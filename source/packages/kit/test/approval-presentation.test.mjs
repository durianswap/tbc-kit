import assert from "node:assert/strict";
import test from "node:test";

import { hashCanonical } from "@tbc-wallet/core";
import {
  ApprovalHostEvidenceConflictError,
  projectTbcApprovalPreparation,
  projectTbcApprovalPresentation,
} from "../dist/esm/wallet.js";
import { renderApprovalPresentation } from "../examples/approval-presentation/renderer.mjs";

const CHAIN_ID = "tbc:testnet";
const FROM = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const TO = "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";
const ACCOUNT_ID = `${CHAIN_ID}:${FROM}`;
const EXPIRES = "2026-09-25T00:05:00Z";
const RELEASE = "08".repeat(32);

test("permission presentation preserves positional params and binds the permission proposal", () => {
  const requested = [{ tbc_accounts: { chains: [CHAIN_ID] }, tbc_signMessage: { chains: [CHAIN_ID] } }];
  const preview = { operationKind: "permission", requested,
    granted: ["tbc_accounts", "tbc_signMessage"].map(capability => ({ capability, chainId: CHAIN_ID, accountIds: [ACCOUNT_ID], methods: [capability] })),
    decisions: ["tbc_accounts", "tbc_signMessage"].map(capability => ({ capability, status: "narrowed", reason: "ONE_ACCOUNT_PER_CHAIN" })),
    warnings: ["PERMISSION_NARROWED"] };
  const proposal = { version: "1.0", origin: "https://wallet.example", requested, changes: [], decisions: preview.decisions,
    createdAt: "2026-09-25T00:00:00Z", expiresAt: EXPIRES };
  const evidence = structuredClone(formalEvidence({ method: "wallet_requestPermissions", operationKind: "permission",
    request: requested, preview, planPayload: proposal, planKey: "permissionProposalHash" }));
  const payload = evidence.params.binding.payload;
  delete payload.chainId; delete payload.accountId; payload.chainIds = [CHAIN_ID];
  evidence.params.binding.bindingHash = hashCanonical(payload);
  evidence.memory.permissionProposal = { payload: proposal, permissionProposalHash: hashCanonical(proposal) };
  delete evidence.memory.workflowPlan;
  const projected = projectTbcApprovalPresentation(frozen(evidence));
  assert.equal(projected.trust, "binding-verified");
  assert.equal(projected.operationKind, "permission");
  assert.equal(projected.binding.requestHash, hashCanonical(requested));
  const changed = structuredClone(evidence);
  changed.memory.permissionProposal.payload.origin = "https://other.example";
  assert.throws(() => projectTbcApprovalPresentation(changed), ApprovalHostEvidenceConflictError);
});

function frozen(value) {
  const clone = structuredClone(value);
  const visit = (entry) => {
    if (entry !== null && typeof entry === "object") {
      for (const child of Object.values(entry)) visit(child);
      Object.freeze(entry);
    }
  };
  visit(clone);
  return clone;
}

test("requestAccounts presentation binds the Core-derived active-chain permission request", () => {
  const requested = [{ tbc_accounts: { chains: [CHAIN_ID], maxAccounts: 1 } }];
  const preview = { operationKind: "permission", requested,
    granted: [{ capability: "tbc_accounts", chainId: CHAIN_ID, accountIds: [ACCOUNT_ID], methods: ["tbc_accounts"] }],
    decisions: [{ capability: "tbc_accounts", status: "granted", reason: "SUPPORTED" }], warnings: [] };
  const proposal = { version: "1.0", origin: "https://wallet.example", requested, changes: [], decisions: preview.decisions,
    createdAt: "2026-09-25T00:00:00Z", expiresAt: EXPIRES };
  const evidence = structuredClone(formalEvidence({ method: "tbc_requestAccounts", operationKind: "permission",
    request: requested, preview, planPayload: proposal, planKey: "permissionProposalHash" }));
  delete evidence.payload.operation.params;
  evidence.payload.session = { state: { activeChainId: CHAIN_ID } };
  const payload = evidence.params.binding.payload;
  delete payload.chainId; delete payload.accountId; payload.chainIds = [CHAIN_ID];
  evidence.params.binding.bindingHash = hashCanonical(payload);
  evidence.memory.permissionProposal = { payload: proposal, permissionProposalHash: hashCanonical(proposal) };
  delete evidence.memory.workflowPlan;
  assert.equal(projectTbcApprovalPresentation(frozen(evidence)).binding.requestHash, hashCanonical(requested));
  const changed = structuredClone(evidence);
  changed.payload.session.state.activeChainId = "tbc:mainnet";
  assert.throws(() => projectTbcApprovalPresentation(frozen(changed)), ApprovalHostEvidenceConflictError);
});

function formalEvidence({ method, operationKind, request, preview, planPayload, planKey }) {
  const requestHash = hashCanonical(request);
  const operationHash = hashCanonical(planPayload);
  const bindingPayload = {
    version: "1.0",
    method,
    operationKind,
    contextHash: "11".repeat(32),
    origin: "https://wallet.example",
    sessionId: "approval-presentation-session",
    chainId: CHAIN_ID,
    accountId: ACCOUNT_ID,
    requestHash,
    operationHash,
    expiresAt: EXPIRES,
  };
  const binding = { payload: bindingPayload, bindingHash: hashCanonical(bindingPayload) };
  const params = {
    version: "1.0",
    binding,
    requester: {
      transport: "remote",
      origin: "https://wallet.example",
      topOrigin: "https://wallet.example",
      frame: "top",
    },
    preview,
  };
  const operationId = "operation-presentation";
  const callId = "call-presentation";
  const plan = { payload: planPayload, [planKey]: operationHash };
  return frozen({
    callId,
    operationId,
    releaseFingerprint: RELEASE,
    call: { callId, operation: "approval.request", params },
    params,
    operation: { operationId, releaseFingerprint: RELEASE, transition: { checkpoint: { payload: {} } } },
    payload: { operationId, operation: { method, params: request } },
    memory: {
      requestHash,
      approvalBinding: binding,
      approvalPreview: preview,
      ...(operationKind === "transaction"
        ? { normalizedTransaction: { request, requestHash }, executionPlan: plan }
        : { workflowPlan: plan }),
    },
  });
}

test("reviewed LOP terms survive formal single and workflow presentation and binding rejects mutation", () => {
  const terms={standardId:'tbc-lop',side:'sell',market:'native-token',ownerHash:'01'.repeat(20),feeRecipientHash:'02'.repeat(20),
    saleVolume:'9007199254740993',unitPrice:'1000000',feeRate:'10',priceScale:'1000000',feeScale:'1000000',
    baseAsset:{kind:'native'},quoteAsset:{kind:'token',contractId:'03'.repeat(32),partialHash:'04'.repeat(32)}};
  const lopOrders=[{transactionIndex:0,verification:'exact-template',assetIdentityVerified:false,inputs:[],outputs:[{index:0,terms}]}];
  const coinLocks=[{transactionIndex:0,position:'input',index:1,contractId:'03'.repeat(32),amount:'100',owner:FROM,
    lockTime:12,domain:'height',transactionLockTime:12,sequence:4294967294,scriptLockChecked:true,chainMaturityChecked:false}];
  const rawRequest={payload:{format:'raw',transactions:[]}};
  const transactionPreview={operationKind:'transaction',assetFlows:[],totalFee:'1',transactionCount:1,warnings:['LOCKED_ASSET'],irreversible:true,lopOrders,coinLocks};
  const singleRequest={chainId:CHAIN_ID,from:FROM,request:rawRequest,maxFee:'100'};
  const evidence=structuredClone(formalEvidence({method:'tbc_signReviewedTransaction',operationKind:'transaction',request:singleRequest,
    preview:transactionPreview,planPayload:{requestHash:hashCanonical(singleRequest),preview:transactionPreview,task:{purpose:'reviewedTransaction'}},planKey:'planHash'}));
  evidence.memory.walletActionPlan=evidence.memory.executionPlan;
  delete evidence.memory.executionPlan;delete evidence.memory.normalizedTransaction;
  const single=projectTbcApprovalPresentation(frozen(evidence));
  assert.deepEqual(single.businessTerms,{status:'known',source:'engine-preview',value:{type:'tbc-lop',orders:lopOrders,coinLocks}});
  assert.equal(single.unknown.includes('businessTerms'),false);
  assert.equal(single.counts.signingTasks.status,'unknown');
  assert.equal(single.fees.maximumAtomic.value,'100');
  const changed=structuredClone(evidence);
  changed.memory.walletActionPlan.payload.preview.lopOrders[0].outputs[0].terms.unitPrice='2';
  assert.throws(()=>projectTbcApprovalPresentation(changed),ApprovalHostEvidenceConflictError);
  const changedLock=structuredClone(evidence);changedLock.memory.walletActionPlan.payload.preview.coinLocks[0].lockTime=0;
  assert.throws(()=>projectTbcApprovalPresentation(changedLock),ApprovalHostEvidenceConflictError);
  const workflowRequest={chainId:CHAIN_ID,from:FROM,steps:[{id:'raw',kind:'reviewedTransaction',dependsOn:[],request:rawRequest}]};
  const preview={operationKind:'workflow',failureMode:'atomic',bindings:[],totalFee:'1',warnings:[],steps:[{id:'raw',kind:'reviewedTransaction',dependsOn:[],reviewedTransactionPreview:transactionPreview}]};
  const workflow=projectTbcApprovalPresentation(formalEvidence({method:'tbc_signWorkflow',operationKind:'workflow',request:workflowRequest,
    preview,planPayload:{requestHash:hashCanonical(workflowRequest),preview,transactionPlans:[],reviewedTransactionTasks:[{requestHash:hashCanonical(rawRequest)}]},planKey:'workflowPlanHash'}));
  assert.deepEqual(workflow.steps[0].businessTerms,single.businessTerms);
});

test("contract-held Coin display retains a bound controller hash, not an invented owner address", () => {
  const coinLocks=[{transactionIndex:0,position:'output',index:0,contractId:'03'.repeat(32),amount:'300',
    controller:{type:'contract',hash:'22'.repeat(20)},lockTime:0,domain:'none',transactionLockTime:0,scriptLockChecked:false,chainMaturityChecked:false}];
  const request={chainId:CHAIN_ID,from:FROM,request:{payload:{format:'raw',transactions:[]}},maxFee:'100'};
  const preview={operationKind:'transaction',assetFlows:[],totalFee:'1',transactionCount:1,warnings:[],irreversible:true,coinLocks};
  const evidence=structuredClone(formalEvidence({method:'tbc_signReviewedTransaction',operationKind:'transaction',request,
    preview,planPayload:{requestHash:hashCanonical(request),preview,task:{purpose:'reviewedTransaction'}},planKey:'planHash'}));
  evidence.memory.walletActionPlan=evidence.memory.executionPlan;delete evidence.memory.executionPlan;delete evidence.memory.normalizedTransaction;
  const result=projectTbcApprovalPresentation(frozen(evidence));
  assert.deepEqual(result.businessTerms.value,{type:'tbc20-stablecoin',coinLocks});
  assert.deepEqual(renderApprovalPresentation(result).businessTerms.value.coinLocks[0].controller,coinLocks[0].controller);
  assert.equal(result.businessTerms.value.coinLocks[0].owner,undefined);
  for(const field of ['hash','type']){
    const bad=structuredClone(evidence);bad.memory.walletActionPlan.payload.preview.coinLocks[0].controller[field]='changed';
    assert.throws(()=>projectTbcApprovalPresentation(bad),ApprovalHostEvidenceConflictError);
  }
});

test("native TimeLock terms are bound and available to single and workflow approval UI", () => {
  const timeLocks=[{transactionIndex:0,position:'input',index:0,amount:'10000',owner:FROM,
    lockHeight:100,domain:'height',transactionLockTime:100,sequence:4294967294,verification:'exact-template',
    scriptLockChecked:true,chainMaturityChecked:false,scriptExecutionVerified:false}];
  const rawRequest={payload:{format:'raw',transactions:[]}};
  const preview={operationKind:'transaction',assetFlows:[],totalFee:'80',transactionCount:1,warnings:['LOCKED_ASSET'],irreversible:true,timeLocks};
  const request={chainId:CHAIN_ID,from:FROM,request:rawRequest,maxFee:'100'};
  const evidence=structuredClone(formalEvidence({method:'tbc_signReviewedTransaction',operationKind:'transaction',request,
    preview,planPayload:{requestHash:hashCanonical(request),preview,task:{purpose:'reviewedTransaction'}},planKey:'planHash'}));
  evidence.memory.walletActionPlan=evidence.memory.executionPlan;
  delete evidence.memory.executionPlan;delete evidence.memory.normalizedTransaction;
  const single=projectTbcApprovalPresentation(frozen(evidence));
  assert.deepEqual(single.businessTerms,{status:'known',source:'engine-preview',value:{type:'tbc-timelock',timeLocks}});
  for(const field of ['owner','amount','lockHeight','sequence']){
    const changed=structuredClone(evidence);changed.memory.walletActionPlan.payload.preview.timeLocks[0][field]='changed';
    assert.throws(()=>projectTbcApprovalPresentation(changed),ApprovalHostEvidenceConflictError);
  }
  const workflowRequest={chainId:CHAIN_ID,from:FROM,steps:[{id:'raw',kind:'reviewedTransaction',dependsOn:[],request:rawRequest}]};
  const workflowPreview={operationKind:'workflow',failureMode:'atomic',bindings:[],totalFee:'80',warnings:[],
    steps:[{id:'raw',kind:'reviewedTransaction',dependsOn:[],reviewedTransactionPreview:preview}]};
  const workflow=projectTbcApprovalPresentation(formalEvidence({method:'tbc_signWorkflow',operationKind:'workflow',request:workflowRequest,
    preview:workflowPreview,planPayload:{requestHash:hashCanonical(workflowRequest),preview:workflowPreview,transactionPlans:[],reviewedTransactionTasks:[{requestHash:hashCanonical(rawRequest)}]},planKey:'workflowPlanHash'}));
  assert.deepEqual(workflow.steps[0].businessTerms,single.businessTerms);
});

test("raw HTLC public terms remain bound in single and workflow approvals without claiming a branch", () => {
  const htlcLocks=[{transactionIndex:0,position:'input',index:0,amount:'10000',hashlock:'12'.repeat(32),sender:FROM,receiver:TO,
    lockTime:100,domain:'height',transactionLockTime:0,sequence:4294967295,verification:'exact-template',branch:'unresolved',
    preimageVerified:false,chainMaturityChecked:false,scriptExecutionVerified:false}];
  const rawRequest={payload:{format:'raw',transactions:[]}};
  const preview={operationKind:'transaction',assetFlows:[],totalFee:'80',transactionCount:1,warnings:['LOCKED_ASSET'],irreversible:true,htlcLocks};
  const request={chainId:CHAIN_ID,from:FROM,request:rawRequest,maxFee:'100'};
  const evidence=structuredClone(formalEvidence({method:'tbc_signReviewedTransaction',operationKind:'transaction',request,
    preview,planPayload:{requestHash:hashCanonical(request),preview,task:{purpose:'reviewedTransaction'}},planKey:'planHash'}));
  evidence.memory.walletActionPlan=evidence.memory.executionPlan;
  delete evidence.memory.executionPlan;delete evidence.memory.normalizedTransaction;
  const single=projectTbcApprovalPresentation(frozen(evidence));
  assert.deepEqual(single.businessTerms,{status:'known',source:'engine-preview',value:{type:'tbc-htlc',htlcLocks}});
  assert.equal(JSON.stringify(single).includes('"preimage":'),false);
  for(const field of ['sender','receiver','hashlock','lockTime']){
    const changed=structuredClone(evidence);changed.memory.walletActionPlan.payload.preview.htlcLocks[0][field]='changed';
    assert.throws(()=>projectTbcApprovalPresentation(changed),ApprovalHostEvidenceConflictError);
  }
  const workflowRequest={chainId:CHAIN_ID,from:FROM,steps:[{id:'raw',kind:'reviewedTransaction',dependsOn:[],request:rawRequest}]};
  const workflowPreview={operationKind:'workflow',failureMode:'atomic',bindings:[],totalFee:'80',warnings:[],
    steps:[{id:'raw',kind:'reviewedTransaction',dependsOn:[],reviewedTransactionPreview:preview}]};
  const workflow=projectTbcApprovalPresentation(formalEvidence({method:'tbc_signWorkflow',operationKind:'workflow',request:workflowRequest,
    preview:workflowPreview,planPayload:{requestHash:hashCanonical(workflowRequest),preview:workflowPreview,transactionPlans:[],reviewedTransactionTasks:[{requestHash:hashCanonical(rawRequest)}]},planKey:'workflowPlanHash'}));
  assert.deepEqual(workflow.steps[0].businessTerms,single.businessTerms);
});

test("associated HTLC branch and disclosure are formally bound without exposing the template", () => {
  const marker='PUBLIC_SYNTHETIC_PREIMAGE_NEVER_DISPLAY';
  for(const branch of ['claim','refund']){
    const htlcLocks=[{transactionIndex:0,position:'input',index:0,amount:'10000',hashlock:'12'.repeat(32),sender:FROM,receiver:TO,
      lockTime:100,domain:'height',transactionLockTime:100,sequence:4294967294,verification:'exact-template',branch,
      preimageVerified:branch==='claim',chainMaturityChecked:false,scriptExecutionVerified:false}];
    const reviewed={payload:{format:'associated',sourceTransaction:'fixture',sourceInputs:[{unlockingScriptTemplate:marker}],children:[]}};
    const preview={operationKind:'transaction',assetFlows:[],totalFee:'80',transactionCount:1,
      warnings:branch==='claim'?['LOCKED_ASSET','HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE']:['LOCKED_ASSET'],irreversible:true,htlcLocks};
    const request={chainId:CHAIN_ID,from:FROM,request:reviewed,maxFee:'100'};
    const make=(p=preview)=>{
      const evidence=structuredClone(formalEvidence({method:'tbc_signReviewedTransaction',operationKind:'transaction',request,
        preview:p,planPayload:{requestHash:hashCanonical(request),preview:p,task:{purpose:'reviewedTransaction'}},planKey:'planHash'}));
      evidence.memory.walletActionPlan=evidence.memory.executionPlan;delete evidence.memory.executionPlan;delete evidence.memory.normalizedTransaction;return evidence;
    };
    const evidence=make(),single=projectTbcApprovalPresentation(frozen(evidence));
    assert.equal(single.businessTerms.value.htlcLocks[0].branch,branch);
    assert.equal(single.warnings.includes('HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE'),branch==='claim');
    assert.equal(JSON.stringify(single).includes(marker),false);
    for(const field of ['branch','preimageVerified','sequence','transactionLockTime']){
      const changed=structuredClone(evidence);changed.memory.walletActionPlan.payload.preview.htlcLocks[0][field]='changed';
      assert.throws(()=>projectTbcApprovalPresentation(changed),ApprovalHostEvidenceConflictError);
    }
    if(branch==='claim')assert.throws(()=>projectTbcApprovalPresentation(make({...preview,warnings:['LOCKED_ASSET']})),ApprovalHostEvidenceConflictError);
    const workflowRequest={chainId:CHAIN_ID,from:FROM,steps:[{id:'associated',kind:'reviewedTransaction',dependsOn:[],request:reviewed}]};
    const workflowPreview={operationKind:'workflow',failureMode:'atomic',bindings:[],totalFee:'80',warnings:preview.warnings,
      steps:[{id:'associated',kind:'reviewedTransaction',dependsOn:[],reviewedTransactionPreview:preview}]};
    const workflow=projectTbcApprovalPresentation(formalEvidence({method:'tbc_signWorkflow',operationKind:'workflow',request:workflowRequest,
      preview:workflowPreview,planPayload:{requestHash:hashCanonical(workflowRequest),preview:workflowPreview,transactionPlans:[],reviewedTransactionTasks:[{requestHash:hashCanonical(reviewed)}]},planKey:'workflowPlanHash'}));
    assert.deepEqual(workflow.steps[0].businessTerms,single.businessTerms);assert.equal(JSON.stringify(workflow).includes(marker),false);
  }
});

test("HTLC escrow asset identity and amount are part of formal approval, not unbound labels", () => {
  for(const coin of [false,true]){
    const htlcLocks=[{transactionIndex:0,position:'input',index:0,amount:'100',hashlock:'12'.repeat(32),sender:FROM,receiver:TO,
      lockTime:100,domain:'height',transactionLockTime:100,sequence:4294967294,verification:'exact-template',branch:'unresolved',
      preimageVerified:false,chainMaturityChecked:false,scriptExecutionVerified:false,
      escrowToken:{index:1,standardId:coin?'tbc20-stablecoin':'tbc20-standard',contractId:'34'.repeat(32),amount:'250',
        ...(coin?{coinLockTime:0,coinInputLockChecked:true}:{})}}];
    const preview={operationKind:'transaction',assetFlows:[],totalFee:'80',transactionCount:1,warnings:['LOCKED_ASSET'],irreversible:true,htlcLocks};
    const request={chainId:CHAIN_ID,from:FROM,request:{payload:{format:'raw',transactions:[]}},maxFee:'100'};
    const evidence=structuredClone(formalEvidence({method:'tbc_signReviewedTransaction',operationKind:'transaction',request,
      preview,planPayload:{requestHash:hashCanonical(request),preview,task:{purpose:'reviewedTransaction'}},planKey:'planHash'}));
    evidence.memory.walletActionPlan=evidence.memory.executionPlan;delete evidence.memory.executionPlan;delete evidence.memory.normalizedTransaction;
    assert.deepEqual(projectTbcApprovalPresentation(frozen(evidence)).businessTerms.value.htlcLocks,htlcLocks);
    for(const field of ['amount','contractId',...(coin?['coinLockTime']:[])]){
      const changed=structuredClone(evidence);changed.memory.walletActionPlan.payload.preview.htlcLocks[0].escrowToken[field]='changed';
      assert.throws(()=>projectTbcApprovalPresentation(changed),ApprovalHostEvidenceConflictError);
    }
  }
});

test("unified contract execution is formal bound evidence, never an early hint", () => {
  const request={version:'1.0',chainId:CHAIN_ID,from:FROM,intent:{version:'1.0',type:'tbc20Lp.merge',poolContractId:'22'.repeat(32)}};
  const early=projectTbcApprovalPreparation({method:'tbc_signTransaction',operationKind:'transaction',request,
    requestHash:hashCanonical(request),warningScope:[],expiresAt:Date.parse(EXPIRES)});
  assert.equal(early.contractExecution.status,'unknown');
  for(const [generation,implementation] of [['current','tbc20-lp-merge'],['historical','tbc.pool.ftlp.merge']]) {
    const contractExecution={businessType:request.intent.type,implementation,generation};
    const preview={operationKind:'transaction',assetFlows:[],totalFee:'80',transactionCount:1,warnings:[],irreversible:true,contractExecution};
    const planPayload={requestHash:hashCanonical(request),preview,transactions:[{id:'merge'}],signingTasks:[{taskId:'sign-0'}]};
    const evidence=formalEvidence({method:'tbc_signPreparedTransaction',operationKind:'transaction',request,preview,planPayload,planKey:'planHash'});
    const model=projectTbcApprovalPresentation(evidence);
    assert.deepEqual(model.contractExecution,{status:'known',value:contractExecution,source:'engine-preview'});
    assert.deepEqual(renderApprovalPresentation(model).contractExecution,model.contractExecution);
    const changed=structuredClone(evidence);changed.params.preview.contractExecution.generation=generation==='current'?'historical':'current';
    assert.throws(()=>projectTbcApprovalPresentation(changed),ApprovalHostEvidenceConflictError);
    const mismatchedPreview={...preview,contractExecution:{...contractExecution,businessType:'amm.swap'}};
    const mismatch=formalEvidence({method:'tbc_signPreparedTransaction',operationKind:'transaction',request,
      preview:mismatchedPreview,planPayload:{...planPayload,preview:mismatchedPreview},planKey:'planHash'});
    assert.throws(()=>projectTbcApprovalPresentation(mismatch),ApprovalHostEvidenceConflictError);
  }
});

test("formal Prepared transaction presentation uses bound Engine evidence and marks unavailable precision unknown", () => {
  const request = {
    version: "1.0",
    chainId: CHAIN_ID,
    from: FROM,
    clientRequestId: "presentation-transaction",
    intent: { version: "1.0", type: "tbc.stablecoin.transfer", contractId: "22".repeat(32), to: TO, amount: "125" },
    constraints: { maxFee: "200" },
  };
  const preview = {
    operationKind: "transaction",
    assetFlows: [
      { kind: "stablecoin", direction: "send", amount: "125", contractId: "22".repeat(32), from: FROM, to: TO },
      { kind: "native", direction: "fee", amount: "80", from: FROM },
    ],
    totalFee: "80",
    transactionCount: 1,
    warnings: [],
    irreversible: false,
  };
  const requestHash = hashCanonical(request);
  const planPayload = {
    requestHash,
    preview,
    transactions: [{ id: "primary" }],
    signingTasks: [{ taskId: "sign-0" }, { taskId: "sign-1" }, { taskId: "sign-2" }],
  };
  const model = projectTbcApprovalPresentation(formalEvidence({
    method: "tbc_signPreparedTransaction",
    operationKind: "transaction",
    request,
    preview,
    planPayload,
    planKey: "planHash",
  }));
  assert.equal(model.phase, "formal");
  assert.equal(model.trust, "binding-verified");
  assert.equal(model.prepared, true);
  assert.deepEqual(model.fees.maximumAtomic, { status: "known", value: "200", source: "bound-request" });
  assert.deepEqual(model.fees.actualAtomic, { status: "known", value: "80", source: "engine-preview" });
  assert.deepEqual(model.counts.transactions, { status: "known", value: 1, source: "engine-plan" });
  assert.deepEqual(model.counts.signingTasks, { status: "known", value: 3, source: "engine-plan" });
  assert.equal(model.assets[0].amount.atomic, "125");
  assert.deepEqual(model.businessTerms.value, request.intent);
  assert.equal(model.assets[0].amount.precision.status, "unknown");
  assert.ok(model.unknown.includes("assets.0.amount.precision"));
  assert.equal(Object.isFrozen(model), true);
});

test("multi-stage counts use the bound total; missing total is unknown, not initial-stage count", () => {
  const request = { version: "1.0", chainId: CHAIN_ID, from: FROM,
    intent: { version: "1.0", type: "tbc.transfer", to: TO, amount: "1000" } };
  for (const total of [4, undefined, 0]) {
    const preview = { operationKind: "transaction", assetFlows: [], totalFee: "160", transactionCount: 2,
      ...(total === undefined ? {} : { signingTaskCount: total }), warnings: [], irreversible: true };
    const planPayload = { requestHash: hashCanonical(request), preview, transactions: [{ id: "source" }, { id: "mint" }],
      signingTasks: [{ taskId: "source-input-0" }] };
    const evidence = formalEvidence({ method: "tbc_signTransaction", operationKind: "transaction", request, preview, planPayload, planKey: "planHash" });
    if (total === 0) { assert.throws(() => projectTbcApprovalPresentation(evidence), ApprovalHostEvidenceConflictError); continue; }
    const model = projectTbcApprovalPresentation(evidence);
    assert.deepEqual(model.counts.signingTasks, total === undefined
      ? { status: "unknown", reason: "NOT_AVAILABLE" }
      : { status: "known", value: 4, source: "engine-plan" });
    if (total === undefined) assert.ok(model.unknown.includes("counts.signingTasks"));
  }
});

test("formal ordinary single-transaction presentation is not mislabeled Prepared", () => {
  const request = {
    version: "1.0",
    chainId: CHAIN_ID,
    from: FROM,
    intent: { version: "1.0", type: "tbc.transfer", to: TO, amount: "1000" },
  };
  const preview = {
    operationKind: "transaction",
    assetFlows: [{ kind: "native", direction: "send", amount: "1000", from: FROM, to: TO }],
    totalFee: "80",
    transactionCount: 1,
    warnings: [],
    irreversible: false,
  };
  const planPayload = {
    requestHash: hashCanonical(request),
    preview,
    transactions: [{ id: "primary" }],
    signingTasks: [{ taskId: "sign-0" }],
  };
  const model = projectTbcApprovalPresentation(formalEvidence({
    method: "tbc_signTransaction",
    operationKind: "transaction",
    request,
    preview,
    planPayload,
    planKey: "planHash",
  }));
  assert.equal(model.prepared, false);
  assert.equal(model.counts.transactions.value, 1);
  assert.equal(model.counts.signingTasks.value, 1);
  assert.equal(model.fees.maximumAtomic.status, "unknown");
  assert.ok(model.unknown.includes("fees.maximumAtomic"));
});

test("formal Prepared workflow presentation preserves one batch, per-step fees, dependencies, and signing totals", () => {
  const request = {
    version: "1.0",
    chainId: CHAIN_ID,
    from: FROM,
    clientRequestId: "presentation-workflow",
    maxTotalFee: "400",
    failureMode: "atomic",
    steps: [
      { id: "create", kind: "preparedTransaction", dependsOn: [], intent: { version: "1.0", type: "tbc.ft.create", name: "Token", symbol: "TOK", decimals: 2, initialSupply: "12345" }, proposal: {} },
      { id: "send", kind: "preparedTransaction", dependsOn: ["create"], intent: { version: "1.0", type: "tbc.transfer", to: TO, amount: "1000" }, proposal: {} },
    ],
  };
  const preview = {
    operationKind: "workflow",
    failureMode: "atomic",
    steps: [
      { id: "create", kind: "preparedTransaction", dependsOn: [], assetFlows: [
        { kind: "ft", direction: "mint", amount: "12345", from: FROM },
        { kind: "native", direction: "fee", amount: "80", from: FROM },
      ] },
      { id: "send", kind: "preparedTransaction", dependsOn: ["create"], assetFlows: [{ kind: "native", direction: "send", amount: "1000", from: FROM, to: TO }] },
    ],
    bindings: [],
    totalFee: "160",
    warnings: ["MULTI_TRANSACTION"],
  };
  const requestHash = hashCanonical(request);
  const transactionPlans = [
    { stepId: "create", plan: { payload: { preview: { totalFee: "80" }, transactions: [{ id: "create" }], signingTasks: [{ taskId: "create-0" }] } } },
    { stepId: "send", plan: { payload: { preview: { totalFee: "80" }, transactions: [{ id: "send" }], signingTasks: [{ taskId: "send-0" }] } } },
  ];
  const planPayload = {
    requestHash,
    preview,
    transactionPlans,
    // This is the real Core WorkflowPlan shape: transaction tasks are copied
    // into immediateSigningTasks, alongside immediate message/typed-data tasks.
    immediateSigningTasks: [
      { stepId: "create", task: { taskId: "create-0" } },
      { stepId: "send", task: { taskId: "send-0" } },
      { stepId: "message", task: { taskId: "message-0" } },
    ],
    deferredSigningTasks: [],
    reviewedTransactionTasks: [],
  };
  const model = projectTbcApprovalPresentation(formalEvidence({
    method: "tbc_sendPreparedWorkflow",
    operationKind: "workflow",
    request,
    preview,
    planPayload,
    planKey: "workflowPlanHash",
  }));
  assert.equal(model.prepared, true);
  assert.deepEqual(model.counts.steps, { status: "known", value: 2, source: "engine-preview" });
  assert.deepEqual(model.counts.transactions, { status: "known", value: 2, source: "engine-plan" });
  assert.deepEqual(model.counts.signingTasks, { status: "known", value: 3, source: "engine-plan" });
  assert.equal(model.steps[1].dependsOn[0], "create");
  assert.deepEqual(model.steps.map((step) => step.actualFeeAtomic.value), ["80", "80"]);
  assert.deepEqual(model.steps.map((step) => step.signingTaskCount.value), [1, 1]);
  assert.deepEqual(model.assets[0].amount.precision, { status: "known", value: 2, source: "bound-request" });
  assert.deepEqual(model.assets[0].amount.display, { status: "known", value: "123.45", source: "bound-request" });
  assert.deepEqual(model.assets[0].symbol, { status: "known", value: "TOK", source: "bound-request" });
  assert.equal(model.assets[1].kind, "native");
  assert.equal(model.assets[1].amount.precision.status, "unknown");
  assert.equal(model.assets[1].amount.display.status, "unknown");
  assert.equal(model.assets[1].symbol.status, "unknown");
  assert.deepEqual(model.steps[0].businessTerms.value, request.steps[0].intent);
  assert.deepEqual(model.steps[1].businessTerms.value, request.steps[1].intent);
  assert.deepEqual(model.warnings, ["MULTI_TRANSACTION", "BATCH_NOT_ATOMIC"]);
  for (const exact of [true, false]) {
    const multi = structuredClone(planPayload);
    const create = multi.transactionPlans[0].plan.payload;
    create.transactions.push({ id: "mint" });
    if (exact) create.preview.signingTaskCount = 4;
    const result = projectTbcApprovalPresentation(formalEvidence({
      method: "tbc_sendPreparedWorkflow", operationKind: "workflow", request, preview, planPayload: multi, planKey: "workflowPlanHash",
    }));
    if (exact) {
      assert.equal(result.counts.signingTasks.value, 6, "4 staged + 1 transfer + 1 message, without double-counting the source");
      assert.equal(result.steps[0].signingTaskCount.value, 4);
    } else {
      assert.equal(result.counts.signingTasks.status, "unknown");
      assert.equal(result.steps[0].signingTaskCount.status, "unknown");
      assert.ok(result.unknown.includes("steps.0.signingTaskCount"));
    }
  }
});

test("real Core workflow task collections do not double-count transaction signatures and include deferred/reviewed work", () => {
  const reviewedRequest = {
    payload: { format: "raw", transactions: [{ rawTransaction: "00", inputs: [{ satoshis: "1", scriptPubKey: "00" }] }] },
  };
  const request = {
    version: "1.0",
    chainId: CHAIN_ID,
    from: FROM,
    maxTotalFee: "400",
    failureMode: "atomic",
    steps: [
      { id: "send", kind: "transaction", dependsOn: [], intent: { version: "1.0", type: "tbc.transfer", to: TO, amount: "1000" } },
      { id: "message", kind: "message", dependsOn: [], message: { encoding: "utf8", data: "hello" } },
      { id: "deferred", kind: "message", dependsOn: ["send"], message: { encoding: "utf8", data: "{\"settlement\":{\"$tbcBinding\":\"unresolved\"}}" }, bindings: [{ target: "settlement", source: { stepId: "send", output: "transactionIds" } }] },
      { id: "reviewed", kind: "reviewedTransaction", dependsOn: [], request: reviewedRequest },
    ],
  };
  const preview = {
    operationKind: "workflow",
    failureMode: "atomic",
    steps: [
      { id: "send", kind: "transaction", dependsOn: [], assetFlows: [{ kind: "native", direction: "send", amount: "1000", from: FROM, to: TO }] },
      { id: "message", kind: "message", dependsOn: [], message: { encoding: "utf8", data: "hello" } },
      { id: "deferred", kind: "message", dependsOn: ["send"], message: { encoding: "utf8", data: "{\"settlement\":{\"$tbcBinding\":\"unresolved\"}}" } },
      { id: "reviewed", kind: "reviewedTransaction", dependsOn: [], reviewedTransactionPreview: {
        operationKind: "transaction", assetFlows: [], totalFee: "0", transactionCount: 2, warnings: [], irreversible: true,
      } },
    ],
    bindings: [{ sourceStepId: "send", sourceOutput: "transactionIds", target: "/message/settlement", targetType: "json-string-array" }],
    totalFee: "80",
    warnings: [],
  };
  const requestHash = hashCanonical(request);
  const transactionPlanPayload = {
    preview: { totalFee: "80" },
    transactions: [{ id: "primary" }],
    signingTasks: [{ taskId: "transaction-0" }, { taskId: "transaction-1" }],
  };
  const planPayload = {
    requestHash,
    preview,
    transactionPlans: [{ stepId: "send", plan: { payload: transactionPlanPayload } }],
    immediateSigningTasks: [
      { stepId: "send", task: { taskId: "transaction-0" } },
      { stepId: "send", task: { taskId: "transaction-1" } },
      { stepId: "message", task: { taskId: "message-0" } },
    ],
    deferredSigningTasks: [{ taskId: "deferred-0", targetStepId: "deferred" }],
    reviewedTransactionTasks: [{ taskId: "review-reviewed", requestHash: hashCanonical(reviewedRequest) }],
  };
  const model = projectTbcApprovalPresentation(formalEvidence({
    method: "tbc_signWorkflow",
    operationKind: "workflow",
    request,
    preview,
    planPayload,
    planKey: "workflowPlanHash",
  }));
  assert.deepEqual(model.counts.transactions, { status: "known", value: 3, source: "engine-plan" });
  assert.deepEqual(model.counts.signingTasks, { status: "known", value: 5, source: "engine-plan" });
  assert.deepEqual(
    model.steps.map(({ signingTaskCount }) => signingTaskCount.value),
    [2, 1, 1, 1],
  );
  const rendered = renderApprovalPresentation(model);
  assert.equal(rendered.summaryAssets.length, 1);
  assert.equal(rendered.steps[0].assets.length, 1);
  assert.equal(rendered.steps[1].assets.length, 0);
  assert.deepEqual(rendered.steps.map(({ signingTaskCount }) => signingTaskCount.value), [2, 1, 1, 1]);
  assert.ok(rendered.retainedSpecializedDetails.includes("message bytes, encoding, domain and sign-in context"));
  assert.ok(rendered.retainedSpecializedDetails.includes("reviewed raw transactions, associated inputs and dependencies"));
  assert.ok(rendered.retainedSpecializedDetails.includes("dynamic-binding source, target and resolved value"));
});

test("formal projection rejects a detached preview or plan instead of rendering it", () => {
  const request = {
    version: "1.0",
    chainId: CHAIN_ID,
    from: FROM,
    intent: { version: "1.0", type: "tbc.transfer", to: TO, amount: "1000" },
  };
  const preview = {
    operationKind: "transaction",
    assetFlows: [{ kind: "native", direction: "send", amount: "1000", from: FROM, to: TO }],
    totalFee: "80",
    transactionCount: 1,
    warnings: [],
    irreversible: false,
  };
  const planPayload = { requestHash: hashCanonical(request), preview, transactions: [{ id: "primary" }], signingTasks: [] };
  const evidence = structuredClone(formalEvidence({
    method: "tbc_signTransaction",
    operationKind: "transaction",
    request,
    preview,
    planPayload,
    planKey: "planHash",
  }));
  evidence.params.preview.totalFee = "81";
  evidence.call.params = evidence.params;
  assert.throws(
    () => projectTbcApprovalPresentation(evidence),
    ApprovalHostEvidenceConflictError,
  );
});

test("early preparation projection remains explicitly non-authorizing and does not invent plan values", () => {
  const request = {
    version: "1.0",
    chainId: CHAIN_ID,
    from: FROM,
    intent: { version: "1.0", type: "tbc.transfer", to: TO, amount: "1000" },
    constraints: { maxFee: "200" },
  };
  const model = projectTbcApprovalPreparation({
    method: "tbc_sendTransaction",
    operationKind: "transaction",
    requestHash: hashCanonical(request),
    chainId: CHAIN_ID,
    accountId: ACCOUNT_ID,
    suggestedFeeCapAtomic: "200",
    warningScope: [],
    expiresAt: Date.parse(EXPIRES),
    request,
  });
  assert.equal(model.phase, "preparation");
  assert.equal(model.trust, "intent-bounded");
  assert.equal(model.binding.status, "not-created");
  assert.equal(model.assets.length, 0);
  assert.equal(model.fees.actualAtomic.status, "unknown");
  assert.equal(model.counts.signingTasks.status, "unknown");
  assert.deepEqual(model.businessTerms.value, request.intent);
  assert.ok(model.unknown.includes("assets"));
});

test("early mixed batch keeps every bound intent and step risk without inventing asset flows", () => {
  const request = { chainId: CHAIN_ID, from: FROM, maxTotalFee: "200", steps: [
    {id:"transfer",kind:"transaction",dependsOn:[],intent:{version:"1.0",type:"tbc.transfer",to:TO,amount:"123"}},
    {id:"burn",kind:"transaction",dependsOn:[],intent:{version:"1.0",type:"tbc20Lp.burn",poolContractId:"ab".repeat(32)}},
    {id:"message",kind:"message",dependsOn:[],message:{encoding:"utf8",data:"Only this message"}},
  ]};
  const model=projectTbcApprovalPreparation({method:"tbc_signWorkflow",operationKind:"workflow",requestHash:hashCanonical(request),request,warningScope:[],expiresAt:Date.parse(EXPIRES)});
  assert.equal(model.steps.length,3);
  assert.equal(model.counts.steps.value,3);
  assert.equal(model.steps[0].businessTerms.value.to,TO);
  assert.equal(model.steps[0].businessTerms.value.amount,"123");
  assert.deepEqual(model.steps[0].assets,[]);
  assert.ok(model.steps[1].warnings.includes("ASSET_DESTRUCTION_NO_WITHDRAWAL"));
  assert.ok(model.steps[2].warnings.includes("SIGNATURE_MAY_AUTHORIZE_ACTIONS"));
  assert.ok(!model.steps[0].warnings.includes("ASSET_DESTRUCTION_NO_WITHDRAWAL"));
  assert.equal(model.steps[0].actualFeeAtomic.status,"unknown");
  assert.throws(()=>model.steps[0].businessTerms.value.amount="999",TypeError);
});

test("reviewed batch assets, recipients, fee and warnings come from the exact bound child preview",()=>{
  const rawRequest={txraws:["00000000"],utxos_satoshis:[[1]],script_pubkeys:[["51"]]};
  const request={chainId:CHAIN_ID,from:FROM,steps:[{id:"raw",kind:"reviewedTransaction",dependsOn:[],request:rawRequest}]};
  const child={operationKind:"transaction",totalFee:"80",transactionCount:1,warnings:["LOCKED_ASSET"],irreversible:true,
    assetFlows:[{kind:"ft",direction:"send",amount:"9876543210123456789",contractId:"ab".repeat(32),from:FROM,to:TO}]};
  const preview={operationKind:"workflow",failureMode:"atomic",bindings:[],totalFee:"80",warnings:["LOCKED_ASSET"],steps:[{id:"raw",kind:"reviewedTransaction",dependsOn:[],reviewedTransactionPreview:child}]};
  const evidence=formalEvidence({method:"tbc_signWorkflow",operationKind:"workflow",request,preview,
    planPayload:{requestHash:hashCanonical(request),preview,transactionPlans:[],reviewedTransactionTasks:[{requestHash:hashCanonical(rawRequest)}]},planKey:"workflowPlanHash"});
  const model=projectTbcApprovalPresentation(evidence),step=model.steps[0];
  assert.equal(step.assets[0].amount.atomic,"9876543210123456789");
  assert.equal(step.assets[0].to.value,TO);
  assert.equal(step.assets[0].contractId.value,"ab".repeat(32));
  assert.equal(step.actualFeeAtomic.value,"80");
  assert.ok(step.warnings.includes("LOCKED_ASSET"));
  assert.equal(model.assets.length,1);
  assert.deepEqual(renderApprovalPresentation(model).steps[0].warnings,step.warnings);
  const changed=structuredClone(evidence);changed.params.preview.steps[0].reviewedTransactionPreview.assetFlows[0].to=FROM;
  assert.throws(()=>projectTbcApprovalPresentation(changed),ApprovalHostEvidenceConflictError);
});

test("business terms preserve exact bound swap, liquidity, NFT and FT approval clauses", () => {
  const intents = [
    { version: "1.0", type: "tbc.pool.swap.tbcForToken", poolContractId: "11".repeat(32), tbcAmount: "1000", minimumTokenAmount: "900", receiver: TO },
    { version: "1.0", type: "tbc.pool.liquidity.add", poolContractId: "22".repeat(32), tbcAmount: "1000", minimumLpAmount: "12", receiver: TO, lockUntil: "2030-01-01T00:00:00Z" },
    { version: "1.0", type: "tbc.nft.mint", collectionId: "33".repeat(32), metadata: { name: "Bound NFT", uri: "https://example.com/nft.json" }, receiver: TO },
    { version: "1.0", type: "tbc.ft.create", name: "Bound Token", symbol: "BND", decimals: 8, initialSupply: "21000000" },
  ];
  for (const [index, intent] of intents.entries()) {
    const request = { version: "1.0", chainId: CHAIN_ID, from: FROM, clientRequestId: `terms-${index}`, intent };
    const preview = {
      operationKind: "transaction", assetFlows: [], totalFee: "80", transactionCount: 1, warnings: [], irreversible: false,
    };
    const planPayload = { requestHash: hashCanonical(request), preview, transactions: [{ id: "primary" }], signingTasks: [] };
    const model = projectTbcApprovalPresentation(formalEvidence({
      method: "tbc_signTransaction", operationKind: "transaction", request, preview, planPayload, planKey: "planHash",
    }));
    assert.deepEqual(model.businessTerms, { status: "known", value: intent, source: "bound-request" });
  }
});

test("formal projection consumes the real Host-reader envelope shape, not a fabricated top-level operation", () => {
  const request = { version: "1.0", chainId: CHAIN_ID, from: FROM, intent: { version: "1.0", type: "tbc.transfer", to: TO, amount: "1" } };
  const preview = { operationKind: "transaction", assetFlows: [], totalFee: "1", transactionCount: 1, warnings: [], irreversible: false };
  const planPayload = { requestHash: hashCanonical(request), preview, transactions: [{ id: "primary" }], signingTasks: [] };
  const evidence = formalEvidence({ method: "tbc_signTransaction", operationKind: "transaction", request, preview, planPayload, planKey: "planHash" });
  assert.equal(evidence.operation.method, undefined);
  assert.equal(evidence.payload.operation.method, "tbc_signTransaction");
  assert.equal(projectTbcApprovalPresentation(evidence).businessType.value, "tbc.transfer");
});

test("chain transaction rows retain commitments and fees without duplicating aggregate assets", () => {
  const request={version:"1.0",chainId:CHAIN_ID,from:FROM,intent:{version:"1.0",type:"tbc20.transfer",contractId:"ab".repeat(32),receivers:[{to:TO,amount:"6016"}]}};
  const preview={operationKind:"transaction",assetFlows:[{kind:"ft",direction:"send",amount:"6016",to:TO}],totalFee:"2092",transactionCount:2,warnings:[],irreversible:true};
  const transactions=[
    {id:"maintenance",role:"maintenance",dependsOn:[],templateHash:"01".repeat(32),fee:"800"},
    {id:"primary",role:"primary",dependsOn:["maintenance"],templateHash:"02".repeat(32),fee:"1292"},
  ];
  const evidence=formalEvidence({method:"tbc_signTransaction",operationKind:"transaction",request,preview,
    planPayload:{requestHash:hashCanonical(request),preview,transactions,signingTasks:[]},planKey:"planHash"});
  const model=projectTbcApprovalPresentation(evidence),rendered=renderApprovalPresentation(model);
  assert.equal(model.transactionsStatus,"available");
  assert.equal(model.transactions.length,2);
  assert.equal(model.assets[0].amount.atomic,"6016");
  model.transactions.forEach((row,index)=>{
    assert.equal(row.id,transactions[index].id);
    assert.equal(row.role.value,transactions[index].role);
    assert.deepEqual(row.dependsOn,transactions[index].dependsOn);
    assert.equal(row.templateHash.value,transactions[index].templateHash);
    assert.equal(row.feeAtomic.value,transactions[index].fee);
    assert.equal(row.assetsStatus,"step-summary-only");
    assert.deepEqual(row.assets,[]);
    assert.deepEqual(row.warnings,["PER_TRANSACTION_ASSET_DETAILS_UNAVAILABLE"]);
  });
  assert.equal(rendered.transactions[1].feeAtomic.value,"1292");
  assert.throws(()=>model.transactions[0].dependsOn.push("changed"),TypeError);
  const changed=structuredClone(evidence);changed.memory.executionPlan.payload.transactions[1].fee="0";
  assert.throws(()=>projectTbcApprovalPresentation(changed),ApprovalHostEvidenceConflictError);
});

test("AMM destination fallback uses only the bound pool and does not replace recipients or network fees",()=>{
  const pool="ab".repeat(32);
  for(const type of ["tbc-amm-add-liquidity","tbc-amm-remove-liquidity","tbc-amm-swap","tbc.transfer"]){
    const request={version:"1.0",chainId:CHAIN_ID,from:FROM,intent:{version:"1.0",type,poolContractId:pool}};
    const preview={operationKind:"transaction",assetFlows:[
      {kind:"native",direction:"send",amount:"100"},
      {kind:"ft",direction:"send",amount:"200",to:TO},
      {kind:"native",direction:"fee",amount:"80"},
      {kind:"ft",direction:"receive",amount:"2"},
    ],totalFee:"80",transactionCount:1,warnings:[],irreversible:true};
    const model=projectTbcApprovalPresentation(formalEvidence({method:"tbc_signTransaction",operationKind:"transaction",request,preview,
      planPayload:{requestHash:hashCanonical(request),preview,transactions:[{id:"primary",fee:"80",dependsOn:[]}],signingTasks:[]},planKey:"planHash"}));
    if(type==="tbc.transfer")assert.equal(model.assets[0].to.status,"unknown");
    else assert.deepEqual(model.assets[0].to,{status:"known",value:`pool:${pool}`,source:"bound-request"});
    assert.equal(model.assets[1].to.value,TO);
    assert.equal(model.assets[2].to.status,"unknown");
    assert.equal(model.assets[3].to.status,"unknown");
    assert.equal(model.transactions[0].assetsStatus,"available");
    assert.deepEqual(model.transactions[0].assets,model.assets);
  }
});

test("preparation distinguishes unknown transaction details and retains only required risks",()=>{
  const request={chainId:CHAIN_ID,from:FROM,steps:[
    {id:"order",kind:"transaction",dependsOn:[],intent:{type:"tbc-lop-create"}},
    {id:"lock",kind:"transaction",dependsOn:[],intent:{type:"tbc20Lp.lock"}},
    {id:"message",kind:"message",dependsOn:[],message:{encoding:"utf8",data:"hello"}},
  ]};
  const model=projectTbcApprovalPreparation({method:"tbc_signWorkflow",operationKind:"workflow",requestHash:hashCanonical(request),request,warningScope:[],expiresAt:Date.parse(EXPIRES)});
  assert.equal(model.steps[0].transactionsStatus,"not-bound");
  assert.deepEqual(model.steps[0].transactions,[]);
  assert.deepEqual(model.steps[0].warnings,[]);
  assert.ok(model.steps[1].warnings.includes("ASSET_LOCKED_UNTIL_CONDITIONS_MET"));
  assert.ok(model.steps[2].warnings.includes("SIGNATURE_MAY_AUTHORIZE_ACTIONS"));
  assert.equal(model.steps[2].transactionsStatus,"not-applicable");
  assert.ok(model.warnings.includes("BATCH_NOT_ATOMIC"));
});

test("each chain transaction discloses bound output balances without duplicating user debits",()=>{
 const request={version:'1.0',chainId:CHAIN_ID,from:FROM,intent:{type:'tbc.ft.transfer',to:TO,amount:'123'}};
 const preview={operationKind:'transaction',assetFlows:[],totalFee:'100',transactionCount:2,warnings:[],irreversible:true};
 const output=(indices,amount,recipient)=>({outputIndices:indices,kind:'tbc20-standard',assetIdentity:'code-identity:'+ 'ab'.repeat(32),amountAtomic:amount,recipient,nativeValueAtomic:'500',warnings:[]});
 const transactions=[{id:'merge',dependsOn:[],fee:'50',outputReview:[output([0,1],'9007199254740993123',FROM)]},
  {id:'primary',dependsOn:['merge'],fee:'50',outputReview:[output([0,1],'123',TO),output([2,3],'9007199254740993000',FROM)]}];
 const payload={requestHash:hashCanonical(request),preview,transactions,signingTasks:[]};
 const evidence=formalEvidence({method:'tbc_signTransaction',operationKind:'transaction',request,preview,planPayload:payload,planKey:'planHash'});
 const model=projectTbcApprovalPresentation(evidence);
 assert.equal(model.transactions[0].outputsStatus,'available');
 assert.equal(model.transactions[0].outputs[0].amountAtomic.value,'9007199254740993123');
 assert.equal(model.transactions[1].outputs[0].recipient.value,TO);
 assert.equal(model.transactions[1].outputs[1].recipient.value,FROM);
 assert.deepEqual(model.transactions[1].assets,[]);
 assert.deepEqual(renderApprovalPresentation(model).transactions[1].outputs,model.transactions[1].outputs);
 assert.throws(()=>model.transactions[0].outputs[0].outputIndices.push(3),TypeError);
 for(const field of ['amountAtomic','recipient','assetIdentity']){
  const changed=structuredClone(evidence);changed.memory.executionPlan.payload.transactions[1].outputReview[0][field]='changed';
  assert.throws(()=>projectTbcApprovalPresentation(changed),ApprovalHostEvidenceConflictError);
 }
 const partial=structuredClone(payload);partial.transactions[0].outputReview=[{outputIndices:[0],kind:'unrecognized',nativeValueAtomic:'42',warnings:['OUTPUT_ASSET_DETAILS_UNAVAILABLE']}];
 const p=projectTbcApprovalPresentation(formalEvidence({method:'tbc_signTransaction',operationKind:'transaction',request,preview,planPayload:partial,planKey:'planHash'}));
 assert.equal(p.transactions[0].outputsStatus,'partial');assert.equal(p.transactions[0].outputs[0].amountAtomic.status,'unknown');assert.equal(p.transactions[0].outputs[0].nativeValueAtomic,'42');
 for(const indices of [[1],[0,0],[0,2]]){
  const malformed=structuredClone(payload);malformed.transactions[0].outputReview[0].outputIndices=indices;
  assert.throws(()=>projectTbcApprovalPresentation(formalEvidence({method:'tbc_signTransaction',operationKind:'transaction',request,preview,planPayload:malformed,planKey:'planHash'})),ApprovalHostEvidenceConflictError);
 }
});
