import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {assertValidTws, chainDataRequirement} from '@tbc-wallet/core';

const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/prepared-chain-data.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node'});
const {preparedChainDataRequirement}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const address='1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
const base={version:'1.0',chainId:'tbc:testnet',from:address};
const ft={version:'1.0',type:'tbc.ft.transfer',contractId:'11'.repeat(32)};

test('old FT schema accepts exactly one recipient form, at most five positive recipients',()=>{
  for(let count=1;count<=5;count++){
    const request={...base,intent:{...ft,receivers:Array.from({length:count},(_,i)=>({to:address,amount:String(i+1)}))}};
    assert.doesNotThrow(()=>assertValidTws('transactionRequest',request));
    const core=chainDataRequirement(request),prepared=preparedChainDataRequirement(request);
    assert.deepEqual(prepared,core);
    assert.equal(core.assets.find(asset=>asset.kind==='ft').minimumAmount,String(count*(count+1)/2));
  }
  for(const intent of [
    {...ft,receivers:[]}, {...ft,receivers:Array(6).fill({to:address,amount:'1'})},
    {...ft,receivers:[{to:address,amount:'0'}]},
    {...ft,to:address,amount:'1',receivers:[{to:address,amount:'1'}]},
    {...ft,receivers:[{to:address,amount:'1'}],attachedTbcAmount:'42'},
  ]) assert.throws(()=>assertValidTws('transactionRequest',{...base,intent}));
  assert.doesNotThrow(()=>assertValidTws('transactionRequest',{...base,intent:{...ft,to:address,amount:'1',attachedTbcAmount:'42'}}));
});

test('TBC20 payment is carried identically by wallet and Prepared data requirements',()=>{
  for(const type of ['tbc20-standard-transfer','tbc20.transfer']){
    const request={...base,intent:{...ft,type,receivers:[{to:address,amount:'2'},{to:address,amount:'3'}],payment:{to:address,amount:'1234'}}};
    assert.doesNotThrow(()=>assertValidTws('transactionRequest',request));
    assert.deepEqual(preparedChainDataRequirement(request),chainDataRequirement(request));
    assert.equal(chainDataRequirement(request).nativeAmount,'1234');
    assert.equal(chainDataRequirement(request).assets.find(asset=>asset.kind==='ft').minimumAmount,'5');
  }
});

test('native consolidation preserves the exact selected inputs in both data requirements',()=>{
  const points=[{txid:'11'.repeat(32),vout:0},{txid:'22'.repeat(32),vout:1}];
  const request={...base,intent:{type:'tbc.maintenance.merge',version:'1.0'},constraints:{inputOutpoints:points}};
  assert.doesNotThrow(()=>assertValidTws('transactionRequest',request));
  const core=chainDataRequirement(request),prepared=preparedChainDataRequirement(request);
  assert.deepEqual(prepared,core);
  assert.deepEqual(core.inputOutpoints,points);
  assert.equal(core.includeAncestry,false);
});
