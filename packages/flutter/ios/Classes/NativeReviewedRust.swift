import Foundation
// C ABI is exported by this plugin module.

/// Kit-owned keyless adapter. Linking/provenance belongs to packaging, not a
/// page or partner decoder. The existing custody owner fences late replies.
@MainActor final class NativeReviewedRust:NativeReviewedComputer {
 static let artifact="1d5a2a68a60f613376f3b59e7b318a7e6799d3f3e690d73ad902988ab3ab0675"
 private static let worker=DispatchQueue(label:"io.tbc.kit.dart.reviewed",qos:.userInitiated)
 private var pending=0
 init()throws{
  guard String(cString:tbc_dart_reviewed_identity())==Self.artifact else{throw NativeCustodyFailure(code:"NATIVE_COMPUTE_IDENTITY")}
 }
 func call(method:String,input:String,complete:@escaping @MainActor (Result<String,Error>)->Void){
  guard pending<8,input.utf8.count<=16*1024*1024,
   method=="prepareReviewedStage" || method=="finalizeReviewedStage" else{
   complete(.failure(NativeCustodyFailure(code:"NATIVE_REVIEWED_COMPUTE_FAILED")));return
  }
  pending+=1
  Self.worker.async{
   let value=Self.invoke(method:method,input:input)
   DispatchQueue.main.async{self.pending-=1;complete(value)}
  }
 }
 private nonisolated static func invoke(method:String,input:String)->Result<String,Error>{
  Result{
   let m=Array(method.utf8),i=Array(input.utf8)
   var output=TbcDartReviewedOutput()
   let status=m.withUnsafeBufferPointer{mp in i.withUnsafeBufferPointer{ip in
    tbc_dart_reviewed_call(mp.baseAddress,mp.count,ip.baseAddress,ip.count,&output)
   }}
   guard status==0 else{throw NativeCustodyFailure(code:"NATIVE_REVIEWED_COMPUTE_FAILED")}
   defer{tbc_dart_reviewed_free(output)}
   guard output.len<=32*1024*1024,let ptr=output.ptr,
    let text=String(bytes:UnsafeBufferPointer(start:ptr,count:output.len),encoding:.utf8)
   else{throw NativeCustodyFailure(code:"NATIVE_REVIEWED_COMPUTE_FAILED")}
   return text
  }
 }
}
