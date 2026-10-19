// Pure pinned OrderBook factory oracle. No API/keyful wrapper is loaded.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {runInThisContext} from 'node:vm';
import {resolve,join} from 'node:path';
import {transform} from 'esbuild';
const [upstreamArg,depsArg,mode]=process.argv.slice(2);
assert.ok(upstreamArg&&depsArg&&[undefined,'--write-template'].includes(mode));
const upstream=resolve(upstreamArg),deps=createRequire(join(resolve(depsArg),'package.json'));
const commit='af77616121db340e15bb8b73c197bc2f8d1ee986',relative='lib/contract/orderBook.ts';
const bytes=readFileSync(join(upstream,relative));
assert.deepEqual(bytes,execFileSync('git',['-C',upstream,'show',`${commit}:${relative}`],{maxBuffer:1024*1024}));
const source=bytes.toString(),sha=value=>createHash('sha256').update(value).digest('hex');
const names=['getSellOrderCode','getBuyOrderCode','getTokenSellOrderCode','getTokenBuyOrderCode'];
const templates=names.map((name,index)=>{
  const start=source.indexOf(`\n  ${name}(`),end=source.indexOf(`\n  ${names[index+1]??'buildOrderData'}(`,start+1);
  assert.ok(start>0&&end>start);
  const match=source.slice(start,end).match(/`([0-9a-f$}{A-Za-z]+)`/);
  assert.ok(match);return match[1];
});
const file=new URL('../rust/crates/tbc-engine-core/src/protocols/lop-templates.json',import.meta.url);
const artifact={commit,source:relative,sourceSha256:sha(bytes),templates};
if(mode==='--write-template'){
  // Mechanical extraction of reviewed, pinned opcode artifacts only.
  writeFileSync(file,JSON.stringify(artifact,null,2)+'\n');
  console.log(JSON.stringify({status:'LOP_TEMPLATE_EXTRACTED',commit,templates:templates.length}));
}else{
  assert.deepEqual(JSON.parse(readFileSync(file)),artifact);
  const pure=source.slice(source.indexOf('\n  getSellOrderCode('),source.indexOf('\n  static placeHolderP2PKHOutput('));
  const compiled=await transform(`class Oracle {${pure}\n}`,{loader:'ts',target:'node22'});
  const tbc=deps('tbc-lib-js'),BN=tbc.crypto.BN;
  // Modern native-order markers depend only on validated Code byte length.
  const tbc20Fixture=JSON.parse(readFileSync(new URL('../rust/fixtures/tbc20-standard-transfer.json',import.meta.url)));
  const genesis=new tbc.Transaction(tbc20Fixture.stages[1].signedRaw);
  const modernCodeOffsets=new Map([[genesis.outputs[0].script.toBuffer().length,0],[2981,0]]);
  const Oracle=runInThisContext(`(function(tbc,BN,modernCodeOffsets,token_order_size_hex){${compiled.code}\nreturn Oracle;})`)(tbc,BN,modernCodeOffsets,'023405');
  const stdout=execFileSync('cargo',['test','--offline','--locked','-p','tbc-engine-core','--test','lop',
    'pinned_lop_roundtrip_and_continuations','--','--exact','--nocapture'],{
    cwd:resolve(import.meta.dirname,'../rust'),env:{...process.env,LOP_DUMP_WIRE:'1'},encoding:'utf8',timeout:60000,
    maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']});
  const wires=stdout.split('\n').filter(l=>l.startsWith('LOP_WIRE:')).map(l=>JSON.parse(l.slice(9)));
  assert.equal(wires.length,16);
  const owner=new tbc.PrivateKey(new BN(1)),other=new tbc.PrivateKey(new BN(2));let cancellationChecks=0;
  for(const w of wires){
    const o=new Oracle();Object.assign(o,{hold_address:tbc.Address.fromHex('00'+w.owner).toString(),
      sale_volume:BigInt(w.volume),fee_rate:BigInt(w.fee),unit_price:BigInt(w.price),
      ft_a_contract_partialhash:w.aHash,ft_a_contract_id:w.aId,ft_b_contract_partialhash:w.bHash,ft_b_contract_id:w.bId});
    const tax=tbc.Address.fromHex('00'+w.tax).toString();
    const actual=w.pair?(w.sell?o.getTokenSellOrderCode(tax,w.aModern,w.bModern):o.getTokenBuyOrderCode(tax,w.aModern,w.bModern)):
      (w.sell?o.getSellOrderCode(false,tax,Buffer.from([w.tokenBytes&255,w.tokenBytes>>8]).toString('hex')):
        o.getBuyOrderCode(false,tax,Buffer.from([w.tokenBytes&255,w.tokenBytes>>8]).toString('hex')));
    assert.equal(actual.toHex(),w.script);
    const update=w.pair?Oracle.updateTokenSaleVolume:Oracle.updateSaleVolume;
    assert.equal(update(actual.toHex(),1n).toHex(),w.continuation);
    assert.equal(tbc.crypto.Hash.sha256ripemd160(tbc.crypto.Hash.sha256(actual.toBuffer())).toString('hex'),w.controller);
    const decoded=w.pair?Oracle.getTokenOrderData(actual.toHex()):Oracle.getOrderData(actual.toHex());
    assert.equal(String(decoded.saleVolume),w.volume);assert.equal(String(decoded.unitPrice),w.price);assert.equal(String(decoded.feeRate),w.fee);
    // Only the order input's owner-cancellation branch. A complete Token cancel
    // must additionally prove its sibling Token input; this is not that claim.
    o.hold_address=owner.toAddress().toString();
    const owned=w.pair?(w.sell?o.getTokenSellOrderCode(tax,w.aModern,w.bModern):o.getTokenBuyOrderCode(tax,w.aModern,w.bModern)):
      (w.sell?o.getSellOrderCode(false,tax,Buffer.from([w.tokenBytes&255,w.tokenBytes>>8]).toString('hex')):
        o.getBuyOrderCode(false,tax,Buffer.from([w.tokenBytes&255,w.tokenBytes>>8]).toString('hex')));
    for(const signer of [owner,other]){
      const tx=new tbc.Transaction().from({txId:'11'.repeat(32),outputIndex:0,script:owned.toHex(),satoshis:10000})
        .to(owner.toAddress().toString(),9900).fee(100);
      tx.inputs[0].setScript(tbc.Script.fromASM(`${tx.getSignature(0,signer)} ${signer.publicKey.toString()} OP_2`));
      assert.equal(tx.verifyScript(0).success,signer===owner,'Order cancellation requires owner signature');cancellationChecks++;
    }
  }
  console.log(JSON.stringify({status:'LOP_CODE_SOURCE_PASS',commit,sourceSha256:sha(bytes),codeVectors:wires.length,
    interpreterVersion:deps('tbc-lib-js/package.json').version,cancellationInputVmChecks:cancellationChecks,externalRequests:0,broadcasts:0,
    scope:'Code/fields/controller/continuation and isolated order cancellation input; no full Token cancel, fill, builder or installed support'}));
}
