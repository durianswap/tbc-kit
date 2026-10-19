// Untrusted page DTO/Promise facade only. No account authority, chain reads,
// transaction builder, keys or execution loop. Native attests canonical results
// BEFORE this module projects the historical window.Turing return shape.
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex} from '@noble/hashes/utils';
export const LEGACY_CHANNEL='legacy-window-turing-shared/1';
const MAX=4*1024*1024,methods=['connect','disconnect','isConnected','getPubKey','getAddress',
  'getNetwork','getInfo','getBalance','sendTransaction','signTransaction','signAssociatedTransaction',
  'signMessage','encrypt','decrypt','sendBatchRequest','mergeUtxos','mergeFtUtxos','mergeStableCoinUtxos'];
// Separate active work from lifetime replay fingerprints, as in Standard.
// Never evict old request identities: a replay must not execute again.
const MAX_TRACKED_MESSAGES=100000;
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=v=>typeof v==='string'&&v.length>0;
const mergeMethods=new Set(['mergeUtxos','mergeFtUtxos','mergeStableCoinUtxos']);
const failure=()=>Error('Legacy wallet session closed');
const fingerprint=s=>bytesToHex(sha256(new TextEncoder().encode(s)));
function need(v){if(!v)throw failure();}
export function canonical(value){
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(record(value))return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  need(value===null||typeof value==='string'||typeof value==='boolean'||Number.isSafeInteger(value));
  return JSON.stringify(value);
}
function snapshot(input){
  let count=0;const parents=new Set();
  function copy(v,depth){
    need(++count<=10000&&depth<=32);
    if(v===null||typeof v==='boolean'||typeof v==='string')return v;
    if(typeof v==='number'){need(Number.isFinite(v));return v;}
    need(v&&typeof v==='object'&&!parents.has(v));parents.add(v);
    let out;
    if(Array.isArray(v)){
      out=[];for(let i=0;i<v.length;i++){const d=Object.getOwnPropertyDescriptor(v,String(i));need(d&&Object.hasOwn(d,'value'));out.push(copy(d.value,depth+1));}
    }else{
      need(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);out={};
      for(const key of Reflect.ownKeys(v)){
        need(typeof key==='string'&&!['__proto__','constructor','prototype'].includes(key));
        const d=Object.getOwnPropertyDescriptor(v,key);need(d&&Object.hasOwn(d,'value'));out[key]=copy(d.value,depth+1);
      }
    }
    parents.delete(v);return out;
  }
  const value=copy(input===undefined?null:input,0),json=JSON.stringify(value);
  need(new TextEncoder().encode(json).length<=MAX);return {value,json};
}
function network(chain){need(chain==='tbc:mainnet'||chain==='tbc:testnet');return {network:'tbc',type:chain.slice(4)};}
function rawTransactions(value){need(Array.isArray(value?.transactions)&&value.transactions.length>0);return value.transactions;}
// Params are retained only when their shape is required for projecting results;
// never retain the original raw transactions, crypto text or HTLC witness.
export function projection(method,params){
  if(method==='sendBatchRequest'){
    need(Array.isArray(params)&&params.length>=1&&params.length<=5);
    return {method,steps:params.map(p=>projection(p.method,p.params))};
  }
  return {method,...mergeMethods.has(method)?{startedAt:Date.now()}: {}};
}
export function projectResult(context,value,{chainId,descriptor,platform,version}={}){
  const {method}=context;
  switch(method){
    case 'connect':{
      need(Array.isArray(value));
      const p=value.find(p=>p.parentCapability==='tbc_accounts'),c=p?.caveats?.find(c=>c.type==='restrictAccounts');
      const account=c?.value?.find(a=>typeof a==='string'&&a.startsWith(chainId+':'));
      return account?{tbcAddress:account.slice(chainId.length+1)}:{error:'User not connected'};
    }
    case 'getAddress':need(Array.isArray(value));return text(value[0])?{tbcAddress:value[0]}:{error:'User not connected'};
    case 'isConnected':need(Array.isArray(value));return text(value[0]);
    case 'getPubKey':need(text(value?.publicKey));return {tbcPubKey:value.publicKey};
    case 'getNetwork':return network(value);
    case 'getInfo':network(value);return {name:descriptor?.name??'Turing',platform,version};
    case 'getBalance':{
      need(value?.chainId===chainId&&text(value.address)&&value.decimals===6&&
        typeof value.balanceAtomic==='string'&&/^(0|[1-9][0-9]{0,15})$/.test(value.balanceAtomic)&&
        Number.isSafeInteger(Number(value.balanceAtomic)));
      const padded=value.balanceAtomic.padStart(7,'0');
      return {tbc:Number(padded.slice(0,-6)+'.'+padded.slice(-6))};
    }
    case 'mergeUtxos':case 'mergeFtUtxos':case 'mergeStableCoinUtxos':{
      const initial=value?.initialUtxoCount,final=value?.finalUtxoCount;
      const valid=Number.isSafeInteger(initial)&&Number.isSafeInteger(final)&&initial>=final&&final>=0;
      const success=valid&&final<=1&&value.status==='complete'&&['target-reached','already-below-target'].includes(value.reason);
      return {success,duration:Math.max(0,Date.now()-context.startedAt),
        ...method==='mergeStableCoinUtxos'?{successCount:valid?initial-final:0}:{}};
    }
    case 'disconnect':return true;
    case 'sendTransaction':{
      const rows=rawTransactions(value);
      if(rows.every(r=>text(r.rawTransaction)))return {txraw:rows.map(r=>r.rawTransaction).join(',')};
      need(rows.every(r=>typeof r.txid==='string'&&/^[a-f0-9]{64}$/.test(r.txid)));
      return {txid:rows.map(r=>r.txid).join(',')};
    }
    case 'signAssociatedTransaction':{const rows=rawTransactions(value);need(rows.every(r=>text(r.rawTransaction)));return {txraws:rows.map(r=>r.rawTransaction)};}
    case 'signTransaction':need(Array.isArray(value?.detachedSignatures)&&value.detachedSignatures.every(r=>Array.isArray(r)&&r.every(text)));return {sigs:value.detachedSignatures};
    case 'signMessage':need(text(value?.address)&&text(value.publicKey)&&text(value.signature)&&typeof value.envelope?.message?.data==='string');return {
      address:value.address,maddress:value.address,pubkey:value.publicKey,pubKey:value.publicKey,message:value.envelope.message.data,sig:value.signature};
    case 'encrypt':need(text(value?.ciphertext));return {encryptedMessage:value.ciphertext};
    case 'decrypt':{
      const m=value?.message;need(m&&typeof m.data==='string');let bytes;
      if(m.encoding==='utf8')return {decryptedMessage:m.data};
      if(m.encoding==='hex'){need(/^(?:[a-fA-F0-9]{2})*$/.test(m.data));bytes=Uint8Array.from(m.data.match(/../g)??[],v=>parseInt(v,16));}
      else{need(m.encoding==='base64');bytes=Uint8Array.from(atob(m.data),v=>v.charCodeAt(0));}
      return {decryptedMessage:new TextDecoder('utf-8',{fatal:true}).decode(bytes)};
    }
    case 'sendBatchRequest':{
      need(Array.isArray(value?.steps)&&value.steps.length===context.steps.length);
      return value.steps.map((s,i)=>{
        if(s.status==='skipped')return {error:'Previous request failed or produced no txids'};
        if(s.status==='failed')return {error:typeof s.error?.message==='string'?s.error.message:'Workflow step failed'};
        // Atomic workflows omit status on success; continue-independent rows
        // may spell it out. Native attestation has already verified the result.
        need(s.status===undefined||s.status==='completed');return projectResult(context.steps[i],s.result,{chainId,descriptor,platform,version});
      });
    }
    default:throw failure();
  }
}
export function projectError(method,error,context={method,startedAt:Date.now()}){
  if(mergeMethods.has(method)){
    if(error?.code===4200||error?.code===4901)return {error:'Unsupported legacy operation'};
    if(error?.code===-32602)return {error:'Missing required parameters'};
    return projectResult(context,undefined);
  }
  const rejected={connect:'User rejected the request',sendTransaction:'User cancelled the transaction',
    signMessage:'User cancelled the sign message',signTransaction:'User cancelled the sign transaction',
    signAssociatedTransaction:'User cancelled the sign associated transaction',encrypt:'User cancelled the crypto operation',
    decrypt:'User cancelled the crypto operation',sendBatchRequest:'User cancelled the batch request'};
  if(error?.code===4001)return {error:rejected[method]??'Request rejected'};
  if(error?.code===4100)return {error:'User not connected'};
  if(error?.code===4200||error?.code===4901)return {error:'Unsupported legacy operation'};
  return {error:error?.code===-32602?'Invalid parameters':'Wallet operation unavailable'};
}
export function createLegacyPage({target,post,metadata=()=>({})}){
  let identity,initialization,closed=false,sequence=0,chainId;
  const pending=new Map(),seen=new Map(),received=new Map(),listeners=new Map();
  const own=Object.hasOwn,EventType=target.CustomEvent??globalThis.CustomEvent;
  function dispatch(name,detail){target.dispatchEvent(new EventType(name,{detail}));}
  function close(){if(closed)return;closed=true;for(const p of pending.values())p.reject(failure());pending.clear();received.clear();seen.clear();}
  function envelope(type,extra={}){need(!closed&&identity&&Number.isSafeInteger(sequence+1));return {channel:LEGACY_CHANNEL,type,...identity,messageId:'legacy-page-'+(++sequence),...extra};}
  function send(type,extra={}){post(canonical(envelope(type,extra)));}
  function request(method,input){
    if(closed||!identity)return Promise.reject(failure());
    // Frozen Legacy accepts absent/[]/{} but not explicit null. The private
    // wrapper uses null for absence; preserve that distinction at the API edge.
    if((method==='getBalance'||method==='mergeUtxos')&&input===null)return Promise.resolve({error:'Invalid parameters'});
    if(pending.size>=128)return Promise.resolve({error:'Another wallet request is already pending'});
    if(received.size>=MAX_TRACKED_MESSAGES||!Number.isSafeInteger(sequence+1)){close();return Promise.reject(failure());}
    let captured,context;
    try{captured=snapshot(input);context=projection(method,captured.value);}catch{return Promise.resolve({error:'Invalid parameters'});}
    const id='legacy-request-'+(++sequence);
    return new Promise((resolve,reject)=>{
      pending.set(id,{method,context,resolve,reject});
      try{send('request',{request:{jsonrpc:'2.0',id,method,params:{legacyJson:captured.json}}});}catch{close();}
    });
  }
  let facade;
  function on(name,listener){
    if(typeof name!=='string'||typeof listener!=='function')throw TypeError('Invalid Legacy event listener');
    let group=listeners.get(name);if(!group){group=new Map();listeners.set(name,group);}
    if(!group.has(listener)){const wrapper=e=>listener(e.detail);group.set(listener,wrapper);target.addEventListener(name,wrapper);}return facade;
  }
  function removeListener(name,listener){const group=listeners.get(name),wrapper=group?.get(listener);if(wrapper){target.removeEventListener(name,wrapper);group.delete(listener);}return facade;}
  function event(input){
    need(record(input));
    if(input.name==='accountsChanged'){need(Array.isArray(input.payload));dispatch('TuringAccountChanged',{addresses:text(input.payload[0])?{tbcAddress:input.payload[0]}:{}});}
    else if(input.name==='chainChanged'){chainId=input.payload;dispatch('TuringNetworkChanged',network(chainId));}
    else if(input.name==='disconnect')dispatch('TuringAccountChanged',{addresses:{}});
    else need(input.name==='permissionsChanged');
  }
  function receive(serialized){
    if(closed)return false;
    try{
      need(typeof serialized==='string'&&new TextEncoder().encode(serialized).length<=MAX);
      const m=JSON.parse(serialized);need(m.channel===LEGACY_CHANNEL&&canonical(m)===serialized);
      need(text(m.sessionId)&&text(m.navigationId)&&text(m.messageId));
      if(m.type==='initialize'){
        if(initialization!==undefined){need(initialization===serialized);return true;}
        need(m.origin===target.location?.origin);network(m.chainId);need(!own(target,'Turing'));
        identity={sessionId:m.sessionId,navigationId:m.navigationId};chainId=m.chainId;initialization=serialized;
        facade=Object.freeze({...Object.fromEntries(methods.map(name=>[name,p=>request(name,p)])),
          get isReady(){return !closed;},on,removeListener});
        Object.defineProperty(target,'Turing',{value:facade,writable:false,configurable:false});send('ready');dispatch('TuringReady');return true;
      }
      need(identity&&m.sessionId===identity.sessionId&&m.navigationId===identity.navigationId);
      // Retain only a digest, never copies of transaction/crypto/witness bodies.
      const digest=fingerprint(serialized);
      if(seen.has(m.messageId)){need(seen.get(m.messageId)===digest);return true;}
      need(seen.size<MAX_TRACKED_MESSAGES);seen.set(m.messageId,digest);
      if(m.type==='close'){close();return true;}
      if(m.type==='event'){event(m.event);return true;}
      need(m.type==='delivery'&&record(m.response)&&m.response.jsonrpc==='2.0'&&Array.isArray(m.events)&&/^[a-f0-9]{64}$/.test(m.deliveryId));
      const {response}=m,id=response.id;
      if(received.has(id)){need(received.get(id)===m.deliveryId);send('ack',{deliveryId:m.deliveryId});return true;}
      const p=pending.get(id);need(p&&received.size<MAX_TRACKED_MESSAGES&&own(response,'result')!==own(response,'error'));
      if(response.error?.code===4100&&response.error.message==='Authorization changed'){
        pending.delete(id);received.set(id,m.deliveryId);p.reject(failure());send('ack',{deliveryId:m.deliveryId});return true;
      }
      const result=own(response,'error')?projectError(p.method,response.error,p.context):projectResult(p.context,response.result,{...metadata(),chainId});
      pending.delete(id);received.set(id,m.deliveryId);p.resolve(result);
      dispatch('TuringResponse',Object.freeze({id,method:p.method,result}));
      for(const e of m.events)event(e);
      send('ack',{deliveryId:m.deliveryId});return true;
    }catch{close();return false;}
  }
  return Object.freeze({receive,close});
}
