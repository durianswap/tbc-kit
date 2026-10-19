import Foundation

// Read controlled, public fixture vectors; never account material or live requests.
@main struct NativeBridgeVectors {
  struct Vector: Decodable { let name: String; let method: String; let input: String }
  struct Result: Encodable { let name: String; let output: String }
  static func main() throws {
    precondition(CommandLine.arguments.count == 3)
    let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    let vectors = try JSONDecoder().decode([Vector].self, from: data)
    let results = try vectors.map { Result(name: $0.name, output: try TbcKitEngineBridge.call($0.method, $0.input)) }
    try JSONEncoder().encode(results).write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
    print("NATIVE_BRIDGE_VECTORS_PASS count=\(results.count)")
  }
}
