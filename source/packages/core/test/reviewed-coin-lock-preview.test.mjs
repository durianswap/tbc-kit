import assert from 'node:assert/strict';
import test from 'node:test';
import {assertValidTws} from '../dist/esm/index.js';

const account={chainId:'tbc:testnet',address:'1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP',
 accountId:'tbc:testnet:1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP',publicKey:'02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'};
const holder={transactionIndex:0,position:'input',index:0,contractId:'bc'.repeat(32),amount:'100',owner:account.address,
 lockTime:1000,domain:'height',transactionLockTime:1000,sequence:4294967294,scriptLockChecked:true,chainMaturityChecked:false};
const preview=(lock,roles)=>({operationKind:'transaction',assetFlows:[],totalFee:'1',transactionCount:1,warnings:[],irreversible:true,
 coinLocks:[lock],...(roles?{signingRoles:roles}:{})});
const roles=[{role:'coin-admin',account}];
const admin={...holder,authorization:'administrator',transactionLockTime:0,sequence:4294967295,scriptLockChecked:false};
const valid=p=>assertValidTws('approvalPreview',p);

test('administrator lock evidence requires an explicit bound Coin role, not holder maturity',()=>{
 valid(preview(admin,roles));
 for(const p of [preview(admin),preview(admin,[{role:'pool-controller',account}]),
  preview({...admin,scriptLockChecked:true},roles),preview({...admin,chainMaturityChecked:true},roles),
  preview({...admin,position:'output'},roles),preview({...admin,authorization:'holder'},roles)])assert.throws(()=>valid(p));
 const noSequence={...admin};delete noSequence.sequence;assert.throws(()=>valid(preview(noSequence,roles)));
});
test('existing holder and output lock semantics remain strict',()=>{
 valid(preview(holder));
 for(const lock of [{...holder,scriptLockChecked:false},{...holder,sequence:4294967295},{...holder,chainMaturityChecked:true}])assert.throws(()=>valid(preview(lock)));
 const output={...holder,position:'output',scriptLockChecked:false};delete output.sequence;valid(preview(output));
 assert.throws(()=>valid(preview({...output,authorization:'administrator'},roles)));
 assert.throws(()=>valid(preview({...output,scriptLockChecked:true})));
});
test('contract-held Coin preview discloses its controller hash without inventing an address',()=>{
 const contract={...admin,controller:{type:'contract',hash:'22'.repeat(20)}};delete contract.owner;
 valid(preview(contract,roles));
 const output={...contract,position:'output'};delete output.sequence;delete output.authorization;
 valid(preview(output,roles));
 for(const lock of [{...contract,owner:account.address},{...contract,controller:undefined},
  {...contract,controller:{type:'address',hash:'22'.repeat(20)}},{...contract,controller:{type:'contract',hash:'22'.repeat(32)}},
  {...contract,controller:{type:'contract',hash:'22'.repeat(20),address:account.address}},
  {...contract,scriptLockChecked:true},{...contract,chainMaturityChecked:true}])assert.throws(()=>valid(preview(lock,roles)));
 assert.throws(()=>valid(preview(contract)));
});
