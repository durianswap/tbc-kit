import Foundation
import TbcEngine

// The host checker links macOS C ABI; the device checker instead compiles this
// exact consumer against the frozen iOS Simulator archive and runs via simctl.
@main struct SwiftProbe {
    struct Vector: Decodable { let method: String; let input: String; let expected: String }
    static func main() async throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let cases = try JSONDecoder().decode([Vector].self, from: data)
        do { _ = try TbcEngine(expectedArtifactSetId: "wrong"); fatalError("identity mismatch accepted") }
        catch TbcEngineError.artifactMismatch {}
        let expectedIdentity = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : TbcEngine.artifactSetId
        let engine = try TbcEngine(expectedArtifactSetId: expectedIdentity)
        for c in cases {
            let actual = try await engine.callEnvelope(TbcEngineMethod(rawValue: c.method)!, canonicalInput: c.input)
            precondition(actual == c.expected, c.method)
        }
        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0..<16 {
                group.addTask {
                    let actual = try await engine.normalizeRequest(cases[0].input)
                    precondition(actual == cases[0].expected)
                }
            }
            try await group.waitForAll()
        }
        for method in [TbcEngineMethod.normalizeRequest, .plan, .validate, .finalize] {
            do {
                switch method {
                case .normalizeRequest: _ = try await engine.normalizeRequest("中文🍈")
                case .plan: _ = try await engine.plan("{}")
                case .validate: _ = try await engine.validate("{}")
                case .finalize: _ = try await engine.finalize("{}")
                }
                fatalError("Engine failure not mapped")
            } catch TbcEngineError.engine(let code, _, _) { precondition(!code.isEmpty) }
        }
        #if targetEnvironment(simulator)
        let runtime = "ios-simulator"
        #else
        let runtime = "macos-host"
        #endif
        print("SWIFT_NATIVE_PROBE_PASS runtime=\(runtime) cases=\(cases.count) concurrent=16")
    }
}
