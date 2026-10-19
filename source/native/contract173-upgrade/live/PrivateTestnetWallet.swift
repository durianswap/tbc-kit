import Foundation
import UIKit
import TbcFlutterSigner

// Acceptance adapter only, never included in the partner runtime/default Vault.
// Uses a provisioned private Testnet account; no key enters Dart or WebView.
@MainActor final class PrivateTestnetWallet:NativeAccountSource,NativeApprovalPresenter,NativeDigestSigner {
 let current:NativeAccount
 var revision:Int64=0,unlocked=false
 private var scalar=Data()
 private let controller:UIViewController
 var approvals=0,signatures=0,nativeSignUs:UInt64=0,lastApprovedNs:UInt64=0,lastSignedNs:UInt64=0
 init(_ controller:UIViewController)throws{
  self.controller=controller
  try permissionNeed(Bundle.main.bundleIdentifier=="io.tbc.dartkit.contract173","PRIVATE_TESTNET_APP")
  let publicUrl=Bundle.main.url(forResource:"native-account",withExtension:"json")!
  let p=try JSONSerialization.jsonObject(with:Data(contentsOf:publicUrl)) as! [String:String]
  try permissionNeed(p["chainId"]=="tbc:testnet","TESTNET_ONLY")
  current=NativeAccount(address:p["address"]!,publicKey:p["publicKey"]!,chainId:"tbc:testnet")
 }
 func unlock()throws{
  scalar.resetBytes(in:0..<scalar.count);scalar=Data();unlocked=false;revision+=1
  let url=FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0].appendingPathComponent("testnet-private.json")
  var bytes=try Data(contentsOf:url);defer{bytes.resetBytes(in:0..<bytes.count)}
  try permissionNeed(bytes.count<=4096,"TESTNET_PROVISIONING")
  let mode=(try FileManager.default.attributesOfItem(atPath:url.path)[.posixPermissions] as? NSNumber)?.intValue
  try permissionNeed(mode==0o600,"TESTNET_PRIVATE_MODE")
  let p=try JSONSerialization.jsonObject(with:bytes) as! [String:String]
  try permissionNeed(p["chainId"]==current.chainId && p["address"]==current.address && p["publicKey"]==current.publicKey,"TESTNET_ACCOUNT_MISMATCH")
  guard let h=p["scalar"],h.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil else{throw PermissionFailure(code:"PRIVATE_TEST_KEY_REQUIRED")}
  let chars=Array(h.utf8),key=stride(from:0,to:64,by:2).map{UInt8(String(bytes:chars[$0..<$0+2],encoding:.utf8)!,radix:16)!}
  try permissionNeed(key.prefix(31).contains{$0 != 0} || key[31]>2,"PUBLIC_FIXTURE_KEY_FORBIDDEN")
  scalar=Data(key);unlocked=true;revision+=1
 }
 func present(_ review:NativeReview,complete:@escaping @MainActor (Bool)->Void)->@MainActor ()->Void{
  approvals+=1;var finished=false
  let permitted=unlocked && review.chainId==current.chainId && review.accountAddress==current.address && review.origin=="http://127.0.0.1:41893"
  let dialog=UIAlertController(title:"TESTNET ONLY · "+review.title,message:review.origin+"\n"+review.description,preferredStyle:.alert)
  func finish(_ yes:Bool){guard !finished else{return};finished=true;if yes{lastApprovedNs=DispatchTime.now().uptimeNanoseconds};complete(yes)}
  dialog.addAction(UIAlertAction(title:"Approve",style:.default){_ in finish(permitted)})
  dialog.addAction(UIAlertAction(title:"Reject",style:.cancel){_ in finish(false)})
  controller.present(dialog,animated:false)
  // Explicitly authorized isolated Testnet acceptance. Not a partner default.
  DispatchQueue.main.asyncAfter(deadline:.now()+0.25){if !finished && dialog.presentingViewController != nil{dialog.dismiss(animated:false);finish(permitted)}}
  return {guard !finished else{return};finished=true;dialog.dismiss(animated:false)}
 }
 func sign(account:NativeAccount,digest:[UInt8],encoding:String,requireCurrent:@escaping @MainActor ()throws->Void,complete:@escaping @MainActor (Result<[UInt8],Error>)->Void){
  complete(Result{
   try requireCurrent()
   try permissionNeed(unlocked && account==current && scalar.count==32 && digest.count==32 && ["compact64","compact65-recoverable"].contains(encoding),"TESTNET_SIGNER_SCOPE")
   let count=encoding=="compact64" ? 64:65
   guard tbc_signer_kernel_version()==1,let buffer=tbc_signer_buffer_new()else{throw PermissionFailure(code:"TESTNET_SIGNER_ABI")}
   defer{tbc_signer_buffer_free(buffer)}
   for i in 0..<32{buffer[i]=digest[i];buffer[32+i]=scalar[i]}
   try requireCurrent();let start=DispatchTime.now().uptimeNanoseconds
   try permissionNeed(tbc_signer_sign_digest(buffer,32,buffer.advanced(by:32),32,UInt32(count),buffer.advanced(by:64),count)==0,"TESTNET_SIGN_FAILED")
   lastSignedNs=DispatchTime.now().uptimeNanoseconds;nativeSignUs+=(lastSignedNs-start)/1000;signatures+=1
   return Array(UnsafeBufferPointer(start:buffer.advanced(by:64),count:count))
  })
 }
 func stats()->[String:Any]{["approvals":approvals,"signatures":signatures,"nativeSignUs":nativeSignUs,"approvalToLastSignatureUs":lastSignedNs>=lastApprovedNs ? (lastSignedNs-lastApprovedNs)/1000:0,"testnetPrivateAdapter":true]}
}
