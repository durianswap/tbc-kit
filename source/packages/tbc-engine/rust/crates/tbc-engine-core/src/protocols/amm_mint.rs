//! New Pool genesis from an explicitly selected, already-finalized funding root.
//! Output construction is keyless; final signatures go through common signing.
use tbc_sdk::{Transaction,PublicKey,hash,script::Script};
use crate::{EngineError,ErrorCode,signing::{UnsignedPlan,PlannedInput,PlannedOutput,PlannedTransaction,materialize_unsigned_preview}};
use super::{amm,amm_state::{PoolConfig,contract_controller},amm_transaction::{self,FeePlan,MinerFeePolicy},
    tbc20,tbc20_proof::check_transaction,tbc20_transfer::public_context};
fn invalid(message:&str)->EngineError{EngineError{code:ErrorCode::InvalidPlan,message:message.into(),path:None}}
fn hex(b:&[u8])->String{b.iter().map(|b|format!("{b:02x}")).collect()}
pub struct MintOptions<'a>{
    pub config:&'a PoolConfig,pub funding_parent:&'a Transaction,pub funding_vout:u32,pub funding_public_key:&'a PublicKey,
    pub change_hash:[u8;20],pub fee_policy:MinerFeePolicy,pub max_fee:u64,
}
pub fn build_mint_plan(options:MintOptions<'_>)->Result<FeePlan,EngineError>{
    check_transaction(options.funding_parent)?;
    let funding=options.funding_parent.outputs.get(options.funding_vout as usize).ok_or_else(||invalid("Pool genesis funding missing"))?;
    if funding.script_pubkey!=Script::p2pkh(&options.funding_public_key.hash160()){return Err(invalid("Pool genesis funding signer does not own exact P2PKH"));}
    let point=tbc_sdk::OutPoint{txid:options.funding_parent.txid(),vout:options.funding_vout};let mut original=Vec::new();point.serialize(&mut original);
    let config=options.config;
    let code=config.pool_code(original.try_into().unwrap())?;
    let pool_hash=hash::sha256(&code);let tape=config.genesis_tape(pool_hash)?.encode().map_err(|_|invalid("Pool genesis Tape invalid"))?;
    let ft_code=tbc20::replace_controller(config.ft_code(),contract_controller(&pool_hash)).map_err(|_|invalid("Pool FT Code invalid"))?;
    let ft_extension=tbc20::parse_tape(config.ft_tape()).map_err(|_|invalid("Pool FT Tape invalid"))?.extension;
    let ft_tape=tbc20::build_tape([0;6],&ft_extension).map_err(|_|invalid("Pool FT zero Tape invalid"))?;
    let outputs=vec![PlannedOutput{satoshis:amm::CODE_DUST,locking_script:hex(&code)},PlannedOutput{satoshis:0,locking_script:hex(&tape)},
        PlannedOutput{satoshis:500,locking_script:hex(&ft_code)},PlannedOutput{satoshis:0,locking_script:hex(&ft_tape)}];
    let available=funding.satoshis.checked_sub(amm::CODE_DUST+500).ok_or_else(||EngineError{code:ErrorCode::InsufficientFunds,message:"Pool genesis funding below asset outputs".into(),path:None})?;
    let make_plan=|with_change:bool|{
        let mut outputs=outputs.clone();if with_change{outputs.push(PlannedOutput{satoshis:options.fee_policy.change_dust,locking_script:hex(Script::p2pkh(&options.change_hash).as_bytes())});}
        Ok(UnsignedPlan{evidence_table:vec![],transactions:vec![PlannedTransaction{transaction_id:"tbc-amm-create".into(),role:"tbc-amm-create".into(),
            stage:0,depends_on:vec![],version:10,lock_time:0,outputs,
            inputs:vec![PlannedInput{previous_transaction_id:point.txid.to_string(),previous_output_index:point.vout,
                previous_output_script:hex(funding.script_pubkey.as_bytes()),previous_output_satoshis:funding.satoshis,
                sequence:tbc_sdk::DEFAULT_SEQUENCE,unlocking_script:String::new(),signer:public_context(options.funding_public_key)}]}]})
    };
    amm_transaction::finish_plan(make_plan,available,options.fee_policy,options.max_fee)
}

#[derive(Debug)]
pub struct FundedMintPlan{pub unsigned_plan:UnsignedPlan,pub fees:[u64;2],pub maximum_signed_bytes:[usize;2]}
/// SDK mintPoolNFT: Source returns the selected funding to its signer; genesis
/// consumes that output only after its real external signature fixes the txid.
pub fn build_funded_mint_plan(options:MintOptions<'_>)->Result<FundedMintPlan,EngineError>{
    check_transaction(options.funding_parent)?;
    let previous=options.funding_parent.outputs.get(options.funding_vout as usize).ok_or_else(||invalid("AMM source funding missing"))?;
    build_funded_mint_from_output(FundedMintOptions{config:options.config,
        funding_outpoint:tbc_sdk::OutPoint{txid:options.funding_parent.txid(),vout:options.funding_vout},funding_output:previous,
        funding_public_key:options.funding_public_key,change_hash:options.change_hash,fee_policy:options.fee_policy,max_fee:options.max_fee})
}
/// Trusted UTXO descriptor entry, like TBC20 mint: P2PKH source signing does not
/// require a full parent transaction. Unspentness is verified by chain data.
pub struct FundedMintOptions<'a>{
    pub config:&'a PoolConfig,pub funding_outpoint:tbc_sdk::OutPoint,pub funding_output:&'a tbc_sdk::TxOut,
    pub funding_public_key:&'a PublicKey,pub change_hash:[u8;20],pub fee_policy:MinerFeePolicy,pub max_fee:u64,
}
pub fn build_funded_mint_from_output(options:FundedMintOptions<'_>)->Result<FundedMintPlan,EngineError>{
    let previous=options.funding_output;
    if previous.satoshis==0||previous.satoshis>9_007_199_254_740_991{return Err(invalid("AMM funding value exceeds safe atomic range"));}
    let owner=Script::p2pkh(&options.funding_public_key.hash160());
    if previous.script_pubkey!=owner{return Err(invalid("AMM source funding not owned by public signer"));}
    let source_id="tbc-amm-source";
    let source=amm_transaction::finish_plan(|with_change|{
        if !with_change{return Err(EngineError{code:ErrorCode::InsufficientFunds,message:"AMM source requires one funding output".into(),path:None});}
        Ok(UnsignedPlan{evidence_table:vec![],transactions:vec![PlannedTransaction{transaction_id:source_id.into(),role:"prerequisite".into(),stage:0,depends_on:vec![],version:10,lock_time:0,
            inputs:vec![PlannedInput{previous_transaction_id:options.funding_outpoint.txid.to_string(),previous_output_index:options.funding_outpoint.vout,
                previous_output_script:hex(owner.as_bytes()),previous_output_satoshis:previous.satoshis,sequence:tbc_sdk::DEFAULT_SEQUENCE,
                signer:public_context(options.funding_public_key),unlocking_script:String::new()}],
            outputs:vec![PlannedOutput{satoshis:options.fee_policy.change_dust,locking_script:hex(owner.as_bytes())}]}]})
    },previous.satoshis,options.fee_policy,options.max_fee)?;
    // Size/layout preview only. Its unsigned txid never leaves the final plan:
    // all dependent identities below become deferred typed output descriptors.
    let preview=materialize_unsigned_preview(&source.unsigned_plan.transactions[0],&source.unsigned_plan)?;
    let remaining_cap=options.max_fee.checked_sub(source.fee).ok_or_else(||EngineError{code:ErrorCode::FeeCapExceeded,message:"AMM total fee cap below source fee".into(),path:None})?;
    let genesis=build_mint_plan(MintOptions{config:options.config,funding_parent:&preview,funding_vout:0,funding_public_key:options.funding_public_key,
        change_hash:options.change_hash,fee_policy:options.fee_policy,max_fee:remaining_cap})?;
    let definition=super::amm_genesis::Definition::from_config(options.config)?;
    let mut tx=genesis.unsigned_plan.transactions.into_iter().next().unwrap();tx.stage=1;tx.depends_on=vec![source_id.into()];tx.inputs[0].previous_transaction_id=source_id.into();
    for part in 0..3{tx.outputs[part].locking_script=super::amm_genesis::descriptor(source_id,part as u8,&definition)?;}
    let mut plan=source.unsigned_plan;plan.transactions.push(tx);
    Ok(FundedMintPlan{unsigned_plan:plan,fees:[source.fee,genesis.fee],maximum_signed_bytes:[source.maximum_signed_bytes,genesis.maximum_signed_bytes]})
}
