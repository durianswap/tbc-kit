//! Keyless Coin address-holder transfer and merge with selected immutable inputs.
//! Fixed SDK: coinTbc20.ts at af776161. No selection, HTTP, keys, UI or storage.
//! Shared slot allocation/evidence interning and staged witness sizing; distinct
//! Coin rules: nonfinal inputs, lock domains, mandatory >=24 native change.
use std::collections::{BTreeMap, BTreeSet};
use tbc_sdk::{Address, PublicKey, Transaction, hash, script::Script};
use crate::{EngineError, ErrorCode, signing::{UnsignedPlan, PlannedInput, PlannedOutput, PublicSigningContext, EvidenceEntry,
    PlannedTransaction, ProofReference, Tbc20OutputGroup, CoinUnlockRecipe,
    coin_unlocking_descriptor, maximum_signed_transaction_sizes}};
use super::{coin, coin_proof::ParentMaterial, tbc20_mint::fee_for_size,
    tbc20_material::MAX_MATERIAL_TRANSACTION_BYTES, tbc20_transfer::{allocate, intern, public_context}};
pub use super::tbc20_transfer::{FeeInput, Receiver, TransferPlan};

const MAX_SAFE: u64 = 9_007_199_254_740_991;
const NONFINAL: u32 = super::coin::HOLDER_INPUT_SEQUENCE;

pub struct CoinInput<'a> {
    pub parent: &'a ParentMaterial,
    /// Exact deduplicated direct ancestors, already obtained by the caller.
    pub ancestor_raws: &'a [&'a [u8]],
    pub public_key: &'a PublicKey,
}
pub struct TransferOptions<'a> {
    pub inputs: &'a [CoinInput<'a>],
    pub fee_input: &'a FeeInput<'a>,
    pub receivers: &'a [Receiver],
    /// Independently bound asset; parsing the supplied parent is not provenance.
    pub expected_identity: &'a [u8],
    pub token_change_controller: [u8; 21],
    pub additional_payment: Option<(&'a Address, u64)>,
    pub additional_info: Option<&'a [u8]>,
    pub max_fee: u64,
}
fn invalid(message: &str) -> EngineError {
    EngineError {code:ErrorCode::InvalidPlan,message:message.into(),path:None}
}
fn insufficient(message: &str) -> EngineError {
    EngineError {code:ErrorCode::InsufficientFunds,message:message.into(),path:None}
}
fn hex(bytes:&[u8])->String {bytes.iter().map(|b|format!("{b:02x}")).collect()}

pub fn build_transfer_plan(options: TransferOptions<'_>) -> Result<TransferPlan, EngineError> {
    if options.inputs.is_empty() || options.inputs.len()>5 {
        return Err(invalid("Coin transfer supports one to five selected Coin inputs plus one fee input"));
    }
    if options.receivers.is_empty() || options.receivers.len()>7 {
        return Err(invalid("Coin receivers must leave one of eight groups for native change"));
    }
    let first = options.inputs[0].parent;
    let mut remaining = Vec::new(); let mut seen = BTreeSet::new(); let mut locks = Vec::new();let mut signers=Vec::new();
    for input in options.inputs {
        let p = input.parent;
        if options.expected_identity.is_empty() || p.identity()!=options.expected_identity || p.tape().balance==0 {
            return Err(invalid("Coin input has the wrong bound identity or zero balance"));
        }
        let key = input.public_key.to_bytes(); let owner = input.public_key.hash160();
        if p.code().controller[20]!=0 || p.code().controller[..20]!=owner {
            return Err(invalid("Coin holder builder requires a matching address controller"));
        }
        // The holder may also be the x-only administrator. Match the pinned
        // SDK's per-input algorithm choice, without asking for any private key.
        let xonly_admin=hash::hash160(&key[1..])==p.code().admin_pubkey_hash;
        signers.push(if xonly_admin {
            super::coin_issuance::administrator_context(key[1..].try_into().unwrap())?
        }else{public_context(input.public_key)});
        if !seen.insert((p.selected().txid.to_string(),p.selected().vout)) {
            return Err(invalid("Coin selected inputs repeat an outpoint"));
        }
        locks.push(if xonly_admin || owner==p.code().admin_pubkey_hash {0} else {p.tape().lock_time});
        remaining.push(p.tape().balance);
    }
    let lock_time = coin::required_lock_time(&locks).map_err(|_|invalid("Coin holder inputs mix height and timestamp locks"))?;
    let fee_input = options.fee_input;
    if fee_input.output.satoshis==0 || fee_input.output.satoshis>MAX_SAFE
        || fee_input.output.script_pubkey!=Script::p2pkh(&fee_input.public_key.hash160())
        || !seen.insert((fee_input.outpoint.txid.to_string(),fee_input.outpoint.vout)) {
        return Err(invalid("Coin fee input must be positive, unique, owner-controlled P2PKH"));
    }
    let total_native = fee_input.output.satoshis.checked_add(options.inputs.len() as u64*500)
        .filter(|v|*v<=MAX_SAFE).ok_or_else(||invalid("Coin native total exceeds safe integer range"))?;
    let mut token_outputs = Vec::new();
    for receiver in options.receivers {
        if receiver.amount==0 {return Err(invalid("Coin recipient amount must be positive"));}
        if receiver.amount>remaining.iter().sum() {return Err(insufficient("Coin recipients exceed selected balance"));}
        allocate(&mut remaining,receiver.controller,receiver.amount,&mut token_outputs)?;
    }
    let token_change = remaining.iter().sum();
    allocate(&mut remaining,options.token_change_controller,token_change,&mut token_outputs)?;
    let first_code = first.transaction().outputs[first.selected().vout as usize].script_pubkey.as_bytes();
    let mut outputs = Vec::new(); let mut groups = Vec::new();
    for output in &token_outputs {
        groups.push(Tbc20OutputGroup {code_vout:outputs.len() as u32,tape_vout:Some(outputs.len() as u32+1)});
        outputs.push(PlannedOutput {satoshis:500,locking_script:hex(&coin::replace_controller(first_code,output.controller)
            .map_err(|_|invalid("Coin recipient controller invalid"))?)});
        // SDK holder transfer consumes the mature input lock and emits unlocked
        // outputs. Preserve the first input's exact metadata/padding, not locks.
        outputs.push(PlannedOutput {satoshis:0,locking_script:hex(&coin::build_tape(output.amounts_by_input,
            first.code().tape_size as usize,0,&first.tape().metadata).map_err(|_|invalid("Coin output Tape invalid"))?)});
    }
    if let Some((address, amount)) = options.additional_payment {
        if !(24..=MAX_SAFE).contains(&amount) {return Err(invalid("Coin additional TBC payment must be at least 24 atomic and safe"));}
        groups.push(Tbc20OutputGroup {code_vout:outputs.len() as u32,tape_vout:None});
        outputs.push(PlannedOutput {satoshis:amount,locking_script:hex(Script::p2pkh(&address.hash160()).as_bytes())});
    }
    if let Some(data) = options.additional_info {
        if data.len()>MAX_MATERIAL_TRANSACTION_BYTES {return Err(invalid("Coin additional data exceeds transaction byte budget"));}
        let mut script = Script::from_bytes(vec![0,0x6a]); script.push_data(data);
        groups.push(Tbc20OutputGroup {code_vout:outputs.len() as u32,tape_vout:None});
        outputs.push(PlannedOutput {satoshis:0,locking_script:hex(script.as_bytes())});
    }
    if groups.len()>=8 {return Err(invalid("Coin requires one of eight output groups for native change"));}
    let fixed = outputs.iter().try_fold(0u64,|sum,o|sum.checked_add(o.satoshis).filter(|n|*n<=MAX_SAFE))
        .ok_or_else(||invalid("Coin output total exceeds safe integer range"))?;
    let available = total_native.checked_sub(fixed).filter(|n|*n>=104)
        .ok_or_else(||insufficient("Coin funding cannot cover outputs, fees and change"))?;
    groups.push(Tbc20OutputGroup {code_vout:outputs.len() as u32,tape_vout:None});
    outputs.push(PlannedOutput {satoshis:available-80,locking_script:hex(Script::p2pkh(&fee_input.public_key.hash160()).as_bytes())});

    let (mut inputs,evidence_table)=bound_coin_inputs(options.inputs.iter().zip(signers).map(|(input,signer)|
        (input.parent,input.ancestor_raws,signer)),&groups)?;
    inputs.push(PlannedInput {previous_transaction_id:fee_input.outpoint.txid.to_string(),previous_output_index:fee_input.outpoint.vout,
        previous_output_script:hex(fee_input.output.script_pubkey.as_bytes()),previous_output_satoshis:fee_input.output.satoshis,
        sequence:tbc_sdk::DEFAULT_SEQUENCE,signer:public_context(fee_input.public_key),unlocking_script:String::new()});
    let mut unsigned_plan = UnsignedPlan {evidence_table,transactions:vec![PlannedTransaction {
        transaction_id:"tbc20-stablecoin-transfer".into(),role:"tbc20-stablecoin-transfer".into(),stage:0,depends_on:vec![],
        version:10,lock_time,inputs,outputs,
    }]};
    let maximum_signed_bytes = maximum_signed_transaction_sizes(&unsigned_plan)?[0];
    if maximum_signed_bytes>MAX_MATERIAL_TRANSACTION_BYTES {return Err(invalid("Coin transaction exceeds byte budget"));}
    let fee = fee_for_size(maximum_signed_bytes)?;
    let change = available.checked_sub(fee).filter(|n|*n>=24)
        .ok_or_else(||insufficient("Coin funding cannot cover complete witness fee and 24 atomic change"))?;
    if fee>options.max_fee {return Err(EngineError {code:ErrorCode::FeeCapExceeded,message:"Coin fee exceeds approved cap".into(),path:None});}
    unsigned_plan.transactions[0].outputs.last_mut().unwrap().satoshis = change;
    Ok(TransferPlan {unsigned_plan,token_outputs,fee,maximum_signed_bytes})
}

/// Holder and administrator share ordered slots, exact ancestor-set checks and
/// per-build parsing/interning. No cache survives the bound construction call.
pub(crate) fn bound_coin_inputs<'a>(materials:impl IntoIterator<Item=(&'a ParentMaterial,&'a [&'a [u8]],PublicSigningContext)>,
    groups:&[Tbc20OutputGroup])->Result<(Vec<PlannedInput>,Vec<EvidenceEntry>),EngineError> {
    let mut evidence_table = Vec::new(); let mut ids = BTreeMap::new(); let mut inputs = Vec::new();
    let mut cache: Vec<(&[u8],Transaction)> = Vec::new();
    for (p,ancestor_raws,signer) in materials {
        let parent = intern(p.transaction(),&mut evidence_table,&mut ids);
        if ancestor_raws.len()>6 {return Err(invalid("Coin ancestor set exceeds six slots"));}
        let mut supplied = BTreeMap::new();
        for raw in ancestor_raws {
            let index = if let Some(i) = cache.iter().position(|(bytes,_)|bytes==raw) {i} else {
                if raw.is_empty() || raw.len()>MAX_MATERIAL_TRANSACTION_BYTES {return Err(invalid("Coin ancestor exceeds byte budget"));}
                let tx = Transaction::from_bytes(raw).map_err(|_|invalid("Coin ancestor raw malformed"))?;
                if tx.serialize()!=*raw {return Err(invalid("Coin ancestor raw is not canonical"));}
                cache.push((raw,tx));cache.len()-1
            };
            if supplied.insert(cache[index].1.txid().to_string(),index).is_some() {return Err(invalid("Coin ancestor repeated"));}
        }
        let required:BTreeSet<_> = p.dependencies().iter().map(|point|point.txid.to_string()).collect();
        if required!=supplied.keys().cloned().collect() {return Err(invalid("Coin needs exactly its direct ancestors"));}
        let proof_references = p.dependencies().iter().map(|point|ProofReference {
            source:intern(&cache[supplied[&point.txid.to_string()]].1,&mut evidence_table,&mut ids),output_index:point.vout,
        }).collect();
        inputs.push(PlannedInput {previous_transaction_id:p.selected().txid.to_string(),previous_output_index:p.selected().vout,
            previous_output_script:hex(p.transaction().outputs[p.selected().vout as usize].script_pubkey.as_bytes()),
            previous_output_satoshis:500,sequence:NONFINAL,signer,
            unlocking_script:coin_unlocking_descriptor(CoinUnlockRecipe {parent,proof_references,output_groups:groups.to_vec(),contract_controller:None})?});
    }
    Ok((inputs,evidence_table))
}

/// Merge uses the same holder path, conserving the complete selected balance.
pub fn build_merge_plan(options:TransferOptions<'_>,controller:[u8;21])->Result<TransferPlan,EngineError> {
    if options.inputs.is_empty() || options.inputs.len()>5 {return Err(invalid("Coin merge requires one to five inputs"));}
    let total = options.inputs.iter().map(|input|input.parent.tape().balance).sum();
    let receivers = [Receiver {controller,amount:total}];
    let mut result = build_transfer_plan(TransferOptions {receivers:&receivers,..options})?;
    result.unsigned_plan.transactions[0].transaction_id="tbc20-stablecoin-merge".into();
    result.unsigned_plan.transactions[0].role="tbc20-stablecoin-merge".into();
    Ok(result)
}
