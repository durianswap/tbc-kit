import Foundation

/// Native-owned registration only. A private call chooses an already installed
/// lane; it cannot change a custody profile or borrow another lane's grants.
@MainActor struct NativeProtocolLane {
 let wallet:NativeWalletHost,network:NativeNetworkWalletRouter?
 var walletProtocol:NativeWalletProtocol{wallet.walletProtocol}
 init(wallet:NativeWalletHost,network:NativeNetworkWalletRouter?=nil)throws{
  try permissionNeed(network==nil || network?.walletProtocol==wallet.walletProtocol,"PERMISSION_PROTOCOL")
  self.wallet=wallet;self.network=network
 }
 func navigation(owner:String,scope:[String:String])throws{
  if let network{try network.navigation(owner:owner,scope:scope)}else{try wallet.navigation(owner:owner,scope:scope)}
 }
 func invalidate(owner:String){if let network{network.invalidate(owner:owner)}else{wallet.invalidate(owner:owner)}}
 func accountChanged(){if let network{network.accountChanged()}else{wallet.accountChanged()}}
 func dispatch(method:String,input:[String:Any],reply:@escaping @MainActor ([String:Any])->Void){
  if let network{network.dispatch(method:method,input:input,reply:reply)}else{wallet.dispatch(method:method,input:input,reply:reply)}
 }
 func allowDelivery(owner:String,scope:[String:String],text:String)->Bool{
  network?.allowDelivery(owner:owner,scope:scope,text:text) ?? wallet.allowDelivery(owner:owner,scope:scope,text:text)
 }
}

@MainActor final class NativeProtocolWalletRouter {
 private let lanes:[NativeWalletProtocol:NativeProtocolLane]
 private var owners=Set<String>(),closed=false
 init(standard:NativeProtocolLane,legacy:NativeProtocolLane?=nil)throws{
  try permissionNeed(standard.walletProtocol == .standard && (legacy==nil || legacy?.walletProtocol == .legacy),"PERMISSION_PROTOCOL")
  var configured:[NativeWalletProtocol:NativeProtocolLane]=[.standard:standard]
  if let legacy{configured[.legacy]=legacy};lanes=configured
 }
 func navigation(owner:String,scope:[String:String])throws{
  try permissionNeed(!closed && (owners.contains(owner) || owners.count<8),"NATIVE_DENIED")
  do{for lane in lanes.values{try lane.navigation(owner:owner,scope:scope)};owners.insert(owner)}
  catch{invalidate(owner:owner);throw error}
 }
 func invalidate(owner:String){for lane in lanes.values{lane.invalidate(owner:owner)};owners.remove(owner)}
 func accountChanged(){if !closed{for lane in lanes.values{lane.accountChanged()}}}
 func close(){guard !closed else{return};closed=true;for owner in Array(owners){invalidate(owner:owner)};for lane in lanes.values{lane.network?.close()}}
 func dispatch(method:String,input:Any?,reply:@escaping @MainActor ([String:Any])->Void){
  guard !closed,var args=input as? [String:Any]else{reply(["ok":false,"code":"NATIVE_DENIED"]);return}
  let selected:NativeWalletProtocol
  if let raw=args.removeValue(forKey:"walletProtocol"){
   guard let name=raw as? String,let protocolId=NativeWalletProtocol(rawValue:name)else{reply(["ok":false,"code":"NATIVE_DENIED"]);return}
   selected=protocolId
  }else{selected = .standard}
  guard let lane=lanes[selected]else{reply(["ok":false,"code":"NATIVE_DENIED"]);return}
  lane.dispatch(method:method,input:args,reply:reply)
 }
 func allowDelivery(owner:String,scope:[String:String],text:String,walletProtocol:NativeWalletProtocol = .standard)->Bool{
  // Native selects this lane from its delivery operation, not a page field.
  // The same host validates canonical execution results before the page maps
  // them to historical DTOs. No duplicate parse of complete signed bundles.
  guard !closed else{return false}
  return lanes[walletProtocol]?.allowDelivery(owner:owner,scope:scope,text:text) ?? false
 }
}
