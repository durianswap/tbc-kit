import Foundation
import TbcEngine
@main struct KeylessProbe {
    struct Vector: Decodable { let method: String; let input: String; let expected: String }
    static func main() async throws {
        let cases = try JSONDecoder().decode([Vector].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        let engine = try TbcKeylessEngine(expectedArtifactSetId: CommandLine.arguments[2])
        do { _ = try TbcKeylessEngine(expectedArtifactSetId: "wrong"); fatalError("Identity accepted") }
        catch TbcEngineError.artifactMismatch {}
        for c in cases {
            let raw = try await engine.callEnvelope(TbcKeylessOperation(rawValue: c.method)!, canonicalInput: c.input)
            precondition(raw == c.expected, c.method)
        }
        try await withThrowingTaskGroup(of: Void.self) { tasks in
            for _ in 0..<16 { tasks.addTask {
                let raw = try await engine.callEnvelope(TbcKeylessOperation(rawValue: cases[0].method)!, canonicalInput: cases[0].input)
                precondition(raw == cases[0].expected)
            } }
            try await tasks.waitForAll()
        }
        precondition(TbcKeylessOperation(rawValue: "sign") == nil)
        print("KEYLESS_SWIFT_PASS cases=\(cases.count) concurrent=16")
    }
}
