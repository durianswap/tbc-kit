// swift-tools-version: 5.9
import PackageDescription
import Foundation
let package = Package(name: "SignerConsumer", platforms: [.iOS("15.1")],
    products: [.library(name: "SignerConsumer", type: .dynamic, targets: ["SignerConsumer"])],
    dependencies: [.package(name: "TbcSigner", path: ProcessInfo.processInfo.environment["TBC_SIGNER_SDK_PATH"]!)],
    targets: [.target(name: "SignerConsumer", dependencies: [.product(name: "TbcSigner", package: "TbcSigner")])])
