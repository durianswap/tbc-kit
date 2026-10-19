import Foundation
import TbcSigner

@main struct SwiftProbe {
    struct Vector: Decodable { let scalar: String; let digest: String; let compact64: String; let compact65: String }
    struct Fixture: Decodable { let vectors: [Vector] }
    static func bytes(_ hex: String) -> [UInt8] {
        stride(from: 0, to: hex.count, by: 2).map { i in
            let start = hex.index(hex.startIndex, offsetBy: i)
            return UInt8(hex[start..<hex.index(start, offsetBy: 2)], radix: 16)!
        }
    }
    static func main() throws {
        let cases = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))).vectors
        var checks = 0
        for vector in cases {
            let digest = bytes(vector.digest)
            var scalar = bytes(vector.scalar)
            for encoding in [TbcSignatureEncoding.compact64, .compact65Recoverable] {
                let signature = try scalar.withUnsafeBytes { try TbcDigestSigner.sign(digest: digest, scalar: $0, encoding: encoding) }
                precondition(signature == bytes(encoding == .compact64 ? vector.compact64 : vector.compact65))
                precondition(scalar == bytes(vector.scalar))
                checks += 1
            }
            _ = scalar.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) }
        }
        for (digest, scalar) in [(Array(repeating: UInt8(1), count: 31), Array(repeating: UInt8(1), count: 32)),
                                  (Array(repeating: UInt8(1), count: 32), Array(repeating: UInt8(1), count: 31)),
                                  (Array(repeating: UInt8(1), count: 32), Array(repeating: UInt8(0), count: 32)),
                                  (Array(repeating: UInt8(1), count: 32), Array(repeating: UInt8(255), count: 32))] {
            do { _ = try scalar.withUnsafeBytes { try TbcDigestSigner.sign(digest: digest, scalar: $0, encoding: .compact64) }; fatalError("Invalid input accepted") }
            catch is TbcSignerError { checks += 1 }
        }
        precondition(checks == 52)
        print("SIGNER_SWIFT_PASS checks=\(checks)")
        var schnorrKey = [UInt8](repeating: 0, count: 32); schnorrKey[31] = 3
        let schnorr = try schnorrKey.withUnsafeBytes {
            try TbcDigestSigner.sign(digest: [UInt8](repeating: 0, count: 32), scalar: $0, encoding: .schnorr64)
        }
        precondition(schnorr == bytes("e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0"))
        precondition(TbcSignatureEncoding.schnorr64.size == 64)
        print("SCHNORR_SWIFT_PASS checks=1")
        let key = [UInt8](repeating:7,count:32), message = Array("Native crypto 独立向量".utf8)
        let expected = bytes("4249453102989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6ff99741713c05883f92ecb23261254e069265bf15c77057e79861b91604f018961006b71b93bb9fc4fa2ffdbb645b2ebf36c024b79b9fedb31d87d9e822598c33")
        let encrypted = try key.withUnsafeBytes {try TbcDigestSigner.crypt(input:message,scalar:$0,decrypt:false)}
        precondition(encrypted==expected)
        let plain = try key.withUnsafeBytes {try TbcDigestSigner.crypt(input:encrypted,scalar:$0,decrypt:true)}
        precondition(plain==message)
        var corrupt=encrypted;corrupt[corrupt.count-1] ^= 1
        do {_ = try key.withUnsafeBytes {try TbcDigestSigner.crypt(input:corrupt,scalar:$0,decrypt:true)};fatalError("Corrupted ciphertext accepted")} catch is TbcSignerError {}
        let empty = try key.withUnsafeBytes {try TbcDigestSigner.crypt(input:[],scalar:$0,decrypt:false)}
        let emptyPlain = try key.withUnsafeBytes {try TbcDigestSigner.crypt(input:empty,scalar:$0,decrypt:true)}
        precondition(emptyPlain.isEmpty)
        print("CRYPTO_SWIFT_PASS checks=4")
    }
}
