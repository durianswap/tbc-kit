import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {resolve} from 'node:path';
import {build} from 'esbuild';

const root=resolve(import.meta.dirname,'../../..');
const built=await build({
  entryPoints:[resolve(root,'packages/kit/src/legacy-bitcoin-message.ts')],
  bundle:true,write:false,platform:'node',format:'esm',target:'es2022',
  alias:{'@tbc-wallet/core':resolve(root,'packages/core/src/index.ts')},
  logLevel:'silent',
});
const {digestTbcLegacyBitcoinMessage,prepareTbcLegacyBitcoinMessage}=await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);

function referenceDigest(message){
  const magic=Buffer.from('Bitcoin Signed Message:\n');
  const compact=value=>value<0xfd?Buffer.from([value]):value<=0xffff
    ?Buffer.from([0xfd,value&255,value>>>8])
    :Buffer.from([0xfe,value&255,(value>>>8)&255,(value>>>16)&255,(value>>>24)&255]);
  const payload=Buffer.concat([compact(magic.length),magic,compact(message.length),message]);
  return createHash('sha256').update(createHash('sha256').update(payload).digest()).digest('hex');
}

test('Kit Legacy Bitcoin digest matches the historical signed-message format',async()=>{
  assert.equal(digestTbcLegacyBitcoinMessage({version:'1.0',message:{encoding:'utf8',data:'hello'}}),
    'cf0447ec85f0ce7150a257db32ebfcb7523dae17c36dbd1be598779fec0484f4');
  for(const message of ['', 'hello', 'a'.repeat(252), 'a'.repeat(253),
    'a'.repeat(65536), '原生钱包']){
    const bytes=Buffer.from(message,'utf8');
    const expected=referenceDigest(bytes);
    assert.equal(digestTbcLegacyBitcoinMessage({version:'1.0',
      message:{encoding:'utf8',data:message}}),expected);
    assert.equal((await prepareTbcLegacyBitcoinMessage({encoding:'base64',
      message:bytes.toString('base64')})).digest,expected);
  }
});

test('Kit Legacy Bitcoin digest rejects invalid encoding and oversized messages',async()=>{
  assert.throws(()=>digestTbcLegacyBitcoinMessage({version:'1.0',
    message:{encoding:'hex',data:'xyz'}}),/hex input/);
  assert.throws(()=>digestTbcLegacyBitcoinMessage({version:'1.0',
    message:{encoding:'utf8',data:'a'.repeat(65537)}}),/message size/);
  await assert.rejects(prepareTbcLegacyBitcoinMessage({encoding:'base64',message:'!!!'}),
    /base64 input/);
});
