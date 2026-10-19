// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "TbcSigner", platforms: [.iOS("15.1")],
    products: [.library(name: "TbcSigner", targets: ["TbcSigner"])],
    targets: [
        .binaryTarget(name: "TbcSignerKernel", path: "Artifacts/TbcSignerKernel.xcframework"),
        // local4 pairs this private bridge with a MuSig-enabled Rust artifact.
        .target(name: "TbcSigner", dependencies: ["TbcSignerKernel"],
                swiftSettings: [.define("TBC_SIGNER_MUSIG")])
    ])
