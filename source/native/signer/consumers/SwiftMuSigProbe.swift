// PUBLIC fixture scalars 1/2 only. Never use this probe with wallet custody.
import Foundation
#if TBC_SIGNER_EXTERNAL_MODULE
import TbcSigner
#endif

@main @MainActor struct SwiftMuSigProbe {
    static func bytes(_ hex: String) -> [UInt8] {
        stride(from: 0, to: hex.count, by: 2).map {
            let i = hex.index(hex.startIndex, offsetBy: $0)
            return UInt8(hex[i..<hex.index(i, offsetBy: 2)], radix: 16)!
        }
    }
    static func hex(_ bytes: [UInt8]) -> String { bytes.map { String(format: "%02x", $0) }.joined() }
    static func main() throws {
        let keys = [bytes("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
                    bytes("02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5")]
        let aggregate = bytes("3b46d262d2f610e9038b44beabdfe97ab5a0feb89870acc2264edfb7f63ec2ec")
        #if !TBC_SIGNER_EXTERNAL_MODULE || TBC_SIGNER_GROUP_DERIVATION
        let derivedAggregate = try TbcMuSigSession.aggregateKey(publicKeys: keys)
        precondition(derivedAggregate == aggregate)
        let publicGroupDerivation = true
        #else
        // Frozen local4 consumer probes must remain runnable unchanged in scope.
        let publicGroupDerivation = false
        #endif
        let digest = [UInt8](repeating: 0x37, count: 32)
        var checks = 0, approvals = 0, allowed = true
        func rejection(_ code: Int32? = nil, _ work: () throws -> Void) {
            do { try work(); fatalError("Expected rejection") }
            catch TbcSignerError.rejected(let actual) { if let code { precondition(code == actual) }; checks += 1 }
            catch TbcSignerError.invalidInput { precondition(code == nil); checks += 1 }
            catch { fatalError("Unexpected error type") }
        }
        func auth(ttl: UInt64 = 60_000, byte: UInt8 = 0x20) throws -> TbcMuSigAuthorization {
            try .init(binding: [UInt8](repeating: byte, count: 32), digest: digest,
                      expiresAt: TbcMuSigSession.monotonicMilliseconds + ttl)
        }
        func withKey<T>(_ n: UInt8, _ body: (UnsafeRawBufferPointer) throws -> T) rethrows -> T {
            var scalar = [UInt8](repeating: 0, count: 32); scalar[31] = n
            defer { _ = scalar.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) } }
            return try scalar.withUnsafeBytes(body)
        }
        func begin(_ n: UInt8, _ authorization: TbcMuSigAuthorization) throws -> TbcMuSigSession {
            try withKey(n) { try TbcMuSigSession(publicKeys: keys, aggregateKey: aggregate,
                authorization: authorization, scalar: $0, authorize: { _ in approvals += 1; return allowed }) }
        }
        func sign(_ session: TbcMuSigSession, _ n: UInt8, _ authorization: TbcMuSigAuthorization,
                  _ nonces: [[UInt8]]) throws -> [UInt8] {
            try withKey(n) { try session.sign(authorization: authorization, scalar: $0, publicNonces: nonces) }
        }
        let authorization = try auth(), a = try begin(1, authorization), b = try begin(2, authorization)
        let nonces = [a.publicNonce, b.publicNonce]
        let shares = [try sign(a, 1, authorization, nonces), try sign(b, 2, authorization, nonces)]
        let signature = try TbcMuSigSession.combine(publicKeys: keys, aggregateKey: aggregate,
            digest: digest, publicNonces: nonces, partialSignatures: shares)
        precondition(signature.count == 64 && approvals == 4); checks += 1
        rejection(106) { _ = try sign(a, 1, authorization, nonces) }
        rejection(105) { _ = try TbcMuSigSession.combine(publicKeys: keys, aggregateKey: aggregate,
            digest: digest, publicNonces: nonces, partialSignatures: [shares[1], shares[0]]) }
        let cancelled = try begin(1, authorization); cancelled.cancel()
        rejection(106) { _ = try sign(cancelled, 1, authorization, nonces) }
        let revoked = try begin(1, authorization); allowed = false
        rejection(102) { _ = try sign(revoked, 1, authorization, nonces) }
        rejection(102) { _ = try begin(1, authorization) }
        allowed = true
        rejection(106) { _ = try sign(revoked, 1, authorization, nonces) }
        let wrong = try begin(1, authorization), other = try auth(byte: 0x21)
        rejection(102) { _ = try sign(wrong, 1, other, nonces) }
        rejection(106) { _ = try sign(wrong, 1, authorization, nonces) }
        let malformed = try begin(1, authorization)
        rejection { _ = try sign(malformed, 1, authorization, [[]]) }
        rejection(106) { _ = try sign(malformed, 1, authorization, nonces) }
        let wrongKey = try begin(1, authorization)
        rejection { _ = try sign(wrongKey, 2, authorization, [wrongKey.publicNonce, b.publicNonce]) }
        rejection(106) { _ = try sign(wrongKey, 1, authorization, nonces) }
        let short = try auth(ttl: 20), expired = try begin(1, short)
        Thread.sleep(forTimeInterval: 0.03)
        rejection(108) { _ = try sign(expired, 1, short, [expired.publicNonce, b.publicNonce]) }
        rejection(106) { _ = try sign(expired, 1, short, nonces) }
        rejection(108) { _ = try begin(1, auth(ttl: 400_000)) }
        // More than registry capacity: each object deinit must release its slot.
        for _ in 0..<40 {
            var dropped: TbcMuSigSession? = try begin(1, authorization)
            weak var reference = dropped
            dropped = nil
            precondition(reference == nil)
            reference = nil
        }
        checks += 1
        // A reentrant cancellation from the platform's authorization callback
        // must not let the sign operation use a now-revoked native handle.
        var reentrant: TbcMuSigSession?
        reentrant = try withKey(1) { try TbcMuSigSession(publicKeys: keys, aggregateKey: aggregate,
            authorization: authorization, scalar: $0, authorize: { _ in reentrant?.cancel(); return true }) }
        rejection(106) { _ = try sign(reentrant!, 1, authorization, [reentrant!.publicNonce, b.publicNonce]) }
        reentrant = nil
        let report: [String: Any] = ["status": "PASS", "checks": checks, "publicFixturesOnly": true, "publicGroupDerivation": publicGroupDerivation,
            "publicKeys": keys.map(hex), "aggregateKey": hex(aggregate), "digest": hex(digest),
            "publicNonces": nonces.map(hex), "partialSignatures": shares.map(hex), "signature": hex(signature)]
        print(String(data: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8)!)
    }
}
