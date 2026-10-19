import TbcEngine

/// Keyless Engine adapter only. Never send a private key into the shared JS VM.
public struct EngineAdapter: Sendable {
    private let engine: TbcEngine
    public init() throws {
        engine = try TbcEngine(expectedArtifactSetId: "__ARTIFACT_SET_ID__")
    }
    // Shared Kit owns JSON decoding, validation, plan/approval/sign/finalize order.
    public func call(_ method: TbcEngineMethod, canonicalInput: String) async throws -> String {
        try await engine.callEnvelope(method, canonicalInput: canonicalInput)
    }
}
