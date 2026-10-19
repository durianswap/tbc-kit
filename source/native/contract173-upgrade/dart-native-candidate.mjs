// Maintainer-side pairing only. Never called on a wallet request path.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {sha256} from '../flutter/scripts/candidate-inputs.mjs';
import {safePath} from '../../packages/kit/scripts/platform-resources.mjs';
export async function verifiedDartNativeCandidate(directory){
 const m=JSON.parse(await readFile(join(directory,'native-artifacts.json')));
 assert.equal(m.kind,'paired-dart-native');assert.equal(m.schema,1);
 assert.equal(m.artifactId,sha256(JSON.stringify(m.buildInputs)));
 assert.equal(m.kitIdentity.rustSourceSha256,m.buildInputs.rustSourceSha256);
 assert.deepEqual(m.kitIdentity,m.buildInputs.kitIdentity);
 for(const [p,hash]of Object.entries(m.artifacts))assert.equal(sha256(await readFile(join(directory,safePath(p)))),hash,p);
 for(const p of ['include/tbc_keyless.h','android/src/main/jniLibs/arm64-v8a/libtbc_compute_native.so','android/src/main/jniLibs/arm64-v8a/libtbc_signer_kernel.so',
  'android/src/main/assets/tbc-kit/tbc-webview-page.js','ios/Frameworks/TbcFlutterEngine.xcframework/ios-arm64/TbcFlutterEngine.framework/TbcFlutterEngine',
  'ios/Frameworks/TbcFlutterEngine.xcframework/ios-arm64-simulator/TbcFlutterEngine.framework/TbcFlutterEngine'])assert(Object.hasOwn(m.artifacts,p),p);
 return m;
}
export function pairedNativeSource(file,bytes,manifest){
 if(!manifest)return bytes;
 const native=['NativeReviewedRust.swift','NativeReviewedRust.kt'].includes(file);
 const page=['MainActivity.kt','AppDelegate.swift'].includes(file);
 if(!native&&!page)return bytes;
 const old=native?'92d18b12fb2823d0dce98245b6ac1b689a44dcf581c25e3e2ab9a37bb94e40fb':'9efa0a281e4de99f455fd2983e90db38836e8e9217e1dcf8aaee6c8a1d8f6a72';
 const current=native?manifest.artifactId:manifest.artifacts['android/src/main/assets/tbc-kit/tbc-webview-page.js'];
 assert.match(current,/^[0-9a-f]{64}$/);
 const text=bytes.toString();
 assert.equal(text.split(old).length,2,'Review identity template before packaging '+file);
 return Buffer.from(text.replace(old,current));
}
