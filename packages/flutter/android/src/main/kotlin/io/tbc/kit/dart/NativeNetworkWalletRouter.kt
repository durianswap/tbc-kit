package io.tbc.kit.dart

import org.json.JSONArray

// Immutable wallet-owned lane; network URLs/keys cannot come from page params.
data class NativeNetworkLane(val sourceIdentity:String,val custody:NativeCustody,val wallet:NativeWalletHost)

/** Shared per-document native router. Calls use the custody executor. It reuses
 * existing signing/grant/broadcast hosts; no key access, HTTP or business logic.
 * Multi-network registration must route every private call through this owner.
 */
class NativeNetworkWalletRouter(
 lanes:Map<String,NativeNetworkLane>,private val initialChain:String,
 private val approval:NativeApprovalPresenter,nativeCurrent:(String,Map<String,String>)->Boolean,
) {
 private val lanes=lanes.toMap();private val executor=Thread.currentThread()
 val walletProtocol get()=this.lanes.getValue(initialChain).custody.walletProtocol
 private val pending=mutableMapOf<String,MutableMap<String,()->Unit>>()
 private val documents=mutableMapOf<String,Map<String,String>>()
 private var closed=false
 private var refreshing=false
 private var authorityChanged:((String,Map<String,String>,Map<String,Any?>?)->Unit)?=null
 private val sessions:NativeNetworkSessions
 init{
  require(initialChain in lanes&&lanes.values.map{it.custody}.toSet().size==lanes.size&&lanes.values.map{it.wallet}.toSet().size==lanes.size){"NETWORK_CATALOG"}
  require(lanes.values.map{it.custody.walletProtocol}.toSet().size==1){"PERMISSION_PROTOCOL"}
  lanes.forEach{(chain,lane)->lane.custody.validateNetworkLane(chain,lane.sourceIdentity)}
  sessions=NativeNetworkSessions(this.lanes.mapValues{it.value.sourceIdentity},
   {owner,scope->!closed&&nativeCurrent(owner,scope)},
   {chain,origin->val a=this.lanes.getValue(chain).custody.networkAuthority(origin);NativeNetworkAuthority(a.epoch,a.unlocked,a.switchAccountIds,a.visibleAddresses)},
   {owner,_->this.lanes.values.forEach{it.wallet.fenceDocument(owner)};cancelDialogs(owner)},
   activate={owner,scope,chain,ids->this.lanes.getValue(chain).custody.activateAccounts(owner,scope,ids)})
  this.lanes.values.forEach{lane->lane.wallet.installNetworkEvents{owner,scope->publicEvents(owner,scope)}}
 }
 private fun onExecutor(){check(Thread.currentThread()===executor){"NATIVE_EXECUTOR"}}
 private fun needOpen(){onExecutor();if(closed)throw NativeNetworkFailure("NETWORK_STALE")}
 fun installAuthorityChanged(callback:(String,Map<String,String>,Map<String,Any?>?)->Unit){needOpen();need(authorityChanged==null);authorityChanged=callback}
 fun nativeAuthorityChanged(owner:String,scope:Map<String,String>){
  onExecutor();if(closed||refreshing||documents[owner]!=scope)return
  try{authorityChanged?.invoke(owner,scope,snapshotWire(owner,scope))}
  catch(e:Exception){invalidate(owner);authorityChanged?.invoke(owner,scope,null)}
 }
 private fun notifyChanges(origin:String?,exceptOwner:String?=null){
  documents.toMap().forEach{(owner,scope)->if(owner!=exceptOwner&&(origin==null||scope["origin"]==origin))nativeAuthorityChanged(owner,scope)}
 }
 private fun cancelDialogs(owner:String){pending.remove(owner)?.values?.toList()?.forEach{it()}}
 fun navigation(owner:String,scope:Map<String,String>){
  needOpen();sessions.navigation(owner,scope,initialChain)
  try{lanes.values.forEach{it.wallet.navigation(owner,scope)};documents[owner]=scope.toMap()}catch(e:Exception){invalidate(owner);throw e}
 }
 fun invalidate(owner:String){onExecutor();sessions.invalidate(owner);cancelDialogs(owner);lanes.values.forEach{it.wallet.invalidate(owner)};documents.remove(owner)}
 fun state(owner:String,scope:Map<String,String>):NativeNetworkState{needOpen();return sessions.state(owner,scope)}
 fun sourceIdentity(owner:String,scope:Map<String,String>,expected:NativeNetworkState):String{needOpen();return sessions.requireState(owner,scope,expected)}
 fun snapshot(owner:String,scope:Map<String,String>,expected:NativeNetworkState):NativeWalletSnapshot{
  sourceIdentity(owner,scope,expected);return lanes.getValue(expected.chainId).custody.snapshot(owner,scope)
 }
 fun permissions(owner:String,scope:Map<String,String>):List<Map<String,Any?>>{
  state(owner,scope);return lanes.keys.sorted().flatMap{lanes.getValue(it).custody.networkPermissions(scope.getValue("origin"))}
 }
 // Target-chain grants do not switch the page or authorize a signature.
 fun requestPermissions(owner:String,scope:Map<String,String>,operation:String,target:String,expected:NativeNetworkState,
                        request:Map<String,Any?>,complete:(Result<List<Map<String,Any?>>>)->Unit){
  sourceIdentity(owner,scope,expected);val lane=lanes[target]?:throw NativeNetworkFailure("NETWORK_UNSUPPORTED")
  lane.custody.requestPermissions(owner,scope,operation,request){result->
   notifyChanges(scope["origin"],owner)
   complete(runCatching{sourceIdentity(owner,scope,expected);result.getOrThrow()})
  }
 }
 fun accountChanged(){onExecutor();pending.keys.toList().forEach(::cancelDialogs);refreshing=true
  try{lanes.values.forEach{it.wallet.accountChanged()}}finally{refreshing=false};notifyChanges(null)
 }
 private fun requestPermissionGroup(owner:String,scope:Map<String,String>,operation:String,expected:NativeNetworkState,
                                    requests:Map<String,Map<String,Any?>>,complete:(Result<List<Map<String,Any?>>>)->Unit){
  val grants=mutableListOf<NativePermissionGrant>();var done=false;var ownsPending=false;var dismiss:(()->Unit)?=null
  fun finish(result:Result<List<Map<String,Any?>>>){
   if(done)return;done=true
   if(ownsPending){pending[owner]?.remove(operation);if(pending[owner]?.isEmpty()==true)pending.remove(owner)}
   grants.forEach{it.detach()};runCatching{complete(result)};runCatching{dismiss?.invoke()}
  }
  val cancel={finish(Result.failure(NativeNetworkFailure("NETWORK_STALE")))}
  try{
   sourceIdentity(owner,scope,expected);need(pending[owner]?.containsKey(operation)!=true)
   pending.getOrPut(owner){mutableMapOf()}[operation]=cancel;ownsPending=true
   for(chain in requests.keys.sorted())grants+=lanes.getValue(chain).custody.prepareNetworkGrant(owner,scope,operation,requests.getValue(chain),cancel)
   NativePermissions.groupBackend(grants)
   val detail=grants.joinToString("\n\n"){g->val p=g.proposal;"${p.accounts[0].chainId}: ${p.capabilities.joinToString()}\nAccounts:\n"+p.accounts.joinToString("\n"){it.address}}
   val a=snapshot(owner,scope,expected).account
   val review=NativeReview(operation,scope.getValue("origin"),expected.chainId,a.address,"Connect wallet networks",
    detail+"\n\nApprove all listed networks together. This does not switch this page. Each signature still requires approval.")
   dismiss=approval.present(lanes.getValue(initialChain).custody.walletProtocol.approvalReview(review)){yes->
    onExecutor();if(!done){
     try{
      if(!yes)throw NativeNetworkFailure("NETWORK_REJECTED")
      pending[owner]?.remove(operation)
      val records=NativePermissions.approveGroup(grants){sourceIdentity(owner,scope,expected);Unit}
      notifyChanges(scope["origin"],owner);finish(Result.success(records))
     }catch(e:Exception){notifyChanges(scope["origin"],owner);finish(Result.failure(e))}
    }
   }
   if(done)runCatching{dismiss?.invoke()}
  }catch(e:Exception){finish(Result.failure(e))}
 }
 fun cancelSwitch(owner:String,scope:Map<String,String>,operation:String){
  needOpen();sessions.cancel(owner,scope,operation);val cb=pending[owner]?.remove(operation)
  if(pending[owner]?.isEmpty()==true)pending.remove(owner);cb?.invoke()
 }
 fun switchChain(owner:String,scope:Map<String,String>,operation:String,target:String,expected:NativeNetworkState,
                 complete:(Result<NativeNetworkCommit>)->Unit){
  sourceIdentity(owner,scope,expected)
  val proposal=sessions.prepare(owner,scope,operation,target,expected.revision)
  if(target==expected.chainId){complete(runCatching{sessions.commit(proposal,false)});return}
  val targetAddresses=proposal.toAuthority.visibleAddresses.filter{"$target:$it" in proposal.toAuthority.switchAccountIds}
  var done=false;var dismiss:(()->Unit)?=null
  fun finish(result:Result<NativeNetworkCommit>){
   if(done)return;done=true;pending[owner]?.remove(operation);if(pending[owner]?.isEmpty()==true)pending.remove(owner)
   complete(result);dismiss?.invoke()
  }
  pending.getOrPut(owner){mutableMapOf()}[operation]={finish(Result.failure(NativeNetworkFailure("NETWORK_STALE")))}
  val name=if(target=="tbc:mainnet")"TBC Mainnet" else "TBC Testnet"
  val review=NativeReview(operation,scope.getValue("origin"),target,targetAddresses.first(),"Switch network",
   "Switch this page from ${expected.chainId} to $name ($target).\nAccounts:\n${targetAddresses.joinToString("\n")}\nPending requests on the previous network will be cancelled. No transaction will be signed or sent.")
  try{
   dismiss=approval.present(lanes.getValue(initialChain).custody.walletProtocol.approvalReview(review)){yes->
    onExecutor();if(!done){pending[owner]?.remove(operation);finish(runCatching{sessions.commit(proposal,yes)})}
   }
   if(done)dismiss.invoke()
  }catch(e:Exception){
   runCatching{sessions.cancel(owner,scope,operation)};finish(Result.failure(NativeNetworkFailure("NETWORK_STALE")))
  }
 }
 fun requireDelivery(commit:NativeNetworkCommit){needOpen();sessions.requireDelivery(commit)}
 // Chain+revision is held through callback completion; never reroute stale work.
 fun dispatch(owner:String,scope:Map<String,String>,expected:NativeNetworkState,method:String,fields:Map<String,Any?>,
              reply:(Map<String,Any?>)->Unit){
  fun denied(){reply(mapOf("ok" to false,"code" to "NATIVE_DENIED"))}
  try{
   sourceIdentity(owner,scope,expected)
   if(fields.keys.any{it in setOf("ownerId","scope")}||method in setOf("permissions.disconnect","document.invalidate"))throw NativeNetworkFailure("NETWORK_SCOPE")
   lanes.getValue(expected.chainId).wallet.dispatch(method,fields+mapOf("ownerId" to owner,"scope" to scope)){result->
    onExecutor();if(runCatching{sourceIdentity(owner,scope,expected)}.isSuccess)reply(result)else denied()
   }
  }catch(e:Exception){denied()}
 }
 fun allowDelivery(owner:String,scope:Map<String,String>,expected:NativeNetworkState,text:String):Boolean=
  runCatching{sourceIdentity(owner,scope,expected);lanes.getValue(expected.chainId).wallet.allowDelivery(owner,scope,text)}.getOrDefault(false)
 // Origin-wide revoke. Attempt every store, fail closed if any commit fails.
 fun disconnect(owner:String,scope:Map<String,String>,operation:String,expected:NativeNetworkState){
  sourceIdentity(owner,scope,expected);cancelDialogs(owner);lanes.values.forEach{it.wallet.fenceDocument(owner)}
  var failure:Exception?=null
  for(chain in lanes.keys.sorted())try{lanes.getValue(chain).custody.disconnect(owner,scope,operation)}catch(e:Exception){failure=e}
  notifyChanges(scope["origin"],owner)
  failure?.let{throw it}
 }
 fun close(){onExecutor();if(closed)return;closed=true;documents.keys.toList().forEach(::invalidate)}

 private fun need(b:Boolean){if(!b)throw NativeNetworkFailure("NETWORK_SCOPE")}
 private fun map(v:Any?):Map<String,Any?>{val m=v as? Map<*,*>?:throw NativeNetworkFailure("NETWORK_SCOPE");need(m.keys.all{it is String});return m.entries.associate{it.key as String to it.value}}
 private fun string(v:Any?)=v as? String?:throw NativeNetworkFailure("NETWORK_SCOPE")
 private fun parseState(v:Any?):NativeNetworkState{
  val m=map(v);need(m.keys==setOf("chainId","revision"));val n=m["revision"]
  need(n is Int||n is Long);val revision=(n as Number).toLong();need(revision in 0..Int.MAX_VALUE.toLong())
  return NativeNetworkState(string(m["chainId"]),revision.toInt())
 }
 fun snapshotWire(owner:String,scope:Map<String,String>):Map<String,Any?>{
  val s=state(owner,scope)
  return mapOf("network" to mapOf("chainId" to s.chainId,"revision" to s.revision),"sources" to lanes.mapValues{it.value.sourceIdentity},
   "lanes" to lanes.mapValues{it.value.wallet.snapshotWire(it.value.custody.snapshot(owner,scope))},"permissions" to permissions(owner,scope))
 }
 private fun publicEvents(owner:String,scope:Map<String,String>):List<Map<String,Any?>>{
  val s=state(owner,scope);val a=snapshot(owner,scope,s)
  return listOf(mapOf("name" to "permissionsChanged","payload" to permissions(owner,scope)),mapOf("name" to "accountsChanged","payload" to a.connectedAccounts.map{it.address}))
 }
 private fun remember(owner:String,scope:Map<String,String>,expected:NativeNetworkState,id:String,method:String,result:Any?,events:List<Map<String,Any?>>,check:()->Unit={}){
  val epochs=lanes.mapValues{it.value.custody.networkAuthority(scope.getValue("origin")).epoch}
  lanes.getValue(expected.chainId).wallet.rememberNetworkResult(owner,scope,id,method,result,events){
   sourceIdentity(owner,scope,expected);check()
   need(lanes.mapValues{it.value.custody.networkAuthority(scope.getValue("origin")).epoch}==epochs)
  }
 }
 fun allowDelivery(owner:String,scope:Map<String,String>,text:String):Boolean=runCatching{allowDelivery(owner,scope,state(owner,scope),text)}.getOrDefault(false)
 // Sole multi-network private channel entry. Page data cannot replace source
 // configuration, document identity or the original call's network stamp.
 fun dispatch(method:String,input:Any?,reply:(Map<String,Any?>)->Unit){
  onExecutor();var done=false
  fun respond(value:Map<String,Any?>){if(!done){done=true;reply(value)}}
  fun fail(error:Exception){
   val code=when(error){is NativeNetworkFailure->error.code;is NativeCustodyFailure->error.code;else->null}
   respond(mapOf("ok" to false,"code" to when(code){"NETWORK_REJECTED","USER_REJECTED"->"USER_REJECTED";"NETWORK_UNSUPPORTED"->"UNSUPPORTED_CHAIN";else->"NATIVE_DENIED"}))
  }
  try{
   val a=map(input);val owner=string(a["ownerId"]);val scope=map(a["scope"]).mapValues{string(it.value)}
   fun keys(vararg fields:String){need(a.keys==setOf("ownerId","scope","network")+fields)}
   fun id()=string(a["operation"])
   fun send(value:Any?,snapshot:Boolean=false){respond(mapOf("ok" to true,"value" to value)+(if(snapshot)mapOf("snapshot" to snapshotWire(owner,scope))else emptyMap()))}
   if(method=="network.snapshot"){need(a.keys==setOf("ownerId","scope"));send(snapshotWire(owner,scope));return}
   val expected=parseState(a["network"]);sourceIdentity(owner,scope,expected)
   when(method){
    "network.switch"->{
     keys("operation","chainId");val operation=id()
     switchChain(owner,scope,operation,string(a["chainId"]),expected){r->
      try{val c=r.getOrThrow();val events=(PermissionJson.decode(JSONArray(c.eventsJSON)) as List<*>).map{map(it)}
       remember(owner,scope,c.state,operation,"tbc_switchChain",null,events){requireDelivery(c)}
       send(events,true)
      }catch(e:Exception){fail(e)}
     }
    }
    "network.capabilities"->{
     keys("operation","chainId","address");val target=string(a["chainId"]);val lane=lanes[target]?:throw NativeNetworkFailure("NETWORK_UNSUPPORTED")
     if(a["address"]!=null)need(string(a["address"]) in lane.custody.networkAuthority(scope.getValue("origin")).visibleAddresses)
     val result=lane.wallet.networkCapabilities(owner,scope);remember(owner,scope,expected,id(),"tbc_getCapabilities",result,emptyList());send(result)
    }
    "permissions.request"->{
     keys("operation","permissions","providerMethod");val request=map(a["permissions"]);val provider=string(a["providerMethod"]);val operation=id()
     need(provider in setOf("tbc_requestAccounts","wallet_requestPermissions")&&request.isNotEmpty())
     val requests=mutableMapOf<String,MutableMap<String,Any?>>()
     for((method,value)in request){
      val options=map(value);val chains=(options["chains"] as? List<*>)?.map{string(it)}?:throw NativeNetworkFailure("NETWORK_SCOPE")
      need(chains.isNotEmpty()&&chains.size<=lanes.size&&chains.toSet().size==chains.size)
      for(chain in chains){
       if(chain !in lanes)throw NativeNetworkFailure("NETWORK_UNSUPPORTED")
       requests.getOrPut(chain){mutableMapOf()}[method]=options+mapOf("chains" to listOf(chain))
      }
     }
     need(provider!="tbc_requestAccounts"||requests.keys==setOf(expected.chainId))
     val complete:(Result<List<Map<String,Any?>>>)->Unit={r->
      try{val records=r.getOrThrow();val s=snapshot(owner,scope,expected);val events=publicEvents(owner,scope)
       remember(owner,scope,expected,operation,provider,if(provider=="tbc_requestAccounts")s.connectedAccounts.map{it.address}else records,events)
       send(records,true)
      }catch(e:Exception){fail(e)}
     }
     if(requests.size==1){val target=requests.keys.single();requestPermissions(owner,scope,operation,target,expected,requests.getValue(target),complete)}
     else requestPermissionGroup(owner,scope,operation,expected,requests,complete)
    }
    "permissions.disconnect"->{keys("operation");disconnect(owner,scope,id(),expected);remember(owner,scope,expected,id(),"tbc_disconnect",null,publicEvents(owner,scope));send(null,true)}
    "operation.cancel"->{keys("operation");val operation=id();cancelSwitch(owner,scope,operation);lanes.values.forEach{it.custody.cancel(owner,scope,operation)};send(null)}
    "document.invalidate"->{keys();invalidate(owner);send(null)}
    else->{
     if(method=="delivery.prepare"&&a["method"]=="wallet_getPermissions"){
      keys("method","requestId","serialized");val operation=PermissionJson.id("P4/rpc",scope.getValue("sessionId"),PermissionJson.canonical(a["requestId"]))
      remember(owner,scope,expected,operation,"wallet_getPermissions",permissions(owner,scope),emptyList())
     }
     dispatch(owner,scope,expected,method,a.filterKeys{it !in setOf("ownerId","scope","network")},::respond)
    }
   }
  }catch(e:Exception){fail(e)}
 }
}
