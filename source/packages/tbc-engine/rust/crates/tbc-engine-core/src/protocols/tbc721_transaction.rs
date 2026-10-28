//! Pure TBC721 business construction over caller-selected, bound material.
//! No private key, HTTP, UTXO selection, approval, persistence or broadcasting.
//! Pinned SDK semantics: tbc-contract af776161, contract/tbc721.ts. All amounts
//! are atomic integers. Fees use shared maximum low-S sizing, not trial signing.

use std::collections::BTreeSet;
use tbc_sdk::{Address, OutPoint, PublicKey, Transaction, TxIn, TxOut, Txid, script::Script,
    contracts::nft::{CollectionData, NftData, scripts}};
use crate::{EngineError, ErrorCode, signing::{EvidenceEntry, PlannedInput, PlannedOutput,
    PlannedTransaction, PublicSigningContext, TransactionSource, UnsignedPlan,
    Tbc721UnlockRecipe, tbc721_unlocking_descriptor, MAX_SIGNING_PLAN_INPUTS,
    MAX_SIGNING_PLAN_OUTPUTS, MAX_SIGNING_PLAN_TRANSACTIONS}};
use super::{tbc721::{CodeDescriptor, instantiate_code, parse_code},
    tbc721_proof::{UnlockOptions, prepare_unlock}, tbc20_mint::fee_for_size,
    tbc20_material::MAX_MATERIAL_TRANSACTION_BYTES};

const MAX_SAFE: u64 = 9_007_199_254_740_991;
// Pinned tbc-lib-js change threshold; not the payment minimum (24 atomic).
const CHANGE_DUST: u64 = 42;

pub struct FundingInput<'a> {
    pub outpoint: OutPoint,
    pub output: &'a TxOut,
}

#[derive(Debug)]
pub struct NftPlan {
    pub unsigned_plan: UnsignedPlan,
    pub fees: Vec<u64>,
    pub maximum_signed_bytes: Vec<usize>,
}

pub struct MintItem<'a> {
    pub slot: u32,
    pub recipient: &'a Address,
    pub data: &'a NftData,
}

pub struct TransferOptions<'a> {
    pub parent: &'a Transaction,
    pub grandparent: &'a Transaction,
    /// Independently bound NFT origin, not copied blindly from an unknown Code.
    pub expected_origin: &'a OutPoint,
    pub public_key: &'a PublicKey,
    pub recipient: &'a Address,
    pub funding: &'a [FundingInput<'a>],
    /// Optional TBC payment: atomic units, no floating-point conversion here.
    pub payment: Option<(&'a Address, u64)>,
    pub max_fee: u64,
}

fn invalid(message: &str) -> EngineError {
    EngineError {code: ErrorCode::InvalidPlan,message: message.into(),path: None}
}
fn insufficient() -> EngineError {
    EngineError {code: ErrorCode::InsufficientFunds,message:"TBC721 selected funding cannot cover outputs and fees".into(),path:None}
}
fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b|format!("{b:02x}")).collect() }
fn context(key: &PublicKey) -> Result<PublicSigningContext,EngineError> {
    if key.to_bytes().len()!=33 {return Err(invalid("TBC721 holder profile requires a compressed public key"));}
    Ok(PublicSigningContext {address:key.address().to_string(),public_key:hex(&key.to_bytes()),public_key_hash:hex(&key.hash160())})
}
fn input(id: String,vout:u32,output:&TxOut,signer:&PublicSigningContext)->PlannedInput {
    PlannedInput {previous_transaction_id:id,previous_output_index:vout,
        previous_output_script:hex(output.script_pubkey.as_bytes()),previous_output_satoshis:output.satoshis,
        sequence:tbc_sdk::DEFAULT_SEQUENCE,unlocking_script:String::new(),signer:signer.clone()}
}
fn funding_inputs(funding:&[FundingInput<'_>],key:&PublicKey,reserved:&[OutPoint])->Result<Vec<PlannedInput>,EngineError> {
    if funding.len()+reserved.len()>MAX_SIGNING_PLAN_INPUTS {return Err(invalid("TBC721 selected input budget exceeded"));}
    let signer=context(key)?;let script=Script::p2pkh(&key.hash160());
    let mut seen:BTreeSet<_>=reserved.iter().map(|p|(p.txid.to_string(),p.vout)).collect();
    funding.iter().map(|f|{
        if f.output.satoshis==0||f.output.satoshis>MAX_SAFE||f.output.script_pubkey!=script
            ||!seen.insert((f.outpoint.txid.to_string(),f.outpoint.vout)) {
            return Err(invalid("TBC721 funding must be positive, unique, owner-controlled P2PKH"));
        }
        Ok(input(f.outpoint.txid.to_string(),f.outpoint.vout,f.output,&signer))
    }).collect()
}
fn sum(mut values:impl Iterator<Item=u64>)->Result<u64,EngineError> {
    values.try_fold(0u64,|s,v|s.checked_add(v).filter(|n|*n<=MAX_SAFE)
        .ok_or_else(||invalid("TBC721 atomic sum exceeds safe integer range")))
}
fn tape<T:serde::Serialize>(data:&T)->Result<Script,EngineError> {
    let raw=serde_json::to_vec(data).map_err(|_|invalid("TBC721 metadata cannot be encoded"))?;
    if raw.len()>MAX_MATERIAL_TRANSACTION_BYTES {return Err(invalid("TBC721 metadata exceeds material budget"));}
    scripts::tape_script(data).map_err(|_|invalid("TBC721 Tape encoding failed"))
}

/// Constructs one transaction with exact selected inputs; callers own selection.
/// Planned parent identifiers use zero-width-equivalent txids for fee sizing,
/// never as a spendable preview or signed transaction.
fn fund(
    id:&str,stage:u32,inputs:Vec<PlannedInput>,mut outputs:Vec<TxOut>,key:&PublicKey,
    max_fee:u64,proof:Option<(&Transaction,&Transaction)>,
) -> Result<(PlannedTransaction,u64,usize),EngineError> {
    if inputs.is_empty()||inputs.len()>MAX_SIGNING_PLAN_INPUTS||outputs.len()+1>MAX_SIGNING_PLAN_OUTPUTS {
        return Err(invalid("TBC721 transaction cardinality exceeds shared signing limits"));
    }
    let total=sum(inputs.iter().map(|i|i.previous_output_satoshis))?;
    let fixed=sum(outputs.iter().map(|o|o.satoshis))?;
    let size=|outs:&[TxOut]|->Result<usize,EngineError>{
        let mut tx=Transaction {version:10,inputs:inputs.iter().map(|i|TxIn::new(OutPoint {
            txid:i.previous_transaction_id.parse().unwrap_or_else(|_|Txid::from_le_bytes([0;32])),vout:i.previous_output_index,
        })).collect(),outputs:outs.to_vec(),lock_time:0};
        let code_size=proof.map(|(parent,grandparent)|prepare_unlock(UnlockOptions {
            current_tx:&tx,parent_tx:parent,grandparent_tx:grandparent,public_key:&key.to_bytes(),
        }).map(|p|p.max_unlocking_script_bytes())).transpose()?;
        for (vin,i) in tx.inputs.iter_mut().enumerate(){
            i.script_sig=Script::from_bytes(vec![0;if vin==0 {code_size.unwrap_or(107)} else {107}]);
        }
        let bytes=tx.serialize().len();
        if bytes>MAX_MATERIAL_TRANSACTION_BYTES {return Err(invalid("TBC721 transaction exceeds material byte budget"));}
        Ok(bytes)
    };
    outputs.push(TxOut {satoshis:CHANGE_DUST,script_pubkey:Script::p2pkh(&key.hash160())});
    let with_size=size(&outputs)?;let minimum=fee_for_size(with_size)?;
    let (fee,bytes)=match total.checked_sub(fixed).and_then(|v|v.checked_sub(minimum)) {
        Some(change) if change>=CHANGE_DUST=>{outputs.last_mut().unwrap().satoshis=change;(minimum,with_size)}
        _=>{outputs.pop();let bytes=size(&outputs)?;let paid=total.checked_sub(fixed).ok_or_else(insufficient)?;
            if paid<fee_for_size(bytes)? {return Err(insufficient());}(paid,bytes)}
    };
    if fee>max_fee {return Err(EngineError {code:ErrorCode::FeeCapExceeded,message:"TBC721 fee exceeds approved cap".into(),path:None});}
    let mut depends_on=Vec::new();
    for i in &inputs {if i.previous_transaction_id.parse::<Txid>().is_err()&&!depends_on.contains(&i.previous_transaction_id) {
        depends_on.push(i.previous_transaction_id.clone());
    }}
    Ok((PlannedTransaction {transaction_id:id.into(),role:if id.starts_with("tbc721-standard-mint-") {"tbc721-standard-mint".into()} else {id.into()},stage,
        depends_on,version:10,inputs,outputs:outputs.iter().map(|o|PlannedOutput {
            satoshis:o.satoshis,locking_script:hex(o.script_pubkey.as_bytes())}).collect(),lock_time:0},fee,bytes))
}

pub fn build_collection_plan(data:&CollectionData,recipient:&Address,key:&PublicKey,
    funding:&[FundingInput<'_>],max_fee:u64)->Result<NftPlan,EngineError> {
    if data.supply==0||u64::from(data.supply)+2>MAX_SIGNING_PLAN_OUTPUTS as u64 {
        return Err(invalid("TBC721 collection supply exceeds shared output limits or is zero"));
    }
    let inputs=funding_inputs(funding,key,&[])?;
    let mut outputs=vec![TxOut {satoshis:0,script_pubkey:tape(data)?}];
    outputs.extend((0..data.supply).map(|_|TxOut {satoshis:100,script_pubkey:scripts::mint_script(recipient)}));
    let (tx,fee,size)=fund("tbc721-standard-create-collection",0,inputs,outputs,key,max_fee,None)?;
    Ok(NftPlan {unsigned_plan:UnsignedPlan {transactions:vec![tx],evidence_table:vec![]},fees:vec![fee],maximum_signed_bytes:vec![size]})
}

pub fn build_mint_plan(collection:&Transaction,item:MintItem<'_>,key:&PublicKey,
    funding:&[FundingInput<'_>],max_fee:u64)->Result<NftPlan,EngineError> {
    build_batch_mint_plan(collection,&[item],key,funding,max_fee)
}

pub fn build_batch_mint_plan(collection:&Transaction,items:&[MintItem<'_>],key:&PublicKey,
    funding:&[FundingInput<'_>],max_fee:u64)->Result<NftPlan,EngineError> {
    if items.is_empty()||items.len()>100||items.len()>MAX_SIGNING_PLAN_TRANSACTIONS||items.len()*4>MAX_SIGNING_PLAN_OUTPUTS {
        return Err(invalid("TBC721 mint batch exceeds shared transaction/output limits or is empty"));
    }
    let layout=super::nft_origin::inspect_collection_layout(collection).map_err(|e|invalid(&e))?;
    let metadata=layout.metadata;
    let signer=context(key)?;
    if layout.owner!=key.address() {
        return Err(invalid("TBC721 collection slots do not match the mint owner"));
    }
    let collection_id=collection.txid();let mut slots=BTreeSet::new();
    for item in items {if item.slot==0||item.slot>metadata.supply||!slots.insert(item.slot) {
        return Err(invalid("TBC721 mint slots must be unique and within collection supply"));
    }}
    let reserved:Vec<_>=items.iter().map(|i|OutPoint {txid:collection_id,vout:i.slot}).collect();
    let mut fees=funding_inputs(funding,key,&reserved)?;
    if fees.len()+items.len()*2>MAX_SIGNING_PLAN_INPUTS {return Err(invalid("TBC721 batch input budget exceeded"));}
    let mut result=NftPlan {unsigned_plan:UnsignedPlan {transactions:Vec::new(),evidence_table:Vec::new()},fees:Vec::new(),maximum_signed_bytes:Vec::new()};
    let mut total_fee=0u64;
    for (index,item) in items.iter().enumerate(){
        let slot=&collection.outputs[item.slot as usize];
        let mut inputs=vec![input(collection_id.to_string(),item.slot,slot,&signer)];inputs.extend(fees);
        let mut data=item.data.clone();
        if data.file.as_ref().is_none_or(|file|file.is_empty()) {
            data.file=Some(format!("{}{}",collection_id,hex(&item.slot.to_le_bytes())));
        }
        let outputs=vec![TxOut {satoshis:200,script_pubkey:Script::from_bytes(instantiate_code(&CodeDescriptor {
            original_outpoint:OutPoint {txid:collection_id,vout:item.slot}}))},
            TxOut {satoshis:100,script_pubkey:scripts::hold_script(item.recipient)},TxOut {satoshis:0,script_pubkey:tape(&data)?}];
        let id=format!("tbc721-standard-mint-{index}");
        let (tx,fee,size)=fund(&id,index as u32,inputs,outputs,key,max_fee-total_fee,None)?;
        total_fee+=fee;fees=Vec::new();
        if index+1<items.len(){
            let change=tx.outputs.get(3).ok_or_else(insufficient)?;
            // This typed internal edge resolves only after the preceding mint is signed.
            fees.push(input(id,3,&TxOut {satoshis:change.satoshis,script_pubkey:Script::p2pkh(&key.hash160())},&signer));
        }
        result.unsigned_plan.transactions.push(tx);result.fees.push(fee);result.maximum_signed_bytes.push(size);
    }
    Ok(result)
}

pub fn build_transfer_plan(options:TransferOptions<'_>)->Result<NftPlan,EngineError> {
    let TransferOptions {parent,grandparent,expected_origin,public_key:key,recipient,funding,payment,max_fee}=options;
    if parent.outputs.len()<3 {return Err(invalid("TBC721 parent Code/Hold/Tape missing"));}
    let descriptor=parse_code(parent.outputs[0].script_pubkey.as_bytes()).map_err(|_|invalid("TBC721 parent uses a different Code template"))?;
    if descriptor.original_outpoint!=*expected_origin||expected_origin.vout==0
        ||parent.outputs[0].satoshis!=200||parent.outputs[1].satoshis!=100||parent.outputs[2].satoshis!=0
        ||parent.outputs[1].script_pubkey!=scripts::hold_script(&key.address()) {
        return Err(invalid("TBC721 ordinary NFT identity, layout or Hold owner is inconsistent"));
    }
    // Preserve actual Tape bytes, including external metadata variants (e.g.
    // nullable attributes). A transfer is not a new-mint form validation.
    let _:serde_json::Value=super::nft_metadata::decode_tape(&parent.outputs[2])?;
    let signer=context(key)?;let parent_id=parent.txid();
    let mut inputs=vec![input(parent_id.to_string(),0,&parent.outputs[0],&signer),input(parent_id.to_string(),1,&parent.outputs[1],&signer)];
    inputs[0].unlocking_script=tbc721_unlocking_descriptor(Tbc721UnlockRecipe {
        parent:TransactionSource::Evidence(0),grandparent:TransactionSource::Evidence(1)})?;
    inputs.extend(funding_inputs(funding,key,&[OutPoint {txid:parent_id,vout:0},OutPoint {txid:parent_id,vout:1}])?);
    let mut outputs=vec![parent.outputs[0].clone(),TxOut {satoshis:100,script_pubkey:scripts::hold_script(recipient)},parent.outputs[2].clone()];
    if let Some((address,amount))=payment {
        if !(24..=MAX_SAFE).contains(&amount) {return Err(invalid("TBC721 accompanying TBC payment must be at least 24 atomic"));}
        outputs.push(TxOut {satoshis:amount,script_pubkey:address.script_pubkey()});
    }
    let (tx,fee,size)=fund("tbc721-standard-transfer",0,inputs,outputs,key,max_fee,Some((parent,grandparent)))?;
    let evidence_table=[parent,grandparent].iter().map(|tx|EvidenceEntry {txid:tx.txid().to_string(),raw_transaction:tx.to_hex()}).collect();
    Ok(NftPlan {unsigned_plan:UnsignedPlan {transactions:vec![tx],evidence_table},fees:vec![fee],maximum_signed_bytes:vec![size]})
}
