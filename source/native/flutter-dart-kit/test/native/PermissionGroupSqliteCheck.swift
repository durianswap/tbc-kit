import Foundation

// Actual system SQLite transaction/restart proof on macOS, not an iOS device.
@main private struct PermissionGroupSqliteCheck {
 @MainActor static var checks=0
 @MainActor static func yes(_ value:Bool){precondition(value,"SQLite group check \(checks+1)");checks+=1}
 @MainActor static func rejects(_ action:()throws->Void){do{try action();fatalError("Expected rejection")}catch{checks+=1}}
 @MainActor static func main()throws{
  let directory=URL(fileURLWithPath:CommandLine.arguments[1]),origin="https://group.example"
  let main=try SystemPermissionBackend(profile:"wallet",chain:"tbc:mainnet",directory:directory)
  let test=try SystemPermissionBackend(profile:"wallet",chain:"tbc:testnet",directory:directory)
  defer{main.close();test.close()}
  func mutations(_ id:String,_ a:Int64=0,_ b:Int64=0)->[NativePermissionMutation]{
   [(main,"tbc:mainnet",a),(test,"tbc:testnet",b)].map{store,chain,revision in
    NativePermissionMutation(backend:store,chainId:chain,origin:origin,expected:revision,records:[["fixture":chain]],callId:id,meaning:"group-"+id)
   }
  }
  func revision(_ store:SystemPermissionBackend)throws->Int64{try store.loadAll()[origin]?.revision ?? 0}
  yes(main.acceptsGroup([main,test]));yes(!main.acceptsGroup([main,main]));yes(!main.acceptsGroup([]))
  let wrongProfile=try SystemPermissionBackend(profile:"different",chain:"tbc:testnet",directory:directory)
  let wrongFile=try SystemPermissionBackend(profile:"wallet",chain:"tbc:testnet",directory:directory.appendingPathComponent("other"))
  yes(!main.acceptsGroup([main,wrongProfile]));yes(!main.acceptsGroup([main,wrongFile]));wrongProfile.close();wrongFile.close()

  // First chain has already executed both INSERTs when the second CAS fails.
  rejects{_ = try main.commitGroup(mutations("stale-second",0,7)) {}}
  yes(try revision(main)==0 && revision(test)==0)
  // Same operation can succeed after rollback: no residual idempotency row.
  let first=try main.commitGroup(mutations("stale-second")){}
  yes(first.count==2 && first.values.allSatisfy{$0.acknowledgedRevision==1})
  yes(try revision(main)==1 && revision(test)==1)
  let replay=try main.commitGroup(mutations("stale-second")){}
  yes(replay.values.allSatisfy{$0.acknowledgedRevision==1 && $0.current.revision==1})
  var fences=0
  rejects{_ = try main.commitGroup(mutations("last-fence",1,1)){fences+=1;if fences==3{throw PermissionFailure(code:"CANCELLED")}}}
  yes(fences==3);yes(try revision(main)==1 && revision(test)==1)
  _ = try main.commitGroup(mutations("last-fence",1,1)){}
  yes(try revision(main)==2 && revision(test)==2)

  // Reject a partial historical operation instead of silently completing it.
  let partial=mutations("partial",2,2)
  _ = try main.commit(origin:origin,expected:2,records:partial[0].records,callId:"partial",meaning:"group-partial"){}
  rejects{_ = try main.commitGroup(partial){}}
  yes(try revision(main)==3 && revision(test)==2)
  // Replays return the actual current records, never revive revoked grants.
  _ = try test.commit(origin:origin,expected:2,records:[],callId:"revoke",meaning:"revoke"){}
  let afterRevoke=try main.commitGroup(mutations("stale-second")){}
  yes(afterRevoke["tbc:testnet"]!.acknowledgedRevision==1 && afterRevoke["tbc:testnet"]!.current.records.isEmpty)
  yes(try revision(main)==3 && revision(test)==3)
  var forged=mutations("invalid",3,3)
  forged[1]=NativePermissionMutation(backend:test,chainId:"tbc:mainnet",origin:origin,expected:3,records:[],callId:"invalid",meaning:"invalid")
  rejects{_ = try main.commitGroup(forged){}}
  yes(try revision(main)==3 && revision(test)==3)
  main.close();test.close()
  for chain in ["tbc:mainnet","tbc:testnet"]{
   let reopened=try SystemPermissionBackend(profile:"wallet",chain:chain,directory:directory)
   yes(try revision(reopened)==3)
   yes(try reopened.loadAll()[origin]!.records.isEmpty==(chain=="tbc:testnet"));reopened.close()
  }
  print("{\"status\":\"PERMISSION_GROUP_SQLITE_PASS\",\"checks\":\(checks),\"systemSQLite\":true,\"mobileDevice\":false,\"broadcasts\":0}")
 }
}
