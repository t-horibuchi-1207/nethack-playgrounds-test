importScripts("helper.js");

self.onmessage = async function(event) {
    try {
        const response = await fetch("test.wasm");
        const bytes = await response.arrayBuffer();
        await WebAssembly.instantiate(bytes);
        self.postMessage(self.helperMessage + " + WORKER + WASM OK: " + bytes.byteLength + " bytes");
    } catch (e) {
        self.postMessage("ERROR: " + e);
    }
};
