/**
 * InputResolver.js
 * Wasm 側の同期入力待ち（Asyncify）に対する Promise 管理とセーフティレスポンダー
 */
(function (global) {
    if (global.InputResolver) return;

    /**
     * Proxy (Vue, Solid, Svelte store 等) や循環参照のないオブジェクトを
     * 安全に Structured Clone 可能な Plain JavaScript Object に変換します。
     */
    function unwrapPayload(value) {
        if (value === null || value === undefined) return value;
        if (typeof value !== 'object') return value;

        try {
            // structuredClone が使える場合
            if (typeof structuredClone === 'function') {
                return structuredClone(value);
            }
        } catch (e) {
            // fallback: JSON parse/stringify
        }

        try {
            return JSON.parse(JSON.stringify(value));
        } catch (e) {
            return value;
        }
    }

    class InputResolver {
        constructor(options = {}) {
            this.pendingResolver = null;
            this.pendingContext = null;
            this.timeoutMs = options.timeoutMs || 0; // 0 はタイムアウト無効
            this.timerId = null;
            this.onTimeout = options.onTimeout || null;
            this.unwrapPayload = options.unwrapPayload !== false;
            this.currentResolverId = 0;
        }

        isUserPromptContext(context) {
            const userContexts = ['askname', 'name', 'yn_function', 'yn', 'select_menu', 'menu', 'getlin', 'get_ext_cmd', 'ext_cmd', 'poskey', 'getch'];
            return userContexts.includes(context);
        }

        /**
         * 新しい入力待機を登録します。
         * @param {string} context - 'key', 'poskey', 'yn', 'menu', 'getlin', 'name', 'ext_cmd', 'display' 等
         * @param {object} extra - choices, prompt など
         * @returns {{ promise: Promise, safeResolver: Function }}
         */
        createPending(context, extra = {}) {
            // 既存が真のユーザー入力待機であり、新規が単なる display 表示要求等の場合、既存のユーザー入力待機を保護
            if (this.pendingContext && this.isUserPromptContext(this.pendingContext.context) && !this.isUserPromptContext(context)) {
                // 既存のユーザー入力待機を上書きせず保持
                return {
                    promise: Promise.resolve(0),
                    safeResolver: () => false
                };
            }

            // 既存の待機があれば Stale (無効) 化して安全に破棄
            this.stale();

            this.currentResolverId++;
            const resolverId = this.currentResolverId;
            this.pendingContext = { context, ...extra, resolverId };

            let safeResolveFn = null;

            const promise = new Promise((resolve) => {
                let resolved = false;

                // SafeResolver: 1度だけ呼び出しを許可するラッパー関数
                const safeResolver = (val) => {
                    if (resolved) {
                        if (this.debug) {
                            console.warn(`[InputResolver] SafeResolver: Resolver for context '${context}' (ID: ${resolverId}) was already resolved. Ignoring duplicate call.`);
                        }
                        return false;
                    }
                    resolved = true;
                    if (this.currentResolverId === resolverId) {
                        this.cleanup();
                    }
                    const cleanValue = this.unwrapPayload ? unwrapPayload(val) : val;
                    resolve(cleanValue);
                    return true;
                };

                safeResolver.respond = (val) => safeResolver(val);
                safeResolver.cancel = () => {
                    if (resolved) return false;
                    return this.cancel();
                };
                safeResolver.isResolved = () => resolved;

                safeResolveFn = safeResolver;
                this.pendingResolver = safeResolver;

                if (this.timeoutMs > 0) {
                    this.timerId = setTimeout(() => {
                        console.warn(`[InputResolver] Safety timeout fired for context '${context}'. Auto-cancelling.`);
                        if (this.onTimeout) this.onTimeout(context);
                        this.cancel();
                    }, this.timeoutMs);
                }
            });

            return { promise, safeResolver: safeResolveFn };
        }

        cleanup() {
            if (this.timerId) {
                clearTimeout(this.timerId);
                this.timerId = null;
            }
            this.pendingResolver = null;
            this.pendingContext = null;
        }

        /**
         * 直前の未解決 Resolver を C コアへの応答なしで無効化 (Stale) します。
         */
        stale() {
            if (this.pendingResolver) {
                const ctx = this.pendingContext ? this.pendingContext.context : 'unknown';
                if (this.debug) {
                    console.log(`[InputResolver] Input staled for context '${ctx}'. Invalidating old resolver.`);
                }
                const resolver = this.pendingResolver;
                this.cleanup();
                if (typeof resolver === 'function') {
                    try { resolver(undefined); } catch (e) {}
                }
                return true;
            }
            return false;
        }

        /**
         * クライアントからの正規な回答を渡し、Promise を resolve します。
         */
        respond(value) {
            if (this.pendingResolver) {
                const resolver = this.pendingResolver;
                return resolver(value);
            }
            return false;
        }

        /**
         * 入力をキャンセルし、Wasm フリーズを防ぐため標準的なキャンセル値 (ESC: 27 または null) を返します。
         */
        cancel() {
            if (this.pendingResolver) {
                const ctx = this.pendingContext ? this.pendingContext.context : 'unknown';
                console.log(`[InputResolver] Input cancelled for context '${ctx}'. Resolving with fallback.`);

                let fallbackVal;
                if (ctx === 'yn' || ctx === 'yn_function') {
                    const choices = this.pendingContext?.choices || "";
                    if (choices.includes('q')) fallbackVal = 'q'.charCodeAt(0);
                    else if (choices.includes('n')) fallbackVal = 'n'.charCodeAt(0);
                    else fallbackVal = 27; // ESC
                } else if (ctx === 'menu' || ctx === 'select_menu') {
                    fallbackVal = 0; // 0 or []
                } else if (ctx === 'getlin' || ctx === 'name') {
                    fallbackVal = null;
                } else if (ctx === 'ext_cmd' || ctx === 'get_ext_cmd') {
                    fallbackVal = -1;
                } else {
                    fallbackVal = 27; // ASCII ESC
                }

                const resolver = this.pendingResolver;
                return resolver(fallbackVal);
            }
            return false;
        }

        isWaiting() {
            return this.pendingResolver !== null;
        }

        getContext() {
            return this.pendingContext;
        }
    }

    InputResolver.unwrapPayload = unwrapPayload;

    global.InputResolver = InputResolver;
    if (typeof window !== 'undefined') {
        window.InputResolver = InputResolver;
    }
    if (typeof globalThis !== 'undefined') {
        globalThis.InputResolver = InputResolver;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = InputResolver;
        module.exports.InputResolver = InputResolver;
        module.exports.unwrapPayload = unwrapPayload;
        module.exports.default = InputResolver;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));


