import ExpoModulesCore

public class TbcKitEngineModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TbcKitEngine")
    Constant("artifactSetId") { TbcEngine.artifactSetId }
    // SDK owns scheduling and buffers; Kit performs the one envelope decode.
    AsyncFunction("call") { (method: String, input: String) async throws -> String in
      guard let selected = TbcEngineMethod(rawValue: method) else {
        throw Exception(name: "UnsupportedMethod", description: "Unsupported Engine method")
      }
      return try await TbcEngine().callEnvelope(selected, canonicalInput: input)
    }
    AsyncFunction("callKeyless") { (operation: String, input: String) async throws -> String in
      guard let selected = TbcKeylessOperation(rawValue: operation) else {
        throw Exception(name: "UnsupportedMethod", description: "Unsupported Keyless operation")
      }
      return try await TbcKeylessEngine().callEnvelope(selected, canonicalInput: input)
    }
  }
}
