import TbcEngine

// Compiled and linked as a separate SPM consumer, never installed into a wallet.
public enum NativeEngineConsumer {
    public static func normalize(_ canonicalInput: String, expectedArtifactSetId: String) async throws -> String {
        let engine = try TbcEngine(expectedArtifactSetId: expectedArtifactSetId)
        return try await engine.normalizeRequest(canonicalInput)
    }
}
