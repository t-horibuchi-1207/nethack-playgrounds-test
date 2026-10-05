/**
 * NetHackWasmWorkerBridge.js
 * Web Worker 内で動作する NetHackWasmDriver と UI レイヤーを仲介するブリッジクラス。
 * UI側からは従来の NetHackWasmDriver とほぼ同一のインターフェースとして扱えます。
 */
(function (global) {
    if (global.NetHackWasmWorkerBridge) return;

    class NetHackWasmWorkerBridge {
        static get DriverState() {
            return {
                IDLE: 'IDLE',
                RUNNING: 'RUNNING',
                WAITING_INPUT: 'WAITING_INPUT',
                STOPPED: 'STOPPED'
            };
        }

        static get MAX_RECORDED_EVENTS() {
            return 10000;
        }

        constructor(workerUrl, options = {}) {
            this.listeners = new Map();
            this.options = options;
            this.state = NetHackWasmWorkerBridge.DriverState.IDLE;
            this._activeResolver = null;
            this.lastSequenceBuffer = [];
            this.isExecutingSequence = false;
            this.isTopLevelTurn = false;
            this._canAcceptSequenceInterruption = false;
            this._driverDebugStatus = null;
            this._pendingSequences = new Map();
            this.isRecording = false;
            this.recordedEvents = [];

            if (!workerUrl && typeof window !== 'undefined') {
                const path = window.location.pathname;
                if (path.includes('/examples/legacy-client/') || path.includes('/examples/pure-js-client/')) {
                    this.workerUrl = '../../src/driver/nethack.worker.js';
                } else if (path.includes('/examples/') || path.includes('/tests/') || path.includes('/tools/')) {
                    this.workerUrl = '../src/driver/nethack.worker.js';
                } else {
                    this.workerUrl = 'src/driver/nethack.worker.js';
                }
            } else {
                this.workerUrl = workerUrl || 'src/driver/nethack.worker.js';
            }

            this.createWorkerInstance();
        }

        createWorkerInstance() {
            try {
                this.worker = new Worker(this.workerUrl);
            } catch (e) {
                console.warn(`[NetHackWasmWorkerBridge] Initial worker url (${this.workerUrl}) failed, trying fallback...`, e);
                this.workerUrl = '../../src/driver/nethack.worker.js';
                this.worker = new Worker(this.workerUrl);
            }
            this.setupWorkerListener();
        }

        get activeResolver() {
            return this._activeResolver;
        }

        // EventEmitter 独自簡易実装 (NetHackWasmDriver と同一の API)
        on(event, fn) {
            if (!this.listeners.has(event)) {
                this.listeners.set(event, []);
            }
            this.listeners.get(event).push(fn);
            return this;
        }

        once(event, fn) {
            const wrapper = (payload) => {
                this.off(event, wrapper);
                fn(payload);
            };
            return this.on(event, wrapper);
        }

        off(event, fn) {
            if (!this.listeners.has(event)) return this;
            const list = this.listeners.get(event).filter(l => l !== fn);
            this.listeners.set(event, list);
            return this;
        }

        startRecording() {
            this.isRecording = true;
            this.recordedEvents = [];
        }

        stopRecording() {
            this.isRecording = false;
            const events = this.recordedEvents ? [...this.recordedEvents] : [];
            this.recordedEvents = [];
            return events;
        }

        _recordEvent(event, payload) {
            if (this.recordedEvents.length >= NetHackWasmWorkerBridge.MAX_RECORDED_EVENTS) {
                console.warn(`[NetHackWasmWorkerBridge] Recording buffer reached maximum limit (${NetHackWasmWorkerBridge.MAX_RECORDED_EVENTS} events). Auto-stopping recording to prevent memory leak.`);
                this.isRecording = false;
                return;
            }

            try {
                const clonedData = payload !== undefined ? JSON.parse(JSON.stringify(payload)) : null;
                this.recordedEvents.push({
                    type: event,
                    data: clonedData,
                    timestamp: Date.now()
                });
            } catch (e) {
                this.recordedEvents.push({
                    type: event,
                    data: payload,
                    timestamp: Date.now()
                });
            }
        }

        emit(event, payload) {
            if (this.isRecording) {
                this._recordEvent(event, payload);
            }

            if (!this.listeners.has(event)) return false;
            const list = this.listeners.get(event);
            list.forEach(fn => {
                try {
                    fn(payload);
                } catch (e) {
                    console.error(`[NetHackWasmWorkerBridge] Error in event listener for '${event}':`, e);
                }
            });
            return true;
        }

        setupWorkerListener() {
            this.worker.onmessage = (e) => {
                const { type, event, data, exitCode, message, success, filename, saveName } = e.data;

                switch (type) {
                    case 'INIT_DONE':
                        this.emit('initialized', {});
                        break;

                    case 'EVENT':
                        if (event === 'stateChange' && data && data.state) {
                            this.state = data.state;
                        }
                        if (data && typeof data.isExecutingSequence === 'boolean') {
                            this.isExecutingSequence = data.isExecutingSequence;
                        }
                        if (data && typeof data.isTopLevelTurn === 'boolean') {
                            this.isTopLevelTurn = data.isTopLevelTurn;
                        }
                        if (data && typeof data.canAcceptSequenceInterruption === 'boolean') {
                            this._canAcceptSequenceInterruption = data.canAcceptSequenceInterruption;
                        }

                        // inputRequired イベントなどの透過的 resolver 再構築
                        if (data && data.hasResolver) {
                            const resolverId = data.resolverId;
                            const bridge = this;
                            let resolved = false;

                            const safeRespond = (val) => {
                                if (resolved) {
                                    console.warn(`[NetHackWasmWorkerBridge] SafeResolver: Worker bridge resolver was already resolved. Ignoring duplicate call.`);
                                    return false;
                                }
                                resolved = true;
                                if (bridge._activeResolver === data.resolver) {
                                    bridge._activeResolver = null;
                                }

                                const cleanVal = (typeof InputResolver !== 'undefined' && InputResolver.unwrapPayload) ? 
                                    InputResolver.unwrapPayload(val) : 
                                    (function(v) {
                                        if (v === null || typeof v !== 'object') return v;
                                        try { return JSON.parse(JSON.stringify(v)); } catch(e) { return v; }
                                    })(val);

                                this.worker.postMessage({
                                    type: 'RESPOND_INPUT',
                                    payload: { resolverId, value: cleanVal, isCancel: false }
                                });
                                return true;
                            };

                            const safeCancel = () => {
                                if (resolved) return false;
                                resolved = true;
                                if (bridge._activeResolver === data.resolver) {
                                    bridge._activeResolver = null;
                                }
                                this.worker.postMessage({
                                    type: 'RESPOND_INPUT',
                                    payload: { resolverId, isCancel: true }
                                });
                                return true;
                            };

                            data.resolver = {
                                respond: safeRespond,
                                resolve: safeRespond,
                                cancel: safeCancel,
                                isResolved: () => resolved
                            };
                            this._activeResolver = data.resolver;
                        }

                        // メインスレッド側のリスナーへイベントを転送
                        this.emit(event, data);
                        break;

                    case 'EXIT':
                        this.state = NetHackWasmWorkerBridge.DriverState.STOPPED;
                        this.emit('exited', { exitCode });
                        break;

                    case 'ERROR':
                        console.error("[NetHackWasmWorkerBridge] Error from Worker:", message);
                        this.emit('error', { message });
                        break;

                    case 'DELETE_SAVE_RESULT':
                        this.emit('deleteSaveResult', { success, filename });
                        break;

                    case 'DETECT_SAVE_NAME_RESULT':
                        this.emit('detectSaveNameResult', { saveName });
                        break;

                    case 'DEBUG_STATUS_RESULT':
                        if (msgData && msgData.status) {
                            this._driverDebugStatus = msgData.status;
                        }
                        this.emit('debugStatusResult', msgData ? msgData.status : null);
                        break;

                    case 'LIST_SAVE_FILES_RESULT':
                        this.emit('listSaveFilesResult', { saveFiles: data.saveFiles });
                        break;

                    case 'SEQUENCE_FINISHED': {
                        const seqId = e.data.sequenceId || (data ? data.sequenceId : null);
                        const buf = e.data.buffer || (data ? data.buffer : []);
                        this.lastSequenceBuffer = buf;
                        if (seqId && this._pendingSequences.has(seqId)) {
                            const pending = this._pendingSequences.get(seqId);
                            this._pendingSequences.delete(seqId);
                            pending.resolve(buf);
                        }
                        this.emit('sequenceFinished', { sequenceId: seqId, buffer: buf });
                        break;
                    }

                    case 'SEQUENCE_CANCELLED': {
                        const seqId = e.data.sequenceId || (data ? data.sequenceId : null);
                        const err = e.data.error || 'Sequence cancelled';
                        if (seqId && this._pendingSequences.has(seqId)) {
                            const pending = this._pendingSequences.get(seqId);
                            this._pendingSequences.delete(seqId);
                            pending.reject(new Error(err));
                        }
                        this.emit('sequenceCancelled', { sequenceId: seqId, error: err });
                        break;
                    }

                    case 'GET_LAST_SEQUENCE_BUFFER_RESULT':
                        this.lastSequenceBuffer = e.data.buffer || [];
                        this.emit('getLastSequenceBufferResult', { buffer: this.lastSequenceBuffer, requestId: e.data.requestId });
                        break;
                }
            };

            this.worker.onerror = (err) => {
                console.error("[NetHackWasmWorkerBridge] Worker system error:", err);
                this.emit('error', { message: err.message || 'Worker syntax or runtime error' });
            };
        }

        init(wasmJsUrl, options = {}) {
            let resolvedWasmJsUrl = wasmJsUrl;
            if (typeof wasmJsUrl === 'string' && !wasmJsUrl.startsWith('/') && !wasmJsUrl.startsWith('http')) {
                // 単純な相対パスの場合、Workerの位置(src/driver/)からルートへ戻るために '../../' を補完する
                if (!wasmJsUrl.startsWith('.') && !wasmJsUrl.includes('/')) {
                    resolvedWasmJsUrl = '../../' + wasmJsUrl;
                }
            }

            const mergedOptions = Object.assign({}, this.options, options);
            this.worker.postMessage({
                type: 'INIT',
                payload: {
                    wasmJsUrl: resolvedWasmJsUrl,
                    options: mergedOptions
                }
            });
        }

        async start(options = {}) {
            this.state = NetHackWasmWorkerBridge.DriverState.RUNNING;
            this.worker.postMessage({
                type: 'START',
                payload: { options }
            });
            
            return new Promise((resolve) => {
                const onExited = (payload) => {
                    this.off('exited', onExited);
                    resolve(payload.exitCode);
                };
                this.on('exited', onExited);
            });
        }

        sendInput(value) {
            this.worker.postMessage({
                type: 'SEND_INPUT',
                payload: { value }
            });
        }

        async deleteSaveFile(filename) {
            let deleted = false;
            const cleanName = filename ? filename.replace(/^\/save\//, '').replace(/#.*$/, '').trim() : "";

            // 1. メインスレッドから IndexedDB を直接物理削除
            try {
                if (typeof indexedDB !== 'undefined') {
                    deleted = await new Promise((resolve) => {
                        const req = indexedDB.open('/save');
                        req.onsuccess = (e) => {
                            const db = e.target.result;
                            if (!db.objectStoreNames.contains('FILE_DATA')) {
                                db.close();
                                resolve(false);
                                return;
                            }
                            const tx = db.transaction('FILE_DATA', 'readwrite');
                            const store = tx.objectStore('FILE_DATA');
                            const keyReq = store.getAllKeys();

                            keyReq.onsuccess = () => {
                                const keys = keyReq.result || [];
                                const systemNames = ['record', 'logfile', 'xlogfile', 'paniclog', 'perm', 'sysconf'];
                                keys.forEach(key => {
                                    const keyStr = String(key);
                                    const isSystem = systemNames.some(sys => keyStr.endsWith(sys));
                                    const isSaveKey = (keyStr.includes('/save/') || keyStr.includes('save/')) && !isSystem;

                                    if (isSaveKey || (cleanName && keyStr.includes(cleanName))) {
                                        store.delete(key);
                                        deleted = true;
                                        console.log(`[NetHackWasmWorkerBridge] Directly deleted key from IndexedDB: '${keyStr}'`);
                                    }
                                });
                            };

                            tx.oncomplete = () => {
                                db.close();
                                resolve(deleted);
                            };
                            tx.onerror = () => {
                                db.close();
                                resolve(false);
                            };
                        };
                        req.onerror = () => resolve(false);
                    });
                }
            } catch (e) {
                console.warn("[NetHackWasmWorkerBridge] Error directly deleting from IndexedDB:", e);
            }

            // 2. Worker 側へもメッセージを送信（VFSキャッシュのクリアなど）
            this.worker.postMessage({
                type: 'DELETE_SAVE',
                payload: { filename }
            });

            return new Promise((resolve) => {
                const onResult = (payload) => {
                    if (payload.filename === filename) {
                        this.off('deleteSaveResult', onResult);
                        resolve(deleted || payload.success);
                    }
                };
                // Workerからの応答タイムアウト制限 (1秒)
                setTimeout(() => {
                    this.off('deleteSaveResult', onResult);
                    resolve(deleted);
                }, 1000);
                this.on('deleteSaveResult', onResult);
            });
        }

        async deleteAllSaveFiles() {
            if (typeof NetHackFSManager !== 'undefined' && typeof NetHackFSManager.deleteAllSaveFilesFromIndexedDB === 'function') {
                return await NetHackFSManager.deleteAllSaveFilesFromIndexedDB();
            }
            return false;
        }

        async syncToPersistent() {
            return true;
        }

        autoDetectSavePlayerName() {
            return "";
        }

        async autoDetectSavePlayerNameAsync() {
            if (typeof NetHackFSManager !== 'undefined' && typeof NetHackFSManager.autoDetectSavePlayerNameFromIndexedDB === 'function') {
                return await NetHackFSManager.autoDetectSavePlayerNameFromIndexedDB();
            }
            return "";
        }

        async listSaveFiles() {
            return new Promise((resolve) => {
                if (!this.worker) return resolve([]);
                const onResult = ({ saveFiles }) => {
                    this.off('listSaveFilesResult', onResult);
                    resolve(saveFiles || []);
                };
                setTimeout(() => {
                    this.off('listSaveFilesResult', onResult);
                    resolve([]);
                }, 1000);
                this.on('listSaveFilesResult', onResult);
                this.worker.postMessage({ type: 'LIST_SAVE_FILES' });
            });
        }

        readXlogText() {
            return "";
        }

        async readXlogTextAsync() {
            if (typeof NetHackFSManager !== 'undefined' && typeof NetHackFSManager.readTextFromIndexedDB === 'function') {
                return await NetHackFSManager.readTextFromIndexedDB('xlogfile');
            }
            return "";
        }

        readRecordText() {
            return "";
        }

        async readRecordTextAsync() {
            if (typeof NetHackFSManager !== 'undefined' && typeof NetHackFSManager.readTextFromIndexedDB === 'function') {
                let rec = await NetHackFSManager.readTextFromIndexedDB('record');
                if (!rec) rec = await NetHackFSManager.readTextFromIndexedDB('logfile');
                return rec;
            }
            return "";
        }

        hasSaveData() {
            return false;
        }

        async hasSaveDataAsync() {
            const name = await this.autoDetectSavePlayerNameAsync();
            return !!(name && name.length > 0);
        }

        terminate() {
            this.stopRecording();
            if (this.worker) {
                this.worker.terminate();
                this.state = NetHackWasmWorkerBridge.DriverState.STOPPED;
            }
        }

        async restart(options = {}) {
            this.terminate();
            this.state = NetHackWasmWorkerBridge.DriverState.IDLE;
            this._activeResolver = null;
            this.lastSequenceBuffer = [];
            this.isExecutingSequence = false;
            this.isTopLevelTurn = false;
            this._canAcceptSequenceInterruption = false;
            this._driverDebugStatus = null;
            if (this._pendingSequences && typeof this._pendingSequences.clear === 'function') {
                this._pendingSequences.clear();
            }

            this.createWorkerInstance();

            if (options && options.wasmJsUrl) {
                this.init(options.wasmJsUrl, options);
            }
            return true;
        }

        /**
         * 現在のドライバ状態がメインターン行動待ちであり、自走シーケンスの割り込み実行が安全に可能か判定
         * @returns {boolean}
         */
        canAcceptSequenceInterruption() {
            if (this.state !== NetHackWasmWorkerBridge.DriverState.WAITING_INPUT) return false;
            if (typeof this._canAcceptSequenceInterruption === 'boolean') {
                return this._canAcceptSequenceInterruption;
            }
            return Boolean(this.isTopLevelTurn);
        }

        /**
         * 開発者・DevTools・DebugInspector 用デバッグステータスの一括取得
         */
        getDebugStatus() {
            if (this._driverDebugStatus) {
                return {
                    ...this._driverDebugStatus,
                    bridgeState: this.state,
                    bridgeExecutingSequence: this.isExecutingSequence,
                    canAcceptSequenceInterruption: this.canAcceptSequenceInterruption()
                };
            }
            return {
                state: this.state,
                isTopLevelTurn: this.isTopLevelTurn,
                canAcceptSequenceInterruption: this.canAcceptSequenceInterruption(),
                isExecutingSequence: this.isExecutingSequence,
                sequenceQueueLength: 0
            };
        }

        /**
         * GKL シーケンスを Worker 内の Driver へ送信し設定する
         * @param {Array<string|number>} tokens
         * @param {Object} [options={}]
         * @returns {Promise<Array<Object>>} シーケンス結果バッファの Promise
         */
        queueSequence(tokens, options = {}) {
            if (!Array.isArray(tokens) || tokens.length === 0) return Promise.resolve([]);
            this.lastSequenceBuffer = [];
            this.isExecutingSequence = true;

            const sequenceId = options.sequenceId || `seq_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
            const payloadOptions = { ...options, sequenceId };

            return new Promise((resolve, reject) => {
                if (options.isSilentSync) {
                    this._pendingSequences.forEach((pending, id) => {
                        if (pending.isSilentSync) {
                            pending.reject(new Error('Sequence cancelled: superseded by new silent sync'));
                            this._pendingSequences.delete(id);
                        }
                    });
                }

                this._pendingSequences.set(sequenceId, { resolve, reject, isSilentSync: !!options.isSilentSync });

                if (this.worker) {
                    this.worker.postMessage({
                        type: 'QUEUE_SEQUENCE',
                        payload: { tokens, options: payloadOptions, sequenceId }
                    });
                } else {
                    this._pendingSequences.delete(sequenceId);
                    resolve([]);
                }
            });
        }

        /**
         * GKL シーケンスのキャンセルを Worker 内の Driver へ送信する
         */
        cancelSequence() {
            this.isExecutingSequence = false;
            this._pendingSequences.forEach((pending) => {
                if (typeof pending.reject === 'function') {
                    pending.reject(new Error('Sequence cancelled'));
                }
            });
            this._pendingSequences.clear();

            if (this.worker) {
                this.worker.postMessage({
                    type: 'CANCEL_SEQUENCE'
                });
            }
        }

        /**
         * 直近のシーケンス実行結果バッファを Worker 内の Driver から取得
         * @returns {Promise<Array<Object>>} バッファ配列の Promise
         */
        async getLastSequenceBuffer() {
            return new Promise((resolve) => {
                if (!this.worker) return resolve([...this.lastSequenceBuffer]);
                const requestId = Math.random().toString(36).substring(2);
                const onResult = (data) => {
                    if (data && data.requestId === requestId) {
                        this.off('getLastSequenceBufferResult', onResult);
                        resolve(data.buffer || []);
                    }
                };
                setTimeout(() => {
                    this.off('getLastSequenceBufferResult', onResult);
                    resolve([...this.lastSequenceBuffer]);
                }, 1000);
                this.on('getLastSequenceBufferResult', onResult);
                this.worker.postMessage({ type: 'GET_LAST_SEQUENCE_BUFFER', payload: { requestId } });
            });
        }

        /**
         * 抽象方向コード (DIR_*) や制御キーのキーモード変換ヘルパー
         * @param {string} token
         * @returns {string}
         */
        resolveTokenKey(token) {
            if (typeof token !== 'string') return token;
            const mode = this.keyMode || 'numpad';

            const directionMap = {
                'numpad': {
                    'DIR_N': '8', 'DIR_E': '6', 'DIR_S': '2', 'DIR_W': '4',
                    'DIR_NE': '9', 'DIR_NW': '7', 'DIR_SE': '3', 'DIR_SW': '1',
                    'DIR_SELF': '.'
                },
                'vi': {
                    'DIR_N': 'k', 'DIR_E': 'l', 'DIR_S': 'j', 'DIR_W': 'h',
                    'DIR_NE': 'u', 'DIR_NW': 'y', 'DIR_SE': 'n', 'DIR_SW': 'b',
                    'DIR_SELF': '.'
                }
            };

            const map = directionMap[mode] || directionMap['numpad'];
            if (map[token]) return map[token];

            return token;
        }
    }

    global.NetHackWasmWorkerBridge = NetHackWasmWorkerBridge;
    if (typeof window !== 'undefined') {
        window.NetHackWasmWorkerBridge = NetHackWasmWorkerBridge;
    }
    if (typeof globalThis !== 'undefined') {
        globalThis.NetHackWasmWorkerBridge = NetHackWasmWorkerBridge;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = NetHackWasmWorkerBridge;
        module.exports.NetHackWasmWorkerBridge = NetHackWasmWorkerBridge;
        module.exports.default = NetHackWasmWorkerBridge;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));


