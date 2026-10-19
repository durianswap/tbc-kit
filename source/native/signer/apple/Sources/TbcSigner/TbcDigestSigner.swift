import TbcSignerKernel

public enum TbcSignatureEncoding: UInt32, Sendable {
    case compact64 = 64
    case compact65Recoverable = 65
    case schnorr64 = 164
    public var size: Int { self == .schnorr64 ? 64 : Int(rawValue) }
}
public enum TbcSignerError: Error { case incompatibleABI, invalidInput, rejected(Int32) }

/// Wallet-private cryptographic primitive, NOT an approval or DApp API.
/// Digest is already hashed. Custody owns and clears scalar storage after this call.
/// Use a borrowed buffer to avoid making a Swift Array/Data copy of the secret.
public enum TbcDigestSigner {
    public static func crypt(input: [UInt8], scalar: UnsafeRawBufferPointer, decrypt: Bool) throws -> [UInt8] {
        guard scalar.count == 32, let key = scalar.baseAddress, input.count <= 1_048_661 else { throw TbcSignerError.invalidInput }
        let capacity = decrypt ? input.count : input.count + 85
        guard capacity <= 1_048_661 else { throw TbcSignerError.invalidInput }
        var output = [UInt8](repeating: 0, count: capacity)
        defer { for index in output.indices { output[index] = 0 } }
        // Non-null storage is required by the FFI even for empty plaintext.
        let bytes = input.isEmpty ? [UInt8(0)] : input
        let result = bytes.withUnsafeBytes { buffer in output.withUnsafeMutableBytes { target in
            tbc_signer_bie1(buffer.baseAddress!.assumingMemoryBound(to: UInt8.self), input.count,
                key.assumingMemoryBound(to: UInt8.self), 32, decrypt ? 1 : 0,
                target.baseAddress!.assumingMemoryBound(to: UInt8.self), capacity)
        } }
        guard result >= 0, result <= capacity else { throw TbcSignerError.rejected(result) }
        return Array(output.prefix(Int(result)))
    }
    public static func sign(digest: [UInt8], scalar: UnsafeRawBufferPointer,
                            encoding: TbcSignatureEncoding) throws -> [UInt8] {
        guard tbc_signer_kernel_version() == 1 else { throw TbcSignerError.incompatibleABI }
        guard digest.count == 32, scalar.count == 32, let key = scalar.baseAddress else {
            throw TbcSignerError.invalidInput
        }
        var output = [UInt8](repeating: 0, count: encoding.size)
        let status = digest.withUnsafeBytes { input in
            output.withUnsafeMutableBytes { result in
                tbc_signer_sign_digest(input.baseAddress!.assumingMemoryBound(to: UInt8.self), 32,
                    key.assumingMemoryBound(to: UInt8.self), 32, encoding.rawValue,
                    result.baseAddress!.assumingMemoryBound(to: UInt8.self), result.count)
            }
        }
        guard status == 0 else { throw TbcSignerError.rejected(status) }
        return output
    }
}
