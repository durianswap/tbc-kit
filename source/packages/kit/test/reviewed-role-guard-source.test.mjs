// Missing wallet custody configuration must never silently use the old signer.
import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const result=await build({entryPoints:[join(root,'packages/kit/src/standard-workflow-capabilities.ts')],bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent',
 banner:{js:`import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(import.meta.url)});`},
 plugins:[{name:'parser',setup(b){b.onResolve({filter:/^\.\/vendor\/tbc-tx-parser\/index\.js$/},()=>({path:join(root,'packages/kit/dist/esm/vendor/tbc-tx-parser/index.js')}));}}]});
const {normalizeTbcReviewedTransactionMaterial:normalize,createTbcStandardWorkflowCapabilities:create}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
test('role markers cannot be silently normalized away',()=>{
 assert.throws(()=>normalize({payload:{format:'associated',sourceTransaction:'00',sourceInputs:[{outputIndex:0,signingProfile:'tbc20-stablecoin',signingRole:'coin-admin'}],children:[]}}),/role-aware/);
 assert.throws(()=>normalize({payload:{format:'raw',transactions:[{rawTransaction:'00',inputs:[{satoshis:'500',scriptPubKey:'51',signingRole:'coin-admin'}]}]}}),/role-aware/);
});
test('unconfigured role review and execution never reach account reads, reviewers or custody',async()=>{
 let calls=0;const unexpected=()=>{calls++;throw Error('must not run');};
 const c=create({navigation:{origin:'https://fixture.invalid',sessionId:'session',navigationId:'navigation'},chainId:'tbc:testnet',
  account:{accountId:'tbc:testnet:owner',address:'owner',publicKey:'02'+'11'.repeat(32)},networkSourceIdentity:'fixture',
  readCurrentAuthority:unexpected,rawReviewer:{review:unexpected},associatedReviewer:{review:unexpected},
  materialNative:{execute:unexpected},privateNative:unexpected});
 await assert.rejects(c.reviewedTransaction.review({signingRoles:[]},{operation:'reviewedTransaction.review'}),/role-aware/);
 await assert.rejects(c.reviewedTransaction.execute({task:{signingRoles:[]}},{operation:'reviewedTransaction.execute'}),/role-aware/);
 assert.equal(calls,0);
});
