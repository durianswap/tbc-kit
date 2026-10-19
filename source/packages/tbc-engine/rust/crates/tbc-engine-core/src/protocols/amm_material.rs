//! Read-only Pool3 material descriptors shared by Engine and Kit loaders.
//! These derive scripts/read dependencies, not unspentness or chain authority.
use tbc_sdk::{Transaction, TxOut, PublicKey, hash};
use crate::{EngineError, ErrorCode};
use super::{amm, amm_code::Authorization, amm_profile, amm_lp, amm_state::PoolConfig,
    tbc20_proof::check_transaction};

pub const PUBLIC_TEMPLATE: &str = "c98ecae0a22452ce37bcaf24be0c836521d3de3a75aa8f16cef587b8b6f031b2";
pub const CONTROLLED_TEMPLATE: &str = "cf7f95c0483b56ad24825591acbce6e82e37890aa0047fc63183d3fb7a7a4ffc";
pub const EXPLICIT_PUBLIC_TEMPLATE: &str = "a821abdb280268430ad7ea7a9421068a719a8e959b84c11265d4456e8d740db7";
pub const EXPLICIT_CONTROLLED_TEMPLATE: &str = "834610c0726fa0829c50aaa75c3a0b58c046105248f0b023257437a22f8aca22";
pub fn template_revision(code:&amm_profile::Code)->&'static str{
    match (code.service_provider_tag.is_some(),matches!(code.authorization,Authorization::Controller(_))) {
        (false,false)=>PUBLIC_TEMPLATE,(false,true)=>CONTROLLED_TEMPLATE,
        (true,false)=>EXPLICIT_PUBLIC_TEMPLATE,(true,true)=>EXPLICIT_CONTROLLED_TEMPLATE,
    }
}
fn invalid(message: &str) -> EngineError {
    EngineError { code: ErrorCode::InvalidAncestry, message: message.into(), path: None }
}
pub struct PoolInspection {
    pub code: amm_profile::Code,
    pub tape: amm_profile::Tape,
    pub code_hash: [u8; 32],
    pub template_revision: &'static str,
}
/// Inspect current or genesis Code/Tape without another transaction or I/O.
pub fn inspect_pool(tx: &Transaction) -> Result<PoolInspection, EngineError> {
    check_transaction(tx)?;
    let code_output = tx.outputs.first().ok_or_else(|| invalid("Pool Code missing"))?;
    inspect_pool_outputs(code_output,tx.outputs.get(1))?
        .ok_or_else(||invalid("Pool full Code invalid"))
}

/// Reuse exact material validation for already authenticated output groups.
/// None is unrecognized, not permission. No synthetic transaction or I/O is
/// needed by the historical-issuance classifier; transaction-level checks still
/// belong to inspect_pool and the execution planner.
pub(crate) fn inspect_pool_outputs(code_output:&TxOut,tape_output:Option<&TxOut>)->Result<Option<PoolInspection>,EngineError> {
    let Ok(code)=amm_profile::Code::decode(code_output.script_pubkey.as_bytes()) else {return Ok(None);};
    let tape_output=tape_output.ok_or_else(||invalid("Pool Tape missing"))?;
    if code_output.satoshis < amm::CODE_DUST || tape_output.satoshis != 0 {
        return Err(invalid("Pool Code/Tape value invalid"));
    }
    let tape = amm_profile::Tape::decode(tape_output.script_pubkey.as_bytes()).map_err(|_| invalid("Pool Tape invalid"))?;
    let controlled = matches!(code.authorization, Authorization::Controller(_));
    if tape.with_swap_hash_lock != controlled || tape.with_lp_hash_lock != controlled {
        return Err(invalid("Pool Code and Tape controller mode differ"));
    }
    amm_profile::Profile::from_parts(&code,&tape).map_err(|_|invalid("Pool fee profile or Code binding invalid"))?;
    let code_hash = hash::sha256(code_output.script_pubkey.as_bytes());
    let lp = amm_lp::instantiate_code(&amm_lp::Code { pool_code_hash: code_hash, tape_size: code.ft_tape_size, controller: [0; 21], timelocked: tape.with_lp_locktime })
        .map_err(|_| invalid("Pool LP profile invalid"))?;
    let identity = amm_lp::code_identity(&lp).map_err(|_| invalid("Pool LP identity invalid"))?;
    if identity[..32] != tape.ft_lp_partial_hash || lp.len() != tape.ft_lp_code_size as usize {
        return Err(invalid("Pool Tape LP identity differs from full Code"));
    }
    super::amm_math::State { ft_lp_amount: tape.ft_lp_amount, ft_a_amount: tape.ft_a_amount,
        tbc_amount: tape.tbc_amount, pool_value: code_output.satoshis }.validate(false).map_err(|_| invalid("Pool reserve state invalid"))?;
    let template_revision=template_revision(&code);
    Ok(Some(PoolInspection { code, tape, code_hash, template_revision }))
}

pub struct PoolGenesis {
    pub config: PoolConfig,
    pub code_hash: [u8; 32],
    pub template_revision: &'static str,
}
/// Current indexed Pool state + indexed underlying FT; no historical replay.
/// The configured API owns the mapping from public pool ID to current output.
pub fn bind_indexed(pool:&Transaction,ft_code:Vec<u8>,ft_tape:Vec<u8>)->Result<PoolGenesis,EngineError>{
    let inspected=inspect_pool(pool)?;
    let id=inspected.tape.ft_a_contract_id.iter().map(|b|format!("{b:02x}")).collect::<String>().parse().map_err(|_|invalid("Pool underlying FT ID invalid"))?;
    let profile=amm_profile::Profile::from_parts(&inspected.code,&inspected.tape).map_err(|_|invalid("Pool fee profile invalid"))?;
    let config=PoolConfig::with_indexed_ft(id,ft_code,ft_tape,inspected.code.authorization.clone(),inspected.tape.with_lp_locktime,profile)?;
    config.read_pool(pool,&inspected.code_hash)?;
    Ok(PoolGenesis{config,code_hash:inspected.code_hash,template_revision:inspected.template_revision})
}
/// Bind genesis to FT identity/config. The caller must separately verify the
/// funding source, indexed availability and network (Engine pool_anchor does).
pub fn bind_genesis(genesis: &Transaction, ft: &Transaction, owner: &PublicKey) -> Result<PoolGenesis, EngineError> {
    if genesis.inputs.len() != 1 || !(4..=5).contains(&genesis.outputs.len()) {
        return Err(invalid("AMM genesis shape invalid"));
    }
    let inspected = inspect_pool(genesis)?;
    if inspected.tape.ft_a_contract_id.iter().map(|b| format!("{b:02x}")).collect::<String>() != ft.txid().to_string() {
        return Err(invalid("Pool underlying FT genesis differs"));
    }
    let profile=amm_profile::Profile::from_parts(&inspected.code,&inspected.tape).map_err(|_|invalid("Pool profile invalid"))?;
    let config = PoolConfig::with_profile(ft, &ft.txid(), inspected.code.authorization.clone(), inspected.tape.with_lp_locktime,profile)?;
    let state = config.read_pool(genesis, &inspected.code_hash)?;
    if state.math().pool_value != 1500 || state.math().ft_lp_amount != 0 || state.math().ft_a_amount != 0 || state.math().tbc_amount != 0 {
        return Err(invalid("AMM genesis reserves must be empty"));
    }
    config.validate_ft(genesis, 2, owner, Some(&state))?;
    let mut original = Vec::new(); genesis.inputs[0].previous_output.serialize(&mut original);
    if inspected.code.original_utxo.as_slice() != original { return Err(invalid("Pool genesis funding anchor differs")); }
    Ok(PoolGenesis { config, code_hash: inspected.code_hash, template_revision: inspected.template_revision })
}
