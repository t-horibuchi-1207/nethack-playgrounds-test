/**
 * NetHackMemory.js
 * Emscripten Wasm メモリとの低レイヤー相互変換・型解釈・デコードを担当するモジュール
 */
(function (global) {
    if (global.NetHackMemory) return;

    class NetHackMemory {
        constructor(moduleRef) {
            this.module = moduleRef || (typeof globalThis !== 'undefined' ? globalThis.Module : null);
        }

        setModule(moduleRef) {
            this.module = moduleRef;
        }

        get Module() {
            const winM = (typeof window !== 'undefined') ? window.Module : null;
            const globM = (typeof globalThis !== 'undefined') ? globalThis.Module : null;
            if (winM && (winM.getValue || winM.setValue)) return winM;
            if (globM && (globM.getValue || globM.setValue)) return globM;
            if (this.module && (this.module.getValue || this.module.setValue)) return this.module;
            return winM || globM || this.module;
        }

        getValue(ptr, type) {
            const M = this.Module;
            const getValFn = (M && M.getValue) ? M.getValue.bind(M) : (typeof getValue !== 'undefined' ? getValue : null);
            if (!getValFn || !ptr) return 0;
            return getValFn(ptr, type);
        }

        setValue(ptr, val, type) {
            const M = this.Module;
            const setValFn = (M && M.setValue) ? M.setValue.bind(M) : (typeof setValue !== 'undefined' ? setValue : null);
            if (!setValFn || !ptr) return;
            setValFn(ptr, val, type);
        }

        UTF8ToString(ptr) {
            const M = this.Module;
            const u8StrFn = (M && M.UTF8ToString) ? M.UTF8ToString.bind(M) : (typeof UTF8ToString !== 'undefined' ? UTF8ToString : null);
            if (!u8StrFn || !ptr) return "";
            return u8StrFn(ptr);
        }

        stringToUTF8(str, outPtr, maxBytes) {
            const M = this.Module;
            const strU8Fn = (M && M.stringToUTF8) ? M.stringToUTF8.bind(M) : (typeof stringToUTF8 !== 'undefined' ? stringToUTF8 : null);
            if (strU8Fn && outPtr) {
                strU8Fn(str, outPtr, maxBytes);
            }
        }

        /**
         * C言語側のポインタ ptr から指定型 type に従って値を読み出します。
         */
        getPointerValue(ptr, type) {
            if (!ptr) return null;

            switch (type) {
                case 'v': return null;
                case 'i': return this.getValue(ptr, 'i32');
                case 's': return this.UTF8ToString(ptr);
                case 'b': return !!this.getValue(ptr, 'i8');
                case 'c':
                case '0': return String.fromCharCode(this.getValue(ptr, 'i8'));
                case '1': return this.getValue(ptr, 'i16'); // coordxy
                case 'p': return ptr;
                default: return ptr;
            }
        }

        /**
         * C言語側の戻り値用ポインタ ret_ptr に値を書き込みます。
         */
        setPointerValue(ret_ptr, type, value) {
            if (!ret_ptr) return;
            const M = this.Module;

            switch (type) {
                case 'i':
                    this.setValue(ret_ptr, value, 'i32');
                    break;
                case 'b':
                    this.setValue(ret_ptr, value ? 1 : 0, 'i8');
                    break;
                case 'c':
                    this.setValue(ret_ptr, typeof value === 'string' ? value.charCodeAt(0) : value, 'i8');
                    break;
                case '1':
                case '2':
                    this.setValue(ret_ptr, value, 'i16');
                    break;
                case 's':
                    if (value === null || value === undefined) {
                        this.setValue(ret_ptr, 0, 'i32');
                    } else if (typeof value === 'string') {
                        const mallocFn = (M && M._malloc) ? M._malloc.bind(M) : (typeof _malloc !== 'undefined' ? _malloc : null);
                        if (mallocFn) {
                            const ptr = mallocFn(value.length + 1);
                            this.stringToUTF8(value, ptr, value.length + 1);
                            this.setValue(ret_ptr, ptr, 'i32');
                        }
                    } else if (typeof value === 'number') {
                        if (value <= 0 || value === 27) {
                            this.setValue(ret_ptr, 0, 'i32');
                        } else if (value > 65536) {
                            this.setValue(ret_ptr, value, 'i32');
                        } else {
                            const strVal = String(value);
                            const mallocFn = (M && M._malloc) ? M._malloc.bind(M) : (typeof _malloc !== 'undefined' ? _malloc : null);
                            if (mallocFn) {
                                const ptr = mallocFn(strVal.length + 1);
                                this.stringToUTF8(strVal, ptr, strVal.length + 1);
                                this.setValue(ret_ptr, ptr, 'i32');
                            }
                        }
                    } else {
                        this.setValue(ret_ptr, 0, 'i32');
                    }
                    break;
                case 'p':
                    this.setValue(ret_ptr, value, 'i32');
                    break;
            }
        }

        /**
         * NetHack 3.7 / 5.0 の glyph_info 構造体メモリからデータを展開・デコードします。
         */
        parseGlyphInfo(ptr) {
            if (!ptr) return null;

            const GLYPH_OFFSET = 0;
            const TTYCHAR_OFFSET = 4;
            const FRAMECOLOR_OFFSET = 8;
            const GM_OFFSET = 12; // glyph_map starts here

            const GM_FLAGS_OFFSET = GM_OFFSET + 0;
            const GM_COLOR_OFFSET = GM_OFFSET + 4;
            const GM_SYMIDX_OFFSET = GM_OFFSET + 8;
            const GM_TILEIDX_OFFSET = GM_OFFSET + 18; // NetHack 5.0 glyph_map.tileidx
            const GM_U_OFFSET = GM_OFFSET + 20; // pointer to unicode_representation

            const glyph = this.getValue(ptr + GLYPH_OFFSET, 'i32');
            const symbol = this.getValue(ptr + TTYCHAR_OFFSET, 'i32');
            const framecolor = this.getValue(ptr + FRAMECOLOR_OFFSET, 'i32');

            const flags = this.getValue(ptr + GM_FLAGS_OFFSET, 'i32');
            const color = this.getValue(ptr + GM_COLOR_OFFSET, 'i32');
            const symidx = this.getValue(ptr + GM_SYMIDX_OFFSET, 'i32');
            const tileidx = this.getValue(ptr + GM_TILEIDX_OFFSET, 'i16');

            let ch = String.fromCharCode(symbol);
            const uPtr = this.getValue(ptr + GM_U_OFFSET, 'i32');
            if (uPtr) {
                const utf8strPtr = this.getValue(uPtr + 4, 'i32');
                if (utf8strPtr) {
                    ch = this.UTF8ToString(utf8strPtr);
                }
            }

            return { glyph, symbol, framecolor, flags, color, symidx, tileidx, ch };
        }

        /**
         * shim_status_update の生引数をデコードし、構造化された値を返します。
         */
        parseStatusUpdate(fld, ptr, chg, clr) {
            let rawVal = null;
            let parsedVal = null;
            let glyphId = null;

            if (!ptr && fld !== 20 && fld !== 10) {
                return { fld, field: fld, value: 0, rawVal: 0, parsedVal: 0, chg, clr, dlevelData: null, goldData: null };
            }

            if (fld === 22) { // BL_CONDITION
                try {
                    rawVal = (typeof ptr === 'number' && ptr > 65536) ? (this.getValue(ptr, 'i32') || 0) : Number(ptr);
                } catch (e) {
                    rawVal = 0;
                }
                parsedVal = this.parseConditionFlags(rawVal);
            } else if (fld === 17) { // BL_HUNGER
                try {
                    rawVal = this.UTF8ToString(ptr);
                } catch (e) {
                    rawVal = (typeof ptr === 'number' && ptr > 65536) ? this.getValue(ptr, 'i32') : ptr;
                }
                parsedVal = this.parseHungerState(rawVal);
            } else if (fld === 9) { // BL_CAP (空文字列 = Unencumbered)
                try {
                    rawVal = this.UTF8ToString(ptr);
                } catch (e) {
                    rawVal = (typeof ptr === 'number' && ptr > 65536) ? this.getValue(ptr, 'i32') : ptr;
                }
                parsedVal = rawVal || "";
            } else {
                if (typeof ptr === 'string') {
                    rawVal = ptr;
                } else if (typeof ptr === 'number') {
                    if (ptr > 65536) {
                        try {
                            const str = this.UTF8ToString(ptr);
                            if (str !== null && str !== undefined && str !== "") {
                                rawVal = str;
                            } else {
                                rawVal = this.getValue(ptr, 'i32');
                            }
                        } catch (e) {
                            try {
                                rawVal = this.getValue(ptr, 'i32');
                            } catch (err) {
                                rawVal = ptr;
                            }
                        }
                    } else {
                        rawVal = ptr;
                    }
                }
                parsedVal = rawVal;
            }

            // ゴールド表現 (BL_GOLD / Index 10) の構造化デコード
            let goldData = null;
            if (fld === 10) { // BL_GOLD
                let extractedGlyph = 3886; // NetHack 5.0 / 3.7 default Gold Pieces Glyph ID (0x0F2E = 3886)
                let amount = 0;

                if (typeof rawVal === 'string') {
                    if (rawVal.includes(':')) {
                        const parts = rawVal.split(':');
                        if (parts[0].includes('glyph:')) {
                            const rawHex = parts[0].replace('glyph:', '').trim();
                            extractedGlyph = rawHex.startsWith('0x') ? parseInt(rawHex, 16) : parseInt(rawHex, 10);
                        }
                        amount = parseInt(parts[parts.length - 1]) || 0;
                    } else {
                        amount = parseInt(rawVal) || 0;
                    }
                } else if (typeof rawVal === 'number') {
                    // ptr が直接 Glyph ID 数値として渡された場合
                    extractedGlyph = rawVal > 0 ? rawVal : 3886;
                }

                glyphId = extractedGlyph || 3886;
                goldData = { glyphId, amount, raw: rawVal };
            }

            // ダンジョン階層 (BL_DLEVEL / Index 20) の構造化デコード
            let dlevelData = null;
            if (fld === 20) { // BL_DLEVEL
                let dlevelStr = String(rawVal || "");
                let branch = "Dlvl";
                let dlevelNum = 1;

                if (dlevelStr.includes(':')) {
                    const parts = dlevelStr.split(':');
                    branch = parts[0].trim();
                    dlevelNum = parseInt(parts[1], 10) || 1;
                } else {
                    const match = dlevelStr.match(/([a-zA-Z]+)?\s*[:\-]?\s*(\d+)/);
                    if (match) {
                        if (match[1]) branch = match[1];
                        if (match[2]) dlevelNum = parseInt(match[2], 10);
                    } else if (!isNaN(parseInt(dlevelStr, 10))) {
                        dlevelNum = parseInt(dlevelStr, 10);
                    }
                }

                dlevelData = {
                    raw: rawVal,
                    dlevelStr,
                    dlevelNum,
                    branch
                };
            }

            return {
                fld,
                field: fld,
                value: parsedVal !== null ? parsedVal : rawVal,
                glyphId: glyphId !== null ? glyphId : (fld === 10 ? 3886 : null),
                rawVal,
                parsedVal,
                goldData,
                dlevelData,
                chg,
                clr
            };
        }

        /**
         * コンディションビットマスクを状態文字列配列に変換します (NetHack 3.7 / 5.0 完全仕様)
         */
        parseConditionFlags(condBitmask) {
            const CDT = {
                "BareHanded": 0x00000001,
                "Blind": 0x00000002,
                "Busy": 0x00000004,
                "Confused": 0x00000008,
                "Deaf": 0x00000010,
                "ElfIron": 0x00000020,
                "Flying": 0x00000040,
                "FoodPoisoning": 0x00000080,
                "GlowHands": 0x00000100,
                "Grabbing": 0x00000200,
                "Hallucinating": 0x00000400,
                "Held": 0x00000800,
                "Icy": 0x00001000,
                "InLava": 0x00002000,
                "Levitating": 0x00004000,
                "Paralyzed": 0x00008000,
                "Riding": 0x00010000,
                "Sleeping": 0x00020000,
                "Slimed": 0x00040000,
                "Slippery": 0x00080000,
                "Stoned": 0x00100000,
                "Strangled": 0x00200000,
                "Stunned": 0x00400000,
                "Submerged": 0x00800000,
                "Termill": 0x01000000,
                "Tethered": 0x02000000,
                "Trapped": 0x04000000,
                "Unconscious": 0x08000000,
                "WoundedLeg": 0x10000000,
                "Holding": 0x20000000
            };

            const activeConditions = [];
            for (const [name, mask] of Object.entries(CDT)) {
                if ((condBitmask & mask) !== 0) {
                    activeConditions.push(name);
                }
            }
            return activeConditions;
        }

        /**
         * 空腹・満腹ステータスを文字列表現にマッピング
         */
        parseHungerState(val) {
            if (typeof val === 'string') {
                const s = val.trim();
                return (s === 'Satisfied' || s === 'Not Hungry') ? '' : s;
            }
            if (typeof val === 'number') {
                const hungerMap = {
                    0: "Satiated",
                    1: "", // Normal (Not Hungry)
                    2: "Hungry",
                    3: "Weak",
                    4: "Fainting",
                    5: "Fainted",
                    6: "Starved"
                };
                return hungerMap[val] !== undefined ? hungerMap[val] : "";
            }
            return "";
        }

        /**
         * select_menu の返却用 menu_item 構造体配列バッファを生成します。
         * NetHack 5.0 / 3.7 C 構造体定義:
         * struct mi {
         *   anything item;      (8 bytes in wasm32 due to int64 member, 8-byte aligned)
         *   long count;         (4 bytes at offset 8)
         *   unsigned itemflags; (4 bytes at offset 12)
         * }; // sizeof(menu_item) == 16 bytes
         *
         * Offset:
         *   offset 0:  mi.item.a_obj / mi.item.a_int (uint32, low 4 bytes)
         *   offset 4:  mi.item high 4 bytes (zero padding, 4 bytes)
         *   offset 8:  mi.count (int32, 4 bytes)
         *   offset 12: mi.itemflags (unsigned int, 4 bytes)
         */
        buildMenuItemBuffer(selectedItems) {
            const M = this.Module;
            const mallocFn = (M && M._malloc) ? M._malloc.bind(M) : (typeof _malloc !== 'undefined' ? _malloc : null);
            if (!mallocFn || !selectedItems || selectedItems.length === 0) return 0;

            const ITEM_SIZE = 16;
            const ptr = mallocFn(ITEM_SIZE * selectedItems.length);

            selectedItems.forEach((item, index) => {
                const offset = ptr + (index * ITEM_SIZE);
                this.setValue(offset, item.identifier !== undefined ? item.identifier : 0, 'i32');
                this.setValue(offset + 4, 0, 'i32'); // high 4 bytes (zero padding)
                this.setValue(offset + 8, item.count !== undefined ? item.count : -1, 'i32');
                this.setValue(offset + 12, (item.itemflags || 0) | 1, 'i32'); // SELECTED = 1
            });

            return ptr;
        }
    }

    global.NetHackMemory = NetHackMemory;
    if (typeof window !== 'undefined') {
        window.NetHackMemory = NetHackMemory;
    }
    if (typeof globalThis !== 'undefined') {
        globalThis.NetHackMemory = NetHackMemory;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = NetHackMemory;
        module.exports.NetHackMemory = NetHackMemory;
        module.exports.default = NetHackMemory;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));


