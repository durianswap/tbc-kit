// Copies an existing authorized Testnet account only to the new sandbox.
// No key is printed or passed to Flutter/WebView. No funding/broadcast here.
import assert from 'node:assert/strict';
import {readFile,stat,copyFile,chmod,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {secp256k1} from '@noble/curves/secp256k1';
const directory=resolve(process.argv[2]);assert.match(directory,/^\/private\/tmp\/tbc-p5-private-[A-Za-z0-9]+$/);
const file=join(directory,'ios.json'),p=JSON.parse(await readFile(file));
assert.equal((await stat(file)).mode&0o777,0o600);
const expected=JSON.parse(await readFile(new URL('../flutter-dart-live-token-exploration/evidence/private-accounts-20261012-a/accounts.json',import.meta.url))).accounts.ios;
for(const k of ['chainId','address','publicKey','accountId'])assert.equal(p[k],expected[k]);
const key=Buffer.from(p.scalar,'hex');assert.equal(key.length,32);
assert.equal(Buffer.from(secp256k1.getPublicKey(key,true)).toString('hex'),p.publicKey);key.fill(0);delete p.scalar;
const device='C2C010B8-4071-4888-9E25-D91BF88EB461',bundle='io.tbc.dartkit.contract173';
const container=execFileSync('xcrun',['simctl','get_app_container',device,bundle,'data'],{encoding:'utf8'}).trim();
assert(container.includes(`/Devices/${device}/data/Containers/Data/Application/`));
await mkdir(join(container,'Documents'),{recursive:true});const dest=join(container,'Documents/testnet-private.json');
try{assert.deepEqual(await readFile(dest),await readFile(file),'Existing custody differs');}catch(e){if(e.code!=='ENOENT')throw e;await copyFile(file,dest);}
await chmod(dest,0o600);console.log(JSON.stringify({status:'PRIVATE_TESTNET_ACCOUNT_PROVISIONED',bundle,address:p.address,noSecretOutput:true}));
