import Foundation
import Dispatch
import TbcKeylessNative

public enum TbcKeylessOperation: String, CaseIterable, Sendable {
    case preparePoolNft, prepareAssetAncestry, legacyPoolPreview, inspectTokenReceipt, inspectNftReceipt
    case prepareReviewedStage, finalizeReviewedStage, inspectAmmMaterial, inspectLopMaterial, inspectTokenMaterial
    case describeMultisig, decodeMultisigAddress, prepareMultisig, inspectMultisig
    case verifyMultisigSignatures, finalizeMultisig
}

/// Companion computation only: no private scalar, account, network or signing.
public struct TbcKeylessEngine: Sendable {
    public init(expectedArtifactSetId: String = TbcEngine.artifactSetId) throws {
        guard expectedArtifactSetId == TbcEngine.artifactSetId else { throw TbcEngineError.artifactMismatch }
    }
    public func callEnvelope(_ operation: TbcKeylessOperation, canonicalInput: String) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do { continuation.resume(returning: try Self.invoke(operation, canonicalInput)) }
                catch { continuation.resume(throwing: error) }
            }
        }
    }
    private static func invoke(_ operation: TbcKeylessOperation, _ input: String) throws -> String {
        let name = Array(operation.rawValue.utf8), bytes = Array(input.utf8)
        let buffer = name.withUnsafeBufferPointer { op in bytes.withUnsafeBufferPointer { value in
            tbc_keyless_call(op.baseAddress, op.count, value.baseAddress, value.count)
        } }
        defer { tbc_keyless_free(buffer) }
        guard buffer.len <= buffer.cap, buffer.len == 0 || buffer.ptr != nil else { throw TbcEngineError.invalidBuffer }
        let data = buffer.len == 0 ? Data() : Data(bytes: buffer.ptr!, count: buffer.len)
        guard let raw = String(data: data, encoding: .utf8) else { throw TbcEngineError.invalidEncoding }
        return raw
    }
}
