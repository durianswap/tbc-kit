// Operation-bound adapter for the shared Dart broadcast port/client. Native
// owns the exact selection, SQLite admission and HTTP dispatch; Dart owns the
// existing node response codec. No raw bytes or admission are persisted/exposed
// to a page. All calls, start and callbacks run on the custody executor.
import Foundation
import CryptoKit

@MainActor final class NativeBroadcastDispatch {
 typealias Sender = (NativeBroadcastHTTPRequest,()throws->Void,@escaping @MainActor (Result<NativeBroadcastHTTPResponse,NativeBroadcastHTTPFailure>)->Void)throws->(@Sendable ()->Void)
 private let store:SystemBroadcastStore,apiOrigin:String,requireCurrent:()throws->Void,send:Sender
 private let callHash:String,transactions:[[String:Any]],batch:Bool,expiresAt:Date
 let identities:[NativeBroadcastIdentity]
 private var ticket:NativeBroadcastAdmission?,active=[UUID:@Sendable ()->Void]()
 private var observed=Set<String>(),created=false,closed=false,started=false
 private static func need(_ yes:Bool)throws{if !yes{throw BroadcastStoreFailure(code:"BROADCAST_DISPATCH_SCOPE")}}
 private static func hash(_ value:Any)throws->String{sha(Data(try PermissionJSON.canonical(value).utf8))}
 private static func sha(_ value:Data)->String{SHA256.hash(data:value).map{String(format:"%02x",$0)}.joined()}
 private static func raw(_ value:String)throws->Data{
  try need(value.count<=4*1024*1024 && value.range(of:"^(?:[0-9a-f]{2})+$",options:.regularExpression) != nil)
  var data=Data();data.reserveCapacity(value.count/2);var i=value.startIndex
  while i<value.endIndex{let next=value.index(i,offsetBy:2);data.append(UInt8(value[i..<next],radix:16)!);i=next};return data
 }
 // call is a private shared-worker Host call. It cannot replace any approved
 // transaction or source. Its IDs are bound into the native journal identity.
 init(store:SystemBroadcastStore,apiOrigin:String,chainId:String,call:[String:Any],
      selection selected:[String:Any],requireCurrent:@escaping ()throws->Void,send:@escaping Sender)throws{
  self.store=store;self.apiOrigin=apiOrigin;self.requireCurrent=requireCurrent;self.send=send
  try requireCurrent();callHash=try Self.hash(call)
  guard let txs=selected["transactions"] as? [[String:Any]],let expiry=selected["expiresAt"] as? String,
   let method=selected["method"] as? String,let p=call["params"] as? [String:Any],let key=p["idempotencyKey"] as? String,
   let callId=call["callId"] as? String,!callId.isEmpty,callId.utf8.count<=256,
   let execution=call["execution"] as? [String:Any] else{throw BroadcastStoreFailure(code:"BROADCAST_DISPATCH_SCOPE")}
  batch=["tbc_sendWorkflow","tbc_sendPreparedWorkflow"].contains(method);transactions=txs
  let f=ISO8601DateFormatter();f.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
  let plain=ISO8601DateFormatter()
  guard let end=f.date(from:expiry) ?? plain.date(from:expiry)else{throw BroadcastStoreFailure(code:"BROADCAST_DISPATCH_SCOPE")};expiresAt=end
  try Self.need(Set(call.keys)==["callId","operation","params","execution"] && ["session-only","durable"].contains(execution["type"] as? String ?? ""))
  try Self.need(selected["sourceIdentity"] as? String==store.sourceIdentity && selected["accountScopeHash"] as? String==store.accountScopeHash)
  try Self.need(NativePrepared.sends(method) && (1...32).contains(txs.count) && (batch || txs.count==1))
  let operation=batch ? "broadcast.submitBatch":"broadcast.submit"
  try Self.need(call["operation"] as? String==operation && Set(p.keys)==["version","chainId",batch ? "transactions":"transaction","idempotencyKey"] && p["version"] as? String=="1.0" && p["chainId"] as? String==chainId && ["tbc:mainnet","tbc:testnet"].contains(chainId) && !key.isEmpty && key.utf8.count<=256)
  try Self.need(PermissionJSON.canonical(p[batch ? "transactions":"transaction"])==PermissionJSON.canonical(batch ? txs as Any:txs[0] as Any))
  let prefix="tbcnet-"+store.sourceIdentity.prefix(24)+"-",isBatch=batch
  identities=try txs.enumerated().map{i,tx in
   guard let raw=tx["rawTransaction"] as? String,let txid=tx["txid"] as? String else{throw BroadcastStoreFailure(code:"BROADCAST_DISPATCH_SCOPE")}
   // Native completedBundle already checked TBC's header-derived transaction
   // ID. Reuse that immutable result; only the journal raw-hash is new here.
   let bytes=try Self.raw(raw),hash=Self.sha(bytes)
   let base=isBatch ? "\(key):\(i)":key
   var context:[String:Any]=["version":"1.0","callId":callId,"operation":operation,"params":p];if isBatch{context["index"]=i}
   return NativeBroadcastIdentity(idempotencyKey:base.hasPrefix(prefix) ? base:prefix+(try Self.hash(["idempotencyKey":base])),rawHash:hash,txid:txid,submitContextHash:try Self.hash(context),accountScopeHash:store.accountScopeHash)
  }
  for id in identities{try id.validate(source:store.sourceIdentity,account:store.accountScopeHash)}
  try Self.need(Set(identities.map{$0.txid}).count==txs.count)
  // Validate the native fixed HTTPS origin before any reservation is created.
  _ = try NativeBroadcastHTTPRequest.validated(sourceIdentity:store.sourceIdentity,apiOrigin:apiOrigin,method:"POST",path:batch ? "/api/tbc/broadcasttxs":"/api/tbc/broadcasttx",body:"{}",deadline:end)
  try fence()
 }
 private func fence()throws{
  try Self.need(!closed && Date()<expiresAt)
  try requireCurrent()
 }
 func guardCall(_ call:[String:Any])throws{try fence();try Self.need(Self.hash(call)==callHash)}
 private func owned(_ ids:[NativeBroadcastIdentity])throws{try Self.need(ids==identities)}
 func begin(_ ids:[NativeBroadcastIdentity])throws->NativeBroadcastReservation{
  try fence();try owned(ids);let r=try store.begin(identities,fence:fence);created = created || r.created;return r
 }
 func read(_ key:String)throws->NativeBroadcastRecord?{
  try fence();try Self.need(identities.contains{$0.idempotencyKey==key});return try store.read(key)
 }
 func readByTxids(_ txids:[String])throws->[NativeBroadcastRecord]{
  try fence();try Self.need(!txids.isEmpty && txids.allSatisfy{tx in identities.contains{$0.txid==tx}})
  let rows=try store.readByTxids(txids);try Self.need(rows.allSatisfy{identities.contains($0.identity)});return rows
 }
 func admit(_ ids:[NativeBroadcastIdentity])throws{
  try fence();try owned(ids);try Self.need(created && ticket==nil && !started)
  ticket=try store.admitDispatch(identities,fence:fence)
 }
 func abortPreflight(_ id:NativeBroadcastIdentity,code:String)throws{
  try fence();try Self.need(created && identities.contains(id) && ticket==nil && !started && ["INVALID_INPUT","NODE_RESPONSE_INVALID"].contains(code))
  try store.abortPrepared([id],code:code,fence:fence)
 }
 // Only the shared package codec may classify a response that this native
 // adapter has actually returned. This is not an untrusted page status API.
 func complete(_ id:NativeBroadcastIdentity,status:String)throws{
  try fence();try Self.need(identities.contains(id) && observed.contains(id.txid))
  try store.complete(id,status:status,fence:fence)
 }
 // Native-only terminal projection. Prepared/admitted/in-flight is NOT an
 // unknown result. An uncertain row proves entry into the dispatch window,
 // including a previous attempt; it is never permission to submit again.
 func deliveryState()throws->[[String:String]]{
  try fence();try Self.need(ticket==nil && active.isEmpty)
  return try identities.map{id in
   guard let row=try store.read(id.idempotencyKey)else{throw BroadcastStoreFailure(code:"BROADCAST_DISPATCH_SCOPE")}
   try Self.need(row.identity==id && ["uncertain","completed"].contains(row.state))
   let status=row.state=="uncertain" ? "unknown":row.resultStatus ?? ""
   try Self.need(["accepted","known","rejected","unknown"].contains(status))
   return ["txid":id.txid,"status":status]
  }
 }
 func wire(method:String,url:String,body:String?,deadline:Date?=nil,complete:@escaping @MainActor (Result<NativeBroadcastHTTPResponse,NativeBroadcastHTTPFailure>)->Void)throws{
  try fence()
  if let deadline{try Self.need(deadline>Date())}
  let path:String,ids:[String]
  if method=="POST"{
   path=batch ? "/api/tbc/broadcasttxs":"/api/tbc/broadcasttx";ids=identities.map{$0.txid}
   let expected:Any=batch ? transactions.map{["txraw":$0["rawTransaction"]!]} as Any:["txraw":transactions[0]["rawTransaction"]!] as Any
   try Self.need(ticket != nil && !started && body==PermissionJSON.canonical(expected))
  }else{
   try Self.need(method=="GET" && body==nil)
   guard let id=identities.first(where:{url==apiOrigin+"/api/tbc/decode/txid/"+$0.txid}),let row=try store.read(id.idempotencyKey) else{throw BroadcastStoreFailure(code:"BROADCAST_DISPATCH_SCOPE")}
   try Self.need(row.identity==id && ["uncertain","completed"].contains(row.state))
   path="/api/tbc/decode/txid/"+id.txid;ids=[id.txid]
  }
  try Self.need(url==apiOrigin+path && active.count<32)
  let request=try NativeBroadcastHTTPRequest.validated(sourceIdentity:store.sourceIdentity,apiOrigin:apiOrigin,method:method,path:path,body:body,deadline:min(expiresAt,deadline ?? Date().addingTimeInterval(15),Date().addingTimeInterval(15)))
  let token=UUID()
  let callback:@MainActor (Result<NativeBroadcastHTTPResponse,NativeBroadcastHTTPFailure>)->Void={ [weak self] response in
   guard let self else{complete(.failure(NativeBroadcastHTTPFailure(code:"NODE_REQUEST_FAILED")));return}
   self.active.removeValue(forKey:token)
   do{try self.fence();if case .success=response{self.observed.formUnion(ids)};complete(response)}
   catch{complete(.failure(NativeBroadcastHTTPFailure(code:"NODE_REQUEST_FAILED")))}
  }
  if method=="POST"{
   let admission=ticket!;ticket=nil
   active[token]=try store.startAdmission(admission,fence:fence){started=true;return try send(request,fence,callback)}
  }else{active[token]=try send(request,fence,callback)}
 }
 func close(){
  guard !closed else{return};closed=true
  if let admission=ticket{ticket=nil;try? store.cancelAdmission(admission)}
  // This owner can retire only reservations it created before dispatch.
  if created && !started{for id in identities{if (try? store.read(id.idempotencyKey)?.state)=="prepared"{try? store.abortPrepared([id],code:"CANCELLED",fence:{})}}}
  let cancel=Array(active.values);active.removeAll();for f in cancel{f()}
 }
}

extension NativeCustody {
 func makeBroadcastDispatch(owner:String,scope:[String:String],id:String,receipt:[String:Any],index:Int?,
  store:SystemBroadcastStore,apiOrigin:String,chainId:String,call:[String:Any],onClose:@escaping ()->Void={},send:@escaping NativeBroadcastDispatch.Sender)throws->NativeBroadcastDispatch{
  let selected=try broadcastSelection(owner:owner,scope:scope,id:id,receipt:receipt,index:index)
  let authorization=selected["authorizationId"] as! String
  let adapter=try NativeBroadcastDispatch(store:store,apiOrigin:apiOrigin,chainId:chainId,call:call,selection:selected,requireCurrent:{[weak self] in
   guard let self else{throw NativeCustodyFailure(code:"NATIVE_OPERATION_GONE")}
   try self.broadcastCurrent(owner:owner,scope:scope,id:id,receipt:receipt,authorizationId:authorization)
  },send:send)
  try ownBroadcast(owner:owner,scope:scope,id:id,key:index.map{"single:\($0)"} ?? "batch",state:{try adapter.deliveryState()},close:{adapter.close();onClose()},recoveryId:adapter.identities.first?.idempotencyKey)
  return adapter
 }
}
