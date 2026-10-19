// Maintainer-only isolated consumer composition. Never part of runtime delivery.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {sourcePath} from '../../flutter/scripts/webview-source-identity.mjs';
import {verifiedKitCandidate} from '../../flutter/scripts/candidate-inputs.mjs';
import {sendConsumerSource} from './send_consumer_wire.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
export async function legacyPage(directory,base,paired,kitDirectory){
 const manifest=JSON.parse(await readFile(join(directory,'page-provenance.json')));
 assert.deepEqual(manifest.kitIdentity,paired.kitIdentity);
 const root=resolve(base,'../..'),kit=kitDirectory?resolve(kitDirectory):join(root,'release/kit-contract173-20261014-c/package');
 assert.deepEqual(await verifiedKitCandidate(kit),paired.kitIdentity);
 for(const [p,hash] of Object.entries(manifest.sources))assert.equal(sha(await readFile(sourcePath(root,kit,p))),hash,p);
 const bytes=await readFile(join(directory,'tbc-webview-page.js'));
 assert.equal(sha(bytes),manifest.sha256);assert(bytes.includes('tbc-dart-legacy-page:'));
 return {bytes,manifest};
}
export function legacyConsumerSource(file,bytes,paired,page,maintenance=false){
 if(maintenance&&file.startsWith('TbcDartWalletHost.'))bytes=sendConsumerSource(file,bytes,'send');
 let text=bytes.toString();
 function replace(from,to){assert.equal(text.split(from).length,2,`${file}: ${from}`);text=text.replace(from,to);}
 if(['MainActivity.kt','AppDelegate.swift'].includes(file)){
  replace(paired.artifacts['android/src/main/assets/tbc-kit/tbc-webview-page.js'],page.sha256);
  if(file.endsWith('.kt')){
   replace('crypto=wallet)', 'crypto=wallet,legacyBackend=SystemPermissionBackend(this,"f1-public-fixture",wallet.current.chainId,NativeWalletProtocol.LEGACY)'+(maintenance?',broadcast=NativeBroadcastConfiguration("testnet"),broadcastDirectory=filesDir,broadcastProfile="f3-maintenance-"+java.util.UUID.randomUUID().toString()':'')+')');
   replace('"stats"->', '"phase"->result.success(if(getSharedPreferences("legacy-fixture",MODE_PRIVATE).getBoolean("first-passed",false))2 else 1)\n    "restartReady"->{check(getSharedPreferences("legacy-fixture",MODE_PRIVATE).edit().putBoolean("first-passed",true).commit());result.success(null)}\n    "stats"->');
  }else{
   replace('allowInsecureLoopback:true)', 'allowInsecureLoopback:true'+(maintenance?',broadcast:try NativeBroadcastConfiguration(network:"testnet"),broadcastDirectory:directory,broadcastProfile:"f3-maintenance-"+UUID().uuidString':'')+',legacyBackend:SystemPermissionBackend(profile:"f1-public-fixture",chain:wallet.current.chainId,directory:directory,walletProtocol:.legacy))');
   replace('case "stats":', 'case "phase":result(UserDefaults.standard.bool(forKey:"legacy-first-passed") ? 2:1)\n   case "restartReady":UserDefaults.standard.set(true,forKey:"legacy-first-passed");result(nil)\n   case "stats":');
  }
 }
 if(file.startsWith('FixtureWallet.'))replace('"io.tbc.dartkit.network"','"io.tbc.dartkit.network","io.tbc.dartkit.legacy"');
 return Buffer.from(text);
}
