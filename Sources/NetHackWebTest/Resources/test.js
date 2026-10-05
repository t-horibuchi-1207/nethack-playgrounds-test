(async () => {
    const result = document.getElementById("result");
    try {
        result.innerText = "STARTING WORKER...";
        const worker = new Worker("worker.js");
        worker.onmessage = function(event) { result.innerText = event.data; };
        worker.onerror = function(event) { result.innerText = "WORKER ERROR: " + event.message; };
        worker.postMessage("HELLO");
    } catch (e) {
        result.innerText = "WORKER EXCEPTION: " + e;
    }
})();
