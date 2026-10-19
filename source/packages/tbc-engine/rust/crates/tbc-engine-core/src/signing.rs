use std::{
    collections::{BTreeMap, BTreeSet},
    io::{self, Write},
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use tbc_sdk::{
    Address, DEFAULT_SIGHASH, OutPoint, PublicKey, Transaction, TxIn,
    TxOut, Txid, UtxoInfo,
    contracts::{
        ft::{
            amount::{balance_from_tape, build_tape_amount},
            partial_sha256::calculate_partial_hash,
            scripts::{FT_CODE_SATOSHIS, transfer_tape_script},
            unlock::classify_ft_script,
        },
        pool_nft_v2::{
            FTLP_CODE_SATOSHIS, FTLP_TAPE_SATOSHIS, FtScriptVersion, FtlpCodeParams,
            FtlpTapeLayout, FtlpTapeParams,
            LockedPoolCodeParams, PoolAmounts, PoolCodeParams, PoolSpendContext, PoolState,
            PoolSwapOption,
            PoolUnlockContext, PoolUnlockOption, PoolUnlockSignature, ftlp_code,
            ftlp_lock_time_code, ftlp_tape, locked_pool_code, pool_code, pool_held_ft_code,
            pool_tape, pool_unlock,
            pool_outputs_data, pool_unlock_requires_signature, pool_unlock_unsigned_body,
            scripts::transfer_ftlp_code_script,
        },
    },
    script::{Script, opcodes},
};

use crate::{EngineError, ErrorCode, families::pool::partial_hash_offset};
use crate::protocols::htlc_transaction::{is_descriptor as is_htlc_descriptor, SpendBranch as HtlcBranch};
use crate::protocols::lop_transaction::CANCEL_DESCRIPTOR as LOP_CANCEL_DESCRIPTOR;

const ALGORITHM: &str = "secp256k1-ecdsa";
const SCRIPT_CLASS: &str = "p2pkh";
const FT_SCRIPT_CLASS: &str = "ft-covenant";
const FT_UNLOCK_PREFIX: &str = "ft1:";
const TBC20_UNLOCK_PREFIX: &str = "tbc20-standard-unlock:";
const COIN_UNLOCK_PREFIX: &str = "tbc20-stablecoin-unlock:";
const AMM_LP_UNLOCK_PREFIX: &str = "tbc20-lp-unlock:";
const AMM_POOL_UNLOCK_PREFIX: &str = "tbc-amm-unlock:";
const LOP_MATCH_UNLOCK_PREFIX: &str = "tbc-lop-match:";
const TBC721_UNLOCK_PREFIX: &str = "tbc721-standard-unlock:";
pub(crate) const TIMELOCK_UNLOCK_DESCRIPTOR: &str = "tbc-timelock-unlock";
const NFT_UNLOCK_PREFIX: &str = "nft1:";
const POOL_UNLOCK_PREFIX: &str = "pool1:";
const POOL_HELD_FT_UNLOCK_PREFIX: &str = "pool-ft1:";
const FTLP_UNLOCK_PREFIX: &str = "ftlp1:";
const FT_MINT_OUTPUT_PREFIX: &str = "ft-mint-v4:";
const POOL_MINT_OUTPUT_PREFIX: &str = "pool-mint-v2:";
const FT_EVIDENCE_OUTPUT_PREFIX: &str = "ft-evidence-output:";
pub const MAX_SIGNING_PLAN_TRANSACTIONS: usize = 1_024;
pub const MAX_SIGNING_PLAN_INPUTS: usize = 4_096;
pub const MAX_SIGNING_PLAN_OUTPUTS: usize = 4_096;
pub const MAX_SIGNING_PLAN_DEPENDENCIES: usize = 4_096;
pub const MAX_EVIDENCE_ENTRIES: usize = 1_024;
pub const MAX_EVIDENCE_REFERENCES: usize = 4_096;
pub const MAX_EVIDENCE_RAW_BYTES: usize = 8_388_608;
pub const MAX_EVIDENCE_ENTRY_RAW_BYTES: usize = 1_048_576;
pub const MAX_UNSIGNED_PLAN_SERIALIZED_BYTES: usize = 4_194_304;
pub const MAX_SIGNING_CONTINUATION_SERIALIZED_BYTES: usize = 8_388_608;
pub const MAX_POOL_AUXILIARY_PARENTS: usize = 10;
pub const MAX_POOL_PUBLIC_KEY_LOCKS: usize = 10;
pub const MAX_POOL_PROOF_REFERENCES: usize = 6;
pub const MAX_POOL_RECIPE_SERIALIZED_BYTES: usize = 4_194_304;
pub const MAX_POOL_RECIPE_RAW_BYTES: usize = 1_048_576;
pub const MAX_POOL_UNLOCKING_SCRIPT_BYTES: usize = 65_535;
pub const MAX_STANDARD_FTLP_INPUTS: usize = 1;
const MAX_LOCKED_FTLP_INPUTS: usize = 6;
const MAX_FTLP_MAINTENANCE_INPUTS: usize = 5;
const MAX_FINAL_POOL_CONSUME_FT_INPUTS: usize = 3;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicSigningContext {
    pub address: String,
    pub public_key: String,
    pub public_key_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase", deny_unknown_fields)]
pub enum TransactionSource {
    Raw(String),
    Evidence(u32),
    Planned(String),
}

pub(crate) type FtTransactionSource = TransactionSource;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceEntry {
    pub txid: String,
    pub raw_transaction: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProofReference {
    pub source: TransactionSource,
    pub output_index: u32,
}

pub(crate) type FtProofReference = ProofReference;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tbc20OutputGroup {
    pub code_vout: u32,
    pub tape_vout: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tbc20ContractControllerReference {
    pub source: TransactionSource,
    pub current_input_index: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tbc20UnlockRecipe {
    pub parent: TransactionSource,
    pub proof_references: Vec<ProofReference>,
    pub output_groups: Vec<Tbc20OutputGroup>,
    pub contract_controller: Option<Tbc20ContractControllerReference>,
}

fn tbc20_recipe_sources(recipe: &Tbc20UnlockRecipe) -> impl Iterator<Item = &TransactionSource> {
    std::iter::once(&recipe.parent)
        .chain(recipe.proof_references.iter().map(|proof| &proof.source))
        .chain(recipe.contract_controller.iter().map(|witness| &witness.source))
}

fn validate_tbc20_recipe(recipe: &Tbc20UnlockRecipe) -> Result<(), EngineError> {
    if recipe.proof_references.len() > 6 || recipe.output_groups.is_empty() || recipe.output_groups.len() > 8 {
        return Err(invalid_plan("TBC20 recipe exceeds the proof or output-group bound"));
    }
    if recipe.contract_controller.as_ref().is_some_and(|witness| witness.current_input_index >= 6) {
        return Err(invalid_plan("TBC20 contract controller input index exceeds five"));
    }
    validate_recipe_sources(tbc20_recipe_sources(recipe))
}

pub fn tbc20_unlocking_descriptor(recipe: Tbc20UnlockRecipe) -> Result<String, EngineError> {
    validate_tbc20_recipe(&recipe)?;
    serialize_recipe(TBC20_UNLOCK_PREFIX, &recipe)
}

/// Coin shares the bounded proof-reference envelope, not TBC20 validation.
/// Its distinct descriptor dispatches to issuer/admin/lock-aware Coin proofs.
pub type CoinUnlockRecipe = Tbc20UnlockRecipe;

pub fn coin_unlocking_descriptor(recipe: CoinUnlockRecipe) -> Result<String, EngineError> {
    validate_tbc20_recipe(&recipe)?;
    serialize_recipe(COIN_UNLOCK_PREFIX, &recipe)
}

/// Same bounded evidence envelope, but strict new LP proof semantics.
pub type AmmLpUnlockRecipe = Tbc20UnlockRecipe;
pub fn amm_lp_unlocking_descriptor(recipe: AmmLpUnlockRecipe) -> Result<String, EngineError> {
    validate_tbc20_recipe(&recipe)?;
    serialize_recipe(AMM_LP_UNLOCK_PREFIX, &recipe)
}

/// Permissionless order covenant branch: no external signature for this input.
#[derive(Clone,Debug,Deserialize,Eq,PartialEq,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct LopMatchUnlockRecipe {pub parent:TransactionSource}
pub fn lop_match_unlocking_descriptor(recipe:LopMatchUnlockRecipe)->Result<String,EngineError>{
    validate_recipe_sources(std::iter::once(&recipe.parent))?;
    serialize_recipe(LOP_MATCH_UNLOCK_PREFIX,&recipe)
}
fn parse_lop_match_recipe(value:&str)->Result<LopMatchUnlockRecipe,EngineError>{
    let recipe:LopMatchUnlockRecipe=parse_pool_recipe(value,LOP_MATCH_UNLOCK_PREFIX,"tbc-lop-match")?;
    validate_recipe_sources(std::iter::once(&recipe.parent))?;Ok(recipe)
}

/// Re-index typed evidence references when combining independently constructed
/// fungible rounds. Planned dependencies are already bound and remain intact.
pub(crate) fn remap_fungible_evidence(value: &str, indices: &std::collections::BTreeMap<u32,u32>) -> Result<String,EngineError> {
    let remap=|source:&mut TransactionSource|->Result<(),EngineError>{
        match source {
            TransactionSource::Evidence(index)=>*index=*indices.get(index).ok_or_else(||invalid_plan("unbound staged evidence index"))?,
            TransactionSource::Planned(_)=>{},
            TransactionSource::Raw(_)=>return Err(invalid_plan("unexpected inline staged evidence")),
        }Ok(())
    };
    if value.starts_with(LOP_MATCH_UNLOCK_PREFIX){
        let mut recipe=parse_lop_match_recipe(value)?;remap(&mut recipe.parent)?;
        return lop_match_unlocking_descriptor(recipe);
    }
    if value.starts_with(AMM_POOL_UNLOCK_PREFIX){
        let mut recipe=parse_amm_pool_unlock_recipe(value)?;
        remap(&mut recipe.parent)?;remap(&mut recipe.ancestor)?;
        for parent in &mut recipe.auxiliary_parents{remap(parent)?;}
        return amm_pool_unlocking_descriptor(recipe);
    }
    let mut recipe=parse_fungible_unlock_recipe(value)?;
    remap(&mut recipe.parent)?;
    for proof in &mut recipe.proof_references{remap(&mut proof.source)?;}
    if let Some(controller)=&mut recipe.contract_controller{remap(&mut controller.source)?;}
    if value.starts_with(AMM_LP_UNLOCK_PREFIX){amm_lp_unlocking_descriptor(recipe)}
    else if value.starts_with(COIN_UNLOCK_PREFIX){coin_unlocking_descriptor(recipe)}
    else{tbc20_unlocking_descriptor(recipe)}
}

/// New Pool active-branch proof. No private keys or legacy Pool ABI fields.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AmmPoolUnlockRecipe {
    pub parent: TransactionSource,
    pub ancestor: TransactionSource,
    pub auxiliary_parents: Vec<TransactionSource>,
    pub operation: u8,
    pub pool_code_hash: String,
}
fn amm_pool_recipe_sources(recipe:&AmmPoolUnlockRecipe)->impl Iterator<Item=&TransactionSource>{
    [&recipe.parent,&recipe.ancestor].into_iter().chain(recipe.auxiliary_parents.iter())
}
fn amm_pool_operation(value:u8)->Result<crate::protocols::amm_pool_proof::Operation,EngineError>{
    use crate::protocols::amm_pool_proof::Operation;
    match value {1=>Ok(Operation::AddLp),2=>Ok(Operation::RemoveLp),3=>Ok(Operation::BuyFt),4=>Ok(Operation::SellFt),
        _=>Err(invalid_plan("New Pool operation must be 1-4"))}
}
fn validate_amm_pool_recipe(recipe:&AmmPoolUnlockRecipe)->Result<(),EngineError>{
    if recipe.auxiliary_parents.len()!=amm_pool_operation(recipe.operation)?.auxiliary_inputs()
        || recipe.pool_code_hash.len()!=64 || !recipe.pool_code_hash.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){
        return Err(invalid_plan("New Pool recipe has invalid identity or auxiliary count"));
    }
    validate_recipe_sources(amm_pool_recipe_sources(recipe))
}
pub fn amm_pool_unlocking_descriptor(recipe:AmmPoolUnlockRecipe)->Result<String,EngineError>{
    validate_amm_pool_recipe(&recipe)?;serialize_recipe(AMM_POOL_UNLOCK_PREFIX,&recipe)
}
fn parse_amm_pool_unlock_recipe(value:&str)->Result<AmmPoolUnlockRecipe,EngineError>{
    let recipe=parse_pool_recipe(value,AMM_POOL_UNLOCK_PREFIX,"tbc-amm")?;validate_amm_pool_recipe(&recipe)?;Ok(recipe)
}

#[cfg(test)]
mod amm_pool_rebinding_tests {
    use super::*;
    #[test]
    fn new_pool_funding_rebinds_only_typed_sources_and_preserves_identity() {
        let raw="00".repeat(32);
        let original=AmmPoolUnlockRecipe{parent:TransactionSource::Raw(raw.clone()),ancestor:TransactionSource::Evidence(7),
            auxiliary_parents:vec![TransactionSource::Evidence(7),TransactionSource::Evidence(8),TransactionSource::Raw(raw.clone())],
            operation:1,pool_code_hash:raw.clone()};
        let encoded=amm_pool_unlocking_descriptor(original.clone()).unwrap();
        let rebound=bind_funding_recipe(&encoded,&raw,&[7],"funding").unwrap();
        let actual=parse_amm_pool_unlock_recipe(&rebound).unwrap();
        assert_eq!(actual.parent,TransactionSource::Planned("funding".into()));
        assert_eq!(actual.ancestor,TransactionSource::Planned("funding".into()));
        assert_eq!(actual.auxiliary_parents,vec![TransactionSource::Planned("funding".into()),TransactionSource::Evidence(8),TransactionSource::Planned("funding".into())]);
        assert_eq!(actual.pool_code_hash,original.pool_code_hash);
        assert_eq!(actual.operation,original.operation);
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tbc721UnlockRecipe {
    pub parent: TransactionSource,
    pub grandparent: TransactionSource,
}

fn tbc721_recipe_sources(recipe: &Tbc721UnlockRecipe) -> impl Iterator<Item = &TransactionSource> {
    [&recipe.parent, &recipe.grandparent].into_iter()
}

pub fn tbc721_unlocking_descriptor(recipe: Tbc721UnlockRecipe) -> Result<String, EngineError> {
    validate_recipe_sources(tbc721_recipe_sources(&recipe))?;
    serialize_recipe(TBC721_UNLOCK_PREFIX, &recipe)
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FtUnlockRecipe {
    parent: FtTransactionSource,
    proof_references: Vec<FtProofReference>,
    coin_mode: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NftUnlockRecipe {
    parent: FtTransactionSource,
    pre_pre: FtTransactionSource,
    version: u8,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PoolRecipeOperation {
    IncreaseLiquidity,
    ConsumeLiquidity,
    Swap,
    MergePoolFt,
}

impl PoolRecipeOperation {
    fn released(self) -> PoolUnlockOption {
        match self {
            Self::IncreaseLiquidity => PoolUnlockOption::IncreaseLiquidity,
            Self::ConsumeLiquidity => PoolUnlockOption::ConsumeLiquidity,
            Self::Swap => PoolUnlockOption::Swap,
            Self::MergePoolFt => PoolUnlockOption::MergePoolFt,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PoolRecipeSwap {
    TbcToFt,
    FtToTbc,
}

impl PoolRecipeSwap {
    fn released(self) -> PoolSwapOption {
        match self {
            Self::TbcToFt => PoolSwapOption::TbcToFt,
            Self::FtToTbc => PoolSwapOption::FtToTbc,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum PoolContractSource {
    Transaction(TransactionSource),
    Indexed(IndexedPoolContract),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndexedPoolContract {
    pub contract_id: String,
    pub code_script: String,
    pub tape_script: String,
}

impl From<TransactionSource> for PoolContractSource {
    fn from(source: TransactionSource) -> Self { Self::Transaction(source) }
}

impl PoolContractSource {
    fn sources(&self) -> impl Iterator<Item = &TransactionSource> {
        match self { Self::Transaction(source) => Some(source), Self::Indexed(_) => None }.into_iter()
    }
    fn source_mut(&mut self) -> Option<&mut TransactionSource> {
        match self { Self::Transaction(source) => Some(source), Self::Indexed(_) => None }
    }
    fn resolve(&self, resolve: impl FnOnce(&TransactionSource) -> Result<Transaction, EngineError>) -> Result<ResolvedPoolContract, EngineError> {
        match self {
            Self::Transaction(source) => Ok(ResolvedPoolContract::Transaction(resolve(source)?)),
            Self::Indexed(index) => Ok(ResolvedPoolContract::Indexed {
                contract_id: parse_txid(&index.contract_id)?,
                code: parse_script(&index.code_script, "indexedPoolFtCode")?,
                tape: parse_script(&index.tape_script, "indexedPoolFtTape")?,
            }),
        }
    }
}

enum ResolvedPoolContract {
    Transaction(Transaction),
    Indexed { contract_id: Txid, code: Script, tape: Script },
}

impl tbc_sdk::contracts::pool_nft_v2::unlock::PoolContractBinding for ResolvedPoolContract {
    fn validate_contract_binding(&self, expected: Txid) -> tbc_sdk::Result<()> {
        match self {
            Self::Transaction(tx) => tx.validate_contract_binding(expected),
            Self::Indexed { contract_id, .. } if *contract_id == expected => Ok(()),
            _ => Err(tbc_sdk::Error::InvalidUtxo("indexed Pool FT identity mismatch".to_owned())),
        }
    }
}

impl ResolvedPoolContract {
    fn pairs(&self, state: &PoolState) -> Result<Vec<(Script, Script)>, EngineError> {
        use tbc_sdk::contracts::pool_nft_v2::unlock::PoolContractBinding;
        self.validate_contract_binding(state.ft_a_contract_id)
            .map_err(|_| invalid_plan("Pool FT authority identity is inconsistent"))?;
        let candidates = match self {
            Self::Indexed { code, tape, .. } => vec![(code.clone(), tape.clone())],
            Self::Transaction(tx) => [(0usize, 1usize), (3, 4)].into_iter().filter_map(|(c,t)| {
                let code=tx.outputs.get(c)?; let tape=tx.outputs.get(t)?;
                let info=classify_ft_script(&code.script_pubkey).ok()?;
                (code.satoshis == FT_CODE_SATOSHIS && tape.satoshis == 0
                    && c == if info.is_coin {3} else {0})
                    .then(|| (code.script_pubkey.clone(),tape.script_pubkey.clone()))
            }).collect(),
        };
        let pairs = candidates.into_iter().filter(|(code,tape)| {
            let Ok(info)=classify_ft_script(code) else {return false};
            let Ok(end)=partial_hash_offset(info.version,info.is_coin) else {return false};
            let Some(partial)=code.as_bytes().get(..end) else {return false};
            let Ok(pushes)=canonical_op_return_pushes(tape) else {return false};
            calculate_partial_hash(partial).as_slice() == state.ft_a_partial_hash.as_slice()
                && pushes.len() == if info.is_coin {6} else {5}
                && pushes.first().is_some_and(|v|v.len()==48)
                && pushes.get(1).is_some_and(|v|v.len()==1 && v[0]<=18)
                && pushes.last().map(Vec::as_slice)==Some(b"FTape")
                && (!info.is_coin || pushes[4].len()==4)
                && String::from_utf8(pushes[2].clone()).is_ok()
                && String::from_utf8(pushes[3].clone()).is_ok()
                && balance_from_tape(tape).is_ok()
        }).collect::<Vec<_>>();
        if pairs.len()!=1 {return Err(invalid_plan("Pool FT authority Code/Tape is invalid"));}
        Ok(pairs)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PoolUnlockRecipe {
    pub parent: TransactionSource,
    pub pre_parent: TransactionSource,
    pub contract: PoolContractSource,
    pub auxiliary_parents: Vec<TransactionSource>,
    pub spent_vout: u32,
    pub operation: PoolRecipeOperation,
    pub swap: Option<PoolRecipeSwap>,
    pub with_lock: bool,
    pub service_provider: String,
    pub public_key_lock: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PoolHeldFtUnlockRecipe {
    pub parent: TransactionSource,
    pub proof_references: Vec<ProofReference>,
    pub contract: TransactionSource,
    pub ft_version: u8,
    pub coin_mode: bool,
    pub logical_swap_input_index: u8,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum FtlpLockMode {
    Standard,
    BlockHeight {
        lock_height: u32,
        current_height: u32,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FtlpUnlockRecipe {
    pub parent: TransactionSource,
    pub proof_references: Vec<ProofReference>,
    pub lock: FtlpLockMode,
    pub ordered_input_index: u8,
    pub ordered_input_count: u8,
}

pub fn pool_unlocking_descriptor(recipe: PoolUnlockRecipe) -> Result<String, EngineError> {
    if recipe.auxiliary_parents.len() > MAX_POOL_AUXILIARY_PARENTS {
        return Err(invalid_plan("Pool recipe exceeds the auxiliary-parent budget"));
    }
    if recipe.public_key_lock.len() > MAX_POOL_PUBLIC_KEY_LOCKS {
        return Err(invalid_plan("Pool recipe exceeds the public-key-lock budget"));
    }
    validate_recipe_sources(
        std::iter::once(&recipe.parent)
            .chain(std::iter::once(&recipe.pre_parent))
            .chain(recipe.contract.sources())
            .chain(recipe.auxiliary_parents.iter()),
    )?;
    serialize_recipe(POOL_UNLOCK_PREFIX, &recipe)
}

pub fn pool_held_ft_unlocking_descriptor(
    recipe: PoolHeldFtUnlockRecipe,
) -> Result<String, EngineError> {
    validate_proof_count(&recipe.proof_references)?;
    validate_recipe_sources(
        std::iter::once(&recipe.parent)
            .chain(std::iter::once(&recipe.contract))
            .chain(recipe.proof_references.iter().map(|proof| &proof.source)),
    )?;
    if !(1..=4).contains(&recipe.ft_version) {
        return Err(invalid_plan("Pool-held FT recipe version is unsupported"));
    }
    if recipe.logical_swap_input_index > 5 {
        return Err(invalid_plan("Pool-held FT logical swap input index exceeds five"));
    }
    serialize_recipe(POOL_HELD_FT_UNLOCK_PREFIX, &recipe)
}

pub fn ftlp_unlocking_descriptor(recipe: FtlpUnlockRecipe) -> Result<String, EngineError> {
    validate_proof_count(&recipe.proof_references)?;
    validate_recipe_sources(
        std::iter::once(&recipe.parent)
            .chain(recipe.proof_references.iter().map(|proof| &proof.source)),
    )?;
    serialize_recipe(FTLP_UNLOCK_PREFIX, &recipe)
}

fn validate_proof_count(proofs: &[ProofReference]) -> Result<(), EngineError> {
    if proofs.is_empty() || proofs.len() > MAX_POOL_PROOF_REFERENCES {
        return Err(invalid_plan(
            "Pool recipe must contain between one and six proof references",
        ));
    }
    Ok(())
}

fn validate_recipe_sources<'a>(
    sources: impl Iterator<Item = &'a TransactionSource>,
) -> Result<(), EngineError> {
    for source in sources {
        match source {
            TransactionSource::Raw(raw) if raw.len() > MAX_POOL_RECIPE_RAW_BYTES * 2 => {
                return Err(invalid_plan("Pool recipe raw source exceeds the byte budget"));
            }
            TransactionSource::Planned(id) if id.is_empty() => {
                return Err(invalid_plan("Pool recipe planned source identifier is empty"));
            }
            _ => {}
        }
    }
    Ok(())
}

fn serialize_recipe<T: Serialize>(prefix: &str, recipe: &T) -> Result<String, EngineError> {
    validate_serialized_budget(
        recipe,
        MAX_POOL_RECIPE_SERIALIZED_BYTES,
        "Pool recipe exceeds the serialized byte budget",
    )?;
    let bytes = serde_json::to_vec(recipe)
        .map_err(|_| internal("could not serialize Pool unlocking recipe"))?;
    Ok(format!("{prefix}{}", encode_hex(&bytes)))
}

pub(crate) fn nft_unlocking_descriptor(
    parent: FtTransactionSource,
    pre_pre: FtTransactionSource,
    version: u8,
) -> Result<String, EngineError> {
    if version > 2 { return Err(invalid_plan("NFT unlocking recipe version is unsupported")); }
    let bytes = serde_json::to_vec(&NftUnlockRecipe { parent, pre_pre, version })
        .map_err(|_| internal("could not serialize NFT unlocking recipe"))?;
    Ok(format!("{NFT_UNLOCK_PREFIX}{}", encode_hex(&bytes)))
}

pub(crate) fn ft_unlocking_descriptor(
    parent: FtTransactionSource,
    proof_references: Vec<FtProofReference>,
    coin_mode: bool,
) -> Result<String, EngineError> {
    let bytes = serde_json::to_vec(&FtUnlockRecipe {
        parent,
        proof_references,
        coin_mode,
    })
    .map_err(|_| internal("could not serialize FT unlocking recipe"))?;
    Ok(format!("{FT_UNLOCK_PREFIX}{}", encode_hex(&bytes)))
}

pub(crate) fn ft_mint_output_descriptor(
    parent_id: &str,
    source_vout: u32,
    address: &str,
    tape_size: usize,
) -> String {
    format!("{FT_MINT_OUTPUT_PREFIX}{parent_id}:{source_vout}:{address}:{tape_size}")
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PoolMintOutputKind {
    Code,
    Tape,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PoolMintOutputDescriptor {
    pub kind: PoolMintOutputKind,
    pub parent_id: String,
    pub source_vout: u32,
    pub service_provider_tag: String,
    pub lp_plan: u8,
    pub ft_version: u8,
    pub is_coin: bool,
    pub public_key_lock: Vec<String>,
    pub lp_cost_address: Option<String>,
    pub lp_cost_sat: Option<u64>,
    pub zero_ftlp_tape: String,
    pub ftlp_receiver: String,
    pub ft_a_partial_hash: Vec<u8>,
    pub ft_a_contract_id: String,
    pub service_fee_rate: u16,
    pub ftlp_lock_time_enabled: bool,
}

pub(crate) fn pool_mint_output_descriptor(
    descriptor: &PoolMintOutputDescriptor,
) -> Result<String, EngineError> {
    serialize_recipe(POOL_MINT_OUTPUT_PREFIX, descriptor)
}

pub(crate) fn ft_evidence_output_descriptor(index: u32, output_index: u32) -> String {
    format!("{FT_EVIDENCE_OUTPUT_PREFIX}{index}:{output_index}")
}

// Rebind only typed transaction-source fields, never arbitrary script bytes.
// A funding prerequisite's preview hash is not its final signed transaction ID.
pub(crate) fn bind_funding_recipe(
    value: &str,
    raw: &str,
    evidence_indexes: &[u32],
    planned_id: &str,
) -> Result<String, EngineError> {
    let replace = |source: &mut TransactionSource| {
        if matches!(source, TransactionSource::Raw(value) if value == raw)
            || matches!(source, TransactionSource::Evidence(index) if evidence_indexes.contains(index))
        {
            *source = TransactionSource::Planned(planned_id.to_owned());
        }
    };
    if value.starts_with(LOP_MATCH_UNLOCK_PREFIX) {
        let mut recipe=parse_lop_match_recipe(value)?;replace(&mut recipe.parent);
        lop_match_unlocking_descriptor(recipe)
    } else if value.starts_with(AMM_POOL_UNLOCK_PREFIX) {
        let mut recipe=parse_amm_pool_unlock_recipe(value)?;
        replace(&mut recipe.parent);replace(&mut recipe.ancestor);
        for source in &mut recipe.auxiliary_parents {replace(source);}
        amm_pool_unlocking_descriptor(recipe)
    } else if is_ecdsa_fungible_recipe(value) || value.starts_with(COIN_UNLOCK_PREFIX) {
        let mut recipe = parse_fungible_unlock_recipe(value)?;
        replace(&mut recipe.parent);
        for proof in &mut recipe.proof_references { replace(&mut proof.source); }
        if let Some(witness) = &mut recipe.contract_controller { replace(&mut witness.source); }
        if value.starts_with(COIN_UNLOCK_PREFIX) { coin_unlocking_descriptor(recipe) }
        else if value.starts_with(AMM_LP_UNLOCK_PREFIX) { amm_lp_unlocking_descriptor(recipe) }
        else { tbc20_unlocking_descriptor(recipe) }
    } else if value.starts_with(TBC721_UNLOCK_PREFIX) {
        let mut recipe = parse_tbc721_unlock_recipe(value)?;
        replace(&mut recipe.parent);
        replace(&mut recipe.grandparent);
        tbc721_unlocking_descriptor(recipe)
    } else if value.starts_with(FT_UNLOCK_PREFIX) {
        let mut recipe = parse_ft_unlock_recipe(value)?;
        replace(&mut recipe.parent);
        for proof in &mut recipe.proof_references { replace(&mut proof.source); }
        ft_unlocking_descriptor(recipe.parent, recipe.proof_references, recipe.coin_mode)
    } else if value.starts_with(NFT_UNLOCK_PREFIX) {
        let mut recipe = parse_nft_unlock_recipe(value)?;
        replace(&mut recipe.parent);
        replace(&mut recipe.pre_pre);
        nft_unlocking_descriptor(recipe.parent, recipe.pre_pre, recipe.version)
    } else if value.starts_with(POOL_UNLOCK_PREFIX) {
        let mut recipe = parse_pool_unlock_recipe(value)?;
        replace(&mut recipe.parent);
        replace(&mut recipe.pre_parent);
        if let Some(source) = recipe.contract.source_mut() { replace(source); }
        for source in &mut recipe.auxiliary_parents { replace(source); }
        pool_unlocking_descriptor(recipe)
    } else if value.starts_with(POOL_HELD_FT_UNLOCK_PREFIX) {
        let mut recipe = parse_pool_held_ft_unlock_recipe(value)?;
        replace(&mut recipe.parent);
        replace(&mut recipe.contract);
        for proof in &mut recipe.proof_references { replace(&mut proof.source); }
        pool_held_ft_unlocking_descriptor(recipe)
    } else if value.starts_with(FTLP_UNLOCK_PREFIX) {
        let mut recipe = parse_ftlp_unlock_recipe(value)?;
        replace(&mut recipe.parent);
        for proof in &mut recipe.proof_references { replace(&mut proof.source); }
        ftlp_unlocking_descriptor(recipe)
    } else {
        Ok(value.to_owned())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedInput {
    pub previous_transaction_id: String,
    pub previous_output_index: u32,
    pub previous_output_script: String,
    pub previous_output_satoshis: u64,
    pub sequence: u32,
    pub unlocking_script: String,
    pub signer: PublicSigningContext,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedOutput {
    pub satoshis: u64,
    pub locking_script: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedTransaction {
    pub transaction_id: String,
    pub role: String,
    pub stage: u32,
    pub depends_on: Vec<String>,
    pub version: i32,
    pub inputs: Vec<PlannedInput>,
    pub outputs: Vec<PlannedOutput>,
    pub lock_time: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsignedPlan {
    pub transactions: Vec<PlannedTransaction>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence_table: Vec<EvidenceEntry>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SigningRequest {
    pub session_id: String,
    pub stage: u32,
    pub stage_commitment: String,
    pub transaction_id: String,
    pub input_index: u32,
    pub algorithm: String,
    pub sighash_type: u32,
    pub digest: String,
    pub public_key: String,
    pub script_class: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSignature {
    pub session_id: String,
    pub stage: u32,
    pub stage_commitment: String,
    pub transaction_id: String,
    pub input_index: u32,
    pub digest: String,
    pub public_key: String,
    pub signature: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedTransaction {
    pub transaction_id: String,
    pub role: String,
    pub txid: String,
    pub raw_transaction: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedBundle {
    pub transactions: Vec<SignedTransaction>,
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
/// Caller-owned incremental signing state.
///
/// This type deliberately does not implement `Clone` and never owns the
/// authoritative unsigned plan.
///
/// ```compile_fail
/// use tbc_engine_core::signing::SigningContinuation;
/// fn requires_clone<T: Clone>() {}
/// requires_clone::<SigningContinuation>();
/// ```
pub struct SigningContinuation {
    pub session_id: String,
    pub plan_commitment: String,
    pub next_stage: u32,
    pub finalized_transactions: Vec<Option<SignedTransaction>>,
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SigningStage {
    pub session_id: String,
    pub stage: u32,
    pub stage_commitment: String,
    pub signing_requests: Vec<SigningRequest>,
    pub continuation: SigningContinuation,
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StageOutcome {
    Pending(SigningStage),
    Complete(SignedBundle),
}

pub trait SigningRequestSink {
    fn request(&mut self, request: SigningRequest) -> Result<(), EngineError>;
}

impl SigningRequestSink for Vec<SigningRequest> {
    fn request(&mut self, request: SigningRequest) -> Result<(), EngineError> {
        self.push(request);
        Ok(())
    }
}

pub fn begin_signing(plan: &UnsignedPlan) -> Result<SigningStage, EngineError> {
    validate_plan(plan)?;
    let session_id = plan_session_id(plan)?;
    build_stage(plan, SigningContinuation {
        plan_commitment: session_id.clone(),
        session_id,
        next_stage: 0,
        finalized_transactions: vec![None; plan.transactions.len()],
    })
}

pub fn finalize_signing_stage(
    plan: &UnsignedPlan,
    stage: SigningStage,
    signatures: &[ExternalSignature],
) -> Result<StageOutcome, EngineError> {
    validate_continuation(plan, &stage.continuation)?;
    let expected_session = plan_session_id(plan)?;
    let expected_commitment = continuation_commitment(&stage.continuation)?;
    if stage.session_id != expected_session
        || stage.continuation.session_id != expected_session
        || stage.stage != stage.continuation.next_stage
        || stage.stage_commitment != expected_commitment
    {
        return Err(invalid_plan(
            "signing continuation session, stage, or commitment is invalid",
        ));
    }

    let expected_requests = build_signing_requests(plan, &stage.continuation, &expected_commitment)?;
    if expected_requests != stage.signing_requests {
        return Err(invalid_plan("signing requests do not match the continuation"));
    }
    if signatures.len() < expected_requests.len() {
        return Err(error(
            ErrorCode::MissingSignature,
            "the current signing stage is missing signatures",
            "signatures",
        ));
    }
    if signatures.len() > expected_requests.len() {
        return Err(invalid_signature("the current signing stage has extra signatures"));
    }

    let mut supplied = BTreeMap::new();
    for signature in signatures {
        if signature.session_id != stage.session_id
            || signature.stage != stage.stage
            || signature.stage_commitment != stage.stage_commitment
        {
            return Err(invalid_plan(
                "signature session, stage, or commitment is out of order",
            ));
        }
        let planned = plan.transactions
            .iter()
            .find(|planned| planned.transaction_id == signature.transaction_id)
            .ok_or_else(|| invalid_signature("signature transaction does not exist in the plan"))?;
        let local_input_index = usize::try_from(signature.input_index)
            .map_err(|_| invalid_signature("signature input index exceeds the local index range"))?;
        if local_input_index >= planned.inputs.len() {
            return Err(invalid_signature("signature input index is out of range"));
        }
        let key = (signature.transaction_id.clone(), signature.input_index);
        if supplied.insert(key, signature).is_some() {
            return Err(invalid_signature("duplicate signature for a signing request"));
        }
    }

    let SigningStage {
        stage: current_stage,
        mut continuation,
        ..
    } = stage;
    for (transaction_index, planned) in plan.transactions.iter().enumerate() {
        if planned.stage != current_stage {
            continue;
        }
        let mut transaction = materialize_transaction(planned, plan, &continuation)?;
        for (input_index, input) in planned.inputs.iter().enumerate() {
            if !input_requires_external_signature(
                &transaction,
                input_index,
                input,
                plan,
                &continuation,
            )? {
                apply_unsigned_recipe(
                    &mut transaction,
                    input_index,
                    input,
                    plan,
                    &continuation,
                )?;
                continue;
            }
            let wire_input_index = u32::try_from(input_index)
                .map_err(|_| invalid_plan("planned input index exceeds the wire range"))?;
            let request = expected_requests
                .iter()
                .find(|request| {
                    request.transaction_id == planned.transaction_id
                        && request.input_index == wire_input_index
                })
                .ok_or_else(|| internal("missing recomputed signing request"))?;
            let signature = supplied
                .get(&(planned.transaction_id.clone(), wire_input_index))
                .ok_or_else(|| {
                    error(
                        ErrorCode::MissingSignature,
                        "signature is missing for a signing request",
                        "signatures",
                    )
                })?;
            if signature.digest != request.digest || signature.public_key != request.public_key {
                return Err(invalid_signature(
                    "signature digest or public key does not match its request",
                ));
            }
            let der = decode_hex(&signature.signature)
                .map_err(|_| invalid_signature("signature is not valid hexadecimal"))?;
            if is_schnorr_context(&input.signer) {
                apply_schnorr_signature(&mut transaction,input_index,input,&der,plan,&continuation,false)?;
                continue;
            }
            let script_code = resolve_previous_output_script(input, plan)?;
            let public_key = parse_public_key(&signature.public_key)?;
            apply_external_signature(
                &mut transaction,
                input_index,
                input,
                &public_key,
                &script_code,
                &der,
                plan,
                &continuation,
            )?;
        }
        continuation.finalized_transactions[transaction_index] = Some(SignedTransaction {
            transaction_id: planned.transaction_id.clone(),
            role: planned.role.clone(),
            txid: transaction.txid().to_string(),
            raw_transaction: transaction.to_hex(),
        });
    }

    if plan.transactions
        .iter()
        .any(|transaction| transaction.stage > current_stage)
    {
        continuation.next_stage = current_stage
            .checked_add(1)
            .ok_or_else(|| internal("signing stage overflow"))?;
        return build_stage(plan, continuation).map(StageOutcome::Pending);
    }

    continuation.next_stage = current_stage
        .checked_add(1)
        .ok_or_else(|| internal("signing stage overflow"))?;
    validate_continuation(plan, &continuation)?;

    let transactions = continuation
        .finalized_transactions
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| internal("signing completed with unfinished transactions"))?;
    Ok(StageOutcome::Complete(SignedBundle { transactions }))
}

pub(crate) fn maximum_signed_transaction_sizes(
    plan: &UnsignedPlan,
) -> Result<Vec<usize>, EngineError> {
    validate_plan(plan)?;
    let session_id = plan_session_id(plan)?;
    let mut continuation = SigningContinuation {
        plan_commitment: session_id.clone(),
        session_id,
        next_stage: 0,
        finalized_transactions: vec![None; plan.transactions.len()],
    };
    let maximum_der = maximum_low_s_der();
    let mut sizes = vec![0usize; plan.transactions.len()];
    let maximum_stage = plan
        .transactions
        .iter()
        .map(|transaction| transaction.stage)
        .max()
        .unwrap_or(0);

    for stage in 0..=maximum_stage {
        continuation.next_stage = stage;
        for (transaction_index, planned) in plan.transactions.iter().enumerate() {
            if planned.stage != stage {
                continue;
            }
            let mut transaction = materialize_transaction(planned, plan, &continuation)?;
            for (input_index, input) in planned.inputs.iter().enumerate() {
                if !input_requires_external_signature(
                    &transaction,
                    input_index,
                    input,
                    plan,
                    &continuation,
                )? {
                    apply_unsigned_recipe(
                        &mut transaction,
                        input_index,
                        input,
                        plan,
                        &continuation,
                    )?;
                    continue;
                }
                if is_schnorr_context(&input.signer) {
                    apply_schnorr_signature(&mut transaction,input_index,input,&[],plan,&continuation,true)?;
                    continue;
                }
                let script_code = resolve_authenticated_signing_script(
                    &transaction,
                    input_index,
                    input,
                    plan,
                    &continuation,
                )?;
                let public_key = validate_signing_recipe_owner(input, plan, &continuation, &script_code)?;
                apply_maximum_external_signature(
                    &mut transaction,
                    input_index,
                    input,
                    &public_key,
                    &maximum_der,
                    plan,
                    &continuation,
                )?;
            }
            sizes[transaction_index] = transaction.serialize().len();
            continuation.finalized_transactions[transaction_index] = Some(SignedTransaction {
                transaction_id: planned.transaction_id.clone(),
                role: planned.role.clone(),
                txid: transaction.txid().to_string(),
                raw_transaction: transaction.to_hex(),
            });
        }
    }
    Ok(sizes)
}

fn maximum_low_s_der() -> Vec<u8> {
    let mut der = vec![0x30, 0x45, 0x02, 0x21, 0x00];
    der.extend_from_slice(&[0x80; 32]);
    der.extend_from_slice(&[0x02, 0x20]);
    der.extend_from_slice(&[0x7f; 32]);
    der
}

#[cfg(test)]
mod schnorr_size_tests {
    use super::*;

    #[test]
    fn xonly_size_uses_fixed_64_byte_body_without_ecdsa_padding() {
        // Public BIP340 generator key; synthetic outpoint, no signing key.
        let key = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
        let hash = tbc_sdk::hash::hash160(&decode_hex(key).unwrap());
        let script = encode_hex(Script::p2pkh(&hash).as_bytes());
        let signer = PublicSigningContext {
            address: Address::from_hash160(hash).to_string(),
            public_key: key.into(), public_key_hash: encode_hex(&hash),
        };
        let plan = UnsignedPlan {
            evidence_table: vec![],
            transactions: vec![PlannedTransaction {
                transaction_id: "schnorr-size".into(), role: "size-test".into(),
                stage: 0, depends_on: vec![], version: 10, lock_time: 0,
                inputs: vec![PlannedInput {
                    previous_transaction_id: "01".repeat(32), previous_output_index: 0,
                    previous_output_script: script.clone(), previous_output_satoshis: 10_000,
                    sequence: u32::MAX, unlocking_script: String::new(), signer,
                }],
                outputs: vec![PlannedOutput { satoshis: 9_000, locking_script: script }],
            }],
        };
        // 10 framing + 36 outpoint + 1 length + (1+65+1+32) script
        // + 4 sequence + (8+1+25) P2PKH output.
        assert_eq!(maximum_signed_transaction_sizes(&plan).unwrap(), vec![184]);
        let stage = begin_signing(&plan).unwrap();
        assert_eq!(stage.signing_requests[0].algorithm, "secp256k1-schnorr");
        assert!(stage.continuation.finalized_transactions.iter().all(Option::is_none));
    }
}

pub fn emit_signing_requests(
    stage: &SigningStage,
    sink: &mut impl SigningRequestSink,
) -> Result<(), EngineError> {
    for request in &stage.signing_requests {
        sink.request(request.clone())?;
    }
    Ok(())
}

fn build_stage(plan: &UnsignedPlan, continuation: SigningContinuation) -> Result<SigningStage, EngineError> {
    validate_continuation(plan, &continuation)?;
    let stage_commitment = continuation_commitment(&continuation)?;
    let signing_requests = build_signing_requests(plan, &continuation, &stage_commitment)?;
    Ok(SigningStage {
        session_id: continuation.session_id.clone(),
        stage: continuation.next_stage,
        stage_commitment,
        signing_requests,
        continuation,
    })
}

fn build_signing_requests(
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
    stage_commitment: &str,
) -> Result<Vec<SigningRequest>, EngineError> {
    let mut signing_requests = Vec::new();
    for planned in &plan.transactions {
        if planned.stage != continuation.next_stage {
            continue;
        }
        let transaction = materialize_transaction(planned, plan, continuation)?;
        for (input_index, input) in planned.inputs.iter().enumerate() {
            if !input_requires_external_signature(
                &transaction,
                input_index,
                input,
                plan,
                continuation,
            )? {
                continue;
            }
            let wire_input_index = u32::try_from(input_index)
                .map_err(|_| invalid_plan("planned input index exceeds the wire range"))?;
            let script_code = resolve_authenticated_signing_script(
                &transaction,
                input_index,
                input,
                plan,
                continuation,
            )?;
            let public_key = if is_schnorr_context(&input.signer) {
                validate_schnorr_context(input,&script_code)?
            } else { validate_signing_recipe_owner(input, plan, continuation, &script_code)?.to_bytes().to_vec() };
            let digest = transaction
                .sighash_digest(
                    input_index,
                    &script_code,
                    input.previous_output_satoshis,
                    DEFAULT_SIGHASH,
                )
                .map_err(|_| invalid_plan("could not derive signing digest"))?;
            signing_requests.request(SigningRequest {
                session_id: continuation.session_id.clone(),
                stage: continuation.next_stage,
                stage_commitment: stage_commitment.to_owned(),
                transaction_id: planned.transaction_id.clone(),
                input_index: wire_input_index,
                algorithm: if is_schnorr_context(&input.signer) {"secp256k1-schnorr"}else{ALGORITHM}.to_owned(),
                sighash_type: DEFAULT_SIGHASH,
                digest: encode_hex(&digest),
                public_key: encode_hex(&public_key),
                script_class: if input.unlocking_script.starts_with(COIN_UNLOCK_PREFIX) {
                    "tbc20-stablecoin".to_owned()
                } else if input.unlocking_script == TIMELOCK_UNLOCK_DESCRIPTOR {
                    "tbc-timelock".to_owned()
                } else if is_htlc_descriptor(&input.unlocking_script) {
                    "tbc-htlc".to_owned()
                } else if input.unlocking_script == LOP_CANCEL_DESCRIPTOR {
                    "tbc-lop".to_owned()
                } else if input.unlocking_script.starts_with(AMM_POOL_UNLOCK_PREFIX) {
                    "tbc-amm".to_owned()
                } else if input.unlocking_script.starts_with(AMM_LP_UNLOCK_PREFIX) {
                    "tbc20-lp".to_owned()
                } else if is_ecdsa_fungible_recipe(&input.unlocking_script) {
                    "tbc20-standard".to_owned()
                } else if input.unlocking_script.starts_with(TBC721_UNLOCK_PREFIX) {
                    "tbc721-standard".to_owned()
                } else if input.unlocking_script.starts_with(POOL_UNLOCK_PREFIX) {
                    "pool-covenant".to_owned()
                } else if input
                    .unlocking_script
                    .starts_with(POOL_HELD_FT_UNLOCK_PREFIX)
                {
                    "pool-held-ft-covenant".to_owned()
                } else if input.unlocking_script.starts_with(FTLP_UNLOCK_PREFIX) {
                    "ftlp-covenant".to_owned()
                } else if input.unlocking_script.starts_with(FT_UNLOCK_PREFIX) {
                    FT_SCRIPT_CLASS.to_owned()
                } else if input.unlocking_script.starts_with(NFT_UNLOCK_PREFIX) {
                    "nft-covenant".to_owned()
                } else {
                    SCRIPT_CLASS.to_owned()
                },
            })?;
        }
    }
    Ok(signing_requests)
}

fn validate_continuation(plan: &UnsignedPlan, continuation: &SigningContinuation) -> Result<(), EngineError> {
    let plan_commitment = plan_session_id(plan)?;
    if continuation.plan_commitment != plan_commitment
        || continuation.session_id != plan_commitment
    {
        return Err(invalid_plan("signing continuation does not bind the authoritative plan"));
    }
    if continuation.finalized_transactions.len() != plan.transactions.len() {
        return Err(invalid_plan(
            "finalized transaction vector length does not match the plan",
        ));
    }
    validate_serialized_budget(
        continuation,
        MAX_SIGNING_CONTINUATION_SERIALIZED_BYTES,
        "signing continuation exceeds the serialized byte budget",
    )?;
    validate_global_input_uniqueness(plan, Some(continuation))?;
    let max_stage = plan.transactions
        .iter()
        .map(|transaction| transaction.stage)
        .max()
        .ok_or_else(|| invalid_plan("unsigned plan has no stages"))?;
    if continuation.next_stage > max_stage.saturating_add(1) {
        return Err(invalid_plan("continuation stage is beyond the plan"));
    }
    for (index, planned) in plan.transactions.iter().enumerate() {
        let should_be_final = planned.stage < continuation.next_stage;
        match (
            should_be_final,
            continuation.finalized_transactions[index].as_ref(),
        ) {
            (true, Some(record)) => validate_finalized_record(
                index,
                planned,
                record,
                plan,
                continuation,
            )?,
            (true, None) => {
                return Err(invalid_plan(
                    "continuation is missing a finalized earlier-stage transaction",
                ));
            }
            (false, Some(_)) => {
                return Err(invalid_plan(
                    "continuation contains a finalized current or future transaction",
                ));
            }
            (false, None) => {}
        }
    }
    Ok(())
}

fn validate_finalized_record(
    transaction_index: usize,
    planned: &PlannedTransaction,
    record: &SignedTransaction,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<(), EngineError> {
    if record.transaction_id != planned.transaction_id || record.role != planned.role {
        return Err(invalid_plan(
            "finalized transaction identity does not match the plan",
        ));
    }
    let transaction = Transaction::from_hex(&record.raw_transaction)
        .map_err(|_| invalid_plan("finalized transaction bytes are malformed"))?;
    if transaction.to_hex() != record.raw_transaction || transaction.txid().to_string() != record.txid {
        return Err(invalid_plan(
            "finalized transaction bytes and transaction id do not match",
        ));
    }
    let expected = materialize_transaction(planned, plan, continuation)?;
    let mut rebuilt = expected.clone();
    if transaction.version != expected.version
        || transaction.lock_time != expected.lock_time
        || transaction.outputs != expected.outputs
        || transaction.inputs.len() != expected.inputs.len()
    {
        return Err(invalid_plan(
            "finalized transaction structure does not match the plan",
        ));
    }
    for (input_index, ((actual, expected), input)) in transaction
        .inputs
        .iter()
        .zip(&expected.inputs)
        .zip(&planned.inputs)
        .enumerate()
    {
        if actual.previous_output != expected.previous_output || actual.sequence != expected.sequence {
            return Err(invalid_plan(
                "finalized transaction input does not match the plan",
            ));
        }
        if input_requires_external_signature(
            &rebuilt,
            input_index,
            input,
            plan,
            continuation,
        )? {
            let der_signature = validate_finalized_input(
                &transaction,
                input_index,
                input,
                plan,
                continuation,
            )?;
            if is_schnorr_context(&input.signer) {
                apply_schnorr_signature(&mut rebuilt,input_index,input,&der_signature,plan,continuation,false)?;
                continue;
            }
            let script_code = resolve_authenticated_signing_script(
                &transaction,
                input_index,
                input,
                plan,
                continuation,
            )?;
            let public_key = validate_signing_recipe_owner(input, plan, continuation, &script_code)?;
            apply_external_signature(
                &mut rebuilt,
                input_index,
                input,
                &public_key,
                &script_code,
                &der_signature,
                plan,
                continuation,
            )
            .map_err(|_| invalid_plan("could not canonically rebuild finalized signature"))?;
        } else {
            apply_unsigned_recipe(&mut rebuilt, input_index, input, plan, continuation)
                .map_err(|_| invalid_plan("could not canonically rebuild unsigned covenant input"))?;
        }
    }
    if rebuilt.to_hex() != record.raw_transaction || rebuilt.txid().to_string() != record.txid {
        return Err(invalid_plan(
            "finalized transaction does not use the canonical unlocking script",
        ));
    }
    if continuation.finalized_transactions[transaction_index]
        .as_ref()
        .map(|candidate| candidate != record)
        .unwrap_or(true)
    {
        return Err(invalid_plan("finalized transaction record is inconsistent"));
    }
    Ok(())
}

fn validate_finalized_input(
    transaction: &Transaction,
    input_index: usize,
    input: &PlannedInput,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<Vec<u8>, EngineError> {
    let script = transaction.inputs[input_index].script_sig.as_bytes();
    if input.unlocking_script.starts_with(AMM_POOL_UNLOCK_PREFIX) {
        let prepared=resolve_amm_pool_prepared(transaction,input_index,input,plan,continuation)?;
        if prepared.controller_public_key().is_none(){return Err(invalid_plan("Public Pool does not have an external signature"));}
        let fields=covenant_script_fields(script,prepared.proof_fields().len())?;
        if fields.len()!=prepared.proof_fields().len()||prepared.finalize(Some(&fields[0]))?.as_bytes()!=script{
            return Err(invalid_plan("Finalized new Pool script differs from bound proof"));
        }
        return Ok(fields[0][..fields[0].len()-1].to_vec());
    }
    if input.unlocking_script.starts_with(COIN_UNLOCK_PREFIX) {
        let fields = covenant_script_fields(script, crate::protocols::coin_proof::UNLOCK_LEAF_COUNT)?;
        if fields.len() != crate::protocols::coin_proof::UNLOCK_LEAF_COUNT {
            return Err(invalid_plan("finalized Coin script must contain exactly 123 leaves"));
        }
        let prepared = resolve_coin_prepared(transaction, input_index, input, plan, continuation)?;
        if fields[99].as_slice() != prepared.public_key()
            || prepared.finalize(&fields[98])?.as_bytes() != script
        { return Err(invalid_plan("finalized Coin script does not match its bound recipe")); }
        return Ok(fields[98][..fields[98].len() - 1].to_vec());
    }
    if input.unlocking_script.starts_with(TBC721_UNLOCK_PREFIX) {
        let fields = covenant_script_fields(script, crate::protocols::tbc721_proof::UNLOCK_LEAF_COUNT)?;
        if fields.len() != crate::protocols::tbc721_proof::UNLOCK_LEAF_COUNT {
            return Err(invalid_plan("finalized TBC721 script must contain exactly 20 leaves"));
        }
        let prepared = resolve_tbc721_prepared(transaction, input_index, input, plan, continuation)?;
        if prepared.finalize(&fields[0])?.as_bytes() != script {
            return Err(invalid_plan("finalized TBC721 script does not match its bound recipe"));
        }
        return Ok(fields[0][..fields[0].len() - 1].to_vec());
    }
    if is_ecdsa_fungible_recipe(&input.unlocking_script) {
        let fields = covenant_script_fields(script, crate::protocols::tbc20_proof::UNLOCK_LEAF_COUNT)?;
        if fields.len() != crate::protocols::tbc20_proof::UNLOCK_LEAF_COUNT {
            return Err(invalid_plan("finalized TBC20 script must contain exactly 123 leaves"));
        }
        let prepared = resolve_ecdsa_fungible_prepared(transaction, input_index, input, plan, continuation)?;
        if fields[99].as_slice() != prepared.public_key() {
            return Err(invalid_plan("finalized TBC20 script has the wrong public key"));
        }
        let expected = prepared.finalize(&fields[98])?;
        if expected.as_bytes() != script {
            return Err(invalid_plan("finalized TBC20 script does not match its bound recipe"));
        }
        return Ok(fields[98][..fields[98].len() - 1].to_vec());
    }
    let owned;
    let signed_portion = if input.unlocking_script == LOP_CANCEL_DESCRIPTOR {
        let (pushes, consumed) = leading_script_pushes(script, 2)?;
        if script.get(consumed..) != Some(&[0x52]) {
            return Err(invalid_plan("Finalized LOP cancellation branch differs from bound plan"));
        }
        owned = canonical_signature_portion(&pushes)?;
        owned.as_slice()
    } else if is_htlc_descriptor(&input.unlocking_script) {
        let (pushes, consumed) = leading_script_pushes(script, 2)?;
        let suffix = HtlcBranch::parse(&input.unlocking_script)?.suffix()?;
        if script.get(consumed..) != Some(suffix.as_slice()) {
            return Err(invalid_plan("Finalized HTLC branch differs from bound plan"));
        }
        owned = canonical_signature_portion(&pushes)?;
        owned.as_slice()
    } else if input.unlocking_script.starts_with(POOL_UNLOCK_PREFIX) {
        let (pushes, consumed) = leading_script_pushes(script, 2)?;
        if consumed >= script.len() {
            return Err(invalid_plan("finalized Pool unlocking script is missing covenant data"));
        }
        owned = canonical_signature_portion(&pushes)?;
        owned.as_slice()
    } else if input.unlocking_script.starts_with(POOL_HELD_FT_UNLOCK_PREFIX) {
        let recipe = parse_pool_held_ft_unlock_recipe(&input.unlocking_script)?;
        let prefix = pool_held_ft_unlock_prefix(
            transaction,
            input_index,
            input,
            &recipe,
            plan,
            continuation,
        )?;
        let suffix = pool_held_ft_unlock_suffix(
            transaction,
            input_index,
            input,
            &recipe,
            plan,
            continuation,
        )?;
        if !script.starts_with(&prefix)
            || !script.ends_with(&suffix)
            || script.len() < prefix.len() + suffix.len()
        {
            return Err(invalid_plan(
                "finalized Pool-held FT unlocking script does not match its recipe",
            ));
        }
        owned = script[prefix.len()..script.len() - suffix.len()].to_vec();
        owned.as_slice()
    } else if input.unlocking_script.starts_with(FTLP_UNLOCK_PREFIX) {
        let recipe = parse_ftlp_unlock_recipe(&input.unlocking_script)?;
        let prefix = ftlp_unlock_prefix(
            transaction,
            input_index,
            input,
            &recipe,
            plan,
            continuation,
        )?;
        let suffix = ftlp_unlock_suffix(input, &recipe, plan, continuation)?;
        if !script.starts_with(&prefix)
            || !script.ends_with(&suffix)
            || script.len() < prefix.len() + suffix.len()
        {
            return Err(invalid_plan(
                "finalized FTLP unlocking script does not match its recipe",
            ));
        }
        owned = script[prefix.len()..script.len() - suffix.len()].to_vec();
        owned.as_slice()
    } else if input.unlocking_script.starts_with(FT_UNLOCK_PREFIX) {
        let recipe = parse_ft_unlock_recipe(&input.unlocking_script)?;
        let prefix = ft_unlock_prefix(transaction, input_index, input, &recipe, plan, continuation)?;
        let suffix = ft_unlock_suffix(input, &recipe, plan, continuation)?;
        if !script.starts_with(&prefix)
            || !script.ends_with(&suffix)
            || script.len() < prefix.len() + suffix.len()
        {
            return Err(invalid_plan(
                "finalized FT unlocking script does not match its ancestry recipe",
            ));
        }
        owned = script[prefix.len()..script.len() - suffix.len()].to_vec();
        owned.as_slice()
    } else if input.unlocking_script.starts_with(NFT_UNLOCK_PREFIX) {
        let recipe = parse_nft_unlock_recipe(&input.unlocking_script)?;
        let suffix = nft_unlock_suffix(transaction, input, &recipe, plan, continuation)?;
        if !script.ends_with(&suffix) || script.len() < suffix.len() { return Err(invalid_plan("finalized NFT unlocking script does not match its ancestry recipe")); }
        owned = script[..script.len() - suffix.len()].to_vec();
        owned.as_slice()
    } else {
        script
    };
    let pushes = script_pushes(signed_portion)?;
    if pushes.len() != 2 {
        return Err(invalid_plan(
            "finalized P2PKH unlocking script must contain signature and public key",
        ));
    }
    let (sighash_byte, der_signature) = pushes[0]
        .split_last()
        .ok_or_else(|| invalid_plan("finalized signature is empty"))?;
    if *sighash_byte != (DEFAULT_SIGHASH & 0xff) as u8 {
        return Err(invalid_plan("finalized signature has the wrong sighash type"));
    }
    let script_code = resolve_authenticated_signing_script(
        transaction,
        input_index,
        input,
        plan,
        continuation,
    )?;
    if is_schnorr_context(&input.signer) {
        let key=validate_schnorr_context(input,&script_code)?;
        if pushes[1]!=key.as_slice() {return Err(invalid_plan("Schnorr unlocking public key differs"));}
        let digest=transaction.sighash_digest(input_index,&script_code,input.previous_output_satoshis,DEFAULT_SIGHASH)
            .map_err(|_|invalid_plan("Schnorr finalized digest invalid"))?;
        crate::protocols::covenant_signature::CovenantPublicKey::parse(&key)?.verify_transaction_signature(&digest,pushes[0])?;
        return Ok(der_signature.to_vec());
    }
    let public_key = validate_signing_recipe_owner(input, plan, continuation, &script_code)?;
    if pushes[1] != public_key.to_bytes() {
        return Err(invalid_plan(
            "finalized unlocking script has the wrong public key",
        ));
    }
    let digest = transaction
        .sighash_digest(
            input_index,
            &script_code,
            input.previous_output_satoshis,
            DEFAULT_SIGHASH,
        )
        .map_err(|_| invalid_plan("could not rederive finalized signature digest"))?;
    if !tbc_sdk::sighash::verify_low_s_ecdsa(&public_key, &digest, der_signature)
        .map_err(|_| invalid_plan("finalized signature encoding is invalid"))?
    {
        return Err(invalid_plan(
            "finalized signature is high-S or cryptographically invalid",
        ));
    }
    Ok(der_signature.to_vec())
}

fn canonical_signature_portion(pushes: &[&[u8]]) -> Result<Vec<u8>, EngineError> {
    if pushes.len() != 2 {
        return Err(invalid_plan("Pool signature prefix must contain two pushes"));
    }
    let mut bytes = Vec::new();
    push_script_data(&mut bytes, pushes[0])?;
    push_script_data(&mut bytes, pushes[1])?;
    Ok(bytes)
}

#[allow(clippy::too_many_arguments)]
fn apply_external_signature(
    transaction: &mut Transaction,
    input_index: usize,
    input: &PlannedInput,
    public_key: &PublicKey,
    script_code: &Script,
    der: &[u8],
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<(), EngineError> {
    if is_ecdsa_fungible_recipe(&input.unlocking_script) || input.unlocking_script.starts_with(COIN_UNLOCK_PREFIX) || input.unlocking_script.starts_with(AMM_POOL_UNLOCK_PREFIX) {
        // These prepared paths perform their own digest-bound low-S verification.
        return apply_external_signature_bytes(transaction, input_index, input, public_key, der, plan, continuation);
    }
    let digest = transaction
        .sighash_digest(
            input_index,
            script_code,
            input.previous_output_satoshis,
            DEFAULT_SIGHASH,
        )
        .map_err(|_| invalid_signature("could not derive signature digest"))?;
    if !tbc_sdk::sighash::verify_low_s_ecdsa(public_key, &digest, der)
        .map_err(|_| invalid_signature("signature encoding is invalid"))?
    {
        return Err(invalid_signature(
            "signature is malformed, high-S, or cryptographically invalid",
        ));
    }
    apply_external_signature_bytes(
        transaction,
        input_index,
        input,
        public_key,
        der,
        plan,
        continuation,
    )
}

fn apply_external_signature_bytes(
    transaction: &mut Transaction,
    input_index: usize,
    input: &PlannedInput,
    public_key: &PublicKey,
    der: &[u8],
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<(), EngineError> {
    if input.unlocking_script.starts_with(AMM_POOL_UNLOCK_PREFIX) {
        let prepared=resolve_amm_pool_prepared(transaction,input_index,input,plan,continuation)?;
        if prepared.controller_public_key()!=Some(public_key.to_bytes().as_slice()){
            return Err(invalid_signature("New Pool external controller differs from bound signer"));
        }
        let mut signature=der.to_vec();signature.push(DEFAULT_SIGHASH as u8);
        return set_bounded_unlocking_script(transaction,input_index,prepared.finalize(Some(&signature))?.into_bytes());
    }
    if input.unlocking_script.starts_with(COIN_UNLOCK_PREFIX) {
        let prepared = resolve_coin_prepared(transaction, input_index, input, plan, continuation)?;
        if prepared.public_key() != &public_key.to_bytes() {
            return Err(invalid_signature("Coin external signer differs from the recipe signer"));
        }
        let mut signature = der.to_vec(); signature.push(DEFAULT_SIGHASH as u8);
        return set_bounded_unlocking_script(transaction, input_index, prepared.finalize(&signature)?.into_bytes());
    }
    if input.unlocking_script.starts_with(TBC721_UNLOCK_PREFIX) {
        let prepared = resolve_tbc721_prepared(transaction, input_index, input, plan, continuation)?;
        if prepared.public_key() != &public_key.to_bytes() {
            return Err(invalid_signature("TBC721 external signer differs from the recipe signer"));
        }
        let mut signature = der.to_vec(); signature.push(DEFAULT_SIGHASH as u8);
        return set_bounded_unlocking_script(transaction, input_index, prepared.finalize(&signature)?.into_bytes());
    }
    if is_ecdsa_fungible_recipe(&input.unlocking_script) {
        let prepared = resolve_ecdsa_fungible_prepared(transaction, input_index, input, plan, continuation)?;
        if prepared.public_key() != &public_key.to_bytes() {
            return Err(invalid_signature("TBC20 external signer differs from the recipe signer"));
        }
        let mut signature = der.to_vec(); signature.push(DEFAULT_SIGHASH as u8);
        let script = prepared.finalize(&signature)?;
        return set_bounded_unlocking_script(transaction, input_index, script.into_bytes());
    }
    if input.unlocking_script.starts_with(POOL_UNLOCK_PREFIX) {
        let recipe = parse_pool_unlock_recipe(&input.unlocking_script)?;
        let mut signature = der.to_vec();
        signature.push((DEFAULT_SIGHASH & 0xff) as u8);
        let script = pool_unlock_script(
            transaction,
            input_index,
            input,
            &recipe,
            Some((&signature, public_key)),
            plan,
            continuation,
        )?;
        return set_bounded_unlocking_script(transaction, input_index, script);
    }
    if input.unlocking_script.starts_with(POOL_HELD_FT_UNLOCK_PREFIX) {
        let recipe = parse_pool_held_ft_unlock_recipe(&input.unlocking_script)?;
        let mut script = pool_held_ft_unlock_prefix(
            transaction,
            input_index,
            input,
            &recipe,
            plan,
            continuation,
        )?;
        append_external_signature(&mut script, der, public_key)?;
        script.extend_from_slice(&pool_held_ft_unlock_suffix(
            transaction,
            input_index,
            input,
            &recipe,
            plan,
            continuation,
        )?);
        return set_bounded_unlocking_script(transaction, input_index, script);
    }
    if input.unlocking_script.starts_with(FTLP_UNLOCK_PREFIX) {
        let recipe = parse_ftlp_unlock_recipe(&input.unlocking_script)?;
        let mut script = ftlp_unlock_prefix(
            transaction,
            input_index,
            input,
            &recipe,
            plan,
            continuation,
        )?;
        append_external_signature(&mut script, der, public_key)?;
        script.extend_from_slice(&ftlp_unlock_suffix(input, &recipe, plan, continuation)?);
        return set_bounded_unlocking_script(transaction, input_index, script);
    }
    if input.unlocking_script.starts_with(FT_UNLOCK_PREFIX) {
        let recipe = parse_ft_unlock_recipe(&input.unlocking_script)?;
        let mut script = ft_unlock_prefix(
            transaction,
            input_index,
            input,
            &recipe,
            plan,
            continuation,
        )?;
        let mut signature = der.to_vec();
        signature.push((DEFAULT_SIGHASH & 0xff) as u8);
        push_script_data(&mut script, &signature)?;
        push_script_data(&mut script, &public_key.to_bytes())?;
        script.extend_from_slice(&ft_unlock_suffix(input, &recipe, plan, continuation)?);
        transaction.inputs[input_index].script_sig = Script::from_bytes(script);
        return Ok(());
    }
    if input.unlocking_script.starts_with(NFT_UNLOCK_PREFIX) {
        let recipe = parse_nft_unlock_recipe(&input.unlocking_script)?;
        let mut script = Vec::new();
        let mut signature = der.to_vec();
        signature.push((DEFAULT_SIGHASH & 0xff) as u8);
        push_script_data(&mut script, &signature)?;
        push_script_data(&mut script, &public_key.to_bytes())?;
        script.extend_from_slice(&nft_unlock_suffix(transaction, input, &recipe, plan, continuation)?);
        transaction.inputs[input_index].script_sig = Script::from_bytes(script);
        return Ok(());
    }
    let mut script = Vec::new();
    append_external_signature(&mut script, der, public_key)?;
    if input.unlocking_script == LOP_CANCEL_DESCRIPTOR {
        script.push(0x52);
        return set_bounded_unlocking_script(transaction, input_index, script);
    }
    if is_htlc_descriptor(&input.unlocking_script) {
        script.extend_from_slice(&HtlcBranch::parse(&input.unlocking_script)?.suffix()?);
        return set_bounded_unlocking_script(transaction, input_index, script);
    }
    transaction.inputs[input_index].script_sig = Script::from_bytes(script);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn apply_maximum_external_signature(
    transaction: &mut Transaction,
    input_index: usize,
    input: &PlannedInput,
    public_key: &PublicKey,
    der: &[u8],
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<(), EngineError> {
    if input.unlocking_script.starts_with(AMM_POOL_UNLOCK_PREFIX) {
        let prepared=resolve_amm_pool_prepared(transaction,input_index,input,plan,continuation)?;
        return set_bounded_unlocking_script(transaction,input_index,vec![0;prepared.max_unlocking_script_bytes()]);
    }
    if input.unlocking_script.starts_with(COIN_UNLOCK_PREFIX) {
        let prepared = resolve_coin_prepared(transaction, input_index, input, plan, continuation)?;
        return set_bounded_unlocking_script(transaction, input_index,
            vec![0; prepared.max_unlocking_script_bytes()]);
    }
    if input.unlocking_script.starts_with(TBC721_UNLOCK_PREFIX) {
        let prepared = resolve_tbc721_prepared(transaction, input_index, input, plan, continuation)?;
        return set_bounded_unlocking_script(transaction, input_index,
            vec![0; prepared.max_unlocking_script_bytes()]);
    }
    if is_ecdsa_fungible_recipe(&input.unlocking_script) {
        let prepared = resolve_ecdsa_fungible_prepared(transaction, input_index, input, plan, continuation)?;
        // This private sizing traversal never exports these bytes or treats them
        // as a valid signature. Equal-width placeholders preserve dependent sizes.
        return set_bounded_unlocking_script(transaction, input_index,
            vec![0; prepared.max_unlocking_script_bytes()]);
    }
    if !input.unlocking_script.starts_with(POOL_UNLOCK_PREFIX) {
        return apply_external_signature_bytes(
            transaction,
            input_index,
            input,
            public_key,
            der,
            plan,
            continuation,
        );
    }
    let recipe = parse_pool_unlock_recipe(&input.unlocking_script)?;
    let mut body = pool_unlock_unsigned_script(
        transaction,
        input_index,
        input,
        &recipe,
        plan,
        continuation,
    )?;
    let mut signature = der.to_vec();
    signature.push((DEFAULT_SIGHASH & 0xff) as u8);
    let mut script = Vec::new();
    push_script_data(&mut script, &signature)?;
    push_script_data(&mut script, &public_key.to_bytes())?;
    script.append(&mut body);
    set_bounded_unlocking_script(transaction, input_index, script)
}

fn append_external_signature(
    script: &mut Vec<u8>,
    der: &[u8],
    public_key: &PublicKey,
) -> Result<(), EngineError> {
    let mut signature = der.to_vec();
    signature.push((DEFAULT_SIGHASH & 0xff) as u8);
    push_script_data(script, &signature)?;
    push_script_data(script, &public_key.to_bytes())
}

fn set_bounded_unlocking_script(
    transaction: &mut Transaction,
    input_index: usize,
    script: Vec<u8>,
) -> Result<(), EngineError> {
    if script.len() > MAX_POOL_UNLOCKING_SCRIPT_BYTES {
        return Err(invalid_plan("Pool unlocking script exceeds the byte budget"));
    }
    transaction.inputs[input_index].script_sig = Script::from_bytes(script);
    Ok(())
}

fn apply_unsigned_recipe(
    transaction: &mut Transaction,
    input_index: usize,
    input: &PlannedInput,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<(), EngineError> {
    if input.unlocking_script.starts_with(LOP_MATCH_UNLOCK_PREFIX) {
        let script=resolve_lop_match_script(transaction,input_index,input,plan,continuation)?;
        return set_bounded_unlocking_script(transaction,input_index,script.into_bytes());
    }
    if input.unlocking_script.starts_with(AMM_POOL_UNLOCK_PREFIX) {
        let prepared=resolve_amm_pool_prepared(transaction,input_index,input,plan,continuation)?;
        return set_bounded_unlocking_script(transaction,input_index,prepared.finalize(None)?.into_bytes());
    }
    if !input.unlocking_script.starts_with(POOL_UNLOCK_PREFIX) {
        return Err(invalid_plan("only released Pool Code may use an unsigned recipe"));
    }
    let recipe = parse_pool_unlock_recipe(&input.unlocking_script)?;
    let script = pool_unlock_script(
        transaction,
        input_index,
        input,
        &recipe,
        None,
        plan,
        continuation,
    )?;
    set_bounded_unlocking_script(transaction, input_index, script)
}

fn parse_ft_unlock_recipe(value: &str) -> Result<FtUnlockRecipe, EngineError> {
    let encoded = value
        .strip_prefix(FT_UNLOCK_PREFIX)
        .ok_or_else(|| invalid_plan("FT unlocking descriptor prefix is invalid"))?;
    let bytes = decode_hex(encoded)
        .map_err(|_| invalid_plan("FT unlocking descriptor is not hexadecimal"))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| invalid_plan("FT unlocking descriptor payload is invalid"))
}

fn parse_tbc721_unlock_recipe(value: &str) -> Result<Tbc721UnlockRecipe, EngineError> {
    let recipe = parse_pool_recipe(value, TBC721_UNLOCK_PREFIX, "TBC721")?;
    validate_recipe_sources(tbc721_recipe_sources(&recipe))?;
    Ok(recipe)
}

fn resolve_tbc721_prepared(
    transaction: &Transaction,
    input_index: usize,
    input: &PlannedInput,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<crate::protocols::tbc721_proof::PreparedUnlock, EngineError> {
    use crate::protocols::tbc721_proof;
    if input_index != 0 || input.previous_output_index != 0 {
        return Err(invalid_plan("TBC721 Code must use input zero and parent output zero"));
    }
    let recipe = parse_tbc721_unlock_recipe(&input.unlocking_script)?;
    let parent = resolve_source(&recipe.parent, plan, continuation)?;
    let grandparent = resolve_source(&recipe.grandparent, plan, continuation)?;
    let previous = parent.outputs.first().ok_or_else(|| invalid_plan("TBC721 parent output is missing"))?;
    if previous.satoshis != input.previous_output_satoshis
        || previous.script_pubkey != resolve_previous_output_script(input, plan)?
    { return Err(invalid_plan("TBC721 recipe does not bind the planned previous output")); }
    let public_key = validated_signer_bytes(&input.signer)?;
    tbc721_proof::prepare_unlock(tbc721_proof::UnlockOptions {
        current_tx: transaction, parent_tx: &parent, grandparent_tx: &grandparent, public_key: &public_key,
    })
}

pub(crate) fn parse_tbc20_unlock_recipe(value: &str) -> Result<Tbc20UnlockRecipe, EngineError> {
    let recipe = parse_pool_recipe(value, TBC20_UNLOCK_PREFIX, "TBC20")?;
    validate_tbc20_recipe(&recipe)?;
    Ok(recipe)
}

fn parse_fungible_unlock_recipe(value: &str) -> Result<Tbc20UnlockRecipe, EngineError> {
    if value.starts_with(AMM_LP_UNLOCK_PREFIX) {
        let recipe=parse_pool_recipe(value,AMM_LP_UNLOCK_PREFIX,"tbc20-lp")?;
        validate_tbc20_recipe(&recipe)?;return Ok(recipe);
    }
    if !value.starts_with(COIN_UNLOCK_PREFIX) { return parse_tbc20_unlock_recipe(value); }
    let recipe = parse_pool_recipe(value, COIN_UNLOCK_PREFIX, "Coin")?;
    validate_tbc20_recipe(&recipe)?;
    Ok(recipe)
}

fn resolve_coin_prepared(
    transaction: &Transaction,
    input_index: usize,
    input: &PlannedInput,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<crate::protocols::coin_proof::PreparedUnlock, EngineError> {
    use crate::protocols::coin_proof;
    let recipe = parse_fungible_unlock_recipe(&input.unlocking_script)?;
    let parent_tx = resolve_source(&recipe.parent, plan, continuation)?;
    let current_input = transaction.inputs.get(input_index)
        .ok_or_else(|| invalid_plan("Coin recipe current input is missing"))?;
    let previous = parent_tx.outputs.get(input.previous_output_index as usize)
        .ok_or_else(|| invalid_plan("Coin recipe parent output is missing"))?;
    if current_input.previous_output.txid != parent_tx.txid()
        || current_input.previous_output.vout != input.previous_output_index
        || previous.satoshis != input.previous_output_satoshis
        || previous.script_pubkey != resolve_previous_output_script(input, plan)?
    { return Err(invalid_plan("Coin recipe parent does not bind the planned previous output")); }
    let parent = coin_proof::inspect_parent(&parent_tx.serialize(), &current_input.previous_output, None)?;
    let required = parent.dependencies().iter().map(|point| (point.txid.to_string(), point.vout)).collect();
    let unique_raws = resolve_fungible_proof_sources(&recipe, &required, plan, continuation)?;
    let ancestor_raws: Vec<_> = unique_raws.values().map(Vec::as_slice).collect();
    let controller_tx = recipe.contract_controller.as_ref()
        .map(|witness| resolve_source(&witness.source, plan, continuation)).transpose()?;
    let controller = recipe.contract_controller.as_ref().zip(controller_tx.as_ref())
        .map(|(reference, tx)| coin_proof::ContractControllerWitness {
            transaction: tx, current_input_index: reference.current_input_index as usize,
        });
    let groups: Vec<_> = recipe.output_groups.iter().map(|group| coin_proof::OutputGroup {
        code_vout: group.code_vout as usize, tape_vout: group.tape_vout.map(|index| index as usize),
    }).collect();
    let public_key = validated_signer_bytes(&input.signer)?;
    coin_proof::prepare_unlock(coin_proof::UnlockOptions {
        current_tx: transaction, input_index, parent: &parent, ancestor_raws: &ancestor_raws,
        output_groups: &groups, public_key: &public_key, contract_controller: controller,
    })
}

fn resolve_amm_pool_prepared(
    transaction:&Transaction,input_index:usize,input:&PlannedInput,plan:&UnsignedPlan,continuation:&SigningContinuation,
)->Result<crate::protocols::amm_pool_proof::PreparedUnlock,EngineError>{
    use crate::protocols::{amm_code,amm_pool_proof as proof};
    if input_index!=0||input.previous_output_index!=0{return Err(invalid_plan("New Pool Code must occupy input/output zero"));}
    let recipe=parse_amm_pool_unlock_recipe(&input.unlocking_script)?;
    // A parent may supply both Pool Code, Pool FT and funding. Resolve each
    // Evidence/Planned source once here, then borrow its immutable transaction.
    let mut sources:Vec<(&TransactionSource,Transaction)>=Vec::new();
    for source in amm_pool_recipe_sources(&recipe){
        if !sources.iter().any(|(key,_)|*key==source){sources.push((source,resolve_source(source,plan,continuation)?));}
    }
    let get=|source:&TransactionSource|->&Transaction{&sources.iter().find(|(key,_)|*key==source).expect("validated source").1};
    let parent=get(&recipe.parent);let previous=parent.outputs.first().ok_or_else(||invalid_plan("New Pool parent Code missing"))?;
    if previous.satoshis!=input.previous_output_satoshis||previous.script_pubkey!=resolve_previous_output_script(input,plan)?{
        return Err(invalid_plan("New Pool planned previous output differs from authenticated parent"));
    }
    let profile=crate::protocols::amm_profile::Code::decode(previous.script_pubkey.as_bytes()).map_err(|_|invalid_plan("New Pool template invalid"))?;
    let key=validate_public_identity(&input.signer)?.to_bytes();
    let controller=matches!(profile.authorization,amm_code::Authorization::Controller(_)).then_some(key.as_slice());
    let auxiliary:Vec<_>=recipe.auxiliary_parents.iter().map(get).collect();
    let expected:[u8;32]=decode_hex(&recipe.pool_code_hash).map_err(|_|invalid_plan("New Pool hash invalid"))?.try_into().map_err(|_|invalid_plan("New Pool hash length invalid"))?;
    proof::prepare_unlock(proof::UnlockOptions{current_tx:transaction,parent,ancestor:get(&recipe.ancestor),auxiliary_parents:&auxiliary,
        operation:amm_pool_operation(recipe.operation)?,expected_pool_hash:&expected,controller_public_key:controller})
}

fn resolve_lop_match_script(
    transaction:&Transaction,input_index:usize,input:&PlannedInput,plan:&UnsignedPlan,continuation:&SigningContinuation,
)->Result<Script,EngineError>{
    let recipe=parse_lop_match_recipe(&input.unlocking_script)?;
    let parent=resolve_source(&recipe.parent,plan,continuation)?;
    let previous=parent.outputs.get(input.previous_output_index as usize).ok_or_else(||invalid_plan("LOP match order output missing"))?;
    if previous.satoshis!=input.previous_output_satoshis||previous.script_pubkey!=resolve_previous_output_script(input,plan)?{
        return Err(invalid_plan("LOP planned previous output differs from authenticated parent"));
    }
    validate_public_identity(&input.signer)?;
    crate::protocols::lop_proof::build_match_unlock(transaction,&parent,input_index)
}

fn resolve_amm_lp_prepared(
    transaction:&Transaction,input_index:usize,input:&PlannedInput,plan:&UnsignedPlan,continuation:&SigningContinuation,
) -> Result<crate::protocols::amm_lp_proof::PreparedUnlock,EngineError> {
    use crate::protocols::amm_lp_proof as proof;
    let recipe=parse_fungible_unlock_recipe(&input.unlocking_script)?;
    let parent_tx=resolve_source(&recipe.parent,plan,continuation)?;
    let current=transaction.inputs.get(input_index).ok_or_else(||invalid_plan("LP current input missing"))?;
    let previous=parent_tx.outputs.get(input.previous_output_index as usize).ok_or_else(||invalid_plan("LP parent output missing"))?;
    if current.previous_output.txid!=parent_tx.txid() || current.previous_output.vout!=input.previous_output_index
        || previous.satoshis!=input.previous_output_satoshis || previous.script_pubkey!=resolve_previous_output_script(input,plan)? {
        return Err(invalid_plan("LP recipe does not bind planned previous output"));
    }
    let parent=proof::inspect_parent(&parent_tx.serialize(),&current.previous_output,None)?;
    let required=parent.dependencies().iter().map(|p|(p.txid.to_string(),p.vout)).collect();
    let raws=resolve_fungible_proof_sources(&recipe,&required,plan,continuation)?;
    let ancestor_raws:Vec<_>=raws.values().map(Vec::as_slice).collect();
    let controller_tx=recipe.contract_controller.as_ref().map(|w|resolve_source(&w.source,plan,continuation)).transpose()?;
    let controller=recipe.contract_controller.as_ref().zip(controller_tx.as_ref()).map(|(w,tx)|proof::ContractControllerWitness{
        transaction:tx,current_input_index:w.current_input_index as usize,
    });
    let groups:Vec<_>=recipe.output_groups.iter().map(|g|proof::OutputGroup{code_vout:g.code_vout as usize,tape_vout:g.tape_vout.map(|i|i as usize)}).collect();
    let key=validate_public_identity(&input.signer)?.to_bytes();
    proof::prepare_unlock(proof::UnlockOptions{current_tx:transaction,input_index,parent:&parent,ancestor_raws:&ancestor_raws,
        output_groups:&groups,public_key:&key,contract_controller:controller})
}

fn resolve_ecdsa_fungible_prepared(
    transaction: &Transaction,
    input_index: usize,
    input: &PlannedInput,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<crate::protocols::tbc20_proof::PreparedUnlock, EngineError> {
    if input.unlocking_script.starts_with(AMM_LP_UNLOCK_PREFIX) {
        return resolve_amm_lp_prepared(transaction,input_index,input,plan,continuation);
    }
    use crate::protocols::{tbc20_material, tbc20_proof};
    let recipe = parse_tbc20_unlock_recipe(&input.unlocking_script)?;
    let parent_tx = resolve_source(&recipe.parent, plan, continuation)?;
    let current_input = transaction.inputs.get(input_index)
        .ok_or_else(|| invalid_plan("TBC20 recipe current input is missing"))?;
    let previous = parent_tx.outputs.get(input.previous_output_index as usize)
        .ok_or_else(|| invalid_plan("TBC20 recipe parent output is missing"))?;
    if current_input.previous_output.txid != parent_tx.txid()
        || current_input.previous_output.vout != input.previous_output_index
        || previous.satoshis != input.previous_output_satoshis
        || previous.script_pubkey != resolve_previous_output_script(input, plan)?
    { return Err(invalid_plan("TBC20 recipe parent does not bind the planned previous output")); }
    let parent = tbc20_material::inspect_parent(&parent_tx.serialize(), &current_input.previous_output, None)?;
    let required: BTreeSet<_> = parent.dependencies().iter()
        .map(|dependency| (dependency.outpoint.txid.to_string(), dependency.outpoint.vout)).collect();
    let unique_raws = resolve_fungible_proof_sources(&recipe, &required, plan, continuation)?;
    let ancestors = tbc20_material::link_ancestors(&parent, &unique_raws.values().map(Vec::as_slice).collect::<Vec<_>>())?;
    let controller_tx = recipe.contract_controller.as_ref()
        .map(|witness| resolve_source(&witness.source, plan, continuation)).transpose()?;
    let controller = recipe.contract_controller.as_ref().zip(controller_tx.as_ref())
        .map(|(reference, tx)| tbc20_proof::ContractControllerWitness {
            transaction: tx, current_input_index: reference.current_input_index as usize,
        });
    let groups: Vec<_> = recipe.output_groups.iter().map(|group| tbc20_proof::OutputGroup {
        code_vout: group.code_vout as usize, tape_vout: group.tape_vout.map(|index| index as usize),
    }).collect();
    let public_key = validate_public_identity(&input.signer)?.to_bytes();
    tbc20_proof::prepare_unlock(tbc20_proof::UnlockOptions {
        current_tx: transaction, input_index, parent: &parent, ancestors: &ancestors,
        output_groups: &groups, public_key: &public_key, contract_controller: controller,
    })
}

// Resolve each immutable source once even when several ancestor slots use it.
// Fungible protocols require the exact set of nonzero Tape outpoints.
fn resolve_fungible_proof_sources(
    recipe: &Tbc20UnlockRecipe,
    required: &BTreeSet<(String, u32)>,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<BTreeMap<String, Vec<u8>>, EngineError> {
    let mut referenced = BTreeSet::new();
    let mut cached_sources: Vec<(TransactionSource, Transaction)> = Vec::new();
    let mut unique_raws = BTreeMap::new();
    for reference in &recipe.proof_references {
        let cache_index = if let Some(index) = cached_sources.iter().position(|(source, _)| source == &reference.source) {
            index
        } else {
            let tx = resolve_source(&reference.source, plan, continuation)?;
            cached_sources.push((reference.source.clone(), tx)); cached_sources.len() - 1
        };
        let ancestor = &cached_sources[cache_index].1;
        let txid = ancestor.txid().to_string();
        if !referenced.insert((txid.clone(), reference.output_index))
            || ancestor.outputs.get(reference.output_index as usize).is_none()
        { return Err(invalid_plan("TBC20 proof references are duplicated or point to missing outputs")); }
        unique_raws.entry(txid).or_insert_with(|| ancestor.serialize());
    }
    if &referenced != required {
        return Err(invalid_plan("TBC20 proof references must exactly match nonzero parent Tape slots"));
    }
    Ok(unique_raws)
}

// The new ABI uses canonical small-number opcodes. Do not loosen the older
// recipe parser to add these semantics to historical unlock formats.
fn covenant_script_fields(script: &[u8], max_leaves: usize) -> Result<Vec<Vec<u8>>, EngineError> {
    if script.len() > MAX_POOL_UNLOCKING_SCRIPT_BYTES {
        return Err(invalid_plan("covenant unlocking script exceeds the byte budget"));
    }
    let mut fields = Vec::new();
    let mut offset = 0;
    while offset < script.len() {
        if fields.len() >= max_leaves {
            return Err(invalid_plan("covenant unlocking script has too many leaves"));
        }
        let opcode = script[offset]; offset += 1;
        let length = match opcode {
            0..=75 => usize::from(opcode),
            0x4c => read_push_length(script, &mut offset, 1)?,
            0x4d => read_push_length(script, &mut offset, 2)?,
            0x4e => read_push_length(script, &mut offset, 4)?,
            0x4f => { fields.push(vec![0x81]); continue; }
            0x51..=0x60 => { fields.push(vec![opcode - 0x50]); continue; }
            _ => return Err(invalid_plan("covenant unlocking script is not push-only")),
        };
        let end = offset.checked_add(length).ok_or_else(|| invalid_plan("covenant unlocking leaf overflow"))?;
        let data = script.get(offset..end).ok_or_else(|| invalid_plan("covenant unlocking leaf is truncated"))?;
        fields.push(data.to_vec()); offset = end;
    }
    Ok(fields)
}

fn parse_nft_unlock_recipe(value: &str) -> Result<NftUnlockRecipe, EngineError> {
    let encoded = value.strip_prefix(NFT_UNLOCK_PREFIX).ok_or_else(|| invalid_plan("NFT unlocking descriptor prefix is invalid"))?;
    let bytes = decode_hex(encoded).map_err(|_| invalid_plan("NFT unlocking descriptor is not hexadecimal"))?;
    serde_json::from_slice(&bytes).map_err(|_| invalid_plan("NFT unlocking descriptor payload is invalid"))
}

fn parse_pool_unlock_recipe(value: &str) -> Result<PoolUnlockRecipe, EngineError> {
    parse_pool_recipe(value, POOL_UNLOCK_PREFIX, "Pool")
}

fn parse_pool_held_ft_unlock_recipe(
    value: &str,
) -> Result<PoolHeldFtUnlockRecipe, EngineError> {
    parse_pool_recipe(value, POOL_HELD_FT_UNLOCK_PREFIX, "Pool-held FT")
}

fn parse_ftlp_unlock_recipe(value: &str) -> Result<FtlpUnlockRecipe, EngineError> {
    parse_pool_recipe(value, FTLP_UNLOCK_PREFIX, "FTLP")
}

fn parse_pool_recipe<T: DeserializeOwned + Serialize>(
    value: &str,
    prefix: &str,
    family: &str,
) -> Result<T, EngineError> {
    let encoded = value
        .strip_prefix(prefix)
        .ok_or_else(|| invalid_plan(&format!("{family} unlocking descriptor prefix is invalid")))?;
    if encoded.len() > MAX_POOL_RECIPE_SERIALIZED_BYTES.saturating_mul(2) {
        return Err(invalid_plan("Pool recipe exceeds the serialized byte budget"));
    }
    let bytes = decode_hex(encoded)
        .map_err(|_| invalid_plan(&format!("{family} unlocking descriptor is not hexadecimal")))?;
    let recipe: T = serde_json::from_slice(&bytes)
        .map_err(|_| invalid_plan(&format!("{family} unlocking descriptor payload is invalid")))?;
    if serde_json::to_vec(&recipe).map_err(|_| internal("could not reserialize Pool recipe"))?
        != bytes
    {
        return Err(invalid_plan("Pool unlocking descriptor is not canonical"));
    }
    Ok(recipe)
}

fn nft_unlock_suffix(
    transaction: &Transaction,
    input: &PlannedInput,
    recipe: &NftUnlockRecipe,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<Vec<u8>, EngineError> {
    let parent = resolve_source(&recipe.parent, plan, continuation)?;
    let pre_pre = resolve_source(&recipe.pre_pre, plan, continuation)?;
    if parent.txid().to_string() != input.previous_transaction_id { return Err(invalid_plan("NFT parent does not match the planned outpoint")); }
    let mut suffix = if recipe.version == 0 { legacy_current_tx_data(transaction)? } else { tbc_sdk::contracts::nft::unlock::current_tx_data(transaction).map_err(|_| invalid_plan("could not derive NFT current transaction data"))? };
    suffix.extend_from_slice(&if recipe.version == 0 { legacy_pre_pre_tx_data(&pre_pre)? } else { tbc_sdk::contracts::nft::unlock::pre_pre_tx_data(&pre_pre).map_err(|_| invalid_plan("could not derive NFT pre-pre transaction data"))? });
    suffix.extend_from_slice(&if recipe.version == 0 { legacy_pre_tx_data(&parent)? } else { tbc_sdk::contracts::nft::unlock::pre_tx_data(&parent).map_err(|_| invalid_plan("could not derive NFT parent transaction data"))? });
    Ok(suffix)
}

struct ResolvedPoolUnlock {
    pool: PoolSpendContext<ResolvedPoolContract>,
    auxiliary_parents: Vec<Transaction>,
    public_key_lock: Vec<PublicKey>,
}

fn context_dependent_signature(input: &PlannedInput) -> bool {
    input.unlocking_script.starts_with(POOL_UNLOCK_PREFIX) || input.unlocking_script.starts_with(AMM_POOL_UNLOCK_PREFIX)
}

/// Total external tasks, including later stages, without materializing descendants
/// or deriving their digests. Context-dependent future covenants remain unknown.
/// Only called after begin_signing has validated the complete plan.
pub(crate) fn planned_signing_task_count(plan: &UnsignedPlan, initial: &SigningStage) -> Option<u32> {
    // A single transaction already exposes its complete task collection. Avoid
    // duplicating that fact in every ordinary transfer's bound wire payload.
    if plan.transactions.len() <= 1 { return None; }
    let mut count = u32::try_from(initial.signing_requests.len()).ok()?;
    for transaction in &plan.transactions {
        if transaction.stage <= initial.stage { continue; }
        for input in &transaction.inputs {
            if input.unlocking_script.starts_with(LOP_MATCH_UNLOCK_PREFIX) { continue; }
            if context_dependent_signature(input) { return None; }
            count = count.checked_add(1)?;
        }
    }
    Some(count)
}

fn input_requires_external_signature(
    transaction: &Transaction,
    input_index: usize,
    input: &PlannedInput,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<bool, EngineError> {
    if input.unlocking_script.starts_with(LOP_MATCH_UNLOCK_PREFIX) {
        resolve_lop_match_script(transaction,input_index,input,plan,continuation)?;
        return Ok(false);
    }
    if input.unlocking_script.starts_with(AMM_POOL_UNLOCK_PREFIX) {
        return Ok(resolve_amm_pool_prepared(transaction,input_index,input,plan,continuation)?.controller_public_key().is_some());
    }
    if !context_dependent_signature(input) {
        return Ok(true);
    }
    let recipe = parse_pool_unlock_recipe(&input.unlocking_script)?;
    let resolved = resolve_pool_unlock(
        transaction,
        input_index,
        input,
        &recipe,
        plan,
        continuation,
    )?;
    let context = PoolUnlockContext {
        transaction,
        input_index,
        spent_vout: recipe.spent_vout,
        pool: &resolved.pool,
        input_parents: &resolved.auxiliary_parents,
        option: recipe.operation.released(),
        swap_option: recipe.swap.map(PoolRecipeSwap::released),
        with_lock: recipe.with_lock,
        signature: None,
        public_key_lock: &resolved.public_key_lock,
    };
    pool_unlock_requires_signature(&context)
        .map_err(|_| invalid_plan("released Pool context rejected the authenticated recipe"))
}

#[allow(clippy::too_many_arguments)]
fn resolve_pool_unlock(
    transaction: &Transaction,
    input_index: usize,
    input: &PlannedInput,
    recipe: &PoolUnlockRecipe,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<ResolvedPoolUnlock, EngineError> {
    let parent = resolve_source(&recipe.parent, plan, continuation)?;
    let pre_parent = resolve_source(&recipe.pre_parent, plan, continuation)?;
    let contract = recipe.contract.resolve(|source| resolve_source(source, plan, continuation))?;
    let auxiliary_parents = recipe
        .auxiliary_parents
        .iter()
        .map(|source| resolve_source(source, plan, continuation))
        .collect::<Result<Vec<_>, _>>()?;
    let public_key_lock = recipe
        .public_key_lock
        .iter()
        .map(|key| parse_public_key(key))
        .collect::<Result<Vec<_>, _>>()?;
    let current_input = transaction
        .inputs
        .get(input_index)
        .ok_or_else(|| invalid_plan("Pool recipe input index is out of range"))?;
    let output = parent
        .outputs
        .get(recipe.spent_vout as usize)
        .ok_or_else(|| invalid_plan("Pool recipe parent vout is out of range"))?;
    if parent.txid() != current_input.previous_output.txid
        || current_input.previous_output.vout != recipe.spent_vout
        || parent.txid() != resolve_previous_txid(input, plan, continuation)?
        || output.satoshis != input.previous_output_satoshis
        || output.script_pubkey != resolve_previous_output_script(input, plan)?
    {
        return Err(invalid_plan("Pool recipe parent does not bind the planned outpoint"));
    }
    let tape = parent
        .outputs
        .get(1)
        .ok_or_else(|| invalid_plan("Pool recipe parent is missing its state Tape"))?;
    let mut state = PoolState::from_v2_tape(&tape.script_pubkey, recipe.service_provider.clone())
        .map_err(|_| invalid_plan("Pool recipe parent state Tape is invalid"))?;
    match &contract {
        ResolvedPoolContract::Indexed { .. } => { contract.pairs(&state)?; },
        ResolvedPoolContract::Transaction(tx) => {
            if tx.inputs.is_empty() || tx.outputs.is_empty() {
                return Err(invalid_plan("Pool contract transaction must have inputs and outputs"));
            }
            if tx.txid() != state.ft_a_contract_id {
                return Err(invalid_plan("Pool contract does not match authenticated Pool state"));
            }
        },
    }
    state.public_key_locked = !public_key_lock.is_empty();
    Ok(ResolvedPoolUnlock {
        pool: PoolSpendContext {
            pool_utxo: UtxoInfo {
                outpoint: current_input.previous_output.clone(),
                satoshis: output.satoshis,
                script_pubkey: output.script_pubkey.clone(),
            },
            pool_pre_tx: parent,
            pool_pre_pre_tx: pre_parent,
            contract_tx: contract,
            state,
        },
        auxiliary_parents,
        public_key_lock,
    })
}

#[allow(clippy::too_many_arguments)]
fn pool_unlock_script(
    transaction: &Transaction,
    input_index: usize,
    input: &PlannedInput,
    recipe: &PoolUnlockRecipe,
    signature: Option<(&[u8], &PublicKey)>,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<Vec<u8>, EngineError> {
    let resolved = resolve_pool_unlock(
        transaction,
        input_index,
        input,
        recipe,
        plan,
        continuation,
    )?;
    let signature = signature.map(|(bytes, key)| PoolUnlockSignature {
        signature_with_hashtype: bytes.to_vec(),
        public_key: key.clone(),
    });
    let context = PoolUnlockContext {
        transaction,
        input_index,
        spent_vout: recipe.spent_vout,
        pool: &resolved.pool,
        input_parents: &resolved.auxiliary_parents,
        option: recipe.operation.released(),
        swap_option: recipe.swap.map(PoolRecipeSwap::released),
        with_lock: recipe.with_lock,
        signature: signature.as_ref(),
        public_key_lock: &resolved.public_key_lock,
    };
    let script = pool_unlock(&context)
        .map_err(|_| invalid_plan("released Pool unlock rejected the authenticated recipe"))?;
    if script.len() > MAX_POOL_UNLOCKING_SCRIPT_BYTES {
        return Err(invalid_plan("Pool unlocking script exceeds the byte budget"));
    }
    Ok(script)
}

fn pool_unlock_unsigned_script(
    transaction: &Transaction,
    input_index: usize,
    input: &PlannedInput,
    recipe: &PoolUnlockRecipe,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<Vec<u8>, EngineError> {
    let resolved = resolve_pool_unlock(
        transaction,
        input_index,
        input,
        recipe,
        plan,
        continuation,
    )?;
    let context = PoolUnlockContext {
        transaction,
        input_index,
        spent_vout: recipe.spent_vout,
        pool: &resolved.pool,
        input_parents: &resolved.auxiliary_parents,
        option: recipe.operation.released(),
        swap_option: recipe.swap.map(PoolRecipeSwap::released),
        with_lock: recipe.with_lock,
        signature: None,
        public_key_lock: &resolved.public_key_lock,
    };
    pool_unlock_unsigned_body(&context).map_err(|source| {
        let message = format!(
            "released Pool unlock rejected the authenticated keyless size recipe: {source}"
        );
        invalid_plan(&message)
    })
}

fn validate_exact_recipe_proof_pairs(
    selected_outpoints: &[(String, u32)],
    proof_outpoints: &[(String, u32)],
    message: &'static str,
) -> Result<(), EngineError> {
    if selected_outpoints.len() != proof_outpoints.len() {
        return Err(invalid_plan(message));
    }
    let mut selected = BTreeSet::new();
    let mut proofs = BTreeSet::new();
    for (selected_outpoint, proof_outpoint) in selected_outpoints.iter().zip(proof_outpoints) {
        if !selected.insert(selected_outpoint.clone())
            || !proofs.insert(proof_outpoint.clone())
            || selected_outpoint != proof_outpoint
        {
            return Err(invalid_plan(message));
        }
    }
    Ok(())
}

fn resolve_recipe_parent_and_proofs(
    input: &PlannedInput,
    parent_source: &TransactionSource,
    proof_references: &[ProofReference],
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
    proof_message: &'static str,
) -> Result<(Transaction, Vec<Transaction>), EngineError> {
    let parent = resolve_source(parent_source, plan, continuation)?;
    if parent.txid() != resolve_previous_txid(input, plan, continuation)? {
        return Err(invalid_plan("Pool covenant parent does not match the planned outpoint"));
    }
    let output = parent
        .outputs
        .get(input.previous_output_index as usize)
        .ok_or_else(|| invalid_plan("Pool covenant parent vout is out of range"))?;
    if output.satoshis != input.previous_output_satoshis
        || output.script_pubkey != resolve_previous_output_script(input, plan)?
    {
        return Err(invalid_plan(
            "Pool covenant parent output does not match the plan",
        ));
    }
    let tape = parent
        .outputs
        .get(input.previous_output_index as usize + 1)
        .ok_or_else(|| invalid_plan(proof_message))?;
    let source_indexes = tape_source_indexes(&tape.script_pubkey, proof_message)?;
    let selected_outpoints = source_indexes
        .into_iter()
        .map(|source_index| {
            parent
                .inputs
                .get(source_index)
                .map(|source| {
                    (
                        source.previous_output.txid.to_string(),
                        source.previous_output.vout,
                    )
                })
                .ok_or_else(|| invalid_plan(proof_message))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut proofs = Vec::with_capacity(proof_references.len());
    let mut proof_outpoints = Vec::with_capacity(proof_references.len());
    for reference in proof_references {
        let proof = resolve_source(&reference.source, plan, continuation)?;
        proof
            .outputs
            .get(reference.output_index as usize)
            .ok_or_else(|| invalid_plan(proof_message))?;
        proof_outpoints.push((proof.txid().to_string(), reference.output_index));
        proofs.push(proof);
    }
    validate_exact_recipe_proof_pairs(&selected_outpoints, &proof_outpoints, proof_message)?;
    Ok((parent, proofs))
}

fn resolve_authenticated_signing_script(
    transaction: &Transaction,
    input_index: usize,
    input: &PlannedInput,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<Script, EngineError> {
    if input.unlocking_script.starts_with(LOP_MATCH_UNLOCK_PREFIX) {
        resolve_lop_match_script(transaction,input_index,input,plan,continuation)?;
        return resolve_previous_output_script(input,plan);
    }
    if input.unlocking_script.starts_with(AMM_POOL_UNLOCK_PREFIX) {
        resolve_amm_pool_prepared(transaction,input_index,input,plan,continuation)?;
        return resolve_previous_output_script(input,plan);
    }
    if input.unlocking_script.starts_with(COIN_UNLOCK_PREFIX) {
        resolve_coin_prepared(transaction, input_index, input, plan, continuation)?;
        return resolve_previous_output_script(input, plan);
    }
    if input.unlocking_script.starts_with(TBC721_UNLOCK_PREFIX) {
        resolve_tbc721_prepared(transaction, input_index, input, plan, continuation)?;
        return resolve_previous_output_script(input, plan);
    }
    if is_ecdsa_fungible_recipe(&input.unlocking_script) {
        resolve_ecdsa_fungible_prepared(transaction, input_index, input, plan, continuation)?;
        return resolve_previous_output_script(input, plan);
    }
    if input.unlocking_script.starts_with(POOL_HELD_FT_UNLOCK_PREFIX) {
        let recipe = parse_pool_held_ft_unlock_recipe(&input.unlocking_script)?;
        let (parent, _) = resolve_recipe_parent_and_proofs(
            input,
            &recipe.parent,
            &recipe.proof_references,
            plan,
            continuation,
            "Pool proof does not match its ordered parent input",
        )?;
        authenticated_pool_held_ft_fields(
            transaction,
            input_index,
            input,
            &recipe,
            &parent,
            plan,
            continuation,
        )?;
        return Ok(parent.outputs[input.previous_output_index as usize]
            .script_pubkey
            .clone());
    }
    if input.unlocking_script.starts_with(FTLP_UNLOCK_PREFIX) {
        let recipe = parse_ftlp_unlock_recipe(&input.unlocking_script)?;
        let (parent, _) = resolve_recipe_parent_and_proofs(
            input,
            &recipe.parent,
            &recipe.proof_references,
            plan,
            continuation,
            "Pool proof does not match its ordered parent input",
        )?;
        return Ok(parent.outputs[input.previous_output_index as usize]
            .script_pubkey
            .clone());
    }
    if input.unlocking_script.starts_with(POOL_UNLOCK_PREFIX) {
        let recipe = parse_pool_unlock_recipe(&input.unlocking_script)?;
        let parent = resolve_source(&recipe.parent, plan, continuation)?;
        let output = parent
            .outputs
            .get(recipe.spent_vout as usize)
            .ok_or_else(|| invalid_plan("Pool parent vout is out of range"))?;
        return Ok(output.script_pubkey.clone());
    }
    resolve_previous_output_script(input, plan)
}

fn validate_signing_recipe_owner(
    input: &PlannedInput,
    _plan: &UnsignedPlan,
    _continuation: &SigningContinuation,
    script_code: &Script,
) -> Result<PublicKey, EngineError> {
    if input.unlocking_script.starts_with(POOL_UNLOCK_PREFIX) {
        let public_key = validate_public_identity(&input.signer)?;
        let recipe = parse_pool_unlock_recipe(&input.unlocking_script)?;
        let locked_keys = recipe
            .public_key_lock
            .iter()
            .map(|candidate| parse_public_key(candidate))
            .collect::<Result<Vec<_>, _>>()?;
        if !locked_keys.is_empty() && !locked_keys.contains(&public_key) {
            return Err(invalid_plan("Pool signer is absent from the authenticated lock set"));
        }
        return Ok(public_key);
    }
    if input.unlocking_script.starts_with(POOL_HELD_FT_UNLOCK_PREFIX) {
        let recipe = parse_pool_held_ft_unlock_recipe(&input.unlocking_script)?;
        return validate_proof_owner(
            &input.signer,
            input,
            &recipe.parent,
            &recipe.proof_references,
            _plan,
            _continuation,
        );
    }
    if input.unlocking_script.starts_with(FTLP_UNLOCK_PREFIX) {
        let recipe = parse_ftlp_unlock_recipe(&input.unlocking_script)?;
        return validate_proof_owner(
            &input.signer,
            input,
            &recipe.parent,
            &recipe.proof_references,
            _plan,
            _continuation,
        );
    }
    validate_public_context(&input.signer, script_code, &input.unlocking_script)
}

fn validate_proof_owner(
    context: &PublicSigningContext,
    input: &PlannedInput,
    parent_source: &TransactionSource,
    proof_references: &[ProofReference],
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<PublicKey, EngineError> {
    let (_, proofs) = resolve_recipe_parent_and_proofs(
        input,
        parent_source,
        proof_references,
        plan,
        continuation,
        "Pool proof does not match its ordered parent input",
    )?;
    let public_key = validate_public_identity(context)?;
    for (proof, reference) in proofs.iter().zip(proof_references) {
        let output = proof
            .outputs
            .get(reference.output_index as usize)
            .ok_or_else(|| invalid_plan("Pool proof owner output is out of range"))?;
        if validate_public_context(context, &output.script_pubkey, "").is_ok()
            || tbc_sdk::contracts::pool_nft_v2::scripts::pool_code_source_outpoint(
                &output.script_pubkey,
            )
            .is_ok()
            || tbc_sdk::contracts::ft::unlock::classify_ft_script(&output.script_pubkey).is_ok()
            || output
                .script_pubkey
                .as_bytes()
                .windows(public_key.hash160().len())
                .any(|window| window == public_key.hash160().as_slice())
        {
            continue;
        }
        return Err(invalid_plan(
            "Pool proof is neither protocol-controlled nor owned by the public account",
        ));
    }
    Ok(public_key)
}

fn pool_held_ft_unlock_prefix(
    transaction: &Transaction,
    input_index: usize,
    input: &PlannedInput,
    recipe: &PoolHeldFtUnlockRecipe,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<Vec<u8>, EngineError> {
    let (parent, proofs) = resolve_recipe_parent_and_proofs(
        input,
        &recipe.parent,
        &recipe.proof_references,
        plan,
        continuation,
        "Pool proof does not match its ordered parent input",
    )?;
    let mut script = tbc_sdk::contracts::ft::unlock::current_tx_data(transaction, input_index)
        .map_err(|_| invalid_plan("could not derive Pool-held FT current transaction data"))?;
    script.extend_from_slice(
        &tbc_sdk::contracts::ft::unlock::pre_pre_tx_data_from_parents(
            &parent,
            input.previous_output_index as usize,
            &proofs,
        )
        .map_err(|_| invalid_plan("Pool-held FT pre-pre proof set is invalid"))?,
    );
    Ok(script)
}

fn pool_held_ft_unlock_suffix(
    transaction: &Transaction,
    input_index: usize,
    input: &PlannedInput,
    recipe: &PoolHeldFtUnlockRecipe,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<Vec<u8>, EngineError> {
    let (parent, _) = resolve_recipe_parent_and_proofs(
        input,
        &recipe.parent,
        &recipe.proof_references,
        plan,
        continuation,
        "Pool proof does not match its ordered parent input",
    )?;
    let authority = authenticated_pool_held_ft_fields(
        transaction,
        input_index,
        input,
        recipe,
        &parent,
        plan,
        continuation,
    )?;
    let contract_vout = if authority.ft_version > 1 {
        -1
    } else {
        transaction
            .inputs
            .first()
            .map(|current| current.previous_output.vout as i32)
            .unwrap_or_default()
    };
    let mut suffix = tbc_sdk::contracts::ft::unlock::current_inputs_data(transaction)
        .map_err(|_| invalid_plan("could not derive Pool-held FT current input data"))?;
    suffix.extend_from_slice(
        &tbc_sdk::contracts::ft::unlock::contract_tx_data(&authority.contract, contract_vout)
            .map_err(|_| invalid_plan("could not derive Pool-held FT contract data"))?,
    );
    if authority.ft_version > 2 {
        // Pool-held FT uses the released default contract branch (wire tag zero).
        // The authenticated logical index still checks input order, not this tag.
        suffix.push(match authority.logical_swap_input_index {
            0..=5 => opcodes::OP_0,
            _ => return Err(invalid_plan("Pool-held FT logical swap input index exceeds five")),
        });
    }
    if authority.coin_mode {
        suffix.push(opcodes::OP_1);
    }
    suffix.extend_from_slice(
        &tbc_sdk::contracts::ft::unlock::pre_tx_data(
            &parent,
            input.previous_output_index as usize,
        )
        .map_err(|_| invalid_plan("could not derive Pool-held FT parent data"))?,
    );
    Ok(suffix)
}

struct AuthenticatedPoolHeldFtFields {
    contract: Transaction,
    ft_version: u8,
    coin_mode: bool,
    logical_swap_input_index: u8,
}

#[allow(clippy::too_many_arguments)]
fn authenticated_pool_held_ft_fields(
    transaction: &Transaction,
    input_index: usize,
    input: &PlannedInput,
    recipe: &PoolHeldFtUnlockRecipe,
    parent: &Transaction,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<AuthenticatedPoolHeldFtFields, EngineError> {
    let contract = resolve_source(&recipe.contract, plan, continuation)?;
    let pool_input = transaction
        .inputs
        .first()
        .ok_or_else(|| invalid_plan("Pool-held FT transaction is missing its Pool input"))?;
    if pool_input.previous_output.txid != contract.txid() {
        return Err(invalid_plan(
            "Pool-held FT contract does not match the transaction Pool input",
        ));
    }
    let contract_output = contract
        .outputs
        .get(pool_input.previous_output.vout as usize)
        .ok_or_else(|| invalid_plan("Pool-held FT contract Pool output is out of range"))?;
    let parent_output = parent
        .outputs
        .get(input.previous_output_index as usize)
        .ok_or_else(|| invalid_plan("Pool-held FT parent code output is out of range"))?;
    let classified =
        tbc_sdk::contracts::ft::unlock::classify_ft_script(&parent_output.script_pubkey)
            .map_err(|_| {
                invalid_plan("Pool-held FT parent covenant is not a supported FT family")
            })?;
    let expected = pool_held_ft_code(
        &parent_output.script_pubkey,
        tbc_sdk::hash::hash160(&contract_output.script_pubkey.sha256()),
    )
    .map_err(|_| invalid_plan("Pool-held FT parent covenant binding is malformed"))?;
    if expected != parent_output.script_pubkey {
        return Err(invalid_plan(
            "Pool-held FT parent covenant is not held by authenticated Pool contract",
        ));
    }
    if recipe.ft_version != classified.version {
        return Err(invalid_plan(
            "Pool-held FT version does not match authenticated parent covenant",
        ));
    }
    if recipe.coin_mode != classified.is_coin {
        return Err(invalid_plan(
            "Pool-held FT coin mode does not match authenticated parent covenant",
        ));
    }
    let logical_index = input_index
        .checked_sub(1)
        .ok_or_else(|| invalid_plan("Pool-held FT input cannot replace the Pool input"))?;
    let logical_swap_input_index = u8::try_from(logical_index)
        .map_err(|_| invalid_plan("Pool-held FT logical swap input index exceeds wire range"))?;
    if recipe.logical_swap_input_index != logical_swap_input_index {
        return Err(invalid_plan(
            "Pool-held FT logical swap input index does not match ordered input",
        ));
    }
    Ok(AuthenticatedPoolHeldFtFields {
        contract,
        ft_version: classified.version,
        coin_mode: classified.is_coin,
        logical_swap_input_index,
    })
}

fn ftlp_unlock_prefix(
    transaction: &Transaction,
    input_index: usize,
    input: &PlannedInput,
    recipe: &FtlpUnlockRecipe,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<Vec<u8>, EngineError> {
    let (parent, proofs) = resolve_recipe_parent_and_proofs(
        input,
        &recipe.parent,
        &recipe.proof_references,
        plan,
        continuation,
        "Pool proof does not match its ordered parent input",
    )?;
    validate_ftlp_lock(transaction, input_index, &parent, recipe)?;
    let mut script = tbc_sdk::contracts::ft::unlock::current_tx_data(transaction, input_index)
        .map_err(|_| invalid_plan("could not derive FTLP current transaction data"))?;
    script.extend_from_slice(
        &tbc_sdk::contracts::ft::unlock::pre_pre_tx_data_from_parents(
            &parent,
            input.previous_output_index as usize,
            &proofs,
        )
        .map_err(|_| invalid_plan("FTLP pre-pre proof set is invalid"))?,
    );
    Ok(script)
}

fn ftlp_unlock_suffix(
    input: &PlannedInput,
    recipe: &FtlpUnlockRecipe,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<Vec<u8>, EngineError> {
    let (parent, _) = resolve_recipe_parent_and_proofs(
        input,
        &recipe.parent,
        &recipe.proof_references,
        plan,
        continuation,
        "Pool proof does not match its ordered parent input",
    )?;
    tbc_sdk::contracts::ft::unlock::pre_tx_data(
        &parent,
        input.previous_output_index as usize,
    )
    .map_err(|_| invalid_plan("could not derive FTLP parent data"))
}

fn validate_ftlp_lock(
    transaction: &Transaction,
    input_index: usize,
    parent: &Transaction,
    recipe: &FtlpUnlockRecipe,
) -> Result<(), EngineError> {
    let tape_index = transaction
        .inputs
        .get(input_index)
        .map(|current| current.previous_output.vout as usize)
        .ok_or_else(|| invalid_plan("FTLP input index is out of range"))?
        .checked_add(1)
        .ok_or_else(|| invalid_plan("FTLP Tape output index overflow"))?;
    let tape = parent
        .outputs
        .get(tape_index)
        .ok_or_else(|| invalid_plan("FTLP parent is missing its adjacent Tape"))?;
    let chunks = canonical_op_return_pushes(&tape.script_pubkey)?;
    let current = &transaction.inputs[input_index];
    match recipe.lock {
        FtlpLockMode::Standard => {
            if chunks.get(1).is_none_or(|chunk| chunk.len() != 1)
                || transaction.lock_time != 0
                || current.sequence != tbc_sdk::DEFAULT_SEQUENCE
            {
                return Err(invalid_plan("standard FTLP lock-time or sequence is invalid"));
            }
        }
        FtlpLockMode::BlockHeight {
            lock_height,
            current_height,
        } => {
            let encoded: [u8; 4] = chunks
                .get(1)
                .filter(|chunk| chunk.len() == 4)
                .ok_or_else(|| invalid_plan("locked FTLP Tape is malformed"))?
                .as_slice()
                .try_into()
                .expect("length checked");
            if u32::from_le_bytes(encoded) != lock_height
                || lock_height >= 500_000_000
                || (lock_height != 0 && current_height == 0)
                || current_height >= 500_000_000
                || lock_height > current_height
                || transaction.lock_time != current_height
                || current.sequence != tbc_sdk::DEFAULT_SEQUENCE - 1
            {
                return Err(invalid_plan("FTLP block-height lock or sequence is invalid"));
            }
        }
    }
    Ok(())
}

fn canonical_op_return_pushes(script: &Script) -> Result<Vec<Vec<u8>>, EngineError> {
    let bytes = script.as_bytes();
    if !bytes.starts_with(&[opcodes::OP_0, opcodes::OP_RETURN]) {
        return Err(invalid_plan("FTLP Tape is not canonical OP_FALSE OP_RETURN"));
    }
    let mut offset = 2usize;
    let mut pushes = Vec::new();
    while offset < bytes.len() {
        let opcode = bytes[offset];
        offset += 1;
        let length = match opcode {
            0 => 0,
            1..=75 => usize::from(opcode),
            opcodes::OP_PUSHDATA1 => {
                let length = read_push_length(bytes, &mut offset, 1)?;
                if length <= 75 {
                    return Err(invalid_plan("FTLP Tape contains a non-minimal push"));
                }
                length
            }
            opcodes::OP_PUSHDATA2 => {
                let length = read_push_length(bytes, &mut offset, 2)?;
                if length <= 0xff {
                    return Err(invalid_plan("FTLP Tape contains a non-minimal push"));
                }
                length
            }
            _ => return Err(invalid_plan("FTLP Tape contains a non-push opcode")),
        };
        let end = offset
            .checked_add(length)
            .ok_or_else(|| invalid_plan("FTLP Tape push length overflow"))?;
        pushes.push(
            bytes
                .get(offset..end)
                .ok_or_else(|| invalid_plan("FTLP Tape push is truncated"))?
                .to_vec(),
        );
        offset = end;
    }
    if pushes.last().map(Vec::as_slice) != Some(b"FTape".as_slice()) {
        return Err(invalid_plan("FTLP Tape is missing its released marker"));
    }
    Ok(pushes)
}

pub(crate) fn legacy_current_tx_data(tx: &Transaction) -> Result<Vec<u8>, EngineError> {
    use tbc_sdk::contracts::nft::unlock::{length_hex, outputs_data};
    let output = tx.outputs.first().ok_or_else(|| invalid_plan("NFT current transaction is missing its code output"))?;
    let mut data = vec![0x08];
    data.extend_from_slice(&output.satoshis.to_le_bytes());
    data.extend_from_slice(&length_hex(output.script_pubkey.as_bytes().len()).map_err(|_| invalid_plan("NFT V0 code script length is invalid"))?);
    data.extend_from_slice(output.script_pubkey.as_bytes());
    data.extend_from_slice(&outputs_data(tx, 1).map_err(|_| invalid_plan("NFT V0 current outputs are invalid"))?);
    Ok(data)
}

pub(crate) fn legacy_pre_tx_data(tx: &Transaction) -> Result<Vec<u8>, EngineError> {
    use tbc_sdk::contracts::nft::unlock::{length_hex, outputs_data};
    let code = tx.outputs.first().ok_or_else(|| invalid_plan("NFT V0 parent code output is missing"))?;
    let hold = tx.outputs.get(1).ok_or_else(|| invalid_plan("NFT V0 parent hold output is missing"))?;
    let (base, unlocks) = legacy_input_data(tx);
    let mut data = legacy_tx_header(tx);
    data.extend_from_slice(&length_hex(base.len()).map_err(|_| invalid_plan("NFT V0 parent input length is invalid"))?);
    data.extend_from_slice(&base);
    data.push(0x20);
    data.extend_from_slice(&tbc_sdk::hash::sha256(&unlocks));
    append_legacy_output(&mut data, code)?;
    append_legacy_output(&mut data, hold)?;
    data.extend_from_slice(&outputs_data(tx, 2).map_err(|_| invalid_plan("NFT V0 parent outputs are invalid"))?);
    Ok(data)
}

pub(crate) fn legacy_pre_pre_tx_data(tx: &Transaction) -> Result<Vec<u8>, EngineError> {
    use tbc_sdk::contracts::nft::unlock::outputs_data;
    let code = tx.outputs.first().ok_or_else(|| invalid_plan("NFT V0 pre-pre code output is missing"))?;
    let (base, unlocks) = legacy_input_data(tx);
    let mut data = legacy_tx_header(tx);
    data.push(0x20);
    data.extend_from_slice(&tbc_sdk::hash::sha256(&base));
    data.push(0x20);
    data.extend_from_slice(&tbc_sdk::hash::sha256(&unlocks));
    append_legacy_output(&mut data, code)?;
    data.extend_from_slice(&outputs_data(tx, 1).map_err(|_| invalid_plan("NFT V0 pre-pre outputs are invalid"))?);
    Ok(data)
}

fn legacy_tx_header(tx: &Transaction) -> Vec<u8> {
    let mut data = vec![0x10];
    data.extend_from_slice(&(tx.version as u32).to_le_bytes());
    data.extend_from_slice(&tx.lock_time.to_le_bytes());
    data.extend_from_slice(&(tx.inputs.len() as i32).to_le_bytes());
    data.extend_from_slice(&(tx.outputs.len() as i32).to_le_bytes());
    data
}

fn legacy_input_data(tx: &Transaction) -> (Vec<u8>, Vec<u8>) {
    let mut base = Vec::new();
    let mut unlocks = Vec::new();
    for input in &tx.inputs {
        input.previous_output.serialize(&mut base);
        base.extend_from_slice(&input.sequence.to_le_bytes());
        unlocks.extend_from_slice(&input.script_sig.sha256());
    }
    (base, unlocks)
}

fn append_legacy_output(data: &mut Vec<u8>, output: &tbc_sdk::TxOut) -> Result<(), EngineError> {
    use tbc_sdk::contracts::nft::unlock::length_hex;
    data.push(0x08);
    data.extend_from_slice(&output.satoshis.to_le_bytes());
    data.extend_from_slice(&length_hex(output.script_pubkey.as_bytes().len()).map_err(|_| invalid_plan("NFT V0 output script length is invalid"))?);
    data.extend_from_slice(output.script_pubkey.as_bytes());
    Ok(())
}

fn resolve_source(
    source: &FtTransactionSource,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<Transaction, EngineError> {
    match source {
        FtTransactionSource::Raw(raw) => {
            let transaction = Transaction::from_hex(raw)
                .map_err(|_| invalid_plan("ancestry transaction is malformed"))?;
            if transaction.to_hex() != *raw {
                return Err(invalid_plan("ancestry transaction encoding is not canonical"));
            }
            Ok(transaction)
        }
        FtTransactionSource::Evidence(index) => {
            let index = usize::try_from(*index)
                .map_err(|_| invalid_plan("FT evidence index exceeds the local index range"))?;
            let entry = plan.evidence_table
                .get(index)
                .ok_or_else(|| invalid_plan("FT evidence reference is out of range"))?;
            let transaction = Transaction::from_hex(&entry.raw_transaction)
                .map_err(|_| invalid_plan("FT evidence transaction is malformed"))?;
            if transaction.to_hex() != entry.raw_transaction
                || transaction.txid().to_string() != entry.txid
            {
                return Err(invalid_plan(
                    "FT evidence transaction identifier or encoding is inconsistent",
                ));
            }
            Ok(transaction)
        }
        FtTransactionSource::Planned(transaction_id) => {
            let index = plan.transactions
                .iter()
                .position(|transaction| transaction.transaction_id == *transaction_id)
                .ok_or_else(|| invalid_plan("FT ancestry dependency does not exist"))?;
            let finalized = continuation.finalized_transactions[index]
                .as_ref()
                .ok_or_else(|| invalid_plan("FT ancestry dependency is not finalized"))?;
            Transaction::from_hex(&finalized.raw_transaction)
                .map_err(|_| invalid_plan("FT finalized ancestry transaction is malformed"))
        }
    }
}

fn ft_unlock_prefix(
    transaction: &Transaction,
    input_index: usize,
    input: &PlannedInput,
    recipe: &FtUnlockRecipe,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<Vec<u8>, EngineError> {
    let mut script = tbc_sdk::contracts::ft::unlock::current_tx_data(transaction, input_index)
        .map_err(|_| invalid_plan("could not derive FT current transaction data"))?;
    let parent = resolve_source(&recipe.parent, plan, continuation)?;
    if parent.txid() != resolve_previous_txid(input, plan, continuation)? {
        return Err(invalid_plan(
            "FT unlocking parent does not match the planned outpoint",
        ));
    }
    let mut proofs = Vec::with_capacity(recipe.proof_references.len());
    for reference in &recipe.proof_references {
        proofs.push(resolve_source(&reference.source, plan, continuation)?);
    }
    script.extend_from_slice(
        &tbc_sdk::contracts::ft::unlock::pre_pre_tx_data_from_parents(
            &parent,
            input.previous_output_index as usize,
            &proofs,
        )
        .map_err(|_| invalid_plan("FT grandparent proof does not match the parent Tape"))?,
    );
    Ok(script)
}

fn ft_unlock_suffix(
    input: &PlannedInput,
    recipe: &FtUnlockRecipe,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<Vec<u8>, EngineError> {
    let parent = resolve_source(&recipe.parent, plan, continuation)?;
    if parent.txid().to_string() != resolve_previous_txid(input, plan, continuation)?.to_string() {
        return Err(invalid_plan(
            "FT unlocking parent does not match the planned outpoint",
        ));
    }
    let previous = resolve_previous_output_script(input, plan)?;
    let classified = classify_ft_script(&previous)
        .map_err(|_| invalid_plan("planned FT previous output script is not a supported covenant"))?;
    if recipe.coin_mode != classified.is_coin {
        return Err(invalid_plan(
            "FT unlocking coin mode does not match the authenticated covenant",
        ));
    }
    let mut suffix = Vec::new();
    if recipe.coin_mode {
        suffix.push(opcodes::OP_0);
    }
    suffix.extend_from_slice(&tbc_sdk::contracts::ft::unlock::pre_tx_data(
        &parent,
        input.previous_output_index as usize,
    )
    .map_err(|_| invalid_plan("could not derive FT parent transaction data"))?);
    Ok(suffix)
}

fn resolve_previous_txid(
    input: &PlannedInput,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<Txid, EngineError> {
    if let Some(index) = plan.transactions
        .iter()
        .position(|transaction| transaction.transaction_id == input.previous_transaction_id)
    {
        let finalized = continuation.finalized_transactions[index]
            .as_ref()
            .ok_or_else(|| invalid_plan("planned parent is not finalized"))?;
        parse_txid(&finalized.txid)
    } else {
        parse_txid(&input.previous_transaction_id)
    }
}

fn push_script_data(output: &mut Vec<u8>, data: &[u8]) -> Result<(), EngineError> {
    match data.len() {
        0..=75 => output.push(data.len() as u8),
        76..=0xff => {
            output.push(0x4c);
            output.push(data.len() as u8);
        }
        _ => return Err(invalid_plan("FT signature push exceeds the supported width")),
    }
    output.extend_from_slice(data);
    Ok(())
}

fn script_pushes(script: &[u8]) -> Result<Vec<&[u8]>, EngineError> {
    let mut pushes = Vec::new();
    let mut offset = 0usize;
    while offset < script.len() {
        let opcode = script[offset];
        offset += 1;
        let length = match opcode {
            0..=75 => opcode as usize,
            0x4c => read_push_length(script, &mut offset, 1)?,
            0x4d => read_push_length(script, &mut offset, 2)?,
            0x4e => read_push_length(script, &mut offset, 4)?,
            _ => return Err(invalid_plan("finalized unlocking script is not push-only")),
        };
        let end = offset
            .checked_add(length)
            .ok_or_else(|| invalid_plan("finalized unlocking push length overflow"))?;
        let data = script
            .get(offset..end)
            .ok_or_else(|| invalid_plan("finalized unlocking push is truncated"))?;
        pushes.push(data);
        offset = end;
    }
    Ok(pushes)
}

fn leading_script_pushes(
    script: &[u8],
    count: usize,
) -> Result<(Vec<&[u8]>, usize), EngineError> {
    let mut pushes = Vec::with_capacity(count);
    let mut offset = 0usize;
    while pushes.len() < count {
        let opcode = *script
            .get(offset)
            .ok_or_else(|| invalid_plan("finalized Pool signature prefix is truncated"))?;
        offset += 1;
        let length = match opcode {
            0..=75 => usize::from(opcode),
            opcodes::OP_PUSHDATA1 => {
                let length = read_push_length(script, &mut offset, 1)?;
                if length <= 75 {
                    return Err(invalid_plan("finalized Pool signature push is non-minimal"));
                }
                length
            }
            opcodes::OP_PUSHDATA2 => {
                let length = read_push_length(script, &mut offset, 2)?;
                if length <= 0xff {
                    return Err(invalid_plan("finalized Pool signature push is non-minimal"));
                }
                length
            }
            _ => return Err(invalid_plan("finalized Pool signature prefix is not push-only")),
        };
        let end = offset
            .checked_add(length)
            .ok_or_else(|| invalid_plan("finalized Pool signature push length overflow"))?;
        pushes.push(
            script
                .get(offset..end)
                .ok_or_else(|| invalid_plan("finalized Pool signature push is truncated"))?,
        );
        offset = end;
    }
    Ok((pushes, offset))
}

fn read_push_length(script: &[u8], offset: &mut usize, bytes: usize) -> Result<usize, EngineError> {
    let end = offset
        .checked_add(bytes)
        .ok_or_else(|| invalid_plan("finalized unlocking length overflow"))?;
    let encoded = script
        .get(*offset..end)
        .ok_or_else(|| invalid_plan("finalized unlocking length is truncated"))?;
    *offset = end;
    let mut padded = [0u8; 8];
    padded[..bytes].copy_from_slice(encoded);
    usize::try_from(u64::from_le_bytes(padded))
        .map_err(|_| invalid_plan("finalized unlocking length is too large"))
}

#[cfg(test)]
mod task6_round1_legacy_tests {
    use super::*;
    use tbc_sdk::{OutPoint, TxIn, TxOut, Txid, script::Script};

    fn tx(script: Vec<u8>) -> Transaction {
        Transaction {
            version: tbc_sdk::TX_VERSION,
            inputs: vec![TxIn::new(OutPoint { txid: Txid::from_le_bytes([3; 32]), vout: 1 })],
            outputs: vec![
                TxOut { satoshis: 200, script_pubkey: Script::from_bytes(script) },
                TxOut { satoshis: 100, script_pubkey: Script::from_bytes(vec![0x51]) },
                TxOut { satoshis: 0, script_pubkey: Script::from_bytes(vec![0, 0x6a]) },
            ],
            lock_time: 9,
        }
    }

    #[test]
    fn legacy_chunks_embed_raw_code_where_v1_hashes_it() {
        let raw_code = vec![0x51; 142];
        let transaction = tx(raw_code.clone());
        let legacy = legacy_current_tx_data(&transaction).unwrap();
        let modern = tbc_sdk::contracts::nft::unlock::current_tx_data(&transaction).unwrap();
        assert!(legacy.windows(raw_code.len()).any(|window| window == raw_code));
        assert!(!modern.windows(raw_code.len()).any(|window| window == raw_code));
        assert_ne!(legacy_pre_tx_data(&transaction).unwrap(), tbc_sdk::contracts::nft::unlock::pre_tx_data(&transaction).unwrap());
        assert_ne!(legacy_pre_pre_tx_data(&transaction).unwrap(), tbc_sdk::contracts::nft::unlock::pre_pre_tx_data(&transaction).unwrap());
    }
}

fn validate_plan(plan: &UnsignedPlan) -> Result<(), EngineError> {
    if plan.transactions.is_empty() {
        return Err(invalid_plan("unsigned plan has no transactions"));
    }
    validate_cardinality_counts(plan.transactions.len(), 0, 0, 0)?;
    let transaction_count = u32::try_from(plan.transactions.len())
        .map_err(|_| invalid_plan("unsigned plan transaction count exceeds the wire range"))?;
    let mut total_inputs = 0usize;
    let mut total_outputs = 0usize;
    let mut total_dependencies = 0usize;
    let mut stages = BTreeSet::new();
    for transaction in &plan.transactions {
        total_inputs = total_inputs
            .checked_add(transaction.inputs.len())
            .ok_or_else(|| invalid_plan("unsigned plan input cardinality overflow"))?;
        total_outputs = total_outputs
            .checked_add(transaction.outputs.len())
            .ok_or_else(|| invalid_plan("unsigned plan output cardinality overflow"))?;
        total_dependencies = total_dependencies
            .checked_add(transaction.depends_on.len())
            .ok_or_else(|| invalid_plan("unsigned plan dependency cardinality overflow"))?;
        if transaction.stage >= transaction_count {
            return Err(invalid_plan(
                "signing stage exceeds the transaction cardinality",
            ));
        }
        stages.insert(transaction.stage);
    }
    validate_cardinality_counts(
        plan.transactions.len(),
        total_inputs,
        total_outputs,
        total_dependencies,
    )?;
    for (expected, actual) in stages.iter().copied().enumerate() {
        let expected = u32::try_from(expected)
            .map_err(|_| invalid_plan("signing stage count exceeds the wire range"))?;
        if actual != expected {
            return Err(invalid_plan("signing stages must be contiguous from zero"));
        }
    }
    validate_serialized_budget(
        plan,
        MAX_UNSIGNED_PLAN_SERIALIZED_BYTES,
        "unsigned plan exceeds the serialized byte budget",
    )?;

    validate_evidence_table(plan)?;
    let mut evidence_references = 0usize;
    let mut ids = BTreeMap::new();
    for (index, transaction) in plan.transactions.iter().enumerate() {
        if transaction.transaction_id.is_empty()
            || ids
                .insert(transaction.transaction_id.clone(), (index, transaction.stage))
                .is_some()
        {
            return Err(invalid_plan("transaction identifiers must be unique and non-empty"));
        }
        if transaction.inputs.is_empty() {
            return Err(invalid_plan("each transaction must have at least one input"));
        }
        if let Some(round) = ftlp_maintenance_round(transaction) {
            let expected_dependency = round.checked_sub(1).map(|prior| format!("ftlp-merge-{prior}"));
            if usize::try_from(transaction.stage).ok() != Some(round)
                || transaction.depends_on != expected_dependency.iter().cloned().collect::<Vec<_>>()
            {
                return Err(invalid_plan("FTLP maintenance stage or dependency chain is invalid"));
            }
        }
        for input in &transaction.inputs {
            if input.unlocking_script.starts_with(LOP_MATCH_UNLOCK_PREFIX) {
                let recipe=parse_lop_match_recipe(&input.unlocking_script)?;
                record_recipe_evidence(&recipe.parent,plan,&mut evidence_references)?;
            } else if input.unlocking_script.starts_with(AMM_POOL_UNLOCK_PREFIX) {
                let recipe=parse_amm_pool_unlock_recipe(&input.unlocking_script)?;
                for source in amm_pool_recipe_sources(&recipe){record_recipe_evidence(source,plan,&mut evidence_references)?;}
            } else if is_ecdsa_fungible_recipe(&input.unlocking_script) || input.unlocking_script.starts_with(COIN_UNLOCK_PREFIX) {
                let recipe = parse_fungible_unlock_recipe(&input.unlocking_script)?;
                for source in tbc20_recipe_sources(&recipe) {
                    record_recipe_evidence(source, plan, &mut evidence_references)?;
                }
            } else if input.unlocking_script.starts_with(TBC721_UNLOCK_PREFIX) {
                let recipe = parse_tbc721_unlock_recipe(&input.unlocking_script)?;
                for source in tbc721_recipe_sources(&recipe) {
                    record_recipe_evidence(source, plan, &mut evidence_references)?;
                }
            } else if input.unlocking_script.starts_with(POOL_UNLOCK_PREFIX) {
                let recipe = parse_pool_unlock_recipe(&input.unlocking_script)?;
                if recipe.auxiliary_parents.len() > MAX_POOL_AUXILIARY_PARENTS
                    || recipe.public_key_lock.len() > MAX_POOL_PUBLIC_KEY_LOCKS
                {
                    return Err(invalid_plan("Pool recipe exceeds a cardinality budget"));
                }
                validate_recipe_sources(
                    std::iter::once(&recipe.parent)
                        .chain(std::iter::once(&recipe.pre_parent))
                        .chain(recipe.contract.sources())
                        .chain(recipe.auxiliary_parents.iter()),
                )?;
                let mut keys = BTreeSet::new();
                for key in &recipe.public_key_lock {
                    let parsed = parse_public_key(key)?;
                    if !keys.insert(parsed.to_bytes()) {
                        return Err(invalid_plan("Pool public-key-lock set contains duplicates"));
                    }
                }
                for source in std::iter::once(&recipe.parent)
                    .chain(std::iter::once(&recipe.pre_parent))
                    .chain(recipe.contract.sources())
                    .chain(recipe.auxiliary_parents.iter())
                {
                    record_recipe_evidence(source, plan, &mut evidence_references)?;
                }
            } else if input.unlocking_script.starts_with(POOL_HELD_FT_UNLOCK_PREFIX) {
                let recipe = parse_pool_held_ft_unlock_recipe(&input.unlocking_script)?;
                validate_proof_count(&recipe.proof_references)?;
                validate_recipe_sources(
                    std::iter::once(&recipe.parent)
                        .chain(std::iter::once(&recipe.contract))
                        .chain(recipe.proof_references.iter().map(|proof| &proof.source)),
                )?;
                if !(1..=4).contains(&recipe.ft_version)
                    || recipe.logical_swap_input_index > 5
                {
                    return Err(invalid_plan("Pool-held FT recipe fields are unsupported"));
                }
                for source in std::iter::once(&recipe.parent)
                    .chain(std::iter::once(&recipe.contract))
                    .chain(recipe.proof_references.iter().map(|proof| &proof.source))
                {
                    record_recipe_evidence(source, plan, &mut evidence_references)?;
                }
            } else if input.unlocking_script.starts_with(FTLP_UNLOCK_PREFIX) {
                let recipe = parse_ftlp_unlock_recipe(&input.unlocking_script)?;
                validate_proof_count(&recipe.proof_references)?;
                validate_recipe_sources(
                    std::iter::once(&recipe.parent)
                        .chain(recipe.proof_references.iter().map(|proof| &proof.source)),
                )?;
                for source in std::iter::once(&recipe.parent)
                    .chain(recipe.proof_references.iter().map(|proof| &proof.source))
                {
                    record_recipe_evidence(source, plan, &mut evidence_references)?;
                }
            } else if input.unlocking_script.starts_with(FT_UNLOCK_PREFIX) {
                let recipe = parse_ft_unlock_recipe(&input.unlocking_script)?;
                if recipe.proof_references.is_empty() || recipe.proof_references.len() > 6 {
                    return Err(invalid_plan(
                        "FT unlocking recipe must contain between one and six proofs",
                    ));
                }
                validate_evidence_reference(&recipe.parent, plan)?;
                evidence_references = evidence_references
                    .checked_add(usize::from(matches!(recipe.parent, FtTransactionSource::Evidence(_))))
                    .and_then(|count| count.checked_add(recipe.proof_references.len()))
                    .ok_or_else(|| invalid_plan("FT evidence reference cardinality overflow"))?;
                for reference in &recipe.proof_references {
                    validate_evidence_reference(&reference.source, plan)?;
                }
            } else if input.unlocking_script.starts_with(NFT_UNLOCK_PREFIX) {
                let recipe = parse_nft_unlock_recipe(&input.unlocking_script)?;
                validate_evidence_reference(&recipe.parent, plan)?;
                validate_evidence_reference(&recipe.pre_pre, plan)?;
                evidence_references = evidence_references
                    .checked_add(usize::from(matches!(recipe.parent, FtTransactionSource::Evidence(_))))
                    .and_then(|count| count.checked_add(usize::from(matches!(recipe.pre_pre, FtTransactionSource::Evidence(_)))))
                    .ok_or_else(|| invalid_plan("NFT evidence reference cardinality overflow"))?;
                let empty = SigningContinuation {
                    session_id: String::new(),
                    plan_commitment: String::new(),
                    next_stage: 0,
                    finalized_transactions: vec![None; plan.transactions.len()],
                };
                let parent = resolve_source(&recipe.parent, plan, &empty)?;
                let pre_pre = resolve_source(&recipe.pre_pre, plan, &empty)?;
                if parent.txid().to_string() != input.previous_transaction_id || parent.inputs.first().is_none_or(|source| source.previous_output.txid != pre_pre.txid()) {
                    return Err(invalid_plan("NFT ancestry recipe does not bind the planned parent"));
                }
            } else if input.unlocking_script == LOP_CANCEL_DESCRIPTOR {
                let previous = resolve_previous_output_script(input, plan)?;
                let code = crate::protocols::lop::Code::decode(previous.as_bytes())
                    .map_err(|_| invalid_plan("LOP input has an unsupported Code"))?;
                let key = validate_public_identity(&input.signer)?;
                if code.terms.owner_hash != key.hash160() {
                    return Err(invalid_plan("LOP cancellation signer is not the order owner"));
                }
            } else if is_htlc_descriptor(&input.unlocking_script) {
                let previous = resolve_previous_output_script(input, plan)?;
                let code = crate::protocols::htlc::Code::decode(previous.as_bytes())
                    .map_err(|_| invalid_plan("HTLC input has an unsupported Code"))?;
                let key = validate_public_identity(&input.signer)?;
                HtlcBranch::parse(&input.unlocking_script)?.verify(&code, &key.hash160(), input.sequence, transaction.lock_time)?;
            } else if input.unlocking_script == TIMELOCK_UNLOCK_DESCRIPTOR {
                let previous = resolve_previous_output_script(input, plan)?;
                let code = crate::protocols::timelock::Code::decode(previous.as_bytes())
                    .map_err(|_| invalid_plan("Timelock input has an unsupported Code"))?;
                // The pure signer has no chain view. Height freshness is bound
                // by the caller's snapshot/planner; here verify script conditions.
                code.validate_height_spend(input.sequence, transaction.lock_time, transaction.lock_time)
                    .map_err(|_| invalid_plan("Timelock signing plan violates its height or sequence condition"))?;
            } else if !input.unlocking_script.is_empty() {
                return Err(invalid_plan("unknown unlocking descriptor"));
            }
            if evidence_references > MAX_EVIDENCE_REFERENCES {
                return Err(invalid_plan("evidence references exceed the cardinality budget"));
            }
        }
        for (output_index,output) in transaction.outputs.iter().enumerate() {
            validate_locking_script_descriptor(&output.locking_script)?;
            if output.locking_script.starts_with(crate::protocols::amm_genesis::OUTPUT_PREFIX) {
                let descriptor=crate::protocols::amm_genesis::parse_output(&output.locking_script)?;
                if output_index!=descriptor.part as usize{return Err(invalid_plan("AMM genesis descriptor at wrong output position"));}
                if !transaction.outputs[0].locking_script.starts_with(crate::protocols::amm_genesis::OUTPUT_PREFIX){return Err(invalid_plan("AMM genesis descriptors require the shared Code output"));}
                if output_index!=0{continue;}
                let source=plan.transactions.iter().find(|source|source.transaction_id==descriptor.parent_id)
                    .ok_or_else(||invalid_plan("AMM genesis Source missing"))?;
                if source.stage>=transaction.stage||source.outputs.len()!=1||transaction.inputs.len()!=1
                    ||transaction.inputs[0].previous_transaction_id!=descriptor.parent_id||transaction.inputs[0].previous_output_index!=0
                    ||!(4..=5).contains(&transaction.outputs.len()) {
                    return Err(invalid_plan("AMM genesis must consume its single earlier Source root"));
                }
                for part in 0..3 {
                    let sibling=crate::protocols::amm_genesis::parse_output(&transaction.outputs[part].locking_script)?;
                    if sibling.part!=part as u8||sibling.parent_id!=descriptor.parent_id||sibling.definition!=descriptor.definition
                        ||transaction.outputs[part].satoshis!=[1500,0,500][part] {
                        return Err(invalid_plan("AMM genesis output descriptors disagree on identity or position"));
                    }
                }
                if transaction.outputs[3].satoshis!=0{return Err(invalid_plan("AMM genesis FT Tape value must be zero"));}
                descriptor.definition.validate_zero_ft_tape(parse_script(&transaction.outputs[3].locking_script,"ammGenesisFtTape")?.as_bytes())?;
            }
            if output.locking_script.starts_with(crate::protocols::tbc20_mint::OUTPUT_PREFIX) {
                let descriptor = crate::protocols::tbc20_mint::parse_output(&output.locking_script)?;
                if !transaction.inputs.iter().any(|input|
                    input.previous_transaction_id == descriptor.parent_id
                        && input.previous_output_index == descriptor.source_vout)
                    || !plan.transactions.iter().any(|source|
                        source.transaction_id == descriptor.parent_id && source.stage < transaction.stage)
                {
                    return Err(invalid_plan("TBC20 genesis must consume its declared earlier Source output"));
                }
            }
        }
    }

    let final_pool_consumes = validate_final_pool_consumes(plan)?;
    for transaction in &plan.transactions {
        validate_ftlp_recipe_order(transaction, plan, &final_pool_consumes)?;
    }

    for transaction in &plan.transactions {
        let dependencies = transaction.depends_on.iter().collect::<BTreeSet<_>>();
        if dependencies.len() != transaction.depends_on.len() {
            return Err(invalid_plan("transaction dependencies must be unique"));
        }
        for dependency in &transaction.depends_on {
            let (_, dependency_stage) = ids
                .get(dependency)
                .ok_or_else(|| invalid_plan("transaction dependency does not exist"))?;
            if *dependency_stage >= transaction.stage {
                return Err(invalid_plan("transaction dependency is not in an earlier stage"));
            }
        }
        let mut expected_dependencies = Vec::new();
        for input in &transaction.inputs {
            if ids.contains_key(&input.previous_transaction_id)
                && !expected_dependencies.contains(&input.previous_transaction_id)
            {
                expected_dependencies.push(input.previous_transaction_id.clone());
            }
        }
        if transaction.depends_on != expected_dependencies {
            return Err(invalid_plan(
                "transaction dependencies must follow internal input order",
            ));
        }
        for input in &transaction.inputs {
            if input.unlocking_script.starts_with(LOP_MATCH_UNLOCK_PREFIX) {
                let recipe=parse_lop_match_recipe(&input.unlocking_script)?;
                validate_stage_recipe_source(&recipe.parent,transaction,plan)?;
            } else if input.unlocking_script.starts_with(AMM_POOL_UNLOCK_PREFIX) {
                let recipe=parse_amm_pool_unlock_recipe(&input.unlocking_script)?;
                for source in amm_pool_recipe_sources(&recipe){validate_stage_recipe_source(source,transaction,plan)?;}
            } else if is_ecdsa_fungible_recipe(&input.unlocking_script) || input.unlocking_script.starts_with(COIN_UNLOCK_PREFIX) {
                let recipe = parse_fungible_unlock_recipe(&input.unlocking_script)?;
                for source in tbc20_recipe_sources(&recipe) {
                    validate_stage_recipe_source(source, transaction, plan)?;
                }
            } else if input.unlocking_script.starts_with(TBC721_UNLOCK_PREFIX) {
                let recipe = parse_tbc721_unlock_recipe(&input.unlocking_script)?;
                for source in tbc721_recipe_sources(&recipe) {
                    validate_stage_recipe_source(source, transaction, plan)?;
                }
            } else if input.unlocking_script.starts_with(POOL_UNLOCK_PREFIX) {
                let recipe = parse_pool_unlock_recipe(&input.unlocking_script)?;
                for source in std::iter::once(&recipe.parent)
                    .chain(std::iter::once(&recipe.pre_parent))
                    .chain(recipe.contract.sources())
                    .chain(recipe.auxiliary_parents.iter())
                {
                    validate_stage_recipe_source(source, transaction, plan)?;
                }
            } else if input.unlocking_script.starts_with(POOL_HELD_FT_UNLOCK_PREFIX) {
                let recipe = parse_pool_held_ft_unlock_recipe(&input.unlocking_script)?;
                for source in std::iter::once(&recipe.parent)
                    .chain(std::iter::once(&recipe.contract))
                    .chain(recipe.proof_references.iter().map(|proof| &proof.source))
                {
                    validate_stage_recipe_source(source, transaction, plan)?;
                }
            } else if input.unlocking_script.starts_with(FTLP_UNLOCK_PREFIX) {
                let recipe = parse_ftlp_unlock_recipe(&input.unlocking_script)?;
                for source in std::iter::once(&recipe.parent)
                    .chain(recipe.proof_references.iter().map(|proof| &proof.source))
                {
                    validate_stage_recipe_source(source, transaction, plan)?;
                }
            }
            let previous_script = resolve_previous_output_script_from_plan(input, plan)?;
            if is_schnorr_context(&input.signer) {
                validate_schnorr_context(input,&previous_script)?;
            } else if input.unlocking_script.starts_with(FTLP_UNLOCK_PREFIX)
                || input.unlocking_script.starts_with(POOL_UNLOCK_PREFIX)
                || input
                    .unlocking_script
                    .starts_with(POOL_HELD_FT_UNLOCK_PREFIX)
            {
                validate_public_identity(&input.signer)?;
            } else {
                validate_public_context(&input.signer, &previous_script, &input.unlocking_script)?;
            }
            if let Some((parent_index, parent_stage)) = ids.get(&input.previous_transaction_id) {
                if !dependencies.contains(&input.previous_transaction_id) {
                    return Err(invalid_plan("internal input is not declared as a dependency"));
                }
                if *parent_stage >= transaction.stage {
                    return Err(invalid_plan("internal input parent is not finalized earlier"));
                }
                let parent_output = plan.transactions[*parent_index]
                    .outputs
                    .get(input.previous_output_index as usize)
                    .ok_or_else(|| invalid_plan("internal input output index is out of range"))?;
                if parent_output.satoshis != input.previous_output_satoshis
                    || parent_output.locking_script != input.previous_output_script
                {
                    return Err(invalid_plan("internal input does not match its parent output"));
                }
            } else {
                parse_txid(&input.previous_transaction_id)?;
            }
        }
    }
    validate_global_input_uniqueness(plan, None)?;
    Ok(())
}

fn record_recipe_evidence(
    source: &TransactionSource,
    plan: &UnsignedPlan,
    count: &mut usize,
) -> Result<(), EngineError> {
    validate_evidence_reference(source, plan)?;
    if matches!(source, TransactionSource::Evidence(_)) {
        *count = count
            .checked_add(1)
            .ok_or_else(|| invalid_plan("Pool evidence reference cardinality overflow"))?;
    }
    Ok(())
}

fn validate_stage_recipe_source(
    source: &TransactionSource,
    transaction: &PlannedTransaction,
    plan: &UnsignedPlan,
) -> Result<(), EngineError> {
    let TransactionSource::Planned(id) = source else {
        return Ok(());
    };
    let mut transactions = BTreeMap::new();
    for candidate in &plan.transactions {
        if transactions
            .insert(candidate.transaction_id.as_str(), candidate)
            .is_some()
        {
            return Err(invalid_plan(
                "transaction identifiers must be unique and non-empty",
            ));
        }
    }
    let source_transaction = transactions
        .get(id.as_str())
        .ok_or_else(|| invalid_plan("Pool recipe planned source does not exist"))?;
    if source_transaction.stage >= transaction.stage {
        return Err(invalid_plan(
            "Pool recipe planned source is not an earlier declared dependency",
        ));
    }

    let direct_dependencies = transaction.depends_on.iter().collect::<BTreeSet<_>>();
    if direct_dependencies.len() != transaction.depends_on.len() {
        return Err(invalid_plan("transaction dependencies must be unique"));
    }
    let mut pending = transaction
        .depends_on
        .iter()
        .rev()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let mut visited = BTreeSet::new();
    let mut reachable = false;
    while let Some(candidate_id) = pending.pop() {
        if !visited.insert(candidate_id) {
            continue;
        }
        let candidate = transactions
            .get(candidate_id)
            .ok_or_else(|| invalid_plan("transaction dependency does not exist"))?;
        if candidate.stage >= transaction.stage {
            return Err(invalid_plan(
                "transaction dependency is not in an earlier stage",
            ));
        }
        let dependencies = candidate.depends_on.iter().collect::<BTreeSet<_>>();
        if dependencies.len() != candidate.depends_on.len() {
            return Err(invalid_plan("transaction dependencies must be unique"));
        }
        for dependency_id in candidate.depends_on.iter().rev() {
            let dependency = transactions
                .get(dependency_id.as_str())
                .ok_or_else(|| invalid_plan("transaction dependency does not exist"))?;
            if dependency.stage >= candidate.stage {
                return Err(invalid_plan(
                    "transaction dependency is not in an earlier stage",
                ));
            }
            pending.push(dependency_id);
        }
        reachable |= candidate_id == id;
    }
    if reachable {
        Ok(())
    } else {
        Err(invalid_plan(
            "Pool recipe planned source is not an earlier declared dependency",
        ))
    }
}

fn ftlp_maintenance_round(transaction: &PlannedTransaction) -> Option<usize> {
    if transaction.role != "maintenance" {
        return None;
    }
    transaction
        .transaction_id
        .strip_prefix("ftlp-merge-")
        .filter(|round| !round.is_empty())
        .and_then(|round| round.parse::<usize>().ok().filter(|parsed| parsed.to_string() == round))
}

fn resolve_ftlp_code_tape(
    input: &PlannedInput,
    recipe: &FtlpUnlockRecipe,
    plan: &UnsignedPlan,
) -> Result<(Transaction, Script, Script, u128), EngineError> {
    let tape_index = input
        .previous_output_index
        .checked_add(1)
        .ok_or_else(|| invalid_plan("FTLP maintenance input Code/Tape pair is invalid"))?;
    let (source_id, parent) =
        match &recipe.parent {
            TransactionSource::Planned(id) => {
                let planned = plan
                    .transactions
                    .iter()
                    .find(|transaction| transaction.transaction_id == *id)
                    .ok_or_else(|| invalid_plan("FTLP maintenance parent does not exist"))?;
                (id.clone(), materialize_unsigned_preview(planned, plan)?)
            }
            source => {
                let empty = SigningContinuation {
                    session_id: String::new(),
                    plan_commitment: String::new(),
                    next_stage: 0,
                    finalized_transactions: vec![None; plan.transactions.len()],
                };
                let parent = resolve_source(source, plan, &empty)?;
                (parent.txid().to_string(), parent)
            }
        };
    let code = parent
        .outputs
        .get(input.previous_output_index as usize)
        .ok_or_else(|| invalid_plan("FTLP maintenance parent Code output is missing"))?;
    let tape = parent
        .outputs
        .get(tape_index as usize)
        .ok_or_else(|| invalid_plan("FTLP maintenance parent Tape output is missing"))?;
    let code_satoshis = code.satoshis;
    let code_script = code.script_pubkey.clone();
    let tape_satoshis = tape.satoshis;
    let tape_script = tape.script_pubkey.clone();
    if source_id != input.previous_transaction_id
        || code_satoshis != input.previous_output_satoshis
        || code_satoshis != FTLP_CODE_SATOSHIS
        || tape_satoshis != FTLP_TAPE_SATOSHIS
        || code_script != resolve_previous_output_script_from_plan(input, plan)?
    {
        return Err(invalid_plan("FTLP maintenance input Code/Tape pair is invalid"));
    }
    let balance = balance_from_tape(&tape_script)
        .map_err(|_| invalid_plan("FTLP maintenance parent Tape amount is invalid"))?;
    Ok((parent, code_script, tape_script, balance))
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FtlpAuthorityBinding {
    pool_hash: [u8; 32],
    ft_lp_partial_hash: Vec<u8>,
    ft_version: FtScriptVersion,
    is_coin: bool,
    source_ft_tape_size: usize,
    locked: bool,
}

fn resolve_source_for_plan_validation(
    source: &TransactionSource,
    plan: &UnsignedPlan,
) -> Result<Transaction, EngineError> {
    match source {
        TransactionSource::Planned(id) => plan
            .transactions
            .iter()
            .find(|transaction| transaction.transaction_id == *id)
            .ok_or_else(|| invalid_plan("FTLP maintenance Pool authority source does not exist"))
            .and_then(|transaction| materialize_unsigned_preview(transaction, plan)),
        source => {
            let empty = SigningContinuation {
                session_id: String::new(),
                plan_commitment: String::new(),
                next_stage: 0,
                finalized_transactions: vec![None; plan.transactions.len()],
            };
            resolve_source(source, plan, &empty)
        }
    }
}

fn ft_script_version(version: u8) -> Result<FtScriptVersion, EngineError> {
    match version {
        1 => Ok(FtScriptVersion::V1),
        2 => Ok(FtScriptVersion::V2),
        3 => Ok(FtScriptVersion::V3),
        4 => Ok(FtScriptVersion::V4),
        _ => Err(invalid_plan("FTLP maintenance Pool authority FT version is unsupported")),
    }
}

fn pool_authority_binding(
    transaction: &PlannedTransaction,
    plan: &UnsignedPlan,
    expected_ftlp_successor: &str,
) -> Result<Option<FtlpAuthorityBinding>, EngineError> {
    let Some((input_index, input)) = transaction
        .inputs
        .iter()
        .enumerate()
        .find(|(_, input)| input.unlocking_script.starts_with(POOL_UNLOCK_PREFIX))
    else {
        return Ok(None);
    };
    if input_index != 0 {
        return Err(invalid_plan("FTLP maintenance Pool authority input is not input zero"));
    }
    let recipe = parse_pool_unlock_recipe(&input.unlocking_script)?;
    let mut parent = resolve_source_for_plan_validation(&recipe.parent, plan)?;
    let pool_parent_source_txid = parent.txid();
    let pre_parent = resolve_source_for_plan_validation(&recipe.pre_parent, plan)?;
    let contract = recipe.contract.resolve(|source| resolve_source_for_plan_validation(source, plan))?;
    let pool_code = parent
        .outputs
        .get(recipe.spent_vout as usize)
        .cloned()
        .ok_or_else(|| invalid_plan("FTLP maintenance Pool authority Code is missing"))?;
    let pool_tape = parent
        .outputs
        .get(1)
        .cloned()
        .ok_or_else(|| invalid_plan("FTLP maintenance Pool authority Tape is missing"))?;
    let expected_parent_id = match &recipe.parent {
        TransactionSource::Planned(id) => id.clone(),
        _ => parent.txid().to_string(),
    };
    if expected_parent_id != input.previous_transaction_id
        || recipe.spent_vout != input.previous_output_index
        || pool_code.satoshis != input.previous_output_satoshis
        || parse_script(&input.previous_output_script, "ftlpMaintenancePoolCode")?
            != pool_code.script_pubkey
    {
        return Err(invalid_plan("FTLP maintenance Pool authority outpoint is inconsistent"));
    }
    let state = PoolState::from_v2_tape(&pool_tape.script_pubkey, recipe.service_provider)
        .map_err(|_| invalid_plan("FTLP maintenance Pool authority state Tape is invalid"))?;
    let mut authorities = Vec::new();
    for (code, tape) in contract.pairs(&state).map_err(|_| invalid_plan("FTLP maintenance Pool authority released context is invalid"))? {
        let Ok(classified) = classify_ft_script(&code) else {
            continue;
        };
        let Ok(partial_end) = partial_hash_offset(classified.version, classified.is_coin) else {
            continue;
        };
        let Some(partial_script) = code.as_bytes().get(..partial_end) else {
            continue;
        };
        if calculate_partial_hash(partial_script).as_slice() != state.ft_a_partial_hash.as_slice()
            || balance_from_tape(&tape).is_err()
        {
            continue;
        }
        authorities.push((
            ft_script_version(classified.version)?,
            classified.is_coin,
            tape.as_bytes().len(),
            code,
            tape,
        ));
    }
    if authorities.len() != 1 {
        return Err(invalid_plan(
            "FTLP maintenance Pool authority must contain one released FT Code/Tape pair",
        ));
    }
    let (ft_version, is_coin, source_ft_tape_size, _authority_code, authority_tape) =
        authorities.pop().expect("length checked");

    let prior_pool_tape = pre_parent
        .outputs
        .get(1)
        .ok_or_else(|| invalid_plan("FTLP maintenance Pool authority pre-parent Tape is missing"))?;
    let prior_state = PoolState::from_v2_tape(
        &prior_pool_tape.script_pubkey,
        state.service_provider.clone(),
    )
    .map_err(|_| invalid_plan("FTLP maintenance Pool authority released context is invalid"))?;
    if pre_parent.outputs.first().is_none_or(|output| {
        output.script_pubkey != pool_code.script_pubkey
    }) || prior_state.ft_lp_partial_hash != state.ft_lp_partial_hash
        || prior_state.ft_a_partial_hash != state.ft_a_partial_hash
        || prior_state.ft_a_contract_id != state.ft_a_contract_id
        || prior_state.service_fee_rate != state.service_fee_rate
        || prior_state.lp_plan != state.lp_plan
        || prior_state.public_key_locked != state.public_key_locked
        || prior_state.ftlp_lock_time_enabled != state.ftlp_lock_time_enabled
    {
        return Err(invalid_plan(
            "FTLP maintenance Pool immutable state or LP partial hash is inconsistent",
        ));
    }

    let pushes = canonical_op_return_pushes(&authority_tape)
        .map_err(|_| invalid_plan("FTLP maintenance Pool authority released context is invalid"))?;
    let expected_push_count = if is_coin { 6 } else { 5 };
    if pushes.len() != expected_push_count
        || pushes.first().is_none_or(|amount| amount.len() != 48)
        || pushes.get(1).is_none_or(|decimal| decimal.len() != 1)
        || pushes.last().map(Vec::as_slice) != Some(b"FTape")
        || (is_coin && pushes.get(4).is_none_or(|suffix| suffix.len() != 4))
    {
        return Err(invalid_plan(
            "FTLP maintenance Pool authority released context is invalid",
        ));
    }
    if pushes[1][0] > 18 {
        return Err(invalid_plan("FTLP maintenance Pool authority released context is invalid"));
    }
    balance_from_tape(&authority_tape)
        .map_err(|_| invalid_plan("FTLP maintenance Pool authority released context is invalid"))?;
    String::from_utf8(pushes[2].clone())
        .map_err(|_| invalid_plan("FTLP maintenance Pool authority released context is invalid"))?;
    String::from_utf8(pushes[3].clone())
        .map_err(|_| invalid_plan("FTLP maintenance Pool authority released context is invalid"))?;

    let expected_pre_parent_id = match &recipe.pre_parent {
        TransactionSource::Planned(id) => id.clone(),
        _ => pre_parent.txid().to_string(),
    };
    let parent_predecessor_matches = match &recipe.parent {
        TransactionSource::Planned(id) => plan
            .transactions
            .iter()
            .find(|transaction| transaction.transaction_id == *id)
            .and_then(|transaction| transaction.inputs.first())
            .is_some_and(|input| input.previous_transaction_id == expected_pre_parent_id),
        _ => parent
            .inputs
            .first()
            .is_some_and(|input| input.previous_output.txid == pre_parent.txid()),
    };
    if !parent_predecessor_matches {
        return Err(invalid_plan(
            "FTLP maintenance Pool authority predecessor lineage is invalid",
        ));
    }
    parent
        .inputs
        .first_mut()
        .expect("released Pool parent has an authenticated predecessor")
        .previous_output
        .txid = pre_parent.txid();

    let pool_utxo = UtxoInfo {
        outpoint: OutPoint { txid: parent.txid(), vout: recipe.spent_vout },
        satoshis: pool_code.satoshis,
        script_pubkey: pool_code.script_pubkey.clone(),
    };
    let pool = PoolSpendContext {
        pool_utxo: pool_utxo.clone(),
        pool_pre_tx: parent,
        pool_pre_pre_tx: pre_parent,
        contract_tx: contract,
        state: state.clone(),
    };
    if recipe.operation != PoolRecipeOperation::ConsumeLiquidity || recipe.swap.is_some() {
        return Err(invalid_plan(
            "FTLP maintenance descendant Pool operation context is invalid",
        ));
    }
    let final_consume_identity = matches!(
        transaction.transaction_id.as_str(),
        "pool-liquidity-remove" | "pool-liquidity-close"
    );
    let pool_ft_count = transaction.inputs.len().saturating_sub(3);
    let exact_input_shape = final_consume_identity
        && transaction.inputs.len() >= 4
        && transaction.inputs[0].unlocking_script.starts_with(POOL_UNLOCK_PREFIX)
        && transaction.inputs[1].unlocking_script.starts_with(FTLP_UNLOCK_PREFIX)
        && (1..=MAX_FINAL_POOL_CONSUME_FT_INPUTS).contains(&pool_ft_count)
        && transaction.inputs[2..2 + pool_ft_count]
            .iter()
            .all(|input| input.unlocking_script.starts_with(POOL_HELD_FT_UNLOCK_PREFIX))
        && transaction
            .inputs
            .last()
            .is_some_and(|input| input.unlocking_script.is_empty());
    if !exact_input_shape {
        return Err(invalid_plan(
            "FTLP maintenance descendant Pool input shape is invalid",
        ));
    }
    let first_auxiliary_id = recipe
        .auxiliary_parents
        .first()
        .map(|source| match source {
            TransactionSource::Planned(id) => Ok(id.clone()),
            source => resolve_source_for_plan_validation(source, plan)
                .map(|transaction| transaction.txid().to_string()),
        })
        .transpose()?;
    if transaction.inputs.get(1).is_none_or(|asset| {
        asset.previous_transaction_id != expected_ftlp_successor
            || !asset.unlocking_script.starts_with(FTLP_UNLOCK_PREFIX)
    }) || recipe.auxiliary_parents.len() != transaction.inputs.len().saturating_sub(1)
        || first_auxiliary_id.as_deref() != Some(expected_ftlp_successor)
    {
        return Err(invalid_plan(
            "FTLP maintenance descendant Pool operation context is invalid",
        ));
    }

    let mut descendant = materialize_unsigned_preview(transaction, plan)?;
    descendant.inputs[0].previous_output.txid = pool.pool_pre_tx.txid();
    let mut input_parents = Vec::with_capacity(recipe.auxiliary_parents.len());
    for ((planned_input, materialized_input), source) in transaction
        .inputs
        .iter()
        .skip(1)
        .zip(descendant.inputs.iter_mut().skip(1))
        .zip(&recipe.auxiliary_parents)
    {
        let parent = resolve_source_for_plan_validation(source, plan)?;
        let expected_parent_id = match source {
            TransactionSource::Planned(id) => id.clone(),
            _ => parent.txid().to_string(),
        };
        let Some(parent_output) = parent.outputs.get(planned_input.previous_output_index as usize)
        else {
            return Err(invalid_plan(
                "FTLP maintenance descendant Pool operation context is invalid",
            ));
        };
        if expected_parent_id != planned_input.previous_transaction_id
            || parent_output.satoshis != planned_input.previous_output_satoshis
            || parse_script(
                &planned_input.previous_output_script,
                "ftlpMaintenanceDescendantInput",
            )? != parent_output.script_pubkey
        {
            return Err(invalid_plan(
                "FTLP maintenance descendant Pool operation context is invalid",
            ));
        }
        materialized_input.previous_output.txid = parent.txid();
        input_parents.push(parent);
    }

    for input_index in 2..2 + pool_ft_count {
        let planned_input = &transaction.inputs[input_index];
        let held_recipe = parse_pool_held_ft_unlock_recipe(&planned_input.unlocking_script)?;
        let parent = &input_parents[input_index - 1];
        let held_parent = resolve_source_for_plan_validation(&held_recipe.parent, plan)?;
        let held_contract = resolve_source_for_plan_validation(&held_recipe.contract, plan)?;
        let parent_output = parent
            .outputs
            .get(planned_input.previous_output_index as usize)
            .ok_or_else(|| {
                invalid_plan("FTLP maintenance descendant Pool input shape is invalid")
            })?;
        let contract_output = held_contract
            .outputs
            .get(transaction.inputs[0].previous_output_index as usize)
            .ok_or_else(|| {
                invalid_plan("FTLP maintenance descendant Pool input shape is invalid")
            })?;
        let classified = classify_ft_script(&parent_output.script_pubkey).map_err(|_| {
            invalid_plan("FTLP maintenance descendant Pool input shape is invalid")
        })?;
        let expected_code = pool_held_ft_code(
            &parent_output.script_pubkey,
            tbc_sdk::hash::hash160(&contract_output.script_pubkey.sha256()),
        )
        .map_err(|_| invalid_plan("FTLP maintenance descendant Pool input shape is invalid"))?;
        validate_pool_held_ft_proofs(
            &held_recipe.parent,
            &held_parent,
            planned_input.previous_output_index as usize,
            &held_recipe.proof_references,
            plan,
        )?;
        if held_parent.txid() != parent.txid()
            || held_contract.txid() != pool_parent_source_txid
            || expected_code != parent_output.script_pubkey
            || held_recipe.ft_version != classified.version
            || held_recipe.coin_mode != classified.is_coin
            || held_recipe.logical_swap_input_index != u8::try_from(input_index - 1).unwrap()
        {
            return Err(invalid_plan(
                "FTLP maintenance descendant Pool input shape is invalid",
            ));
        }
    }
    let fee_input = transaction.inputs.last().expect("shape checked");
    let fee_script = parse_script(
        &fee_input.previous_output_script,
        "ftlpMaintenanceDescendantFeeInput",
    )?;
    validate_public_context(&fee_input.signer, &fee_script, &fee_input.unlocking_script)
        .map_err(|_| invalid_plan("FTLP maintenance descendant Pool input shape is invalid"))?;
    let public_key_lock = recipe
        .public_key_lock
        .iter()
        .map(|key| parse_public_key(key))
        .collect::<Result<Vec<_>, _>>()?;
    let option = PoolUnlockOption::ConsumeLiquidity;
    let swap_option = None;
    pool_outputs_data(&descendant, option, recipe.with_lock, swap_option)
        .map_err(|_| {
            invalid_plan("FTLP maintenance descendant Pool operation context is invalid")
        })?;
    pool_unlock_requires_signature(&PoolUnlockContext {
        transaction: &descendant,
        input_index: 0,
        spent_vout: recipe.spent_vout,
        pool: &pool,
        input_parents: &input_parents,
        option,
        swap_option,
        with_lock: recipe.with_lock,
        signature: None,
        public_key_lock: &public_key_lock,
    })
    .map_err(|_| invalid_plan("FTLP maintenance Pool authority released context is invalid"))?;

    Ok(Some(FtlpAuthorityBinding {
        pool_hash: Sha256::digest(pool_code.script_pubkey.as_bytes()).into(),
        ft_lp_partial_hash: state.ft_lp_partial_hash,
        ft_version,
        is_coin,
        source_ft_tape_size,
        locked: state.ftlp_lock_time_enabled,
    }))
}

fn tape_source_indexes(tape: &Script, message: &'static str) -> Result<Vec<usize>, EngineError> {
    let pushes = canonical_op_return_pushes(tape).map_err(|_| invalid_plan(message))?;
    let amounts = pushes
        .first()
        .filter(|amounts| amounts.len() == 48)
        .ok_or_else(|| invalid_plan(message))?;
    Ok((0..6)
        .rev()
        .filter(|index| amounts[index * 8..index * 8 + 8] != [0; 8])
        .collect())
}

fn validate_pool_held_ft_proofs(
    parent_source: &TransactionSource,
    parent: &Transaction,
    spent_vout: usize,
    proof_references: &[ProofReference],
    plan: &UnsignedPlan,
) -> Result<(), EngineError> {
    const MESSAGE: &str = "FTLP maintenance descendant Pool-held FT proof set is invalid";
    if let TransactionSource::Planned(parent_id) = parent_source {
        let planned = plan
            .transactions
            .iter()
            .find(|transaction| transaction.transaction_id == *parent_id)
            .ok_or_else(|| invalid_plan(MESSAGE))?;
        let tape = parent.outputs.get(spent_vout + 1).ok_or_else(|| invalid_plan(MESSAGE))?;
        let source_indexes = tape_source_indexes(&tape.script_pubkey, MESSAGE)?;
        let selected_outpoints = source_indexes
            .into_iter()
            .map(|source_index| {
                planned
                    .inputs
                    .get(source_index)
                    .map(|source| {
                        (
                            source.previous_transaction_id.clone(),
                            source.previous_output_index,
                        )
                    })
                    .ok_or_else(|| invalid_plan(MESSAGE))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let proof_outpoints = proof_references
            .iter()
            .map(|proof| {
                Ok((
                    planned_source_identity_and_output(
                        &proof.source,
                        proof.output_index,
                        plan,
                    )?,
                    proof.output_index,
                ))
            })
            .collect::<Result<Vec<_>, EngineError>>()?;
        return validate_exact_recipe_proof_pairs(
            &selected_outpoints,
            &proof_outpoints,
            MESSAGE,
        );
    }
    let proofs = proof_references
        .iter()
        .map(|reference| resolve_source_for_plan_validation(&reference.source, plan))
        .collect::<Result<Vec<_>, _>>()?;
    let tape = parent.outputs.get(spent_vout + 1).ok_or_else(|| invalid_plan(MESSAGE))?;
    let source_indexes = tape_source_indexes(&tape.script_pubkey, MESSAGE)?;
    let selected_outpoints = source_indexes
        .into_iter()
        .map(|source_index| {
            parent
                .inputs
                .get(source_index)
                .map(|source| {
                    (
                        source.previous_output.txid.to_string(),
                        source.previous_output.vout,
                    )
                })
                .ok_or_else(|| invalid_plan(MESSAGE))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let proof_outpoints = proof_references
        .iter()
        .zip(&proofs)
        .map(|(reference, proof)| {
            proof
                .outputs
                .get(reference.output_index as usize)
                .ok_or_else(|| invalid_plan(MESSAGE))?;
            Ok((proof.txid().to_string(), reference.output_index))
        })
        .collect::<Result<Vec<_>, EngineError>>()?;
    validate_exact_recipe_proof_pairs(&selected_outpoints, &proof_outpoints, MESSAGE)?;
    tbc_sdk::contracts::ft::unlock::pre_pre_tx_data_from_parents(parent, spent_vout, &proofs)
        .map_err(|_| invalid_plan(MESSAGE))?;
    Ok(())
}

fn validate_final_pool_consumes(
    plan: &UnsignedPlan,
) -> Result<BTreeMap<(String, u32), FtlpAuthorityBinding>, EngineError> {
    let mut bindings = BTreeMap::new();
    for transaction in &plan.transactions {
        let canonical_consume_id = matches!(
            transaction.transaction_id.as_str(),
            "pool-liquidity-remove" | "pool-liquidity-close"
        );
        let pool_recipes = transaction
            .inputs
            .iter()
            .filter(|input| input.unlocking_script.starts_with(POOL_UNLOCK_PREFIX))
            .map(|input| parse_pool_unlock_recipe(&input.unlocking_script))
            .collect::<Result<Vec<_>, _>>()?;
        let semantic_consume = pool_recipes.iter().any(|recipe| {
            recipe.operation == PoolRecipeOperation::ConsumeLiquidity && recipe.swap.is_none()
        });
        if !canonical_consume_id
            && semantic_consume
            && (transaction.stage > 0 || !transaction.depends_on.is_empty())
        {
            return Err(invalid_plan(
                "delayed Pool consume identity, role, and recipe must agree",
            ));
        }
        if !canonical_consume_id {
            continue;
        }
        if transaction.role != "primary"
            || pool_recipes.len() != 1
        {
            return Err(invalid_plan(
                "delayed Pool consume identity, role, and recipe must agree",
            ));
        }
        let successor_id = transaction
            .inputs
            .get(1)
            .map(|input| input.previous_transaction_id.clone())
            .ok_or_else(|| invalid_plan("FTLP maintenance descendant Pool input shape is invalid"))?;
        let binding = pool_authority_binding(transaction, plan, &successor_id)?
            .ok_or_else(|| invalid_plan("FTLP maintenance descendant Pool operation context is invalid"))?;
        if !semantic_consume {
            return Err(invalid_plan("FTLP maintenance descendant Pool operation context is invalid"));
        }
        let successor_vout = transaction.inputs[1].previous_output_index;
        if bindings.insert((successor_id, successor_vout), binding).is_some() {
            return Err(invalid_plan(
                "FTLP maintenance descendant Pool asset consumption is ambiguous",
            ));
        }
    }
    Ok(bindings)
}

fn final_ftlp_successor_id(
    transaction: &PlannedTransaction,
    plan: &UnsignedPlan,
) -> Result<String, EngineError> {
    let mut successor_id = transaction.transaction_id.clone();
    let mut round = ftlp_maintenance_round(transaction)
        .ok_or_else(|| invalid_plan("FTLP maintenance identity is invalid"))?;
    loop {
        let next_round = round
            .checked_add(1)
            .ok_or_else(|| invalid_plan("FTLP maintenance round overflows"))?;
        let next_id = format!("ftlp-merge-{next_round}");
        let Some(next) = plan
            .transactions
            .iter()
            .find(|candidate| candidate.transaction_id == next_id)
        else {
            break;
        };
        if next.inputs.first().is_none_or(|input| {
            input.previous_transaction_id != successor_id
                || input.previous_output_index != 0
                || !input.unlocking_script.starts_with(FTLP_UNLOCK_PREFIX)
        }) {
            return Err(invalid_plan(
                "FTLP maintenance asset successor chain is invalid",
            ));
        }
        successor_id = next_id;
        round = next_round;
    }

    Ok(successor_id)
}

fn authenticate_released_ftlp_code(
    code: &Script,
    tape: &Script,
    signer: &PublicSigningContext,
    authority: &FtlpAuthorityBinding,
) -> Result<(), EngineError> {
    let key = validate_public_identity(signer)?;
    if tape.as_bytes().len() != authority.source_ft_tape_size {
        return Err(invalid_plan(
            "FTLP maintenance identity does not match authenticated Pool authority and signer",
        ));
    }
    let params = FtlpCodeParams::for_tape(tape, authority.ft_version, authority.is_coin)
        .map_err(|_| invalid_plan("FTLP maintenance parent Tape is not released"))?;
    let owner = Address::from_hash160(key.hash160());
    let expected = if authority.locked {
        ftlp_lock_time_code(authority.pool_hash, &owner, &params)
    } else {
        ftlp_code(authority.pool_hash, &owner, &params)
    }
    .map_err(|_| invalid_plan("FTLP maintenance parent Code cannot be derived"))?;
    let partial_end = expected
        .as_bytes()
        .len()
        .checked_sub(28)
        .ok_or_else(|| invalid_plan("FTLP maintenance parent Code cannot be partial-hashed"))?;
    if &expected != code {
        return Err(invalid_plan(
            "FTLP maintenance identity does not match authenticated Pool authority and signer",
        ));
    }
    if calculate_partial_hash(&expected.as_bytes()[..partial_end]).as_slice()
        != authority.ft_lp_partial_hash.as_slice()
    {
        return Err(invalid_plan(
            "FTLP maintenance Pool immutable state or LP partial hash is inconsistent",
        ));
    }
    Ok(())
}

fn planned_source_identity_and_output(
    source: &TransactionSource,
    output_index: u32,
    plan: &UnsignedPlan,
) -> Result<String, EngineError> {
    match source {
        TransactionSource::Planned(id) => {
            let transaction = plan
                .transactions
                .iter()
                .find(|transaction| transaction.transaction_id == *id)
                .ok_or_else(|| invalid_plan("FTLP maintenance proof parent does not exist"))?;
            transaction
                .outputs
                .get(output_index as usize)
                .ok_or_else(|| invalid_plan("FTLP maintenance proof vout is out of range"))?;
            Ok(id.clone())
        }
        source => {
            let empty = SigningContinuation {
                session_id: String::new(),
                plan_commitment: String::new(),
                next_stage: 0,
                finalized_transactions: vec![None; plan.transactions.len()],
            };
            let transaction = resolve_source(source, plan, &empty)?;
            transaction
                .outputs
                .get(output_index as usize)
                .ok_or_else(|| invalid_plan("FTLP maintenance proof vout is out of range"))?;
            Ok(transaction.txid().to_string())
        }
    }
}

fn validate_planned_ftlp_proofs(
    parent_id: &str,
    input: &PlannedInput,
    recipe: &FtlpUnlockRecipe,
    tape: &Script,
    plan: &UnsignedPlan,
) -> Result<(), EngineError> {
    let parent = plan
        .transactions
        .iter()
        .find(|transaction| transaction.transaction_id == parent_id)
        .ok_or_else(|| invalid_plan("FTLP maintenance parent does not exist"))?;
    let source_indexes = tape_source_indexes(tape, "FTLP maintenance pre-pre proof set is invalid")?;
    let message = "FTLP maintenance pre-pre proof set is invalid";
    let selected_outpoints = source_indexes
        .into_iter()
        .map(|source_index| {
            parent
                .inputs
                .get(source_index)
                .map(|source| {
                    (
                        source.previous_transaction_id.clone(),
                        source.previous_output_index,
                    )
                })
                .ok_or_else(|| invalid_plan(message))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let proof_outpoints = recipe
        .proof_references
        .iter()
        .map(|proof| {
            Ok((
                planned_source_identity_and_output(&proof.source, proof.output_index, plan)?,
                proof.output_index,
            ))
        })
        .collect::<Result<Vec<_>, EngineError>>()?;
    validate_exact_recipe_proof_pairs(&selected_outpoints, &proof_outpoints, message)?;
    if input.previous_transaction_id != parent_id {
        return Err(invalid_plan("FTLP maintenance pre-pre proof set is invalid"));
    }
    Ok(())
}

fn validate_ftlp_maintenance_proofs(
    parent: &Transaction,
    input: &PlannedInput,
    recipe: &FtlpUnlockRecipe,
    tape: &Script,
    plan: &UnsignedPlan,
) -> Result<(), EngineError> {
    if let TransactionSource::Planned(id) = &recipe.parent {
        return validate_planned_ftlp_proofs(id, input, recipe, tape, plan);
    }
    let empty = SigningContinuation {
        session_id: String::new(),
        plan_commitment: String::new(),
        next_stage: 0,
        finalized_transactions: vec![None; plan.transactions.len()],
    };
    let (_, proofs) = resolve_recipe_parent_and_proofs(
        input,
        &recipe.parent,
        &recipe.proof_references,
        plan,
        &empty,
        "FTLP maintenance pre-pre proof set is invalid",
    )?;
    tbc_sdk::contracts::ft::unlock::pre_pre_tx_data_from_parents(
        parent,
        input.previous_output_index as usize,
        &proofs,
    )
    .map_err(|_| invalid_plan("FTLP maintenance pre-pre proof set is invalid"))?;
    Ok(())
}

fn validate_ftlp_maintenance_topology(
    transaction: &PlannedTransaction,
    recipes: &[FtlpUnlockRecipe],
    plan: &UnsignedPlan,
    round: usize,
    final_pool_consumes: &BTreeMap<(String, u32), FtlpAuthorityBinding>,
    public_merge: bool,
    public_burn: bool,
) -> Result<(), EngineError> {
    if transaction.inputs.len() != recipes.len() + 1
        || transaction
            .inputs
            .last()
            .is_none_or(|input| !input.unlocking_script.is_empty())
    {
        return Err(invalid_plan(
            "FTLP maintenance must contain only FTLP inputs followed by one fee input",
        ));
    }
    if transaction.outputs.len() != 3 {
        return Err(invalid_plan(
            "FTLP maintenance outputs must be merged Code, Tape, and fee change",
        ));
    }
    let expected_dependency = if public_merge {
        None
    } else {
        round.checked_sub(1).map(|prior| format!("ftlp-merge-{prior}"))
    };
    if usize::try_from(transaction.stage).ok() != Some(round)
        || transaction.depends_on != expected_dependency.iter().cloned().collect::<Vec<_>>()
        || (public_merge
            && (transaction.role != "primary" || transaction.transaction_id != "ftlp-merge-1"))
        || (public_burn
            && (transaction.role != "primary" || transaction.transaction_id != "ftlp-burn-1"))
    {
        return Err(invalid_plan(
            "FTLP maintenance stage or dependency chain is invalid",
        ));
    }
    if let Some(prior) = &expected_dependency {
        if transaction.inputs[0].previous_transaction_id != *prior
            || transaction.inputs[0].previous_output_index != 0
            || transaction.inputs.last().is_none_or(|input| {
                input.previous_transaction_id != *prior || input.previous_output_index != 2
            })
            || !matches!(&recipes[0].parent, TransactionSource::Planned(id) if id == prior)
        {
            return Err(invalid_plan(
                "FTLP maintenance stage or dependency chain is invalid",
            ));
        }
    } else if recipes
        .iter()
        .any(|recipe| matches!(recipe.parent, TransactionSource::Planned(_)))
    {
        return Err(invalid_plan(
            "FTLP maintenance stage or dependency chain is invalid",
        ));
    }

    let mut first_code = None;
    let mut first_tape = None;
    let mut balances = Vec::with_capacity(recipes.len());
    let preview = materialize_unsigned_preview(transaction, plan)?;
    let authority = if public_merge || public_burn {
        None
    } else {
        let successor_id = final_ftlp_successor_id(transaction, plan)?;
        Some(final_pool_consumes.get(&(successor_id, 0)).cloned().ok_or_else(|| {
            invalid_plan("FTLP maintenance descendant Pool does not consume the final FTLP successor")
        })?)
    };
    for (input_index, (input, recipe)) in transaction.inputs.iter().zip(recipes).enumerate() {
        let (parent, code, tape, balance) = resolve_ftlp_code_tape(input, recipe, plan)?;
        if let Some(authority) = authority.as_ref() {
            authenticate_released_ftlp_code(&code, &tape, &input.signer, authority)?;
        }
        validate_ftlp_lock(&preview, input_index, &parent, recipe).map_err(|_| {
            invalid_plan(
                "FTLP maintenance recipe lock does not match authenticated Tape and transaction",
            )
        })?;
        validate_ftlp_maintenance_proofs(&parent, input, recipe, &tape, plan)?;
        if first_code.as_ref().is_some_and(|expected| expected != &code) {
            return Err(invalid_plan("FTLP maintenance Code inputs are inconsistent"));
        }
        first_code.get_or_insert(code);
        first_tape.get_or_insert(tape);
        balances.push(balance);
    }
    let merged_total = balances.iter().try_fold(0u128, |total, balance| {
        total
            .checked_add(*balance)
            .ok_or_else(|| invalid_plan("FTLP maintenance balance overflow"))
    })?;
    let (merged_amount, _) = build_tape_amount(merged_total, &balances)
        .map_err(|_| invalid_plan("FTLP maintenance balance cannot be encoded"))?;
    let locked = matches!(recipes[0].lock, FtlpLockMode::BlockHeight { .. });
    let first_tape = first_tape.expect("non-empty FTLP maintenance recipes");
    let output_code = parse_script(&transaction.outputs[0].locking_script, "ftlpMaintenanceCode")?;
    let output_tape = parse_script(&transaction.outputs[1].locking_script, "ftlpMaintenanceTape")?;
    if public_burn {
        if locked && recipes.iter().any(|recipe| !matches!(recipe.lock, FtlpLockMode::BlockHeight { lock_height: 0, .. })) {
            return Err(invalid_plan("locked-family FTLP burn requires already-unlocked inputs"));
        }
        let eater = Address::from_string("1BitcoinEaterAddressDontSendf59kuE")
            .map_err(|_| invalid_plan("FTLP burn eater address is invalid"))?;
        let expected_code = transfer_ftlp_code_script(
            &first_code.expect("non-empty FTLP maintenance recipes"),
            &eater,
        )
        .map_err(|_| invalid_plan("FTLP burn Code is invalid"))?;
        if transaction.outputs[0].satoshis != FTLP_CODE_SATOSHIS
            || output_code != expected_code
            || transaction.outputs[1].satoshis != FTLP_TAPE_SATOSHIS
            || balance_from_tape(&output_tape)
                .map_err(|_| invalid_plan("FTLP burn Tape is invalid"))?
                != merged_total
        {
            return Err(invalid_plan(
                "FTLP burn must send the exact authenticated balance to the released eater",
            ));
        }
    } else {
    let tape_base = if locked {
        ftlp_tape(&FtlpTapeParams {
            amount_raw: 0,
            layout: FtlpTapeLayout::LockTime {
                lock_time: 0,
                source_ft_tape_size: first_tape.as_bytes().len(),
            },
        })
        .map_err(|_| invalid_plan("FTLP maintenance lock Tape layout is invalid"))?
    } else {
        first_tape
    };
    let expected_tape = transfer_tape_script(&tape_base, &merged_amount)
        .map_err(|_| invalid_plan("FTLP maintenance merged Tape is invalid"))?;
    if transaction.outputs[0].satoshis != FTLP_CODE_SATOSHIS
        || output_code != first_code.expect("non-empty FTLP maintenance recipes")
        || transaction.outputs[1].satoshis != FTLP_TAPE_SATOSHIS
        || output_tape != expected_tape
    {
        return Err(invalid_plan(
            "FTLP maintenance merged Tape does not conserve authenticated balance and lock layout",
        ));
    }
    }

    let fee_input = transaction.inputs.last().expect("validated FTLP fee input");
    let fee_key = validate_public_identity(&fee_input.signer)?;
    let fee_script = Script::p2pkh(&fee_key.hash160());
    let input_satoshis = transaction.inputs.iter().try_fold(0u64, |total, input| {
        total
            .checked_add(input.previous_output_satoshis)
            .ok_or_else(|| invalid_plan("FTLP maintenance input value overflow"))
    })?;
    let output_satoshis = transaction.outputs.iter().try_fold(0u64, |total, output| {
        total
            .checked_add(output.satoshis)
            .ok_or_else(|| invalid_plan("FTLP maintenance output value overflow"))
    })?;
    input_satoshis
        .checked_sub(output_satoshis)
        .ok_or_else(|| invalid_plan("FTLP maintenance outputs exceed its inputs"))?;
    if resolve_previous_output_script_from_plan(fee_input, plan)? != fee_script
        || transaction.outputs[2].satoshis < tbc_sdk::SDK_DUST_SAT
        || parse_script(&transaction.outputs[2].locking_script, "ftlpMaintenanceFeeChange")?
            != fee_script
    {
        return Err(invalid_plan(
            "FTLP maintenance fee change is not a spendable successor for its fee input",
        ));
    }
    Ok(())
}

fn validate_ftlp_recipe_order(
    transaction: &PlannedTransaction,
    plan: &UnsignedPlan,
    final_pool_consumes: &BTreeMap<(String, u32), FtlpAuthorityBinding>,
) -> Result<(), EngineError> {
    let start = usize::from(transaction.inputs.first().is_some_and(|input| {
        input.unlocking_script.starts_with(POOL_UNLOCK_PREFIX)
    }));
    let prefix_len = transaction.inputs[start..]
        .iter()
        .take_while(|input| input.unlocking_script.starts_with(FTLP_UNLOCK_PREFIX))
        .count();
    if transaction.inputs[start + prefix_len..]
        .iter()
        .any(|input| input.unlocking_script.starts_with(FTLP_UNLOCK_PREFIX))
    {
        return Err(invalid_plan(
            "FTLP inputs must occupy the absolute transaction prefix",
        ));
    }
    let recipes = transaction.inputs[start..start + prefix_len]
        .iter()
        .map(|input| parse_ftlp_unlock_recipe(&input.unlocking_script))
        .collect::<Result<Vec<_>, _>>()?;
    if recipes.is_empty() {
        return Ok(());
    }
    let count = u8::try_from(recipes.len())
        .map_err(|_| invalid_plan("FTLP input count exceeds the recipe wire range"))?;
    let locked = matches!(recipes[0].lock, FtlpLockMode::BlockHeight { .. });
    if recipes
        .iter()
        .any(|recipe| matches!(recipe.lock, FtlpLockMode::BlockHeight { .. }) != locked)
    {
        return Err(invalid_plan("standard and locked FTLP recipes cannot be mixed"));
    }
    let maintenance_round = ftlp_maintenance_round(transaction);
    let public_merge = transaction.role == "primary"
        && transaction.transaction_id == "ftlp-merge-1"
        && transaction.stage == 0
        && transaction.depends_on.is_empty();
    let public_burn = transaction.role == "primary"
        && transaction.transaction_id == "ftlp-burn-1"
        && transaction.stage == 0
        && transaction.depends_on.is_empty();
    let limit = if maintenance_round.is_some() || public_merge || public_burn {
        MAX_FTLP_MAINTENANCE_INPUTS
    } else if locked {
        MAX_LOCKED_FTLP_INPUTS
    } else {
        MAX_STANDARD_FTLP_INPUTS
    };
    if recipes.len() > limit {
        return Err(invalid_plan("FTLP recipe input count exceeds the released limit"));
    }
    for (index, recipe) in recipes.iter().enumerate() {
        if usize::from(recipe.ordered_input_index) != index
            || recipe.ordered_input_count != count
        {
            return Err(invalid_plan("FTLP recipe input ordering is inconsistent"));
        }
        match recipe.lock {
            FtlpLockMode::Standard => {
                if transaction.lock_time != 0 {
                    return Err(invalid_plan("standard FTLP transaction must not set lock time"));
                }
            }
            FtlpLockMode::BlockHeight {
                lock_height,
                current_height,
            } => {
                const LOCK_TIME_THRESHOLD: u32 = 500_000_000;
                if lock_height >= LOCK_TIME_THRESHOLD
                    || current_height >= LOCK_TIME_THRESHOLD
                    || current_height < lock_height
                    || transaction.lock_time != current_height
                {
                    return Err(invalid_plan("FTLP block-height lock domain is invalid"));
                }
            }
        }
    }
    for (input, recipe) in transaction
        .inputs
        .iter()
        .skip(start)
        .take(recipes.len())
        .zip(&recipes)
    {
        let expected_sequence = match recipe.lock {
            FtlpLockMode::Standard => tbc_sdk::DEFAULT_SEQUENCE,
            FtlpLockMode::BlockHeight { .. } => tbc_sdk::DEFAULT_SEQUENCE - 1,
        };
        if input.sequence != expected_sequence {
            return Err(invalid_plan("FTLP input sequence does not match its lock mode"));
        }
    }
    if let Some(round) = maintenance_round {
        if start != 0 {
            return Err(invalid_plan(
                "FTLP maintenance must contain only FTLP inputs followed by one fee input",
            ));
        }
        validate_ftlp_maintenance_topology(
            transaction,
            &recipes,
            plan,
            round,
            final_pool_consumes,
            false,
            false,
        )?;
    } else if public_merge {
        if start != 0 {
            return Err(invalid_plan(
                "public FTLP merge must contain only FTLP inputs followed by one fee input",
            ));
        }
        validate_ftlp_maintenance_topology(
            transaction,
            &recipes,
            plan,
            0,
            final_pool_consumes,
            true,
            false,
        )?;
    } else if public_burn {
        if start != 0 {
            return Err(invalid_plan(
                "public FTLP burn must contain only FTLP inputs followed by one fee input",
            ));
        }
        validate_ftlp_maintenance_topology(
            transaction,
            &recipes,
            plan,
            0,
            final_pool_consumes,
            false,
            true,
        )?;
    }
    Ok(())
}

#[derive(Eq, Ord, PartialEq, PartialOrd)]
enum SpendSource<'a> {
    Chain(&'a str),
    Internal(&'a str),
}

fn validate_global_input_uniqueness(
    plan: &UnsignedPlan,
    continuation: Option<&SigningContinuation>,
) -> Result<(), EngineError> {
    let transaction_indexes = plan
        .transactions
        .iter()
        .enumerate()
        .map(|(index, transaction)| (transaction.transaction_id.as_str(), index))
        .collect::<BTreeMap<_, _>>();
    let finalized_txids = continuation
        .into_iter()
        .flat_map(|state| state.finalized_transactions.iter())
        .filter_map(Option::as_ref)
        .map(|record| record.txid.as_str())
        .collect::<BTreeSet<_>>();
    let mut spent = BTreeSet::new();
    for transaction in &plan.transactions {
        for input in &transaction.inputs {
            let source = if let Some(parent_index) = transaction_indexes
                .get(input.previous_transaction_id.as_str())
            {
                continuation
                    .and_then(|state| state.finalized_transactions[*parent_index].as_ref())
                    .map_or_else(
                        || SpendSource::Internal(input.previous_transaction_id.as_str()),
                        |record| SpendSource::Chain(record.txid.as_str()),
                    )
            } else {
                if finalized_txids.contains(input.previous_transaction_id.as_str()) {
                    return Err(error(
                        ErrorCode::InvalidPlan,
                        "planned input outpoints must be globally unique",
                        "plan.transactions",
                    ));
                }
                SpendSource::Chain(input.previous_transaction_id.as_str())
            };
            if !spent.insert((source, input.previous_output_index)) {
                return Err(error(
                    ErrorCode::InvalidPlan,
                    "planned input outpoints must be globally unique",
                    "plan.transactions",
                ));
            }
        }
    }
    Ok(())
}

fn validate_evidence_table(plan: &UnsignedPlan) -> Result<(), EngineError> {
    if plan.evidence_table.len() > MAX_EVIDENCE_ENTRIES {
        return Err(invalid_plan("FT evidence table exceeds the entry budget"));
    }
    let mut txids = BTreeSet::new();
    let mut raws = BTreeSet::new();
    let mut total = 0usize;
    for entry in &plan.evidence_table {
        let raw_bytes = entry
            .raw_transaction
            .len()
            .checked_div(2)
            .ok_or_else(|| invalid_plan("FT evidence byte length overflow"))?;
        total = total
            .checked_add(raw_bytes)
            .ok_or_else(|| invalid_plan("FT evidence aggregate byte length overflow"))?;
        if raw_bytes > MAX_EVIDENCE_ENTRY_RAW_BYTES || total > MAX_EVIDENCE_RAW_BYTES {
            return Err(invalid_plan("FT evidence exceeds the raw byte budget"));
        }
        let transaction = Transaction::from_hex(&entry.raw_transaction)
            .map_err(|_| invalid_plan("FT evidence transaction is malformed"))?;
        if transaction.to_hex() != entry.raw_transaction
            || transaction.txid().to_string() != entry.txid
        {
            return Err(invalid_plan(
                "FT evidence transaction identifier or encoding is inconsistent",
            ));
        }
        if !txids.insert(entry.txid.as_str()) || !raws.insert(entry.raw_transaction.as_str()) {
            return Err(invalid_plan("FT evidence table contains duplicate or conflicting entries"));
        }
    }
    Ok(())
}

fn validate_evidence_reference(
    source: &FtTransactionSource,
    plan: &UnsignedPlan,
) -> Result<(), EngineError> {
    if let FtTransactionSource::Evidence(index) = source {
        let index = usize::try_from(*index)
            .map_err(|_| invalid_plan("FT evidence index exceeds the local index range"))?;
        if index >= plan.evidence_table.len() {
            return Err(invalid_plan("FT evidence reference is out of range"));
        }
    }
    Ok(())
}

fn validate_cardinality_counts(
    transactions: usize,
    inputs: usize,
    outputs: usize,
    dependencies: usize,
) -> Result<(), EngineError> {
    if transactions > MAX_SIGNING_PLAN_TRANSACTIONS {
        return Err(invalid_plan("unsigned plan exceeds the transaction budget"));
    }
    if inputs > MAX_SIGNING_PLAN_INPUTS {
        return Err(invalid_plan("unsigned plan exceeds the input budget"));
    }
    if outputs > MAX_SIGNING_PLAN_OUTPUTS {
        return Err(invalid_plan("unsigned plan exceeds the output budget"));
    }
    if dependencies > MAX_SIGNING_PLAN_DEPENDENCIES {
        return Err(invalid_plan("unsigned plan exceeds the dependency budget"));
    }
    Ok(())
}

struct SerializedBudgetWriter {
    remaining: usize,
}

struct Sha256Writer {
    hasher: Sha256,
}

impl Write for Sha256Writer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.hasher.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn canonical_sha256<T: Serialize + ?Sized>(value: &T) -> Result<[u8; 32], serde_json::Error> {
    let mut writer = Sha256Writer {
        hasher: Sha256::new(),
    };
    serde_json::to_writer(&mut writer, value)?;
    Ok(writer.hasher.finalize().into())
}

impl Write for SerializedBudgetWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.remaining {
            return Err(io::Error::new(
                io::ErrorKind::Other,
                "serialized byte budget exceeded",
            ));
        }
        self.remaining -= bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn validate_serialized_budget<T: Serialize + ?Sized>(
    value: &T,
    limit: usize,
    message: &str,
) -> Result<(), EngineError> {
    let mut writer = SerializedBudgetWriter { remaining: limit };
    serde_json::to_writer(&mut writer, value).map_err(|_| invalid_plan(message))
}

#[cfg(test)]
mod budget_tests {
    use serde::Serialize;
    use tbc_sdk::{OutPoint, Transaction, TxIn, Txid};

    use super::{
        MAX_POOL_UNLOCKING_SCRIPT_BYTES,
        MAX_SIGNING_CONTINUATION_SERIALIZED_BYTES, MAX_SIGNING_PLAN_DEPENDENCIES,
        MAX_SIGNING_PLAN_INPUTS, MAX_SIGNING_PLAN_OUTPUTS, MAX_SIGNING_PLAN_TRANSACTIONS,
        MAX_UNSIGNED_PLAN_SERIALIZED_BYTES, canonical_sha256, encode_hex,
        set_bounded_unlocking_script, validate_cardinality_counts, validate_serialized_budget,
    };

    #[derive(Serialize)]
    struct HashVector<'a> {
        kind: &'a str,
        value: u32,
    }

    #[derive(Serialize)]
    struct SizedPayload {
        data: String,
    }

    #[test]
    fn streaming_hash_matches_fixed_canonical_json_vectors() {
        let plan = HashVector {
            kind: "plan",
            value: 7,
        };
        let continuation = HashVector {
            kind: "continuation",
            value: 9,
        };

        assert_eq!(
            serde_json::to_vec(&plan).unwrap(),
            br#"{"kind":"plan","value":7}"#
        );
        assert_eq!(
            encode_hex(&canonical_sha256(&plan).unwrap()),
            "7a354a4167f36005787849454e73c3416f643e491e90f6464bbd04199353d542"
        );
        assert_eq!(
            serde_json::to_vec(&continuation).unwrap(),
            br#"{"kind":"continuation","value":9}"#
        );
        assert_eq!(
            encode_hex(&canonical_sha256(&continuation).unwrap()),
            "fc0fb0705107cf1732dab9ab60ad2a2c9be5b2e41dc9971fb853bdf3774534a4"
        );
    }

    #[test]
    fn every_cardinality_budget_accepts_exact_and_rejects_plus_one() {
        validate_cardinality_counts(
            MAX_SIGNING_PLAN_TRANSACTIONS,
            MAX_SIGNING_PLAN_INPUTS,
            MAX_SIGNING_PLAN_OUTPUTS,
            MAX_SIGNING_PLAN_DEPENDENCIES,
        )
        .unwrap();

        let cases = [
            (
                MAX_SIGNING_PLAN_TRANSACTIONS + 1,
                0,
                0,
                0,
                "unsigned plan exceeds the transaction budget",
            ),
            (
                1,
                MAX_SIGNING_PLAN_INPUTS + 1,
                0,
                0,
                "unsigned plan exceeds the input budget",
            ),
            (
                1,
                0,
                MAX_SIGNING_PLAN_OUTPUTS + 1,
                0,
                "unsigned plan exceeds the output budget",
            ),
            (
                1,
                0,
                0,
                MAX_SIGNING_PLAN_DEPENDENCIES + 1,
                "unsigned plan exceeds the dependency budget",
            ),
        ];
        for (transactions, inputs, outputs, dependencies, message) in cases {
            assert_eq!(
                validate_cardinality_counts(transactions, inputs, outputs, dependencies)
                    .unwrap_err()
                    .message,
                message
            );
        }
    }

    #[test]
    fn canonical_byte_budgets_accept_exact_and_reject_plus_one() {
        for (limit, message) in [
            (
                MAX_UNSIGNED_PLAN_SERIALIZED_BYTES,
                "unsigned plan exceeds the serialized byte budget",
            ),
            (
                MAX_SIGNING_CONTINUATION_SERIALIZED_BYTES,
                "signing continuation exceeds the serialized byte budget",
            ),
        ] {
            let empty_size = serde_json::to_vec(&SizedPayload {
                data: String::new(),
            })
            .unwrap()
            .len();
            let exact = SizedPayload {
                data: "x".repeat(limit - empty_size),
            };
            assert_eq!(serde_json::to_vec(&exact).unwrap().len(), limit);
            validate_serialized_budget(&exact, limit, message).unwrap();

            let plus_one = SizedPayload {
                data: "x".repeat(limit - empty_size + 1),
            };
            assert_eq!(
                validate_serialized_budget(&plus_one, limit, message)
                    .unwrap_err()
                    .message,
                message
            );
        }
    }

    #[test]
    fn pool_script_and_stage_material_budgets_accept_exact_and_reject_plus_one() {
        let mut transaction = Transaction::new();
        transaction.inputs.push(TxIn::new(OutPoint {
            txid: Txid::default(),
            vout: 0,
        }));
        set_bounded_unlocking_script(
            &mut transaction,
            0,
            vec![0; MAX_POOL_UNLOCKING_SCRIPT_BYTES],
        )
        .unwrap();
        assert_eq!(
            transaction.inputs[0].script_sig.as_bytes().len(),
            MAX_POOL_UNLOCKING_SCRIPT_BYTES
        );
        assert_eq!(
            set_bounded_unlocking_script(
                &mut transaction,
                0,
                vec![0; MAX_POOL_UNLOCKING_SCRIPT_BYTES + 1],
            )
            .unwrap_err()
            .message,
            "Pool unlocking script exceeds the byte budget"
        );

        let empty_size = serde_json::to_vec(&SizedPayload {
            data: String::new(),
        })
        .unwrap()
        .len();
        let exact = SizedPayload {
            data: "x".repeat(MAX_SIGNING_CONTINUATION_SERIALIZED_BYTES - empty_size),
        };
        validate_serialized_budget(
            &exact,
            MAX_SIGNING_CONTINUATION_SERIALIZED_BYTES,
            "Pool stage material exceeds the serialized byte budget",
        )
        .unwrap();
        let plus_one = SizedPayload {
            data: "x".repeat(MAX_SIGNING_CONTINUATION_SERIALIZED_BYTES - empty_size + 1),
        };
        assert_eq!(
            validate_serialized_budget(
                &plus_one,
                MAX_SIGNING_CONTINUATION_SERIALIZED_BYTES,
                "Pool stage material exceeds the serialized byte budget",
            )
            .unwrap_err()
            .message,
            "Pool stage material exceeds the serialized byte budget"
        );
    }
}

#[cfg(test)]
mod dependency_reachability_tests {
    use super::*;

    fn transaction(id: &str, stage: u32, dependencies: &[&str]) -> PlannedTransaction {
        PlannedTransaction {
            transaction_id: id.to_owned(),
            role: if id == "primary" { "primary" } else { "maintenance" }.to_owned(),
            stage,
            depends_on: dependencies.iter().map(|dependency| (*dependency).to_owned()).collect(),
            version: tbc_sdk::TX_VERSION,
            inputs: Vec::new(),
            outputs: Vec::new(),
            lock_time: 0,
        }
    }

    fn plan(transactions: Vec<PlannedTransaction>) -> UnsignedPlan {
        UnsignedPlan { transactions, evidence_table: Vec::new() }
    }

    fn dependency_order_plan(dependencies: &[&str]) -> UnsignedPlan {
        let public_key = PublicKey::from_slice(
            &decode_hex("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")
                .unwrap(),
        )
        .unwrap();
        let signer = PublicSigningContext {
            address: public_key.address().to_string(),
            public_key: encode_hex(&public_key.to_bytes()),
            public_key_hash: encode_hex(&public_key.hash160()),
        };
        let script = encode_hex(Script::p2pkh(&public_key.hash160()).as_bytes());
        let input = |previous_transaction_id: String| PlannedInput {
            previous_transaction_id,
            previous_output_index: 0,
            previous_output_script: script.clone(),
            previous_output_satoshis: 1_000,
            sequence: tbc_sdk::DEFAULT_SEQUENCE,
            unlocking_script: String::new(),
            signer: signer.clone(),
        };
        let output = || PlannedOutput { satoshis: 1_000, locking_script: script.clone() };
        let mut left = transaction("left", 0, &[]);
        left.inputs = vec![input("11".repeat(32))];
        left.outputs = vec![output()];
        let mut right = transaction("right", 0, &[]);
        right.inputs = vec![input("22".repeat(32))];
        right.outputs = vec![output()];
        let mut primary = transaction("primary", 1, dependencies);
        primary.inputs = vec![input("right".to_owned()), input("left".to_owned())];
        primary.outputs = vec![output()];
        plan(vec![left, right, primary])
    }

    fn assert_invalid(
        plan: &UnsignedPlan,
        transaction_index: usize,
        source_id: &str,
        message: &str,
    ) {
        let error = validate_stage_recipe_source(
            &TransactionSource::Planned(source_id.to_owned()),
            &plan.transactions[transaction_index],
            plan,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidPlan);
        assert_eq!(error.message, message);
        assert_eq!(error.path.as_deref(), Some("plan"));
    }

    #[test]
    fn recipe_source_accepts_only_a_declared_direct_or_transitive_ancestor() {
        let valid = plan(vec![
            transaction("merge-0", 0, &[]),
            transaction("merge-1", 1, &["merge-0"]),
            transaction("primary", 2, &["merge-1"]),
        ]);
        validate_stage_recipe_source(
            &TransactionSource::Planned("merge-0".to_owned()),
            &valid.transactions[2],
            &valid,
        )
        .unwrap();

        let sibling = plan(vec![
            transaction("merge-0", 0, &[]),
            transaction("sibling", 1, &[]),
            transaction("merge-1", 2, &["merge-0"]),
            transaction("primary", 3, &["merge-1"]),
        ]);
        assert_invalid(
            &sibling,
            3,
            "sibling",
            "Pool recipe planned source is not an earlier declared dependency",
        );

        assert_invalid(
            &valid,
            2,
            "missing",
            "Pool recipe planned source does not exist",
        );

        let forward = plan(vec![
            transaction("merge-0", 0, &[]),
            transaction("primary", 1, &["merge-0"]),
            transaction("future", 2, &["primary"]),
        ]);
        assert_invalid(
            &forward,
            1,
            "future",
            "Pool recipe planned source is not an earlier declared dependency",
        );

        assert_invalid(
            &valid,
            2,
            "primary",
            "Pool recipe planned source is not an earlier declared dependency",
        );

        let cycle = plan(vec![
            transaction("merge-0", 0, &["merge-1"]),
            transaction("merge-1", 1, &["merge-0"]),
            transaction("primary", 2, &["merge-1"]),
        ]);
        assert_invalid(
            &cycle,
            2,
            "merge-0",
            "transaction dependency is not in an earlier stage",
        );
    }

    #[test]
    fn direct_dependencies_follow_first_internal_input_occurrence() {
        validate_plan(&dependency_order_plan(&["right", "left"])).unwrap();

        let error = validate_plan(&dependency_order_plan(&["left", "right"])).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidPlan);
        assert_eq!(
            error.message,
            "transaction dependencies must follow internal input order",
        );
        assert_eq!(error.path.as_deref(), Some("plan"));
    }
}

fn materialize_transaction(
    planned: &PlannedTransaction,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<Transaction, EngineError> {
    let mut transaction = Transaction {
        version: planned.version,
        inputs: Vec::with_capacity(planned.inputs.len()),
        outputs: Vec::with_capacity(planned.outputs.len()),
        lock_time: planned.lock_time,
    };
    for input in &planned.inputs {
        let txid = if let Some(parent_index) = plan.transactions
            .iter()
            .position(|parent| parent.transaction_id == input.previous_transaction_id)
        {
            let parent = continuation.finalized_transactions[parent_index]
                .as_ref()
                .ok_or_else(|| invalid_plan("dependent transaction parent is not finalized"))?;
            parse_txid(&parent.txid)?
        } else {
            parse_txid(&input.previous_transaction_id)?
        };
        transaction.inputs.push(TxIn {
            previous_output: OutPoint {
                txid,
                vout: input.previous_output_index,
            },
            script_sig: if is_unlocking_recipe(&input.unlocking_script) {
                Script::empty()
            } else {
                parse_script(&input.unlocking_script, "unlockingScript")?
            },
            sequence: input.sequence,
        });
    }
    for output in &planned.outputs {
        transaction.outputs.push(TxOut {
            satoshis: output.satoshis,
            script_pubkey: resolve_locking_script(&output.locking_script, plan, continuation, false)?,
        });
    }
    Ok(transaction)
}

fn is_ecdsa_fungible_recipe(value:&str) -> bool {
    value.starts_with(TBC20_UNLOCK_PREFIX) || value.starts_with(AMM_LP_UNLOCK_PREFIX)
}

fn is_unlocking_recipe(value: &str) -> bool {
    if value.starts_with(LOP_MATCH_UNLOCK_PREFIX) { return true; }
    if value == LOP_CANCEL_DESCRIPTOR { return true; }
    if is_htlc_descriptor(value) { return true; }
    if value == TIMELOCK_UNLOCK_DESCRIPTOR { return true; }
    if value.starts_with(AMM_POOL_UNLOCK_PREFIX){return true;}
    value.starts_with(TBC20_UNLOCK_PREFIX)
        || value.starts_with(AMM_LP_UNLOCK_PREFIX)
        || value.starts_with(COIN_UNLOCK_PREFIX)
        || value.starts_with(TBC721_UNLOCK_PREFIX)
        || value.starts_with(FT_UNLOCK_PREFIX)
        || value.starts_with(NFT_UNLOCK_PREFIX)
        || value.starts_with(POOL_UNLOCK_PREFIX)
        || value.starts_with(POOL_HELD_FT_UNLOCK_PREFIX)
        || value.starts_with(FTLP_UNLOCK_PREFIX)
}

fn is_schnorr_context(context:&PublicSigningContext)->bool {context.public_key.len()==64}

fn validated_signer_bytes(context:&PublicSigningContext)->Result<Vec<u8>,EngineError> {
    if !is_schnorr_context(context) {return Ok(validate_public_identity(context)?.to_bytes().to_vec());}
    let bytes=decode_hex(&context.public_key).map_err(|_|invalid_plan("Schnorr public key hex invalid"))?;
    crate::protocols::covenant_signature::CovenantPublicKey::parse(&bytes)?;
    let hash=tbc_sdk::hash::hash160(&bytes);
    if context.public_key!=encode_hex(&bytes)||context.public_key_hash!=encode_hex(&hash)
        ||context.address!=Address::from_hash160(hash).to_string() {
        return Err(invalid_plan("Schnorr public context identity is inconsistent"));
    }
    Ok(bytes)
}

fn validate_schnorr_context(input:&PlannedInput,previous:&Script)->Result<Vec<u8>,EngineError> {
    let key=validated_signer_bytes(&input.signer)?;
    if key.len()!=32 {return Err(invalid_plan("Schnorr task requires x-only public key"));}
    let hash=tbc_sdk::hash::hash160(&key);
    let allowed=if input.unlocking_script.starts_with(COIN_UNLOCK_PREFIX) {
        crate::protocols::coin::parse_code(previous.as_bytes()).is_ok_and(|code|
            code.admin_pubkey_hash==hash || code.controller[20]!=0 || code.controller[..20]==hash)
    }else if input.unlocking_script.starts_with(TBC721_UNLOCK_PREFIX) {
        // Full parent Hold and ancestry checks run before requests are emitted.
        crate::protocols::tbc721::parse_code(previous.as_bytes()).is_ok()
    }else if input.unlocking_script.is_empty() {
        let p2pkh=Script::p2pkh(&hash);let p=p2pkh.as_bytes();let actual=previous.as_bytes();
        actual==p || (actual.starts_with(p)&&actual.get(p.len())==Some(&opcodes::OP_RETURN))
    }else{false};
    if !allowed {return Err(invalid_plan("Schnorr public context does not own this supported script"));}
    Ok(key)
}

// Algorithm adapter inside the shared stage/finalize/continuation machine.
// Maximum sizing never exports placeholders as signatures or finalized results.
fn apply_schnorr_signature(transaction:&mut Transaction,input_index:usize,input:&PlannedInput,
    signature:&[u8],plan:&UnsignedPlan,continuation:&SigningContinuation,maximum:bool)->Result<(),EngineError> {
    // Each covenant branch below authenticates its parent and ancestry while
    // preparing the proof. Do not prepare the same proof once here and again
    // for finalization. Plain Hold/P2PKH ownership is checked by the context.
    let script_code=resolve_previous_output_script(input,plan)?;
    let key=validate_schnorr_context(input,&script_code)?;
    if !maximum && signature.len()!=64 {return Err(invalid_signature("Schnorr external signature must be exactly 64 bytes"));}
    let mut wire=if maximum {vec![0;64]}else{signature.to_vec()};wire.push(DEFAULT_SIGHASH as u8);
    let script=if input.unlocking_script.starts_with(COIN_UNLOCK_PREFIX) {
        let proof=resolve_coin_prepared(transaction,input_index,input,plan,continuation)?;
        if maximum {vec![0;proof.max_unlocking_script_bytes()]}else{proof.finalize(&wire)?.into_bytes()}
    }else if input.unlocking_script.starts_with(TBC721_UNLOCK_PREFIX) {
        let proof=resolve_tbc721_prepared(transaction,input_index,input,plan,continuation)?;
        if maximum {vec![0;proof.max_unlocking_script_bytes()]}else{proof.finalize(&wire)?.into_bytes()}
    }else{
        if !maximum {
            let digest=transaction.sighash_digest(input_index,&script_code,input.previous_output_satoshis,DEFAULT_SIGHASH)
                .map_err(|_|invalid_signature("Schnorr digest cannot be formed"))?;
            crate::protocols::covenant_signature::CovenantPublicKey::parse(&key)?.verify_transaction_signature(&digest,&wire)?;
        }
        let mut result=Vec::new();push_script_data(&mut result,&wire)?;push_script_data(&mut result,&key)?;result
    };
    set_bounded_unlocking_script(transaction,input_index,script)
}

fn validate_public_identity(context: &PublicSigningContext) -> Result<PublicKey, EngineError> {
    let public_key = parse_public_key(&context.public_key)?;
    if context.public_key_hash != encode_hex(&public_key.hash160())
        || context.address != public_key.address().to_string()
    {
        return Err(invalid_plan("public signing context identity is inconsistent"));
    }
    Ok(public_key)
}

fn validate_public_context(
    context: &PublicSigningContext,
    previous: &Script,
    unlocking_script: &str,
) -> Result<PublicKey, EngineError> {
    let public_key = parse_public_key(&context.public_key)?;
    let canonical_hash = encode_hex(&public_key.hash160());
    let standard = Script::p2pkh(&public_key.hash160());
    let owns_script = if unlocking_script.starts_with(LOP_MATCH_UNLOCK_PREFIX) {
        // Exact previous-output proof is authenticated before this permissionless
        // input is executed; signer identity here is bookkeeping, not ownership.
        crate::protocols::lop::Code::decode(previous.as_bytes()).is_ok()
    } else if unlocking_script == LOP_CANCEL_DESCRIPTOR {
        crate::protocols::lop::Code::decode(previous.as_bytes())
            .is_ok_and(|code| code.terms.owner_hash == public_key.hash160())
    } else if is_htlc_descriptor(unlocking_script) {
        let branch = HtlcBranch::parse(unlocking_script)?;
        crate::protocols::htlc::Code::decode(previous.as_bytes()).is_ok_and(|code| match branch {
            HtlcBranch::Claim(ref secret) => code.verify_claim(&public_key.hash160(), secret).is_ok(),
            HtlcBranch::Refund => code.sender_hash == public_key.hash160() && code.supported_lock_time().is_ok(),
        })
    } else if unlocking_script == TIMELOCK_UNLOCK_DESCRIPTOR {
        crate::protocols::timelock::Code::decode(previous.as_bytes())
            .is_ok_and(|code| code.owner_hash == public_key.hash160() && code.height_lock().is_ok())
    } else if unlocking_script.starts_with(AMM_POOL_UNLOCK_PREFIX) {
        crate::protocols::amm_profile::Code::decode(previous.as_bytes()).is_ok_and(|code|{
            matches!(code.authorization,crate::protocols::amm_code::Authorization::Public)
                || code.authorization.verify_controller(&public_key.to_bytes()).is_ok()
        })
    } else if unlocking_script.starts_with(COIN_UNLOCK_PREFIX) {
        crate::protocols::coin::parse_code(previous.as_bytes()).is_ok_and(|code| {
            code.admin_pubkey_hash == public_key.hash160()
                || code.controller[20] != 0
                || code.controller[..20] == public_key.hash160()
        })
    } else if unlocking_script.starts_with(AMM_LP_UNLOCK_PREFIX) {
        crate::protocols::amm_lp::parse_code(previous.as_bytes()).is_ok_and(|code| {
            code.controller[20]==1 || code.controller[..20]==public_key.hash160()
        })
    } else if unlocking_script.starts_with(TBC20_UNLOCK_PREFIX) {
        crate::protocols::tbc20::parse_code(previous.as_bytes()).is_ok_and(|code| {
            code.controller[20] != 0
                || code.controller[..20] == public_key.hash160()
        })
    } else if unlocking_script.starts_with(TBC721_UNLOCK_PREFIX) {
        // Full Hold ownership and immediate ancestry are authenticated by
        // resolve_tbc721_prepared before a signing request is exposed.
        crate::protocols::tbc721::parse_code(previous.as_bytes()).is_ok()
    } else if unlocking_script.starts_with(FT_UNLOCK_PREFIX) {
        let info = tbc_sdk::contracts::ft::unlock::classify_ft_script(&previous).ok();
        let bytes = previous.as_bytes();
        let marker_start = bytes.len().checked_sub(5);
        marker_start.is_some_and(|marker_start| {
            info.is_some()
                && marker_start >= 22
                && bytes.get(marker_start - 22..marker_start - 2)
                    == Some(public_key.hash160().as_slice())
                && bytes.get(marker_start - 2) == Some(&0)
        })
    } else if unlocking_script.starts_with(POOL_UNLOCK_PREFIX) {
        tbc_sdk::contracts::pool_nft_v2::scripts::pool_code_source_outpoint(previous).is_ok()
            && tbc_sdk::contracts::pool_nft_v2::unlock::pool_code_lock(previous)
                .is_ok_and(|keys| keys.is_empty() || keys.contains(&public_key))
    } else if unlocking_script.starts_with(POOL_HELD_FT_UNLOCK_PREFIX) {
        tbc_sdk::contracts::ft::unlock::classify_ft_script(previous).is_ok()
    } else if unlocking_script.starts_with(FTLP_UNLOCK_PREFIX) {
        previous
            .as_bytes()
            .windows(public_key.hash160().len())
            .any(|window| window == public_key.hash160().as_slice())
    } else if unlocking_script.starts_with(NFT_UNLOCK_PREFIX) {
        tbc_sdk::contracts::nft::scripts::nft_version(previous).is_some()
    } else {
        *previous == standard
            || is_owned_pool_mint_source(previous, &public_key)
            || *previous
                == tbc_sdk::contracts::ft::scripts::mint_source_script(&public_key.address())
            || *previous == tbc_sdk::contracts::nft::scripts::mint_script(&public_key.address())
            || *previous == tbc_sdk::contracts::nft::scripts::hold_script(&public_key.address())
    };
    if context.public_key_hash != canonical_hash
        || context.address != public_key.address().to_string()
        || !owns_script
    {
        let recipe = if unlocking_script == LOP_CANCEL_DESCRIPTOR {
            "tbc-lop"
        } else if is_htlc_descriptor(unlocking_script) {
            "tbc-htlc"
        } else if unlocking_script == TIMELOCK_UNLOCK_DESCRIPTOR {
            "tbc-timelock"
        } else if unlocking_script.starts_with(AMM_POOL_UNLOCK_PREFIX) {
            "tbc-amm"
        } else if unlocking_script.starts_with(COIN_UNLOCK_PREFIX) {
            "Coin"
        } else if unlocking_script.starts_with(AMM_LP_UNLOCK_PREFIX) {
            "tbc20-lp"
        } else if unlocking_script.starts_with(TBC20_UNLOCK_PREFIX) {
            "TBC20"
        } else if unlocking_script.starts_with(POOL_UNLOCK_PREFIX) {
            "Pool"
        } else if unlocking_script.starts_with(POOL_HELD_FT_UNLOCK_PREFIX) {
            "Pool-held FT"
        } else if unlocking_script.starts_with(FTLP_UNLOCK_PREFIX) {
            "FTLP"
        } else if unlocking_script.starts_with(FT_UNLOCK_PREFIX) {
            "FT"
        } else {
            "P2PKH"
        };
        return Err(invalid_plan(&format!(
            "public signing context does not own the {recipe} previous output script"
        )));
    }
    Ok(public_key)
}

fn is_owned_pool_mint_source(previous: &Script, public_key: &PublicKey) -> bool {
    let mut expected = Script::p2pkh(&public_key.hash160()).as_bytes().to_vec();
    expected.push(opcodes::OP_RETURN);
    expected.push(16);
    expected.extend_from_slice(b"for poolnft mint");
    previous.as_bytes() == expected
}

fn resolve_previous_output_script(
    input: &PlannedInput,
    plan: &UnsignedPlan,
) -> Result<Script, EngineError> {
    resolve_previous_output_script_from_plan(input, plan)
}

fn resolve_previous_output_script_from_plan(
    input: &PlannedInput,
    plan: &UnsignedPlan,
) -> Result<Script, EngineError> {
    if let Some((index, output_index)) =
        parse_evidence_output_descriptor(&input.previous_output_script)?
    {
        let entry = plan
            .evidence_table
            .get(index as usize)
            .ok_or_else(|| invalid_plan("FT previous-output evidence index is out of range"))?;
        let transaction = Transaction::from_hex(&entry.raw_transaction)
            .map_err(|_| invalid_plan("FT previous-output evidence is malformed"))?;
        if transaction.to_hex() != entry.raw_transaction
            || transaction.txid().to_string() != entry.txid
            || transaction.txid().to_string() != input.previous_transaction_id
        {
            return Err(invalid_plan(
                "FT previous-output evidence does not match the planned outpoint",
            ));
        }
        let output = transaction
            .outputs
            .get(output_index as usize)
            .ok_or_else(|| invalid_plan("FT previous-output evidence vout is out of range"))?;
        if output_index != input.previous_output_index
            || output.satoshis != input.previous_output_satoshis
        {
            return Err(invalid_plan(
                "FT previous-output evidence value does not match the planned input",
            ));
        }
        return Ok(output.script_pubkey.clone());
    }
    parse_script(&input.previous_output_script, "previousOutputScript")
}

fn parse_evidence_output_descriptor(value: &str) -> Result<Option<(u32, u32)>, EngineError> {
    let Some(encoded) = value.strip_prefix(FT_EVIDENCE_OUTPUT_PREFIX) else {
        return Ok(None);
    };
    let mut parts = encoded.split(':');
    let index = parts
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| invalid_plan("FT previous-output evidence index is invalid"))?;
    let output_index = parts
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| invalid_plan("FT previous-output evidence vout is invalid"))?;
    if parts.next().is_some() {
        return Err(invalid_plan("FT previous-output evidence descriptor is invalid"));
    }
    Ok(Some((index, output_index)))
}

pub(crate) fn materialize_unsigned_preview(
    planned: &PlannedTransaction,
    plan: &UnsignedPlan,
) -> Result<Transaction, EngineError> {
    let continuation = SigningContinuation {
        session_id: String::new(),
        plan_commitment: String::new(),
        next_stage: 0,
        finalized_transactions: vec![None; plan.transactions.len()],
    };
    materialize_transaction_preview(planned, plan, &continuation)
}

fn materialize_transaction_preview(
    planned: &PlannedTransaction,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
) -> Result<Transaction, EngineError> {
    let mut transaction = Transaction {
        version: planned.version,
        inputs: Vec::with_capacity(planned.inputs.len()),
        outputs: Vec::with_capacity(planned.outputs.len()),
        lock_time: planned.lock_time,
    };
    for input in &planned.inputs {
        let txid = if plan.transactions
            .iter()
            .any(|parent| parent.transaction_id == input.previous_transaction_id)
        {
            Txid::from_le_bytes([0; 32])
        } else {
            parse_txid(&input.previous_transaction_id)?
        };
        transaction.inputs.push(TxIn {
            previous_output: OutPoint {
                txid,
                vout: input.previous_output_index,
            },
            script_sig: Script::empty(),
            sequence: input.sequence,
        });
    }
    for output in &planned.outputs {
        transaction.outputs.push(TxOut {
            satoshis: output.satoshis,
            script_pubkey: resolve_locking_script(&output.locking_script, plan, continuation, true)?,
        });
    }
    Ok(transaction)
}

fn validate_locking_script_descriptor(value: &str) -> Result<(), EngineError> {
    if value.starts_with(crate::protocols::amm_genesis::OUTPUT_PREFIX) {
        crate::protocols::amm_genesis::parse_output(value).map(|_| ())
    } else if value.starts_with(crate::protocols::tbc20_mint::OUTPUT_PREFIX) {
        crate::protocols::tbc20_mint::parse_output(value).map(|_| ())
    } else if value.starts_with(FT_MINT_OUTPUT_PREFIX) {
        parse_ft_mint_output_descriptor(value).map(|_| ())
    } else if value.starts_with(POOL_MINT_OUTPUT_PREFIX) {
        parse_pool_mint_output_descriptor(value).map(|_| ())
    } else {
        parse_script(value, "lockingScript").map(|_| ())
    }
}

fn resolve_locking_script(
    value: &str,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
    placeholder: bool,
) -> Result<Script, EngineError> {
    if value.starts_with(crate::protocols::amm_genesis::OUTPUT_PREFIX) {
        let descriptor=crate::protocols::amm_genesis::parse_output(value)?;
        let txid=if placeholder{Txid::from_le_bytes([0;32])}else{
            let index=plan.transactions.iter().position(|source|source.transaction_id==descriptor.parent_id)
                .ok_or_else(||invalid_plan("AMM genesis Source missing"))?;
            let source=continuation.finalized_transactions.get(index).and_then(Option::as_ref)
                .ok_or_else(||invalid_plan("AMM genesis Source is not finalized"))?;
            parse_txid(&source.txid)?
        };
        return crate::protocols::amm_genesis::instantiate_output(&descriptor,txid);
    }
    if value.starts_with(crate::protocols::tbc20_mint::OUTPUT_PREFIX) {
        let descriptor = crate::protocols::tbc20_mint::parse_output(value)?;
        let txid = if placeholder {
            Txid::from_le_bytes([0; 32])
        } else {
            let index = plan.transactions.iter().position(|source| source.transaction_id == descriptor.parent_id)
                .ok_or_else(|| invalid_plan("TBC20 genesis Source is missing"))?;
            let source = continuation.finalized_transactions.get(index).and_then(Option::as_ref)
                .ok_or_else(|| invalid_plan("TBC20 genesis Source is not finalized"))?;
            parse_txid(&source.txid)?
        };
        return crate::protocols::tbc20_mint::instantiate_output(&descriptor, txid);
    }
    if value.starts_with(POOL_MINT_OUTPUT_PREFIX) {
        return resolve_pool_mint_output(value, plan, continuation, placeholder);
    }
    if !value.starts_with(FT_MINT_OUTPUT_PREFIX) {
        return parse_script(value, "lockingScript");
    }
    let (parent_id, source_vout, address, tape_size) = parse_ft_mint_output_descriptor(value)?;
    let source_txid = if placeholder {
        "00".repeat(32)
    } else {
        let index = plan.transactions
            .iter()
            .position(|transaction| transaction.transaction_id == parent_id)
            .ok_or_else(|| invalid_plan("FT mint source dependency does not exist"))?;
        continuation.finalized_transactions[index]
            .as_ref()
            .ok_or_else(|| invalid_plan("FT mint source dependency is not finalized"))?
            .txid
            .clone()
    };
    let address = tbc_sdk::Address::from_string(&address)
        .map_err(|_| invalid_plan("FT mint recipient address is invalid"))?;
    tbc_sdk::contracts::ft::scripts::mint_code_script_with_version(
        &source_txid,
        source_vout,
        &address,
        tape_size,
        tbc_sdk::contracts::ft::scripts::FtMintVersion::V4,
    )
    .map_err(|_| invalid_plan("could not instantiate the FT V4 mint script"))
}

fn parse_pool_mint_output_descriptor(
    value: &str,
) -> Result<PoolMintOutputDescriptor, EngineError> {
    let encoded = value
        .strip_prefix(POOL_MINT_OUTPUT_PREFIX)
        .ok_or_else(|| invalid_plan("Pool mint output descriptor prefix is invalid"))?;
    let bytes = decode_hex(encoded).map_err(|_| invalid_plan("Pool mint output descriptor hex is invalid"))?;
    if bytes.len() > MAX_POOL_RECIPE_SERIALIZED_BYTES {
        return Err(invalid_plan("Pool mint output descriptor exceeds the byte budget"));
    }
    let descriptor = serde_json::from_slice::<PoolMintOutputDescriptor>(&bytes)
        .map_err(|_| invalid_plan("Pool mint output descriptor is invalid"))?;
    if descriptor.parent_id.is_empty()
        || descriptor.service_provider_tag.is_empty()
        || descriptor.service_provider_tag.len() > 64
        || !(1..=6).contains(&descriptor.lp_plan)
        || descriptor.public_key_lock.len() > MAX_POOL_PUBLIC_KEY_LOCKS
        || descriptor.lp_cost_address.is_some() != descriptor.lp_cost_sat.is_some()
        || descriptor.ft_a_partial_hash.is_empty()
    {
        return Err(invalid_plan("Pool mint output descriptor is invalid"));
    }
    Ok(descriptor)
}

fn resolve_pool_mint_output(
    value: &str,
    plan: &UnsignedPlan,
    continuation: &SigningContinuation,
    placeholder: bool,
) -> Result<Script, EngineError> {
    let descriptor = parse_pool_mint_output_descriptor(value)?;
    let source_txid = if placeholder {
        Txid::from_le_bytes([0; 32])
    } else {
        let index = plan.transactions
            .iter()
            .position(|transaction| transaction.transaction_id == descriptor.parent_id)
            .ok_or_else(|| invalid_plan("Pool mint source dependency does not exist"))?;
        continuation.finalized_transactions[index]
            .as_ref()
            .ok_or_else(|| invalid_plan("Pool mint source dependency is not finalized"))?
            .txid
            .parse::<Txid>()
            .map_err(|_| invalid_plan("Pool mint source transaction id is invalid"))?
    };
    let ft_version = match descriptor.ft_version {
        1 => FtScriptVersion::V1,
        2 => FtScriptVersion::V2,
        3 => FtScriptVersion::V3,
        4 => FtScriptVersion::V4,
        _ => return Err(invalid_plan("Pool mint FT version is unsupported")),
    };
    let params = PoolCodeParams {
        lp_plan: descriptor.lp_plan,
        ft_version,
        is_coin: descriptor.is_coin,
    };
    let source = OutPoint { txid: source_txid, vout: descriptor.source_vout };
    let code = if let (Some(address), Some(satoshis)) = (
        descriptor.lp_cost_address.as_deref(),
        descriptor.lp_cost_sat,
    ) {
        let address = Address::from_string(address)
            .map_err(|_| invalid_plan("Pool mint LP cost address is invalid"))?;
        let keys = descriptor.public_key_lock.iter()
            .map(|key| decode_hex(key).map_err(|_| invalid_plan("Pool mint public-key lock hex is invalid"))
                .and_then(|bytes| PublicKey::from_slice(&bytes)
                    .map_err(|_| invalid_plan("Pool mint public-key lock is invalid"))))
            .collect::<Result<Vec<_>, _>>()?;
        locked_pool_code(
            source,
            descriptor.service_provider_tag.as_bytes(),
            &keys,
            &LockedPoolCodeParams { pool: params, lp_cost_address: address, lp_cost_sat: satoshis },
        )
    } else {
        if !descriptor.public_key_lock.is_empty() {
            return Err(invalid_plan("Pool mint lock cost binding is incomplete"));
        }
        pool_code(source, descriptor.service_provider_tag.as_bytes(), &params)
    }
    .map_err(|_| invalid_plan("could not instantiate released Pool Code"))?;
    if descriptor.kind == PoolMintOutputKind::Code {
        return Ok(code);
    }
    let zero_ftlp_tape = parse_script(&descriptor.zero_ftlp_tape, "zeroFtlpTape")?;
    let ftlp_params = FtlpCodeParams::for_tape(&zero_ftlp_tape, ft_version, descriptor.is_coin)
        .map_err(|_| invalid_plan("could not derive Pool mint FTLP parameters"))?;
    let receiver = Address::from_string(&descriptor.ftlp_receiver)
        .map_err(|_| invalid_plan("Pool mint FTLP receiver is invalid"))?;
    let pool_hash = tbc_sdk::hash::sha256(code.as_bytes());
    let ftlp = if descriptor.ftlp_lock_time_enabled {
        ftlp_lock_time_code(pool_hash, &receiver, &ftlp_params)
    } else {
        ftlp_code(pool_hash, &receiver, &ftlp_params)
    }
    .map_err(|_| invalid_plan("could not instantiate released FTLP Code"))?;
    let partial = partial_hash_offset(descriptor.ft_version, descriptor.is_coin)?;
    let contract_id = descriptor.ft_a_contract_id.parse::<Txid>()
        .map_err(|_| invalid_plan("Pool mint FT contract id is invalid"))?;
    pool_tape(&PoolState {
        amounts: PoolAmounts { ft_lp_raw: 0, ft_a_raw: 0, tbc_sat: 0 },
        ft_lp_partial_hash: calculate_partial_hash(&ftlp.as_bytes()[..partial]).to_vec(),
        ft_a_partial_hash: descriptor.ft_a_partial_hash,
        ft_a_contract_id: contract_id,
        service_fee_rate: descriptor.service_fee_rate,
        service_provider: descriptor.service_provider_tag,
        lp_plan: descriptor.lp_plan,
        public_key_locked: !descriptor.public_key_lock.is_empty(),
        ftlp_lock_time_enabled: descriptor.ftlp_lock_time_enabled,
    })
    .map_err(|_| invalid_plan("could not instantiate released Pool Tape"))
}

fn parse_ft_mint_output_descriptor(
    value: &str,
) -> Result<(String, u32, String, usize), EngineError> {
    let mut parts = value
        .strip_prefix(FT_MINT_OUTPUT_PREFIX)
        .ok_or_else(|| invalid_plan("FT mint output descriptor prefix is invalid"))?
        .split(':');
    let parent_id = parts.next().unwrap_or_default().to_owned();
    let source_vout = parts
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| invalid_plan("FT mint source output index is invalid"))?;
    let address = parts.next().unwrap_or_default().to_owned();
    let tape_size = parts
        .next()
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or_else(|| invalid_plan("FT mint Tape size is invalid"))?;
    if parent_id.is_empty() || address.is_empty() || tape_size > u16::MAX as usize || parts.next().is_some() {
        return Err(invalid_plan("FT mint output descriptor is invalid"));
    }
    Ok((parent_id, source_vout, address, tape_size))
}

fn plan_session_id(plan: &UnsignedPlan) -> Result<String, EngineError> {
    canonical_sha256(plan)
        .map(|digest| encode_hex(&digest))
        .map_err(|_| internal("could not serialize unsigned plan"))
}

pub(crate) fn unsigned_plan_commitment(plan: &UnsignedPlan) -> Result<String, EngineError> {
    plan_session_id(plan)
}

fn continuation_commitment(continuation: &SigningContinuation) -> Result<String, EngineError> {
    canonical_sha256(continuation)
        .map(|digest| encode_hex(&digest))
        .map_err(|_| internal("could not serialize signing continuation"))
}

fn parse_public_key(value: &str) -> Result<PublicKey, EngineError> {
    let bytes = decode_hex(value).map_err(|_| invalid_plan("public key is not valid hexadecimal"))?;
    PublicKey::from_slice(&bytes).map_err(|_| invalid_plan("public key is not valid secp256k1"))
}

pub(crate) fn parse_script(value: &str, path: &str) -> Result<Script, EngineError> {
    decode_hex(value)
        .map(Script::from_bytes)
        .map_err(|_| error(ErrorCode::InvalidPlan, "script is not valid hexadecimal", path))
}

fn parse_txid(value: &str) -> Result<Txid, EngineError> {
    value
        .parse()
        .map_err(|_| invalid_plan("previous transaction identifier is invalid"))
}

fn decode_hex(value: &str) -> Result<Vec<u8>, ()> {
    let bytes = value.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return Err(());
    }
    bytes
        .chunks_exact(2)
        .map(|pair| {
            let high = hex_nibble(pair[0])?;
            let low = hex_nibble(pair[1])?;
            Ok((high << 4) | low)
        })
        .collect()
}

fn hex_nibble(byte: u8) -> Result<u8, ()> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(()),
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn invalid_plan(message: &str) -> EngineError {
    error(ErrorCode::InvalidPlan, message, "plan")
}

fn invalid_signature(message: &str) -> EngineError {
    error(ErrorCode::InvalidSignature, message, "signatures")
}

fn internal(message: &str) -> EngineError {
    EngineError {
        code: ErrorCode::InternalInvariant,
        message: message.to_owned(),
        path: None,
    }
}

fn error(code: ErrorCode, message: &str, path: &str) -> EngineError {
    EngineError {
        code,
        message: message.to_owned(),
        path: Some(path.to_owned()),
    }
}
