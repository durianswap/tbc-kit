package io.tbc.kit.dart

import java.io.File
import java.time.Instant

// Binding-only host proof with the real shared native normalizer, not native consent,
// key custody, signing, delivery, devices or chain acceptance.
@Suppress("UNCHECKED_CAST") private fun map(v:Any?)=v as Map<String,Any?>
private fun run(s:Map<String,Any?>):NativeWorkflow.Binding{
 val a=map(s["account"]);val account=NativeAccount(a["address"] as String,a["publicKey"] as String,a["chainId"] as String)
 val extra=(s["accounts"] as List<*>).drop(1).map{val a=map(it);NativeAccount(a["address"] as String,a["publicKey"] as String,a["chainId"] as String)}
 val reviews=map(s["reviews"]).mapValues{map(it.value)}
 return NativeWorkflow.bind(s["method"] as String,map(s["request"]),map(s["context"]),account,extra,map(s["plan"]),map(s["preview"]),map(s["binding"]),reviews,Instant.parse(s["now"] as String))
}
fun main(args:Array<String>){
 val root=PermissionJson.records("[${File(args[0]).readText()}]").single()
 val good=(root["valid"] as List<*>).map{map(it)};val bad=(root["invalid"] as List<*>).map{map(it)};var checks=0
 for(s in good){
  val b=run(s);check(PermissionJson.canonical(b.plan)==PermissionJson.canonical(s["plan"]));checks++
  check(b.children.size==(map(s["request"])["steps"] as List<*>).size);checks++
  check(b.requiredPermissions==(s["permissions"] as List<*>).toSet());checks++
 }
 for(entry in bad){var rejected=false;try{run(map(entry["sample"]))}catch(_:Exception){rejected=true};check(rejected){"accepted invalid ${entry["label"]}"};checks++}
 println("{\"status\":\"PASS\",\"cases\":${good.size},\"negativeCases\":${bad.size},\"checks\":$checks,\"proof\":\"host-binding-strategy-only\"}")
}
