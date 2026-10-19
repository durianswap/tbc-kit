package io.tbc.kit.dart

import java.io.File
import org.json.JSONObject

private class NetworkFixture(data:Map<String,Any?>){
 @Suppress("UNCHECKED_CAST") val scope=data["scope"] as Map<String,String>
 var time=(data["nowMillis"] as Number).toLong();var active=true
 val epochs=mutableMapOf("tbc:mainnet" to "0","tbc:testnet" to "0");val locked=mutableSetOf<String>();val ungranted=mutableSetOf<String>()
 var fences=0;var failFence=false;var changedInFence=false
 val networks=NativeNetworkSessions(mapOf("tbc:mainnet" to "1".repeat(64),"tbc:testnet" to "2".repeat(64)),{_,s->active&&s==scope},{chain,_->
  val address=if(chain=="tbc:mainnet")"main-address" else "test-address"
  NativeNetworkAuthority(epochs.getValue(chain),chain !in locked,if(chain in ungranted)emptyList()else listOf("$chain:$address"),listOf(address))
 },{_,_->fences++;if(failFence)throw NativeNetworkFailure("FIXTURE_FENCE");if(changedInFence)epochs["tbc:mainnet"]="changed"},{time})
 init{networks.navigation("view",scope,"tbc:testnet")}
 fun proposal(id:String="operation",target:String="tbc:mainnet",revision:Int=0)=networks.prepare("view",scope,id,target,revision)
 fun state()=networks.state("view",scope)
}
private var networkChecks=0
private fun yes(v:Boolean){check(v){"check ${networkChecks+1}"};networkChecks++}
private fun rejects(code:String?=null,block:()->Unit){var failure:Exception?=null;try{block()}catch(e:Exception){failure=e};check(failure!=null){"Expected rejection"};if(code!=null)yes((failure as? NativeNetworkFailure)?.code==code)else networkChecks++}
@Suppress("UNCHECKED_CAST")
fun main(args:Array<String>){
 val data=PermissionJson.decode(JSONObject(File(args[0]).readText())) as Map<String,Any?>
 run{
  val f=NetworkFixture(data);val p=f.proposal()
  for((value,key)in listOf(p.proposalJSON to "proposal",p.bindingJSON to "binding",p.previewJSON to "preview"))yes(value==PermissionJson.canonical(data[key]))
  yes(f.state()==NativeNetworkState("tbc:testnet",0));yes(f.fences==0)
  val result=f.networks.commit(p,true);yes(result.state==NativeNetworkState("tbc:mainnet",1));yes(f.fences==1)
  yes(result.eventsJSON==PermissionJson.canonical(data["expectedEvents"]));f.networks.requireDelivery(result)
  rejects{f.networks.requireState("view",f.scope,p.from)};yes(f.networks.requireState("view",f.scope,result.state)=="1".repeat(64))
  rejects{f.networks.commit(p,true)};rejects{f.proposal("operation","tbc:testnet",1)}
  f.epochs["tbc:mainnet"]="1";rejects{f.networks.requireDelivery(result)}
 }
 run{val f=NetworkFixture(data);val p=f.proposal("noop","tbc:testnet");val c=f.networks.commit(p,false);yes(c.state.revision==0&&c.eventsJSON=="[]"&&f.fences==0)}
 run{val f=NetworkFixture(data);val p=f.proposal();rejects("NETWORK_REJECTED"){f.networks.commit(p,false)};yes(f.state().chainId=="tbc:testnet"&&f.fences==0)}
 for(kind in listOf("lock-source","lock-target","revoke-target","epoch-source","epoch-target","expiry","navigation","cancel","fence-fail","fence-change")){
  val f=NetworkFixture(data);val p=f.proposal()
  when(kind){
   "lock-source"->f.locked+="tbc:testnet"
   "lock-target"->f.locked+="tbc:mainnet"
   "revoke-target"->f.ungranted+="tbc:mainnet"
   "epoch-source"->f.epochs["tbc:testnet"]="1"
   "epoch-target"->f.epochs["tbc:mainnet"]="1"
   "expiry"->f.time+=120000
   "navigation"->f.active=false
   "cancel"->f.networks.cancel("view",f.scope,p.operation)
   "fence-fail"->f.failFence=true
   "fence-change"->f.changedInFence=true
  }
  rejects{f.networks.commit(p,true)};f.active=true;yes(f.state().chainId=="tbc:testnet")
 }
 run{val f=NetworkFixture(data);f.ungranted+="tbc:mainnet";rejects("NETWORK_UNAUTHORIZED"){f.proposal()};rejects("NETWORK_UNSUPPORTED"){f.proposal("bad","tbc:other")}}
 run{val f=NetworkFixture(data);val a=f.proposal("a");val b=f.proposal("b");val c=f.networks.commit(a,true);rejects{f.networks.commit(b,true)};f.networks.requireDelivery(c);yes(f.fences==1)}
 run{val f=NetworkFixture(data);f.networks.navigation("other",f.scope,"tbc:testnet");f.networks.commit(f.proposal(),true);yes(f.networks.state("other",f.scope).chainId=="tbc:testnet")}
 run{val f=NetworkFixture(data);val p=f.proposal();f.networks.invalidate("view");rejects{f.networks.commit(p,true)};yes(f.fences==1)}
 run{val f=NetworkFixture(data);val p=f.proposal();f.networks.navigation("view",f.scope,"tbc:testnet");rejects{f.networks.commit(p,true)}}
 println("{\"status\":\"NETWORK_SESSION_CAS_PASS\",\"checks\":$networkChecks,\"broadcasts\":0}")
}
