// Isolated native custody provisioning only. Never prints/copies a key to Dart.
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {secp256k1} from '@noble/curves/secp256k1';
const directory=resolve(process.argv[2]);assert.match(directory,/^\/private\/tmp\/tbc-p5-private-[A-Za-z0-9]+$/);
const source=join(directory,'android.json'),p=JSON.parse(await readFile(source));assert.equal((await stat(source)).mode&0o777,0o600);
const expected=JSON.parse(await readFile(new URL('../flutter-dart-live-token-exploration/evidence/private-accounts-20261012-a/accounts.json',import.meta.url))).accounts.android;
for(const k of ['chainId','address','publicKey','accountId'])assert.equal(p[k],expected[k]);
const key=Buffer.from(p.scalar,'hex');assert.equal(key.length,32);assert.equal(Buffer.from(secp256k1.getPublicKey(key,true)).toString('hex'),p.publicKey);key.fill(0);delete p.scalar;
const adb='/Users/alex/Library/Android/sdk/platform-tools/adb',device='emulator-5554',bundle='io.tbc.dartkit.contract173';
const run=(args,options={})=>execFileSync(adb,['-s',device,...args],{encoding:'utf8',...options});
assert.equal(run(['shell','getprop','ro.kernel.qemu']).trim(),'1','Test emulator only');
run(['root']);run(['wait-for-device']);assert.equal(run(['shell','id','-u']).trim(),'0');
const output=run(['shell','cmd','package','list','packages','-U',bundle]).trim();
const match=new RegExp(`^package:${bundle.replaceAll('.','\\.')} uid:(\\d+)$`).exec(output);assert(match);
const dir=`/data/user/0/${bundle}/files`,dest=dir+'/testnet-private.json';
run(['shell','mkdir','-p',dir]);
const exists=run(['shell',`if test -e '${dest}'; then echo yes; else echo no; fi`]).trim();
if(exists==='yes'){
 const existing=Buffer.from(run(['exec-out','cat',dest])),expectedBytes=await readFile(source);
 try{assert(existing.equals(expectedBytes),'Existing custody differs; do not replace');}finally{existing.fill(0);expectedBytes.fill(0)}
}else{assert.equal(exists,'no');run(['push',source,dest],{stdio:'pipe'});}
run(['shell','chown',`${match[1]}:${match[1]}`,dir,dest]);run(['shell','chmod','700',dir]);run(['shell','chmod','600',dest]);
console.log(JSON.stringify({status:'PRIVATE_TESTNET_ACCOUNT_PROVISIONED',bundle,address:p.address,noSecretOutput:true}));
