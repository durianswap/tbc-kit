// Compiled with the existing SendCustodyCheck harness. No HTTP or signatures.
fun main(args:Array<String>){
 val sample=map(PermissionJson.decode(JSONObject(File(args[0]).readText())))
 val config=NativeBroadcastConfiguration("testnet");val h=Harness(sample,source=config.sourceIdentity,navigate=false)
 val router=NativeBroadcastRouter(h.c,config,File(args[1]),"mint-guard"){_,_,_->error("NO_HTTP_ALLOWED")}
 try{
  h.host.installBroadcast{method,input,reply->router.dispatch(method,input,reply)};h.c.navigation("view",h.scope);h.grant()
  val expiry=java.time.Instant.now().plusSeconds(120).toString();val account=h.accounts.current
  val items=(1..101).map{mapOf<String,Any?>("slot" to it,"name" to "NFT $it","symbol" to "NFT","description" to "public test","attributes" to emptyList<Any>(),"to" to account.address)}
  val consent=mapOf("operationKind" to "tbc721.batchMint","authority" to mapOf("chainId" to account.chainId,"accountId" to account.accountId,"address" to account.address,"origin" to h.scope["origin"],"sessionId" to h.scope["sessionId"]),"collectionId" to "a".repeat(64),"items" to items,"limits" to mapOf("maxTotalFee" to "1000","expiresAt" to expiry,"maxItemsPerBatch" to 100,"maxPlanBytes" to 4194304,"maxTotalPlanBytes" to 33554432))
  var result:Result<Map<String,Any?>>?=null
  h.c.beginMintJob("view",h.scope,"mint",h.c.snapshot("view",h.scope).revision,account,consent){result=it}
  yes(result==null&&h.ui.reviews.getValue("mint").steps.size==101);h.ui.choose("mint");yes(result!!.getOrThrow()["scopeHash"]==hash(consent))
  fun request(selected:List<Map<String,Any?>>,fee:String="1000")=mapOf("version" to "1.0","chainId" to account.chainId,"from" to account.address,"intent" to mapOf("version" to "1.0","type" to "tbc721-standard-batch-mint","collectionId" to "a".repeat(64),"items" to selected),"constraints" to mapOf("maxFee" to fee,"expiresAt" to expiry))
  fun begin(r:Map<String,Any?>,offset:Int=0){h.c.beginMintBatch("view",h.scope,"mint","child",offset,r)}
  rejects{begin(request(items))};rejects{begin(request(items.take(10)),1)};rejects{begin(request(items.take(10),"1001"))}
  rejects{begin(request(items.take(10).mapIndexed{i,v->if(i==0)v+mapOf("name" to "replaced")else v}))}
  rejects{begin(request(items.take(10).mapIndexed{i,v->if(i==0)v+mapOf("to" to "recipient-replaced")else v}))}
  begin(request(items.take(10)));yes(h.ui.shown==2&&h.signer.calls==0)
  var decision:Result<Boolean>?=null
  h.c.consent("view",h.scope,"child","tbc_sendTransaction",request(items.take(10)),map(sample["context"])){decision=it}
  yes(decision!!.getOrThrow());yes(h.ui.shown==2)
  h.c.close("view",h.scope,"child");val finished=h.c.finishMintJob("view",h.scope,"mint","execution-failed")
  yes(finished["status"]=="stopped"&&finished["minted"]==0);rejects{begin(request(items.take(10)))};yes(h.signer.calls==0)
  println("{\"status\":\"PASS\",\"checks\":$checks,\"httpCalls\":0,\"signatureCalls\":0,\"transactionApprovals\":1}")
 }finally{router.close()}
}
