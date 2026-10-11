import SwiftUI
import WebKit
import NetHackWebTest

// iPad Native PoC v1 reference.
// Verified on iPad with NetHack V19 Stable package resources.
// The diagnostic evaluateJavaScript used during investigation is intentionally omitted.
final class ResourceSchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(NSError(domain: "ResourceScheme", code: 1))
            return
        }

        var relativePath = url.path
        if relativePath.hasPrefix("/") {
            relativePath.removeFirst()
        }

        guard
            !relativePath.isEmpty,
            !relativePath.split(separator: "/").contains(".."),
            let resourceRoot = NetHackWebTestResources.bundle.resourceURL
        else {
            task.didFailWithError(NSError(domain: "ResourceScheme", code: 2))
            return
        }

        let fileURL = resourceRoot.appendingPathComponent(relativePath)
        guard let data = try? Data(contentsOf: fileURL) else {
            task.didFailWithError(NSError(
                domain: "ResourceScheme",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Resource not found: \(relativePath)"]
            ))
            return
        }

        let mimeType: String
        switch fileURL.pathExtension.lowercased() {
        case "html": mimeType = "text/html"
        case "js": mimeType = "application/javascript"
        case "wasm": mimeType = "application/wasm"
        case "json": mimeType = "application/json"
        case "png": mimeType = "image/png"
        case "bin": mimeType = "application/octet-stream"
        case "css": mimeType = "text/css"
        default: mimeType = "application/octet-stream"
        }

        // Important: TensorFlow.js rejected the non-HTTP URLResponse (status 0).
        // HTTPURLResponse with status 200 was verified to fix handwriting AI loading.
        guard let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": mimeType,
                "Content-Length": "\(data.count)"
            ]
        ) else {
            task.didFailWithError(NSError(domain: "ResourceScheme", code: 4))
            return
        }

        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

struct WebView: UIViewRepresentable {
    func makeCoordinator() -> ResourceSchemeHandler {
        ResourceSchemeHandler()
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(
            context.coordinator,
            forURLScheme: "nethackapp"
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        let url = URL(string:
            "nethackapp://local/v19/examples/nethack-iphone-min/index-dev.html"
        )!
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

struct ContentView: View {
    var body: some View {
        WebView().ignoresSafeArea()
    }
}
