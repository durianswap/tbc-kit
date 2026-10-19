package io.tbc.kit.dart

/** Native registration only; a private call cannot install a custody profile. */
class NativeProtocolLane(val wallet:NativeWalletHost,val network:NativeNetworkWalletRouter?=null){
 val walletProtocol get()=wallet.walletProtocol
 init{check(network==null||network.walletProtocol==walletProtocol){"PERMISSION_PROTOCOL"}}
 fun navigation(owner:String,scope:Map<String,String>){if(network!=null)network.navigation(owner,scope)else wallet.navigation(owner,scope)}
 fun invalidate(owner:String){if(network!=null)network.invalidate(owner)else wallet.invalidate(owner)}
 fun accountChanged(){if(network!=null)network.accountChanged()else wallet.accountChanged()}
 fun dispatch(method:String,input:Map<String,Any?>,reply:(Map<String,Any?>)->Unit){if(network!=null)network.dispatch(method,input,reply)else wallet.dispatch(method,input,reply)}
 fun allowDelivery(owner:String,scope:Map<String,String>,text:String)=network?.allowDelivery(owner,scope,text)?:wallet.allowDelivery(owner,scope,text)
}

class NativeProtocolWalletRouter(standard:NativeProtocolLane,legacy:NativeProtocolLane?=null){
 private val lanes:Map<NativeWalletProtocol,NativeProtocolLane>
 private val owners=mutableSetOf<String>();private var closed=false
 init{
  check(standard.walletProtocol==NativeWalletProtocol.STANDARD&&(legacy==null||legacy.walletProtocol==NativeWalletProtocol.LEGACY)){"PERMISSION_PROTOCOL"}
  lanes=if(legacy==null)mapOf(NativeWalletProtocol.STANDARD to standard)else mapOf(NativeWalletProtocol.STANDARD to standard,NativeWalletProtocol.LEGACY to legacy)
 }
 fun navigation(owner:String,scope:Map<String,String>){
  check(!closed&&(owner in owners||owners.size<8)){"NATIVE_DENIED"}
  try{lanes.values.forEach{it.navigation(owner,scope)};owners+=owner}catch(error:Exception){invalidate(owner);throw error}
 }
 fun invalidate(owner:String){lanes.values.forEach{it.invalidate(owner)};owners-=owner}
 fun accountChanged(){if(!closed)lanes.values.forEach{it.accountChanged()}}
 fun close(){if(closed)return;closed=true;owners.toList().forEach(::invalidate);lanes.values.forEach{it.network?.close()}}
 fun dispatch(method:String,input:Any?,reply:(Map<String,Any?>)->Unit){
  val raw=input as? Map<*,*>
  if(closed||raw==null||raw.keys.any{it !is String}){reply(mapOf("ok" to false,"code" to "NATIVE_DENIED"));return}
  val selected=if("walletProtocol" !in raw)NativeWalletProtocol.STANDARD else lanes.keys.firstOrNull{it.namespace==raw["walletProtocol"]}
  val lane=lanes[selected]
  if(lane==null){reply(mapOf("ok" to false,"code" to "NATIVE_DENIED"));return}
  lane.dispatch(method,raw.filterKeys{it!="walletProtocol"}.entries.associate{it.key as String to it.value},reply)
 }
 fun allowDelivery(owner:String,scope:Map<String,String>,text:String,walletProtocol:NativeWalletProtocol=NativeWalletProtocol.STANDARD):Boolean{
  // Native delivery operation selects the lane. It checks the shared result
  // before page-only historical DTO mapping, without a second JSON parse.
  return !closed&&lanes[walletProtocol]?.allowDelivery(owner,scope,text)==true
 }
}
