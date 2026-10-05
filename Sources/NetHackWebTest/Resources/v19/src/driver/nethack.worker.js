// src/driver/nethack.worker.js
// 共通のドライバスクリプトをロード
importScripts(
    './InputResolver.js',
    './NetHackMemory.js',
    './NetHackFSManager.js',
    './NetHackWasmDriver.js'
);

let driver = null;
const savedResolvers = new Map();
let resolverIdCounter = 0;

self.onmessage = async function(e) {
    const { type, payload } = e.data;

    switch (type) {
        case 'INIT': {
            let { wasmJsUrl, options } = payload;

            // Worker (src/driver/nethack.worker.js) から見た相対パス補正
            if (wasmJsUrl === './nethack.js' || wasmJsUrl === 'nethack.js') {
                wasmJsUrl = '../../nethack.js';
            }

            // Module の初期設定
            self.Module = self.Module || {};
            const initialArgs = (options && (options.arguments || options.args)) || [];
            if (initialArgs && initialArgs.length > 0) {
                self.Module.arguments = initialArgs;
            }
            
            // locateFile をカスタマイズし、.wasm ファイルが正しい位置からロードされるようにする
            self.Module.locateFile = function(path, prefix) {
                if (path.endsWith('.wasm')) {
                    if (wasmJsUrl) {
                        if (wasmJsUrl.endsWith('.js')) {
                            return wasmJsUrl.slice(0, -3) + '.wasm';
                        }
                        const parts = wasmJsUrl.split('/');
                        parts.pop();
                        const dir = parts.join('/');
                        return dir ? (dir + '/' + path) : path;
                    }
                }
                return (prefix || '') + path;
            };

            // Wasm 起動前に環境変数 (ENV) を preRun で確実に仕込む
            self.Module.preRun = self.Module.preRun || [];
            self.Module.preRun.push(() => {
                const env = (typeof globalThis !== 'undefined' && globalThis.ENV) ? globalThis.ENV : (typeof ENV !== 'undefined' ? ENV : null);
                if (env) {
                    env.USER = undefined;
                    env.LOGNAME = undefined;
                    env.HOME = "/";
                    env.HACKDIR = "/";
                    env.SCOREDIR = "/save/";
                    env.LEVELDIR = "/";
                    env.SAVEDIR = "/save/";
                    
                    let initialOpts = [];
                    if (options && options.extraOptions && typeof options.extraOptions === 'string') {
                        options.extraOptions.split('\n').forEach(line => {
                            let trimmed = line.trim().replace(/^[, \t]+/, '').replace(/[, \t]+$/, '').trim();
                            if (trimmed) {
                                if (trimmed.startsWith('OPTIONS=')) {
                                    trimmed = trimmed.replace('OPTIONS=', '').trim();
                                }
                                if (trimmed && !trimmed.startsWith('#')) {
                                    initialOpts.push(trimmed);
                                }
                            }
                        });
                    }
                    if (options && options.gameOptions) {
                        for (const [k, v] of Object.entries(options.gameOptions)) {
                            if (typeof v === 'boolean') {
                                initialOpts.push(v ? k : `!${k}`);
                            } else if (v !== undefined && v !== null) {
                                initialOpts.push(`${k}:${v}`);
                            }
                        }
                    }
                    if (initialOpts.length > 0) {
                        env.NETHACKOPTIONS = initialOpts.join(",");
                        console.log("[nethack.worker] ENV.NETHACKOPTIONS initialized in preRun:", env.NETHACKOPTIONS);
                    }
                }
            });

            // Driver インスタンス作成
            driver = new NetHackWasmDriver(options);

            // Driver のイベントをメインスレッドへフォワードする設定
            const driverEvents = [
                'started', 'exited', 'stateChange', 'init_nhwindows', 
                'exit_nhwindows', 'create_nhwindow', 'clear_nhwindow', 
                'display_nhwindow', 'destroy_nhwindow', 'curs', 'putstr', 
                'display_file', 'status_update', 'bell', 'cliparound', 
                'inputRequired', 'raw_print', 'raw_print_bold', 'putmixed',
                'print_glyph', 'putmsg'
            ];

            driverEvents.forEach(evtName => {
                driver.on(evtName, async (data) => {
                    // 🤫 サイレント同期タスク (isSilentSync: true) の実行中は、メインスレッドへの UI/メッセージログイベント通知を抑止
                    const isSilentSync = driver && driver.currentTask && driver.currentTask.options && driver.currentTask.options.isSilentSync;
                    if (isSilentSync) {
                        const opts = driver.currentTask.options || {};
                        const allowMap = !!(opts.allowMapUpdates || (opts.stepDelayMs > 0));
                        const isMapUpdateDisplay = (evtName === 'display_nhwindow' && data && data.windowId <= 3 && !data.blocking);

                        if (!isMapUpdateDisplay || !allowMap) {
                            const uiEvents = ['putmsg', 'putstr', 'raw_print', 'raw_print_bold', 'putmixed', 'inputRequired', 'display_nhwindow', 'clear_nhwindow'];
                            if (uiEvents.includes(evtName)) {
                                return;
                            }
                        }
                    }

                    let cleanData = data ? { ...data } : {};
                    
                    // resolver (関数を含む) はスレッド境界を越えられないため、IDでマッピング管理する
                    if (data && data.resolver) {
                        const resolverId = ++resolverIdCounter;
                        savedResolvers.set(resolverId, data.resolver);
                        cleanData.resolverId = resolverId;
                        cleanData.hasResolver = true;
                        delete cleanData.resolver; // 関数プロパティを除去
                    }

                    if (evtName === 'exited' && driver && typeof driver.syncToPersistent === 'function') {
                        try {
                            await driver.syncToPersistent();
                        } catch (e) {
                            console.warn("[nethack.worker] syncToPersistent error on exited:", e);
                        }
                    }

                    if (driver) {
                        cleanData.isExecutingSequence = driver.isExecutingSequence;
                        cleanData.isTopLevelTurn = driver.isTopLevelTurn;
                        cleanData.canAcceptSequenceInterruption = typeof driver.canAcceptSequenceInterruption === 'function' ? driver.canAcceptSequenceInterruption() : true;
                    }

                    self.postMessage({ type: 'EVENT', event: evtName, data: cleanData });
                });
            });

            const performDriverInit = () => {
                driver.init(self.Module);
                self.postMessage({ type: 'INIT_DONE' });
            };

            // 指定された Wasm JSファイルを動的にロード
            if (wasmJsUrl) {
                // すでに初期化済みの場合は直接初期化を実行
                if (self.Module.calledRun || self.Module.runtimeInitialized) {
                    performDriverInit();
                } else {
                    self.Module.onRuntimeInitialized = function() {
                        performDriverInit();
                    };
                    try {
                        importScripts(wasmJsUrl);
                    } catch (err) {
                        console.error("[nethack.worker] Failed to load Wasm JS script:", wasmJsUrl, err);
                        self.postMessage({ type: 'ERROR', message: `Failed to load Wasm script: ${err.message}` });
                        return;
                    }
                }
            } else {
                performDriverInit();
            }
            break;
        }

        case 'START': {
            if (!driver) {
                self.postMessage({ type: 'ERROR', message: 'Driver not initialized' });
                return;
            }
            try {
                const exitCode = await driver.start(payload ? payload.options : {});
                self.postMessage({ type: 'EXIT', exitCode });
            } catch (err) {
                console.error("[nethack.worker] Driver execution error:", err);
                self.postMessage({ type: 'ERROR', message: err.message });
            }
            break;
        }

        case 'RESPOND_INPUT': {
            const { resolverId, value, isCancel } = payload;
            const resolver = savedResolvers.get(resolverId);
            if (resolver) {
                savedResolvers.delete(resolverId);
                if (isCancel) {
                    resolver.cancel();
                } else {
                    resolver.respond(value);
                }
            } else {
                console.warn("[nethack.worker] Resolver not found or already resolved:", resolverId);
            }
            break;
        }

        case 'DELETE_SAVE': {
            if (driver) {
                const success = await driver.deleteSaveFile(payload.filename);
                self.postMessage({ type: 'DELETE_SAVE_RESULT', success, filename: payload.filename });
            }
            break;
        }

        case 'DETECT_SAVE_NAME': {
            if (driver && driver.fsManager) {
                const saveName = driver.fsManager.autoDetectSavePlayerName();
                self.postMessage({ type: 'DETECT_SAVE_NAME_RESULT', saveName });
            } else {
                self.postMessage({ type: 'DETECT_SAVE_NAME_RESULT', saveName: "" });
            }
            break;
        }

        case 'LIST_SAVE_FILES': {
            if (driver && driver.fsManager) {
                const saveFiles = driver.fsManager.listSaveFiles();
                self.postMessage({ type: 'LIST_SAVE_FILES_RESULT', saveFiles });
            } else {
                self.postMessage({ type: 'LIST_SAVE_FILES_RESULT', saveFiles: [] });
            }
            break;
        }

        case 'GET_DEBUG_STATUS': {
            if (driver && typeof driver.getDebugStatus === 'function') {
                const status = driver.getDebugStatus();
                self.postMessage({ type: 'DEBUG_STATUS_RESULT', status });
            }
            break;
        }

        case 'QUEUE_SEQUENCE': {
            if (driver && typeof driver.queueSequence === 'function') {
                const seqId = payload.sequenceId || (payload.options ? payload.options.sequenceId : null);
                const options = { ...payload.options, sequenceId: seqId };
                driver.queueSequence(payload.tokens, options)
                    .then(buffer => {
                        self.postMessage({
                            type: 'SEQUENCE_FINISHED',
                            sequenceId: seqId,
                            buffer: buffer || []
                        });
                    })
                    .catch(err => {
                        self.postMessage({
                            type: 'SEQUENCE_CANCELLED',
                            sequenceId: seqId,
                            error: err ? err.message : 'Cancelled'
                        });
                    });
            }
            break;
        }

        case 'CANCEL_SEQUENCE': {
            if (driver && typeof driver.cancelSequence === 'function') {
                driver.cancelSequence();
            }
            break;
        }

        case 'GET_LAST_SEQUENCE_BUFFER': {
            const buffer = (driver && typeof driver.getLastSequenceBuffer === 'function') ? driver.getLastSequenceBuffer() : [];
            self.postMessage({ type: 'GET_LAST_SEQUENCE_BUFFER_RESULT', buffer, requestId: payload ? payload.requestId : null });
            break;
        }
    }
};
