import Foundation

@main struct NativeBridgeProbe {
  static func main() throws {
    let input = #"{"version":"1.0","request":{"version":"1.0","chainId":"tbc:testnet","from":"1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH","intent":{"version":"1.0","type":"tbc.transfer","to":"1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP","amount":"1000"}}}"#
    let response = try TbcKitEngineBridge.call("normalizeRequest", input)
    let json = try JSONSerialization.jsonObject(with: Data(response.utf8)) as! [String: Any]
    precondition(json["ok"] as? Bool == true, response)
    // Stateless ABI calls may execute concurrently. Every result must match.
    DispatchQueue.concurrentPerform(iterations: 32) { _ in
      precondition(try! TbcKitEngineBridge.call("normalizeRequest", input) == response)
    }
    for method in ["plan", "validate", "finalize"] {
      let rejected = try TbcKitEngineBridge.call(method, "{}")
      let envelope = try JSONSerialization.jsonObject(with: Data(rejected.utf8)) as! [String: Any]
      precondition(envelope["ok"] as? Bool == false)
    }
    let malformed = try TbcKitEngineBridge.call("normalizeRequest", "中文🍈")
    let errorEnvelope = try JSONSerialization.jsonObject(with: Data(malformed.utf8)) as! [String: Any]
    precondition(errorEnvelope["ok"] as? Bool == false)
    do {
      _ = try TbcKitEngineBridge.call("encryptMessage", "{}")
      fatalError("private method unexpectedly accepted")
    } catch TbcKitBridgeError.unsupportedMethod {}
    print("NATIVE_BRIDGE_PROBE_PASS concurrent=32 methods=4 private=blocked utf8=pass")
    print(response)
  }
}
