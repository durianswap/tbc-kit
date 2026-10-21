import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const built = await build({ stdin: { contents: `export * from './packages/kit/src/htlc-material.ts';
  export * from './packages/kit/src/htlc-token-material.ts';
  export {createTbcClient} from './packages/kit/src/client.ts';
  export {chainDataRequirement,hashCanonical} from './packages/core/src/index.ts';
  export {preparedChainDataRequirement} from './packages/kit/src/prepared-chain-data.ts';
  export {projectTbcApprovalPreparation} from './packages/kit/src/approval-presentation.ts';`,
  resolveDir: root, loader: 'ts' }, alias: { '@tbc-wallet/core': `${root}packages/core/src/index.ts` },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const { inspectHtlcCode, resolveHtlcMaterial, resolveHtlcTokenMaterial, createTbcClient, chainDataRequirement,
  preparedChainDataRequirement, projectTbcApprovalPreparation, hashCanonical } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
const owner = '751e76e8199196d454941c45d1b3a323f1433bd6';
const stranger = 'aa'.repeat(20), id = '11'.repeat(32), hashlock = 'cc'.repeat(32);
function code(time = 829999, sender = owner, receiver = owner) {
  const n = Buffer.alloc(4); n.writeUInt32LE(time);
  return `63a820${hashlock}8876a914${receiver}6704${n.toString('hex')}8152ba816ea0646e040065cd1da263040065cd1da269a1676d7551686700686956ba01247f778104ffffffff9e6976a914${sender}6888ac`;
}
function setup(branch = 'claim') {
  const reads = [], points = [0, 1].map(vout => ({ txid: id, vout }));
  const parent = { txid: id, rawTransaction: 'fixture', confirmations: '2',
    outputs: [0, 1].map(vout => ({ vout, satoshis: '10000', scriptPubKey: code() })) };
  const status = { txos: points.map(p => ({ txid: p.txid, index: String(p.vout), value: '10000', height: '829999', spent: false })) };
  const node = { blocks: '830000', bestblockhash: 'bb'.repeat(32), mediantime: '1700000000' };
  const input = { branch, ownerScript: `76a914${owner}88ac`, inputOutpoints: points, minimumConfirmations: '0',
    api: { nodeInfo: async () => { reads.push('tip'); return node; },
      txoStatus: async params => { reads.push('status'); assert.deepEqual(params, { txos: points.map(p => ({ txid: p.txid, index: p.vout })) }); return status; } },
    readHistory: async txid => { reads.push('raw'); assert.equal(txid, id); return parent; },
    readDecoded: async txid => { reads.push('decoded'); assert.equal(txid, id); return parent; } };
  return { input, reads, parent, status, node, points };
}
test('exact native HTLC code decode preserves script roles and unsigned lock bytes', () => {
  assert.deepEqual(inspectHtlcCode(code()), { hashlock, receiverHash: owner, senderHash: owner, lockTime: 829999 });
  assert.equal(inspectHtlcCode(code(0xffffffff)).lockTime, 0xffffffff);
  for (const bad of [code().slice(2), `${code()}00`, code().replace('8152ba', '8153ba'), code().toUpperCase()]) {
    assert.throws(() => inspectHtlcCode(bad), /Unsupported HTLC/);
  }
});
test('claim and refund share selected sibling parent reads without native funding or ancestor queries', async () => {
  for (const branch of ['claim', 'refund']) {
    const run = setup(branch), result = await resolveHtlcMaterial(run.input);
    assert.deepEqual(run.reads, branch === 'claim' ? ['status', 'raw'] : ['tip', 'status', 'raw']);
    assert.equal(result.parents.length, 1); assert.equal(result.utxos.length, 2);
    assert.ok(result.utxos.every(u => u.classification === 'htlc' && u.confirmations === (branch === 'claim' ? undefined : '2')));
    assert.equal(result.tip?.medianTimePast, branch === 'claim' ? undefined : '1700000000');
  }
});
test('claim has no refund deadline; role must match the chosen branch', async () => {
  for (const time of [829999, 830001, 1700000001]) {
    const run = setup(); run.parent.outputs.forEach(o => { o.scriptPubKey = code(time, stranger, owner); });
    assert.equal((await resolveHtlcMaterial(run.input)).utxos.length, 2);
    run.input.branch = 'refund'; await assert.rejects(resolveHtlcMaterial(run.input), /role mismatch/);
  }
  const run = setup(); run.parent.outputs.forEach(o => { o.scriptPubKey = code(829999, owner, stranger); });
  await assert.rejects(resolveHtlcMaterial(run.input), /role mismatch/);
  run.input.branch = 'refund'; assert.equal((await resolveHtlcMaterial(run.input)).utxos.length, 2);
});
test('refund requires safe locks, one time domain and strict MTP but height equality is mature', async () => {
  for (const time of [0, 830001, 1700000000, 1700000001, 0x80000000, 0xffffffff]) {
    const run = setup('refund'); run.parent.outputs.forEach(o => { o.scriptPubKey = code(time); });
    await assert.rejects(resolveHtlcMaterial(run.input), /maturity mismatch/);
  }
  for (const time of [830000, 1699999999]) {
    const run = setup('refund'); run.parent.outputs.forEach(o => { o.scriptPubKey = code(time); });
    assert.equal((await resolveHtlcMaterial(run.input)).utxos.length, 2);
  }
  const mixed = setup('refund'); mixed.parent.outputs[1].scriptPubKey = code(1699999999);
  await assert.rejects(resolveHtlcMaterial(mixed.input), /domain/);
  mixed.parent.outputs[0].scriptPubKey = code(1699999999); delete mixed.node.mediantime;
  await assert.rejects(resolveHtlcMaterial(mixed.input), /maturity/);
});
test('only missing confirmation height above zero floor refreshes a unique decoded parent', async () => {
  const run = setup(); delete run.status.txos[0].height;
  await resolveHtlcMaterial(run.input); assert.deepEqual(run.reads, ['status', 'raw']);
  run.reads.length = 0; run.input.minimumConfirmations = '1';
  await resolveHtlcMaterial(run.input); assert.deepEqual(run.reads, ['tip', 'status', 'decoded']);
  delete run.parent.confirmations; await assert.rejects(resolveHtlcMaterial(run.input), /confirmations/);
  run.status.txos.forEach(r => { r.height = '-1'; });
  await assert.rejects(resolveHtlcMaterial(run.input), /confirmations/);
  run.input.minimumConfirmations = '0';
  assert.ok((await resolveHtlcMaterial(run.input)).utxos.every(u => u.confirmations === '0'));
});
test('invalid, duplicate, spent, unexpected or mismatched selected deposits cannot enter material', async () => {
  const mutations = [r => r.status.txos.pop(), r => { r.status.txos[1] = r.status.txos[0]; },
    r => { r.status.txos[0].spent = true; }, r => { r.status.txos[0].txid = 'dd'.repeat(32); },
    r => { r.status.txos[0].index = '00'; }, r => { r.status.txos[0].value = '0'; },
    r => { r.status.txos[0].value = '10001'; }, r => { r.status.txos[0].scriptPubKey = '51'; },
    r => { r.status.txos[0].height = '830001'; }, r => { r.parent.txid = 'dd'.repeat(32); },
    r => { r.node.mediantime = '-1'; }, r => { r.parent.outputs[0].scriptPubKey = '51'; }];
  for (const mutate of mutations) {
    const run = setup(); run.input.minimumConfirmations = '1'; mutate(run); await assert.rejects(resolveHtlcMaterial(run.input));
  }
  const invalid = setup(); invalid.points.push(invalid.points[0]);
  await assert.rejects(resolveHtlcMaterial(invalid.input), /Invalid HTLC material/); assert.deepEqual(invalid.reads, []);
});
test('selected points and account role are fixed before asynchronous reads', async () => {
  const run = setup();
  run.input.api.txoStatus = async params => {
    assert.deepEqual(params.txos.map(p => p.index), [0, 1]);
    run.points[0].vout = 99; run.input.branch = 'refund'; run.input.ownerScript = `76a914${stranger}88ac`;
    return run.status;
  };
  const result = await resolveHtlcMaterial(run.input);
  assert.deepEqual(result.utxos.map(u => u.vout), [0, 1]);
});
test('Core and Prepared project only selected deposit reads, never claim secrets', () => {
  const request = { intent: { type: 'tbc-htlc-claim', version: '1.0', preimage: 'abcd' },
    constraints: { inputOutpoints: [{ txid: id, vout: 1 }] } };
  const material = chainDataRequirement(request);
  assert.deepEqual(material, { intentType: 'tbc-htlc-claim', includeAncestry: true,
    inputOutpoints: request.constraints.inputOutpoints, assets: [{ kind: 'htlc' }] });
  assert.deepEqual(preparedChainDataRequirement(request), material);
  assert.ok(!JSON.stringify(material).includes('preimage'));
  request.constraints.inputOutpoints[0].vout = 2; assert.equal(material.inputOutpoints[0].vout, 1);
});
test('Token HTLC requirements share Core/Prepared identity and never send a preimage to chain data',()=>{
  for(const assetStandard of ['tbc20-standard','tbc20-stablecoin'])for(const action of ['lock','claim','refund']){
    const request={intent:{type:`tbc-htlc-${action}`,version:'1.0',assetStandard,contractId:id,
      ...(action==='lock'?{amount:'250',to:'1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',hashlock,lockTime:'830010'}:
        {targetOutpoints:[{txid:id,vout:1}],...(action==='claim'?{preimage:'cafe'.repeat(16)}:{})})}};
    const material=chainDataRequirement(request);
    assert.deepEqual(material,{intentType:request.intent.type,includeAncestry:true,contractIds:[id],
      ...(action==='lock'?{}:{targetOutpoints:[{txid:id,vout:1}]}),assets:[
        {kind:assetStandard==='tbc20-standard'?'ft':'stablecoin',contractId:id,...(action==='lock'?{minimumAmount:'250'}:{})},
        {kind:'native'},...(action==='lock'?[]:[{kind:'htlc'}])]});
    assert.deepEqual(preparedChainDataRequirement(request),material);
    assert.ok(!JSON.stringify(material).includes('preimage'));assert.ok(!JSON.stringify(material).includes('cafe'.repeat(16)));
    if(action==='claim'){
      const model=projectTbcApprovalPreparation({method:'tbc_signTransaction',operationKind:'transaction',request,
        requestHash:hashCanonical(request),expiresAt:Date.parse('2030-01-01T00:00:00Z'),warningScope:[]});
      assert.equal(model.businessTerms.value.assetStandard,assetStandard);assert.equal(model.businessTerms.value.contractId,id);
      assert.ok(!JSON.stringify(model).includes(request.intent.preimage));assert.deepEqual(model.warnings,['HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE']);
    }
  }
});
test('early approval hides claim secret but keeps complete request binding and disclosure warning', () => {
  const request = { intent: { type: 'tbc-htlc-claim', version: '1.0', preimage: 'cafe'.repeat(16) },
    constraints: { inputOutpoints: [{ txid: id, vout: 0 }] } };
  const before = structuredClone(request), requestHash = hashCanonical(request);
  const model = projectTbcApprovalPreparation({ method: 'tbc_signTransaction', operationKind: 'transaction',
    requestHash, request, expiresAt: Date.parse('2030-01-01T00:00:00Z'), warningScope: [] });
  assert.deepEqual(model.businessTerms.value, { type: 'tbc-htlc-claim', version: '1.0' });
  assert.ok(!JSON.stringify(model).includes(request.intent.preimage));
  assert.deepEqual(model.warnings, ['HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE']);
  assert.equal(model.binding.requestHash, requestHash); assert.deepEqual(request, before);
  const workflowRequest = { steps: [{ ...request, id:'claim', kind:'transaction', dependsOn:[] }] };
  const workflow = projectTbcApprovalPreparation({ method: 'tbc_signWorkflow', operationKind: 'workflow',
    requestHash: hashCanonical(workflowRequest), request: workflowRequest,
    expiresAt: Date.parse('2030-01-01T00:00:00Z'), warningScope: [] });
  assert.deepEqual(workflow.warnings, [...model.warnings, 'BATCH_NOT_ATOMIC']);
  assert.deepEqual(workflow.steps[0].warnings, model.warnings);
  assert.ok(!JSON.stringify(workflow).includes(request.intent.preimage));
});
test('HTLC helpers use standard methods, exact points and fee limits', async () => {
  const calls = [], address = '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
  const provider = { async request(call) { calls.push(call); return call.method === 'tbc_requestAccounts' ? [address] : {}; },
    on() {}, removeListener() {}, destroy() {} };
  const wallet = await createTbcClient({ network: 'testnet', provider }).connect();
  const points = [{ txid: id, vout: 1 }];
  await wallet.htlc.lock({ to: address, amount: '10000', hashlock, lockTime: '830001', constraints: { maxFee: '100' } });
  await wallet.htlc.claim({ preimage: 'abcd', inputOutpoints: points, constraints: { maxFee: '100' } });
  await wallet.htlc.refund({ inputOutpoints: points, constraints: { maxFee: '100' } });
  await wallet.walletBuild.sign({ intent: { type: 'tbc-htlc-refund', version: '1.0' }, constraints: { inputOutpoints: points } });
  assert.deepEqual(calls.slice(1).map(c => c.method), ['tbc_sendTransaction', 'tbc_sendTransaction', 'tbc_sendTransaction', 'tbc_signTransaction']);
  assert.deepEqual(calls[2].params.intent, { type: 'tbc-htlc-claim', version: '1.0', preimage: 'abcd' });
  assert.deepEqual(calls[3].params.constraints, { maxFee: '100', inputOutpoints: points });
  assert.ok(calls.slice(1).every(c => c.params.chainId === 'tbc:testnet'));
});

test('Token HTLC client preserves asset selectors without inventing native points', async () => {
  const calls = [], address = '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
  const provider = { async request(call) { calls.push(call); return call.method === 'tbc_requestAccounts' ? [address] : {}; },
    on() {}, removeListener() {}, destroy() {} };
  const wallet = await createTbcClient({ network: 'mainnet', provider }).connect();
  for (const assetStandard of ['tbc20-standard','tbc20-stablecoin']) {
    const asset = {assetStandard,contractId:id}, targetOutpoints = [{txid:id,vout:1}];
    const lock = {...asset,to:address,amount:'10',hashlock,lockTime:'830001'};
    await wallet.htlc.lock(lock);
    assert.deepEqual(calls.at(-1).params.intent,{...lock,type:'tbc-htlc-lock',version:'1.0'});
    await wallet.htlc.claim({...asset,targetOutpoints,preimage:'abcd',constraints:{maxFee:'1000'}});
    assert.deepEqual(calls.at(-1).params.intent,{...asset,targetOutpoints,preimage:'abcd',type:'tbc-htlc-claim',version:'1.0'});
    assert.deepEqual(calls.at(-1).params.constraints,{maxFee:'1000'});
    await wallet.htlc.refund({...asset,targetOutpoints});
    assert.deepEqual(calls.at(-1).params.intent,{...asset,targetOutpoints,type:'tbc-htlc-refund',version:'1.0'});
    assert.equal(calls.at(-1).params.chainId,'tbc:mainnet');
    assert.equal(calls.at(-1).params.constraints,undefined);
  }
});

// Synthetic material only. The public Engine/Host check authenticates real raw
// encodings; these isolated vectors exercise the material boundary and reads.
function tokenSetup(assetStandard='tbc20-standard') {
  const sourceId='22'.repeat(32),ancestorId='33'.repeat(32),depositId='44'.repeat(32);
  const source={txid:sourceId,rawTransaction:'00',inputs:[],outputs:[]};
  const origin={txid:id,rawTransaction:'01',inputs:[{txid:sourceId,vout:0}],outputs:[]};
  const ancestor={txid:ancestorId,rawTransaction:'02',inputs:[],outputs:[]};
  const parent={txid:depositId,rawTransaction:'03',inputs:[],outputs:[
    {vout:0,satoshis:'100',scriptPubKey:code()}, {vout:1,satoshis:'500',scriptPubKey:'aa'}, {vout:2,satoshis:'0',scriptPubKey:'bb'}]};
  const parents=new Map([source,origin,ancestor,parent].map(p=>[p.txid,p])),reads=[];
  const rows=[0,1].map(index=>({txid:depositId,index:String(index),value:index===0?'100':'500',height:'829999',spent:false}));
  const input={assetStandard,contractId:id,templateRevision:'aa'.repeat(32),target:{txid:depositId,vout:1},branch:'claim',
    ownerScript:`76a914${owner}88ac`,minimumConfirmations:'0',
    readTip:async()=>{reads.push(['tip']);return {height:'830000',hash:'55'.repeat(32),medianTimePast:'1800000000'};},
    tokenLockTime:async()=>0,
    readIdentity:async()=>{reads.push(['info']);return {contractId:id,codeScript:'aa',tapeScript:'bb',totalSupply:'1000'};},
    api:{async txoStatus(body){reads.push(['status',body]);return {txos:rows};}},
    async readHistory(txid){reads.push(['raw',txid]);return parents.get(txid);},
    async readDecoded(txid){reads.push(['fresh',txid]);return {...parents.get(txid),confirmations:'2'};},
    ancestors(){return [ancestorId,ancestorId,id];}};
  return {input,reads,rows,parent,parents,sourceId,ancestorId,depositId};
}
test('Token HTLC material selects escrow plus Token and reuses unique ancestry without secret or funding reads', async()=>{
  for(const assetStandard of ['tbc20-standard','tbc20-stablecoin']) {
    const f=tokenSetup(assetStandard),r=await resolveHtlcTokenMaterial(f.input);
    assert.deepEqual(r.utxos.map(u=>[u.vout,u.classification]),[[0,'htlc'],[1,assetStandard==='tbc20-standard'?'ft':'stablecoin']]);
    assert.equal(r.utxos[0].contractId,undefined);assert.equal(r.utxos[1].contractId,id);
    assert.equal(r.contracts[0].standardId,assetStandard);
    assert.equal(f.reads.filter(([kind])=>kind==='raw').length,3);
    assert.equal(f.reads.filter(([kind])=>kind==='info').length,1);
    assert.equal(f.reads.filter(([kind])=>kind==='tip').length,0);
    assert.equal(f.reads.filter(([kind])=>kind==='fresh').length,0);
    assert.deepEqual(f.reads[0],['status',{txos:[0,1].map(index=>({txid:f.depositId,index}))}]);
    assert.ok(!JSON.stringify(f.reads).includes('preimage'));
  }
});
test('Token HTLC refreshes missing confirmations once and snapshots target before I/O', async()=>{
  const f=tokenSetup();f.input.minimumConfirmations='1';f.rows.forEach(row=>delete row.height);
  const pending=resolveHtlcTokenMaterial(f.input);f.input.target.txid='ff'.repeat(32);
  const r=await pending;assert.equal(f.reads.filter(([kind])=>kind==='fresh').length,1);
  assert.ok(r.utxos.every(u=>u.confirmations==='2'&&u.txid===f.depositId));
});
test('Token HTLC rejects unavailable siblings, forged rows, wrong roles and immature refunds', async()=>{
  const changes=[
    f=>{f.rows[0].spent=true;}, f=>{f.rows[1].spent=true;}, f=>{f.rows[1]={...f.rows[0]};},
    f=>{f.rows[1].txid='ff'.repeat(32);}, f=>{f.rows[0].value='101';},f=>{f.rows[0].scriptPubKey='aa';},
    f=>{f.rows[1].height='830001';},f=>{f.rows[1].height='830000';},f=>{f.input.ownerScript=`76a914${stranger}88ac`;},
    f=>{f.input.branch='refund';f.parent.outputs[0].scriptPubKey=code(830001);},
    f=>{f.input.branch='refund';f.parent.outputs[0].scriptPubKey=code(1800000000);},
    f=>{f.input.minimumConfirmations='3';},f=>{f.parent.outputs[2].satoshis='1';},
    f=>{f.input.target.vout=0;},f=>{f.input.assetStandard='historical';},
  ];
  for(const change of changes){const f=tokenSetup();change(f);await assert.rejects(resolveHtlcTokenMaterial(f.input));}
  const f=tokenSetup();f.input.branch='refund';f.parent.outputs[0].scriptPubKey=code(830000);
  assert.equal((await resolveHtlcTokenMaterial(f.input)).utxos.length,2);
});
