package io.tbc.kit.dart

import java.io.File
import org.json.JSONObject

private class Accounts(var selected:NativeAccount):NativeAccountSource {
 override val current get()=selected
 override var revision=0L
 override var unlocked=true
 var additional=emptyList<NativeAccount>();override val signingAccounts get()=listOf(current)+additional
}
private class MemoryBackend:NativePermissionBackend {
 var values=mutableMapOf<String,PermissionSnapshot>()
 private val commits=mutableMapOf<String,Pair<String,Long>>()
 var reads=0;var writes=0;var fail=false
 override fun loadAll():Map<String,PermissionSnapshot>{reads++;return values.toMap()}
 override fun commit(origin:String,expected:Long,records:List<Map<String,Any?>>,callId:String,meaning:String,fence:()->Unit):PermissionCommitResult{
  fence();check(!fail){"TEST_IO"}
  val current=values[origin]?:PermissionSnapshot(0,emptyList())
  commits[callId]?.let{check(it.first==meaning);fence();return PermissionCommitResult(it.second,current)}
  check(current.revision==expected){"TEST_CAS"};fence()
  val next=PermissionSnapshot(expected+1,PermissionJson.records(PermissionJson.canonical(records)))
  values[origin]=next;commits[callId]=meaning to next.revision;writes++
  return PermissionCommitResult(next.revision,next)
 }
}
private var checks=0
private fun yes(value:Boolean){check(value){"check ${checks+1}"};checks++}
private fun rejects(block:()->Unit){var rejected=false;try{block()}catch(_:Exception){rejected=true};yes(rejected)}
@Suppress("UNCHECKED_CAST")
fun main(args:Array<String>){
 val fixture=PermissionJson.decode(JSONObject(File(args[0]).readText())) as Map<String,Any?>
 val origin=fixture["origin"] as String;val account=fixture["account"] as Map<String,String>
 fun accounts(chain:String="tbc:testnet")=Accounts(NativeAccount(account.getValue("address"),account.getValue("publicKey"),chain))
 fun request(chain:String="tbc:testnet",sign:Boolean=false):Map<String,Any?> = buildMap{
  put("tbc_accounts",mapOf("chains" to listOf(chain),"maxAccounts" to 16))
  if(sign)put("tbc_signMessage",mapOf("chains" to listOf(chain)))
 }
 for(chain in listOf("tbc:mainnet","tbc:testnet")){
  val a=accounts(chain);val store=MemoryBackend();val events=mutableListOf<String?>();val p=NativePermissions(a,chain,store){events.add(it)}
  yes(p.records(origin).isEmpty());val proposal=p.proposal(origin,request(chain),"connect-$chain")
  yes(store.writes==0 && events.isEmpty());p.approve(proposal){}
  yes(p.permits(origin,"tbc_accounts") && !p.permits(origin,"tbc_signMessage"));yes(!p.permits("https://other.example","tbc_accounts"))
  repeat(20){p.permits(origin,"tbc_accounts")};yes(store.reads==1 && store.writes==1)
  val sign=p.proposal(origin,mapOf("tbc_signMessage" to mapOf("chains" to listOf(chain))),"sign-$chain");p.approve(sign){}
  p.require(origin,"tbc_signMessage");yes(store.writes==2)
  a.unlocked=false;yes(p.records(origin).isEmpty());rejects{p.require(origin,"tbc_signMessage")};a.unlocked=true
  a.selected=a.current.copy(address="different-selected-account");a.revision++;yes(p.records(origin).isEmpty())
  a.selected=accounts(chain).current;a.revision++;yes(p.permits(origin,"tbc_signMessage"))
  p.revoke(origin,"revoke-$chain"){};yes(p.records(origin).isEmpty())
  // Replaying a previously committed grant must observe the later revocation.
  yes(p.approve(sign.copy(accountRevision=a.revision)){}.isEmpty())
  yes(store.writes==3)
  a.selected=a.current.copy(chainId=if(chain=="tbc:mainnet")"tbc:testnet" else "tbc:mainnet")
  rejects{p.records(origin)}
 }
 run{
  val a=accounts();val store=MemoryBackend();val p=NativePermissions(a,"tbc:testnet",store){}
  val controller=NativeAccount("1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP","02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5","tbc:testnet")
  a.additional=listOf(controller)
  val single=p.proposal(origin,mapOf("tbc_accounts" to mapOf("chains" to listOf("tbc:testnet")),"tbc_signTransaction" to mapOf("chains" to listOf("tbc:testnet"))),"single")
  yes(single.accounts==listOf(a.current));p.approve(single){}
  rejects{p.require(origin,"tbc_signTransaction",controller)}
  val two=p.proposal(origin,request(),"two");yes(two.accounts==listOf(a.current,controller));p.approve(two){}
  yes(p.permits(origin,"tbc_accounts",controller));rejects{p.require(origin,"tbc_signTransaction",controller)}
  val sign=p.proposal(origin,mapOf("tbc_signTransaction" to mapOf("chains" to listOf("tbc:testnet"))),"two-sign");yes(sign.accounts==listOf(a.current,controller));p.approve(sign){}
  p.require(origin,"tbc_signTransaction",controller);yes(store.writes==3)
  repeat(20){p.require(origin,"tbc_signTransaction",controller)};yes(store.reads==1&&store.writes==3)
  rejects{p.require("https://other.example","tbc_signTransaction",controller)}
  val stale=p.proposal(origin,request(),"selection-stale")
  a.additional=emptyList();rejects{p.approve(stale){}};rejects{p.require(origin,"tbc_signTransaction",controller)};yes(store.writes==3)
  a.additional=listOf(controller);a.revision++
  val stable=p.proposal(origin,request(),"key-stale")
  a.additional=listOf(controller.copy(publicKey=a.current.publicKey))
  rejects{p.approve(stable){}};rejects{p.selectedAccounts()}
  a.additional=listOf(controller,controller);rejects{p.selectedAccounts()}
  a.additional=listOf(controller.copy(chainId="tbc:mainnet"));rejects{p.selectedAccounts()}
  a.additional=listOf(controller);p.revoke(origin,"two-revoke"){};rejects{p.require(origin,"tbc_signTransaction",controller)}
 }
 for(raw in fixture["invalidRequests"] as List<Map<String,Any?>>){
  val p=NativePermissions(accounts(),"tbc:testnet",MemoryBackend()){}
  rejects{p.proposal(origin,raw,"invalid")}
 }
 run{
  val a=accounts();val store=MemoryBackend();val p=NativePermissions(a,"tbc:testnet",store){}
  yes(!p.permits(origin,"tbc_switchChain"))
  val grant=p.proposal(origin,mapOf("tbc_accounts" to mapOf("chains" to listOf("tbc:testnet")),"tbc_switchChain" to mapOf("chains" to listOf("tbc:testnet"))),"switch-grant")
  p.approve(grant){};p.require(origin,"tbc_switchChain")
  yes(store.reads==1&&store.writes==1);rejects{p.require(origin,"tbc_signTransaction")}
  rejects{p.proposal(origin,mapOf("tbc_switchChain" to mapOf("chains" to listOf("tbc:mainnet"))),"foreign-switch")}
  p.revoke(origin,"revoke-switch"){};rejects{p.require(origin,"tbc_switchChain")}
 }
 run{
  val a=accounts();val store=MemoryBackend();val p=NativePermissions(a,"tbc:testnet",store){}
  val proposal=p.proposal(origin,request(),"stale");a.revision++;rejects{p.approve(proposal){}};yes(store.writes==0)
  val fresh=p.proposal(origin,request(),"cancelled");rejects{p.approve(fresh){error("CANCELLED")}};yes(store.writes==0)
 }
 run{
  val store=MemoryBackend();val events=mutableListOf<String?>();val p=NativePermissions(accounts(),"tbc:testnet",store){events.add(it)}
  val proposal=p.proposal(origin,request(),"io-fail");store.fail=true;rejects{p.approve(proposal){}}
  yes(store.writes==0 && events==listOf<String?>(null));rejects{p.records(origin)}
 }
 val maker=NativePermissions(accounts(),"tbc:testnet",MemoryBackend()){}
 val base=maker.proposal(origin,request(sign=true),"corruption-base").records
 for(kind in fixture["corruptions"] as List<String>){
  val records=PermissionJson.records(PermissionJson.canonical(base)).map{it.toMutableMap()}
  val p=records[0];val cs=(p["caveats"] as List<Map<String,Any?>>).map{it.toMutableMap()}.toMutableList()
  when(kind){
   "duplicate-caveat"->cs.add(cs[0].toMutableMap())
   "unknown-caveat"->cs.add(mutableMapOf("type" to "unknown","value" to true))
   "expiry-number"->cs.add(mutableMapOf("type" to "expiresAt","value" to 12))
   "expiry-null"->cs.add(mutableMapOf("type" to "expiresAt","value" to null))
   "expiry-invalid"->cs.add(mutableMapOf("type" to "expiresAt","value" to "invalid"))
   "account-non-string"->cs.first{it["type"]=="restrictAccounts"}["value"]=listOf(accounts().current.accountId,7)
   "wrong-origin"->p["invoker"]="https://other.example"
   "wrong-chain"->cs.first{it["type"]=="restrictChains"}["value"]=listOf("tbc:mainnet")
   else->error("UNKNOWN_TEST")
  };p["caveats"]=cs
  val store=MemoryBackend();store.values[origin]=PermissionSnapshot(1,records)
  val permission=NativePermissions(accounts(),"tbc:testnet",store){}
  rejects{permission.records(origin)}
 }
 println("{\"platform\":\"kotlin-jvm\",\"checks\":$checks,\"status\":\"PASS\",\"androidSQLiteExercised\":false}")
}
