// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "NetHackWebTest",
    platforms: [.iOS(.v16)],
    products: [
        .library(name: "NetHackWebTest", targets: ["NetHackWebTest"])
    ],
    targets: [
        .target(
            name: "NetHackWebTest",
            resources: [
                .copy("Resources/v19"),
                .process("Resources/helper.js"),
                .process("Resources/test.html"),
                .process("Resources/test.js"),
                .process("Resources/test.wasm"),
                .process("Resources/worker.js"),
                .copy("Resources/sub")
            ]
        )
    ]
)
