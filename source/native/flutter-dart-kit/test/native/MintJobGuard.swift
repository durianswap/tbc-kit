// Compiled with the existing SendCustodyCheck harness. No HTTP or signatures.
@main @MainActor struct LargeRouteCheck {
 static func main() async throws {
  let sample=map(try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))))
  let config=try NativeBroadcastConfiguration(network:"testnet"),h=try Harness(sample,source:config.sourceIdentity,navigate:false)
  let router=NativeBroadcastRouter(custody:h.c,configuration:config,directory:URL(fileURLWithPath:CommandLine.arguments[2]),profile:"mint-guard"){_,_,_ in throw NativeCustodyFailure(code:"NO_HTTP_ALLOWED")}
  defer{router.close()};try h.host.installBroadcast{method,input,reply in router.dispatch(method:method,input:input,reply:reply)}
  try h.c.navigation(owner:"view",scope:h.scope);try h.grant()
  let expiry=ISO8601DateFormatter().string(from:Date().addingTimeInterval(120)),account=h.accounts.current
  let items:[[String:Any]]=(1...101).map{["slot":$0,"name":"NFT \($0)","symbol":"NFT","description":"public test","attributes":[],"to":account.address]}
  let authority:[String:Any]=["chainId":account.chainId,"accountId":account.accountId,"address":account.address,"origin":h.scope["origin"]!,"sessionId":h.scope["sessionId"]!]
  let consent:[String:Any]=["operationKind":"tbc721.batchMint","authority":authority,"collectionId":String(repeating:"a",count:64),"items":items,"limits":["maxTotalFee":"1000","expiresAt":expiry,"maxItemsPerBatch":100,"maxPlanBytes":4194304,"maxTotalPlanBytes":33554432]]
  var result:Result<[String:Any],Error>?
  try h.c.beginMintJob(owner:"view",scope:h.scope,id:"mint",expectedRevision:h.c.snapshot(owner:"view",scope:h.scope).revision,expectedAccount:account,consent:consent){result=$0}
  yes(result==nil && h.ui.reviews["mint"]!.steps.count==101);h.ui.choose("mint");yes(try result!.get()["scopeHash"] as? String==hash(consent))
  func request(_ selected:[[String:Any]],fee:String="1000")->[String:Any]{["version":"1.0","chainId":account.chainId,"from":account.address,"intent":["version":"1.0","type":"tbc721-standard-batch-mint","collectionId":String(repeating:"a",count:64),"items":selected],"constraints":["maxFee":fee,"expiresAt":expiry]]}
  func begin(_ r:[String:Any],_ offset:Int=0)throws{_ = try h.c.beginMintBatch(owner:"view",scope:h.scope,parent:"mint",id:"child",offset:offset,request:r)}
  rejects{try begin(request(items))};rejects{try begin(request(Array(items.prefix(10))),1)}
  rejects{try begin(request(Array(items.prefix(10)),fee:"1001"))}
  var altered=Array(items.prefix(10));altered[0]["name"]="replaced";rejects{try begin(request(altered))}
  altered=Array(items.prefix(10));altered[0]["to"]="recipient-replaced";rejects{try begin(request(altered))}
  try begin(request(Array(items.prefix(10))));yes(h.ui.shown==2 && h.signer.calls==0)
  var decision:Result<Bool,Error>?
  try h.c.consent(owner:"view",scope:h.scope,id:"child",method:"tbc_sendTransaction",request:request(Array(items.prefix(10))),context:map(sample["context"])){decision=$0}
  yes(try decision!.get());yes(h.ui.shown==2)
  try h.c.close(owner:"view",scope:h.scope,id:"child")
  let finished=try h.c.finishMintJob(owner:"view",scope:h.scope,id:"mint",reason:"execution-failed")
  yes(finished["status"] as? String=="stopped" && finished["minted"] as? Int==0)
  rejects{try begin(request(Array(items.prefix(10))))};yes(h.signer.calls==0)
  print("{\"status\":\"PASS\",\"checks\":\(checks),\"httpCalls\":0,\"signatureCalls\":0,\"transactionApprovals\":1}")
 }
}
