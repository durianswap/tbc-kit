import { canonicalize, type ChainDataRequirement } from "@tbc-wallet/core";
import { positiveHolderCandidates } from "./fungible-candidates.js";
import type { TestnetClient, TestnetTip } from "./testnet-client.js";
import type { PoolMaterialNativeProviderInput } from "./pool-material-native.js";
import type { NftTransactionMaterial as Parent } from "./nft-material.js";

const HASH=/^[0-9a-f]{64}$/u,UINT=/^(0|[1-9][0-9]*)$/u;
const FT="0f5db33bb46e4517963cbd383518f74283b5c2c4efb0a733522a1fbc0d4a9f84";
const COIN="c686fc271f0ee8116325bf541d87c4d2e6ad839896a9d9dd21dcf2ac847660e3";
type Point=Readonly<{txid:string;vout:number}>;
type Standard="tbc20-standard"|"tbc20-stablecoin";
type Asset=Readonly<Point & {standardId:Standard;contractId?:string;controller:string;balance:string;lockTime:number;scriptPubKey:string;dependencies:readonly Point[]}>;
type Utxo=Readonly<Point & {satoshis:string;scriptPubKey:string;classification:string;contractId?:string;confirmations?:string}>;
type Contract=Readonly<{contractId:string;family:string;protocolVersion:string;standardId:Standard;templateRevision:string;creationTxid:string;genesisOutpoint:Point;currentOutpoint:Point;indexedFungible:{codeScript:string;tapeScript:string;totalSupply:string}}>;
function point(value:Point){return HASH.test(value.txid)&&Number.isSafeInteger(value.vout)&&value.vout>=0&&value.vout<=0xffff_ffff;}

/** Fresh availability plus bounded immutable ancestry. Rust supplies exact Code
 * recognition; its planner independently authenticates identity and signatures.
 * No broadcast, database, secret, recursive history walk or fee-parent scan. */
export async function resolveLopMaterial(input:Readonly<{
  requirement:ChainDataRequirement;address:string;ownerScript:string;client:TestnetClient;native:PoolMaterialNativeProviderInput;
  minimumConfirmations:string;maxInputs:number;
  readHistory:(txid:string)=>Promise<Parent>;readDecoded:(txid:string)=>Promise<Parent>;
  hasHistory?:(txid:string)=>boolean;
}>){
  const r=JSON.parse(canonicalize(input.requirement)) as ChainDataRequirement,{client,readDecoded,native}=input;
  if(!client.api||!UINT.test(input.minimumConfirmations)||!/^76a914[0-9a-f]{40}88ac$/u.test(input.ownerScript)||
    !["tbc-lop-create","tbc-lop-cancel","tbc-lop-match"].includes(r.intentType)||r.includeAncestry!==true)throw new TypeError("Invalid LOP material request");
  const create=r.intentType==="tbc-lop-create",cancel=r.intentType==="tbc-lop-cancel";
  const targets=r.targetOutpoints??[],hints=r.lopAssets??[];
  if(create?(targets.length!==0||hints.length<1||hints.length>2||hints.some(a=>!HASH.test(a.contractId)||!["identity","escrow"].includes(a.purpose)||!["tbc20-standard","tbc20-stablecoin"].includes(a.standard))||
      new Set(hints.map(a=>a.contractId)).size!==hints.length||hints.filter(a=>a.purpose==="escrow").length>1):
    hints.length!==0||targets.length!==(cancel?1:2)||targets.some(p=>!point(p))||new Set(targets.map(p=>`${p.txid}:${p.vout}`)).size!==targets.length)throw new TypeError("Invalid LOP exact selectors");
  if(r.inputOutpoints?.some(p=>!point(p))||r.certificateOutpoint!==undefined||r.collectionSlots!==undefined)throw new TypeError("Invalid LOP input selectors");
  const escrowHint=hints.find(h=>h.purpose==="escrow"),escrowRequirement=r.assets[1];
  if(r.assets[0]?.kind!=="native"||r.assets[0].contractId!==undefined||r.assets[0].contractDependency!==undefined||
    (create?(escrowHint===undefined?(r.assets.length!==1||!r.nativeAmount||r.assets[0].minimumAmount!==r.nativeAmount):
      r.assets.length!==2||r.nativeAmount!==undefined||escrowRequirement?.contractId!==escrowHint.contractId||
      escrowRequirement?.kind!==(escrowHint.standard==="tbc20-standard"?"ft":"stablecoin")||!escrowRequirement?.minimumAmount||!/^[1-9][0-9]*$/u.test(escrowRequirement.minimumAmount)):
      r.assets.length!==2||escrowRequirement?.kind!=="lop"||r.nativeAmount!==undefined))throw new TypeError("Inconsistent LOP material projection");
  if(create&&JSON.stringify(r.contractIds)!==JSON.stringify(hints.map(h=>h.contractId)))throw new TypeError("LOP identity order differs");
  const parents=new Map<string,Parent>(),contracts=new Map<string,Contract>(),utxos:Utxo[]=[];
  const decoded=new Map<string,Promise<Parent>>();
  const fresh=(id:string)=>{let pending=decoded.get(id);if(!pending){pending=readDecoded(id);decoded.set(id,pending);}return pending;};
  const read=async(id:string)=>{if(!HASH.test(id))throw new Error("Invalid LOP parent ID");const cached=parents.get(id);if(cached)return cached;const p=await input.readHistory(id);if(p.txid!==id)throw new Error("LOP parent ID mismatch");parents.set(id,p);return p;};
  const raw=({txid,rawTransaction}:Parent)=>({txid,rawTransaction});
  const inspect=async(request:unknown)=>JSON.parse(await native.execute("inspectLopMaterial",JSON.stringify(request)));
  const inspectAsset=async(parent:Parent,vout:number):Promise<Asset>=>{
    const a=await inspect({phase:"inspectAsset",parent:raw(parent),vout}) as Asset;
    if(a.txid!==parent.txid||a.vout!==vout||!["tbc20-standard","tbc20-stablecoin"].includes(a.standardId)||!UINT.test(a.balance)||
      !Array.isArray(a.dependencies)||a.dependencies.length>6||a.dependencies.some(p=>!point(p)))throw new Error("Invalid LOP Token inspection");return a;
  };
  const anchor=async(id:string,standard:Standard,current?:Point)=>{
    const info=await (standard==="tbc20-standard"?client.getFtInfo(id):client.getStablecoinInfo(id));
    if(info.contractId!==id)throw new Error("Invalid LOP indexed identity");
    current??={txid:id,vout:0};
    const indexedFungible={codeScript:info.codeScript,tapeScript:info.tapeScript,totalSupply:info.totalSupply};
    const prior=contracts.get(id);if(prior&&prior.standardId!==standard)throw new Error("LOP asset standard conflict");
    if(prior&&(prior.currentOutpoint.txid<current!.txid||(prior.currentOutpoint.txid===current!.txid&&prior.currentOutpoint.vout<=current!.vout)))return;
    contracts.set(id,Object.freeze({contractId:id,indexedFungible,family:standard==="tbc20-standard"?"ft":"stablecoin",protocolVersion:standard==="tbc20-standard"?"tbc20":"coin",
      standardId:standard,templateRevision:standard==="tbc20-standard"?FT:COIN,creationTxid:id,genesisOutpoint:{txid:id,vout:0},currentOutpoint:{txid:current!.txid,vout:current!.vout}}));
  };
  const floor=BigInt(input.minimumConfirmations),allowed=(p:Point)=>r.inputOutpoints===undefined||r.inputOutpoints.some(i=>i.txid===p.txid&&i.vout===p.vout);
  const confirmation=async(id:string,height:string|undefined,tip:TestnetTip|undefined)=>{
    if(height==="-1")height="0";
    if(height!==undefined){if(!UINT.test(height)||tip!==undefined&&BigInt(height)>BigInt(tip.height))throw new Error("LOP height exceeds tip");return height==="0"?"0":tip===undefined?undefined:String(BigInt(tip.height)-BigInt(height)+1n);}
    if(floor===0n)return undefined;
    const value=await fresh(id),old=parents.get(id);if(value.txid!==id||(old&&old.rawTransaction!==value.rawTransaction))throw new Error("LOP fresh parent differs");
    parents.set(id,value);if(value.confirmations===undefined||!UINT.test(value.confirmations))throw new Error("LOP confirmations unknown");return value.confirmations;
  };
  const nativeIndex:Promise<{tip?:TestnetTip;utxos:readonly import('./testnet-client.js').TestnetUtxo[]}>=floor===0n&&client.getNativeUtxos
    ?client.getNativeUtxos(input.address).then(utxos=>({utxos})):client.getUtxos(input.address);
  let observedTip:TestnetTip|undefined,pendingTip:Promise<TestnetTip>|undefined;
  const observeTip=()=>pendingTip??=nativeIndex.then(async index=>{
    observedTip=index.tip??(client.getTip?await client.getTip():(await client.getUtxos(input.address)).tip);return observedTip;
  });
  const assetsWork=(async()=>{
    if(create){
      await Promise.all(hints.map(async hint=>{
        if(hint.purpose==="identity"){await anchor(hint.contractId,hint.standard);return;}
        const [rows,{tip}]=await Promise.all([hint.standard==="tbc20-standard"?client.getFtUtxos(input.address,hint.contractId):client.getStablecoinUtxos(input.address,hint.contractId),nativeIndex]);
        if(rows.length>input.maxInputs)throw new Error("LOP asset candidate bound exceeded");
        let total=0n;const wanted=BigInt(escrowRequirement!.minimumAmount!),selected:Asset[]=[],seen=new Set<string>();
        for(const row of [...positiveHolderCandidates(rows, row=>row.ftAmount, r.inputOutpoints)].sort((a,b)=>a.txid.localeCompare(b.txid)||a.vout-b.vout)){
          const key=`${row.txid}:${row.vout}`;if(seen.has(key))throw new Error("Duplicate LOP Token candidate");seen.add(key);
          if(!allowed(row)||total>=wanted&&r.inputOutpoints===undefined)continue;
          const c=await confirmation(row.txid,row.height,tip);if(c!==undefined&&BigInt(c)<floor){if(r.inputOutpoints)throw new Error("LOP selected confirmations insufficient");continue;}
          const parent=await read(row.txid),a=await inspectAsset(parent,row.vout);
          if(a.standardId!==hint.standard||a.balance!==row.ftAmount||row.satoshis!=="500"||a.controller!==`${input.ownerScript.slice(6,46)}00`)throw new Error("LOP index/Token holder mismatch");
          if(a.lockTime!==0){const time=await observeTip();if(a.lockTime<500_000_000?BigInt(a.lockTime)>BigInt(time.height):time.medianTimePast===undefined||BigInt(a.lockTime)>=BigInt(time.medianTimePast)){if(r.inputOutpoints)throw new Error("LOP Coin not mature");continue;}}
          if(selected.length===5)throw new Error("LOP deposit requires separate asset maintenance");
          selected.push(a);total+=BigInt(a.balance);utxos.push({txid:a.txid,vout:a.vout,satoshis:"500",scriptPubKey:a.scriptPubKey,classification:hint.standard==="tbc20-standard"?"ft":"stablecoin",contractId:hint.contractId,...(c===undefined?{}:{confirmations:c})});
        }
        if(total<wanted||selected.length===0)throw new Error("LOP deposit balance insufficient");
        await Promise.all([anchor(hint.contractId,hint.standard,selected[0]),...new Set(selected.flatMap(a=>a.dependencies.map(p=>p.txid)))].map(p=>typeof p==="string"?read(p):p));
      }));
    }else{
      const orders=await Promise.all(targets.map(async(target,index)=>{
        // A cold target needs bytes anyway: use the same request to observe
        // confirmations. Warm bytes defer status until index height is known.
        const parent=floor>0n&&input.hasHistory?.(target.txid)===false?await fresh(target.txid):await read(target.txid);
        if(parent.txid!==target.txid)throw new Error("LOP parent ID mismatch");
        parents.set(target.txid,parent);
        const order=await inspect({phase:"inspectOrder",parent:raw(parent),vout:target.vout});
        if(order.standardId!=="tbc-lop"||order.txid!==target.txid||order.vout!==target.vout||(!cancel&&order.side!==(index===0?"buy":"sell"))||
          (cancel&&order.ownerHash!==input.ownerScript.slice(6,46)))throw new Error("LOP order role or target mismatch");
        return {parent,order,target};
      }));
      const points=orders.flatMap(({target,order})=>order.escrow===null?[target]:[target,{txid:target.txid,vout:target.vout+1}]);
      if(points.some(p=>!allowed(p))||new Set(points.map(p=>`${p.txid}:${p.vout}`)).size!==points.length)throw new Error("LOP selected pairs missing or repeated");
      const [{txos},{tip}]=await Promise.all([client.api!.txoStatus({txos:points.map(p=>({txid:p.txid,index:p.vout}))},{category:"asset-index"}),nativeIndex]);
      if(!Array.isArray(txos)||txos.length!==points.length)throw new Error("LOP status count mismatch");
      const status=new Map<string,typeof txos[number]>();const heights=new Map<string,string>();
      for(const row of txos){const key=`${row.txid}:${row.index}`;
        if(!points.some(p=>p.txid===row.txid&&String(p.vout)===row.index)||status.has(key)||row.spent!==false)throw new Error("LOP output unavailable or repeated");status.set(key,row);
        if(row.height!==undefined){const height=row.height==="-1"?"0":row.height,prior=heights.get(row.txid);if(prior!==undefined&&prior!==height)throw new Error("LOP sibling heights inconsistent");heights.set(row.txid,height);}
      }
      await Promise.all(orders.map(async({parent,order,target})=>{
        for(const p of order.escrow===null?[target]:[target,{txid:target.txid,vout:target.vout+1}]){
          const row=status.get(`${p.txid}:${p.vout}`)!,output=parent.outputs[p.vout];
          if(!output||output.vout!==p.vout||output.satoshis!==row.value||(row.scriptPubKey!==undefined&&row.scriptPubKey!==output.scriptPubKey))throw new Error("LOP status/raw mismatch");
          const c=await confirmation(p.txid,row.height,tip);if(c!==undefined&&BigInt(c)<floor)throw new Error("LOP current confirmations insufficient");
          const a=order.escrow as Asset|null;
          utxos.push({...p,satoshis:row.value,scriptPubKey:output.scriptPubKey,classification:p.vout===target.vout?"lop":a!.standardId==="tbc20-standard"?"ft":"stablecoin",
            ...(p.vout===target.vout?{}:{contractId:a!.contractId!}),...(c===undefined?{}:{confirmations:c})});
        }
        const a=order.escrow as Asset|null;
        if(a){if(!a.contractId||!HASH.test(a.contractId)||a.dependencies.length>6)throw new Error("Invalid LOP escrow identity");
          if(a.lockTime!==0)await observeTip();
          await Promise.all([anchor(a.contractId,a.standardId,a),...new Set(a.dependencies.map(p=>p.txid))].map(p=>typeof p==="string"?read(p):p));}
      }));
    }
  })();
  const [index]=await Promise.all([nativeIndex,assetsWork]);
  const tip=observedTip??index.tip,funding=index.utxos;
  if(tip!==undefined&&(!UINT.test(tip.height)||!HASH.test(tip.hash))||funding.length>input.maxInputs)throw new Error("LOP tip/funding bound invalid");
  const feeRows:Utxo[]=[];
  for(const row of funding){if(!allowed(row))continue;const c=await confirmation(row.txid,row.height,tip);if(c!==undefined&&BigInt(c)<floor)continue;
    feeRows.push({txid:row.txid,vout:row.vout,satoshis:row.satoshis,scriptPubKey:input.ownerScript,classification:"native",...(c===undefined?{}:{confirmations:c})});}
  if(feeRows.length===0)throw new Error("LOP native funding unavailable");
  const all=[...feeRows,...utxos];if(all.length>input.maxInputs||new Set(all.map(p=>`${p.txid}:${p.vout}`)).size!==all.length)throw new Error("LOP snapshot input bound or duplication");
  // Completion order changes on warm cache hits. Snapshot material order must
  // not: Prepared approval/binding compares the same canonical material set.
  return {tip,utxos:all.sort((a,b)=>a.txid.localeCompare(b.txid)||a.vout-b.vout),
    parents:[...parents.values()].sort((a,b)=>a.txid.localeCompare(b.txid)),
    contracts:[...contracts.values()].sort((a,b)=>a.contractId.localeCompare(b.contractId))};
}
