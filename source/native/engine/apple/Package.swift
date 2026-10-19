// swift-tools-version: 5.9
import PackageDescription

// Materialized beside the matching binary by prepare-native-engine.mjs.
let package = Package(
    name: "TbcEngine",
    platforms: [.iOS("15.1")],
    products: [.library(name: "TbcEngine", targets: ["TbcEngine"])],
    targets: [
        .binaryTarget(name: "TbcEngineNative", path: "Artifacts/TbcEngineNative.xcframework"),
        .target(name: "TbcEngine", dependencies: ["TbcEngineNative"])
    ]
)
