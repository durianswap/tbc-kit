// Wallet-private bounded wire transport. No node codec, retry, permission,
// signer, journal or page/Flutter route. The native owner prepares this request
// from its fixed source and approved bytes, then starts inside its one-use
// SystemBroadcastStore admission on the SAME authority executor.
import Foundation

struct NativeBroadcastHTTPFailure:Error,Sendable {let code:String}
struct NativeBroadcastHTTPResponse:Sendable {let status:Int,body:Data}
struct NativeBroadcastHTTPRequest:Sendable {
 let sourceIdentity:String,method:String,url:URL,body:Data?,deadline:Date
 let maximumResponseBytes:Int
 // Internal value, not a serializable page capability. Production callers use
 // validated(); tests may inject a loopback wire request into the transport.
 init(sourceIdentity:String,method:String,url:URL,body:Data?,deadline:Date,maximumResponseBytes:Int=4*1024*1024){
  self.sourceIdentity=sourceIdentity;self.method=method;self.url=url;self.body=body;self.deadline=deadline;self.maximumResponseBytes=maximumResponseBytes
 }
 static func validated(sourceIdentity:String,apiOrigin:String,method:String,path:String,body:String?,deadline:Date)throws->Self {
  func need(_ b:Bool)throws{if !b{throw NativeBroadcastHTTPFailure(code:"BROADCAST_WIRE_REQUEST")}}
  try need(sourceIdentity.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil)
  guard let origin=URLComponents(string:apiOrigin),let host=origin.host,!host.isEmpty else{throw NativeBroadcastHTTPFailure(code:"BROADCAST_WIRE_REQUEST")}
  try need(origin.scheme=="https" && origin.user==nil && origin.password==nil && origin.query==nil && origin.fragment==nil && origin.path.isEmpty && origin.string==apiOrigin)
  let post=method=="POST" && ["/api/tbc/broadcasttx","/api/tbc/broadcasttxs"].contains(path)
  let read=method=="GET" && path.range(of:"^/api/tbc/decode/txid/[0-9a-f]{64}$",options:.regularExpression) != nil
  let bytes=body.map{Data($0.utf8)}
  try need((post && bytes != nil && !bytes!.isEmpty && bytes!.count<=128*1024*1024) || (read && bytes==nil))
  guard let url=URL(string:apiOrigin+path) else{throw NativeBroadcastHTTPFailure(code:"BROADCAST_WIRE_REQUEST")}
  return Self(sourceIdentity:sourceIdentity,method:method,url:url,body:bytes,deadline:deadline)
 }
}

@MainActor final class NativeBroadcastHTTP {
 let sourceIdentity:String
 init(sourceIdentity:String)throws{
  guard sourceIdentity.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil else{throw NativeBroadcastHTTPFailure(code:"BROADCAST_WIRE_SOURCE")}
  self.sourceIdentity=sourceIdentity
 }
 // No await between the final native fence and task.resume(). Transport errors
 // after this function starts are NOT proof of non-submission. No POST retry.
 func start(_ request:NativeBroadcastHTTPRequest,fence:()throws->Void,
  complete:@escaping @MainActor (Result<NativeBroadcastHTTPResponse,NativeBroadcastHTTPFailure>)->Void)throws->@Sendable ()->Void {
  guard request.sourceIdentity==sourceIdentity,request.deadline>Date(),
    request.maximumResponseBytes>0,request.maximumResponseBytes<=4*1024*1024 else{throw NativeBroadcastHTTPFailure(code:"BROADCAST_WIRE_REQUEST")}
  try fence()
  let worker=BroadcastHTTPTask(request){result in Task{@MainActor in complete(result)}}
  worker.start()
  return {worker.cancel()}
 }
}

// Foundation callbacks and timeout/cancel bookkeeping use one serial executor.
// No response body, request or native error string is logged or persisted.
private final class BroadcastHTTPTask:NSObject,URLSessionDataDelegate,@unchecked Sendable {
 private let request:NativeBroadcastHTTPRequest
 private let finishCallback:@Sendable(Result<NativeBroadcastHTTPResponse,NativeBroadcastHTTPFailure>)->Void
 private let queue=DispatchQueue(label:"io.tbc.dart.broadcast.http")
 private var session:URLSession?,task:URLSessionDataTask?,timer:DispatchSourceTimer?
 private var status:Int?,bytes=Data(),done=false
 init(_ request:NativeBroadcastHTTPRequest,complete:@escaping @Sendable(Result<NativeBroadcastHTTPResponse,NativeBroadcastHTTPFailure>)->Void){self.request=request;finishCallback=complete}
 func start(){
  // Called once by native authority. URLSession construction does not dispatch;
  // resume synchronously admits the one request before returning to the owner.
  let config=URLSessionConfiguration.ephemeral
  config.urlCache=nil;config.httpCookieStorage=nil;config.urlCredentialStorage=nil
  config.httpShouldSetCookies=false;config.requestCachePolicy = .reloadIgnoringLocalCacheData
  let seconds=min(15,max(0.001,request.deadline.timeIntervalSinceNow))
  config.timeoutIntervalForRequest=seconds;config.timeoutIntervalForResource=seconds
  config.waitsForConnectivity=false
  let delegateQueue=OperationQueue();delegateQueue.maxConcurrentOperationCount=1;delegateQueue.underlyingQueue=queue
  session=URLSession(configuration:config,delegate:self,delegateQueue:delegateQueue)
  var wire=URLRequest(url:request.url,cachePolicy:.reloadIgnoringLocalCacheData,timeoutInterval:seconds)
  wire.httpMethod=request.method;wire.httpBody=request.body;wire.httpShouldHandleCookies=false
  wire.setValue("application/json",forHTTPHeaderField:"Accept")
  if request.body != nil{wire.setValue("application/json",forHTTPHeaderField:"Content-Type")}
  task=session!.dataTask(with:wire)
  let deadline=DispatchSource.makeTimerSource(queue:queue);timer=deadline
  deadline.schedule(deadline:.now()+seconds)
  deadline.setEventHandler{[weak self] in self?.finish(.failure(NativeBroadcastHTTPFailure(code:"NODE_REQUEST_FAILED")))}
  deadline.resume();task!.resume()
 }
 func cancel(){queue.async{self.finish(.failure(NativeBroadcastHTTPFailure(code:"NODE_REQUEST_FAILED")))}}
 private func finish(_ result:Result<NativeBroadcastHTTPResponse,NativeBroadcastHTTPFailure>){
  guard !done else{return};done=true;timer?.cancel();timer=nil;bytes.removeAll(keepingCapacity:false)
  task?.cancel();task=nil;session?.invalidateAndCancel();session=nil;finishCallback(result)
 }
 func urlSession(_ session:URLSession,task:URLSessionTask,willPerformHTTPRedirection response:HTTPURLResponse,newRequest request:URLRequest,completionHandler:@escaping @Sendable(URLRequest?)->Void){completionHandler(nil)}
 func urlSession(_ session:URLSession,task:URLSessionTask,didReceive challenge:URLAuthenticationChallenge,completionHandler:@escaping @Sendable(URLSession.AuthChallengeDisposition,URLCredential?)->Void){
  // Use system TLS validation only; never reuse wallet/web credentials or retry
  // an authenticated POST following an HTTP challenge.
  // rejectProtectionSpace can transparently repeat the POST once on Darwin.
  // Cancel any non-TLS challenge instead; treat it as a submitted unknown.
  completionHandler(challenge.protectionSpace.authenticationMethod==NSURLAuthenticationMethodServerTrust ? .performDefaultHandling:.cancelAuthenticationChallenge,nil)
 }
 func urlSession(_ session:URLSession,dataTask:URLSessionDataTask,didReceive response:URLResponse,completionHandler:@escaping @Sendable(URLSession.ResponseDisposition)->Void){
  guard !done,let http=response as? HTTPURLResponse,http.expectedContentLength<=Int64(request.maximumResponseBytes) else{
   completionHandler(.cancel);finish(.failure(NativeBroadcastHTTPFailure(code:"NODE_RESPONSE_INVALID")));return
  }
  status=http.statusCode;completionHandler(.allow)
 }
 func urlSession(_ session:URLSession,dataTask:URLSessionDataTask,didReceive data:Data){
  guard !done else{return}
  guard data.count<=request.maximumResponseBytes-bytes.count else{finish(.failure(NativeBroadcastHTTPFailure(code:"NODE_RESPONSE_INVALID")));return}
  bytes.append(data)
 }
 func urlSession(_ session:URLSession,task:URLSessionTask,didCompleteWithError error:Error?){
  guard !done else{return}
  guard error==nil,let status else{finish(.failure(NativeBroadcastHTTPFailure(code:"NODE_REQUEST_FAILED")));return}
  finish(.success(NativeBroadcastHTTPResponse(status:status,body:bytes)))
 }
}
