// Independent packaged Core approval/hash oracle. No chain data, key or POST.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {verifiedKitCandidate} from '../../flutter/scripts/candidate-inputs.mjs';
const base=resolve(import.meta.dirname,'..'),root=resolve(base,'../..');
const pkg=join(root,'release/kit-contract173-20261014-c');
const tar=await readFile(join(pkg,'tbc-kit-0.1.0-platform-slim.20261014.3.tgz'));
assert.equal(createHash('sha256').update(tar).digest('hex'),'65441bc8dec3cf659f9ab2d65f722559b52eb68af4ab2b95e04470e3c4acf7fa');
const identity=await verifiedKitCandidate(join(pkg,'package'));
assert.equal(identity.artifactId,'9601507ee4961e9d99bac98984d112a80854b3ef8a979f8b0728f152ae335626');
const k=await import(pathToFileURL(join(pkg,'package/dist/esm/wallet.js')));
const now='2026-10-14T12:00:00.123Z',scope={webViewInstanceId:'view-network',sessionId:'session-network',navigationId:'navigation-network',committedUrl:'https://partner.example/swap',origin:'https://partner.example',topOrigin:'https://partner.example',frame:'top',createdAt:now};
const context={sessionId:scope.sessionId,transport:'webview',origin:scope.origin,topOrigin:scope.topOrigin,frame:'top',navigationId:scope.navigationId,createdAt:scope.createdAt};
const expiresAt=new Date(Date.parse(now)+120000).toISOString();
const payload={version:'1.0',fromChainId:'tbc:testnet',toChainId:'tbc:mainnet',expectedSessionRevision:'0',expiresAt};
const proposal={payload,chainSwitchProposalHash:k.hashCanonical(payload)};
const binding=k.createApprovalBinding({version:'1.0',method:'tbc_switchChain',operationKind:'switchChain',contextHash:k.hashCanonical(context),origin:scope.origin,sessionId:scope.sessionId,chainId:payload.toChainId,requestHash:k.hashCanonical({chainId:payload.toChainId}),operationHash:proposal.chainSwitchProposalHash,expiresAt});
const preview={operationKind:'switchChain',fromChainId:payload.fromChainId,toChainId:payload.toChainId,network:{name:'TBC Mainnet',nativeCurrencySymbol:'TBC'},warnings:['CHAIN_SWITCH']};
const out={nowMillis:Date.parse(now),scope,proposal,binding,preview,expectedEvents:[{name:'chainChanged',payload:'tbc:mainnet'},{name:'accountsChanged',payload:['main-address']}],oracle:'Kit20261014.3 createApprovalBinding/hashCanonical; protocol shape from current Core beginChainSwitch',broadcasts:0};
if(process.argv[2]==='--check'){
 assert.deepEqual(JSON.parse(await readFile(join(base,'test/fixtures/network-switch.json'))),out);
 console.log(JSON.stringify({status:'NETWORK_SWITCH_ORACLE_VERIFIED',artifactId:identity.artifactId,bindingHash:binding.bindingHash}));
}else{
 assert.equal(process.argv.length,2);
 await writeFile(join(base,'test/fixtures/network-switch.json'),JSON.stringify(out,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({status:'NETWORK_SWITCH_ORACLE_SAVED',bindingHash:binding.bindingHash}));
}
