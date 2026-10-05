import { NetHackWasmWorkerBridge } from '../../src/driver/index.js';

const APP_VERSION = 'V10-⑤-5';
const APP_BUILD = 100505;
const VERSION_URL = './version.json';

let latestVersionInfo = null;
let preparedUpdateCache = null;

async function getUpdateState() {
  if (!navigator.serviceWorker.controller) {
    throw new Error('Service Worker controller not available');
  }

  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();

    const timer = setTimeout(() => {
      reject(new Error('Service Worker response timeout'));
    }, 5000);

    channel.port1.onmessage = event => {
      clearTimeout(timer);

      const result = event.data;

      if (result && result.ok) {
        resolve(result);
      } else {
        reject(new Error('GET_UPDATE_STATE failed'));
      }
    };

    navigator.serviceWorker.controller.postMessage(
      {
        type: 'GET_UPDATE_STATE'
      },
      [channel.port2]
    );
  });
}

async function rollbackUpdate() {
  if (!navigator.serviceWorker.controller) {
    throw new Error('Service Worker controller not available');
  }

  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();

    const timer = setTimeout(() => {
      reject(new Error('Service Worker response timeout'));
    }, 5000);

    channel.port1.onmessage = event => {
      clearTimeout(timer);

      const result = event.data;

      if (result && result.ok) {
        resolve(result);
      } else {
        reject(
          new Error(
            result && result.error
              ? result.error
              : 'Rollback failed'
          )
        );
      }
    };

    navigator.serviceWorker.controller.postMessage(
      {
        type: 'ROLLBACK_CACHE'
      },
      [channel.port2]
    );
  });
}

async function applyPreparedUpdate(cacheName) {
  if (!cacheName) {
    throw new Error('No prepared update');
  }

  if (!navigator.serviceWorker.controller) {
    throw new Error('Service Worker controller not available');
  }

  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();

    const timer = setTimeout(() => {
      reject(new Error('Service Worker response timeout'));
    }, 5000);

    channel.port1.onmessage = event => {
      clearTimeout(timer);

      const result = event.data;

      if (result && result.ok) {
        resolve(result);
      } else {
        reject(
          new Error(
            result && result.error
              ? result.error
              : 'Cache switch failed'
          )
        );
      }
    };

    navigator.serviceWorker.controller.postMessage(
      {
        type: 'SET_ACTIVE_CACHE',
        cacheName
      },
      [channel.port2]
    );
  });
}

async function checkForUpdate() {
  try {
    const url = VERSION_URL + '?t=' + Date.now();

    const response = await fetch(url, {
      cache: 'no-store'
    });

    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }

    const info = await response.json();

    if (
      typeof info.build !== 'number' ||
      typeof info.version !== 'string'
    ) {
      throw new Error('Invalid version.json');
    }

    latestVersionInfo = info;
    return info;

  } catch (err) {
    console.log('[NetHack Update] check failed:', err);
    return null;
  }
}

async function downloadUpdate(info) {
  if (
    !info ||
    typeof info.cache !== 'string' ||
    !Array.isArray(info.files)
  ) {
    throw new Error('Invalid update information');
  }

  const cacheName = info.cache;

  // Remove only an incomplete cache with the SAME update name.
  // Existing Stable/DEV caches are never touched.
  await caches.delete(cacheName);

  const cache = await caches.open(cacheName);

  try {
    for (let i = 0; i < info.files.length; i++) {
      const file = info.files[i];

      showMessage(
        '[Downloading ' +
        (i + 1) + '/' + info.files.length +
        ': ' + file + ']'
      );

      const separator = file.includes('?') ? '&' : '?';
      const url =
        file + separator +
        'update=' + encodeURIComponent(info.build) +
        '&t=' + Date.now();

      const response = await fetch(url, {
        cache: 'no-store'
      });

      if (!response.ok) {
        throw new Error(
          file + ' HTTP ' + response.status
        );
      }

      // Store under the original URL, not the cache-busting URL.
      await cache.put(file, response.clone());
    }

    return cacheName;

  } catch (err) {
    // Incomplete new version must not remain.
    await caches.delete(cacheName);
    throw err;
  }
}

async function autoCheckForUpdate() {
  if (!navigator.onLine) return;

  const info = await checkForUpdate();

  if (info && info.build > APP_BUILD) {
    console.log(
      '[NetHack Update] new version:',
      info.version
    );
  }
}


// NetHack Safari Display Base V8
// - Portrait: V7 layout
// - Landscape: V13 display philosophy (maximum Dungeon + overlay Messages/Controls)
// - NetHack/WASM/Driver/Worker are intentionally unchanged.

const oldScreen = document.getElementById('screen');
if (oldScreen) oldScreen.remove();

const app = document.createElement('div');
app.id = 'app';

const game = document.createElement('div');
game.id = 'game';

const mapWrap = document.createElement('div');
mapWrap.id = 'dungeon-pane';
const map = document.createElement('pre');
map.id = 'dungeon';
mapWrap.appendChild(map);

const messages = document.createElement('div');
messages.id = 'messages';
messages.setAttribute('aria-label', 'Messages');

const status = document.createElement('aside');
status.id = 'status-pane';
status.textContent = ' ';

game.append(mapWrap, messages, status);

const controls = document.createElement('div');
controls.id = 'controls';

const modeButtons = document.createElement('div');
modeButtons.id = 'mode-buttons';
[
  ['a', 'lower'], ['A', 'upper'], ['!?', 'symbol'],
  ['123', 'digit'], ['Ctrl', 'ctrl']
].forEach(([label, mode]) => {
  const b = document.createElement('button');
  b.className = 'mode-btn';
  b.dataset.mode = mode;
  b.textContent = label;
  modeButtons.appendChild(b);
});

const inputStage = document.createElement('div');
inputStage.id = 'input-stage';

const movePad = document.createElement('div');
movePad.id = 'move-pad';
[
  ['↖','y'],['↑','k'],['↗','u'],
  ['←','h'],['·','.'],['→','l'],
  ['↙','b'],['↓','j'],['↘','n']
].forEach(([label,key]) => {
  const b = document.createElement('button');
  b.className = 'move-btn';
  b.dataset.key = key;
  b.textContent = label;
  movePad.appendChild(b);
});

// V8ではV13の「同じ右側面を手書き面として使う」構造まで移植する。
// 認識エンジン(TF.js/EMNIST等)はまだ接続しない。
const handwriting = document.createElement('div');
handwriting.id = 'handwriting-surface';
const handwritingLabel = document.createElement('div');
handwritingLabel.id = 'handwriting-label';
handwritingLabel.textContent = 'handwriting';
const stroke = document.createElement('canvas');
stroke.id = 'stroke';
handwriting.append(handwritingLabel, stroke);

inputStage.append(movePad, handwriting);

// V7のYES/NO、menu、CONTINUEを失わないための一時アクション面。
const actionPanel = document.createElement('div');
actionPanel.id = 'action-panel';

controls.append(modeButtons, inputStage, actionPanel);
app.append(game, controls);
document.body.appendChild(app);

function showMessage(text) {
  if (text == null) return;
  const v = String(text);
  if (!v.trim()) return;
  if (messages.textContent) messages.textContent += '\n';
  messages.textContent += v;
  messages.scrollTop = messages.scrollHeight;
}

function clearActions() {
  actionPanel.innerHTML = '';
  actionPanel.classList.remove('visible');
}

function addAction(label, fn) {
  const b = document.createElement('button');
  b.className = 'action-btn';
  b.textContent = label;
  b.addEventListener('click', () => {
    clearActions();
    fn();
  });
  actionPanel.appendChild(b);
  actionPanel.classList.add('visible');
}

function addPersistentAction(label, fn) {
  const b = document.createElement('button');
  b.className = 'action-btn';
  b.textContent = label;

  b.addEventListener('click', async () => {
    b.disabled = true;

    try {
      await fn();
    } finally {
      b.disabled = false;
    }
  });

  actionPanel.appendChild(b);
  actionPanel.classList.add('visible');

  return b;
}

const MAP_W = 80, MAP_H = 24;
const dungeon = Array.from({length: MAP_H}, () => Array(MAP_W).fill(' '));

// V18 build 2: keep NetHack's native text color alongside each ASCII cell.
// 7 is NetHack's normal white/gray text color.
const dungeonColor = Array.from(
  {length: MAP_H},
  () => Array(MAP_W).fill(7)
);

// V11-03: keep NetHack glyph separately from ASCII representation.
// NetHack remains the authority for object/monster/player identity.
const dungeonGlyph = Array.from(
  {length: MAP_H},
  () => Array(MAP_W).fill(null)
);

// NetHack-wasm-webUI original NetHack 5.0 tile sheet.
const TILE_SIZE = 32;
const TILES_PER_ROW = 40;
const tileImage = new Image();
tileImage.src = '../../pict/nethack_default_32.png';

let dungeonWindowId = null;
const charWidthCache = new Map();

// V11-03: one-tile overlay test.
// Keep the existing ASCII dungeon untouched.
const tileCanvas = document.createElement('canvas');
tileCanvas.id = 'tile-overlay';

Object.assign(tileCanvas.style, {
  position: 'absolute',
  inset: '0',
  width: '100%',
  height: '100%',
  pointerEvents: 'none',
  zIndex: '2'
});

mapWrap.appendChild(tileCanvas);

let tileMap = null;

if (typeof window.tileMapping === 'function') {
  tileMap = window.tileMapping();
} else {
  console.error('[V11-03] window.tileMapping is unavailable');
}

function resizeTileCanvas() {
  const rect = mapWrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));

  if (
    tileCanvas.width !== Math.round(w * dpr) ||
    tileCanvas.height !== Math.round(h * dpr)
  ) {
    tileCanvas.width = Math.round(w * dpr);
    tileCanvas.height = Math.round(h * dpr);
  }

  const ctx = tileCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;

  return {ctx, w, h};
}

function isLandscape() {
  return window.innerWidth > window.innerHeight;
}

// V15 build 1: Dungeon display preference.
// The active mode is read once at startup so changing the preference on the
// exit screen never changes the Dungeon while the current game is running.
const DUNGEON_DISPLAY_KEY = 'nethack-dungeon-display';
const DUNGEON_DISPLAY_ASCII = 'ascii';
const DUNGEON_DISPLAY_TILE = 'tile';

// V18 symset persistence: NetHack does not store the selected symbol set in
// the game save. Keep this UI preference separately and feed it back through
// NetHack's normal OPTIONS=symset:<name> startup path.
const SYMBOL_SET_KEY = 'nethack-symbol-set';
const SYMBOL_SET_DEFAULT = 'default';

function loadSymbolSetPreference() {
  try {
    return localStorage.getItem(SYMBOL_SET_KEY);
  } catch (err) {
    console.log('[Symbol Set] preference read failed:', err);
    return null;
  }
}

function saveSymbolSetPreference(name) {
  try {
    localStorage.setItem(SYMBOL_SET_KEY, name);
    return true;
  } catch (err) {
    console.log('[Symbol Set] preference write failed:', err);
    return false;
  }
}

let activeSymbolSetPreference = loadSymbolSetPreference() || SYMBOL_SET_DEFAULT;

// NetHack 5.0 legacy terminal graphics conversion.  These Unicode mappings
// follow win/X11/winX.c (X11_glyph_char): IBM handling is CP437, while DEC
// handling maps the DEC alternate character set to Unicode.
const CP437_HIGH_UNICODE = [
  0x00c7,0x00fc,0x00e9,0x00e2,0x00e4,0x00e0,0x00e5,0x00e7,
  0x00ea,0x00eb,0x00e8,0x00ef,0x00ee,0x00ec,0x00c4,0x00c5,
  0x00c9,0x00e6,0x00c6,0x00f4,0x00f6,0x00f2,0x00fb,0x00f9,
  0x00ff,0x00d6,0x00dc,0x00a2,0x00a3,0x00a5,0x20a7,0x0192,
  0x00e1,0x00ed,0x00f3,0x00fa,0x00f1,0x00d1,0x00aa,0x00ba,
  0x00bf,0x2310,0x00ac,0x00bd,0x00bc,0x00a1,0x00ab,0x00bb,
  0x2591,0x2592,0x2593,0x2502,0x2524,0x2561,0x2562,0x2556,
  0x2555,0x2563,0x2551,0x2557,0x255d,0x255c,0x255b,0x2510,
  0x2514,0x2534,0x252c,0x251c,0x2500,0x253c,0x255e,0x255f,
  0x255a,0x2554,0x2569,0x2566,0x2560,0x2550,0x256c,0x2567,
  0x2568,0x2564,0x2565,0x2559,0x2558,0x2552,0x2553,0x256b,
  0x256a,0x2518,0x250c,0x2588,0x2584,0x258c,0x2590,0x2580,
  0x03b1,0x00df,0x0393,0x03c0,0x03a3,0x03c3,0x00b5,0x03c4,
  0x03a6,0x0398,0x03a9,0x03b4,0x221e,0x03c6,0x03b5,0x2229,
  0x2261,0x00b1,0x2265,0x2264,0x2320,0x2321,0x00f7,0x2248,
  0x00b0,0x2219,0x00b7,0x221a,0x207f,0x00b2,0x25a0,0x00a0
];

const DEC_GRAPHICS_UNICODE = [
  0x2666,0x2592,0x0062,0x0063,0x0064,0x0065,0x00b0,0x00b1,
  0x2591,0x00a4,0x2518,0x2510,0x250c,0x2514,0x253c,0x23ba,
  0x23bb,0x2500,0x23bc,0x23bd,0x251c,0x2524,0x2534,0x252c,
  0x2502,0x2264,0x2265,0x03c0,0x2260,0x00a3,0x00b7,0x007f
];

function nativeDungeonChar(glyphInfo) {
  const symset = String(activeSymbolSetPreference || '').toLowerCase();
  const code = Number.isInteger(glyphInfo.symbol) ? (glyphInfo.symbol & 0xff) : -1;

  if (['ibmgraphics', 'ibmgraphics_1', 'ibmgraphics_2'].includes(symset)
      && code >= 0x80) {
    return String.fromCodePoint(CP437_HIGH_UNICODE[code - 0x80]);
  }

  if (['curses', 'decgraphics'].includes(symset) && code >= 0x80) {
    const decCode = code & 0x7f;
    if (decCode >= 0x60 && decCode <= 0x7f) {
      return String.fromCodePoint(DEC_GRAPHICS_UNICODE[decCode - 0x60]);
    }
  }

  return glyphInfo.ch || ' ';
}

function rememberSymbolSetMenuChoice(data, item) {
  const prompt = data && data.prompt ? String(data.prompt).trim() : '';
  if (prompt !== 'Select symbol set:' || !item || !item.str) return;

  const label = String(item.str).trim();
  const name = /^Default Symbols(?:\s|$)/i.test(label)
    ? SYMBOL_SET_DEFAULT
    : label.split(/\s+/)[0];

  if (name) {
    activeSymbolSetPreference = name;
    saveSymbolSetPreference(name);
  }
}

function loadDungeonDisplayPreference() {
  try {
    return localStorage.getItem(DUNGEON_DISPLAY_KEY) === DUNGEON_DISPLAY_TILE
      ? DUNGEON_DISPLAY_TILE
      : DUNGEON_DISPLAY_ASCII;
  } catch (err) {
    console.log('[Dungeon Display] preference read failed:', err);
    return DUNGEON_DISPLAY_ASCII;
  }
}

function saveDungeonDisplayPreference(mode) {
  try {
    localStorage.setItem(DUNGEON_DISPLAY_KEY, mode);
    return true;
  } catch (err) {
    console.log('[Dungeon Display] preference write failed:', err);
    return false;
  }
}

const activeDungeonDisplay = loadDungeonDisplayPreference();

// V16 build 1: TILE Dungeon pinch zoom.
// Keep this as display-only runtime state. It is intentionally not persisted
// yet, and ASCII display remains unchanged in this first build.
const DUNGEON_TILE_ZOOM_MIN = 0.5;
const DUNGEON_TILE_ZOOM_MAX = 2.0;

function clampDungeonTileZoom(value) {
  return Math.max(
    DUNGEON_TILE_ZOOM_MIN,
    Math.min(DUNGEON_TILE_ZOOM_MAX, value)
  );
}

let dungeonTileZoom = 1.0;

// V16 ASCII build 1: display-only ASCII zoom.
// Keep the same runtime-only behavior as TILE zoom.
const DUNGEON_ASCII_ZOOM_MIN = 0.5;
const DUNGEON_ASCII_ZOOM_MAX = 2.0;

function clampDungeonAsciiZoom(value) {
  return Math.max(
    DUNGEON_ASCII_ZOOM_MIN,
    Math.min(DUNGEON_ASCII_ZOOM_MAX, value)
  );
}

let dungeonAsciiZoom = 1.0;
let dungeonAsciiPanX = 0;
let dungeonAsciiPanY = 0;

// V16 build 2: display-only TILE camera pan, measured in NetHack cells.
// Positive X/Y moves the viewport right/down. Game coordinates are untouched.
let dungeonTilePanX = 0;
let dungeonTilePanY = 0;

// V16: transparent TILE Dungeon gesture surface.
// iOS Safari pinch scale is handled with WebKit GestureEvent at document
// capture; one-finger pan uses Touch Events on this surface.
const dungeonGestureSurface = document.createElement('div');
dungeonGestureSurface.id = 'dungeon-gesture-surface';
Object.assign(dungeonGestureSurface.style, {
  position: 'absolute',
  inset: '0',
  background: 'transparent',
  touchAction: 'none',
  WebkitUserSelect: 'none',
  userSelect: 'none',
  pointerEvents: 'auto',
  zIndex: '3'
});
mapWrap.appendChild(dungeonGestureSurface);

let dungeonGestureStartZoom = 1.0;

// Two-finger pinch: update display-only zoom for the active Dungeon mode.
document.addEventListener('gesturestart', ev => {
  if (ev.target !== dungeonGestureSurface) return;

  ev.preventDefault();
  dungeonGestureStartZoom =
    activeDungeonDisplay === DUNGEON_DISPLAY_TILE
      ? dungeonTileZoom
      : dungeonAsciiZoom;
}, {capture: true, passive: false});

document.addEventListener('gesturechange', ev => {
  if (ev.target !== dungeonGestureSurface) return;

  ev.preventDefault();

  const scale = Number(ev.scale);
  if (!Number.isFinite(scale) || scale <= 0) return;

  if (activeDungeonDisplay === DUNGEON_DISPLAY_TILE) {
    dungeonTileZoom = clampDungeonTileZoom(
      dungeonGestureStartZoom * scale
    );
  } else {
    dungeonAsciiZoom = clampDungeonAsciiZoom(
      dungeonGestureStartZoom * scale
    );
  }

  renderMap();
}, {capture: true, passive: false});

document.addEventListener('gestureend', ev => {
  if (ev.target !== dungeonGestureSurface) return;

  ev.preventDefault();
  dungeonGestureStartZoom =
    activeDungeonDisplay === DUNGEON_DISPLAY_TILE
      ? dungeonTileZoom
      : dungeonAsciiZoom;
}, {capture: true, passive: false});

document.addEventListener('touchmove', ev => {
  if (
    ev.target === dungeonGestureSurface &&
    ev.touches.length === 2
  ) {
    ev.preventDefault();
  }
}, {capture: true, passive: false});

// One-finger drag: update display-only TILE camera offset.
// Convert pixel drag to whole TILE cells.
let dungeonPanTouchId = null;
let dungeonPanStartX = 0;
let dungeonPanStartY = 0;
let dungeonPanStartCellX = 0;
let dungeonPanStartCellY = 0;

dungeonGestureSurface.addEventListener('touchstart', ev => {
  if (ev.touches.length !== 1) return;

  const t = ev.touches[0];
  dungeonPanTouchId = t.identifier;
  dungeonPanStartX = t.clientX;
  dungeonPanStartY = t.clientY;
  dungeonPanStartCellX =
    activeDungeonDisplay === DUNGEON_DISPLAY_TILE
      ? dungeonTilePanX
      : dungeonAsciiPanX;
  dungeonPanStartCellY =
    activeDungeonDisplay === DUNGEON_DISPLAY_TILE
      ? dungeonTilePanY
      : dungeonAsciiPanY;
  ev.preventDefault();
}, {passive: false});

dungeonGestureSurface.addEventListener('touchmove', ev => {
  if (
    dungeonPanTouchId === null ||
    ev.touches.length !== 1
  ) return;

  const t = Array.from(ev.touches).find(
    touch => touch.identifier === dungeonPanTouchId
  );
  if (!t) return;

  ev.preventDefault();

  // Dragging the picture right/down reveals cells to the left/up,
  // like moving a paper map under the viewport.
  if (activeDungeonDisplay === DUNGEON_DISPLAY_TILE) {
    const paneW = mapWrap.clientWidth;
    const paneH = mapWrap.clientHeight;
    const landscape = isLandscape();
    const baseTileCell = landscape
      ? Math.max(8, Math.min(
          32,
          Math.floor(paneW / 20),
          Math.floor(paneH / 10)
        ))
      : Math.max(8, Math.min(
          32,
          Math.floor(paneH / 10)
        ));
    const tileCell = Math.max(
      4,
      Math.round(baseTileCell * dungeonTileZoom)
    );

    dungeonTilePanX =
      dungeonPanStartCellX -
      Math.round((t.clientX - dungeonPanStartX) / tileCell);
    dungeonTilePanY =
      dungeonPanStartCellY -
      Math.round((t.clientY - dungeonPanStartY) / tileCell);
  } else {
    const landscape = isLandscape();
    const baseFontSize = landscape
      ? chooseLandscapeFontSize()
      : choosePortraitTextFontSize();
    const fontSize = Math.max(
      6,
      Math.round(baseFontSize * dungeonAsciiZoom)
    );
    const charW = measureCharWidth(fontSize);
    const charH = fontSize;

    dungeonAsciiPanX =
      dungeonPanStartCellX -
      Math.round((t.clientX - dungeonPanStartX) / charW);
    dungeonAsciiPanY =
      dungeonPanStartCellY -
      Math.round((t.clientY - dungeonPanStartY) / charH);
  }

  renderMap();
}, {passive: false});

function finishDungeonPan(ev) {
  if (dungeonPanTouchId === null) return;
  const stillActive = Array.from(ev.touches || []).some(
    touch => touch.identifier === dungeonPanTouchId
  );
  if (!stillActive) dungeonPanTouchId = null;
}

dungeonGestureSurface.addEventListener(
  'touchend',
  finishDungeonPan,
  {passive: true}
);
dungeonGestureSurface.addEventListener(
  'touchcancel',
  finishDungeonPan,
  {passive: true}
);

function measureCharWidth(fontSize) {
  if (charWidthCache.has(fontSize)) return charWidthCache.get(fontSize);
  const probe = document.createElement('span');
  probe.textContent = 'MMMMMMMMMM';
  Object.assign(probe.style, {
    position: 'absolute', visibility: 'hidden', whiteSpace: 'pre',
    fontFamily: 'Menlo, ui-monospace, monospace', fontSize: `${fontSize}px`,
    lineHeight: '1'
  });
  document.body.appendChild(probe);
  const w = (probe.getBoundingClientRect().width / 10) || fontSize * 0.6;
  probe.remove();
  charWidthCache.set(fontSize, w);
  return w;
}

function chooseLandscapeFontSize() {
  // 確定仕様: 横画面のみ12〜14px。24行が収まる最大サイズ。
  const h = mapWrap.clientHeight;
  for (const size of [14, 13, 12]) {
    if (size * MAP_H <= h) return size;
  }
  return 12;
}

function choosePortraitTextFontSize() {
  // V14 build 2: make the portrait ASCII dungeon easier to read.
  // Keep a useful viewport around the player instead of shrinking all 80x24
  // cells onto the screen.  The existing viewport logic remains authoritative.
  const w = mapWrap.clientWidth;
  const h = mapWrap.clientHeight;
  const minCols = 20;
  const minRows = 10;

  // Match the existing V13 portrait breakpoint: iPad-class layouts
  // (700px and wider) may use up to 20px; iPhone-class layouts use up to 16px.
  const sizes = window.innerWidth >= 700
    ? [20, 19, 18, 17, 16, 15, 14, 13, 12]
    : [16, 15, 14, 13, 12];

  for (const size of sizes) {
    const charW = measureCharWidth(size);
    if (charW * minCols <= w && size * minRows <= h) return size;
  }
  return 12;
}

function renderMap() {
  let px = -1, py = -1;
  for (let y = 0; y < MAP_H; y++) {
    const x = dungeon[y].indexOf('@');
    if (x >= 0) { px = x; py = y; break; }
  }

  const landscape = isLandscape();

  // V15 build 1: display mode is a startup preference, independent of
  // orientation. The preference can only be changed from the exit screen and
  // takes effect after RESTART NETHACK.
  const tileDisplay = activeDungeonDisplay === DUNGEON_DISPLAY_TILE;
  map.style.visibility = tileDisplay ? 'hidden' : 'visible';
  tileCanvas.style.display = tileDisplay ? 'block' : 'none';

  const baseFontSize = landscape
    ? chooseLandscapeFontSize()
    : choosePortraitTextFontSize();
  const fontSize = Math.max(
    6,
    Math.round(baseFontSize * dungeonAsciiZoom)
  );
  map.style.fontSize = `${fontSize}px`;
  map.style.lineHeight = '1';

  const charW = measureCharWidth(fontSize);
  const charH = fontSize;

  const VIEW_W = Math.max(20, Math.min(MAP_W,
    Math.floor(mapWrap.clientWidth / charW)));
  const VIEW_H = Math.max(10, Math.min(MAP_H,
    Math.floor(mapWrap.clientHeight / charH)));

  let left = 0, top = 0;
  if (px >= 0) {
    left = px - Math.floor(VIEW_W / 2);
    top = py - Math.floor(VIEW_H / 2);
  }
  // V16 ASCII build 2: apply display-only ASCII camera pan after
  // the existing @-follow calculation, then clamp to map bounds.
  left += dungeonAsciiPanX;
  top += dungeonAsciiPanY;
  left = Math.max(0, Math.min(left, MAP_W - VIEW_W));
  top = Math.max(0, Math.min(top, MAP_H - VIEW_H));

  // V18 build 2 fix: Safari may render NetHack Unicode glyphs through
  // fallback fonts whose advance widths differ from Menlo.  Keep the NetHack
  // terminal model authoritative by giving every visible glyph exactly one
  // fixed-width dungeon cell.
  const nethackColors = [
    '#000000', '#ff0000', '#00ff00', '#ffff00',
    '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
    '#888888', '#ff8800', '#00ff88', '#ffff88',
    '#8888ff', '#ff88ff', '#88ffff', '#ffffff'
  ];
  const frag = document.createDocumentFragment();
  for (let y = top; y < Math.min(top + VIEW_H, MAP_H); y++) {
    for (let x = left; x < Math.min(left + VIEW_W, MAP_W); x++) {
      const cell = document.createElement('span');
      cell.style.display = 'inline-block';
      cell.style.width = `${charW}px`;
      cell.style.height = `${charH}px`;
      cell.style.overflow = 'visible';
      cell.style.verticalAlign = 'top';
      cell.style.color = nethackColors[dungeonColor[y][x]] || '#ffffff';
      cell.textContent = dungeon[y][x];
      frag.appendChild(cell);
    }
    if (y < Math.min(top + VIEW_H, MAP_H) - 1) {
      frag.appendChild(document.createTextNode('\n'));
    }
  }
  map.replaceChildren(frag);

  // V11-03:
  // Draw only the player cell as a tile.
  // Player position follows the existing stable ASCII viewport logic,
  // but tile identity comes exclusively from NetHack's native glyph.
  const {ctx, w, h} = resizeTileCanvas();
  ctx.clearRect(0, 0, w, h);

  // V11-05:
  // Render the visible dungeon with square tile cells.
  // NetHack coordinates and glyph identity remain unchanged.
  if (
    tileMap &&
    tileImage.complete &&
    tileImage.naturalWidth > 0
  ) {
    const paneW = mapWrap.clientWidth;
    const paneH = mapWrap.clientHeight;

    // V16 build 1 fix 2:
    // First calculate the V15 Stable base cell size exactly as before, then
    // apply the user zoom. Applying zoom before the old Math.min constraints
    // could clamp the value back to the base size and make pinch appear inert.
    const baseTileCell = landscape
      ? Math.max(
          8,
          Math.min(
            32,
            Math.floor(paneW / 20),
            Math.floor(paneH / 10)
          )
        )
      : Math.max(
          8,
          Math.min(
            32,
            Math.floor(paneH / 10)
          )
        );

    const tileCell = Math.max(
      4,
      Math.round(baseTileCell * dungeonTileZoom)
    );


    const TILE_VIEW_W = Math.max(
      1,
      Math.min(MAP_W, Math.floor(paneW / tileCell))
    );

    const TILE_VIEW_H = Math.max(
      1,
      Math.min(MAP_H, Math.floor(paneH / tileCell))
    );

    let tileLeft = 0;
    let tileTop = 0;

    if (px >= 0) {
      // Horizontal behavior remains unchanged.
      tileLeft = px - Math.floor(TILE_VIEW_W / 2);

      // V13-03 portrait vertical camera:
      // If all 24 NetHack rows fit in the Dungeon pane,
      // keep the vertical viewport fixed.
      // Follow the player vertically only when all rows cannot fit.
      if (!landscape && TILE_VIEW_H >= 20) {
        tileTop = 0;
      } else {
        tileTop = py - Math.floor(TILE_VIEW_H / 2);
      }
    }

    // V16 build 2: apply the user's display-only camera offset after
    // the existing @-follow logic, then clamp to the NetHack map bounds.
    tileLeft += dungeonTilePanX;
    tileTop += dungeonTilePanY;

    tileLeft = Math.max(
      0,
      Math.min(tileLeft, MAP_W - TILE_VIEW_W)
    );

    tileTop = Math.max(
      0,
      Math.min(tileTop, MAP_H - TILE_VIEW_H)
    );

    const drawW = TILE_VIEW_W * tileCell;
    const drawH = TILE_VIEW_H * tileCell;

    // V11-07:
    // Dungeon uses the whole dungeon-pane from edge to edge.
    // Transparent control UI intentionally overlays the dungeon.
    const originX = 0;
    const originY = 0;

    const endY = Math.min(tileTop + TILE_VIEW_H, MAP_H);
    const endX = Math.min(tileLeft + TILE_VIEW_W, MAP_W);

    for (let gy = tileTop; gy < endY; gy++) {
      for (let gx = tileLeft; gx < endX; gx++) {
        const glyph = dungeonGlyph[gy][gx];

        if (glyph === null || glyph === undefined) continue;

        const tileIndex = tileMap[glyph];
        if (tileIndex === undefined) continue;

        const srcX =
          (tileIndex % TILES_PER_ROW) * TILE_SIZE;
        const srcY =
          Math.floor(tileIndex / TILES_PER_ROW) * TILE_SIZE;

        const dstX =
          originX + (gx - tileLeft) * tileCell;
        const dstY =
          originY + (gy - tileTop) * tileCell;

        ctx.drawImage(
          tileImage,
          srcX, srcY, TILE_SIZE, TILE_SIZE,
          dstX, dstY, tileCell, tileCell
        );
      }
    }
  }
}

let activeResolver = null;

// V16: any NetHack input ends manual Dungeon panning.
// Preserve TILE/ASCII zoom and restore the normal @-following viewport before
// the command is delivered to NetHack.
function restoreDungeonToPlayerBeforeInput() {
  const hasPan =
    dungeonTilePanX !== 0 ||
    dungeonTilePanY !== 0 ||
    dungeonAsciiPanX !== 0 ||
    dungeonAsciiPanY !== 0;

  if (!hasPan) return;

  dungeonTilePanX = 0;
  dungeonTilePanY = 0;
  dungeonAsciiPanX = 0;
  dungeonAsciiPanY = 0;
  renderMap();
}

// V12 build 2-6c - getlin handwriting string buffer.
let v12GetlinActive = false;
let v12GetlinBuffer = '';
let v12GetlinPrompt = '';
let v12GetlinMessageBase = '';

function setResolver(resolver) {
  activeResolver = resolver || null;
}

function v12RenderGetlin(finalValue = false) {
  const inputText =
    v12GetlinBuffer +
    (finalValue ? '' : '_');

  const current =
    v12GetlinPrompt +
    '\n' +
    inputText;

  messages.textContent =
    v12GetlinMessageBase +
    (v12GetlinMessageBase ? '\n' : '') +
    current;

  messages.scrollTop = messages.scrollHeight;
}

function v12SendHandwritingCharacter(ch) {
  if (!activeResolver) return;

  restoreDungeonToPlayerBeforeInput();

  if (!v12GetlinActive) {
    activeResolver.respond(ch);
    return;
  }

  // V12 build 2-6d - Return / Ctrl+M completes getlin.
  // Show the final value without the input cursor before returning it.
  if (ch === '\r' || ch === '\n') {
    const resolver = activeResolver;
    const value = v12GetlinBuffer;
    const prompt = v12GetlinPrompt;

    v12RenderGetlin(true);

    v12GetlinActive = false;
    v12GetlinBuffer = '';
    v12GetlinPrompt = '';

    resolver.respond(value);
    return;
  }

  // V12 build 2-7e - ESC cancels getlin and shows [cancelled].
  if (ch === '\x1b') {
    const resolver = activeResolver;

    v12GetlinBuffer = '[cancelled]';
    v12RenderGetlin(true);

    v12GetlinActive = false;
    v12GetlinBuffer = '';
    v12GetlinPrompt = '';

    resolver.respond(27);
    return;
  }

  v12GetlinBuffer += ch;
  v12RenderGetlin();
}


// =========================================================
// V8.3 - V13-style multi-touch handwriting test
// Left mode button held by one finger.
// Another finger draws over the right direction pad.
// Recognition is NOT implemented yet.
// =========================================================

let handwritingMode = null;
let handwritingPointer = null;
let handwritingPoints = [];

const handwritingCanvas = document.createElement('canvas');
handwritingCanvas.id = 'handwriting-canvas';

Object.assign(handwritingCanvas.style, {
  position: 'absolute',
  inset: '0',
  width: '100%',
  height: '100%',
  background: 'transparent',
  display: 'none',
  touchAction: 'none',
  pointerEvents: 'none',
  zIndex: '20'
});

movePad.appendChild(handwritingCanvas);

// V8.4.3: V13-style handwriting surface.
// While a mode button is held, the 3x3 direction buttons disappear and
// the entire movePad becomes one handwriting frame.
const v843Style = document.createElement('style');
v843Style.textContent = `
  #move-pad.handwriting-active {
    border: 3px solid rgba(255,255,255,.22);
    border-radius: 14px;
    box-sizing: border-box;
  }

  #move-pad.handwriting-active .move-btn {
    visibility: hidden;
  }

  #move-pad.handwriting-active #handwriting-canvas {
    display: block !important;
  }
`;
document.head.appendChild(v843Style);

// ============================================================
// V9.0 Stable - hide handwriting diagnostics
// Recognition/input logic is intentionally unchanged.
// Errors remain available in console / NetHack Messages.
// ============================================================
const v90StableStyle = document.createElement('style');
v90StableStyle.textContent = `
  #handwriting-label {
    display: none !important;
  }
`;
document.head.appendChild(v90StableStyle);

function resizeHandwritingCanvas() {
  const r = movePad.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  handwritingCanvas.width = Math.max(1, Math.round(r.width * dpr));
  handwritingCanvas.height = Math.max(1, Math.round(r.height * dpr));

  const ctx = handwritingCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,.78)';
}

function clearHandwriting() {
  const ctx = handwritingCanvas.getContext('2d');
  const r = handwritingCanvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);

  handwritingPoints = [];
  handwritingPointer = null;
}

function beginHandwritingMode(mode) {
  handwritingMode = mode;

  v84StrokeList = [];
  v84CurrentStroke = [];

  if (v84RecognizeTimer) {
    clearTimeout(v84RecognizeTimer);
    v84RecognizeTimer = null;
  }

  resizeHandwritingCanvas();
  clearHandwriting();

  handwritingCanvas.style.display = 'block';
  handwritingCanvas.style.pointerEvents = 'auto';

  movePad.classList.add('handwriting-active');
}

function endHandwritingMode() {
  handwritingMode = null;
  handwritingPointer = null;

  clearHandwriting();

  handwritingCanvas.style.pointerEvents = 'none';
  handwritingCanvas.style.display = 'none';

  movePad.classList.remove('handwriting-active');
}

function handwritingXY(ev) {
  const r = handwritingCanvas.getBoundingClientRect();

  return {
    x: ev.clientX - r.left,
    y: ev.clientY - r.top
  };
}

handwritingCanvas.addEventListener('pointerdown', ev => {
  if (!handwritingMode) return;

  // The first pointer on the canvas becomes the drawing finger.
  if (handwritingPointer !== null) return;

  ev.preventDefault();

  handwritingPointer = ev.pointerId;

  try {
    handwritingCanvas.setPointerCapture(ev.pointerId);
  } catch (_) {}

  const pt = handwritingXY(ev);
  handwritingPoints = [pt];

  v84CurrentStroke = [{x:pt.x, y:pt.y}];

  if (v84RecognizeTimer) {
    clearTimeout(v84RecognizeTimer);
    v84RecognizeTimer = null;
  }

  const ctx = handwritingCanvas.getContext('2d');
  ctx.beginPath();
  ctx.moveTo(pt.x, pt.y);
});

handwritingCanvas.addEventListener('pointermove', ev => {
  if (!handwritingMode) return;
  if (ev.pointerId !== handwritingPointer) return;

  ev.preventDefault();

  const pt = handwritingXY(ev);
  handwritingPoints.push(pt);
  v84CurrentStroke.push({x:pt.x, y:pt.y});

  const ctx = handwritingCanvas.getContext('2d');
  ctx.lineTo(pt.x, pt.y);
  ctx.stroke();
});

function finishHandwritingPointer(ev) {
  if (ev.pointerId !== handwritingPointer) return;

  ev.preventDefault();

  try {
    handwritingCanvas.releasePointerCapture(ev.pointerId);
  } catch (_) {}

  handwritingPointer = null;

  if (v84CurrentStroke.length === 1) {
    const p = v84CurrentStroke[0];
    v84CurrentStroke.push({x:p.x + 0.1, y:p.y + 0.1});
  }

  if (v84CurrentStroke.length) {
    v84StrokeList.push(v84CurrentStroke.slice());
  }

  v84CurrentStroke = [];

  if (v84RecognizeTimer) clearTimeout(v84RecognizeTimer);

  v84RecognizeTimer = setTimeout(() => {
    v84RecognizeTimer = null;
    v84RecognizeAndSend();
  }, V84_MULTI_STROKE_WAIT_MS);
}

handwritingCanvas.addEventListener('pointerup', finishHandwritingPointer);
handwritingCanvas.addEventListener('pointercancel', finishHandwritingPointer);



// ============================================================
// V8.4 - lowercase a-z recognition
// Ported from Python/Safari V13.
//
// TensorFlow.js + pretrained EMNIST alphanumeric model
// Source model: akbartus/Handwriting-Recognition-in-VR (MIT)
// 62 classes: 0-9, A-Z, a-z
// ============================================================

const AI_MODEL_URL =
  './ai/model/model.json';

const LOWERCASE_ONLY = 'abcdefghijklmnopqrstuvwxyz';
const UPPERCASE_OFFSET = 10;
const LOWERCASE_OFFSET = 36;
const CASE_FOLD_WEIGHT = 0.25;
const SEND_THRESHOLD = 0.58;

let aiModel = null;
let aiReady = false;

// V8.4 uses multiple pen strokes, just like V13.
let v84StrokeList = [];
let v84CurrentStroke = [];
let v84RecognizeTimer = null;

const V84_MULTI_STROKE_WAIT_MS = 400;

async function loadV84AIModel() {
  try {
    handwritingLabel.textContent = 'AI loading...';

    await tf.ready();
    aiModel = await tf.loadLayersModel(AI_MODEL_URL);

    tf.tidy(() => {
      const z = tf.zeros([1, 28, 28, 1]);
      const y = aiModel.predict(z);
      if (Array.isArray(y)) y.forEach(t => t.dispose());
    });

    aiReady = true;
    handwritingLabel.textContent = 'AI ready';
    console.log('V8.4 handwriting AI ready');
  } catch (err) {
    console.error('AI model load failed:', err);
    handwritingLabel.textContent = 'AI load failed';
    showMessage('[Handwriting AI load FAILED: ' + err.message + ']');
  }
}

function v84Bounds(strokes) {
  if (!strokes || strokes.length === 0) return null;

  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  let count = 0;

  for (const stroke of strokes) {
    for (const pt of stroke) {
      minX = Math.min(minX, pt.x);
      minY = Math.min(minY, pt.y);
      maxX = Math.max(maxX, pt.x);
      maxY = Math.max(maxY, pt.y);
      count++;
    }
  }

  if (count < 2) return null;

  return {
    minX, minY, maxX, maxY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY)
  };
}

function v84CenterByInkMass(source) {
  const w = source.width;
  const h = source.height;

  const sctx = source.getContext('2d', {willReadFrequently:true});
  const img = sctx.getImageData(0, 0, w, h).data;

  let mass = 0;
  let sumX = 0;
  let sumY = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const ink = 255 - img[i];

      if (ink <= 0) continue;

      mass += ink;
      sumX += x * ink;
      sumY += y * ink;
    }
  }

  if (mass <= 0) return source;

  const cx = sumX / mass;
  const cy = sumY / mass;

  const dx = (w - 1) / 2 - cx;
  const dy = (h - 1) / 2 - cy;

  const centered = document.createElement('canvas');
  centered.width = w;
  centered.height = h;

  const cctx = centered.getContext('2d');
  cctx.fillStyle = '#fff';
  cctx.fillRect(0, 0, w, h);
  cctx.drawImage(source, dx, dy);

  return centered;
}

function v84RenderNormalized(strokes, size=64) {
  const b = v84Bounds(strokes);
  if (!b) return null;

  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;

  const octx = out.getContext('2d', {willReadFrequently:true});

  octx.fillStyle = '#fff';
  octx.fillRect(0, 0, size, size);

  octx.strokeStyle = '#000';
  octx.fillStyle = '#000';
  octx.lineCap = 'round';
  octx.lineJoin = 'round';

  // V13: character occupies about 70% of normalization area.
  const target = size * 0.70;
  const scale = Math.min(target / b.w, target / b.h);

  const drawW = b.w * scale;
  const drawH = b.h * scale;

  const ox = (size - drawW) / 2 - b.minX * scale;
  const oy = (size - drawH) / 2 - b.minY * scale;

  octx.lineWidth =
    Math.max(4.0, Math.min(7.0, 5.5 * scale / Math.max(scale, 1)));

  for (const stroke of strokes) {
    if (!stroke.length) continue;

    if (
      stroke.length <= 2 &&
      Math.hypot(
        stroke[stroke.length-1].x - stroke[0].x,
        stroke[stroke.length-1].y - stroke[0].y
      ) < 1
    ) {
      const pt = stroke[0];

      octx.beginPath();
      octx.arc(
        pt.x * scale + ox,
        pt.y * scale + oy,
        octx.lineWidth * 0.7,
        0,
        Math.PI * 2
      );
      octx.fill();

      continue;
    }

    octx.beginPath();
    octx.moveTo(
      stroke[0].x * scale + ox,
      stroke[0].y * scale + oy
    );

    for (let i=1; i<stroke.length; i++) {
      octx.lineTo(
        stroke[i].x * scale + ox,
        stroke[i].y * scale + oy
      );
    }

    octx.stroke();
  }

  return v84CenterByInkMass(out);
}

function v84Make28Tensor(baseCanvas, contentSize) {
  return tf.tidy(() => {
    let t = tf.browser.fromPixels(baseCanvas, 1).toFloat();

    t = tf.image.resizeBilinear(
      t,
      [contentSize, contentSize],
      false
    );

    const totalPad = 28 - contentSize;
    const p0 = Math.floor(totalPad / 2);
    const p1 = totalPad - p0;

    t = t.pad([
      [p0,p1],
      [p0,p1],
      [0,0]
    ], 255);

    // white=0, black=1
    return tf.scalar(1).sub(t.div(255.0));
  });
}

// V8.5 exact V13 lower gesture + corrections
const canvas = handwritingCanvas; // V8.5.1: V13 compatibility alias

function recognizeLowerGesture(strokes) {
    const valid = (strokes || []).filter(s => s && s.length >= 2);
    if (valid.length !== 1) return null;

    const s = valid[0];
    const p0 = s[0];
    const p1 = s[s.length - 1];

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let pathLen = 0;

    for (let i = 0; i < s.length; i++) {
        const p = s[i];
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);

        if (i > 0) {
            const q = s[i - 1];
            pathLen += Math.hypot(p.x - q.x, p.y - q.y);
        }
    }

    const rect = handwritingCanvas.getBoundingClientRect();
    const cw = Math.max(1, rect.width);
    const ch = Math.max(1, rect.height);

    const w = maxX - minX;
    const h = maxY - minY;
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const displacement = Math.hypot(dx, dy);
    const straightness = pathLen > 0 ? displacement / pathLen : 0;

    const wR = w / cw;
    const hR = h / ch;

    // Space:
    // 十分長い、ほぼ水平、ほぼ直線の1ストローク。
    // 左→右 / 右→左のどちらもSpace。
    if (
        wR >= 0.28 &&
        hR <= 0.10 &&
        Math.abs(dx) >= Math.abs(dy) * 4.0 &&
        straightness >= 0.88
    ) {
        return {
            type: 'space',
            character: ' ',
            label: 'Space'
        };
    }

    // Return:
    // 右上 -> 左下。canvas座標では dx < 0, dy > 0。
    // 長く、斜め成分が十分あり、ほぼ直線であることを要求。
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const slopeRatio = absDy > 0 ? absDx / absDy : 999;

    if (
        dx < 0 &&
        dy > 0 &&
        wR >= 0.20 &&
        hR >= 0.18 &&
        slopeRatio >= 0.45 &&
        slopeRatio <= 2.20 &&
        straightness >= 0.88
    ) {
        return {
            type: 'return',
            character: '\r',
            label: 'Return'
        };
    }

    return null;
}

function analyzeFinalHorizontalTail(strokes) {
    const result = {
        hasTail: false,
        runDx: 0,
        runDy: 0,
        runLen: 0,
        width: 0,
        height: 0,
        lowerY: 0,
        ratio: 0
    };

    if (!strokes || strokes.length === 0) return result;

    const b = v84Bounds(strokes);
    if (!b) return result;

    result.width = b.w;
    result.height = b.h;

    let s = null;
    for (let i = strokes.length - 1; i >= 0; i--) {
        if (strokes[i] && strokes[i].length >= 4) {
            s = strokes[i];
            break;
        }
    }
    if (!s) return result;

    // V6.8:
    // 「最後の横線」を、終端付近の局所的な角度ではなく
    // "文字の最下部へ到達した後に、どれだけ横へ進んだか" で判定する。
    //
    // g: 下まで降りた後、最後に横へ払う
    // q: 下まで降りて、ほぼそのまま終了
    //
    // これなら横線の途中に多少のブレ/フックがあっても拾える。

    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of s) {
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
    }
    const strokeH = Math.max(1, maxY - minY);

    // 下端から上へ12%以内に初めて入った点を「下端到達点」とする。
    const lowThreshold = maxY - strokeH * 0.12;
    let lowIndex = -1;
    for (let i = 0; i < s.length; i++) {
        if (s[i].y >= lowThreshold) {
            lowIndex = i;
            break;
        }
    }
    if (lowIndex < 0 || lowIndex >= s.length - 1) {
        return result;
    }

    const startPt = s[lowIndex];
    const endPt = s[s.length - 1];

    let pathLen = 0;
    let absDx = 0;
    let absDy = 0;

    for (let i = lowIndex + 1; i < s.length; i++) {
        const dx = s[i].x - s[i - 1].x;
        const dy = s[i].y - s[i - 1].y;
        const len = Math.hypot(dx, dy);
        if (len < 0.01) continue;

        pathLen += len;
        absDx += Math.abs(dx);
        absDy += Math.abs(dy);
    }

    const netDx = endPt.x - startPt.x;
    const netDy = endPt.y - startPt.y;

    result.runDx = netDx;
    result.runDy = netDy;
    result.runLen = pathLen;
    result.lowerY = b.h > 0
        ? (((startPt.y + endPt.y) / 2 - b.minY) / b.h)
        : 0;
    result.ratio = absDy > 0.1 ? absDx / absDy : 999;

    // q の既知実測は dx=1〜2。
    // g は「下端到達後の横移動」が明確なら採用する。
    const enoughNetHorizontal =
        Math.abs(netDx) >= Math.max(6, b.w * 0.10);

    const enoughHorizontalTravel =
        absDx >= Math.max(8, b.w * 0.14);

    // 下端到達後の動きが、縦より横優勢。
    const horizontalDominant =
        absDx >= absDy * 1.15;

    // 最終点も十分下側に残っていること。
    const staysLow =
        endPt.y >= b.minY + b.h * 0.68;

    result.hasTail =
        enoughNetHorizontal &&
        enoughHorizontalTravel &&
        horizontalDominant &&
        staysLow;

    return result;
}

function applyGQCorrection(normalized, strokes) {
    if (!normalized || normalized.length === 0) return normalized;

    const best = normalized[0];

    // AIがg/q系を1位にした時だけ補正。
    // 他文字には一切影響させない。
    if (best.character !== 'g' && best.character !== 'q') {
        return normalized;
    }

    const g = normalized.find(x => x.character === 'g');
    const q = normalized.find(x => x.character === 'q');

    if (!g || !q) return normalized;

    const tail = analyzeFinalHorizontalTail(strokes);
    const hasTail = tail.hasTail;
    const selected = hasTail ? g : q;
    const rejected = hasTail ? q : g;

    // AIのg/q合計確率を「g/qファミリーとしての確信度」とみなし、
    // 形状判定後の選択文字へ寄せる。
    const familyProb = Math.min(
        0.99,
        Math.max(best.probability, g.probability + q.probability)
    );

    selected.probability = Math.max(selected.probability, familyProb);
    rejected.probability = Math.min(rejected.probability, 0.08);

    // 選択した文字を先頭へ
    normalized.sort((a, b) => b.probability - a.probability);

    // デバッグ表示用
    normalized._gqCorrection = {
        applied: true,
        selected: selected.character,
        hasTail,
        tail
    };

    return normalized;
}



// ------------------------------------------------------------
// f / t 二次判定 (V6.9)
// ------------------------------------------------------------
// ユーザー実測:
//   f は t に誤認されやすい
//   f の上側の横線を強調すると f になる
//
// 方針:
//   AIが f/t 系を1位にした場合だけ、上部の横線を追加解析する。
//   文字上部に明確な横線があれば f、なければAI結果を維持する。
//   t を無理に f/t 二択へ倒さないため、補正は f 方向だけにする。

function analyzeUpperHorizontalBar(strokes) {
    const result = {
        strong: false,
        barLen: 0,
        barDx: 0,
        barDy: 0,
        barY: 1.0,
        width: 0,
        height: 0,
        leftReach: 0,
        rightReach: 0,
        asymmetry: 0,
        stemX: 0,
        crossOffset: 0,
        crossRatio: 0,
        strokeCount: 0,
        firstStartX: 0,
        firstStartY: 0,
        firstEndX: 0,
        firstEndY: 0,
        initialDx: 0,
        initialDy: 0,
        initialRatio: 0,
        terminalDx: 0,
        terminalDy: 0,
        topHook: 0
    };

    if (!strokes || strokes.length === 0) return result;

    const b = v84Bounds(strokes);
    if (!b) return result;

    result.width = b.w;
    result.height = b.h;
    result.strokeCount = strokes.filter(s => s && s.length >= 2).length;

    let best = null;

    for (const s of strokes) {
        if (!s || s.length < 2) continue;

        let runLen = 0;
        let runDx = 0;
        let runDy = 0;
        let runStart = null;
        let runEnd = null;

        function commit() {
            if (runLen <= 0 || !runStart || !runEnd) {
                runLen = 0;
                runDx = 0;
                runDy = 0;
                runStart = null;
                runEnd = null;
                return;
            }

            const midY = (runStart.y + runEnd.y) / 2;
            const yNorm = b.h > 0 ? (midY - b.minY) / b.h : 1.0;

            const candidate = {
                len: runLen,
                dx: runDx,
                dy: runDy,
                yNorm,
                start: runStart,
                end: runEnd
            };

            if (!best || candidate.len > best.len) best = candidate;

            runLen = 0;
            runDx = 0;
            runDy = 0;
            runStart = null;
            runEnd = null;
        }

        for (let i = 1; i < s.length; i++) {
            const p1 = s[i - 1];
            const p2 = s[i];
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const len = Math.hypot(dx, dy);
            if (len < 0.01) continue;

            const horizontal = Math.abs(dx) >= Math.abs(dy) * 2.0;

            if (horizontal) {
                if (!runStart) runStart = p1;
                runEnd = p2;
                runLen += len;
                runDx += dx;
                runDy += dy;
            } else {
                commit();
            }
        }
        commit();
    }

    if (best) {
        result.barLen = best.len;
        result.barDx = best.dx;
        result.barDy = best.dy;
        result.barY = best.yNorm;
    }

    const xs = [];
    for (const s of strokes) {
        if (!s) continue;
        for (const p of s) {
            const yn = b.h > 0 ? (p.y - b.minY) / b.h : 0.5;
            if (yn >= 0.15 && yn <= 0.95) xs.push(p.x);
        }
    }

    let stemX = b.minX + b.w * 0.5;
    if (xs.length > 0) {
        xs.sort((a,b)=>a-b);
        stemX = xs[Math.floor(xs.length/2)];
    }
    result.stemX = stemX;

    if (best) {
        const x1 = Math.min(best.start.x, best.end.x);
        const x2 = Math.max(best.start.x, best.end.x);

        result.leftReach = Math.max(0, stemX - x1);
        result.rightReach = Math.max(0, x2 - stemX);

        const totalReach = result.leftReach + result.rightReach;
        result.asymmetry = totalReach > 0
            ? (result.rightReach - result.leftReach) / totalReach
            : 0;

        const barCenterX = (x1 + x2) / 2;
        result.crossOffset = barCenterX - stemX;
        result.crossRatio = b.w > 0 ? result.crossOffset / b.w : 0;
    }

    let first = null;
    for (const s of strokes) {
        if (s && s.length >= 3) {
            first = s;
            break;
        }
    }

    if (first) {
        const p0 = first[0];
        const pe = first[first.length - 1];

        result.firstStartX = b.w > 0 ? (p0.x - b.minX) / b.w : 0;
        result.firstStartY = b.h > 0 ? (p0.y - b.minY) / b.h : 0;
        result.firstEndX = b.w > 0 ? (pe.x - b.minX) / b.w : 0;
        result.firstEndY = b.h > 0 ? (pe.y - b.minY) / b.h : 0;

        const cut = Math.max(2, Math.ceil(first.length * 0.20));
        const pi = first[Math.min(first.length - 1, cut)];

        result.initialDx = pi.x - p0.x;
        result.initialDy = pi.y - p0.y;
        result.initialRatio =
            Math.abs(result.initialDy) > 0.1
                ? Math.abs(result.initialDx) / Math.abs(result.initialDy)
                : 999;

        const tailStart = Math.max(0, first.length - 1 - cut);
        const pt = first[tailStart];

        result.terminalDx = pe.x - pt.x;
        result.terminalDy = pe.y - pt.y;

        let topMinX = Infinity;
        let topMaxX = -Infinity;
        for (const p of first) {
            const yn = b.h > 0 ? (p.y - b.minY) / b.h : 1;
            if (yn <= 0.22) {
                topMinX = Math.min(topMinX, p.x);
                topMaxX = Math.max(topMaxX, p.x);
            }
        }
        if (isFinite(topMinX) && isFinite(topMaxX) && b.w > 0) {
            result.topHook = (topMaxX - topMinX) / b.w;
        }
    }

    if (best) {
        const upperEnough = best.yNorm <= 0.38;
        const longEnough =
            Math.abs(best.dx) >= Math.max(5, b.w * 0.14) &&
            best.len >= Math.max(6, b.w * 0.16);
        const flatEnough =
            Math.abs(best.dy) <= Math.max(4, b.h * 0.10);

        result.strong = upperEnough && longEnough && flatEnough;
    }

    return result;
}

function applyFTCorrection(normalized, strokes) {
    if (!normalized || normalized.length === 0) return normalized;

    const best = normalized[0];
    if (best.character !== 'f' && best.character !== 't') {
        return normalized;
    }

    const f = normalized.find(x => x.character === 'f');
    const t = normalized.find(x => x.character === 't');
    if (!f || !t) return normalized;

    const bar = analyzeUpperHorizontalBar(strokes);

    // V6.14:
    // ユーザーの書き順をそのまま利用する。
    //
    //   f : 2画目の書き始めが横方向
    //   t : 2画目の書き始めが縦方向
    //
    // 2画目の最初の約25%だけを見て方向を判定する。
    let secondStartHorizontal = false;
    let secondStartVertical = false;
    let secondDx = 0;
    let secondDy = 0;
    let secondRatio = 0;

    const validStrokes = strokes.filter(s => s && s.length >= 3);

    if (validStrokes.length >= 2) {
        const second = validStrokes[1];

        const cut = Math.max(2, Math.ceil(second.length * 0.25));
        const p0 = second[0];
        const p1 = second[Math.min(second.length - 1, cut)];

        secondDx = p1.x - p0.x;
        secondDy = p1.y - p0.y;

        secondRatio =
            Math.abs(secondDy) > 0.1
                ? Math.abs(secondDx) / Math.abs(secondDy)
                : 999;

        // 横開始: 横移動が縦移動の1.5倍以上
        secondStartHorizontal =
            Math.abs(secondDx) >= Math.abs(secondDy) * 1.5 &&
            Math.abs(secondDx) >= 4;

        // 縦開始: 縦移動が横移動の1.5倍以上
        secondStartVertical =
            Math.abs(secondDy) >= Math.abs(secondDx) * 1.5 &&
            Math.abs(secondDy) >= 4;
    }

    let selected = best;

    if (validStrokes.length >= 2) {
        if (secondStartHorizontal) {
            selected = f;
        } else if (secondStartVertical) {
            selected = t;
        } else {
            // 方向が曖昧な場合だけ従来の上部横線情報を補助的に使う。
            if (bar.strong) {
                selected = f;
            }
        }
    } else if (bar.strong) {
        selected = f;
    }

    if (selected === f || selected === t) {
        const rejected = selected === f ? t : f;

        const familyProb = Math.min(
            0.99,
            Math.max(best.probability, f.probability + t.probability)
        );

        selected.probability = Math.max(selected.probability, familyProb);
        rejected.probability = Math.min(rejected.probability, 0.08);
        normalized.sort((a, b) => b.probability - a.probability);
    }

    normalized._ftCorrection = {
        applied: true,
        selected: normalized[0].character,
        bar,
        secondStartHorizontal,
        secondStartVertical,
        secondDx,
        secondDy,
        secondRatio
    };

    return normalized;
}


// ------------------------------------------------------------
// u / v 二次判定 (V6.15)
// ------------------------------------------------------------
// ユーザー実測:
//   u は v に寄りやすい
//   u は下側の横方向を少し強調すると認識が改善
//
// 方針:
//   AIが u/v 系を1位にした場合だけ、文字最下部付近の
//   「横方向の広がり」を見る。
//
//   u : 最下部付近が横に広い / 丸い底
//   v : 最下部付近が狭い / 尖った底

function analyzeUVBottom(strokes) {
    const result = {
        bottomSpan: 0,
        bottomSpanRatio: 0,
        bottomCount: 0,
        width: 0,
        height: 0,
        bottomPathHorizontal: 0,
        bottomPathVertical: 0,
        bottomRatio: 0,
        uLike: false
    };

    if (!strokes || strokes.length === 0) return result;

    const b = v84Bounds(strokes);
    if (!b) return result;

    result.width = b.w;
    result.height = b.h;

    // 下端18%を「底部」とみなす
    const bottomY = b.minY + b.h * 0.82;

    let minX = Infinity;
    let maxX = -Infinity;

    for (const s of strokes) {
        if (!s || s.length < 2) continue;

        for (const p of s) {
            if (p.y >= bottomY) {
                minX = Math.min(minX, p.x);
                maxX = Math.max(maxX, p.x);
                result.bottomCount++;
            }
        }

        for (let i = 1; i < s.length; i++) {
            const p1 = s[i - 1];
            const p2 = s[i];

            // 区間の中点が底部にあるものだけ集計
            const midY = (p1.y + p2.y) / 2;
            if (midY < bottomY) continue;

            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;

            result.bottomPathHorizontal += Math.abs(dx);
            result.bottomPathVertical += Math.abs(dy);
        }
    }

    if (isFinite(minX) && isFinite(maxX)) {
        result.bottomSpan = maxX - minX;
        result.bottomSpanRatio = b.w > 0 ? result.bottomSpan / b.w : 0;
    }

    result.bottomRatio =
        result.bottomPathVertical > 0.1
            ? result.bottomPathHorizontal / result.bottomPathVertical
            : 999;

    // V6.15初期閾値:
    // uは底部が文字幅の22%以上に広がり、
    // かつ底部の動きが横方向優勢ならu寄り。
    result.uLike =
        result.bottomSpanRatio >= 0.22 &&
        result.bottomPathHorizontal >= 6 &&
        result.bottomRatio >= 1.15;

    return result;
}

function applyUVCorrection(normalized, strokes) {
    if (!normalized || normalized.length === 0) return normalized;

    const best = normalized[0];
    if (best.character !== 'u' && best.character !== 'v') {
        return normalized;
    }

    const u = normalized.find(x => x.character === 'u');
    const v = normalized.find(x => x.character === 'v');
    if (!u || !v) return normalized;

    const bottom = analyzeUVBottom(strokes);

    const selected = bottom.uLike ? u : v;
    const rejected = bottom.uLike ? v : u;

    const familyProb = Math.min(
        0.99,
        Math.max(best.probability, u.probability + v.probability)
    );

    selected.probability = Math.max(selected.probability, familyProb);
    rejected.probability = Math.min(rejected.probability, 0.08);

    normalized.sort((a, b) => b.probability - a.probability);

    normalized._uvCorrection = {
        applied: true,
        selected: selected.character,
        bottom
    };

    return normalized;
}



// ------------------------------------------------------------
// j / d 二次判定 (V6.16)
// ------------------------------------------------------------
// ユーザー実測:
//   j は d に寄ることがある
//   j は「上の点をしっかり打つ」＋「下部を強調」で改善
//
// 方針:
//   AIが j/d 系を1位にした場合だけ追加判定。
//   文字上部に、本体とは独立した小さな点ストロークがあれば j。
//   点がなければ d。
//   j の下部形状も補助指標として診断表示する。

function analyzeJDDot(strokes) {
    const result = {
        hasDot: false,
        dotStrokeIndex: -1,
        dotLen: 0,
        dotW: 0,
        dotH: 0,
        dotY: 1.0,
        strokeCount: 0,
        width: 0,
        height: 0,
        lowerHookDx: 0,
        lowerHookDy: 0,
        lowerHookRatio: 0
    };

    if (!strokes || strokes.length === 0) return result;

    const b = v84Bounds(strokes);
    if (!b) return result;

    result.width = b.w;
    result.height = b.h;

    const valid = strokes.filter(s => s && s.length >= 1);
    result.strokeCount = valid.length;

    for (let si = 0; si < strokes.length; si++) {
        const s = strokes[si];
        if (!s || s.length === 0) continue;

        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let pathLen = 0;

        for (let i = 0; i < s.length; i++) {
            const p = s[i];
            minX = Math.min(minX, p.x);
            maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y);
            maxY = Math.max(maxY, p.y);

            if (i > 0) {
                const q = s[i - 1];
                pathLen += Math.hypot(p.x - q.x, p.y - q.y);
            }
        }

        const sw = Math.max(0, maxX - minX);
        const sh = Math.max(0, maxY - minY);
        const cy = (minY + maxY) / 2;
        const yNorm = b.h > 0 ? (cy - b.minY) / b.h : 1.0;

        const upper = yNorm <= 0.30;
        const compact =
            sw <= Math.max(12, b.w * 0.28) &&
            sh <= Math.max(12, b.h * 0.18);
        const shortPath =
            pathLen <= Math.max(22, (b.w + b.h) * 0.16);

        if (upper && compact && shortPath) {
            result.hasDot = true;
            result.dotStrokeIndex = si;
            result.dotLen = pathLen;
            result.dotW = sw;
            result.dotH = sh;
            result.dotY = yNorm;
            break;
        }
    }

    let body = null;
    let bodyLen = -1;

    for (let si = 0; si < strokes.length; si++) {
        if (si === result.dotStrokeIndex) continue;

        const s = strokes[si];
        if (!s || s.length < 3) continue;

        let len = 0;
        for (let i = 1; i < s.length; i++) {
            len += Math.hypot(
                s[i].x - s[i-1].x,
                s[i].y - s[i-1].y
            );
        }

        if (len > bodyLen) {
            bodyLen = len;
            body = s;
        }
    }

    if (body && body.length >= 4) {
        const n = body.length;
        const start = Math.max(0, n - Math.max(3, Math.ceil(n * 0.25)));

        const p0 = body[start];
        const p1 = body[n - 1];

        result.lowerHookDx = p1.x - p0.x;
        result.lowerHookDy = p1.y - p0.y;
        result.lowerHookRatio =
            Math.abs(result.lowerHookDy) > 0.1
                ? Math.abs(result.lowerHookDx) / Math.abs(result.lowerHookDy)
                : 999;
    }

    return result;
}

function applyJDCorrection(normalized, strokes) {
    if (!normalized || normalized.length === 0) return normalized;

    const best = normalized[0];
    if (best.character !== 'j' && best.character !== 'd') {
        return normalized;
    }

    const j = normalized.find(x => x.character === 'j');
    const d = normalized.find(x => x.character === 'd');
    if (!j || !d) return normalized;

    const info = analyzeJDDot(strokes);

    const selected = info.hasDot ? j : d;
    const rejected = info.hasDot ? d : j;

    const familyProb = Math.min(
        0.99,
        Math.max(best.probability, j.probability + d.probability)
    );

    selected.probability = Math.max(selected.probability, familyProb);
    rejected.probability = Math.min(rejected.probability, 0.08);

    normalized.sort((a, b) => b.probability - a.probability);

    normalized._jdCorrection = {
        applied: true,
        selected: selected.character,
        info
    };

    return normalized;
}



// ------------------------------------------------------------
// n / h 二次判定 (V6.17)
// ------------------------------------------------------------
// h : 左の縦棒（ascender）が、右側の山より明確に高い
// n : 左右の上端の高さが比較的近い
//
// 文字全体の上端だけでは区別しにくいため、
// 左40%と右40%の「最上点」の差を見る。

function analyzeNHShape(strokes) {
    const result = {
        width: 0,
        height: 0,
        aspect: 0,
        leftTop: 1.0,
        rightTop: 1.0,
        topDiff: 0,
        leftCount: 0,
        rightCount: 0,
        hLike: false
    };

    if (!strokes || strokes.length === 0) return result;

    const b = v84Bounds(strokes);
    if (!b) return result;

    result.width = b.w;
    result.height = b.h;
    result.aspect = b.h > 0 ? b.w / b.h : 0;

    const leftLimit = b.minX + b.w * 0.40;
    const rightLimit = b.minX + b.w * 0.60;

    let leftTopY = Infinity;
    let rightTopY = Infinity;

    for (const s of strokes) {
        if (!s) continue;

        for (const p of s) {
            if (p.x <= leftLimit) {
                leftTopY = Math.min(leftTopY, p.y);
                result.leftCount++;
            }

            if (p.x >= rightLimit) {
                rightTopY = Math.min(rightTopY, p.y);
                result.rightCount++;
            }
        }
    }

    if (isFinite(leftTopY)) {
        result.leftTop =
            b.h > 0 ? (leftTopY - b.minY) / b.h : 0;
    }

    if (isFinite(rightTopY)) {
        result.rightTop =
            b.h > 0 ? (rightTopY - b.minY) / b.h : 0;
    }

    // hなら左の縦棒上端が右側の山より高くなる。
    result.topDiff = result.rightTop - result.leftTop;

    // 初期閾値。
    // 右側最上点が左側より文字高さの18%以上低ければ h。
    result.hLike =
        result.leftCount >= 3 &&
        result.rightCount >= 3 &&
        result.topDiff >= 0.18;

    return result;
}

function applyNHCorrection(normalized, strokes) {
    if (!normalized || normalized.length === 0) return normalized;

    const best = normalized[0];
    if (best.character !== 'n' && best.character !== 'h') {
        return normalized;
    }

    const n = normalized.find(x => x.character === 'n');
    const h = normalized.find(x => x.character === 'h');
    if (!n || !h) return normalized;

    const info = analyzeNHShape(strokes);
    const selected = info.hLike ? h : n;
    const rejected = info.hLike ? n : h;

    const familyProb = Math.min(
        0.99,
        Math.max(best.probability, n.probability + h.probability)
    );

    selected.probability = Math.max(selected.probability, familyProb);
    rejected.probability = Math.min(rejected.probability, 0.08);

    normalized.sort((a, b) => b.probability - a.probability);

    normalized._nhCorrection = {
        applied: true,
        selected: selected.character,
        info
    };

    return normalized;
}


// ------------------------------------------------------------
// r / f 二次判定 (V6.17)
// ------------------------------------------------------------
// ユーザーの f はこれまでの実測で2画:
//   1画目 = 横線
//   2画目 = 横から入り、その後縦方向
//
// r は通常1画。
// したがってAIが r/f 系を1位にしたときだけ、
// 有効ストローク数を主判定に使う。
// 既存f/t補正は変更しない。

function analyzeRFStrokes(strokes) {
    const result = {
        strokeCount: 0,
        secondDx: 0,
        secondDy: 0,
        secondRatio: 0,
        fLike: false
    };

    if (!strokes) return result;

    const valid = strokes.filter(s => s && s.length >= 3);
    result.strokeCount = valid.length;

    if (valid.length >= 2) {
        const second = valid[1];
        const cut = Math.max(2, Math.ceil(second.length * 0.20));
        const p0 = second[0];
        const p1 = second[Math.min(second.length - 1, cut)];

        result.secondDx = p1.x - p0.x;
        result.secondDy = p1.y - p0.y;

        const ax = Math.abs(result.secondDx);
        const ay = Math.abs(result.secondDy);
        result.secondRatio = ay > 0.1 ? ax / ay : 999;
    }

    // user's f is consistently two-stroke.
    result.fLike = valid.length >= 2;

    return result;
}

function applyRFCorrection(normalized, strokes) {
    if (!normalized || normalized.length === 0) return normalized;

    const best = normalized[0];
    if (best.character !== 'r' && best.character !== 'f') {
        return normalized;
    }

    const r = normalized.find(x => x.character === 'r');
    const f = normalized.find(x => x.character === 'f');
    if (!r || !f) return normalized;

    const info = analyzeRFStrokes(strokes);
    const selected = info.fLike ? f : r;
    const rejected = info.fLike ? r : f;

    const familyProb = Math.min(
        0.99,
        Math.max(best.probability, r.probability + f.probability)
    );

    selected.probability = Math.max(selected.probability, familyProb);
    rejected.probability = Math.min(rejected.probability, 0.08);

    normalized.sort((a, b) => b.probability - a.probability);

    normalized._rfCorrection = {
        applied: true,
        selected: selected.character,
        info
    };

    return normalized;
}


// ============================================================
// V7.2.2 数字認識: EMNIST 0..9のみでランキング
// ============================================================




// ============================================================
// V8.8 - V13 symbol recognizer
// Point-cloud templates + geometric corrections
// ============================================================
const SYMBOL_SEND_THRESHOLD = 0.55;

const SYMBOL_POINT_COUNT = 48;

// Templates use 0..100 coordinates.
// Each outer array element is one pen stroke.
const SYMBOL_TEMPLATES_RAW = {
    '.': [
        [[50,50],[51,51]]
    ],
    ',': [
        [[52,42],[51,55],[47,68]]
    ],
    ':': [
        [[50,30],[51,31]],
        [[50,70],[51,71]]
    ],
    ';': [
        [[50,28],[51,29]],
        [[52,55],[51,66],[46,76]]
    ],
    '!': [
        [[50,15],[50,65]],
        [[50,82],[51,83]]
    ],
    '?': [
        [[30,30],[38,18],[55,15],[70,23],[73,36],[66,47],[54,54],[50,62]],
        [[50,82],[51,83]]
    ],
    '/': [
        [[25,85],[75,15]]
    ],
    '\\': [
        [[25,15],[75,85]]
    ],
    '<': [
        [[72,18],[28,50],[72,82]]
    ],
    '>': [
        [[28,18],[72,50],[28,82]]
    ],
    '[': [
        [[68,15],[38,15],[38,85],[68,85]]
    ],
    '+': [
        [[50,15],[50,85]],
        [[15,50],[85,50]]
    ],
    '-': [
        [[15,50],[85,50]]
    ],
    '=': [
        [[18,35],[82,35]],
        [[18,65],[82,65]]
    ],
    '_': [
        [[15,78],[85,78]]
    ],
    '|': [
        [[50,12],[50,88]]
    ],
    '#': [
        [[36,12],[31,88]],
        [[66,12],[61,88]],
        [[15,38],[85,33]],
        [[12,67],[82,62]]
    ],
    '*': [
        [[50,12],[50,88]],
        [[18,28],[82,72]],
        [[82,28],[18,72]]
    ],
    '^': [
        [[20,70],[50,25],[80,70]]
    ],
    '@': [
        [[76,55],[73,35],[60,25],[43,25],[30,36],[27,55],[34,70],[49,77],[65,72],[70,58],
         [68,43],[58,37],[48,40],[44,52],[48,62],[58,64],[68,58],[78,48],[80,33],[73,19],
         [60,10],[42,10],[25,19],[14,34],[11,54],[17,72],[31,84],[50,89],[69,84]]
    ]
};

function symbolFlattenStrokes(strokes) {
    const pts = [];

    strokes.forEach((stroke, strokeIndex) => {
        if (!stroke || stroke.length === 0) return;

        if (stroke.length === 1) {
            const p = stroke[0];
            pts.push({x:p.x, y:p.y, stroke:strokeIndex});
            pts.push({x:p.x + 0.2, y:p.y + 0.2, stroke:strokeIndex});
            return;
        }

        for (const p of stroke) {
            pts.push({x:p.x, y:p.y, stroke:strokeIndex});
        }
    });

    return pts;
}

function symbolPathLength(points) {
    let d = 0;
    for (let i = 1; i < points.length; i++) {
        if (points[i].stroke !== points[i-1].stroke) continue;
        d += Math.hypot(
            points[i].x - points[i-1].x,
            points[i].y - points[i-1].y
        );
    }
    return d;
}

function symbolResample(points, n) {
    if (!points || points.length < 2) return [];

    const src = points.map(p => ({...p}));
    const total = symbolPathLength(src);

    // all-dot symbol
    if (total < 0.001) {
        const p = src[0];
        return Array.from({length:n}, () => ({...p}));
    }

    const interval = total / (n - 1);
    let D = 0;
    const out = [{...src[0]}];

    let i = 1;
    while (i < src.length) {
        const prev = src[i-1];
        const cur = src[i];

        if (cur.stroke !== prev.stroke) {
            if (out.length < n) out.push({...cur});
            i++;
            continue;
        }

        const d = Math.hypot(cur.x - prev.x, cur.y - prev.y);

        if (d > 0 && D + d >= interval) {
            const t = (interval - D) / d;
            const q = {
                x: prev.x + t * (cur.x - prev.x),
                y: prev.y + t * (cur.y - prev.y),
                stroke: cur.stroke
            };
            out.push(q);
            src.splice(i, 0, q);
            D = 0;
            i++;
        } else {
            D += d;
            i++;
        }

        if (out.length >= n) break;
    }

    while (out.length < n) {
        out.push({...src[src.length - 1]});
    }

    return out.slice(0, n);
}

function symbolNormalize(points) {
    if (!points || points.length === 0) return [];

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const p of points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    }

    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const scale = Math.max(w, h);

    let cx = 0, cy = 0;
    const scaled = points.map(p => {
        const q = {
            x: (p.x - minX) / scale,
            y: (p.y - minY) / scale,
            stroke: p.stroke
        };
        cx += q.x;
        cy += q.y;
        return q;
    });

    cx /= scaled.length;
    cy /= scaled.length;

    return scaled.map(p => ({
        x: p.x - cx,
        y: p.y - cy,
        stroke: p.stroke
    }));
}

function symbolPointCloud(strokes) {
    const flat = symbolFlattenStrokes(strokes);
    const resampled = symbolResample(flat, SYMBOL_POINT_COUNT);
    return symbolNormalize(resampled);
}

function symbolCloudDistance(a, b) {
    if (!a.length || !b.length) return Infinity;

    // Symmetric nearest-neighbor cloud distance.
    function oneWay(x, y) {
        let sum = 0;
        for (const p of x) {
            let best = Infinity;
            for (const q of y) {
                const d = Math.hypot(p.x - q.x, p.y - q.y);
                if (d < best) best = d;
            }
            sum += best;
        }
        return sum / x.length;
    }

    return (oneWay(a,b) + oneWay(b,a)) / 2;
}

const SYMBOL_TEMPLATES = Object.entries(SYMBOL_TEMPLATES_RAW).map(
    ([character, strokes]) => ({
        character,
        strokes,
        strokeCount: strokes.length,
        cloud: symbolPointCloud(
            strokes.map(s => s.map(([x,y]) => ({x,y})))
        )
    })
);

function symbolRawFeatures(strokes) {
    const pts = symbolFlattenStrokes(strokes);
    if (!pts.length) return null;

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const p of pts) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    }

    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const aspect = w / h;

    let totalLen = 0;
    for (let i = 1; i < pts.length; i++) {
        if (pts[i].stroke !== pts[i-1].stroke) continue;
        totalLen += Math.hypot(
            pts[i].x - pts[i-1].x,
            pts[i].y - pts[i-1].y
        );
    }

    const first = pts[0];
    const last = pts[pts.length - 1];
    const endDist = Math.hypot(last.x - first.x, last.y - first.y);
    const diag = Math.hypot(w, h);
    const closure = diag > 0 ? endDist / diag : 1;

    // 曲がり量
    let turn = 0;
    let turnSamples = 0;
    for (let i = 2; i < pts.length; i++) {
        const a = pts[i-2], b = pts[i-1], c = pts[i];
        if (a.stroke !== b.stroke || b.stroke !== c.stroke) continue;

        const v1x = b.x - a.x, v1y = b.y - a.y;
        const v2x = c.x - b.x, v2y = c.y - b.y;
        const l1 = Math.hypot(v1x, v1y);
        const l2 = Math.hypot(v2x, v2y);
        if (l1 < 1 || l2 < 1) continue;

        let cos = (v1x*v2x + v1y*v2y) / (l1*l2);
        cos = Math.max(-1, Math.min(1, cos));
        turn += Math.acos(cos);
        turnSamples++;
    }

    return {
        strokeCount: strokes.length,
        w, h, aspect,
        totalLen,
        closure,
        meanTurn: turnSamples ? turn / turnSamples : 0,
        minX, minY, maxX, maxY
    };
}

function symbolDirectionalPenalty(character, strokes, f) {
    if (!f) return 0;

    let penalty = 0;

    // @ は「ほぼ閉じた」「縦横比が極端でない」「十分に複雑」な形だけ許す。
    if (character === '@') {
        if (f.closure > 0.48) penalty += 0.34;
        if (f.aspect < 0.55 || f.aspect > 1.8) penalty += 0.28;
        if (f.totalLen < Math.max(f.w, f.h) * 2.2) penalty += 0.30;
        if (f.meanTurn < 0.06) penalty += 0.25;
    }

    // + は2ストローク以上を強く優先。
    if (character === '+') {
        if (f.strokeCount < 2) penalty += 0.30;
        if (f.aspect < 0.35 || f.aspect > 2.8) penalty += 0.12;
    }

    // = は2本線が基本。
    if (character === '=') {
        if (f.strokeCount < 2) penalty += 0.34;
        if (f.aspect < 1.3) penalty += 0.18;
    }

    // : ; ! ? は複数ストロークを基本とする。
    if ([':', ';', '!', '?'].includes(character)) {
        if (f.strokeCount < 2) penalty += 0.20;
    }

    // / と \ は1ストロークの斜線を優先。
    if (character === '/' || character === '\\') {
        if (f.strokeCount !== 1) penalty += 0.18;
        if (f.aspect < 0.35 || f.aspect > 3.0) penalty += 0.12;

        const s = strokes[0];
        if (s && s.length >= 2) {
            const a = s[0], b = s[s.length - 1];
            const dx = b.x - a.x;
            const dy = b.y - a.y;

            // 画面座標では下が+。
            // / は通常「左下 -> 右上」または逆なので dx*dy < 0
            // \ は dx*dy > 0
            if (character === '/' && dx * dy > 0) penalty += 0.38;
            if (character === '\\' && dx * dy < 0) penalty += 0.38;
        }
    }

    // < > は1ストロークV字を優先し、左右方向も確認。
    if (character === '<' || character === '>') {
        if (f.strokeCount !== 1) penalty += 0.16;

        const s = strokes[0];
        if (s && s.length >= 5) {
            // 最も左右に突き出た点が中央付近にあるかを見る。
            let idx = 0;
            for (let i = 1; i < s.length; i++) {
                if (
                    (character === '<' && s[i].x < s[idx].x) ||
                    (character === '>' && s[i].x > s[idx].x)
                ) {
                    idx = i;
                }
            }

            const frac = idx / (s.length - 1);
            if (frac < 0.18 || frac > 0.82) penalty += 0.22;
        }
    }

    // - と _ は横長。
    if (character === '-' || character === '_') {
        if (f.aspect < 2.2) penalty += 0.25;
    }

    // | は縦長。
    if (character === '|') {
        if (f.aspect > 0.45) penalty += 0.25;
    }

    // ^ は横幅がある山型。
    if (character === '^') {
        if (f.aspect < 0.65) penalty += 0.14;
    }

    return penalty;
}


// ============================================================
// V6.20 記号の幾何補正
// ============================================================
function rawSymbolGeometry(strokes) {
    const g = {minX:Infinity,maxX:-Infinity,minY:Infinity,maxY:-Infinity,w:0,h:0,cx:0,cy:0,pathLen:0,strokeCount:0,dx:0,dy:0,turns:0};
    const valid=(strokes||[]).filter(s=>s&&s.length>0);
    g.strokeCount=valid.length;
    if(!valid.length) return g;
    let first=null,last=null;
    for(const s of valid){
        let prevAngle=null;
        if(!first&&s.length) first=s[0];
        if(s.length) last=s[s.length-1];
        for(let i=0;i<s.length;i++){
            const p=s[i];
            g.minX=Math.min(g.minX,p.x); g.maxX=Math.max(g.maxX,p.x);
            g.minY=Math.min(g.minY,p.y); g.maxY=Math.max(g.maxY,p.y);
            if(i>0){
                const q=s[i-1], ddx=p.x-q.x, ddy=p.y-q.y;
                g.pathLen+=Math.hypot(ddx,ddy);
                const ang=Math.atan2(ddy,ddx);
                if(prevAngle!==null){ let da=Math.abs(ang-prevAngle); if(da>Math.PI) da=2*Math.PI-da; if(da>0.65) g.turns++; }
                prevAngle=ang;
            }
        }
    }
    if(isFinite(g.minX)){ g.w=g.maxX-g.minX; g.h=g.maxY-g.minY; g.cx=(g.minX+g.maxX)/2; g.cy=(g.minY+g.maxY)/2; }
    if(first&&last){ g.dx=last.x-first.x; g.dy=last.y-first.y; }
    return g;
}

function symbolHeuristicOverride(strokes){
    const g=rawSymbolGeometry(strokes);
    const rect=canvas.getBoundingClientRect();
    const cw=Math.max(1,rect.width), ch=Math.max(1,rect.height);
    const wR=g.w/cw, hR=g.h/ch, cyR=g.cy/ch, lenR=g.pathLen/Math.max(cw,ch);

    // V7.2.2: ',' を '.' より先に判定する。
    // 小さく書いたカンマでも、下方向への明確な払いがあればカンマを優先。
    if(g.strokeCount===1 &&
       wR<=0.16 &&
       hR>=0.025 && hR<=0.28 &&
       lenR>=0.025 &&
       g.dy>0 &&
       Math.abs(g.dy)>=Math.max(2,Math.abs(g.dx)*1.15))
        return {character:',',probability:0.97,reason:'short-downstroke'};

    // V7.2.2: ',' の判定を通らなかった小さい1画は '.' を優先。
    // iPhoneでは点をタップしても数px〜十数pxの微小な軌跡になるため、
    // V6.20.1よりサイズ条件を緩める。
    // ';' は通常2画なので strokeCount===1 により影響させない。
    if(g.strokeCount===1 &&
       wR<=0.10 &&
       hR<=0.10 &&
       lenR<=0.12)
        return {character:'.',probability:0.99,reason:'small-dot'};

    if(g.strokeCount===1 && wR>=0.20 && hR<=0.10 && cyR>=0.68)
        return {character:'_',probability:0.97,reason:'low-horizontal'};

    if(g.strokeCount===1 && wR>=0.16 && hR>=0.16 && g.dx>0 && g.dy>0 && Math.abs(g.dx)>=g.w*0.70 && Math.abs(g.dy)>=g.h*0.70)
        return {character:'\\',probability:0.97,reason:'down-right-diagonal'};

    if(g.strokeCount===1 && wR>=0.22 && hR>=0.22 && lenR>=0.75 && g.turns>=6)
        return {character:'@',probability:0.94,reason:'large-complex-loop'};

    return null;
}

function recognizeSymbol(strokes) {
    const override = symbolHeuristicOverride(strokes);
    if (override) {
        return {
            character: override.character,
            probability: override.probability,
            top3: override.character + ' ' + Math.round(override.probability * 100) + '% [補正:' + override.reason + ']'
        };
    }

if (!strokes || strokes.length === 0) return null;

    const inputCloud = symbolPointCloud(strokes);
    if (!inputCloud.length) return null;

    const features = symbolRawFeatures(strokes);

    const scored = SYMBOL_TEMPLATES.map(t => {
        let distance = symbolCloudDistance(inputCloud, t.cloud);

        // ストローク数の違いを従来より強く評価。
        const strokePenalty =
            Math.abs(strokes.length - t.strokeCount) * 0.085;
        distance += strokePenalty;

        // 記号ごとの形状ルールを追加。
        distance += symbolDirectionalPenalty(
            t.character,
            strokes,
            features
        );

        return {
            character: t.character,
            distance
        };
    }).sort((a,b) => a.distance - b.distance);

    const best = scored[0];
    const second = scored[1];

    // 絶対距離だけでなく「2位との差」を信頼度に反映。
    const absoluteScore =
        Math.max(0, Math.min(1, 1 - best.distance / 0.46));

    const margin = second
        ? Math.max(0, second.distance - best.distance)
        : 0.25;

    const marginScore =
        Math.max(0, Math.min(1, margin / 0.18));

    // 絶対一致度 65% + 2位との差 35%
    let probability =
        absoluteScore * 0.65 +
        marginScore * 0.35;

    // @ は誤爆防止のため、閉じた形でない場合はさらに抑制。
    if (best.character === '@' && features) {
        if (features.closure > 0.40) {
            probability *= 0.55;
        }
        if (features.totalLen < Math.max(features.w, features.h) * 2.0) {
            probability *= 0.60;
        }
    }

    probability = Math.max(0, Math.min(1, probability));

    const top3 = scored.slice(0,3)
        .map((x, i) => {
            const next = scored[i+1];
            const abs = Math.max(0, Math.min(1, 1 - x.distance / 0.46));
            const mg = next
                ? Math.max(0, Math.min(1, (next.distance - x.distance) / 0.18))
                : 1;
            const p = Math.max(0, Math.min(1, abs * 0.65 + mg * 0.35));
            return x.character + ' ' + Math.round(p * 100) + '%';
        })
        .join(' / ');

    return {
        character: best.character,
        probability,
        top3
    };
}

// ============================================================
// V8.7 - digit 0-9 recognition
// Ported from Python/Safari V13 V7.2.2.
// EMNIST classes 0..9 only.
// ============================================================
async function v87RecognizeDigit(strokes) {
  if (!aiReady || !aiModel) return null;

  const base = v84RenderNormalized(strokes, 64);
  if (!base) return null;

  const probs = tf.tidy(() => {
    const sizes = [20,22,24];

    const preds = sizes.map(sz => {
      const input = v84Make28Tensor(base, sz).expandDims(0);

      let y = aiModel.predict(input);
      if (Array.isArray(y)) y = y[0];

      return y.squeeze();
    });

    return tf.stack(preds).mean(0);
  });

  const values = await probs.data();
  probs.dispose();

  const ranked = [];

  for (let i = 0; i < 10; i++) {
    ranked.push({
      character: String(i),
      probability: Number(values[i] || 0)
    });
  }

  ranked.sort((a,b) => b.probability - a.probability);

  const best = ranked[0];

  return {
    character: best.character,
    probability: best.probability,
    top5: ranked.slice(0,5)
  };
}

async function v84RecognizeLower(strokes) {
  if (!aiReady || !aiModel) return null;

  const base = v84RenderNormalized(strokes, 64);
  if (!base) return null;

  const probs = tf.tidy(() => {
    const sizes = [20,22,24];

    const preds = sizes.map(sz => {
      const input = v84Make28Tensor(base, sz).expandDims(0);

      let y = aiModel.predict(input);
      if (Array.isArray(y)) y = y[0];

      return y.squeeze();
    });

    return tf.stack(preds).mean(0);
  });

  const values = await probs.data();
  probs.dispose();

  const scores = [];

  for (let n=0; n<26; n++) {
    const lowerIndex = LOWERCASE_OFFSET + n;
    const upperIndex = UPPERCASE_OFFSET + n;

    const score =
      Number(values[lowerIndex] || 0) +
      CASE_FOLD_WEIGHT * Number(values[upperIndex] || 0);

    scores.push({
      character: LOWERCASE_ONLY[n],
      score
    });
  }

  scores.sort((a,b) => b.score - a.score);

  const total = scores.reduce((sum,x) => sum + x.score, 0);

  const normalized = scores.map(x => ({
    character: x.character,
    probability: total > 0 ? x.score / total : 0
  }));

  normalized.sort((a,b) => b.probability - a.probability);

  // V8.5: Python V13で実機調整済みの二次判定
  applyGQCorrection(normalized, strokes);
  applyFTCorrection(normalized, strokes);
  applyUVCorrection(normalized, strokes);
  applyJDCorrection(normalized, strokes);
  applyNHCorrection(normalized, strokes);
  applyRFCorrection(normalized, strokes);

  return {
    character: normalized[0].character,
    probability: normalized[0].probability,
    top3: normalized.slice(0,3)
  };
}

async function v84RecognizeAndSend() {
  const strokes = v84StrokeList.map(stroke => stroke.slice());

  if (!strokes.length) return;

  // V8.6:
  // lower(a) and upper(A) share the same V13 recognition pipeline.
  // Upper mode recognizes the same handwritten lowercase shape and
  // converts only the final character sent to NetHack.
  const recognizeMode = handwritingMode;

  if (
    recognizeMode !== 'a' &&
    recognizeMode !== 'A' &&
    recognizeMode !== '123' &&
    recognizeMode !== '!?' &&
    recognizeMode !== 'Ctrl'
  ) {
    handwritingLabel.textContent =
      recognizeMode + ' : not yet';
    return;
  }

  handwritingLabel.textContent = 'recognizing...';

  try {
    // V13: Space / Return gestures belong to lowercase mode only.
    const gesture =
      recognizeMode === 'a'
        ? recognizeLowerGesture(strokes)
        : null;

    if (gesture) {
      handwritingLabel.textContent = gesture.label;

      if (activeResolver) {
        v12SendHandwritingCharacter(gesture.character);
      }
      return;
    }

    // V12 build 2-7c - Ctrl+[ -> ASCII ESC (0x1B).
    // Detect '[' geometrically before the lowercase AI pipeline.
    // This applies only to Ctrl mode.
    if (recognizeMode === 'Ctrl') {
      const g = rawSymbolGeometry(strokes);
      const rect = canvas.getBoundingClientRect();
      const cw = Math.max(1, rect.width);
      const ch = Math.max(1, rect.height);

      const w = g.w / cw;
      const h = g.h / ch;
      const dx = g.dx / cw;
      const dy = g.dy / ch;

      const isCtrlLeftBracket =
        g.strokeCount === 1 &&
        w >= 0.25 &&
        w <= 0.45 &&
        h >= 0.60 &&
        Math.abs(dx) <= 0.15 &&
        dy >= 0.55 &&
        g.turns >= 3 &&
        g.turns <= 5;

      if (isCtrlLeftBracket) {
        v12SendHandwritingCharacter('\x1b');
        return;
      }
    }

    const result =
      recognizeMode === '!?'
        ? recognizeSymbol(strokes)
        : recognizeMode === '123'
          ? await v87RecognizeDigit(strokes)
          : await v84RecognizeLower(strokes);

    if (!result) {
      handwritingLabel.textContent =
        aiReady ? 'recognition ?' : 'AI not ready';
      return;
    }

    const pct = Math.round(result.probability * 100);



    // V8.9 - Ctrl handwriting mode
    //
    // Ctrl+A ... Ctrl+Z are ASCII 0x01 ... 0x1A.
    // Recognition itself uses the already-tested lowercase V13 pipeline.
    let outputCharacter;

    if (recognizeMode === 'A') {
      outputCharacter = result.character.toUpperCase();

    } else if (recognizeMode === 'Ctrl') {
      const lower = result.character.toLowerCase();
      const code = lower.charCodeAt(0) - 96;



      if (code < 1 || code > 26) {
        handwritingLabel.textContent = 'Ctrl ?';
        return;
      }

      outputCharacter = String.fromCharCode(code);

    } else {
      outputCharacter = result.character;
    }

    const displayCharacter =
      recognizeMode === 'Ctrl'
        ? 'Ctrl-' + result.character.toUpperCase()
        : outputCharacter;

    handwritingLabel.textContent =
      displayCharacter + ' ' + pct + '%';

    console.log(
      'V8.4:',
      result.character,
      pct + '%',
      result.top3
    );

    const sendThreshold =
      recognizeMode === '!?' ? SYMBOL_SEND_THRESHOLD : SEND_THRESHOLD;

    if (
      result.probability >= sendThreshold &&
      activeResolver
    ) {
      v12SendHandwritingCharacter(outputCharacter);
    }
  } catch (err) {
    console.error(err);
    handwritingLabel.textContent = 'recognition error';
  } finally {
    // V8.4.3:
    // One character is complete. Clear only its strokes.
    // Keep handwriting mode active until the left mode button is released.
    if (handwritingMode) {
      clearHandwriting();
      v84StrokeList = [];
      v84CurrentStroke = [];
    }
  }
}

loadV84AIModel();


// ============================================================
// V8.9 - Ctrl handwriting mode
// Hold Ctrl + write lowercase a-z -> send ASCII Ctrl+A ... Ctrl+Z
// ============================================================

// V13 direction behaviour:
// short press = normal direction (h/j/k/l/y/u/b/n)
// long press  = uppercase direction (H/J/K/L/Y/U/B/N)

// V8.3 mode-button hold -> handwriting surface
const V83_MODE_LABELS = new Set(['a', 'A', '!?', '123', 'Ctrl']);

const v83ModeButtons = [...document.querySelectorAll('button')]
  .filter(b => V83_MODE_LABELS.has(b.textContent.trim()));

v83ModeButtons.forEach(button => {
  const mode = button.textContent.trim();

  button.style.touchAction = 'none';

  button.addEventListener('pointerdown', ev => {
    ev.preventDefault();

    button.classList.add('pressed');
    beginHandwritingMode(mode);

    try {
      button.setPointerCapture(ev.pointerId);
    } catch (_) {}
  });

  const releaseMode = ev => {
    if (handwritingMode !== mode) return;

    ev.preventDefault();
    button.classList.remove('pressed');
    endHandwritingMode();
  };

  button.addEventListener('pointerup', releaseMode);
  button.addEventListener('pointercancel', releaseMode);
  button.addEventListener('contextmenu', ev => ev.preventDefault());
});


const LONG_PRESS_MS = 450;
let movePress = null;

function finishMovePress(button, longPress) {
  if (!button || !activeResolver) return;
  const key = button.dataset.key;

  restoreDungeonToPlayerBeforeInput();

  // Center "." has no uppercase meaning.
  activeResolver.respond(longPress && key !== '.' ? key.toUpperCase() : key);
}

movePad.querySelectorAll('.move-btn').forEach(button => {
  button.addEventListener('pointerdown', ev => {
    ev.preventDefault();

    if (movePress) {
      clearTimeout(movePress.timer);
      movePress = null;
    }

    button.classList.add('pressed');

    const state = {
      button,
      pointerId: ev.pointerId,
      longFired: false,
      timer: null
    };

    state.timer = setTimeout(() => {
      if (movePress !== state) return;
      state.longFired = true;
      finishMovePress(button, true);
      if (navigator.vibrate) navigator.vibrate(20);
    }, LONG_PRESS_MS);

    movePress = state;

    try { button.setPointerCapture(ev.pointerId); } catch (_) {}
  });

  button.addEventListener('pointerup', ev => {
    const state = movePress;
    if (!state || state.button !== button) return;

    clearTimeout(state.timer);
    button.classList.remove('pressed');

    if (!state.longFired) {
      finishMovePress(button, false);
    }

    movePress = null;
  });

  button.addEventListener('pointercancel', () => {
    const state = movePress;
    if (!state || state.button !== button) return;

    clearTimeout(state.timer);
    button.classList.remove('pressed');
    movePress = null;
  });

  button.addEventListener('contextmenu', ev => ev.preventDefault());
});

// V8.4.2
// Old V8 handwriting implementation removed.
// V8.3/V8.4 handwritingCanvas is now the single handwriting path.

// V12 build 2-1a - Common Menu Renderer skeleton.
// Definition only. Not connected to select_menu yet.
let v12MenuOverlay = null;

function v12CloseMenu() {
  if (v12MenuOverlay) {
    v12MenuOverlay.remove();
    v12MenuOverlay = null;
  }
}

function v12MenuAccelerator(item) {
  const value = item && item.accelerator;

  if (
    value === undefined ||
    value === null ||
    value === 0 ||
    value === ''
  ) {
    return '';
  }

  if (typeof value === 'number') {
    if (value >= 32 && value <= 126) {
      return String.fromCharCode(value);
    }
    return '';
  }

  return String(value);
}


// V12 build 2-1b - PICK_NONE read-only menu.
function v12ShowReadOnlyMenu(data) {
  v12CloseMenu();
  clearActions();

  const items = data.menuItems || data.items || [];

  const overlay = document.createElement('div');
  v12MenuOverlay = overlay;

  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '9000',
    background: 'rgba(0,0,0,.72)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '3vh 4vw',
    boxSizing: 'border-box'
  });

  const panel = document.createElement('div');
  Object.assign(panel.style, {
    width: 'min(900px, 90vw)',
    maxHeight: '88vh',
    display: 'flex',
    flexDirection: 'column',
    background: 'rgba(8,8,8,.97)',
    color: '#ddd',
    border: '1px solid rgba(255,255,255,.35)',
    borderRadius: '12px',
    boxSizing: 'border-box',
    fontFamily: 'Menlo, ui-monospace, monospace'
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '10px 12px',
    borderBottom: '1px solid rgba(255,255,255,.2)',
    flex: '0 0 auto'
  });

  const title = document.createElement('div');
  title.textContent =
    data.prompt && String(data.prompt).trim()
      ? String(data.prompt)
      : 'Menu';

  Object.assign(title.style, {
    flex: '1',
    fontSize: '17px',
    fontWeight: '600'
  });

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';

  Object.assign(close.style, {
    minWidth: '76px',
    minHeight: '40px',
    fontFamily: 'inherit',
    fontSize: '15px'
  });

  const body = document.createElement('div');
  Object.assign(body.style, {
    overflowY: 'auto',
    WebkitOverflowScrolling: 'touch',
    padding: '6px 10px 14px',
    flex: '1 1 auto'
  });

  function finish() {
    v12CloseMenu();
    if (data.resolver) {
      data.resolver.respond(0);
    }
  }

  close.addEventListener('click', finish);

  items.forEach(item => {
    const row = document.createElement('div');

    const selectable =
      item &&
      item.identifier !== undefined &&
      item.identifier !== null &&
      item.identifier !== 0;

    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'flex-start',
      gap: '10px',
      padding: selectable ? '7px 8px' : '11px 8px 5px',
      color: selectable ? '#ddd' : '#9bd49b',
      fontSize: selectable ? '15px' : '14px',
      fontWeight: selectable ? '400' : '600',
      borderBottom: selectable
        ? 'none'
        : '1px solid rgba(255,255,255,.08)'
    });

    const accelerator = document.createElement('span');
    accelerator.textContent = selectable
      ? v12MenuAccelerator(item)
      : '';

    Object.assign(accelerator.style, {
      flex: '0 0 25px',
      textAlign: 'center',
      color: '#f0d878',
      fontWeight: '600'
    });

    const description = document.createElement('span');
    description.textContent =
      item && item.str ? String(item.str) : '';

    Object.assign(description.style, {
      flex: '1',
      whiteSpace: 'normal',
      overflowWrap: 'anywhere'
    });

    row.appendChild(accelerator);
    row.appendChild(description);
    body.appendChild(row);
  });

  header.appendChild(title);
  header.appendChild(close);
  panel.appendChild(header);
  panel.appendChild(body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}



// V12 build 2-1c - PICK_ONE menu.
function v12ShowPickOneMenu(data) {
  v12CloseMenu();
  clearActions();

  const items = data.menuItems || data.items || [];

  const overlay = document.createElement('div');
  v12MenuOverlay = overlay;

  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '9000',
    background: 'rgba(0,0,0,.72)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '3vh 4vw',
    boxSizing: 'border-box'
  });

  const panel = document.createElement('div');
  Object.assign(panel.style, {
    width: 'min(900px, 90vw)',
    maxHeight: '88vh',
    display: 'flex',
    flexDirection: 'column',
    background: 'rgba(8,8,8,.97)',
    color: '#ddd',
    border: '1px solid rgba(255,255,255,.35)',
    borderRadius: '12px',
    boxSizing: 'border-box',
    fontFamily: 'Menlo, ui-monospace, monospace'
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '10px 12px',
    borderBottom: '1px solid rgba(255,255,255,.2)',
    flex: '0 0 auto'
  });

  const title = document.createElement('div');
  title.textContent =
    data.prompt && String(data.prompt).trim()
      ? String(data.prompt)
      : 'Menu';

  Object.assign(title.style, {
    flex: '1',
    fontSize: '17px',
    fontWeight: '600'
  });

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';

  Object.assign(close.style, {
    minWidth: '76px',
    minHeight: '40px',
    fontFamily: 'inherit',
    fontSize: '15px'
  });

  const body = document.createElement('div');
  Object.assign(body.style, {
    overflowY: 'auto',
    WebkitOverflowScrolling: 'touch',
    padding: '6px 10px 14px',
    flex: '1 1 auto',
    minHeight: '0',
    touchAction: 'none'
  });

  // V12 build 2-4b - deterministic touch scroll for PICK_ONE.
  let v12TouchY = null;

  body.addEventListener('touchstart', ev => {
    if (ev.touches.length !== 1) return;
    v12TouchY = ev.touches[0].clientY;
  }, { passive: true });

  body.addEventListener('touchmove', ev => {
    if (v12TouchY === null || ev.touches.length !== 1) return;

    const y = ev.touches[0].clientY;
    const dy = v12TouchY - y;

    body.scrollTop += dy;
    v12TouchY = y;

    ev.preventDefault();
  }, { passive: false });

  body.addEventListener('touchend', () => {
    v12TouchY = null;
  }, { passive: true });

  body.addEventListener('touchcancel', () => {
    v12TouchY = null;
  }, { passive: true });

  function finish(value) {
    // Persist only the primary NetHack symbol-set menu choice.  Other PICK_ONE
    // menus keep their existing behavior and are not treated as preferences.
    rememberSymbolSetMenuChoice(data, value);
    v12CloseMenu();
    if (data.resolver) {
      data.resolver.respond(value);
    }
  }

  close.addEventListener('click', () => finish(0));

  items.forEach(item => {
    const selectable =
      item &&
      item.identifier !== undefined &&
      item.identifier !== null &&
      item.identifier !== 0;

    const row = document.createElement(selectable ? 'button' : 'div');

    if (selectable) {
      row.type = 'button';
    }

    Object.assign(row.style, {
      width: '100%',
      minHeight: selectable ? '44px' : 'auto',
      display: 'flex',
      alignItems: 'flex-start',
      gap: '10px',
      padding: selectable ? '9px 10px' : '11px 8px 5px',
      margin: selectable ? '2px 0' : '0',
      boxSizing: 'border-box',
      textAlign: 'left',
      color: selectable ? '#ddd' : '#9bd49b',
      background: selectable
        ? 'rgba(255,255,255,.04)'
        : 'transparent',
      border: selectable
        ? '1px solid rgba(255,255,255,.12)'
        : '0',
      borderBottom: selectable
        ? '1px solid rgba(255,255,255,.12)'
        : '1px solid rgba(255,255,255,.08)',
      borderRadius: selectable ? '7px' : '0',
      fontFamily: 'inherit',
      fontSize: selectable ? '15px' : '14px',
      fontWeight: selectable ? '400' : '600'
    });

    const accelerator = document.createElement('span');
    accelerator.textContent = selectable
      ? v12MenuAccelerator(item)
      : '';

    Object.assign(accelerator.style, {
      flex: '0 0 25px',
      textAlign: 'center',
      color: '#f0d878',
      fontWeight: '600'
    });

    const description = document.createElement('span');
    description.textContent =
      item && item.str ? String(item.str) : '';

    Object.assign(description.style, {
      flex: '1',
      whiteSpace: 'normal',
      overflowWrap: 'anywhere'
    });

    row.appendChild(accelerator);
    row.appendChild(description);

    if (selectable) {
      row.addEventListener('click', () => finish(item));
    }

    body.appendChild(row);
  });

  header.appendChild(title);
  header.appendChild(close);
  panel.appendChild(header);
  panel.appendChild(body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}



// V12 build 2-1d - PICK_ANY menu.
function v12ShowPickAnyMenu(data) {
  v12CloseMenu();
  clearActions();

  const items = data.menuItems || data.items || [];
  const selectedItems = new Set();

  const overlay = document.createElement('div');
  v12MenuOverlay = overlay;

  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '9000',
    background: 'rgba(0,0,0,.72)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '3vh 4vw',
    boxSizing: 'border-box'
  });

  const panel = document.createElement('div');
  Object.assign(panel.style, {
    width: 'min(900px, 90vw)',
    maxHeight: '88vh',
    display: 'flex',
    flexDirection: 'column',
    background: 'rgba(8,8,8,.97)',
    color: '#ddd',
    border: '1px solid rgba(255,255,255,.35)',
    borderRadius: '12px',
    boxSizing: 'border-box',
    fontFamily: 'Menlo, ui-monospace, monospace'
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 12px',
    borderBottom: '1px solid rgba(255,255,255,.2)',
    flex: '0 0 auto'
  });

  const title = document.createElement('div');
  title.textContent =
    data.prompt && String(data.prompt).trim()
      ? String(data.prompt)
      : 'Menu';

  Object.assign(title.style, {
    flex: '1',
    fontSize: '17px',
    fontWeight: '600'
  });

  function makeHeaderButton(label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;

    Object.assign(button.style, {
      minWidth: '72px',
      minHeight: '40px',
      fontFamily: 'inherit',
      fontSize: '15px'
    });

    return button;
  }

  const cancel = makeHeaderButton('Cancel');
  const ok = makeHeaderButton('OK');

  const body = document.createElement('div');
  Object.assign(body.style, {
    overflowY: 'auto',
    WebkitOverflowScrolling: 'touch',
    padding: '6px 10px 14px',
    flex: '1 1 auto',
    minHeight: '0',
    touchAction: 'none'
  });

  // V12 build 2-4c - deterministic touch scroll for PICK_ANY.
  let v12TouchY = null;

  body.addEventListener('touchstart', ev => {
    if (ev.touches.length !== 1) return;
    v12TouchY = ev.touches[0].clientY;
  }, { passive: true });

  body.addEventListener('touchmove', ev => {
    if (v12TouchY === null || ev.touches.length !== 1) return;

    const y = ev.touches[0].clientY;
    const dy = v12TouchY - y;

    body.scrollTop += dy;
    v12TouchY = y;

    ev.preventDefault();
  }, { passive: false });

  body.addEventListener('touchend', () => {
    v12TouchY = null;
  }, { passive: true });

  body.addEventListener('touchcancel', () => {
    v12TouchY = null;
  }, { passive: true });

  function finish(value) {
    v12CloseMenu();
    if (data.resolver) {
      data.resolver.respond(value);
    }
  }

  cancel.addEventListener('click', () => finish(0));

  ok.addEventListener('click', () => {
    finish(Array.from(selectedItems));
  });

  items.forEach(item => {
    const selectable =
      item &&
      item.identifier !== undefined &&
      item.identifier !== null &&
      item.identifier !== 0;

    if (!selectable) {
      const heading = document.createElement('div');
      heading.textContent =
        item && item.str ? String(item.str) : '';

      Object.assign(heading.style, {
        padding: '11px 8px 5px',
        fontSize: '14px',
        fontWeight: '600',
        color: '#9bd49b',
        borderBottom: '1px solid rgba(255,255,255,.08)'
      });

      body.appendChild(heading);
      return;
    }

    const row = document.createElement('button');
    row.type = 'button';

    Object.assign(row.style, {
      width: '100%',
      minHeight: '44px',
      display: 'flex',
      alignItems: 'flex-start',
      gap: '10px',
      padding: '9px 10px',
      margin: '2px 0',
      boxSizing: 'border-box',
      textAlign: 'left',
      color: '#ddd',
      background: 'rgba(255,255,255,.04)',
      border: '1px solid rgba(255,255,255,.12)',
      borderRadius: '7px',
      fontFamily: 'inherit',
      fontSize: '15px'
    });

    const mark = document.createElement('span');
    mark.textContent = '☐';

    Object.assign(mark.style, {
      flex: '0 0 22px',
      textAlign: 'center'
    });

    const accelerator = document.createElement('span');
    accelerator.textContent = v12MenuAccelerator(item);

    Object.assign(accelerator.style, {
      flex: '0 0 25px',
      textAlign: 'center',
      color: '#f0d878',
      fontWeight: '600'
    });

    const description = document.createElement('span');
    description.textContent =
      item.str ? String(item.str) : '';

    Object.assign(description.style, {
      flex: '1',
      whiteSpace: 'normal',
      overflowWrap: 'anywhere'
    });

    row.appendChild(mark);
    row.appendChild(accelerator);
    row.appendChild(description);

    row.addEventListener('click', () => {
      if (selectedItems.has(item)) {
        selectedItems.delete(item);
        mark.textContent = '☐';
        row.style.background = 'rgba(255,255,255,.04)';
      } else {
        selectedItems.add(item);
        mark.textContent = '☑';
        row.style.background = 'rgba(255,255,255,.12)';
      }
    });

    body.appendChild(row);
  });

  header.appendChild(title);
  header.appendChild(cancel);
  header.appendChild(ok);
  panel.appendChild(header);
  panel.appendChild(body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}


const bridge = new NetHackWasmWorkerBridge('../../src/driver/nethack.worker.js');

bridge.on('inputRequired', data => {
  clearActions();
  setResolver(data.resolver);

  // V12 build 2-6a - NetHack-native character choice.
  // NetHack shows the valid choices in the message itself.
  // The user answers through the normal handwriting input.
  if (data.context === 'yn_function') {
    showMessage(data.question || data.query || '');
    return;
  }

  // V12 build 2-3e - Extended command deterministic touch scroll.
  if (data.context === 'get_ext_cmd') {
    v12CloseMenu();
    clearActions();

    const commands = [
      '#', '?', 'adjust', 'annotate', 'apply', 'attributes', 'autopickup',
      'call', 'cast', 'chat', 'chronicle', 'close', 'conduct', 'debugfuzzer',
      'dip', 'down', 'drop', 'droptype', 'eat', 'engrave', 'enhance',
      'exploremode', 'fight', 'fire', 'force', 'genocided', 'glance',
      'help', 'herecmdmenu', 'history', 'inventory', 'inventtype',
      'invoke', 'jump', 'kick', 'known', 'knownclass', 'levelchange',
      'lightsources', 'look', 'lookaround', 'loot', 'migratemons',
      'monster', 'name', 'offer', 'open', 'options', 'optionsfull',
      'overview', 'panic', 'pay', 'perminv', 'pickup', 'polyself',
      'pray', 'prevmsg', 'puton', 'quaff', 'quit', 'quiver', 'read',
      'redraw', 'remove', 'repeat', 'reqmenu', 'retravel', 'ride',
      'rub', 'run', 'rush', 'save', 'saveoptions', 'search', 'seeall',
      'seeamulet', 'seearmor', 'seerings', 'seetools', 'seeweapon',
      'shell', 'showgold', 'showspells', 'showtrap', 'sit', 'stats',
      'suspend', 'swap', 'takeoff', 'takeoffall', 'teleport', 'terrain',
      'therecmdmenu', 'throw', 'timeout', 'tip', 'toggle', 'travel',
      'turn', 'twoweapon', 'untrap', 'up', 'vanquished', 'version',
      'versionshort', 'vision', 'wait', 'wear', 'whatdoes', 'whatis',
      'wield', 'wipe'
    ];

    const overlay = document.createElement('div');
    v12MenuOverlay = overlay;

    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '9000',
      background: 'rgba(0,0,0,.72)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '3vh 4vw',
      boxSizing: 'border-box'
    });

    const panel = document.createElement('div');

    Object.assign(panel.style, {
      width: 'min(900px, 90vw)',
      maxHeight: '88vh',
      display: 'flex',
      flexDirection: 'column',
      background: 'rgba(8,8,8,.97)',
      color: '#ddd',
      border: '1px solid rgba(255,255,255,.35)',
      borderRadius: '12px',
      boxSizing: 'border-box',
      overflow: 'hidden',
      fontFamily: 'Menlo, ui-monospace, monospace'
    });

    const header = document.createElement('div');

    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '10px 12px',
      borderBottom: '1px solid rgba(255,255,255,.2)',
      flex: '0 0 auto'
    });

    const title = document.createElement('div');
    title.textContent = 'Extended Command';

    Object.assign(title.style, {
      flex: '1',
      fontSize: '17px',
      fontWeight: '600'
    });

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';

    Object.assign(cancel.style, {
      minWidth: '72px',
      minHeight: '40px',
      fontFamily: 'inherit',
      fontSize: '15px'
    });

    const body = document.createElement('div');

    Object.assign(body.style, {
      overflowY: 'auto',
      WebkitOverflowScrolling: 'touch',
      minHeight: '0',
      padding: '8px 10px 14px',
      flex: '1 1 auto'
    });

    // V12 build 2-3e - deterministic touch scrolling test.
    // Do not depend on Safari starting native scrolling reliably.
    let v12TouchY = null;
    let v12TouchMoved = false;

    body.style.touchAction = 'none';

    body.addEventListener('touchstart', ev => {
      if (ev.touches.length !== 1) return;
      v12TouchY = ev.touches[0].clientY;
      v12TouchMoved = false;
    }, { passive: true });

    body.addEventListener('touchmove', ev => {
      if (v12TouchY === null || ev.touches.length !== 1) return;

      const y = ev.touches[0].clientY;
      const dy = v12TouchY - y;

      if (Math.abs(dy) > 2) {
        v12TouchMoved = true;
      }

      body.scrollTop += dy;
      v12TouchY = y;

      ev.preventDefault();
    }, { passive: false });

    body.addEventListener('touchend', () => {
      v12TouchY = null;
    }, { passive: true });

    body.addEventListener('touchcancel', () => {
      v12TouchY = null;
    }, { passive: true });

    cancel.addEventListener('click', () => {
      v12CloseMenu();
      if (data.resolver) {
        if (typeof data.resolver.cancel === 'function') {
          data.resolver.cancel(-1);
        } else {
          data.resolver.respond(-1);
        }
      }
    });

    commands.forEach(command => {
      const row = document.createElement('button');
      row.type = 'button';

      row.textContent =
        command === '#' || command === '?'
          ? command
          : '#' + command;

      Object.assign(row.style, {
        width: '100%',
        minHeight: '42px',
        display: 'block',
        padding: '8px 12px',
        margin: '2px 0',
        boxSizing: 'border-box',
        textAlign: 'left',
        color: '#ddd',
        background: 'rgba(255,255,255,.04)',
        border: '1px solid rgba(255,255,255,.12)',
        borderRadius: '7px',
        fontFamily: 'inherit',
        fontSize: '15px'
      });

      row.addEventListener('click', () => {
        v12CloseMenu();
        if (data.resolver) {
          data.resolver.respond(command);
        }
      });

      body.appendChild(row);
    });

    header.appendChild(title);
    header.appendChild(cancel);
    panel.appendChild(header);
    panel.appendChild(body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    return;
  }

  if (data.context === 'select_menu') {
    // V12 build 2-1b: PICK_NONE only.
    if (Number(data.how) === 0) {
      v12ShowReadOnlyMenu(data);
      return;
    }

    // V12 build 2-1c: PICK_ONE.
    if (Number(data.how) === 1) {
      v12ShowPickOneMenu(data);
      return;
    }

    // V12 build 2-1d: PICK_ANY.
    if (Number(data.how) === 2) {
      v12ShowPickAnyMenu(data);
      return;
    }

    if (data.prompt) showMessage(data.prompt);
    const items = (data.menuItems || data.items || [])
      .filter(item => item.identifier && item.identifier !== 0);
    items.forEach(item => {
      const label = item.str || item.accelerator || String(item.identifier);
      addAction(label, () => data.resolver.respond(item));
    });
    if (!items.length) showMessage('[menu has no selectable items]');
    return;
  }

  // V12 build 2-6c - getlin uses the existing handwriting UI.
  if (data.context === 'getlin') {
    v12GetlinActive = true;
    v12GetlinBuffer = '';
    v12GetlinPrompt = data.prompt || data.query || '';
    v12GetlinMessageBase = messages.textContent || '';
    v12RenderGetlin();
    return;
  }

  if (data.context === 'poskey' || data.context === 'getch') return;
  showMessage('[inputRequired: ' + data.context + ']');
});

bridge.on('putstr', data => {
  if (data.text && data.text.trim()) showMessage(data.text);
});
bridge.on('raw_print', data => { if (data.text) showMessage(data.text); });
bridge.on('raw_print_bold', data => { if (data.text) showMessage(data.text); });

bridge.on('clear_nhwindow', data => {
  if (!data || dungeonWindowId === null || data.windowId !== dungeonWindowId) return;

  for (let y = 0; y < MAP_H; y++) {
    dungeon[y].fill(' ');
    dungeonColor[y].fill(7);
    dungeonGlyph[y].fill(null);
  }
  renderMap();
});

// V18 render batching: print_glyph can arrive many times for one NetHack
// action. Rebuilding the fixed-cell DOM after every glyph can expose
// intermediate dungeon states in Safari. Coalesce those updates into one
// render per browser animation frame.
let dungeonRenderFrame = null;
function scheduleDungeonRender() {
  if (dungeonRenderFrame !== null) return;
  dungeonRenderFrame = requestAnimationFrame(() => {
    dungeonRenderFrame = null;
    renderMap();
  });
}

bridge.on('print_glyph', data => {
  const {windowId, x, y, glyphInfo} = data;

  if (windowId !== undefined && windowId !== null) {
    dungeonWindowId = windowId;
  }

  if (x < 0 || x >= MAP_W || y < 0 || y >= MAP_H || !glyphInfo) return;
  // V18 build 1: use NetHack's native character representation for the
  // entire ASCII dungeon. parseGlyphInfo() already falls back to ttychar
  // when no Unicode representation is supplied by NetHack.
  dungeon[y][x] = nativeDungeonChar(glyphInfo);
  dungeonColor[y][x] =
    Number.isInteger(glyphInfo.color) ? glyphInfo.color : 7;

  // V11-03: preserve NetHack's native glyph for tile rendering.
  dungeonGlyph[y][x] = glyphInfo.glyph;

  // Keep the V7 behavior of rendering from print_glyph, but batch the
  // potentially many glyph updates from one action into a single frame.
  scheduleDungeonRender();
});

bridge.on('display_nhwindow', data => {
  renderMap();

  // V12 build 2-5d - Safari UI renders no separate blocking
  // display window here, so acknowledge it immediately.
  // Actual interactive menus are handled by select_menu.
  if (data.resolver) {
    data.resolver.respond(0);
  }
});

// NetHack 5.0 status field IDs, aligned with the original
// Nethack-wasm-webUI StatusAccessor.
const BL = {
  TITLE: 0, STR: 1, DEX: 2, CON: 3, INT: 4, WIS: 5, CHA: 6,
  ALIGN: 7, SCORE: 8, CAP: 9, GOLD: 10, ENE: 11, ENEMAX: 12,
  XP: 13, AC: 14, TIME: 16, HUNGER: 17, HP: 18, HPMAX: 19,
  DLEVEL: 20, EXP: 21, CONDITION: 22
};

const statusFields = {};

function statusValue(field, fallback = '?') {
  const value = statusFields[field];
  return value === undefined || value === null ? fallback : value;
}

// BL_GOLD may arrive as a glyph-prefixed string such as "\\G...:19".
// Match the original Nethack-wasm-webUI StatusAccessor and display only
// the numeric amount after the final colon.
function statusGoldAmount() {
  const rawGold = statusFields[BL.GOLD];

  if (rawGold && typeof rawGold === 'object') {
    if (rawGold.amount !== undefined) {
      return parseInt(rawGold.amount, 10) || 0;
    }
    if (rawGold.goldData && rawGold.goldData.amount !== undefined) {
      return parseInt(rawGold.goldData.amount, 10) || 0;
    }
    if (rawGold.value !== undefined) {
      const parts = String(rawGold.value).split(':');
      return parseInt(parts[parts.length - 1], 10) || 0;
    }
  }

  if (typeof rawGold === 'string') {
    const parts = rawGold.split(':');
    return parseInt(parts[parts.length - 1], 10) || 0;
  }

  if (typeof rawGold === 'number') {
    return rawGold;
  }

  return 0;
}

function renderStatus() {
  const name = statusValue(BL.TITLE, '');
  const stats =
    'St:' + statusValue(BL.STR) +
    ' Dx:' + statusValue(BL.DEX) +
    ' Co:' + statusValue(BL.CON) +
    ' In:' + statusValue(BL.INT) +
    ' Wi:' + statusValue(BL.WIS) +
    ' Ch:' + statusValue(BL.CHA) +
    ' ' + statusValue(BL.ALIGN, '');

  const primary =
    statusValue(BL.DLEVEL, '') +
    '  $:' + statusGoldAmount() +
    '  HP:' + statusValue(BL.HP) + '(' + statusValue(BL.HPMAX) + ')' +
    '  Pw:' + statusValue(BL.ENE) + '(' + statusValue(BL.ENEMAX) + ')' +
    '  AC:' + statusValue(BL.AC) +
    '  Xp:' + statusValue(BL.XP);

  const extras = [];
  const hunger = statusValue(BL.HUNGER, '');
  const cap = statusValue(BL.CAP, '');
  const condition = statusValue(BL.CONDITION, '');

  if (String(hunger).trim()) extras.push(String(hunger).trim());
  if (String(cap).trim()) extras.push(String(cap).trim());
  if (String(condition).trim()) extras.push(String(condition).trim());

  if (isLandscape()) {
    status.textContent =
      name + '\n' +
      'St:' + statusValue(BL.STR) + ' Dx:' + statusValue(BL.DEX) + '\n' +
      'Co:' + statusValue(BL.CON) + ' In:' + statusValue(BL.INT) + '\n' +
      'Wi:' + statusValue(BL.WIS) + ' Ch:' + statusValue(BL.CHA) + '\n' +
      statusValue(BL.ALIGN, '') + '\n' +
      statusValue(BL.DLEVEL, '') + '\n' +
      '$:' + statusGoldAmount() + '\n' +
      'HP:' + statusValue(BL.HP) + '(' + statusValue(BL.HPMAX) + ')\n' +
      'Pw:' + statusValue(BL.ENE) + '(' + statusValue(BL.ENEMAX) + ')\n' +
      'AC:' + statusValue(BL.AC) + '\n' +
      'Xp:' + statusValue(BL.XP) +
      (extras.length ? '\n' + extras.join(' ') : '');
  } else {
    status.textContent =
      name + '\n' + stats + '\n' + primary +
      (extras.length ? '\n' + extras.join(' ') : '');
  }
}

bridge.on('status_update', data => {
  if (data.fld < 0) return;
  statusFields[data.fld] = data.value;
  renderStatus();
});
bridge.on('error', data => showMessage('ERROR: ' + JSON.stringify(data)));

// V10-05-1: NetHack engine exit / update screen
function showExitActions() {
  clearActions();

  addPersistentAction('RESTART NETHACK', () => {
    location.reload();
  });

  let nextDungeonDisplay = loadDungeonDisplayPreference();

  addPersistentAction(
    'DUNGEON: ' + nextDungeonDisplay.toUpperCase(),
    async () => {
      const newMode =
        nextDungeonDisplay === DUNGEON_DISPLAY_ASCII
          ? DUNGEON_DISPLAY_TILE
          : DUNGEON_DISPLAY_ASCII;

      if (!saveDungeonDisplayPreference(newMode)) {
        showMessage('[Dungeon display setting could not be saved]');
        return;
      }

      nextDungeonDisplay = newMode;
      showMessage(
        '[Dungeon display after restart: ' +
        nextDungeonDisplay.toUpperCase() + ']'
      );

      // Rebuild the exit actions so the button label shows the saved mode.
      // activeDungeonDisplay intentionally remains unchanged until reload.
      showExitActions();
    }
  );

  addPersistentAction('CHECK UPDATE', async () => {
    showMessage('[Checking for update...]');

    const info = await checkForUpdate();

    if (!info) {
      showMessage(
        '[Update check failed - current Stable remains available]'
      );
      return;
    }

    if (info.build > APP_BUILD) {
      showMessage(
        '[New version available: ' +
        info.version + ']'
      );

      showExitActions();
    } else {
      showMessage(
        '[Current version is latest: ' +
        APP_VERSION + ']'
      );
    }
  });

  if (
    latestVersionInfo &&
    latestVersionInfo.build > APP_BUILD
  ) {
    addPersistentAction('UPDATE NETHACK', async () => {
      const info = latestVersionInfo;

      showMessage(
        '[Update download started: ' +
        info.version + ']'
      );

      try {
        const cacheName = await downloadUpdate(info);

        preparedUpdateCache = cacheName;

        showMessage(
          '[Update downloaded successfully]'
        );

        showMessage(
          '[Prepared cache: ' + cacheName + ']'
        );

        showExitActions();

        showMessage(
          '[Current version has NOT been changed]'
        );

      } catch (err) {
        console.error('[NetHack Update]', err);

        showMessage(
          '[Update download failed]'
        );

        showMessage(
          '[Current Stable remains unchanged]'
        );
      }
    });
  }

  addPersistentAction('UPDATE STATE', async () => {
    showMessage('[Reading update state...]');

    try {
      const state = await getUpdateState();

      showMessage(
        '[SW: ' + state.swCache + ']'
      );

      showMessage(
        '[ACTIVE: ' + state.activeCache + ']'
      );

      showMessage(
        '[PREVIOUS: ' +
        (state.previousCache || 'none') + ']'
      );

    } catch (err) {
      console.error('[NetHack Update State]', err);
      showMessage('[Update state read failed]');
    }
  });

  addPersistentAction('ROLLBACK', async () => {
    showMessage('[Rollback requested]');

    try {
      const result = await rollbackUpdate();

      showMessage(
        '[Rollback selected: ' +
        result.cacheName + ']'
      );

      showMessage(
        '[Rollback applied - restarting...]'
      );

      setTimeout(() => {
        location.reload();
      }, 500);

    } catch (err) {
      console.error('[NetHack Rollback]', err);

      showMessage('[Rollback failed]');
      showMessage('[Current version remains unchanged]');
    }
  });

  if (preparedUpdateCache) {
    addPersistentAction('APPLY UPDATE', async () => {
      showMessage(
        '[Applying update: ' +
        preparedUpdateCache + ']'
      );

      try {
        await applyPreparedUpdate(
          preparedUpdateCache
        );

        showMessage(
          '[Update applied - restarting...]'
        );

        setTimeout(() => {
          location.reload();
        }, 500);

      } catch (err) {
        console.error('[NetHack Apply Update]', err);

        showMessage(
          '[Update apply failed]'
        );

        showMessage(
          '[Current Stable remains unchanged]'
        );
      }
    });
  }

  showMessage('[Version: ' + APP_VERSION + ']');

  if (
    latestVersionInfo &&
    latestVersionInfo.build > APP_BUILD
  ) {
    showMessage(
      '[New version available: ' +
      latestVersionInfo.version + ']'
    );
  }
}

bridge.on('exited', data => {
  showExitActions();
});

bridge.once('initialized', () => {
  showMessage('WASM initialized');
  bridge.keyMode = 'vi';
  bridge.start();
});
const startupSymbolSet = loadSymbolSetPreference();
const bridgeInitOptions = {arguments:['-u','Hero']};
if (startupSymbolSet && startupSymbolSet !== SYMBOL_SET_DEFAULT) {
  bridgeInitOptions.extraOptions = `OPTIONS=symset:${startupSymbolSet}`;
}
bridge.init('nethack.js', bridgeInitOptions);

// V10-04-1: silent automatic update check.
// Failure must never prevent NetHack from starting.
autoCheckForUpdate();

function applyOrientation() {
  const landscape = isLandscape();
  document.body.dataset.orientation = landscape ? 'landscape' : 'portrait';
  renderStatus();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (handwritingMode) resizeHandwritingCanvas();
    renderMap();
  }));
}

let orientationTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(orientationTimer);
  orientationTimer = setTimeout(applyOrientation, 120);
});
window.addEventListener('orientationchange', () => {
  clearTimeout(orientationTimer);
  orientationTimer = setTimeout(applyOrientation, 180);
});

applyOrientation();
renderMap();
