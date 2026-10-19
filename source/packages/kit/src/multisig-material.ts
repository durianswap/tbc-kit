import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { parseTbcTransaction, turingTransactionId, assertHash32 } from "./testnet-validation.js";
import type { TbcOfficialApiClient } from "./official-api.js";
import type { MultisigDescriptor, MultisigEngine, MultisigGroup, MultisigInput, MultisigToken } from "./multisig.js";

/** An explicitly configured API; no default network, backend service or polling.
 * Mutable UTXO selections are never cached. Immutable raw transactions are
 * deduplicated only inside one resolve call, including shared funding parents.
 */
export function createMultisigMaterialLoader(options: Readonly<{
  chainId: "tbc:mainnet" | "tbc:testnet";
  api: TbcOfficialApiClient;
  engine: MultisigEngine;
}>) {
  const {api,engine,chainId}=options;
  if (chainId!=="tbc:mainnet"&&chainId!=="tbc:testnet") throw new TypeError("Invalid TBC chain");
  const describe=async(group:MultisigGroup):Promise<MultisigDescriptor>=>JSON.parse(await engine.execute("describeMultisig",JSON.stringify(group)));
  const index=(value:string):number=>{
    if(!/^(0|[1-9][0-9]*)$/u.test(value)||BigInt(value)>0xffff_ffffn)throw new TypeError("Invalid UTXO index");return Number(value);
  };
  const atomic=(value:unknown):string=>{
    if(typeof value!=="string"||!/^(0|[1-9][0-9]*)$/u.test(value))throw new TypeError("Invalid atomic amount");return value;
  };
  const nativeRows=async(group:MultisigGroup,query:Readonly<{target?:string;limit?:number}>={})=>{
    const d=await describe(group);
    const scriptpubkeyhash=bytesToHex(sha256(hexToBytes(d.scriptPubKey)).reverse());
    const rows=await api.utxosByScriptHash({scriptpubkeyhash,...query});
    return Object.freeze(rows.utxos.map(row=>Object.freeze({txid:assertHash32(row.txid),vout:index(row.index),
      satoshis:atomic(row.value),scriptPubKey:d.scriptPubKey})));
  };
  const resolveToken=async(input:Readonly<{
    code:string;tape:string;
    selected:readonly Readonly<{txid:string;vout:number;balance:string}>[];
    funding?:MultisigInput;
  }>):Promise<Readonly<{token:MultisigToken;funding?:MultisigInput}>>=>{
    if(input.selected.length<1||input.selected.length>5)throw new RangeError("MultiSig FT requires one to five inputs");
    const cache=new Map<string,Promise<string>>();
    const read=(txid:string):Promise<string>=>{
      assertHash32(txid);
      let pending=cache.get(txid);
      if(!pending){pending=api.rawTransaction({txid}).then(result=>{
        if(turingTransactionId(result.txraw)!==txid)throw new Error("Multisig parent txid mismatch");return result.txraw;
      });cache.set(txid,pending);}return pending;
    };
    // Known immutable funding bytes may be reused after txid authentication.
    if(input.funding?.parentTxraw){
      if(turingTransactionId(input.funding.parentTxraw)!==input.funding.txid)throw new Error("Funding parent txid mismatch");
      cache.set(input.funding.txid,Promise.resolve(input.funding.parentTxraw));
    }
    const fundingPromise=input.funding?read(input.funding.txid):undefined;
    const [parents,fundingRaw]=await Promise.all([Promise.all(input.selected.map(i=>read(i.txid))),fundingPromise]);
    const inspected=JSON.parse(await engine.execute("prepareAssetAncestry",JSON.stringify({phase:"inspect",items:input.selected.map((i,n)=>({
      parentTxid:i.txid,outputIndex:i.vout,parentTxraw:parents[n],
    }))}))) as {items:readonly {references:readonly {txid:string}[]}[]};
    if(inspected.items.length!==parents.length)throw new Error("Invalid ancestry response");
    const items=await Promise.all(input.selected.map(async(i,n)=>{
      const p=parseTbcTransaction(parents[n]!);const o=p.outputs[i.vout];
      if(!Number.isInteger(i.vout)||i.vout<0||!o)throw new Error("Token output missing");
      const ancestors=await Promise.all(inspected.items[n]!.references.map(ref=>read(ref.txid)));
      return {input:{txid:i.txid,vout:i.vout,satoshis:o.satoshis.toString(),scriptPubKey:bytesToHex(o.scriptPubKey),parentTxraw:parents[n]!},
        balance:atomic(i.balance),ancestors};
    }));
    const funding=fundingRaw?{...input.funding!,parentTxraw:fundingRaw}:undefined;
    return {token:{code:input.code,tape:input.tape,inputs:items},...(funding?{funding}:{})};
  };
  return Object.freeze({chainId,
    /** Bounded selection, not an assertion this is the address's full balance. */
    nativeInputs:nativeRows,
    resolveToken,
    async tokenInputs(input:Readonly<{group:MultisigGroup;contractId:string;asset?:"ft"|"legacy-stablecoin";target?:string;funding?:MultisigInput}>) {
      const descriptor=await describe(input.group);assertHash32(input.contractId);
      if(input.asset!==undefined&&input.asset!=="ft"&&input.asset!=="legacy-stablecoin")throw new TypeError("Unsupported multisig token asset");
      // The caller selects the known asset family. Never probe FT first or
      // repeat downloads to guess whether an indexed asset is a legacy Coin.
      const coin=input.asset==="legacy-stablecoin";
      const [info,list]=await Promise.all([
        coin?api.stablecoinInfo({stablecoin_id:input.contractId}):api.ftInfo({contract_id:input.contractId}),
        coin?api.stablecoinUtxosByCombineScript({combine_script:descriptor.tokenOwner,stablecoin_id:input.contractId})
          :api.ftUtxosByCombineScript({combine_script:descriptor.tokenOwner,contract_id:input.contractId,limit:5,...(input.target?{target:input.target}:{})}),
      ]);
      if(typeof info.code_script!=="string"||typeof info.tape_script!=="string")throw new Error("Missing indexed token Code/Tape");
      if(!Array.isArray(list.utxos))throw new Error("Missing indexed token UTXOs");
      // Legacy Coin indexes do not expose the FT target/limit query contract.
      // Bound selection locally without issuing extra reads or changing order.
      const target=input.target===undefined?undefined:BigInt(atomic(input.target));
      const selected: {txid:string;vout:number;balance:string}[]=[];let total=0n;
      for(const row of list.utxos.slice(0,5)){
        if(row===null||typeof row!=="object"||Array.isArray(row)||typeof row.txid!=="string"||typeof row.index!=="string")throw new Error("Invalid indexed token UTXO");
        const balance=atomic(row.ft_value??row.balance);
        selected.push({txid:assertHash32(row.txid),vout:index(row.index),balance});total+=BigInt(balance);
        if(target!==undefined&&total>=target)break;
      }
      return resolveToken({code:info.code_script,tape:info.tape_script,selected,...(input.funding?{funding:input.funding}:{})});
    },
  });
}
