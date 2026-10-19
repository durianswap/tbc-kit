// swift-tools-version: 5.9
import PackageDescription
import Foundation

guard let sdk = ProcessInfo.processInfo.environment["TBC_ENGINE_SDK_PATH"] else {
    fatalError("Set TBC_ENGINE_SDK_PATH to the extracted SDK apple directory")
}
let package = Package(
    name: "TbcWalletStarter", platforms: [.iOS("15.1")],
    products: [.library(name: "TbcWalletStarter", type: .dynamic, targets: ["TbcWalletStarter"])],
    dependencies: [.package(name: "TbcEngine", path: sdk)],
    targets: [.target(name: "TbcWalletStarter", dependencies: [.product(name: "TbcEngine", package: "TbcEngine")])]
)
