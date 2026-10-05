importScripts("helper.js");
importScripts("sub/path-test.js");

self.onmessage = async function(event) {
    try {
        const response = await fetch("test.wasm");
        const bytes = await response.arrayBuffer();
        await WebAssembly.instantiate(bytes);
        self.postMessage(
            self.helperMessage +
            " + " +
            self.pathTestMessage +
            " + WORKER + WASM OK: " +
            bytes.byteLength +
            " bytes"
        );
    } catch (e) {
        self.postMessage("ERROR: " + e);
    }
};
