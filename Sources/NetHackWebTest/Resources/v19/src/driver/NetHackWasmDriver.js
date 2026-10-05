/**
 * NetHackWasmDriver.js
 * NetHack 5.0 Wasm コアと Client UI レイヤーを疎結合に接続する汎用 Driver クラス
 */
(function (global) {
    if (global.NetHackWasmDriver) return;

    class NetHackWasmDriver {
        static get DriverState() {
            return {
                IDLE: 'IDLE',
                RUNNING: 'RUNNING',
                WAITING_INPUT: 'WAITING_INPUT',
                STOPPED: 'STOPPED'
            };
        }

        static get DEFAULT_EXTCMDS() {
            return [
                "#","?","adjust", "annotate", "apply", "attributes", "autopickup",
                "call", "cast", "chat", "chronicle", "close", "conduct", "debugfuzzer",
                "dip", "down", "drop", "droptype", "eat", "engrave", "enhance",
                "exploremode", "fight", "fire", "force", "genocided", "glance",
                "help", "herecmdmenu", "history", "inventory", "inventtype",
                "invoke", "jump", "kick", "known", "knownclass", "levelchange",
                "lightsources", "look", "lookaround", "loot", "migratemons",
                "monster", "name", "offer", "open", "options", "optionsfull",
                "overview", "panic", "pay", "perminv", "pickup", "polyself",
                "pray", "prevmsg", "puton", "quaff", "quit", "quiver", "read",
                "redraw", "remove", "repeat", "reqmenu", "retravel", "ride",
                "rub", "run", "rush", "save", "saveoptions", "search", "seeall",
                "seeamulet", "seearmor", "seerings", "seetools", "seeweapon",
                "shell", "showgold", "showspells", "showtrap", "sit", "stats",
                "suspend", "swap", "takeoff", "takeoffall", "teleport", "terrain",
                "therecmdmenu", "throw", "timeout", "tip", "toggle", "travel",
                "turn", "twoweapon", "untrap", "up", "vanquished", "version",
                "versionshort", "vision", "wait", "wear", "whatdoes", "whatis",
                "wield", "wipe"
            ];
        }

        /**
         * イベントキャプチャの最大蓄積上限数
         * マッピングの巻物等の大量イベントを許容しつつ、停止忘れ時のメモリ肥大化を防止する
         */
        static get MAX_RECORDED_EVENTS() {
            return 10000;
        }

        constructor(options = {}) {
            this.listeners = new Map();
            this.options = {
                autoRespondEmptyMenu: true,
                deduplicateMessages: true,
                filterSysconfLogs: true,
                inputContextGuard: true,
                unwrapPayload: true,
                normalizeMenuResponse: true,
                ...options
            };

            this.initSubModules(this.options);

            this.state = NetHackWasmDriver.DriverState.IDLE;
            this.menuBuffer = {};
            this.messageHistory = [];
            this.lastEmittedMessage = null;
            this.messageWindowId = 1;
            this.version = "";

            // GKL Sequence Queue State (FIFO Task Queue)
            this.sequenceTaskQueue = [];
            this.currentTask = null;
            this.lastCompletedBuffer = [];
            this.keyMode = 'numpad'; // 'numpad' | 'vi'

            // 階層サブモード状態フラグ
            this.isTargetingMode = false;               // '/' ';' ':' '_' '^' '\' の視察/ターゲットカーソル操作中
            this._enteredPoskeyInTargetingMode = false;  // ターゲットモード中に nh_poskey/getch を経由したか
            this.isMenuOpen = false;                    // menu 表示・選択中
            this.isTextWindowOpen = false;              // display_file / モーダルテキスト表示中
            this.isPromptOpen = false;                  // yn_function, getlin, get_ext_cmd 開閉中
            this.isTopLevelTurn = false;                // 真のメインターン自由行動待機中か

            // シナリオテスト用イベント記録エンジン (Downlink Recording)
            this.isRecording = false;
            this.recordedEvents = [];
            this.lastRawPrintText = "";

            // Bind global dispatcher safely
            this.eventHook = this.eventHook.bind(this);
            this.setupGlobalDispatcher();
            this.initSubModules();
        }

        /**
         * 視察・ターゲット開始キー（'/', ';', ':', '_', '^', '\'）が送出されたかを検出
         */
        checkTargetingCommandStart(key) {
            if (typeof key !== 'string') return;
            const cleanKey = key.trim();
            const targetCmds = ['/', ';', ':', '_', '^', '\\'];
            if (targetCmds.includes(cleanKey) || cleanKey === 'whatis' || cleanKey === 'travel') {
                this.isTargetingMode = true;
                this._enteredPoskeyInTargetingMode = false;
                this.isTopLevelTurn = false;
            }
        }

        /**
         * nh_poskey 復帰後以降に決定キー（Space, Enter, ., y, n等）または ESC が押された場合のターゲットモード解除
         */
        checkTargetingCommandEnd(key) {
            if (!this.isTargetingMode) return;
            
            const k = typeof key === 'string' ? key : (typeof key === 'number' ? String.fromCharCode(key) : '');
            if (k === ' ' || k === '\r' || k === '\n' || k === '.' || k === '\x1b' || k === '\u001b' || key === 27 || key === 32 || key === 13 || key === 10) {
                this.isTargetingMode = false;
                this._enteredPoskeyInTargetingMode = false;
            }
        }

        /**
         * 現在のすべてのサブモードが閉じており、真のメインターン自由行動待ちであるか
         * @returns {boolean}
         */
        canAcceptSequenceInterruption() {
            if (this.state !== NetHackWasmDriver.DriverState.WAITING_INPUT) return false;
            if (this.isTargetingMode || this.isMenuOpen || this.isTextWindowOpen || this.isPromptOpen) {
                return false;
            }
            return Boolean(this.isTopLevelTurn);
        }

        /**
         * 開発者・DevTools・DebugInspector 用デバッグステータスの一括取得
         */
        getDebugStatus() {
            return {
                state: this.state,
                isTopLevelTurn: this.isTopLevelTurn,
                canAcceptSequenceInterruption: this.canAcceptSequenceInterruption(),
                isExecutingSequence: this.isExecutingSequence,
                sequenceQueueLength: this.sequenceTaskQueue.length,
                isTargetingMode: this.isTargetingMode,
                isMenuOpen: this.isMenuOpen,
                isTextWindowOpen: this.isTextWindowOpen,
                isPromptOpen: this.isPromptOpen,
                lastRawPrintText: this.lastRawPrintText
            };
        }

        get isExecutingSequence() {
            return !!this.currentTask;
        }
        set isExecutingSequence(val) {
            if (!val && this.currentTask) {
                if (this.currentTask.buffer) {
                    this.lastCompletedBuffer = [...this.currentTask.buffer];
                }
                this.currentTask = null;
                this.processNextSequenceTask();
            }
        }

        get sequenceQueue() {
            return this.currentTask ? this.currentTask.tokens : [];
        }
        set sequenceQueue(val) {
            if (this.currentTask) {
                this.currentTask.tokens = Array.isArray(val) ? val : [];
            }
        }

        get sequenceOptions() {
            return this.currentTask ? this.currentTask.options : { suppressPrompts: false };
        }
        set sequenceOptions(val) {
            if (this.currentTask) {
                this.currentTask.options = { suppressPrompts: false, ...val };
            }
        }

        get lastSequenceBuffer() {
            if (this.currentTask) {
                return this.currentTask.buffer;
            }
            return this.lastCompletedBuffer;
        }
        set lastSequenceBuffer(val) {
            if (this.currentTask) {
                this.currentTask.buffer = Array.isArray(val) ? val : [];
            } else {
                this.lastCompletedBuffer = Array.isArray(val) ? val : [];
            }
        }

        /**
         * 抽象方向コード (DIR_*) や制御キーのキーモード変換ヘルパー
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

        /**
         * 連続キー/トークン配列をタスクとしてFIFOキューに投入し、inputRequired タイミングに合わせて安全に自動消化する
         * @param {Array<string|number>} tokens - トークン配列 (例: ['#', 'open', '\r', 'DIR_E'])
         * @param {Object} [options={}] - { suppressPrompts: boolean, isSilentSync: boolean, sequenceId: string }
         * @returns {Promise<Array<Object>>} シーケンス実行完了時に獲得されたバッファの Promise
         */
        queueSequence(tokens, options = {}) {
            if (!Array.isArray(tokens) || tokens.length === 0) return Promise.resolve([]);
            const sequenceId = options.sequenceId || `seq_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

            return new Promise((resolve, reject) => {
                // 1. 古い未実行の同種サイレント同期タスクがキューに残っていればキャンセル
                if (options.isSilentSync) {
                    if (this.currentTask && this.currentTask.options && this.currentTask.options.isSilentSync) {
                        if (typeof this.currentTask.reject === 'function') {
                            this.currentTask.reject(new Error('Sequence cancelled: superseded by new silent sync'));
                        }
                        this.currentTask = null;
                    }
                    this.sequenceTaskQueue = this.sequenceTaskQueue.filter(task => {
                        if (task.options && task.options.isSilentSync) {
                            if (typeof task.reject === 'function') {
                                task.reject(new Error('Sequence cancelled: superseded by new silent sync'));
                            }
                            return false;
                        }
                        return true;
                    });
                }

                // 2. キュー長上限ガード (最大16件)
                while (this.sequenceTaskQueue.length >= 16) {
                    const dropped = this.sequenceTaskQueue.shift();
                    if (dropped && typeof dropped.reject === 'function') {
                        dropped.reject(new Error('Sequence cancelled: queue limit exceeded'));
                    }
                }

                const task = {
                    sequenceId,
                    tokens: [...tokens],
                    options: { suppressPrompts: false, ...options },
                    buffer: [],
                    resolve,
                    reject
                };
                this.sequenceTaskQueue.push(task);

                if (!this.currentTask) {
                    this.processNextSequenceTask();
                }
            });
        }

        /**
         * FIFOタスクキューから次のシーケンス・タスクを取り出して開始する
         */
        processNextSequenceTask() {
            if (this.currentTask) {
                const finishedTask = this.currentTask;
                this.currentTask = null;
                const buf = finishedTask.buffer ? JSON.parse(JSON.stringify(finishedTask.buffer)) : [];
                if (typeof finishedTask.resolve === 'function') {
                    finishedTask.resolve(buf);
                }
                this.emit("sequenceFinished", { sequenceId: finishedTask.sequenceId, buffer: buf });
            }

            if (this.sequenceTaskQueue.length === 0) {
                return;
            }

            this.currentTask = this.sequenceTaskQueue.shift();

            // すでに入力待ち中であれば、直ちに最初のトークンを消費・応答をキック
            if (this.activeResolver && this.currentTask.tokens.length > 0) {
                this.tryConsumeSequenceToken();
            }
        }

        /**
         * 実行中のシーケンスおよび予約キューを安全に強制キャンセルし、通常状態に復帰
         */
        cancelSequence() {
            if (this.currentTask) {
                const finishedTask = this.currentTask;
                this.currentTask = null;
                if (typeof finishedTask.reject === 'function') {
                    finishedTask.reject(new Error('Sequence cancelled'));
                }
            }
            this.sequenceTaskQueue.forEach(task => {
                if (typeof task.reject === 'function') {
                    task.reject(new Error('Sequence cancelled'));
                }
            });
            this.sequenceTaskQueue = [];
            this.lastCompletedBuffer = [];
            this.emit("sequenceFinished", { sequenceId: null, buffer: [] });
        }

        /**
         * シーケンス実行中に受信したテキスト・メッセージ・メニュー構造体を記録
         */
        recordSequenceBuffer(item) {
            if (this.currentTask && item) {
                try {
                    const cleanItem = JSON.parse(JSON.stringify(item));
                    this.currentTask.buffer.push(cleanItem);
                } catch (e) {
                    this.currentTask.buffer.push(item);
                }
            }
        }

        /**
         * 直近のシーケンス実行結果バッファのクリーンなコピーを取得
         * @returns {Array<Object>} バッファアイテムの配列
         */
        getLastSequenceBuffer() {
            const buf = this.currentTask ? this.currentTask.buffer : this.lastCompletedBuffer;
            try {
                return JSON.parse(JSON.stringify(buf));
            } catch (e) {
                return [...buf];
            }
        }

        /**
         * inputRequired 発生時にシーケンスキューからトークンを自走消費・応答
         * @param {string} promptText - 現在のプロンプト文字列
         * @param {Object} resolver - safeResolver オブジェクト
         * @param {string} context - コンテキスト情報
         * @returns {boolean} 自動消費に成功しUIへのemitをブロックした場合は true
         */
        tryConsumeSequenceToken(promptText = "", resolver = null, context = "") {
            if (!this.currentTask) {
                return false;
            }

            if (this.currentTask.tokens.length === 0) {
                // シーケンスのトークンが全消費された状態で次の入力待ちに達した場合、
                // 前回のシーケンスによる Cコアの出力・処理が完了したことを意味するためタスクを移行
                this.lastCompletedBuffer = [...this.currentTask.buffer];
                this.processNextSequenceTask();

                if (this.currentTask && this.currentTask.tokens.length > 0) {
                    return this.tryConsumeSequenceToken(promptText, resolver, context);
                }
                return false;
            }

            const resObj = resolver || this.activeResolver;
            if (!resObj) return false;

            // プロンプト文面の「投げっぱなし putmsg 送出」
            if (promptText && typeof promptText === 'string' && !this.currentTask.options.suppressPrompts) {
                this.emit("putmsg", { text: promptText, fromSequence: true });
                this.recordSequenceBuffer({ type: 'putmsg', text: promptText, fromSequence: true });
            }

            const rawToken = this.currentTask.tokens.shift();
            const token = this.resolveTokenKey(rawToken);

            this.checkTargetingCommandStart(token);
            this.checkTargetingCommandEnd(token);

            const doRespond = () => {
                if (typeof resObj.respond === 'function') {
                    resObj.respond(token);
                } else if (typeof resObj === 'function') {
                    resObj(token);
                }
            };

            const stepDelayMs = (this.currentTask && this.currentTask.options) ? Number(this.currentTask.options.stepDelayMs) || 0 : 0;
            if (stepDelayMs > 0) {
                setTimeout(() => {
                    doRespond();
                }, stepDelayMs);
            } else {
                doRespond();
            }

            return true;
        }

        getModule() {
            const winM = (typeof window !== 'undefined') ? window.Module : null;
            const globM = (typeof globalThis !== 'undefined') ? globalThis.Module : null;
            if (winM && (winM.ccall || winM.setValue)) return winM;
            if (globM && (globM.ccall || globM.setValue)) return globM;
            if (this.memory && this.memory.Module) return this.memory.Module;
            return winM || globM || (this.options ? this.options.module : null);
        }

        log(...args) {
            if (this.debug) {
                console.log("[NetHackWasmDriver]", ...args);
            }
        }

        initSubModules(options = {}) {
            const getGlobalClass = (className) => {
                if (typeof window !== 'undefined' && window[className]) return window[className];
                if (typeof globalThis !== 'undefined' && globalThis[className]) return globalThis[className];
                try {
                    return eval(className);
                } catch (e) {
                    return null;
                }
            };

            const MemoryClass = getGlobalClass('NetHackMemory');
            const FSManagerClass = getGlobalClass('NetHackFSManager');
            const ResolverClass = getGlobalClass('InputResolver');

            const moduleRef = options.module || this.getModule();

            if (MemoryClass && (!this.memory || options.module)) {
                this.memory = new MemoryClass(moduleRef);
            }
            if (FSManagerClass && !this.fsManager) {
                this.fsManager = new FSManagerClass({ debug: this.debug });
                this.log("Successfully instantiated NetHackFSManager.");
            }
            if (ResolverClass && !this.inputResolver) {
                this.inputResolver = new ResolverClass({ timeoutMs: options.inputTimeoutMs || 0 });
            }
            this.messageHistory = [];
            this.historyIndex = 0;
        }

        init(moduleRef) {
            if (moduleRef) this.wasmModule = moduleRef;
            this.initSubModules(this.options);
            if (this.memory) {
                this.memory.setModule(moduleRef);
            }
            const M = this.getModule();
            if (M) {
                M.preRun = M.preRun || [];
                M.preRun.push(() => {
                    if (typeof globalThis !== 'undefined' && globalThis.ENV) {
                        globalThis.ENV.USER = undefined;
                        globalThis.ENV.LOGNAME = undefined;
                        globalThis.ENV.HOME = "/";
                        globalThis.ENV.HACKDIR = "/";
                        globalThis.ENV.SCOREDIR = "/save/";
                        globalThis.ENV.LEVELDIR = "/";
                        globalThis.ENV.SAVEDIR = "/save/";
                        globalThis.ENV.NETHACKOPTIONS = "";
                    }
                });
            }
            this.setupGlobalDispatcher();
        }

        get activeResolver() {
            return (this.inputResolver && this.inputResolver.isWaiting()) ? this.inputResolver : null;
        }

        getCurrentContext() {
            return this.inputResolver ? this.inputResolver.getContext() : null;
        }

        getPromptCategory(context, type) {
            if (context === 'get_ext_cmd' || type === 'ext_cmd') return 'EXTCMD';
            if (context === 'askname') return 'ASKNAME';
            if (context === 'yn_function' || context === 'yn' || type === 'yn') return 'YN';
            if (context === 'select_menu' || context === 'menu' || type === 'menu') return 'MENU';
            if (context === 'getlin' || type === 'string') return 'TEXT';
            if (context === 'poskey' || type === 'poskey') return 'POSKEY';
            if (context === 'getch' || type === 'char') return 'KEY';
            if (context === 'display_file') return 'FILE';
            return 'OTHER';
        }

        /**
         * EventEmitter API: イベントリスナー登録
         */
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
            if (this.recordedEvents.length >= NetHackWasmDriver.MAX_RECORDED_EVENTS) {
                console.warn(`[NetHackWasmDriver] Recording buffer reached maximum limit (${NetHackWasmDriver.MAX_RECORDED_EVENTS} events). Auto-stopping recording to prevent memory leak.`);
                this.isRecording = false;
                return;
            }

            try {
                // シリアライズ可能な形式で安全にディープコピーして蓄積
                const clonedData = payload !== undefined ? JSON.parse(JSON.stringify(payload)) : null;
                this.recordedEvents.push({
                    type: event,
                    data: clonedData,
                    timestamp: Date.now()
                });
            } catch (e) {
                // 循環参照等のエラーをフォールバック
                this.recordedEvents.push({
                    type: event,
                    data: payload,
                    timestamp: Date.now()
                });
            }
        }

        emit(event, payload) {
            // シナリオテスト用イベント記録エンジン (記録フラグ有効時のみミリ秒未満で蓄積)
            if (this.isRecording) {
                this._recordEvent(event, payload);
            }

            // 🤫 サイレント同期タスク (isSilentSync: true) 実行中はログ・メッセージ・プロンプト関連イベントの外部通知を抑止
            if (this.currentTask && this.currentTask.options && this.currentTask.options.isSilentSync) {
                const opts = this.currentTask.options;
                const allowMap = !!(opts.allowMapUpdates || (opts.stepDelayMs > 0));
                const isMapUpdateDisplay = (event === 'display_nhwindow' && payload && payload.windowId <= 3 && !payload.blocking);

                if (!isMapUpdateDisplay || !allowMap) {
                    const suppressedEvents = ['putmsg', 'putstr', 'raw_print', 'raw_print_bold', 'putmixed', 'inputRequired', 'display_nhwindow', 'clear_nhwindow'];
                    if (suppressedEvents.includes(event)) {
                        return false;
                    }
                }
            }

            if (!this.listeners.has(event)) return false;
            const list = this.listeners.get(event);
            list.forEach(fn => {
                try {
                    fn(payload);
                } catch (e) {
                    console.error(`[NetHackWasmDriver] Error in event listener for '${event}':`, e);
                }
            });
            return true;
        }

        setState(newState) {
            if (this.state !== newState) {
                this.state = newState;
                this.emit('stateChange', { state: newState });
            }
        }

        /**
         * globalThis に C側からの呼び出しレシーバ (nhDispatcher) をセットし、helpers を sticky パッチします。
         */
        setupGlobalDispatcher() {
            const target = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : global);
            target.nhDispatcher = this.eventHook;
            target.nethackGlobal = target.nethackGlobal || {};
            target.nethackGlobal.helpers = target.nethackGlobal.helpers || {};

            const helpers = target.nethackGlobal.helpers;

            const makeSticky = (name, fn) => {
                Object.defineProperty(helpers, name, {
                    get: function () { return fn; },
                    set: function (val) {
                        // console.log(`[NetHackWasmDriver] Blocking attempt to overwrite helper ${name}`);
                    },
                    configurable: true,
                    enumerable: true
                });
            };

            makeSticky('getPointerValue', (name, ptr, type) => this.memory ? this.memory.getPointerValue(ptr, type) : null);
            makeSticky('setPointerValue', (name, ret_ptr, type, value) => this.memory ? this.memory.setPointerValue(ret_ptr, type, value) : null);
            makeSticky('parseGlyphInfo', (ptr) => this.memory ? this.memory.parseGlyphInfo(ptr) : null);
            helpers.isPatched = true;
        }

        /**
         * NetHack Wasm コアエンジンを起動します。
         */
        async start(options = {}) {
            this.initSubModules(options);

            if (this.state === NetHackWasmDriver.DriverState.RUNNING) {
                console.warn("[NetHackWasmDriver] Engine is already running.");
                return 0;
            }

            const M = this.getModule();
            if (!M) {
                throw new Error("[NetHackWasmDriver] Emscripten Module not found!");
            }

            if (!this.fsManager) {
                const FSClass = (typeof window !== 'undefined' && window.NetHackFSManager) ? window.NetHackFSManager : ((typeof globalThis !== 'undefined' && globalThis.NetHackFSManager) ? globalThis.NetHackFSManager : null);
                if (FSClass) {
                    this.fsManager = new FSClass({ debug: this.debug });
                    this.log("Dynamically created NetHackFSManager instance in start().");
                }
            }

            const mergedOptions = Object.assign({}, this.options, options);
            let extraOptsStr = mergedOptions.extraOptions || "";

            if (mergedOptions.gameOptions) {
                const optsList = [];
                for (const [k, v] of Object.entries(mergedOptions.gameOptions)) {
                    if (typeof v === 'boolean') {
                        optsList.push(v ? k : `!${k}`);
                    } else if (v !== undefined && v !== null) {
                        optsList.push(`${k}:${v}`);
                    }
                }
                if (optsList.length > 0) {
                    extraOptsStr += "\n" + optsList.map(o => `OPTIONS=${o}`).join("\n");
                }
            }

            if (this.fsManager) {
                this.log("Initializing FileSystem via fsManager...");
                await this.fsManager.initFileSystem(extraOptsStr);
            } else {
                console.error("[NetHackWasmDriver] CRITICAL: NetHackFSManager is missing! Executing robust raw FS fallback.");
                const FS = typeof globalThis !== 'undefined' && globalThis.FS ? globalThis.FS : (typeof FS !== 'undefined' ? FS : null);
                if (FS) {
                    try {
                        if (!FS.analyzePath('/save').exists) FS.mkdir('/save');
                        if (!FS.analyzePath('/tmp').exists) FS.mkdir('/tmp');
                        
                        const sysconfContent = "WIZARDS=*\nEXPLORERS=*\n";
                        ['/sysconf', '/save/sysconf', 'sysconf'].forEach(p => { try { FS.writeFile(p, sysconfContent); } catch(e){} });
                        
                        const permContent = "*\n";
                        ['/perm', '/save/perm', 'perm'].forEach(p => { try { FS.writeFile(p, permContent); } catch(e){} });

                        FS.writeFile('/.nethackrc', "SCOREDIR=/save/\nSAVEDIR=/save/\nLEVELDIR=/\n" + (extraOptsStr ? `OPTIONS=${extraOptsStr}\n` : ""));
                        this.log("Raw VFS fallback (sysconf + perm) written successfully.");
                    } catch(e) { console.error("Raw VFS fallback error:", e); }
                }
            }

            // C 側のグラフィックコールバック登録
            const cwrapFn = M.cwrap || (typeof cwrap !== 'undefined' ? cwrap : null);
            if (typeof cwrapFn === 'function') {
                try {
                    this.log("Registering graphics callback 'nhDispatcher'...");
                    const setCB = cwrapFn('shim_graphics_set_callback', null, ['string']);
                    setCB("nhDispatcher");
                } catch (e) {
                    console.warn("[NetHackWasmDriver] Failed to set graphics callback via cwrap:", e);
                }
            }

            // コアメインの起動引数構築
            const coreOptions = "number_pad:1,tombstone";
            const args = (M.arguments && M.arguments.length > 0)
                ? [...M.arguments]
                : ['nethack', `-o${coreOptions}`, `--nethackrc:/.nethackrc`];

            if (!args.some(arg => arg.startsWith('--nethackrc'))) {
                args.push("--nethackrc:/.nethackrc");
            }

            const optArg = args.find(a => a.startsWith('-o'));
            const envTarget = typeof globalThis !== 'undefined' && globalThis.ENV ? globalThis.ENV : (typeof ENV !== 'undefined' ? ENV : null);
            if (envTarget) {
                envTarget.NETHACKOPTIONS = optArg ? optArg.slice(2) : "";
            }

            const mallocFn = M._malloc || (typeof _malloc !== 'undefined' ? _malloc : null);
            const setVal = (M && M.setValue) ? M.setValue.bind(M) : (typeof setValue !== 'undefined' ? setValue : null);
            const strToUTF8 = (M && M.stringToUTF8) ? M.stringToUTF8.bind(M) : (typeof stringToUTF8 !== 'undefined' ? stringToUTF8 : (s, ptr) => M.writeAsciiToMemory(s, ptr));
            const ccallFn = (M && M.ccall) ? M.ccall.bind(M) : (typeof ccall !== 'undefined' ? ccall : null);

            const argc = args.length;
            const argv = mallocFn ? mallocFn((argc + 1) * 4) : 0;
            
            for (let i = 0; i < argc; i++) {
                const str = args[i];
                const strPtr = mallocFn ? mallocFn(str.length + 1) : 0;
                if (strPtr) strToUTF8(str, strPtr, str.length + 1);
                if (setVal && argv) setVal(argv + i * 4, strPtr, '*');
            }
            if (setVal && argv) setVal(argv + argc * 4, 0, '*');

            this.setState(NetHackWasmDriver.DriverState.RUNNING);
            this.emit('started', { args });

            this.log("Invoking NetHack main via ccall with args:", args, "argc:", argc);
            return new Promise((resolve) => {
                try {
                    if (!ccallFn) {
                        throw new Error("Emscripten ccall function not found!");
                    }
                    const result = ccallFn('main', 'number', ['number', 'number'], [argc, argv], { async: true });
                    if (result instanceof Promise) {
                        result.then(async code => resolve(await this.handleEngineExit(code)))
                            .catch(async err => {
                                if (err && err.name === 'ExitStatus') {
                                    resolve(await this.handleEngineExit(err.status));
                                } else {
                                    console.error("[NetHackWasmDriver] Engine error in Promise:", err);
                                    resolve(await this.handleEngineExit(-1));
                                }
                            });
                    } else {
                        resolve(this.handleEngineExit(result));
                    }
                } catch (err) {
                    console.error("[NetHackWasmDriver] Exception while starting main:", err);
                    resolve(this.handleEngineExit(-1));
                }
            });
        }

        async handleEngineExit(exitCode) {
            this.stopRecording();
            this.log(`NetHack Engine Exited with code: ${exitCode}`);
            this.setState(NetHackWasmDriver.DriverState.STOPPED);
            if (this.fsManager) {
                await this.fsManager.syncToPersistent();
            }
            this.emit('exited', { exitCode });
            this.emit('exit_nhwindows', { message: `Engine Exited (${exitCode})` });
            return exitCode;
        }

        /**
         * C言語の winshim.c から呼び出されるイベントフック
         */
        async eventHook(type, ...args) {
            this.initSubModules();

            switch (type) {
                case "shim_init_nhwindows":
                    this.emit("init_nhwindows", {});
                    return 0;

                case "shim_player_selection_or_tty":
                    return true;

                case "shim_askname": {
                    this.setState(NetHackWasmDriver.DriverState.WAITING_INPUT);
                    let detectedName = this.fsManager ? this.fsManager.autoDetectSavePlayerName() : "";
                    const defaultName = detectedName || (this.options.gameOptions ? this.options.gameOptions.name : "") || "Web_user";

                    const { promise, safeResolver } = this.inputResolver ?
                        this.inputResolver.createPending('askname', { detectedName }) :
                        { promise: Promise.resolve(defaultName), safeResolver: null };

                    const promptCategory = this.getPromptCategory('askname', 'string');

                    this.emit("inputRequired", {
                        context: "askname",
                        type: "string",
                        promptCategory,
                        prompt: "What is your name?",
                        detectedName,
                        defaultName,
                        resolver: safeResolver
                    });

                    let name = await promise;
                    this.setState(NetHackWasmDriver.DriverState.RUNNING);

                    if (!name || typeof name !== 'string' || name.trim() === "") {
                        name = defaultName;
                    }

                    const M = this.getModule();
                    const getPlnameFn = (M && typeof M._get_plname === 'function') ? M._get_plname : (typeof _get_plname === 'function' ? _get_plname : null);
                    const strToUTF8 = (M && M.stringToUTF8) ? M.stringToUTF8.bind(M) : (typeof stringToUTF8 !== 'undefined' ? stringToUTF8 : null);

                    if (getPlnameFn && strToUTF8) {
                        const plnamePtr = getPlnameFn();
                        if (plnamePtr) {
                            const safeName = name.substring(0, 31);
                            strToUTF8(safeName, plnamePtr, 32);
                        }
                    }
                    return 0;
                }

                case "shim_exit_nhwindows":
                    this.stopRecording();
                    this.setState(NetHackWasmDriver.DriverState.STOPPED);
                    this.emit("exit_nhwindows", { message: args[0] || "" });
                    return 0;

                case "shim_create_nhwindow":
                    if (args[0] === 1) this.messageWindowId = args[0];
                    this.emit("create_nhwindow", { windowId: args[0] });
                    return args[0];

                case "shim_clear_nhwindow":
                    this.emit("clear_nhwindow", { windowId: args[0] });
                    return 0;

                case "shim_display_nhwindow": {
                    const windowId = args[0];
                    const blocking = !!args[1];

                    if (!blocking && windowId <= 3) {
                        this.emit("display_nhwindow", { windowId, blocking });
                        return 0;
                    }

                    const isSuppressPrompts = Boolean(this.sequenceOptions && this.sequenceOptions.suppressPrompts);

                    this.setState(NetHackWasmDriver.DriverState.WAITING_INPUT);
                    const { promise, safeResolver } = this.inputResolver ?
                        this.inputResolver.createPending('display', { windowId }) :
                        { promise: Promise.resolve(0), safeResolver: null };

                    if (!isSuppressPrompts) {
                        this.emit("display_nhwindow", { windowId, blocking, resolver: safeResolver });
                    }

                    if (this.inputResolver && (blocking || windowId > 3)) {
                        if (!this.tryConsumeSequenceToken("", safeResolver, 'display_nhwindow')) {
                            if (isSuppressPrompts && safeResolver) {
                                safeResolver(0);
                            }
                        }
                        await promise;
                        this.setState(NetHackWasmDriver.DriverState.RUNNING);
                    }
                    return 0;
                }

                case "shim_destroy_nhwindow":
                    this.emit("destroy_nhwindow", { windowId: args[0] });
                    return 0;

                case "shim_curs":
                    this.emit("curs", { windowId: args[0], x: args[1], y: args[2] });
                    break;

                case "shim_putstr": {
                    const winId = args[0];
                    const attr = args[1];
                    const text = args[2] || "";
                    const cleanText = text.trim();

                    if (cleanText.length > 0) {
                        this.lastRawPrintText = cleanText;
                    }

                    if (this.options.filterSysconfLogs && (cleanText.includes("sysconf") || cleanText.startsWith("OPTIONS="))) {
                        break;
                    }

                    if (this.options.deduplicateMessages && cleanText.length > 0) {
                        if (this.lastEmittedMessage === cleanText) {
                            break;
                        }
                        this.lastEmittedMessage = cleanText;
                    }

                    if (cleanText.length > 0 && winId === this.messageWindowId) {
                        this.messageHistory.push(cleanText);
                        if (this.messageHistory.length > 200) this.messageHistory.shift();
                    }

                    this.emit("putstr", { windowId: winId, attr, text });
                    this.recordSequenceBuffer({ type: 'putstr', windowId: winId, attr, text });
                    break;
                }

                case "shim_putmsghistory": {
                    const text = args[0] || "";
                    const restoring = !!args[1];

                    if (text.trim().length > 0) {
                        this.messageHistory.push(text.trim());
                        if (this.messageHistory.length > 200) {
                            this.messageHistory.shift();
                        }
                    }

                    if (!restoring) {
                        this.emit("putstr", { windowId: 1, attr: 0, text });
                    }
                    return 0;
                }

                case "shim_getmsghistory": {
                    const init = !!args[0];
                    if (init) {
                        this.historyIndex = 0;
                    }
                    if (this.historyIndex < this.messageHistory.length) {
                        const msg = this.messageHistory[this.historyIndex];
                        this.historyIndex++;
                        return msg;
                    }
                    return null;
                }

                case "shim_display_file": {
                    const filename = args[0];
                    const complain = args[1];

                    let fileText = "";
                    try {
                        const M = this.getModule();
                        const FS = M ? M.FS : (typeof FS !== 'undefined' ? FS : null);
                        if (FS && FS.analyzePath(filename).exists) {
                            fileText = FS.readFile(filename, { encoding: 'utf8' });
                        }
                    } catch (e) {
                        console.warn("[NetHackWasmDriver] Failed to read display file:", filename, e);
                    }

                    this.isTextWindowOpen = true;
                    this.isTopLevelTurn = false;
                    this.setState(NetHackWasmDriver.DriverState.WAITING_INPUT);
                    const { promise, safeResolver } = this.inputResolver ?
                        this.inputResolver.createPending('display_file', { filename }) :
                        { promise: Promise.resolve(0), safeResolver: null };

                    const promptCategory = this.getPromptCategory('display_file', 'file');

                    const isSuppressPrompts = Boolean(this.sequenceOptions && this.sequenceOptions.suppressPrompts);

                    this.recordSequenceBuffer({ type: 'display_file', filename, complain, fileText });
                    if (!isSuppressPrompts) {
                        this.emit("display_file", { filename, complain, fileText, promptCategory, resolver: safeResolver });
                    }
                    if (!this.tryConsumeSequenceToken("", safeResolver, 'display_file')) {
                        if (isSuppressPrompts && safeResolver) {
                            safeResolver(0);
                        }
                    }
                    await promise;
                    this.isTextWindowOpen = false;
                    this.setState(NetHackWasmDriver.DriverState.RUNNING);
                    return 0;
                }

                case "shim_start_menu":
                    this.isMenuOpen = true;
                    this.isTopLevelTurn = false;
                    this.menuBuffer[args[0]] = { behavior: args[1], items: [], prompt: "" };
                    return 0;

                case "shim_add_menu": {
                    const windowId = args[0];
                    if (!this.menuBuffer[windowId]) return 0;

                    const glyphInfo = (args[1] && this.memory) ? this.memory.parseGlyphInfo(args[1]) : null;
                    const numericGlyph = glyphInfo ? glyphInfo.glyph : (typeof args[1] === 'number' ? args[1] : -1);
                    const item = {
                        windowId,
                        glyphInfo,
                        glyph: numericGlyph,
                        identifier: args[2],
                        accelerator: args[3],
                        ch: args[3],
                        gch: args[4],
                        attr: args[5],
                        clr: args[6],
                        str: args[7],
                        itemflags: args[8]
                    };
                    this.menuBuffer[windowId].items.push(item);
                    return 0;
                }

                case "shim_end_menu":
                    if (this.menuBuffer[args[0]]) {
                        this.menuBuffer[args[0]].prompt = args[1] || "";
                    }
                    return 0;

                case "shim_select_menu": {
                    const windowId = args[0];
                    const how = args[1];
                    const menuListPtrPtr = args[2];
                    const menuData = this.menuBuffer[windowId];

                    if (!menuData) return 0;

                    const items = menuData.items || [];

                    // 空メニュー (アイテムが完全にゼロ) の場合のみ自動短縮応答を適用
                    if (this.options.autoRespondEmptyMenu && (!items || items.length === 0)) {
                        return 0;
                    }

                    this.setState(NetHackWasmDriver.DriverState.WAITING_INPUT);
                    const { promise, safeResolver } = this.inputResolver ?
                        this.inputResolver.createPending('select_menu', { windowId, how, items, prompt: menuData.prompt }) :
                        { promise: Promise.resolve(0), safeResolver: null };

                    const promptCategory = this.getPromptCategory('select_menu', 'menu');

                    this.recordSequenceBuffer({
                        type: 'select_menu',
                        windowId,
                        how,
                        menuItems: items,
                        items: items,
                        prompt: menuData.prompt
                    });

                    if (!this.tryConsumeSequenceToken(menuData.prompt, safeResolver, 'select_menu')) {
                        if (!this.sequenceOptions.suppressPrompts) {
                            this.emit("inputRequired", {
                                context: "select_menu",
                                type: "menu",
                                promptCategory,
                                windowId,
                                how,
                                menuItems: items,
                                items: items,
                                prompt: menuData.prompt,
                                resolver: safeResolver
                            });
                        }
                    }

                    let selectedItems = await promise;
                    this.isMenuOpen = false;
                    this.setState(NetHackWasmDriver.DriverState.RUNNING);

                    // 選択可能アイテムリストの抽出 (ヘッダーや無効項目を除外)
                    const selectableItems = items.filter(it => !it.isHeader && it.identifier && it.identifier !== 0);

                    // 1. キャンセル値・空値の判定
                    if (selectedItems === 0 || selectedItems === -1 || selectedItems === 27 ||
                        selectedItems === '0' || selectedItems === 'ESC' || selectedItems === '\x1b' ||
                        selectedItems === null || selectedItems === undefined) {
                        selectedItems = [];
                    }
                    // 2. 文字列トークン (例: 'a', 'B', '1', 'ESC') の自動解決
                    else if (typeof selectedItems === 'string') {
                        const strVal = selectedItems.trim();
                        if (!strVal || strVal === '0' || strVal === 'ESC' || strVal === '\x1b') {
                            selectedItems = [];
                        } else {
                            // (a) アクセラレータ文字の一致判定
                            let match = selectableItems.find(it => {
                                const acc = it.accelerator ? (typeof it.accelerator === 'string' ? it.accelerator : String.fromCharCode(it.accelerator)) : '';
                                return acc.toLowerCase() === strVal.toLowerCase();
                            });

                            // (b) identifier の文字コード一致判定 (例: any.a_char)
                            if (!match) {
                                match = selectableItems.find(it => {
                                    if (typeof it.identifier === 'number' && it.identifier > 0 && it.identifier < 256) {
                                        return String.fromCharCode(it.identifier).toLowerCase() === strVal.toLowerCase();
                                    }
                                    return false;
                                });
                            }

                            // (c) 数値文字列 (例: '1', '2') によるインデックス一致判定
                            if (!match && /^\d+$/.test(strVal)) {
                                const num = parseInt(strVal, 10);
                                if (num > 0 && num <= selectableItems.length) {
                                    match = selectableItems[num - 1];
                                }
                            }

                            selectedItems = match ? [match] : [];
                        }
                    }
                    // 3. 数値トークン (例: 1-based index, または ASCII コード) の自動解決
                    else if (typeof selectedItems === 'number') {
                        let match = null;
                        const num = selectedItems;

                        // (a) 1-based インデックス指定 (1 <= num <= length)
                        if (num > 0 && num <= selectableItems.length) {
                            match = selectableItems[num - 1];
                        }

                        // (b) ASCII コード指定 (例: 97 -> 'a')
                        if (!match && num >= 32 && num <= 126) {
                            const ch = String.fromCharCode(num).toLowerCase();
                            match = selectableItems.find(it => {
                                const acc = it.accelerator ? (typeof it.accelerator === 'string' ? it.accelerator : String.fromCharCode(it.accelerator)) : '';
                                return acc.toLowerCase() === ch;
                            });
                        }

                        selectedItems = match ? [match] : [];
                    }
                    // 4. 単一オブジェクトの配列化 (normalizeMenuResponse)
                    else if (selectedItems && !Array.isArray(selectedItems) && typeof selectedItems === 'object') {
                        selectedItems = [selectedItems];
                    }

                    if (!selectedItems || !Array.isArray(selectedItems) || selectedItems.length === 0) {
                        return 0;
                    }

                    if (Array.isArray(selectedItems) && this.memory) {
                        const ptr = this.memory.buildMenuItemBuffer(selectedItems);
                        const M = this.getModule();
                        const setVal = (M && M.setValue) ? M.setValue.bind(M) : (typeof setValue !== 'undefined' ? setValue : null);
                        if (setVal) setVal(menuListPtrPtr, ptr, 'i32');
                        return selectedItems.length;
                    }
                    return 0;
                }

                case "shim_print_glyph": {
                    const glyphInfo = this.memory ? this.memory.parseGlyphInfo(args[3]) : null;
                    const bkglyphInfo = this.memory ? this.memory.parseGlyphInfo(args[4]) : null;
                    this.emit("print_glyph", { windowId: args[0], x: args[1], y: args[2], glyphInfo, bkglyphInfo });
                    break;
                }

                case "shim_raw_print": {
                    const rawInput = args[0];
                    const text = typeof rawInput === 'string' ? rawInput : (rawInput !== undefined && rawInput !== null ? String(rawInput) : "");
                    const cleanText = text.trim();

                    if (this.options.filterSysconfLogs && (cleanText.includes("sysconf") || cleanText.includes("MAXPLAYERS") || cleanText.includes("WIZARDS") || cleanText.startsWith("OPTIONS="))) {
                        return 0;
                    }

                    if (this.options.deduplicateMessages && cleanText.length > 0) {
                        if (this.lastEmittedMessage === cleanText) {
                            return 0;
                        }
                        this.lastEmittedMessage = cleanText;
                    }

                    this.recordSequenceBuffer({ type: 'raw_print', text });
                    this.emit("raw_print", { text });
                    return 0;
                }

                case "shim_raw_print_bold": {
                    const rawInput = args[0];
                    const text = typeof rawInput === 'string' ? rawInput : (rawInput !== undefined && rawInput !== null ? String(rawInput) : "");
                    const cleanText = text.trim();

                    if (this.options.filterSysconfLogs && (cleanText.includes("sysconf") || cleanText.includes("MAXPLAYERS") || cleanText.includes("WIZARDS") || cleanText.startsWith("OPTIONS="))) {
                        return 0;
                    }

                    if (this.options.deduplicateMessages && cleanText.length > 0) {
                        if (this.lastEmittedMessage === cleanText) {
                            return 0;
                        }
                        this.lastEmittedMessage = cleanText;
                    }

                    this.recordSequenceBuffer({ type: 'raw_print_bold', text });
                    this.emit("raw_print_bold", { text });
                    return 0;
                }

                case "shim_nhgetch": {
                    if (this.isTargetingMode) {
                        this._enteredPoskeyInTargetingMode = true;
                    }
                    this.isTopLevelTurn = !this.isTargetingMode && !this.isMenuOpen && !this.isTextWindowOpen && !this.isPromptOpen;
                    this.setState(NetHackWasmDriver.DriverState.WAITING_INPUT);
                    const { promise, safeResolver } = this.inputResolver ?
                        this.inputResolver.createPending('getch') :
                        { promise: Promise.resolve(32), safeResolver: null };

                    const promptCategory = this.getPromptCategory('getch', 'char');

                    if (!this.tryConsumeSequenceToken("", safeResolver, 'getch')) {
                        if (!this.sequenceOptions.suppressPrompts) {
                            this.emit("inputRequired", {
                                context: "getch",
                                type: "char",
                                promptCategory,
                                resolver: safeResolver
                            });
                        }
                    }

                    const key = await promise;
                    this.setState(NetHackWasmDriver.DriverState.RUNNING);
                    return key;
                }

                case "shim_nh_poskey": {
                    if (this.isTargetingMode) {
                        this._enteredPoskeyInTargetingMode = true;
                    }
                    this.isTopLevelTurn = !this.isTargetingMode && !this.isMenuOpen && !this.isTextWindowOpen && !this.isPromptOpen;
                    this.setState(NetHackWasmDriver.DriverState.WAITING_INPUT);
                    const { promise, safeResolver } = this.inputResolver ?
                        this.inputResolver.createPending('poskey') :
                        { promise: Promise.resolve(32), safeResolver: null };

                    const promptCategory = this.getPromptCategory('poskey', 'poskey');

                    if (!this.tryConsumeSequenceToken("", safeResolver, 'poskey')) {
                        if (!this.sequenceOptions.suppressPrompts) {
                            this.emit("inputRequired", {
                                context: "poskey",
                                type: "poskey",
                                promptCategory,
                                resolver: safeResolver
                            });
                        }
                    }

                    const res = await promise;
                    this.setState(NetHackWasmDriver.DriverState.RUNNING);

                    if (typeof res === 'object' && res && res.x !== undefined && res.y !== undefined) {
                        const M = this.getModule();
                        const setVal = (M && M.setValue) ? M.setValue.bind(M) : (typeof setValue !== 'undefined' ? setValue : null);
                        if (setVal) {
                            setVal(args[0], res.x, 'i16');
                            setVal(args[1], res.y, 'i16');
                            setVal(args[2], res.mod || 0, 'i32');
                        }
                        return 0;
                    }
                    if (typeof res === 'number') return res;
                    if (typeof res === 'string' && res.length > 0) return res.charCodeAt(0);
                    if (Array.isArray(res) && res.length > 0) {
                        const first = res[0];
                        if (typeof first === 'number') return first;
                        if (typeof first === 'string' && first.length > 0) return first.charCodeAt(0);
                    }
                    return 0;
                }

                case "shim_yn_function": {
                    const query = args[0];
                    const choices = args[1] || "";
                    const def = args[2] || "";

                    this.isPromptOpen = true;
                    this.isTopLevelTurn = false;
                    this.setState(NetHackWasmDriver.DriverState.WAITING_INPUT);
                    const { promise, safeResolver } = this.inputResolver ?
                        this.inputResolver.createPending('yn_function', { query, choices, def }) :
                        { promise: Promise.resolve(def ? def.charCodeAt(0) : 27), safeResolver: null };

                    const promptCategory = this.getPromptCategory('yn_function', 'yn');

                    if (!this.tryConsumeSequenceToken(query, safeResolver, 'yn_function')) {
                        this.emit("inputRequired", {
                            context: "yn_function",
                            type: "yn",
                            promptCategory,
                            query,
                            question: query,
                            choices,
                            defaultChoice: def,
                            def,
                            resolver: safeResolver
                        });
                    }

                    const rawAns = await promise;
                    this.isPromptOpen = false;
                    this.setState(NetHackWasmDriver.DriverState.RUNNING);

                    const getSafeFallbackChar = () => {
                        if (def && typeof def === 'string' && def.length > 0 && choices && typeof choices === 'string' && choices.includes(def)) {
                            return def;
                        }
                        if (choices && typeof choices === 'string' && choices.length > 0) {
                            if (choices.includes('y')) return 'y';
                            if (choices.includes('n')) return 'n';
                            if (choices.includes('q')) return 'q';
                            return choices.charAt(0);
                        }
                        return 'y';
                    };

                    let ansCode = 27;
                    if (typeof rawAns === 'number' && !isNaN(rawAns)) {
                        ansCode = rawAns;
                    } else if (typeof rawAns === 'string' && rawAns.length > 0) {
                        ansCode = rawAns.charCodeAt(0);
                    } else if (def && typeof def === 'string' && def.length > 0) {
                        ansCode = def.charCodeAt(0);
                    }

                    const ansChar = (ansCode > 0 && !isNaN(ansCode)) ? String.fromCharCode(ansCode) : '';

                    const isDirectionQuery = (typeof query === 'string' && query.toLowerCase().includes("direction"));
                    const isDirectionChar = (isDirectionQuery || (choices && choices.includes("hjklyubn"))) && /^[1-9hjklyubn.]$/i.test(ansChar);

                    // yn_function 安全ガード: Enter(\r/13), LineFeed(\n/10), Space(32), 空回答/NaN/未入力等や未許可文字が返された場合、デフォルト選択肢文字へ安全正規化
                    if (isNaN(ansCode) || ansCode === 13 || ansCode === 10 || ansCode === 32 || ansChar === '\r' || ansChar === '\n' || ansCode <= 0) {
                        const fallbackChar = getSafeFallbackChar();
                        ansCode = fallbackChar ? fallbackChar.charCodeAt(0) : 27;
                    } else if (!isDirectionChar && choices && typeof choices === 'string' && choices.length > 0) {
                        if (!choices.includes(ansChar) && ansCode !== 27) {
                            console.warn(`[NetHackWasmDriver] Invalid char '${ansChar}' (${ansCode}) for yn_function ('${choices}'). Falling back to default.`);
                            const fallbackChar = getSafeFallbackChar();
                            ansCode = fallbackChar ? fallbackChar.charCodeAt(0) : 27;
                        }
                    }

                    return ansCode;
                }

                case "shim_getlin": {
                    const query = args[0];
                    const bufp = args[1];

                    this.isPromptOpen = true;
                    this.isTopLevelTurn = false;
                    this.setState(NetHackWasmDriver.DriverState.WAITING_INPUT);
                    const { promise, safeResolver } = this.inputResolver ?
                        this.inputResolver.createPending('getlin', { query }) :
                        { promise: Promise.resolve(null), safeResolver: null };

                    const promptCategory = this.getPromptCategory('getlin', 'string');

                    if (!this.tryConsumeSequenceToken(query, safeResolver, 'getlin')) {
                        this.emit("inputRequired", {
                            context: "getlin",
                            type: "string",
                            promptCategory,
                            query,
                            prompt: query,
                            resolver: safeResolver
                        });
                    }

                    const input = await promise;
                    this.isPromptOpen = false;
                    this.setState(NetHackWasmDriver.DriverState.RUNNING);

                    const M = this.getModule();
                    const strToUTF8 = (M && M.stringToUTF8) ? M.stringToUTF8.bind(M) : (typeof stringToUTF8 !== 'undefined' ? stringToUTF8 : null);

                    if (strToUTF8) {
                        if (typeof input === 'string') {
                            strToUTF8(input, bufp, 256);
                        } else if (input === 27) {
                            strToUTF8("\x1b", bufp, 256);
                        } else {
                            strToUTF8("", bufp, 256);
                        }
                    }
                    return 0;
                }

                case "shim_get_ext_cmd": {
                    this.isPromptOpen = true;
                    this.isTopLevelTurn = false;
                    this.setState(NetHackWasmDriver.DriverState.WAITING_INPUT);
                    const { promise, safeResolver } = this.inputResolver ?
                        this.inputResolver.createPending('get_ext_cmd') :
                        { promise: Promise.resolve(-1), safeResolver: null };

                    const extResolverObj = {
                        respond: (val) => {
                            if (!safeResolver) return false;
                            if (typeof val === 'string') {
                                let cleanVal = val.trim().toLowerCase();
                                if (cleanVal.startsWith('#')) {
                                    cleanVal = cleanVal.slice(1).trim();
                                }
                                const extcmds = NetHackWasmDriver.DEFAULT_EXTCMDS;
                                const idx = extcmds.indexOf(cleanVal);
                                return safeResolver.respond(idx >= 0 ? idx : -1);
                            }
                            return safeResolver.respond(typeof val === 'number' ? val : -1);
                        },
                        cancel: (overrideVal) => safeResolver ? safeResolver.cancel(overrideVal ?? -1) : false
                    };

                    const promptCategory = this.getPromptCategory('get_ext_cmd', 'ext_cmd');

                    if (!this.tryConsumeSequenceToken("#", extResolverObj, 'get_ext_cmd')) {
                        this.emit("inputRequired", {
                            context: "get_ext_cmd",
                            type: "ext_cmd",
                            promptCategory,
                            resolver: extResolverObj
                        });
                    }

                    const idx = await promise;
                    this.isPromptOpen = false;
                    this.setState(NetHackWasmDriver.DriverState.RUNNING);
                    return typeof idx === 'number' ? idx : -1;
                }

                case "shim_status_update": {
                    const decoded = this.memory ? this.memory.parseStatusUpdate(args[0], args[1], args[2], args[4]) : { field: args[0], value: args[1] };
                    if (decoded.fld === 35) { // BL_VERS
                        this.version = decoded.rawVal || "";
                    }
                    this.emit("status_update", decoded);
                    return 0;
                }

                case "shim_nhbell":
                    this.emit("bell", {});
                    return 0;

                case "shim_cliparound":
                    this.emit("cliparound", { x: args[0], y: args[1] });
                    return 0;

                case "shim_delay_output":
                    await new Promise(resolve => setTimeout(resolve, 50));
                    return 0;

                default:
                    return 0;
            }
        }

        sendInput(value) {
            // 手動入力介入時、待機中の古い自動同期 (isSilentSync) タスクを安全キャンセル
            if (this.sequenceTaskQueue.length > 0) {
                this.sequenceTaskQueue = this.sequenceTaskQueue.filter(task => {
                    if (task.options && task.options.isSilentSync) {
                        if (typeof task.reject === 'function') {
                            task.reject(new Error('Sequence cancelled due to manual input'));
                        }
                        return false;
                    }
                    return true;
                });
            }
            return this.inputResolver ? this.inputResolver.respond(value) : false;
        }

        /**
         * 仮想 FS 上のセーブファイル一覧を取得
         */
        listSaveFiles() {
            const FS = (this.fsManager && this.fsManager.FS) ? this.fsManager.FS : (typeof globalThis !== 'undefined' && globalThis.FS ? globalThis.FS : null);
            if (!FS) return [];
            try {
                const saveDir = '/save';
                if (!FS.analyzePath(saveDir).exists) return [];
                const files = FS.readdir(saveDir);
                const systemFiles = ['.', '..', 'perm', 'record', 'sysconf', 'logfile', 'xlogfile', 'paniclog', 'bonuses', 'bones'];
                return files
                    .filter(f => !systemFiles.includes(f) && !f.startsWith('.'))
                    .map(filename => {
                        const path = `${saveDir}/${filename}`;
                        const stat = FS.stat(path);
                        return {
                            filename,
                            path,
                            size: stat.size,
                            timestamp: new Date(stat.mtime)
                        };
                    });
            } catch (e) {
                console.warn("[NetHackWasmDriver] Error listing save files:", e);
                return [];
            }
        }

        /**
         * 指定されたセーブファイルを VFS および IndexedDB から完全に削除
         */
        async deleteSaveFile(targetFilename) {
            if (this.fsManager) {
                return await this.fsManager.deleteSaveFile(targetFilename);
            }
            const FS = (typeof globalThis !== 'undefined' && globalThis.FS ? globalThis.FS : null);
            if (!FS) return false;
            try {
                const cleanName = targetFilename.replace(/^\/save\//, '');
                const paths = [`/save/${cleanName}`, cleanName];
                let deleted = false;
                paths.forEach(p => {
                    try {
                        if (FS.analyzePath(p).exists) {
                            FS.unlink(p);
                            deleted = true;
                        }
                    } catch(e) {}
                });
                return deleted;
            } catch (e) {
                console.error("[NetHackWasmDriver] Error deleting save file:", e);
                return false;
            }
        }

        /**
         * Driver の再初期化 / リセット Safe API
         */
        async restart(options = {}) {
            // ライフサイクル連動: 再起動時に前セッションの記録状態を確実にリセット
            this.stopRecording();

            if (this.workerBridge && typeof this.workerBridge.restart === 'function') {
                return await this.workerBridge.restart(options);
            }
            if (this.worker && typeof this.worker.terminate === 'function') {
                try {
                    this.worker.terminate();
                } catch(e) {}
            }
            if (typeof this.init === 'function') {
                return await this.init(options);
            }
            return true;
        }
    }

    global.NetHackWasmDriver = NetHackWasmDriver;
    if (typeof window !== 'undefined') {
        window.NetHackWasmDriver = NetHackWasmDriver;
    }
    if (typeof globalThis !== 'undefined') {
        globalThis.NetHackWasmDriver = NetHackWasmDriver;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = NetHackWasmDriver;
        module.exports.NetHackWasmDriver = NetHackWasmDriver;
        module.exports.default = NetHackWasmDriver;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));


