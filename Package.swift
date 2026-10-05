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
            resources: [.copy("Resources")]
        )
    ]
)
