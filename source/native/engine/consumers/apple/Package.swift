// swift-tools-version: 5.9
import PackageDescription
import Foundation

let sdk = ProcessInfo.processInfo.environment["TBC_ENGINE_SDK_PATH"]!
let package = Package(
    name: "NativeEngineConsumer", platforms: [.iOS("15.1")],
    products: [.library(name: "NativeEngineConsumer", type: .dynamic, targets: ["NativeEngineConsumer"])],
    dependencies: [.package(name: "TbcEngine", path: sdk)],
    targets: [.target(name: "NativeEngineConsumer", dependencies: [.product(name: "TbcEngine", package: "TbcEngine")])]
)
