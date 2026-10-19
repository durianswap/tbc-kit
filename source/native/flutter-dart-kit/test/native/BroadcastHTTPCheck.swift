// Test-only loopback requests with real Foundation HTTP and system SQLite.
// Public synthetic bytes, no wallet/device UI/private key or blockchain node.
import Foundation

@main private struct BroadcastHTTPCheck {
 @MainActor static var checks=0
 @MainActor static var cases=[String](),responses=[[String:Any]]()
 @MainActor static func yes(_ b:Bool){precondition(b,"check \(checks+1)");checks+=1}
 @MainActor static func rejects(_ f:()throws->Void){var failed=false;do{try f()}catch{failed=true};yes(failed)}
 @MainActor static func main()async throws{
  let origin=CommandLine.arguments[1],root=URL(fileURLWithPath:CommandLine.arguments[2])
  let source=String(repeating:"a",count:64),account=String(repeating:"b",count:64)
  let http=try NativeBroadcastHTTP(sourceIdentity:source)
  let store=try SystemBroadcastStore(directory:root,profile:"wire",sourceIdentity:source,accountScopeHash:account)
  defer{store.close()}
  let expiry=Date().addingTimeInterval(15)
  let valid=try NativeBroadcastHTTPRequest.validated(sourceIdentity:source,apiOrigin:"https://api.tbcdev.org",method:"POST",path:"/api/tbc/broadcasttx",body:"{}",deadline:expiry)
  yes(valid.url.absoluteString=="https://api.tbcdev.org/api/tbc/broadcasttx")
  for base in [origin,"https://user:password@api.tbcdev.org","https://api.tbcdev.org/","https://api.tbcdev.org?bad","https://api.tbcdev.org#bad"]{
   rejects{_ = try NativeBroadcastHTTPRequest.validated(sourceIdentity:source,apiOrigin:base,method:"POST",path:"/api/tbc/broadcasttx",body:"{}",deadline:expiry)}
  }
  for (method,path,body) in [("POST","/other",Optional("{}")),("GET","/api/tbc/broadcasttx",nil),("GET","/api/tbc/decode/txid/"+String(repeating:"1",count:64),Optional("{}"))]{
   rejects{_ = try NativeBroadcastHTTPRequest.validated(sourceIdentity:source,apiOrigin:"https://api.tbcdev.org",method:method,path:path,body:body,deadline:expiry)}
  }
  cases.append("native-request-fixed-https-source-and-path")
  var count=0
  func request(_ path:String,_ method:String="POST",_ seconds:Double=5,_ maximum:Int=4096)->NativeBroadcastHTTPRequest{
   NativeBroadcastHTTPRequest(sourceIdentity:source,method:method,url:URL(string:origin+path)!,body:method=="POST" ? Data("{\"publicFixture\":true}".utf8):nil,deadline:Date().addingTimeInterval(seconds),maximumResponseBytes:maximum)
  }
  func identity(_ n:Int)->NativeBroadcastIdentity{NativeBroadcastIdentity(idempotencyKey:"tbcnet-"+source.prefix(24)+"-wire-\(n)",rawHash:String(format:"%064x",n),txid:String(format:"%064x",n+100),submitContextHash:source,accountScopeHash:account)}
  func run(_ name:String,_ path:String,method:String="POST",timeout:Double=5,cancel:Bool=false,failFence:Bool=false)async throws->Result<NativeBroadcastHTTPResponse,NativeBroadcastHTTPFailure>{
   count+=1;let id=identity(count),wire=request(path,method,timeout)
   let ticket:NativeBroadcastAdmission?
   if method=="POST"{_ = try store.begin([id]){};ticket=try store.admitDispatch([id]){}}else{ticket=nil}
   var completions=0
   let result:Result<NativeBroadcastHTTPResponse,NativeBroadcastHTTPFailure>=await withCheckedContinuation{resume in
    do{
     let start={@MainActor ()throws->(@Sendable ()->Void) in
      try http.start(wire,fence:{if failFence{throw NativeBroadcastHTTPFailure(code:"TEST_REVOKED")}}){r in completions+=1;yes(completions==1);resume.resume(returning:r)}
     }
     let handle=try ticket.map{try store.startAdmission($0,fence:{if failFence{throw NativeBroadcastHTTPFailure(code:"TEST_REVOKED")}},start:start)} ?? start()
     if cancel{Task{try? await Task.sleep(nanoseconds:30_000_000);handle()}}
    }catch{resume.resume(returning:.failure(NativeBroadcastHTTPFailure(code:(error as? NativeBroadcastHTTPFailure)?.code ?? "TEST_START_FAILED")))}
   }
   let state=try store.read(id.idempotencyKey)?.state
   if method=="POST"{yes(state==(failFence ? "not-submitted":"uncertain"))}
   if let ticket{rejects{_ = try store.startAdmission(ticket,fence:{},start:{fatalError("must not retry")})}}
   switch result{
   case .success(let value):responses.append(["name":name,"status":value.status,"bytes":value.body.count,"state":state ?? "none"])
   case .failure(let e):responses.append(["name":name,"error":e.code,"state":state ?? "none"])
   }
   cases.append(name);return result
  }
  yes(try await run("post-ok","/ok").get().status==200)
  yes(try await run("post-redirect-no-follow","/redirect").get().status==307)
  yes(try await run("status-not-found","/not-found",method:"GET").get().status==404)
  let auth=try await run("auth-no-replay","/auth")
  if case .success(let r)=auth{yes(r.status==401)}else if case .failure(let e)=auth{yes(e.code=="NODE_REQUEST_FAILED")}
  for (name,path,timeout,cancel,code) in [
   ("oversize-declared","/large-header",5.0,false,"NODE_RESPONSE_INVALID"),
   ("oversize-streamed","/large-stream",5.0,false,"NODE_RESPONSE_INVALID"),
   ("deadline","/slow",0.2,false,"NODE_REQUEST_FAILED"),
   ("cancel-after-start","/slow-cancel",5.0,true,"NODE_REQUEST_FAILED"),
   ("drop-after-post","/drop",5.0,false,"NODE_REQUEST_FAILED")]{
   let r=try await run(name,path,timeout:timeout,cancel:cancel)
   if case .failure(let e)=r{yes(e.code==code)}else{yes(false)}
  }
  let denied=try await run("revoke-before-start","/forbidden",failFence:true)
  if case .failure(let e)=denied{yes(e.code=="TEST_REVOKED")}else{yes(false)}
  rejects{_ = try http.start(request("/expired","POST",-1),fence:{}){_ in fatalError("expired dispatched")}}
  cases.append("expired-before-start")
  let foreign=NativeBroadcastHTTPRequest(sourceIdentity:account,method:"POST",url:URL(string:origin+"/foreign")!,body:Data("{}".utf8),deadline:expiry)
  rejects{_ = try http.start(foreign,fence:{}){_ in fatalError("foreign dispatched")}}
  cases.append("foreign-source-before-start")
  // Allow delayed server writes to observe that timeout/cancel cannot deliver
  // a second result. No sleeps on the native authority executor itself.
  try await Task.sleep(nanoseconds:700_000_000)
  print(String(data:try JSONSerialization.data(withJSONObject:["status":"PASS","checks":checks,"cases":cases,"responses":responses],options:.sortedKeys),encoding:.utf8)!)
 }
}
