//! Pure new Coin issuance, pinned to coinTbc20.ts at af776161.
//! All values are atomic; no HTTP, selection, private keys, approval or storage.
//! The source certificate and mint are signed by the common staged machine.
use std::collections::BTreeMap;
use tbc_sdk::{Address, OutPoint, PublicKey, Transaction, Txid, hash, script::Script};
use crate::{EngineError, ErrorCode, signing::{EvidenceEntry, PlannedInput, PlannedOutput,
    PlannedTransaction, PublicSigningContext, Tbc721UnlockRecipe, TransactionSource,
    UnsignedPlan, maximum_signed_transaction_sizes, tbc721_unlocking_descriptor,
    MAX_SIGNING_PLAN_INPUTS, MAX_SIGNING_PLAN_OUTPUTS}};
use super::{coin, coin_identity::Certificate, covenant_signature::CovenantPublicKey,
    tbc20::MAX_SLOT_AMOUNT, tbc20_material::MAX_MATERIAL_TRANSACTION_BYTES,
    tbc20_mint::fee_for_size, tbc20_transfer::{public_context,FeeInput,intern}, tbc721};

const MAX_SAFE: u64 = 9_007_199_254_740_991;
const DESCRIPTION: &str = "The issuance certificate for the stablecoin, recording cumulative supply and issuance history.";

pub struct CoinDefinition<'a> {
    pub name: &'a str,
    pub symbol: &'a str,
    pub decimals: u8,
    pub initial_amount: u64,
}

pub struct CreateOptions<'a> {
    pub definition: CoinDefinition<'a>,
    pub administrator: &'a [u8; 32],
    pub fee_public_key: &'a PublicKey,
    pub funding: &'a Transaction,
    pub funding_outpoint: OutPoint,
    /// Address hash + 0 or contract hash + 1, as in the pinned SDK.
    pub recipient: [u8; 21],
    pub additional_info: Option<&'a [u8]>,
    /// Total cap across source and mint, not a separate cap per transaction.
    pub max_fee: u64,
}

pub struct MintOptions<'a> {
    pub issuer_id: &'a Txid,
    pub issuer: &'a Transaction,
    pub certificate: &'a Transaction,
    pub grandparent: &'a Transaction,
    /// Bound existing Coin template; immutable metadata/padding is retained.
    pub coin_code: &'a [u8],
    pub coin_tape: &'a [u8],
    pub administrator: &'a [u8;32],
    pub fee_input: &'a FeeInput<'a>,
    pub amount: u64,
    pub recipient: [u8;21],
    pub additional_info: Option<&'a [u8]>,
    pub max_fee: u64,
}

#[derive(Debug)]
pub struct IssuancePlan {
    pub unsigned_plan: UnsignedPlan,
    pub fees: Vec<u64>,
    pub maximum_signed_bytes: Vec<usize>,
}

fn invalid(message: &str) -> EngineError {
    EngineError {code:ErrorCode::InvalidPlan,message:message.into(),path:None}
}
fn insufficient() -> EngineError {
    EngineError {code:ErrorCode::InsufficientFunds,message:"Coin issuance needs complete witness fees and 24 atomic change".into(),path:None}
}
fn hex(bytes:&[u8])->String {bytes.iter().map(|b|format!("{b:02x}")).collect()}
fn output(satoshis:u64,script:Script)->PlannedOutput {
    PlannedOutput {satoshis,locking_script:hex(script.as_bytes())}
}
fn input(id:String,vout:u32,previous:&PlannedOutput,signer:&PublicSigningContext)->PlannedInput {
    PlannedInput {previous_transaction_id:id,previous_output_index:vout,
        previous_output_script:previous.locking_script.clone(),previous_output_satoshis:previous.satoshis,
        sequence:tbc_sdk::DEFAULT_SEQUENCE,unlocking_script:String::new(),signer:signer.clone()}
}
fn certificate_tape(data:&Certificate)->Result<Script,EngineError> {
    let bytes=serde_json::to_vec(data).map_err(|_|invalid("Coin certificate JSON cannot be encoded"))?;
    let mut tape=Script::from_bytes(vec![0,0x6a]);tape.push_data(&bytes);tape.push_data(b"NTape");Ok(tape)
}
pub(crate) fn administrator_context(key:&[u8;32])->Result<PublicSigningContext,EngineError> {
    CovenantPublicKey::parse(key)?;
    let hash=hash::hash160(key);
    Ok(PublicSigningContext {address:Address::from_hash160(hash).to_string(),public_key:hex(key),public_key_hash:hex(&hash)})
}
fn issuance_outputs(code:PlannedOutput,hold:PlannedOutput,certificate:&Certificate,
    coin_code:Vec<u8>,tape:Vec<u8>,additional_info:Option<&[u8]>)->Result<Vec<PlannedOutput>,EngineError> {
    if additional_info.is_some_and(|data|data.len()>MAX_MATERIAL_TRANSACTION_BYTES) {
        return Err(invalid("Coin issuance additional data exceeds byte budget"));
    }
    let mut outputs=vec![code,hold,output(0,certificate_tape(certificate)?),
        output(500,Script::from_bytes(coin_code)),output(0,Script::from_bytes(tape))];
    if let Some(data)=additional_info.filter(|d|!d.is_empty()) {
        let mut script=Script::from_bytes(vec![0,0x6a]);script.push_data(data);outputs.push(output(0,script));
    }
    Ok(outputs)
}
// The SDK uses BigInt for cumulative supply. Do not cap a sequence of legal
// issuances at u64 or round it through floating point; bound work by Tape bytes.
fn add_supply(previous:&str,amount:u64)->Result<String,EngineError> {
    if previous.is_empty() || previous.len()>MAX_MATERIAL_TRANSACTION_BYTES || !previous.bytes().all(|b|b.is_ascii_digit()) {
        return Err(invalid("Coin cumulative supply is not a bounded decimal integer"));
    }
    let mut carry=amount;let mut result=Vec::with_capacity(previous.len()+20);
    for digit in previous.bytes().rev() {
        let sum=u64::from(digit-b'0')+carry%10;carry=carry/10+sum/10;result.push(b'0'+(sum%10)as u8);
    }
    while carry!=0 {result.push(b'0'+(carry%10)as u8);carry/=10;}
    while result.len()>1 && result.last()==Some(&b'0') {result.pop();}
    result.reverse();String::from_utf8(result).map_err(|_|invalid("Coin cumulative supply encoding invalid"))
}
fn native_sum(mut values:impl Iterator<Item=u64>)->Result<u64,EngineError> {
    values.try_fold(0u64,|total,v|total.checked_add(v).filter(|sum|*sum<=MAX_SAFE))
        .ok_or_else(||invalid("Coin issuance native amount exceeds safe integer range"))
}

/// Append mandatory native change, then estimate with the shared witness
/// encoder. The placeholder signatures remain internal size-only material.
pub(crate) fn fund_last(plan:&mut UnsignedPlan,fee_key:&PublicKey,max_fee:u64)->Result<(u64,usize),EngineError> {
    let current=plan.transactions.last_mut().ok_or_else(||invalid("Coin issuance plan empty"))?;
    let available=native_sum(current.inputs.iter().map(|i|i.previous_output_satoshis))?
        .checked_sub(native_sum(current.outputs.iter().map(|o|o.satoshis))?).filter(|v|*v>=104).ok_or_else(insufficient)?;
    current.outputs.push(output(available-80,Script::p2pkh(&fee_key.hash160())));
    let sizes=maximum_signed_transaction_sizes(plan)?;
    let bytes=*sizes.last().ok_or_else(||invalid("Coin issuance size missing"))?;
    if bytes>MAX_MATERIAL_TRANSACTION_BYTES {return Err(invalid("Coin issuance exceeds transaction byte budget"));}
    let fee=fee_for_size(bytes)?;
    let change=available.checked_sub(fee).filter(|v|*v>=24).ok_or_else(insufficient)?;
    if fee>max_fee {return Err(EngineError {code:ErrorCode::FeeCapExceeded,message:"Coin issuance fee exceeds approved total cap".into(),path:None});}
    plan.transactions.last_mut().unwrap().outputs.last_mut().unwrap().satoshis=change;
    Ok((fee,bytes))
}

pub fn build_create_plan(options:CreateOptions<'_>)->Result<IssuancePlan,EngineError> {
    let CreateOptions {definition,administrator,fee_public_key,funding,funding_outpoint,recipient,additional_info,max_fee}=options;
    if definition.decimals>18 || definition.initial_amount==0 || definition.initial_amount>MAX_SLOT_AMOUNT
        || definition.name.len()>61 || definition.symbol.len()>61 || recipient[20]>1 {
        return Err(invalid("Coin definition, atomic supply or recipient is invalid"));
    }
    let admin_hash=hash::hash160(administrator);
    let administrator=administrator_context(administrator)?;
    let fee_signer=public_context(fee_public_key);
    if funding.version!=10 || funding.inputs.is_empty() || funding.inputs.len()>MAX_SIGNING_PLAN_INPUTS
        || funding.outputs.len()>MAX_SIGNING_PLAN_OUTPUTS || funding.serialize().len()>MAX_MATERIAL_TRANSACTION_BYTES
        || funding.txid()!=funding_outpoint.txid {
        return Err(invalid("Coin source funding must match bounded canonical transaction material"));
    }
    let funding_output=funding.outputs.get(funding_outpoint.vout as usize).ok_or_else(||invalid("Coin funding vout missing"))?;
    if funding_output.satoshis==0 || funding_output.satoshis>MAX_SAFE || funding_output.script_pubkey!=Script::p2pkh(&fee_public_key.hash160()) {
        return Err(invalid("Coin funding must be positive owner-controlled P2PKH"));
    }
    if additional_info.is_some_and(|bytes|bytes.len()>MAX_MATERIAL_TRANSACTION_BYTES) {
        return Err(invalid("Coin issuance additional data exceeds byte budget"));
    }
    let mut metadata=Script::empty();metadata.push_data(&[definition.decimals]);
    metadata.push_data(definition.name.as_bytes());metadata.push_data(definition.symbol.as_bytes());
    let tape=coin::build_tape([definition.initial_amount,0,0,0,0,0],coin::MIN_TAPE_BYTES+metadata.as_bytes().len(),0,metadata.as_bytes())
        .map_err(|_|invalid("Coin metadata exceeds the new Tape layout"))?;
    let mut certificate=Certificate {nft_name:format!("{} NFT",definition.name),nft_symbol:format!("{} NFT",definition.symbol),
        description:DESCRIPTION.into(),coin_decimal:definition.decimals,coin_total_supply:"0".into()};
    let issuer_code=Script::from_bytes(tbc721::instantiate_code(&tbc721::CodeDescriptor {original_outpoint:funding_outpoint.clone()}));
    let mut hold=Script::p2pkh(&admin_hash).into_bytes();hold.push(0x6a);
    let mut hold=Script::from_bytes(hold);hold.push_data(format!("For Coin {} NHold",certificate.nft_name).as_bytes());
    let source_id="tbc20-stablecoin-source";
    let source_outputs=vec![output(200,issuer_code.clone()),output(100,hold),output(0,certificate_tape(&certificate)?)];
    let source=PlannedTransaction {transaction_id:source_id.into(),role:source_id.into(),stage:0,depends_on:vec![],
        version:10,lock_time:0,outputs:source_outputs,inputs:vec![input(funding_outpoint.txid.to_string(),funding_outpoint.vout,
            &output(funding_output.satoshis,funding_output.script_pubkey.clone()),&fee_signer)]};
    let mut plan=UnsignedPlan {transactions:vec![source],evidence_table:vec![EvidenceEntry {
        txid:funding.txid().to_string(),raw_transaction:funding.to_hex()}]};
    let (source_fee,source_size)=fund_last(&mut plan,fee_public_key,max_fee)?;
    let source=&plan.transactions[0];
    let mut inputs=vec![input(source_id.into(),0,&source.outputs[0],&administrator),
        input(source_id.into(),1,&source.outputs[1],&administrator),input(source_id.into(),3,&source.outputs[3],&fee_signer)];
    inputs[0].unlocking_script=tbc721_unlocking_descriptor(Tbc721UnlockRecipe {
        parent:TransactionSource::Planned(source_id.into()),grandparent:TransactionSource::Evidence(0)})?;
    certificate.coin_total_supply=definition.initial_amount.to_string();
    let coin_code=coin::instantiate_code(&coin::CodeDescriptor {coin_nft_code_hash:hash::sha256(issuer_code.as_bytes()),
        admin_pubkey_hash:admin_hash,tape_size:tape.len() as u8,controller:recipient}).map_err(|_|invalid("Coin issuance Code invalid"))?;
    let outputs=issuance_outputs(source.outputs[0].clone(),source.outputs[1].clone(),&certificate,coin_code,tape,additional_info)?;
    plan.transactions.push(PlannedTransaction {transaction_id:"tbc20-stablecoin-mint".into(),role:"tbc20-stablecoin-mint".into(),
        stage:1,depends_on:vec![source_id.into()],version:10,lock_time:0,inputs,outputs});
    let (mint_fee,mint_size)=fund_last(&mut plan,fee_public_key,max_fee-source_fee)?;
    Ok(IssuancePlan {unsigned_plan:plan,fees:vec![source_fee,mint_fee],maximum_signed_bytes:vec![source_size,mint_size]})
}

/// Latest TBC721 certificate only. Existing historical issuance builders remain
/// separate and untouched; this function never guesses or changes asset family.
pub fn build_mint_plan(options:MintOptions<'_>)->Result<IssuancePlan,EngineError> {
    let MintOptions {issuer_id,issuer,certificate:parent,grandparent,coin_code,coin_tape,administrator,fee_input,amount,recipient,additional_info,max_fee}=options;
    if amount==0 || amount>MAX_SLOT_AMOUNT || recipient[20]>1 {return Err(invalid("Coin mint amount or recipient invalid"));}
    for tx in [issuer,parent,grandparent] {
        if tx.version!=10 || tx.inputs.is_empty() || tx.inputs.len()>MAX_SIGNING_PLAN_INPUTS || tx.outputs.len()>MAX_SIGNING_PLAN_OUTPUTS
            || tx.serialize().len()>MAX_MATERIAL_TRANSACTION_BYTES {return Err(invalid("Coin issuance material exceeds transaction bounds"));}
    }
    let anchor=super::coin_identity::inspect_issuer(issuer_id,&issuer.serialize())?;
    let admin=administrator_context(administrator)?;
    if hash::hash160(administrator)!=anchor.admin_hash {return Err(invalid("Coin mint administrator differs from issuer"));}
    let code=coin::parse_code(coin_code).map_err(|_|invalid("Coin mint template invalid"))?;
    let tape=coin::parse_tape(coin_tape,Some(code.tape_size as usize)).map_err(|_|invalid("Coin mint Tape invalid"))?;
    let (decimals,name,symbol)=super::coin_identity::metadata_fields(&tape.metadata)?;
    if code.coin_nft_code_hash!=anchor.code_hash || code.admin_pubkey_hash!=anchor.admin_hash
        || decimals!=anchor.decimals || name!=anchor.name || symbol!=anchor.symbol {
        return Err(invalid("Coin mint template and metadata differ from issuer"));
    }
    let mut data=super::coin_identity::certificate(parent)?;
    let mut original=super::coin_identity::certificate(issuer)?;
    original.coin_total_supply=data.coin_total_supply.clone();
    if original!=data || parent.outputs[0]!=issuer.outputs[0] || parent.outputs[1]!=issuer.outputs[1] {
        return Err(invalid("Coin current issuance certificate identity or metadata changed"));
    }
    // Do not silently remove unrecognized certificate fields on reissuance.
    let raw_metadata:serde_json::Value=super::nft_metadata::decode_tape(&parent.outputs[2])?;
    if raw_metadata.as_object().is_none_or(|map|map.len()!=5) {return Err(invalid("Coin certificate has unsupported extra metadata"));}
    let parent_id=parent.txid();
    if (fee_input.outpoint.txid==parent_id && fee_input.outpoint.vout<3)
        || fee_input.output.satoshis==0 || fee_input.output.satoshis>MAX_SAFE
        || fee_input.output.script_pubkey!=Script::p2pkh(&fee_input.public_key.hash160()) {
        return Err(invalid("Coin mint fee must be distinct positive owner-controlled P2PKH"));
    }
    if fee_input.outpoint.txid==parent_id && parent.outputs.get(fee_input.outpoint.vout as usize)!=Some(fee_input.output) {
        return Err(invalid("Coin fee material differs from supplied certificate parent"));
    }
    data.coin_total_supply=add_supply(&data.coin_total_supply,amount)?;
    let mut evidence=Vec::new();let mut ids=BTreeMap::new();
    let parent_source=intern(parent,&mut evidence,&mut ids);let grandparent_source=intern(grandparent,&mut evidence,&mut ids);
    let code_output=output(200,parent.outputs[0].script_pubkey.clone());
    let hold_output=output(100,parent.outputs[1].script_pubkey.clone());
    let mut inputs=vec![input(parent_id.to_string(),0,&code_output,&admin),input(parent_id.to_string(),1,&hold_output,&admin),
        input(fee_input.outpoint.txid.to_string(),fee_input.outpoint.vout,
            &output(fee_input.output.satoshis,fee_input.output.script_pubkey.clone()),&public_context(fee_input.public_key))];
    inputs[0].unlocking_script=tbc721_unlocking_descriptor(Tbc721UnlockRecipe {parent:parent_source,grandparent:grandparent_source})?;
    let new_code=coin::replace_controller(coin_code,recipient).map_err(|_|invalid("Coin mint recipient invalid"))?;
    let new_tape=coin::build_tape([amount,0,0,0,0,0],code.tape_size as usize,0,&tape.metadata).map_err(|_|invalid("Coin mint Tape cannot be encoded"))?;
    let outputs=issuance_outputs(code_output,hold_output,&data,new_code,new_tape,additional_info)?;
    let mut plan=UnsignedPlan {evidence_table:evidence,transactions:vec![PlannedTransaction {
        transaction_id:"tbc20-stablecoin-mint".into(),role:"tbc20-stablecoin-mint".into(),stage:0,depends_on:vec![],
        version:10,lock_time:0,inputs,outputs}]};
    let (fee,size)=fund_last(&mut plan,fee_input.public_key,max_fee)?;
    Ok(IssuancePlan {unsigned_plan:plan,fees:vec![fee],maximum_signed_bytes:vec![size]})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cumulative_supply_does_not_overflow_machine_integer() {
        assert_eq!(add_supply("18446744073709551615",1).unwrap(),"18446744073709551616");
        assert_eq!(add_supply("9999999999999999999999999999999999999999",1).unwrap(),"10000000000000000000000000000000000000000");
        assert_eq!(add_supply("00001000",25).unwrap(),"1025");
        assert_eq!(add_supply("0",MAX_SLOT_AMOUNT).unwrap(),MAX_SLOT_AMOUNT.to_string());
        for bad in ["","-1","1.1","1e3","１"] {assert!(add_supply(bad,1).is_err());}
    }
}
