//! Public new-NFT profile. Shared material, selection, approval and signing;
//! protocol builders stay keyless and do not perform network operations.
use std::{collections::{BTreeMap,BTreeSet},rc::Rc};
use tbc_sdk::{Address,OutPoint,PublicKey,Transaction,TxOut,script::Script,contracts::nft::{CollectionData,NftData,scripts}};
use crate::{EngineError,ErrorCode,model::{CanonicalRequest,WalletMaterial,PlannedTransfer,AssetFlow,Violation,ContractRecord,error},
    normalize::{validate_request,parse_decimal_u64,hex},protocols::{tbc721::parse_code,tbc721_transaction::{self as builder,FundingInput,MintItem,NftPlan,TransferOptions}},
    signing::{PublicSigningContext,UnsignedPlan,materialize_unsigned_preview}};
use super::ft::{validate_material_identity,decode_hex,funding_candidates,finish_profile_plan};

pub(crate) const TEMPLATE:&str="a97688ec62777b01e93c8486e0505b56701f48dc8cf7947637ece57fe88df104";
fn invalid(message:&str)->EngineError {error(ErrorCode::InvalidAncestry,message,"snapshot.payload")}
fn required<'a>(v:&'a Option<String>)->Result<&'a str,EngineError>{v.as_deref().ok_or_else(||invalid("required NFT field missing"))}
fn address(v:&str)->Result<Address,EngineError>{Address::from_string(v).map_err(|_|invalid("invalid NFT address"))}
fn permitted(r:&CanonicalRequest,id:&str,vout:u32)->bool {
    r.constraints.as_ref().and_then(|c|c.input_outpoints.as_ref()).is_none_or(|p|p.iter().any(|p|p.txid==id&&p.vout==vout))
}
struct Parents<'a>{raw:BTreeMap<&'a str,&'a str>,cache:BTreeMap<String,Rc<Transaction>>}
impl<'a> Parents<'a>{
    fn new(m:&'a WalletMaterial<'_>)->Result<Self,EngineError>{
        let mut raw=BTreeMap::new();for p in &m.snapshot.payload.parents {
            if raw.insert(p.txid.as_str(),p.raw_transaction.as_str()).is_some(){return Err(invalid("duplicate NFT parent material"));}
        }Ok(Self {raw,cache:BTreeMap::new()})
    }
    fn get(&mut self,id:&str)->Result<Rc<Transaction>,EngineError>{
        if let Some(tx)=self.cache.get(id){return Ok(tx.clone());}
        let raw=self.raw.get(id).ok_or_else(||error(ErrorCode::MissingMaterial,"required NFT parent is absent","snapshot.payload.parents"))?;
        if raw.len()>2*1_048_576{return Err(invalid("NFT parent exceeds material budget"));}
        let tx=Transaction::from_hex(raw).map_err(|_|invalid("NFT parent is malformed"))?;
        if tx.version!=10||tx.inputs.is_empty()||tx.to_hex()!=*raw||tx.txid().to_string()!=id {return Err(invalid("NFT parent identity, version or encoding differs"));}
        let tx=Rc::new(tx);self.cache.insert(id.into(),tx.clone());Ok(tx)
    }
}
fn record<'a>(m:&'a WalletMaterial<'_>,id:&str,family:&str)->Result<&'a ContractRecord,EngineError>{
    let matches:Vec<_>=m.snapshot.payload.contracts.iter().filter(|r|r.contract_id==id).collect();
    if matches.len()!=1{return Err(invalid("NFT requires one unambiguous contract record"));}
    let r=matches[0];
    if r.family!=family||r.protocol_version!="tbc721"||r.standard_id.as_deref()!=Some("tbc721-standard")
        ||r.template_revision.as_deref()!=Some(TEMPLATE)||r.creation_txid!=id
        ||r.genesis_outpoint.as_ref().is_none_or(|o|o.txid!=id||o.vout!=0) {
        return Err(invalid("NFT contract record does not bind the new standard identity"));
    }Ok(r)
}
fn spend(m:&WalletMaterial<'_>,r:&CanonicalRequest,tx:&Transaction,vout:u32,id:&str,class:&str)->Result<(),EngineError>{
    let txid=tx.txid().to_string();let matches:Vec<_>=m.snapshot.payload.utxos.iter().filter(|u|u.txid==txid&&u.vout==vout).collect();
    if matches.len()!=1{return Err(invalid("selected NFT/slot UTXO must occur exactly once"));}
    let u=matches[0];let o=tx.outputs.get(vout as usize).ok_or_else(||invalid("selected NFT output missing"))?;
    let minimum=parse_decimal_u64(&m.policy.payload.min_confirmations,"policy.payload.minConfirmations")?;
    if !permitted(r,&txid,vout)||u.contract_id.as_deref()!=Some(id)||u.classification!=class
        ||u.satoshis!=o.satoshis.to_string()||u.script_pub_key!=hex(o.script_pubkey.as_bytes()) {
        return Err(invalid("NFT/slot UTXO does not match selected authenticated parent"));
    }
    if !crate::confirmations::meets_minimum(u.confirmations.as_deref(),minimum,"snapshot.payload.utxos.confirmations")? {
        return Err(error(ErrorCode::MissingMaterial,"NFT input confirmation policy is not met","snapshot.payload.utxos"));
    }Ok(())
}
fn policy(r:&CanonicalRequest,m:&WalletMaterial<'_>)->Result<(),EngineError>{
    let p=&m.policy.payload;
    if p.chain_id!=r.chain_id||p.fee_rate_sat_per_kb!="80"||p.dust_threshold!="42"||p.sighash_type!=65 {
        return Err(error(ErrorCode::InvalidInput,"TBC721 requires 80 atomic/kB, change dust 42 and sighash 65","policy.payload"));
    }
    let family=if r.intent.intent_type=="tbc721-standard-create-collection" {"collection"}else{"nft"};
    let mut found=false;
    for rule in &p.contract_policies {
        if rule.get("family").and_then(|v|v.as_str())!=Some(family){continue;}
        if found{return Err(invalid("duplicate NFT contract policies"));}found=true;
        let versions=rule.get("allowedVersions").and_then(|v|v.as_array()).ok_or_else(||invalid("NFT allowedVersions missing"))?;
        let names:Option<BTreeSet<_>>=versions.iter().map(|v|v.as_str()).collect();
        if names.as_ref().is_none_or(|s|s.len()!=versions.len()||!s.contains("tbc721"))
            ||(r.intent.intent_type!="tbc721-standard-transfer"&&rule.get("createVersion").and_then(|v|v.as_str())!=Some("tbc721")) {
            return Err(error(ErrorCode::InvalidInput,"NFT policy does not allow requested new-standard operation","policy.payload.contractPolicies"));
        }
    }
    if let Some(payment)=&r.intent.payment {
        let value=parse_decimal_u64(&payment.amount,"request.intent.payment.amount")?;
        let limits:Vec<_>=p.amount_limits.iter().filter(|l|l.scope=="native"&&l.contract_id.is_none()&&l.protocol_version.is_none()).collect();
        if limits.len()!=1||value>parse_decimal_u64(&limits[0].maximum,"policy.payload.amountLimits.maximum")? {
            return Err(error(ErrorCode::InvalidInput,"NFT TBC payment exceeds native policy","policy.payload.amountLimits"));
        }
    }Ok(())
}
fn metadata(name:&str,symbol:&str,description:&str,attrs:&[serde_json::Value],media:Option<&serde_json::Value>)->Result<NftData,EngineError>{
    Ok(NftData {nft_name:name.into(),symbol:symbol.into(),description:description.into(),
        attributes:serde_json::to_string(attrs).map_err(|_|invalid("NFT attributes encoding failed"))?,
        file:media.map(serde_json::to_string).transpose().map_err(|_|invalid("NFT media encoding failed"))?})
}

pub(crate) fn plan_tbc721(r:&CanonicalRequest,m:&WalletMaterial<'_>,signing:&PublicSigningContext)->Result<PlannedTransfer,EngineError>{
    validate_request(r)?;validate_material_identity(r,m)?;policy(r,m)?;
    let key=PublicKey::from_slice(&decode_hex(&signing.public_key,"snapshot.payload.account.publicKey")?).map_err(|_|invalid("invalid NFT public key"))?;
    let cap=r.constraints.as_ref().and_then(|c|c.max_fee.as_deref()).map(|v|parse_decimal_u64(v,"request.constraints.maxFee")).transpose()?.unwrap_or(u64::MAX);
    let intent=&r.intent;let kind=intent.intent_type.as_str();let receiver=address(intent.to.as_deref().unwrap_or(&r.from))?;
    let mut parents=Parents::new(m)?;
    let mut collection=None;let mut current=None;let mut grandparent=None;let mut origin=None;
    let mut slots=Vec::new();let mut receivers=Vec::new();let mut data=Vec::new();let mut flows=Vec::new();
    if matches!(kind,"tbc721-standard-mint"|"tbc721-standard-batch-mint") {
        let id=required(&intent.collection_id)?;let rec=record(m,id,"collection")?;let tx=parents.get(id)?;
        if rec.current_outpoint.txid!=id||rec.current_outpoint.vout==0{return Err(invalid("collection record must reference one of its mint slots"));}
        if kind=="tbc721-standard-mint" {
            slots.push(intent.slot.unwrap());receivers.push(receiver.clone());
            data.push(metadata(required(&intent.name)?,required(&intent.symbol)?,required(&intent.description)?,intent.attributes.as_deref().unwrap(),intent.media.as_ref())?);
        }else{for item in intent.items.as_deref().unwrap(){slots.push(item.slot);receivers.push(address(item.to.as_deref().unwrap_or(&r.from))?);
            data.push(metadata(&item.name,&item.symbol,&item.description,&item.attributes,item.media.as_ref())?);}}
        if slots.len()>m.policy.payload.max_bundle_transactions as usize {return Err(error(ErrorCode::InvalidInput,"NFT batch exceeds policy transaction limit","policy.payload.maxBundleTransactions"));}
        for (i,slot) in slots.iter().enumerate(){spend(m,r,&tx,*slot,id,"collection-slot")?;
            flows.push(AssetFlow {kind:"nft".into(),direction:"mint".into(),amount:"1".into(),contract_id:None,from:r.from.clone(),to:Some(receivers[i].to_string())});}
        collection=Some(tx);
    }else if kind=="tbc721-standard-transfer" {
        let id=required(&intent.contract_id)?;let rec=record(m,id,"nft")?;
        if rec.current_outpoint.vout!=0{return Err(invalid("NFT current Code must be output zero"));}
        let genesis=parents.get(id)?;let parent=parents.get(&rec.current_outpoint.txid)?;
        if !(3..=4).contains(&genesis.outputs.len())||genesis.outputs[0].satoshis!=200||genesis.outputs[1].satoshis!=100||genesis.outputs[2].satoshis!=0 {
            return Err(invalid("NFT genesis must have canonical Code/Hold/Tape layout"));
        }
        let descriptor=parse_code(genesis.outputs[0].script_pubkey.as_bytes()).map_err(|_|invalid("NFT genesis Code is not the new template"))?;
        if descriptor.original_outpoint.vout==0||genesis.inputs[0].previous_output!=descriptor.original_outpoint
            ||parent.outputs.len()<3||parent.outputs[0].script_pubkey!=genesis.outputs[0].script_pubkey||parent.outputs[2]!=genesis.outputs[2] {
            return Err(invalid("NFT current identity or immutable Tape differs from bound Genesis"));
        }
        let hold=genesis.outputs[1].script_pubkey.as_bytes();
        let hash: [u8;20]=hold.get(3..23).ok_or_else(||invalid("NFT genesis Hold malformed"))?.try_into().unwrap();
        if genesis.outputs[1].script_pubkey!=scripts::hold_script(&Address::from_hash160(hash)){return Err(invalid("NFT genesis has a non-NFT Hold role"));}
        spend(m,r,&parent,0,id,"nft")?;spend(m,r,&parent,1,id,"nft")?;
        grandparent=Some(parents.get(&parent.inputs[0].previous_output.txid.to_string())?);origin=Some(descriptor.original_outpoint);current=Some(parent);
        flows.push(AssetFlow {kind:"nft".into(),direction:"send".into(),amount:"1".into(),contract_id:Some(id.into()),from:r.from.clone(),to:Some(receiver.to_string())});
        if let Some(p)=&intent.payment {flows.push(AssetFlow {kind:"native".into(),direction:"send".into(),amount:p.amount.clone(),contract_id:None,from:r.from.clone(),to:Some(p.to.clone())});}
    }else{flows.push(AssetFlow {kind:"collection".into(),direction:"create".into(),amount:required(&intent.supply)?.into(),contract_id:None,from:r.from.clone(),to:Some(receiver.to_string())});}
    let collection_data=if kind=="tbc721-standard-create-collection" {Some(CollectionData {collection_name:required(&intent.name)?.into(),description:required(&intent.description)?.into(),
        supply:parse_decimal_u64(required(&intent.supply)?,"request.intent.supply")? as u32,file:serde_json::to_string(intent.media.as_ref().unwrap()).map_err(|_|invalid("collection media encoding failed"))?})} else {None};
    let payment=intent.payment.as_ref().map(|p|Ok((address(&p.to)?,parse_decimal_u64(&p.amount,"request.intent.payment.amount")?))).transpose()?;
    let mut candidates=funding_candidates(m,signing)?;candidates.retain(|c|permitted(r,&c.txid,c.vout));
    candidates.sort_by(|a,b|(a.satoshis,&a.txid,a.vout).cmp(&(b.satoshis,&b.txid,b.vout)));
    let outputs=candidates.iter().map(|c|Ok(TxOut {satoshis:c.satoshis,script_pubkey:Script::from_bytes(decode_hex(&c.script,"snapshot.payload.utxos")?)})).collect::<Result<Vec<_>,EngineError>>()?;
    let fees=candidates.iter().zip(&outputs).map(|(c,o)|Ok(FundingInput {outpoint:OutPoint {txid:c.txid.parse().map_err(|_|invalid("invalid native funding ID"))?,vout:c.vout},output:o})).collect::<Result<Vec<_>,EngineError>>()?;
    let build=|fees:&[FundingInput<'_>]|->Result<NftPlan,EngineError>{
        if let Some(meta)=&collection_data {return builder::build_collection_plan(meta,&receiver,&key,fees,cap);}
        if let Some(tx)=&collection {let items=slots.iter().enumerate().map(|(i,slot)|MintItem {slot:*slot,recipient:&receivers[i],data:&data[i]}).collect::<Vec<_>>();
            return builder::build_batch_mint_plan(tx,&items,&key,fees,cap);}
        builder::build_transfer_plan(TransferOptions {parent:current.as_deref().unwrap(),grandparent:grandparent.as_deref().unwrap(),expected_origin:origin.as_ref().unwrap(),public_key:&key,recipient:&receiver,
            funding:fees,payment:payment.as_ref().map(|(a,v)|(a,*v)),max_fee:cap})
    };
    let exact=r.constraints.as_ref().and_then(|c|c.input_outpoints.as_ref()).is_some();let mut built=None;let mut last=None;
    if exact {built=Some(build(&fees)?);} else {
        for fee in &fees {match build(std::slice::from_ref(fee)){Ok(p)=>{built=Some(p);break;},Err(e) if matches!(e.code,ErrorCode::InsufficientFunds|ErrorCode::FeeCapExceeded)=>last=Some(e),Err(e)=>return Err(e)}}
        if built.is_none(){let descending:Vec<_>=fees.into_iter().rev().collect();for count in 2..=descending.len(){
            match build(&descending[..count]){Ok(p)=>{built=Some(p);break;},Err(e) if matches!(e.code,ErrorCode::InsufficientFunds|ErrorCode::FeeCapExceeded)=>last=Some(e),Err(e)=>return Err(e)}
        }}
    }
    let mut built=built.ok_or_else(||last.unwrap_or_else(||error(ErrorCode::InsufficientFunds,"NFT requires sufficient selected native funding","snapshot.payload.utxos")))?;
    if built.unsigned_plan.transactions.len()>m.policy.payload.max_bundle_transactions as usize{return Err(invalid("NFT plan exceeds policy bundle limit"));}
    for tx in &mut built.unsigned_plan.transactions {tx.role="primary".into();}
    if let Some(points)=r.constraints.as_ref().and_then(|c|c.input_outpoints.as_ref()) {
        let wanted:BTreeSet<_>=points.iter().map(|p|(p.txid.as_str(),p.vout)).collect();
        let ids:BTreeSet<_>=built.unsigned_plan.transactions.iter().map(|t|t.transaction_id.as_str()).collect();
        let actual:BTreeSet<_>=built.unsigned_plan.transactions.iter().flat_map(|t|&t.inputs).filter(|i|!ids.contains(i.previous_transaction_id.as_str())).map(|i|(i.previous_transaction_id.as_str(),i.previous_output_index)).collect();
        if actual!=wanted{return Err(error(ErrorCode::InvalidInput,"NFT explicit inputs must equal all external selected inputs","request.constraints.inputOutpoints"));}
    }
    let previews=built.unsigned_plan.transactions.iter().map(|t|materialize_unsigned_preview(t,&built.unsigned_plan)).collect::<Result<Vec<_>,_>>()?;
    finish_profile_plan(r,m,built.unsigned_plan,previews,built.fees,vec![],flows)
}

pub(crate) fn validate_tbc721_plan(r:&CanonicalRequest,plan:&UnsignedPlan)->Vec<Violation>{
    let count=r.intent.items.as_ref().map_or(1,Vec::len);
    if plan.transactions.len()==count&&plan.transactions.iter().all(|t|t.role=="primary"){vec![]}else{
        vec![Violation {code:"BUSINESS_OUTPUT_MISMATCH".into(),path:Some("plan.payload.transactions".into())}]
    }
}
