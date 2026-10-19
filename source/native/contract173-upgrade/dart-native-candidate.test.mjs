import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pairedNativeSource} from './dart-native-candidate.mjs';

test('candidate pairing retains exact page and native identity checks',async()=>{
 const manifest={artifactId:'a'.repeat(64),artifacts:{'android/src/main/assets/tbc-kit/tbc-webview-page.js':'b'.repeat(64)}};
 for(const [file,path]of [
  ['MainActivity.kt','acceptance/android'],['AppDelegate.swift','acceptance/ios'],
  ['NativeReviewedRust.kt','platform/android/src/main/kotlin/io/tbc/kit/dart'],
  ['NativeReviewedRust.swift','platform/ios/Classes'],
 ]){
  const bytes=await readFile(new URL(`../flutter-dart-kit/${path}/${file}`,import.meta.url));
  const paired=pairedNativeSource(file,bytes,manifest);
  const identity=file.startsWith('Native')?manifest.artifactId:manifest.artifacts['android/src/main/assets/tbc-kit/tbc-webview-page.js'];
  assert(paired.toString().includes(identity),file);
  assert.equal(paired.length,bytes.length,'Only the same-length pinned identity changes');
  assert.deepEqual(pairedNativeSource(file,bytes,undefined),bytes,'Frozen default remains unchanged');
  assert.throws(()=>pairedNativeSource(file,Buffer.from('missing identity'),manifest));
  assert.throws(()=>pairedNativeSource(file,Buffer.concat([bytes,bytes]),manifest));
 }
 const other=Buffer.from('unrelated source');
 assert.equal(pairedNativeSource('Unrelated.kt',other,manifest),other);
});
