import Foundation
import Dispatch
import TbcEngineNative

public enum TbcEngineMethod: String, Sendable {
    case normalizeRequest, plan, validate, finalize
}

public enum TbcEngineError: Error, Sendable {
    case artifactMismatch
    case invalidBuffer
    case invalidEncoding
    case invalidEnvelope
    case engine(code: String, message: String, path: String?)
}

/// Keyless JSON ABI. No account store, network, approval UI, signing or broadcasting.
public struct TbcEngine: Sendable {
    public static let artifactSetId = TbcEngineIdentity.artifactSetId
    public static let protocolFingerprint = TbcEngineIdentity.protocolFingerprint

    /// Compare against the identity pinned by the application when one is supplied.
    /// This is a composition check, not a runtime attestation of an untrusted binary.
    public init(expectedArtifactSetId: String = TbcEngine.artifactSetId) throws {
        guard expectedArtifactSetId == Self.artifactSetId else { throw TbcEngineError.artifactMismatch }
    }

    /// Preserves the Rust envelope byte-for-byte, including Engine error envelopes.
    /// A shared Kit adapter can decode it once, with no duplicate bridge JSON parse.
    public func callEnvelope(_ method: TbcEngineMethod, canonicalInput: String) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do { continuation.resume(returning: try Self.invoke(method, canonicalInput)) }
                catch { continuation.resume(throwing: error) }
            }
        }
    }

    /// Native-only convenience methods throw Engine errors and return the intact
    /// success envelope; request/result schemas remain those of the shared Engine.
    public func normalizeRequest(_ input: String) async throws -> String { try await execute(.normalizeRequest, input) }
    public func plan(_ input: String) async throws -> String { try await execute(.plan, input) }
    public func validate(_ input: String) async throws -> String { try await execute(.validate, input) }
    public func finalize(_ input: String) async throws -> String { try await execute(.finalize, input) }

    private func execute(_ method: TbcEngineMethod, _ input: String) async throws -> String {
        let raw = try await callEnvelope(method, canonicalInput: input)
        guard let envelope = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any],
              envelope["version"] as? String == "1.0", let ok = envelope["ok"] as? Bool else {
            throw TbcEngineError.invalidEnvelope
        }
        if !ok {
            guard let error = envelope["error"] as? [String: Any],
                  let code = error["code"] as? String, let message = error["message"] as? String else {
                throw TbcEngineError.invalidEnvelope
            }
            throw TbcEngineError.engine(code: code, message: message, path: error["path"] as? String)
        }
        guard envelope["result"] != nil else { throw TbcEngineError.invalidEnvelope }
        return raw
    }

    private static func invoke(_ method: TbcEngineMethod, _ input: String) throws -> String {
        let methodBytes = Array(method.rawValue.utf8), inputBytes = Array(input.utf8)
        let buffer = methodBytes.withUnsafeBufferPointer { methodPtr in
            inputBytes.withUnsafeBufferPointer { inputPtr in
                tbc_engine_call(methodPtr.baseAddress, methodPtr.count, inputPtr.baseAddress, inputPtr.count)
            }
        }
        defer { tbc_engine_free(buffer) }
        guard buffer.len <= buffer.cap, buffer.len == 0 || buffer.ptr != nil else { throw TbcEngineError.invalidBuffer }
        let bytes = buffer.len == 0 ? Data() : Data(bytes: buffer.ptr!, count: buffer.len)
        guard let response = String(data: bytes, encoding: .utf8) else { throw TbcEngineError.invalidEncoding }
        return response
    }
}
