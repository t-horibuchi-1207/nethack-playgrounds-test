/**
 * NetHackFSManager.js
 * Emscripten 仮想ファイルシステム (FS) や IndexedDB (IDBFS) のカプセル化・スコアログ解析モジュール
 */
(function (global) {
    if (global.NetHackFSManager) return;

    class NetHackFSManager {
        constructor(options = {}) {
            this.debug = options && options.debug !== undefined ? !!options.debug : false;
        }

        log(...args) {
            if (this.debug) {
                console.log("[NetHackFSManager]", ...args);
            }
        }

        warn(...args) {
            if (this.debug) {
                console.warn("[NetHackFSManager]", ...args);
            }
        }

        error(...args) {
            console.error("[NetHackFSManager]", ...args);
        }

        get FS() {
            if (typeof globalThis !== 'undefined' && globalThis.FS) {
                return globalThis.FS;
            }
            return null;
        }

        get IDBFS() {
            if (typeof globalThis !== 'undefined' && globalThis.IDBFS) {
                return globalThis.IDBFS;
            }
            return null;
        }

        /**
         * NetHack 用のファイルシステム初期化 (/save, /tmp の作成と IDBFS マウント)
         */
        async initFileSystem(extraOptions = "") {
            const FS = this.FS;
            const IDBFS = this.IDBFS;

            this.log("Starting initFileSystem...");

            if (!FS) {
                this.warn("Emscripten FS is NOT defined!");
                return false;
            }

            const dirs = ['/save', '/tmp'];
            dirs.forEach(dir => {
                try {
                    const res = FS.analyzePath(dir);
                    if (!res.exists) {
                        try {
                            FS.mkdir(dir);
                            this.log(`Created directory: ${dir}`);
                        } catch (mkErr) {
                            if (mkErr && (mkErr.errno === 10 || mkErr.errno === 16)) {
                                this.log(`Directory ${dir} already exists (${mkErr.errno}).`);
                            } else {
                                throw mkErr;
                            }
                        }
                    }
                    if (dir === '/save' && IDBFS) {
                        try {
                            FS.mount(IDBFS, {}, dir);
                            this.log(`Mounted IDBFS at ${dir}`);
                        } catch (mntErr) {
                            if (mntErr && (mntErr.errno === 10 || mntErr.errno === 16)) {
                                this.log(`IDBFS already mounted at ${dir}.`);
                            } else {
                                throw mntErr;
                            }
                        }
                    }
                } catch (e) {
                    this.log(`Init dir ${dir} note:`, e.message || e);
                }
            });

            const setupAll = () => {
                this.log("Executing setupAll() for system files...");
                // 1. Write Config Files (NetHack.cnf, .nethackrc)
                let configContent = `SCOREDIR=/save/\nSAVEDIR=/save/\nLEVELDIR=/\n`;
                if (extraOptions) {
                    extraOptions.split('\n').forEach(line => {
                        let trimmed = line.trim().replace(/^[, \t]+/, '').replace(/[, \t]+$/, '').trim();
                        if (trimmed) {
                            if (trimmed.includes('=') || trimmed.startsWith('#')) {
                                configContent += trimmed + "\n";
                            } else {
                                configContent += `OPTIONS=${trimmed}\n`;
                            }
                        }
                    });
                }

                ['NetHack.cnf', '.nethackrc'].forEach(cf => {
                    try {
                        FS.writeFile('/' + cf, configContent);
                        this.log(`Created config file /${cf}`);
                    } catch (e) {
                        this.error(`Failed to write /${cf}:`, e);
                    }
                });

                // 2. Write sysconf to all candidate locations
                const sysconfContent = "WIZARDS=*\nEXPLORERS=*\n";
                ['/sysconf', '/save/sysconf', 'sysconf'].forEach(p => {
                    try {
                        FS.writeFile(p, sysconfContent);
                        this.log(`Written sysconf file at '${p}'`);
                    } catch (e) {}
                });

                // 3. Write perm file to root and /save/
                const permContent = "*\n";
                ['/perm', '/save/perm', 'perm'].forEach(p => {
                    try {
                        FS.writeFile(p, permContent);
                        this.log(`Written perm file at '${p}'`);
                    } catch (e) {}
                });

                // 4. Write System Log Files
                ['record', 'logfile', 'xlogfile', 'paniclog'].forEach(f => {
                    try {
                        const rootPath = '/' + f;
                        const savePath = '/save/' + f;

                        if (FS.analyzePath(savePath).exists) {
                            const data = FS.readFile(savePath);
                            if (data && data.length > 0) {
                                FS.writeFile(rootPath, data);
                            } else {
                                FS.writeFile(rootPath, "");
                            }
                        } else {
                            FS.writeFile(rootPath, "");
                            FS.writeFile(savePath, "");
                        }
                    } catch (e) {}
                });

                this.log("All files initialized successfully.");
            };

            if (IDBFS) {
                return new Promise((resolve) => {
                    this.log("Calling FS.syncfs(true)...");
                    FS.syncfs(true, (err) => {
                        if (err) this.error("IDBFS sync error (Initial):", err);
                        else this.log("IDBFS sync(true) complete.");
                        
                        setupAll();

                        this.log("Calling FS.syncfs(false)...");
                        FS.syncfs(false, (err2) => {
                            if (err2) this.error("IDBFS sync error (Final):", err2);
                            else this.log("All FS preparation & sync(false) complete.");
                            resolve(!err && !err2);
                        });
                    });
                });
            } else {
                setupAll();
                return true;
            }
        }

        prepareSystemFiles() {}
        setupNethackRC(extraOptions = "") {}

        _isRealSaveFile(f) {
            if (!f || typeof f !== 'string') return false;
            if (f.startsWith('.')) return false;
            const systemFiles = ['perm', 'record', 'sysconf', 'logfile', 'xlogfile', 'paniclog', 'bonuses', 'bones', 'help', 'hh', 'cmdhelp', 'optmenu', 'license', 'history', 'opthelp', 'wizhelp'];
            if (systemFiles.includes(f)) return false;
            return /^\d+[a-zA-Z0-9_\-]+$/.test(f) || /^\d+.+$/.test(f);
        }

        /**
         * 変更された永続データを /save ディレクトリおよび IDBFS と同期
         */
        syncToPersistent() {
            const FS = this.FS;
            const IDBFS = this.IDBFS;
            if (!FS) return Promise.resolve(false);

            const persistentFiles = ['record', 'logfile', 'xlogfile', 'paniclog', 'perm'];

            try {
                const checkDirs = ['/', '/save'];
                checkDirs.forEach(dir => {
                    if (FS.analyzePath(dir).exists) {
                        const files = FS.readdir(dir);
                        files.forEach(f => {
                            if (this._isRealSaveFile(f) && !persistentFiles.includes(f)) {
                                persistentFiles.push(f);
                            }
                        });
                    }
                });
            } catch(e) {}

            persistentFiles.forEach(f => {
                try {
                    const rootPath = '/' + f;
                    const savePath = '/save/' + f;

                    const rootExists = FS.analyzePath(rootPath).exists;
                    const saveExists = FS.analyzePath(savePath).exists;

                    if (rootExists && saveExists) {
                        const rootTime = FS.stat(rootPath).mtime.getTime();
                        const saveTime = FS.stat(savePath).mtime.getTime();

                        if (saveTime > rootTime) {
                            const data = FS.readFile(savePath);
                            FS.writeFile(rootPath, data);
                        } else if (rootTime > saveTime) {
                            const data = FS.readFile(rootPath);
                            FS.writeFile(savePath, data);
                        }
                    } else if (rootExists && !saveExists) {
                        const data = FS.readFile(rootPath);
                        FS.writeFile(savePath, data);
                    } else if (!rootExists && saveExists) {
                        const data = FS.readFile(savePath);
                        FS.writeFile(rootPath, data);
                    }
                } catch (e) {
                    this.error(`Failed to sync file ${f}:`, e);
                }
            });

            if (IDBFS) {
                return new Promise((resolve) => {
                    FS.syncfs(false, (err) => {
                        if (err) {
                            this.error("IDBFS sync error:", err);
                            resolve(false);
                        } else {
                            this.log("IDBFS sync complete.");
                            resolve(true);
                        }
                    });
                });
            } else {
                return Promise.resolve(true);
            }
        }

        hasSaveData() {
            const FS = this.FS;
            if (FS) {
                try {
                    const saveDirs = ['/save', '/'];
                    for (let dir of saveDirs) {
                        if (FS.analyzePath(dir).exists) {
                            const files = FS.readdir(dir);
                            const saveFile = files.find(f => this._isRealSaveFile(f));
                            if (saveFile) return true;
                        }
                    }
                } catch(e) {}
            }
            return false;
        }

        async hasSaveDataAsync() {
            if (this.hasSaveData()) return true;
            const dbSaveName = await NetHackFSManager.autoDetectSavePlayerNameFromIndexedDB();
            return !!(dbSaveName && dbSaveName.length > 0);
        }

        readXlogText() {
            const FS = this.FS;
            if (!FS) return "";
            try {
                const paths = ['/save/xlogfile', '/xlogfile'];
                for (let p of paths) {
                    if (FS.analyzePath(p).exists) {
                        const data = FS.readFile(p, { encoding: 'utf8' });
                        if (data && data.trim()) return data;
                    }
                }
            } catch (e) {}
            return "";
        }

        async readXlogTextAsync() {
            const text = this.readXlogText();
            if (text && text.trim()) return text;
            return await NetHackFSManager.readTextFromIndexedDB('xlogfile');
        }

        readRecordText() {
            const FS = this.FS;
            if (!FS) return "";
            try {
                const paths = ['/save/record', '/record', '/save/logfile', '/logfile'];
                for (let p of paths) {
                    if (FS.analyzePath(p).exists) {
                        const data = FS.readFile(p, { encoding: 'utf8' });
                        if (data && data.trim()) return data;
                    }
                }
            } catch (e) {}
            return "";
        }

        async readRecordTextAsync() {
            const text = this.readRecordText();
            if (text && text.trim()) return text;
            let recordText = await NetHackFSManager.readTextFromIndexedDB('record');
            if (!recordText) recordText = await NetHackFSManager.readTextFromIndexedDB('logfile');
            return recordText;
        }

        static async readTextFromIndexedDB(targetFileName) {
            if (typeof indexedDB === 'undefined') return "";
            try {
                return await new Promise((resolve) => {
                    const req = indexedDB.open('/save');
                    req.onsuccess = () => {
                        const db = req.result;
                        if (!db.objectStoreNames.contains('FILE_DATA')) {
                            db.close();
                            resolve("");
                            return;
                        }
                        const tx = db.transaction('FILE_DATA', 'readonly');
                        const store = tx.objectStore('FILE_DATA');
                        const keyReq = store.getAllKeys();

                        keyReq.onsuccess = () => {
                            const keys = keyReq.result || [];
                            const targetKey = keys.find(k => String(k).endsWith('/' + targetFileName) || String(k).endsWith(targetFileName));
                            if (targetKey) {
                                const getReq = store.get(targetKey);
                                getReq.onsuccess = () => {
                                    db.close();
                                    const val = getReq.result;
                                    if (!val) resolve("");
                                    let rawData = (val && typeof val === 'object' && val.contents) ? val.contents : val;
                                    if (typeof rawData === 'string') resolve(rawData);
                                    else if (rawData instanceof Uint8Array || ArrayBuffer.isView(rawData)) {
                                        try {
                                            resolve(new TextDecoder('utf-8').decode(rawData));
                                        } catch (e) { resolve(""); }
                                    } else resolve("");
                                };
                                getReq.onerror = () => { db.close(); resolve(""); };
                            } else {
                                db.close();
                                resolve("");
                            }
                        };
                        keyReq.onerror = () => { db.close(); resolve(""); };
                    };
                    req.onerror = () => resolve("");
                });
            } catch (e) {
                return "";
            }
        }

        /**
         * インスタンスメソッド: VFS (/save, /) 内の実体セーブファイルからプレイヤー名を自動検出
         */
        autoDetectSavePlayerName() {
            // VFS (/save, /) ディレクトリの正式セーブファイルから検索
            const FS = this.FS;
            if (FS) {
                try {
                    const saveDirs = ['/save', '/'];
                    const systemFiles = ['.', '..', 'perm', 'record', 'sysconf', 'logfile', 'xlogfile', 'paniclog', 'bonuses', 'bones', 'help', 'hh', 'cmdhelp', 'optmenu', 'license', 'history', 'opthelp', 'wizhelp', 'tmp', 'Tmp', 'TMP'];

                    for (let dir of saveDirs) {
                        if (FS.analyzePath(dir).exists) {
                            const files = FS.readdir(dir);
                            const saveFile = files.find(f => {
                                const lower = f.toLowerCase();
                                return !systemFiles.includes(f) && 
                                       !f.startsWith('.') && 
                                       !lower.includes('tmp') && 
                                       !lower.includes('lock') && 
                                       !lower.includes('bon');
                            });

                            if (saveFile) {
                                const match = saveFile.match(/^\d+(.+)$/);
                                let name = match ? match[1] : saveFile;
                                name = name.replace(/#.*$/, '').replace(/[\/\x00-\x1f\x7f]/g, '').trim();
                                if (name.length > 0 && name.toLowerCase() !== 'tmp') {
                                    return name;
                                }
                            }
                        }
                    }
                } catch (e) {
                    this.warn("Error auto-detecting save file:", e);
                }
            }
            return "";
        }

        /**
         * 非同期でセーブプレイヤー名を検出 (VFS 優先 ➔ IndexedDB フォールバック)
         */
        async autoDetectSavePlayerNameAsync() {
            const vfsName = this.autoDetectSavePlayerName();
            if (vfsName && vfsName.length > 0) return vfsName;
            return await NetHackFSManager.autoDetectSavePlayerNameFromIndexedDB();
        }

        static async autoDetectSavePlayerNameFromIndexedDB() {
            if (typeof indexedDB === 'undefined') return "";
            try {
                return await new Promise((resolve) => {
                    const req = indexedDB.open('/save');
                    req.onsuccess = () => {
                        const db = req.result;
                        if (!db || !db.objectStoreNames.contains('FILE_DATA')) {
                            if (db) db.close();
                            resolve("");
                            return;
                        }
                        const tx = db.transaction('FILE_DATA', 'readonly');
                        const store = tx.objectStore('FILE_DATA');
                        const keyReq = store.getAllKeys();

                        keyReq.onsuccess = () => {
                            const keys = keyReq.result || [];
                            db.close();
                            const systemFiles = ['perm', 'record', 'sysconf', 'logfile', 'xlogfile', 'paniclog', 'bonuses', 'bones', 'help', 'hh', 'cmdhelp', 'optmenu', 'license', 'history', 'opthelp', 'wizhelp'];
                            const saveKey = keys.find(key => {
                                const keyStr = String(key).trim();
                                if (keyStr.endsWith('/.') || keyStr.endsWith('/..') || keyStr === '/save' || keyStr === '/save/' || keyStr === '/') return false;
                                const cleanName = keyStr.replace(/^\/save\//, '').replace(/^\//, '').replace(/#.*$/, '').trim();
                                if (cleanName.startsWith('.')) return false;
                                const lower = cleanName.toLowerCase();
                                if (systemFiles.some(sys => lower === sys || lower.endsWith('/' + sys))) return false;
                                if (lower.includes('tmp') || lower.includes('lock') || lower.includes('bon')) return false;
                                // 骨ファイルや階層ファイル (.0, .1, bon01.0 等) を除外
                                if (/\.\d+$/.test(lower) || /\.[a-z0-9]+$/i.test(cleanName)) return false;
                                return cleanName.length > 0;
                            });

                            if (saveKey) {
                                const cleanName = String(saveKey).replace(/^\/save\//, '').replace(/^\//, '').replace(/#.*$/, '').trim();
                                const match = cleanName.match(/^\d+(.+)$/);
                                let name = match ? match[1] : cleanName;
                                name = name.replace(/[\/\x00-\x1f\x7f]/g, '').trim();
                                resolve(name || "player");
                                return;
                            }
                            resolve("");
                        };
                        keyReq.onerror = () => { db.close(); resolve(""); };
                    };
                    req.onerror = () => resolve("");
                });
            } catch (e) {
                return "";
            }
        }

        static async deleteAllSaveFilesFromIndexedDB() {
            if (typeof indexedDB === 'undefined') return false;
            try {
                return await new Promise((resolve) => {
                    const req = indexedDB.open('/save');
                    req.onsuccess = () => {
                        const db = req.result;
                        if (!db || !db.objectStoreNames.contains('FILE_DATA')) {
                            if (db) db.close();
                            resolve(false);
                            return;
                        }
                        const tx = db.transaction('FILE_DATA', 'readwrite');
                        const store = tx.objectStore('FILE_DATA');
                        const keyReq = store.getAllKeys();

                        keyReq.onsuccess = () => {
                            const keys = keyReq.result || [];
                            const systemFiles = ['perm', 'record', 'sysconf', 'logfile', 'xlogfile', 'paniclog', 'bonuses', 'bones', 'help', 'hh', 'cmdhelp', 'optmenu', 'license', 'history', 'opthelp', 'wizhelp'];

                            keys.forEach(key => {
                                const keyStr = String(key).trim();
                                if (keyStr.endsWith('/.') || keyStr.endsWith('/..') || keyStr === '/save' || keyStr === '/save/' || keyStr === '/') return;
                                const cleanName = keyStr.replace(/^\/save\//, '').replace(/^\//, '').replace(/#.*$/, '').trim();
                                if (cleanName.startsWith('.')) return;
                                const lower = cleanName.toLowerCase();
                                if (systemFiles.some(sys => lower === sys || lower.endsWith('/' + sys))) return;

                                store.delete(key);
                            });

                            tx.oncomplete = () => {
                                db.close();
                                resolve(true);
                            };
                            tx.onerror = () => { db.close(); resolve(false); };
                        };
                        keyReq.onerror = () => { db.close(); resolve(false); };
                    };
                    req.onerror = () => resolve(false);
                });
            } catch (e) {
                return false;
            }
        }

        /**
         * セーブデータの一覧と詳細情報を取得（ファイル名、プレイヤー名、サイズ、更新日時）
         */
        listSaveFiles() {
            const FS = this.FS;
            if (!FS) return [];

            const results = [];
            try {
                const saveDirs = ['/save', '/'];
                const systemFiles = ['.', '..', 'perm', 'record', 'sysconf', 'logfile', 'xlogfile', 'paniclog', 'bonuses', 'bones', 'help', 'hh', 'cmdhelp', 'optmenu', 'license', 'history', 'opthelp', 'wizhelp'];

                for (let dir of saveDirs) {
                    if (FS.analyzePath(dir).exists) {
                        const files = FS.readdir(dir);
                        for (let f of files) {
                            if (systemFiles.includes(f) || f.startsWith('.')) continue;

                            const filePath = dir === '/' ? `/${f}` : `${dir}/${f}`;
                            try {
                                const stat = FS.stat(filePath);
                                if (stat && FS.isFile(stat.mode)) {
                                    const match = f.match(/^\d+(.+)$/);
                                    let playerName = match ? match[1] : f;
                                    playerName = playerName.replace(/#.*$/, '').replace(/[^a-zA-Z0-9_\-]/g, '').trim();

                                    results.push({
                                        path: filePath,
                                        filename: f,
                                        playerName: playerName || "player",
                                        size: stat.size,
                                        mtime: new Date(stat.mtime).toISOString()
                                    });
                                }
                            } catch(e) {}
                        }
                    }
                }
            } catch (e) {
                this.warn("Error listing save files:", e);
            }
            return results;
        }

        /**
         * /save/xlogfile のパース
         */
        parseLastXlog() {
            const FS = this.FS;
            if (!FS || !FS.analyzePath('/save/xlogfile').exists) return null;

            try {
                const xlogData = FS.readFile('/save/xlogfile', { encoding: 'utf8' });
                if (!xlogData || xlogData.trim() === "") return null;

                const lines = xlogData.trim().split('\n');
                const lastLine = lines[lines.length - 1];
                if (!lastLine) return null;

                const entry = {};
                lastLine.split('\t').forEach(p => {
                    const idx = p.indexOf('=');
                    if (idx !== -1) {
                        entry[p.substring(0, idx)] = p.substring(idx + 1);
                    }
                });

                if (!entry.name) return null;

                return {
                    version: entry.version || "1.0",
                    points: parseInt(entry.points) || 0,
                    deathDnum: parseInt(entry.deathdnum) || 0,
                    deathLev: parseInt(entry.deathlev) || 0,
                    maxLvl: parseInt(entry.maxlvl) || 0,
                    hp: parseInt(entry.hp) || 0,
                    maxHp: parseInt(entry.maxhp) || 0,
                    deaths: parseInt(entry.deaths) || 0,
                    deathDate: entry.deathdate,
                    birthDate: entry.birthdate,
                    uid: entry.uid,
                    role: entry.role || "???",
                    race: entry.race || "???",
                    gender: entry.gender || "???",
                    align: entry.align || "???",
                    name: entry.name,
                    death: entry.death || "unknown"
                };
            } catch (e) {
                this.error("Failed to parse xlogfile:", e);
                return null;
            }
        }

        /**
         * record / logfile スコアリストのパース (Top 10)
         */
        parseRecordList() {
            const FS = this.FS;
            if (!FS) return [];

            const candidatePaths = ['/save/record', '/record', '/save/logfile', '/logfile', '/save/xlogfile', '/xlogfile'];
            let recordData = '';

            for (const path of candidatePaths) {
                try {
                    if (FS.analyzePath(path).exists) {
                        const content = FS.readFile(path, { encoding: 'utf8' });
                        if (content && content.trim()) {
                            recordData += '\n' + content.trim();
                        }
                    }
                } catch(e) {}
            }

            if (!recordData || !recordData.trim()) return [];

            const lines = recordData.trim().split('\n');
            const list = [];

            for (const line of lines) {
                if (!line.trim()) continue;
                const parts = line.trim().split(/\s+/);
                if (parts.length < 3) continue;

                let points = 0;
                let deathLev = 1;
                let role = "Explorer";
                let name = "Hero";
                let death = "Died in dungeon";

                // 数値パーツを探す
                const nums = parts.map(p => parseInt(p, 10)).filter(n => !isNaN(n) && n >= 0);
                if (nums.length > 0) points = nums[0];
                if (nums.length > 1) deathLev = nums[1];

                if (line.includes(',')) {
                    const idx = line.indexOf(',');
                    death = line.substring(idx + 1).trim();
                    const pre = line.substring(0, idx).trim().split(/\s+/);
                    if (pre.length > 0) name = pre[pre.length - 1];
                } else if (parts.length > 4) {
                    death = parts.slice(3).join(' ');
                }

                list.push({ points, deathLev, maxLvl: deathLev, role, name, death, score: points });
            }

            list.sort((a, b) => b.points - a.points);
            return list.slice(0, 10);
        }

        getScoreboard() {
            return this.parseRecordList();
        }

        /**
         * セーブファイルを VFS および IndexedDB から完全に削除
         */
        async deleteSaveFile(targetFilename) {
            const FS = this.FS || (typeof globalThis !== 'undefined' && globalThis.FS ? globalThis.FS : null);
            const cleanName = targetFilename ? targetFilename.replace(/^\/save\//, '').replace(/#.*$/, '').trim() : "";
            this.log(`Executing robust save file deletion. Target: '${targetFilename}', cleanName: '${cleanName}'`);

            let deleted = false;

            // 1. VFS (FS) から /save 配下の非システムファイルを全削除
            if (FS) {
                try {
                    const saveDir = '/save';
                    if (FS.analyzePath(saveDir).exists) {
                        const files = FS.readdir(saveDir);
                        const systemFiles = ['.', '..', 'perm', 'record', 'sysconf', 'logfile', 'xlogfile', 'paniclog', 'bonuses', 'bones'];
                        files.forEach(f => {
                            if (!systemFiles.includes(f) && !f.startsWith('.')) {
                                try {
                                    FS.unlink(`${saveDir}/${f}`);
                                    deleted = true;
                                    this.log(`Unlinked VFS save file: /save/${f}`);
                                } catch(e) {
                                    this.warn(`Failed to unlink VFS file /save/${f}:`, e);
                                }
                            }
                        });
                    }
                } catch(e) {}
            }

            // 2. IndexedDB (/save -> FILE_DATA) の全キーを走査してセーブデータを物理削除
            try {
                if (typeof indexedDB !== 'undefined') {
                    await new Promise((resolve) => {
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
                                        this.log(`Deleted key from IndexedDB: '${keyStr}'`);
                                    }
                                });
                            };

                            tx.oncomplete = () => {
                                db.close();
                                resolve(true);
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
                console.warn("[NetHackFSManager] Error in IndexedDB key deletion:", e);
            }

            // 3. IDBFS FS.syncfs 同期
            if (FS && this.IDBFS) {
                try {
                    FS.syncfs(false, () => {});
                } catch(e) {}
            }

            return deleted;
        }
    }

    global.NetHackFSManager = NetHackFSManager;
    if (typeof window !== 'undefined') {
        window.NetHackFSManager = NetHackFSManager;
    }
    if (typeof globalThis !== 'undefined') {
        globalThis.NetHackFSManager = NetHackFSManager;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = NetHackFSManager;
        module.exports.NetHackFSManager = NetHackFSManager;
        module.exports.default = NetHackFSManager;
    }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));


