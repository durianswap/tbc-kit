#if TBC_SIGNER_MUSIG
import Dispatch
import Security
import TbcSignerKernel

/// Wallet-private approved task identity. Construct from trusted Host evidence,
/// never from a page's assertion. expiry uses uptime, not wall-clock time.
public struct TbcMuSigAuthorization: Equatable, Sendable {
    public let binding: [UInt8]
    public let digest: [UInt8]
    public let expiresAt: UInt64
    public init(binding: [UInt8], digest: [UInt8], expiresAt: UInt64) throws {
        guard binding.count == 32, digest.count == 32 else { throw TbcSignerError.invalidInput }
        self.binding = binding; self.digest = digest; self.expiresAt = expiresAt
    }
}

private final class MuSigHandle {
    let bytes: [UInt8]
    init(_ bytes: [UInt8]) { self.bytes = bytes }
    func cancel() { bytes.withUnsafeBufferPointer { tbc_signer_musig_cancel($0.baseAddress!) } }
    deinit { cancel() }
}

private final class MuSigScratch {
    let bytes: UnsafeMutablePointer<UInt8>
    init() throws {
        guard let bytes = tbc_signer_musig_buffer_new() else { throw TbcSignerError.rejected(109) }
        self.bytes = bytes
    }
    func put(_ value: [UInt8], at offset: Int) {
        value.withUnsafeBufferPointer { bytes.advanced(by: offset).update(from: $0.baseAddress!, count: value.count) }
    }
    func get(_ offset: Int, _ count: Int) -> [UInt8] {
        Array(UnsafeBufferPointer(start: bytes.advanced(by: offset), count: count))
    }
    deinit { tbc_signer_musig_buffer_free(bytes) }
}

/// Optional n-of-n SDK-compatible session, NOT a Provider or DApp API.
/// MainActor serializes local approval revocation and signing. Host must cancel
/// on navigation, account/permission changes, closing, or approval revocation.
/// authorize must synchronously recheck the exact trusted task at begin AND sign.
/// Only public nonce leaves Rust; no secret nonce/key serialization or recovery.
@MainActor public final class TbcMuSigSession {
    public let publicNonce: [UInt8]
    private let handle: MuSigHandle
    private let authorization: TbcMuSigAuthorization
    private let authorize: @MainActor (TbcMuSigAuthorization) -> Bool
    private let count: Int
    private var active = true

    public static var monotonicMilliseconds: UInt64 { DispatchTime.now().uptimeNanoseconds / 1_000_000 }

    /// Public-only group configuration. Caller supplies sorted unique keys;
    /// authorization must still bind the result to the actual chain/task.
    public static func aggregateKey(publicKeys: [[UInt8]]) throws -> [UInt8] {
        guard (2...32).contains(publicKeys.count), publicKeys.allSatisfy({ $0.count == 33 }) else {
            throw TbcSignerError.invalidInput
        }
        let scratch = try MuSigScratch(), p = scratch.bytes
        scratch.put(publicKeys.flatMap { $0 }, at: 0)
        let status = tbc_signer_musig_aggregate_key(p, publicKeys.count, p + 1056)
        guard status == 0 else { throw TbcSignerError.rejected(status) }
        return scratch.get(1056, 32)
    }

    public init(publicKeys: [[UInt8]], aggregateKey: [UInt8], authorization: TbcMuSigAuthorization,
                scalar: UnsafeRawBufferPointer,
                authorize: @escaping @MainActor (TbcMuSigAuthorization) -> Bool) throws {
        guard tbc_signer_musig_version() == 1 else { throw TbcSignerError.incompatibleABI }
        guard (2...32).contains(publicKeys.count), publicKeys.allSatisfy({ $0.count == 33 }),
              aggregateKey.count == 32, scalar.count == 32, let key = scalar.baseAddress else {
            throw TbcSignerError.invalidInput
        }
        guard authorize(authorization) else { throw TbcSignerError.rejected(102) }
        let scratch = try MuSigScratch(), p = scratch.bytes
        scratch.put(publicKeys.flatMap { $0 }, at: 0)
        scratch.put(aggregateKey, at: 1056)
        scratch.put(authorization.digest, at: 1088)
        scratch.put(authorization.binding, at: 1120)
        guard SecRandomCopyBytes(kSecRandomDefault, 32, p + 1184) == errSecSuccess else {
            throw TbcSignerError.rejected(107)
        }
        let status = tbc_signer_musig_begin(p, publicKeys.count, p + 1056, p + 1088, p + 1120,
            key.assumingMemoryBound(to: UInt8.self), p + 1184, Self.monotonicMilliseconds,
            authorization.expiresAt, p + 1216, p + 1248)
        guard status == 0 else { throw TbcSignerError.rejected(status) }
        handle = MuSigHandle(scratch.get(1216, 32)); publicNonce = scratch.get(1248, 66)
        self.authorization = authorization; self.authorize = authorize; count = publicKeys.count
    }

    /// Scalar is borrowed for this synchronous call; custody clears it afterwards.
    /// EVERY attempt consumes the session, including validation/approval failure.
    public func sign(authorization current: TbcMuSigAuthorization, scalar: UnsafeRawBufferPointer,
                     publicNonces: [[UInt8]]) throws -> [UInt8] {
        guard active else { throw TbcSignerError.rejected(106) }
        active = false
        defer { handle.cancel() }
        guard current == authorization, authorize(current) else { throw TbcSignerError.rejected(102) }
        guard scalar.count == 32, let key = scalar.baseAddress,
              publicNonces.count == count, publicNonces.allSatisfy({ $0.count == 66 }) else {
            throw TbcSignerError.invalidInput
        }
        let scratch = try MuSigScratch(), p = scratch.bytes
        scratch.put(current.digest, at: 1088); scratch.put(current.binding, at: 1120)
        scratch.put(handle.bytes, at: 1216); scratch.put(publicNonces.flatMap { $0 }, at: 1314)
        let status = tbc_signer_musig_sign(p + 1216, p + 1120, p + 1088,
            key.assumingMemoryBound(to: UInt8.self), p + 1314, count, Self.monotonicMilliseconds, p + 3426)
        guard status == 0 else { throw TbcSignerError.rejected(status) }
        return scratch.get(3426, 32)
    }

    public func cancel() { active = false; handle.cancel() }

    /// Public transcript only; Rust verifies each share and the final signature.
    public static func combine(publicKeys: [[UInt8]], aggregateKey: [UInt8], digest: [UInt8],
                               publicNonces: [[UInt8]], partialSignatures: [[UInt8]]) throws -> [UInt8] {
        guard tbc_signer_musig_version() == 1 else { throw TbcSignerError.incompatibleABI }
        let count = publicKeys.count
        guard (2...32).contains(count), publicKeys.allSatisfy({ $0.count == 33 }),
              aggregateKey.count == 32, digest.count == 32, publicNonces.count == count,
              partialSignatures.count == count, publicNonces.allSatisfy({ $0.count == 66 }),
              partialSignatures.allSatisfy({ $0.count == 32 }) else { throw TbcSignerError.invalidInput }
        let scratch = try MuSigScratch(), p = scratch.bytes
        scratch.put(publicKeys.flatMap { $0 }, at: 0); scratch.put(aggregateKey, at: 1056)
        scratch.put(digest, at: 1088); scratch.put(publicNonces.flatMap { $0 }, at: 1314)
        scratch.put(partialSignatures.flatMap { $0 }, at: 3426)
        let status = tbc_signer_musig_combine(p, count, p + 1056, p + 1088, p + 1314, p + 3426, p + 4450)
        guard status == 0 else { throw TbcSignerError.rejected(status) }
        return scratch.get(4450, 64)
    }
}
#endif
