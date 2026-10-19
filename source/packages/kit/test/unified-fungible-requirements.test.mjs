import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { build } from 'esbuild';

const root = new URL('../../../', import.meta.url);
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addFormat('uri', /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f]*$/);
ajv.addFormat('date-time', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/);
for (const name of await readdir(new URL('schemas/', root))) {
  if (name.endsWith('.json')) ajv.addSchema(JSON.parse(await readFile(new URL(`schemas/${name}`, root), 'utf8')));
}
const schema = JSON.parse(await readFile(new URL('schemas/transaction-request.schema.json', root), 'utf8'));
const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/tbcIntent` });
const integration = JSON.parse(await readFile(new URL('schemas/integration.schema.json', root), 'utf8'));
const validateRequirement = ajv.compile({ $ref: `${integration.$id}#/$defs/chainDataRequirement` });
const bundle = await build({
  stdin: { contents: 'export { chainDataRequirement, assertValidTws, hashCanonical } from "@tbc-wallet/core"; export { TWS_CAPABILITY_INTENTS } from "../../core/src/engine.ts"; export { preparedChainDataRequirement } from "./prepared-chain-data.ts"; export { assertTbcProviderMethodParams } from "../../provider/src/validation.ts"; export { TBC_PROVIDER_METHODS } from "../../provider/src/types.ts";',
    resolveDir: fileURLToPath(new URL('../src/', import.meta.url)), loader: 'ts' },
  alias: { '@tbc-wallet/core': fileURLToPath(new URL('../../core/src/index.ts', import.meta.url)) },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022',
});
const url = new URL('../src/.unified-requirements-test.mjs', import.meta.url).href;
const hooks = registerHooks({
  resolve(s, c, next) { return s === url ? { url, shortCircuit: true } : next(s, c); },
  load(u, c, next) { return u === url ? { source: bundle.outputFiles[0].text, format: 'module', shortCircuit: true } : next(u, c); },
});
const { chainDataRequirement, preparedChainDataRequirement, assertValidTws, hashCanonical, TWS_CAPABILITY_INTENTS,
  assertTbcProviderMethodParams, TBC_PROVIDER_METHODS } = await import(url);
hooks.deregister();
const ID = '11'.repeat(32), FROM = '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
const intent = (type, fields = {}) => ({ type, version: '1.0', contractId: ID, ...fields });

test('shared LP requirements retain exact inputs without adding a current Pool dependency',()=>{
 for(const [type,fields] of [['transfer',{amount:'9',to:FROM}],['lock',{amount:'9',lockTime:'900000'}],['unlock',{}],['merge',{}],['burn',{}]]){
  const request={version:'1.0',chainId:'tbc:testnet',from:FROM,intent:{type:`tbc20Lp.${type}`,version:'1.0',poolContractId:ID,...fields},
   constraints:{inputOutpoints:[{txid:ID,vout:2}]}};
  assertValidTws('transactionRequest',request);
  const requirement=chainDataRequirement(request);
  assert.deepEqual(requirement,preparedChainDataRequirement(request));
  assert.equal(validateRequirement(requirement),true);
  assert.deepEqual(requirement.assets,[{kind:'native'},{kind:'ftlp',contractId:ID,...(fields.amount?{minimumAmount:fields.amount}:{})}]);
  assert.deepEqual(requirement.inputOutpoints,request.constraints.inputOutpoints);
  assert.ok(TWS_CAPABILITY_INTENTS.includes(request.intent.type));
  for(const role of ['coin-admin','pool-controller'])assert.throws(()=>assertValidTws('transactionRequest',{...request,signingRoles:[{role,accountId:`tbc:testnet:${FROM}`}]}));
  for(const method of ['tbc_signTransaction','tbc_sendTransaction'])assert.deepEqual(assertTbcProviderMethodParams(method,request),request);
 }
 const request={intent:{type:'amm.mergeToken',version:'1.0',poolContractId:ID},constraints:{inputOutpoints:[{txid:ID,vout:0}]}};
 const r=chainDataRequirement(request);assert.deepEqual(r,preparedChainDataRequirement(request));
 assert.deepEqual(r.assets,[{kind:'native'},{kind:'pool',contractId:ID},{kind:'ft',contractDependency:{contractId:ID,relation:'pool-ft'}}]);
 assert.deepEqual(r.inputOutpoints,request.constraints.inputOutpoints);
});

test('unified Pool requests retain shared Core/Prepared material requirements and controller scope', t => {
  t.mock.method(globalThis, 'fetch', () => { throw Error('projection must remain offline'); });
  const cases = [
    ['amm.swap', 'tbc-amm-swap', { direction: 'tbc-to-ft', amount: '1000', minimumOutput: '9' }],
    ['amm.swap', 'tbc-amm-swap', { direction: 'ft-to-tbc', amount: '1000', minimumOutput: '9' }],
    ['amm.addLiquidity', 'tbc-amm-add-liquidity', { budgetAsset: 'tbc', amount: '1000', minimumLpAmount: '9' }],
    ['amm.addLiquidity', 'tbc-amm-add-liquidity', { budgetAsset: 'ft', amount: '1000', minimumLpAmount: '9' }],
    ['amm.removeLiquidity', 'tbc-amm-remove-liquidity', { lpAmount: '1000', minimumTbcAmount: '9', minimumFtAmount: '9' }],
  ];
  for (const [type, concrete, fields] of cases) {
    const request = {version:'1.0',chainId:'tbc:testnet',from:FROM,
      intent:{type,version:'1.0',poolContractId:ID,...fields},constraints:{inputOutpoints:[{txid:ID,vout:0}]}};
    assertValidTws('transactionRequest', request);
    assert.ok(TWS_CAPABILITY_INTENTS.includes(type));
    const requirement = chainDataRequirement(request);
    assert.deepEqual(requirement, preparedChainDataRequirement(request));
    assert.deepEqual(requirement, {...chainDataRequirement({...request,intent:{...request.intent,type:concrete}}),intentType:type});
    assert.equal(validateRequirement(requirement),true);
    assert.deepEqual(requirement.inputOutpoints,request.constraints.inputOutpoints);
    const controlled = {...request,signingRoles:[{role:'pool-controller',accountId:`tbc:testnet:${FROM}`}]};
    assertValidTws('transactionRequest',controlled);
    for (const method of ['tbc_signTransaction','tbc_sendTransaction']) {
      assert.deepEqual(assertTbcProviderMethodParams(method,controlled),controlled);
    }
    assert.throws(()=>assertValidTws('transactionRequest',{...controlled,signingRoles:[{role:'coin-admin',accountId:`tbc:testnet:${FROM}`}]}));
    for(const value of [{protocolVersion:'2.0'},{amount:'1.1'},{lpPlan:1}]) {
      assert.equal(validate({...request.intent,...value}),false);
    }
  }
});

test('unified transfer/merge are valid request intents without client-selected contract versions', () => {
  for (const family of ['tbc20', 'tbc20Stablecoin']) {
    for (const fields of [{ to: FROM, amount: '9' }, { receivers: [{ to: FROM, amount: '4' }, { to: FROM, amount: '5' }] }]) {
      assert.equal(validate(intent(`${family}.transfer`, fields)), true, JSON.stringify(validate.errors));
    }
    assert.equal(validate(intent(`${family}.merge`)), true, JSON.stringify(validate.errors));
    for (const fields of [{}, { to: FROM, amount: '0' }, { to: FROM, amount: '1.1' },
      { to: FROM, amount: '1', receivers: [{ to: FROM, amount: '1' }] },
      { to: FROM, amount: '1', protocolVersion: '4.0' }, { to: FROM, amount: '1', attachedTbcAmount: '1' }]) {
      assert.equal(validate(intent(`${family}.transfer`, fields)), false);
    }
    assert.equal(validate(intent(`${family}.merge`, { payment: { to: FROM, amount: '1' } })), false);
  }
});

test('unified NFT request shares Core and Prepared projection without losing selected inputs',()=>{
  const request={version:'1.0',chainId:'tbc:testnet',from:FROM,
    intent:intent('tbc721.transfer',{to:FROM,payment:{to:FROM,amount:'24'}}),
    constraints:{inputOutpoints:[{txid:ID,vout:0}]}};
  assertValidTws('transactionRequest',request);
  assert.equal(validate(request.intent),true);
  assert.ok(TWS_CAPABILITY_INTENTS.includes('tbc721.transfer'));
  const requirement=chainDataRequirement(request);
  assert.deepEqual(requirement,preparedChainDataRequirement(request));
  assert.deepEqual(requirement,{intentType:'tbc721.transfer',includeAncestry:true,contractIds:[ID],nativeAmount:'24',
    assets:[{kind:'native',minimumAmount:'24'},{kind:'nft',contractId:ID,minimumAmount:'1'}],inputOutpoints:[{txid:ID,vout:0}]});
  assert.equal(validateRequirement(requirement),true);
  for(const fields of [{amount:'1'},{protocolVersion:'2.0'},{slot:1},{collectionId:ID}]){
    assert.equal(validate({...request.intent,...fields}),false);
  }
});

test('wallet and Prepared use the same original request and material budget with no I/O', t => {
  const unexpected = () => { throw Error('Requirement projection must not fetch or initialize Engine'); };
  t.mock.method(globalThis, 'fetch', unexpected);
  t.mock.method(WebAssembly, 'instantiate', unexpected);
  for (const [family, kind] of [['tbc20', 'ft'], ['tbc20Stablecoin', 'stablecoin']]) {
    for (const operation of ['transfer', 'merge']) {
      const input = intent(`${family}.${operation}`, operation === 'transfer'
        ? { receivers: [{ to: FROM, amount: '4' }, { to: FROM, amount: '5' }], payment: { to: FROM, amount: '3' } } : {});
      const request = { version: '1.0', chainId: 'tbc:testnet', from: FROM, intent: input,
        constraints: { inputOutpoints: [{ txid: ID, vout: 2 }] } };
      const before = JSON.stringify(request);
      assertValidTws('transactionRequest', request);
      assert.ok(TWS_CAPABILITY_INTENTS.includes(input.type));
      assert.equal(validate(input), true, JSON.stringify(validate.errors));
      const actual = chainDataRequirement(request);
      assert.equal(validateRequirement(actual), true, 'Core port requirement must accept unified intents');
      assert.deepEqual(preparedChainDataRequirement(request), actual);
      assert.deepEqual(actual, { intentType: input.type, includeAncestry: true, contractIds: [ID],
        ...(operation === 'transfer' ? { nativeAmount: '3' } : {}), inputOutpoints: [{ txid: ID, vout: 2 }],
        assets: [{ kind: 'native', ...(operation === 'transfer' ? { minimumAmount: '3' } : {}) },
          { kind, contractId: ID, ...(operation === 'transfer' ? { minimumAmount: '9' } : {}) }] });
      assert.equal(JSON.stringify(request), before);
      assert.ok(Object.isFrozen(actual) && Object.isFrozen(actual.assets));
    }
  }
});

test('recipient bounds follow shape validation; actual template restrictions stay in Engine', () => {
  const receivers = Array.from({ length: 8 }, () => ({ to: FROM, amount: '1' }));
  assert.equal(validate(intent('tbc20.transfer', { receivers })), true);
  assert.equal(validate(intent('tbc20Stablecoin.transfer', { receivers })), false);
  assert.equal(validate(intent('tbc20.transfer', { receivers, payment: { to: FROM, amount: '1' } })), false);
  for (const type of ['tbc20.transfer', 'tbc20Stablecoin.transfer']) {
    assert.throws(() => chainDataRequirement({ intent: intent(type, { receivers: [{ to: FROM, amount: '99999999999999999999999999999999999999' }] }) }), /allocation bound/);
  }
});

test('Core and Provider accept unified intents through existing single/Prepared/workflow methods', async () => {
  const fixture = JSON.parse(await readFile(new URL('test-vectors/integration.json', root), 'utf8')).canonicalTransfer;
  const inputs = ['tbc20','tbc20Stablecoin'].flatMap(family=>['transfer','merge'].map(operation=>
    intent(`${family}.${operation}`,operation==='transfer'?{to:FROM,amount:'9'}:{})));
  inputs.push(
    {type:'amm.swap',version:'1.0',poolContractId:ID,direction:'tbc-to-ft',amount:'1000',minimumOutput:'1'},
    {type:'amm.addLiquidity',version:'1.0',poolContractId:ID,budgetAsset:'tbc',amount:'1000',minimumLpAmount:'1'},
    {type:'amm.removeLiquidity',version:'1.0',poolContractId:ID,lpAmount:'1000',minimumTbcAmount:'1',minimumFtAmount:'1'},
  );
  for (const input of inputs) {
    const request = { version: '1.0', chainId: 'tbc:testnet', from: FROM, intent: input };
    // Structurally valid proposal for transport testing only. Its synthetic
    // native bytes are not proof of a fungible operation or signing authority.
    const payload = { version: '1.0', engineProfile: 'tbc-engine-plan-v1',
      createdAt: fixture.snapshot.payload.capturedAt, expiresAt: fixture.plan.payload.expiresAt,
      intentHash: hashCanonical(input), transactions: fixture.plan.payload.transactions.map(tx => ({
        id: tx.id, role: tx.role, dependsOn: tx.dependsOn, kind: 'fixed', unsignedTransaction: tx.unsignedTransaction, fee: tx.fee,
      })), evidence: { observedAt: fixture.snapshot.payload.capturedAt, parentTransactions: fixture.snapshot.payload.parents, contracts: [] },
      estimatedTotalFee: fixture.plan.payload.preview.totalFee };
    const proposal = { payload, proposalHash: hashCanonical(payload) };
    const workflow = { version: '1.0', chainId: request.chainId, from: FROM, steps: [{ id: 'operation', kind: 'transaction', dependsOn: [], intent: input }] };
    const preparedWorkflow = { ...workflow, steps: [{ ...workflow.steps[0], kind: 'preparedTransaction', proposal }] };
    for (const [schemaName, params, methods] of [
      ['transactionRequest', request, ['tbc_signTransaction', 'tbc_sendTransaction']],
      ['preparedTransactionRequest', { ...request, proposal }, ['tbc_signPreparedTransaction', 'tbc_sendPreparedTransaction']],
      ['workflowRequest', workflow, ['tbc_signWorkflow', 'tbc_sendWorkflow']],
      ['preparedWorkflowRequest', preparedWorkflow, ['tbc_signPreparedWorkflow', 'tbc_sendPreparedWorkflow']],
    ]) {
      assertValidTws(schemaName, params);
      for (const method of methods) assert.deepEqual(assertTbcProviderMethodParams(method, params), params);
    }
    for (const method of ['tbc_signTransaction', 'tbc_sendTransaction']) {
      assert.throws(() => assertTbcProviderMethodParams(method, { ...request, intent: { ...input, protocolVersion: '4.0' } }));
    }
  }
  assert.equal(TBC_PROVIDER_METHODS.length, 22);
  assert.ok(!TBC_PROVIDER_METHODS.some(method => /tbc20|amm_swap/.test(method)));
});

test('capability wire can express exact unified operations without inventing Provider RPCs', async()=>{
  const provider=JSON.parse(await readFile(new URL('schemas/provider.schema.json',root),'utf8'));
  const accept=ajv.compile({$ref:`${provider.$id}#/$defs/capabilities/properties/intents`});
  for(const name of ['tbc721.transfer','tbc20.transfer','tbc20.merge','tbc20Stablecoin.transfer','tbc20Stablecoin.merge',
    'amm.swap','amm.addLiquidity','amm.removeLiquidity','amm.mergeToken',
    'tbc20Lp.transfer','tbc20Lp.lock','tbc20Lp.unlock','tbc20Lp.merge','tbc20Lp.burn',
    'tbc-lop-create','tbc-lop-cancel','tbc-lop-match']) {
    assert.equal(accept({[name]:['1.0']}),true,JSON.stringify(accept.errors));
  }
  assert.equal(accept({'amm.unimplemented':['1.0']}),false);
  // The wire schema still accepts this historical collection capability until
  // its deferred removal; a partner wallet must omit it from its own scope.
  assert.equal(accept({'tbc.collection.create':['1.0']}),true);
  for(const name of ['tbc.ft.create','tbc.nft.mint','tbc.pool.create']) {
    assert.equal(accept({[name]:['1.0']}),false,'Disabled issuance must not be advertised');
  }
});
