//! Public address-holder profile for pinned TBC20 contracts. No network or keys.
//! The Genesis transaction ID is the SDK/API contract ID; partial Code identity
//! is derived only after authenticating its separate Source -> Genesis anchor.
use std::collections::{BTreeMap, BTreeSet};
use unicode_normalization::UnicodeNormalization;
use tbc_sdk::{Address, OutPoint, PublicKey, Transaction, TxOut, script::Script};
use crate::{EngineError, ErrorCode, model::{AssetFlow, CanonicalRequest, PlannedTransfer,
    Violation, WalletMaterial, error}, normalize::{hex, parse_decimal_u128, parse_decimal_u64, tbc20_transfer_recipients, validate_request},
    protocols::{tbc20::MAX_SLOT_AMOUNT,
        tbc20_material::{ParentMaterial, inspect_parent, link_ancestors},
        tbc20_mint::build_mint_plan,
        tbc20_transfer::{FeeInput, Receiver, TokenInput, TransferOptions},
        tbc20_batch::{BatchOptions, build_batch_merge_plan, build_batch_transfer_plan}},
    signing::{PublicSigningContext, UnsignedPlan, materialize_unsigned_preview}};
use super::ft::{decode_hex, finish_profile_plan, funding_candidates, validate_material_identity};

const TEMPLATE: &str = "0f5db33bb46e4517963cbd383518f74283b5c2c4efb0a733522a1fbc0d4a9f84";
fn invalid(message: &str) -> EngineError { error(ErrorCode::InvalidAncestry, message, "snapshot.payload") }
fn missing(message: &str) -> EngineError { error(ErrorCode::MissingMaterial, message, "snapshot.payload.parents") }
fn insufficient(message: &str) -> EngineError { error(ErrorCode::InsufficientFunds, message, "snapshot.payload.utxos") }
fn address_controller(address: &str) -> Result<[u8;21],EngineError> {
    let address = Address::from_string(address).map_err(|_| error(ErrorCode::InvalidInput,"invalid TBC20 recipient","request.intent.to"))?;
    let mut controller=[0;21]; controller[..20].copy_from_slice(&address.hash160()); Ok(controller)
}
pub(crate) fn max_fee(request: &CanonicalRequest) -> Result<u64,EngineError> {
    request.constraints.as_ref().and_then(|c|c.max_fee.as_deref())
        .map(|value|parse_decimal_u64(value,"request.constraints.maxFee")).transpose().map(|v|v.unwrap_or(u64::MAX))
}
pub(crate) fn permitted(request: &CanonicalRequest, txid:&str, vout:u32) -> bool {
    request.constraints.as_ref().and_then(|c|c.input_outpoints.as_ref())
        .is_none_or(|points|points.iter().any(|p|p.txid==txid && p.vout==vout))
}

struct Limits { total:u128, slot:u128 }
fn policy_limits(request:&CanonicalRequest,material:&WalletMaterial<'_>)->Result<Limits,EngineError> {
    let mut ft_policy=None;
    for policy in &material.policy.payload.contract_policies {
        if policy.get("family").and_then(|v|v.as_str())!=Some("ft") {continue;}
        if ft_policy.replace(policy).is_some() {return Err(invalid("duplicate FT contract policies are ambiguous"));}
        let allowed=policy.get("allowedVersions").and_then(|v|v.as_array())
            .ok_or_else(||invalid("FT contract policy allowedVersions is malformed"))?;
        let versions:Option<BTreeSet<_>>=allowed.iter().map(|v|v.as_str()).collect();
        let versions=versions.ok_or_else(||invalid("FT allowedVersions must contain strings"))?;
        if versions.len()!=allowed.len() || !versions.contains("tbc20")
            || (request.intent.intent_type=="tbc20-standard-create" && policy.get("createVersion").and_then(|v|v.as_str())!=Some("tbc20"))
        {return Err(error(ErrorCode::InvalidInput,"FT policy does not allow the requested TBC20 operation","policy.payload.contractPolicies"));}
    }
    let mut result=Limits{total:u128::MAX,slot:MAX_SLOT_AMOUNT as u128};
    let mut seen=BTreeMap::new();
    for limit in &material.policy.payload.amount_limits {
        if !matches!(limit.scope.as_str(),"ft-total"|"ft-slot")
            || limit.protocol_version.as_deref().is_some_and(|v|v!="tbc20")
            || limit.contract_id.as_deref().is_some_and(|id|Some(id)!=request.intent.contract_id.as_deref()) {continue;}
        let maximum=parse_decimal_u128(&limit.maximum,"policy.payload.amountLimits.maximum")?;
        let key=(limit.scope.as_str(),limit.protocol_version.as_deref(),limit.contract_id.as_deref());
        if maximum==0 || seen.insert(key,maximum).is_some_and(|previous|previous!=maximum) {
            return Err(error(ErrorCode::InvalidInput,"FT amount policy is zero or contradictory","policy.payload.amountLimits"));
        }
        if limit.scope=="ft-total" {result.total=result.total.min(maximum);}else{result.slot=result.slot.min(maximum);}
    }
    Ok(result)
}
fn check_amounts(limits:&Limits,total:u128,slots:impl IntoIterator<Item=u64>)->Result<(),EngineError> {
    if total>limits.total || slots.into_iter().any(|slot|slot as u128>limits.slot) {
        return Err(error(ErrorCode::InvalidInput,"TBC20 amount exceeds the applicable FT total/slot policy","policy.payload.amountLimits"));
    }
    Ok(())
}

pub(crate) fn check_shared_amount_policy(request:&CanonicalRequest,material:&WalletMaterial<'_>,total:u128,slots:impl IntoIterator<Item=u64>)->Result<(),EngineError> {
    check_amounts(&policy_limits(request,material)?,total,slots)
}

/// Parse only material used by this operation; never parse/fetch the whole chain.
pub(crate) struct Parents<'a> { raw:BTreeMap<&'a str,&'a str>, decoded:BTreeMap<String,Vec<u8>> }
impl<'a> Parents<'a> {
    pub(crate) fn new(material:&'a WalletMaterial<'_>)->Result<Self,EngineError> {
        let mut raw=BTreeMap::new();
        for parent in &material.snapshot.payload.parents {
            if raw.insert(parent.txid.as_str(),parent.raw_transaction.as_str()).is_some() {
                return Err(invalid("duplicate parent transaction entry"));
            }
        }
        Ok(Self{raw,decoded:BTreeMap::new()})
    }
    pub(crate) fn bytes(&mut self,id:&str)->Result<&[u8],EngineError> {
        if !self.decoded.contains_key(id) {
            let raw=self.raw.get(id).ok_or_else(||missing("required TBC20 parent is absent"))?;
            if raw.len()>2*1_048_576 {return Err(invalid("TBC20 parent exceeds material byte bound"));}
            let bytes=decode_hex(raw,"snapshot.payload.parents")?;
            if hex(&bytes)!=*raw {return Err(invalid("TBC20 raw material must use canonical hex"));}
            self.decoded.insert(id.to_owned(),bytes);
        }
        Ok(&self.decoded[id])
    }
}

/// Wallet-owned trusted-index identity, separate from direct unlock material.
/// Keeping these separate avoids manufacturing a fake Genesis transaction.
pub(crate) struct TokenIdentity {
    pub(crate) script:Vec<u8>,
    identity:Vec<u8>,
    tape:crate::protocols::tbc20::TapeDescriptor,
}
impl TokenIdentity {
    pub(crate) fn identity(&self)->&[u8]{&self.identity}
    pub(crate) fn tape(&self)->&crate::protocols::tbc20::TapeDescriptor{&self.tape}
}
pub(crate) fn trusted_token_identity(id:&str,material:&WalletMaterial<'_>,parents:&mut Parents<'_>)->Result<TokenIdentity,EngineError>{
    let records:Vec<_>=material.snapshot.payload.contracts.iter().filter(|r|r.contract_id==id).collect();
    if records.len()!=1{return Err(invalid("TBC20 requires one unambiguous contract record"));}
    let record=records[0];
    if let Some(indexed)=&record.indexed_fungible {
        if record.family!="ft"||record.protocol_version!="tbc20"||record.standard_id.as_deref()!=Some("tbc20-standard")
            ||record.template_revision.as_deref()!=Some(TEMPLATE)||record.creation_txid!=id
            ||record.genesis_outpoint.as_ref().is_none_or(|p|p.txid!=id||p.vout!=0){return Err(invalid("indexed TBC20 record identity differs"));}
        let mut decoded=Vec::new();
        for value in [&indexed.code_script,&indexed.tape_script] {
            if value.is_empty()||value.len()>131072{return Err(invalid("indexed TBC20 script exceeds bound"));}
            let bytes=decode_hex(value,"snapshot.payload.contracts.indexedFungible")?;
            if hex(&bytes)!=*value{return Err(invalid("indexed TBC20 script is not canonical hex"));}decoded.push(bytes);
        }
        let code=crate::protocols::tbc20::parse_code(&decoded[0]).map_err(|_|invalid("indexed TBC20 Code invalid"))?;
        let tape=crate::protocols::tbc20::parse_tape(&decoded[1]).map_err(|_|invalid("indexed TBC20 Tape invalid"))?;
        if code.tape_size as usize!=decoded[1].len()||parse_decimal_u128(&indexed.total_supply,"snapshot.payload.contracts.indexedFungible.totalSupply")?==0{
            return Err(invalid("indexed TBC20 Tape size or supply invalid"));}
        let identity=crate::protocols::tbc20::code_identity(&decoded[0]).map_err(|_|invalid("indexed TBC20 identity invalid"))?;
        return Ok(TokenIdentity{identity,tape,script:decoded.remove(0)});
    }
    let genesis=trusted_genesis_id(id,material,parents)?;
    Ok(TokenIdentity{identity:genesis.identity().to_vec(),tape:genesis.tape().clone(),
        script:genesis.transaction().outputs[0].script_pubkey.as_bytes().to_vec()})
}
pub(crate) fn trusted_genesis_id(id:&str,material:&WalletMaterial<'_>,parents:&mut Parents<'_>) -> Result<ParentMaterial,EngineError> {
    let records:Vec<_>=material.snapshot.payload.contracts.iter().filter(|r|r.contract_id==id).collect();
    if records.len()!=1 {return Err(invalid("TBC20 requires one unambiguous contract record"));}
    let record=records[0];
    if record.family!="ft" || record.protocol_version!="tbc20"
        || record.standard_id.as_deref()!=Some("tbc20-standard")
        || record.template_revision.as_deref()!=Some(TEMPLATE)
        || record.creation_txid!=id
        || record.genesis_outpoint.as_ref().is_none_or(|p|p.txid!=id || p.vout!=0)
    {return Err(invalid("TBC20 contract record does not bind the pinned Genesis standard"));}
    let selected=OutPoint {txid:id.parse().map_err(|_|invalid("invalid Genesis ID"))?,vout:0};
    let genesis=inspect_parent(parents.bytes(id)?,&selected,None)?;
    let tx=genesis.transaction();
    // Canonical mint has exactly one input and one Code/Tape pair. Rejecting
    // extra pairs closes same-identity siblings masquerading as genesis supply.
    if tx.inputs.len()!=1 || !(2..=3).contains(&tx.outputs.len())
        || genesis.tape().amounts[0]==0 || genesis.tape().amounts[1..].iter().any(|v|*v!=0)
    {return Err(invalid("TBC20 Genesis is not the canonical single-supply mint"));}
    let source_outpoint=&tx.inputs[0].previous_output;
    let mut embedded=[0;36];embedded[..32].copy_from_slice(source_outpoint.txid.as_le_bytes());
    embedded[32..].copy_from_slice(&source_outpoint.vout.to_le_bytes());
    if source_outpoint.vout!=0 || genesis.code().original_outpoint!=embedded {
        return Err(invalid("TBC20 Genesis input does not match its original Source outpoint"));
    }
    let source_raw=parents.bytes(&source_outpoint.txid.to_string())?;
    let source=Transaction::from_bytes(source_raw).map_err(|_|invalid("TBC20 Source is malformed"))?;
    if source.serialize()!=source_raw || source.txid()!=source_outpoint.txid || source.version!=10
        || source.inputs.len()!=1 || source.outputs.len()!=1
    {return Err(invalid("TBC20 Source is not the canonical mint prerequisite"));}
    let source_script=source.outputs[0].script_pubkey.as_bytes();
    if source_script.len()!=25 || source_script[..3]!=[0x76,0xa9,0x14] || source_script[23..]!=[0x88,0xac]
        || (tx.outputs.len()==3 && (tx.outputs[2].script_pubkey!=source.outputs[0].script_pubkey || tx.outputs[2].satoshis<42))
    {return Err(invalid("TBC20 Source/change must follow the pinned P2PKH mint layout"));}
    let total=tx.outputs.iter().try_fold(0u64,|sum,o|sum.checked_add(o.satoshis))
        .ok_or_else(||invalid("TBC20 Genesis native amount overflow"))?;
    if total>=source.outputs[0].satoshis {return Err(invalid("TBC20 Genesis overspends or has no fee"));}
    Ok(genesis)
}

fn metadata(request:&CanonicalRequest)->Result<Vec<u8>,EngineError> {
    let name=request.intent.name.as_deref().unwrap_or("");
    let symbol=request.intent.symbol.as_deref().unwrap_or("");
    let decimals=request.intent.decimals.unwrap_or(0);
    let supply=parse_decimal_u64(request.intent.initial_supply.as_deref().unwrap_or(""),"request.intent.initialSupply")?;
    if name.is_empty() || name.nfc().ne(name.chars()) || symbol.is_empty() || !symbol.bytes().all(|b|(0x21..=0x7e).contains(&b))
        || name.len()+symbol.len()>53 || decimals>18 || supply==0 || supply>MAX_SLOT_AMOUNT {
        return Err(error(ErrorCode::InvalidInput,"invalid bounded TBC20 metadata or raw supply","request.intent"));
    }
    let mut extension=vec![(12+name.len()+symbol.len()) as u8,1,decimals];
    extension.extend_from_slice(&supply.to_le_bytes());
    extension.extend_from_slice(&[name.len() as u8,symbol.len() as u8]);
    extension.extend_from_slice(name.as_bytes());extension.extend_from_slice(symbol.as_bytes());extension.push(9);
    Ok(extension)
}

pub(crate) fn finish(request:&CanonicalRequest,material:&WalletMaterial<'_>,plan:UnsignedPlan,fees:Vec<u64>,flows:Vec<AssetFlow>)->Result<PlannedTransfer,EngineError> {
    finish_with_warnings(request,material,plan,fees,flows,vec![])
}

pub(crate) fn finish_with_warnings(request:&CanonicalRequest,material:&WalletMaterial<'_>,mut plan:UnsignedPlan,fees:Vec<u64>,flows:Vec<AssetFlow>,warnings:Vec<String>)->Result<PlannedTransfer,EngineError> {
    // Public transaction roles describe dependency purpose, not protocol IDs.
    // Keep business IDs on transaction_id and use the shared wire vocabulary.
    for transaction in &mut plan.transactions {
        transaction.role=if matches!(transaction.transaction_id.as_str(),"tbc20-standard-source"|"tbc20-stablecoin-source"|"tbc-amm-source") {"prerequisite"}
            else if transaction.role=="maintenance" {"maintenance"}else{"primary"}.into();
    }
    if plan.transactions.len()>material.policy.payload.max_bundle_transactions as usize {
        return Err(error(ErrorCode::InvalidInput,"TBC20 bundle exceeds policy transaction limit","policy.payload.maxBundleTransactions"));
    }
    if let Some(points)=request.constraints.as_ref().and_then(|c|c.input_outpoints.as_ref()) {
        let wanted:BTreeSet<_>=points.iter().map(|p|(p.txid.as_str(),p.vout)).collect();
        let ids:BTreeSet<_>=plan.transactions.iter().map(|tx|tx.transaction_id.as_str()).collect();
        let actual:BTreeSet<_>=plan.transactions.iter().flat_map(|tx|&tx.inputs)
            .filter(|input|!ids.contains(input.previous_transaction_id.as_str()))
            .map(|input|(input.previous_transaction_id.as_str(),input.previous_output_index)).collect();
        if actual!=wanted {return Err(error(ErrorCode::InvalidInput,"TBC20 specified inputs must match exact selected external inputs","request.constraints.inputOutpoints"));}
    }
    let previews=plan.transactions.iter().map(|tx|materialize_unsigned_preview(tx,&plan)).collect::<Result<Vec<_>,_>>()?;
    finish_profile_plan(request,material,plan,previews,fees,warnings,flows)
}

pub(crate) fn plan_tbc20(request:&CanonicalRequest,material:&WalletMaterial<'_>,signing:&PublicSigningContext)->Result<PlannedTransfer,EngineError> {
    validate_request(request)?;validate_material_identity(request,material)?;
    let policy=&material.policy.payload;
    if policy.chain_id!=request.chain_id || policy.fee_rate_sat_per_kb!="80" || policy.dust_threshold!="42" || policy.sighash_type!=65 {
        return Err(error(ErrorCode::InvalidInput,"TBC20 pinned policy requires 80 atomic/kB, dust 42, and sighash 65","policy.payload"));
    }
    let public=PublicKey::from_slice(&decode_hex(&signing.public_key,"snapshot.payload.account.publicKey")?)
        .map_err(|_|invalid("invalid TBC20 signing public key"))?;
    let owner=address_controller(&request.from)?;
    let mut funding=funding_candidates(material,signing)?;
    funding.retain(|u|permitted(request,&u.txid,u.vout));
    funding.sort_by(|a,b|(a.satoshis,&a.txid,a.vout).cmp(&(b.satoshis,&b.txid,b.vout)));
    let maximum_fee=max_fee(request)?;
    let limits=policy_limits(request,material)?;
    if request.intent.intent_type=="tbc20-standard-create" {
        if let Some(points)=request.constraints.as_ref().and_then(|c|c.input_outpoints.as_ref()) {
            if points.len()!=funding.len() {
                return Err(error(ErrorCode::InvalidInput,"TBC20 specified creation inputs must all be available native funding","request.constraints.inputOutpoints"));
            }
            if funding.len()>1 {
                return Err(insufficient("TBC20 selected creation funding requires a planned prerequisite"));
            }
        }
        let extension=metadata(request)?;
        let amount=parse_decimal_u64(request.intent.initial_supply.as_deref().unwrap(),"request.intent.initialSupply")?;
        check_amounts(&limits,amount as u128,[amount])?;
        let recipient=address_controller(request.intent.to.as_deref().unwrap_or(&request.from))?;
        let mut fee_cap_failure=None;
        for candidate in &funding {
            let built=build_mint_plan(OutPoint{txid:candidate.txid.parse().map_err(|_|invalid("invalid funding ID"))?,vout:candidate.vout},
                &TxOut{satoshis:candidate.satoshis,script_pubkey:Script::from_bytes(decode_hex(&candidate.script,"snapshot.payload.utxos")?)},
                &public,recipient,amount,&extension,maximum_fee);
            let built=match built {Ok(v)=>v,Err(e) if e.code==ErrorCode::InsufficientFunds=>continue,
                Err(e) if e.code==ErrorCode::FeeCapExceeded=>{fee_cap_failure=Some(e);continue;},Err(e)=>return Err(e)};
            return finish(request,material,built.unsigned_plan,vec![built.source_fee,built.genesis_fee],vec![AssetFlow {
                kind:"ft".into(),direction:"create".into(),amount:amount.to_string(),contract_id:None,
                from:request.from.clone(),to:Some(request.intent.to.clone().unwrap_or_else(||request.from.clone())) }]);
        }
        return Err(fee_cap_failure.unwrap_or_else(||insufficient("TBC20 create requires one sufficient native funding output")));
    }
    let mut parents=Parents::new(material)?;
    let genesis=trusted_token_identity(request.intent.contract_id.as_deref().unwrap(),material,&mut parents)?;
    let is_merge=request.intent.intent_type=="tbc20-standard-merge";
    let destinations=if is_merge {vec![]} else {tbc20_transfer_recipients(request)?};
    // The helper checks every positive amount and the aggregate bound.
    let amount=destinations.iter().map(|recipient|recipient.amount).sum::<u128>();
    let contract=request.intent.contract_id.as_deref().unwrap();
    let minimum=parse_decimal_u64(&policy.min_confirmations,"policy.payload.minConfirmations")?;
    let mut selected=Vec::new();let mut total=0u128;let mut seen=BTreeSet::new();
    let mut candidates:Vec<_>=material.snapshot.payload.utxos.iter()
        .filter(|u|u.contract_id.as_deref()==Some(contract)).collect();
    candidates.sort_by(|a,b|(&a.txid,a.vout).cmp(&(&b.txid,b.vout)));
    for utxo in candidates {
        if !seen.insert((utxo.txid.as_str(),utxo.vout)) {return Err(invalid("duplicate TBC20 asset outpoint"));}
        if !permitted(request,&utxo.txid,utxo.vout) {continue;}
        if utxo.classification!="ft" {return Err(invalid("TBC20 UTXO classification must be ft"));}
        if !crate::confirmations::meets_minimum(utxo.confirmations.as_deref(),minimum,"snapshot.payload.utxos.confirmations")? {continue;}
        if !is_merge && total>=amount && request.constraints.as_ref().and_then(|c|c.input_outpoints.as_ref()).is_none() {continue;}
        if selected.len()==128 {return Err(error(ErrorCode::UnsupportedIntent,"TBC20 maintenance exceeds the 128 asset input material bound","snapshot.payload.utxos"));}
        let outpoint=OutPoint{txid:utxo.txid.parse().map_err(|_|invalid("invalid TBC20 UTXO ID"))?,vout:utxo.vout};
        let parent=inspect_parent(parents.bytes(&utxo.txid)?,&outpoint,Some(genesis.identity()))?;
        let actual=&parent.transaction().outputs[utxo.vout as usize];
        if utxo.script_pub_key!=hex(actual.script_pubkey.as_bytes()) || utxo.satoshis!="500"
            || parent.code().controller!=owner || parent.tape().extension!=genesis.tape().extension {
            return Err(invalid("TBC20 UTXO descriptor/owner/extension differs from bound parent and Genesis"));
        }
        let required:BTreeSet<_>=parent.dependencies().iter().map(|d|d.outpoint.txid.to_string()).collect();
        let raws=required.iter().map(|id|parents.bytes(id).map(Vec::from)).collect::<Result<Vec<_>,_>>()?;
        let ancestors=link_ancestors(&parent,&raws.iter().map(Vec::as_slice).collect::<Vec<_>>())?;
        total=total.checked_add(parent.tape().balance).ok_or_else(||invalid("TBC20 balance overflow"))?;
        check_amounts(&limits,total,parent.tape().amounts)?;
        selected.push((parent,ancestors));
    }
    if selected.is_empty() || (!is_merge && total<amount) {return Err(insufficient("insufficient authenticated TBC20 balance"));}
    if let Some(indexed)=material.snapshot.payload.contracts.iter().find(|r|r.contract_id==contract).and_then(|r|r.indexed_fungible.as_ref()) {
        if total>parse_decimal_u128(&indexed.total_supply,"snapshot.payload.contracts.indexedFungible.totalSupply")?{return Err(invalid("TBC20 holdings exceed indexed supply"));}
    }
    if is_merge && selected.len()<2 {return Err(error(ErrorCode::InvalidInput,"TBC20 merge requires at least two token outputs","snapshot.payload.utxos"));}
    let receivers=if is_merge {vec![Receiver{controller:owner,amount:total}]} else {
        destinations.iter().map(|recipient|Receiver{controller:recipient.controller,amount:recipient.amount}).collect()
    };
    let inputs:Vec<_>=selected.iter().map(|(parent,ancestors)|TokenInput{parent,ancestors,public_key:&public}).collect();
    let mut fee_cap_failure=None;
    let mut attempt=|indices:&[usize]|->Result<Option<PlannedTransfer>,EngineError> {
        let outputs=indices.iter().map(|&i|Ok(TxOut{satoshis:funding[i].satoshis,
            script_pubkey:Script::from_bytes(decode_hex(&funding[i].script,"snapshot.payload.utxos")?)}))
            .collect::<Result<Vec<_>,EngineError>>()?;
        let fees=indices.iter().zip(&outputs).map(|(&i,output)|Ok(FeeInput{
            outpoint:OutPoint{txid:funding[i].txid.parse().map_err(|_|invalid("invalid funding ID"))?,vout:funding[i].vout},
            output,public_key:&public})).collect::<Result<Vec<_>,EngineError>>()?;
        let options=TransferOptions{inputs:&inputs,fee_inputs:&fees,receivers:&receivers,expected_identity:genesis.identity(),
            token_change_controller:owner,native_change_hash:public.hash160(),max_fee:maximum_fee};
        let batch=BatchOptions{transfer:options,max_transactions:policy.max_bundle_transactions as usize};
        let built=if is_merge {build_batch_merge_plan(batch)}else{build_batch_transfer_plan(batch)};
        let built=match built {Ok(v)=>v,Err(e) if e.code==ErrorCode::InsufficientFunds=>return Ok(None),
            Err(e) if e.code==ErrorCode::FeeCapExceeded=>{fee_cap_failure=Some(e);return Ok(None);},Err(e)=>return Err(e)};
        for output in &built.token_outputs {check_amounts(&limits,output.amount,output.amounts_by_input)?;}
        let flows=if is_merge {vec![AssetFlow{kind:"ft".into(),direction:"merge".into(),amount:total.to_string(),
            contract_id:Some(contract.into()),from:request.from.clone(),to:Some(request.from.clone())}]} else {
            destinations.iter().map(|recipient|AssetFlow{kind:"ft".into(),direction:"send".into(),amount:recipient.amount.to_string(),
                contract_id:Some(contract.into()),from:request.from.clone(),to:Some(recipient.to.into())}).collect()
        };
        finish(request,material,built.unsigned_plan,built.fees,flows).map(Some)
    };
    let remaining=if inputs.len()>=6 {1}else{6-inputs.len()};
    if let Some(points)=request.constraints.as_ref().and_then(|c|c.input_outpoints.as_ref()) {
        // Explicit inputs are an exact set, not candidates. Never finish using
        // one sufficient fee and silently discard other requested native inputs.
        if points.len()!=inputs.len()+funding.len() {
            return Err(error(ErrorCode::InvalidInput,"TBC20 specified inputs must all be available","request.constraints.inputOutpoints"));
        }
        if funding.len()>remaining {
            return Err(insufficient("TBC20 selected native funding requires a planned prerequisite"));
        }
        if let Some(plan)=attempt(&(0..funding.len()).collect::<Vec<_>>())? {return Ok(plan);}
    } else {
        // A six-Token single transaction may fund itself. Preserve that direct
        // path before considering an optional maintenance fee input.
        if inputs.len()==6 {
            if let Some(plan)=attempt(&[])? {return Ok(plan);}
        }
        // Preserve the existing successful single-fee selection and transaction.
        if remaining>0 {
            for index in 0..funding.len() {
                if let Some(plan)=attempt(&[index])? {return Ok(plan);}
            }
        }
        // Consolidating Code outputs can release enough native value for fees.
        if let Some(plan)=attempt(&[])? {return Ok(plan);}
        // No combinatorial search: at most four extra attempts, using largest
        // funding first to cover fragmented fees within the remaining vin slots.
        let mut combined=Vec::with_capacity(remaining);
        for index in (0..funding.len()).rev().take(remaining) {
            combined.push(index);
            if combined.len()>=2 {
                if let Some(plan)=attempt(&combined)? {return Ok(plan);}
            }
        }
    }
    Err(fee_cap_failure.unwrap_or_else(||insufficient("TBC20 requires sufficient native value within six total inputs")))
}

pub(crate) fn validate_tbc20_plan(request:&CanonicalRequest,plan:&UnsignedPlan)->Vec<Violation> {
    let mut violations=Vec::new();
    // The shared Validate path has already recomputed the authenticated plan and
    // signing requests. Only business shape is checked here, not the proofs twice.
    let shape_valid=if matches!(request.intent.intent_type.as_str(),"tbc20-standard-create"|"tbc20-stablecoin-create"|"tbc-amm-create") {
        plan.transactions.iter().map(|tx|tx.role.as_str()).collect::<Vec<_>>()==["prerequisite","primary"]
    }else{
        plan.transactions.last().is_some_and(|tx|tx.role=="primary") &&
            plan.transactions[..plan.transactions.len().saturating_sub(1)].iter().all(|tx|tx.role=="maintenance")
    };
    if !shape_valid {
        violations.push(Violation{code:"BUSINESS_OUTPUT_MISMATCH".into(),path:Some("plan.payload.transactions".into())});
    }
    violations
}
