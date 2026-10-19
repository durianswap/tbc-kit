import TbcSigner
public func publicFixtureSign() throws -> [UInt8] {
    var scalar = [UInt8](repeating: 0, count: 32); scalar[31] = 1
    defer { _ = scalar.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) } }
    return try scalar.withUnsafeBytes {
        try TbcDigestSigner.sign(digest: [UInt8](repeating: 1, count: 32), scalar: $0, encoding: .compact64)
    }
}
