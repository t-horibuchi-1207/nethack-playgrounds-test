/**
 * NetHack WASM Driver - Unified Entry Point (index.js)
 * NetHack 5.0 / 3.7 Wasm Core を JavaScript / WebUI / Headless App から利用するための汎用ドライバーライブラリ。
 */

import './NetHackMemory.js';
import './InputResolver.js';
import './NetHackFSManager.js';
import './NetHackWasmDriver.js';
import './NetHackWasmWorkerBridge.js';
import './tileMapping.js';

const scope = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : global);

export const NetHackMemory = scope.NetHackMemory;
export const InputResolver = scope.InputResolver;
export const NetHackFSManager = scope.NetHackFSManager;
export const NetHackWasmDriver = scope.NetHackWasmDriver;
export const NetHackWasmWorkerBridge = scope.NetHackWasmWorkerBridge;
export const NetHackTileMapping = scope.NetHackTileMapping;
export const getTileMapping = scope.NetHackTileMapping ? scope.NetHackTileMapping.getTileMapping : null;

export default {
    NetHackWasmDriver: scope.NetHackWasmDriver,
    NetHackWasmWorkerBridge: scope.NetHackWasmWorkerBridge,
    NetHackFSManager: scope.NetHackFSManager,
    NetHackMemory: scope.NetHackMemory,
    InputResolver: scope.InputResolver,
    NetHackTileMapping: scope.NetHackTileMapping
};

if (typeof scope !== 'undefined') {
    scope.NetHackWasmDriverLib = {
        NetHackWasmDriver: scope.NetHackWasmDriver,
        NetHackWasmWorkerBridge: scope.NetHackWasmWorkerBridge,
        NetHackFSManager: scope.NetHackFSManager,
        NetHackMemory: scope.NetHackMemory,
        InputResolver: scope.InputResolver,
        NetHackTileMapping: scope.NetHackTileMapping
    };
}

