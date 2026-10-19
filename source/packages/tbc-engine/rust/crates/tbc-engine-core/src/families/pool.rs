use std::collections::{BTreeMap, BTreeSet};

use tbc_sdk::{
    Address, DEFAULT_SEQUENCE, OutPoint, PublicKey, Transaction, TxIn, TxOut, Txid,
    contracts::{
        ft::{
            amount::balance_from_tape,
            partial_sha256::calculate_partial_hash,
            scripts::{
                FT_CODE_SATOSHIS, FtCodeReceiver, transfer_code_script, transfer_tape_script,
            },
            unlock::classify_ft_script,
        },
        pool_nft_v2::{
            FTLP_CODE_SATOSHIS, FtlpCodeParams, FtlpTapeLayout, FtlpTapeParams,
            FtScriptVersion, LockedPoolCodeParams, PoolAmounts, PoolCodeParams, PoolState,
            consume_lp, ftlp_code, ftlp_lock_time_code, ftlp_tape, increase_lp, initial_lp_raw,
            locked_pool_code, pool_code, pool_held_ft_code, pool_tape, swap_ft_to_tbc,
            swap_tbc_to_ft,
            scripts::{pool_code_source_outpoint, transfer_ftlp_code_script},
            unlock::pool_code_lock,
        },
    },
    hash,
    script::Script,
};

use crate::funding::NativeFundingUtxo;
use crate::model::{
    AssetFlow, CanonicalRequest, ParentTransaction, PlannedTransfer, PoolLock,
    ResolvedPoolPolicy, Violation, WalletMaterial, WalletUtxo, error,
};
use crate::normalize::{hex, parse_decimal_u64};
use crate::signing::{
    EvidenceEntry, FtlpLockMode, FtlpUnlockRecipe, PlannedInput, PlannedOutput,
    PlannedTransaction, PoolHeldFtUnlockRecipe, PoolRecipeOperation, PoolRecipeSwap,
    PoolUnlockRecipe, ProofReference, PublicSigningContext, TransactionSource, UnsignedPlan,
    ft_unlocking_descriptor, ftlp_unlocking_descriptor, pool_held_ft_unlocking_descriptor,
    pool_mint_output_descriptor, pool_unlocking_descriptor, materialize_unsigned_preview,
    PoolMintOutputDescriptor, PoolMintOutputKind,
};
use crate::{EngineError, ErrorCode};

use super::ft::{
    checked_sum_u64, enforce_max_fee, estimate_p2pkh_fee, fee_rate, finish_plan,
    funding_candidates, invalid_input, native_input, p2pkh_outputs_with_optional_change,
    planned_output, transaction_from_parts, validate_material_identity, validate_policy,
};

// Pinned source: pool_nft_v2/builder.rs and math.rs at 923497e8.
const POOL_MINT_SOURCE_SATOSHIS: u64 = 9_800;
const POOL_MINT_SOURCE_MARKER: &[u8] = b"for poolnft mint";
const MAX_POOL_FT_INPUTS: usize = 3;
const MAX_SWAP_POOL_FT_INPUTS: usize = 4;
const MAX_UNLOCK_FTLP_INPUTS: usize = 6;
const MAX_MERGE_FTLP_INPUTS: usize = 5;
const MAX_POOL_FT_MERGE_INPUTS: usize = 4;
const MAX_POOL_CANDIDATES: usize = 128;
const MAX_LOCK_HEIGHT: u32 = 500_000_000;
const FTLP_BURN_ADDRESS: &str = "1BitcoinEaterAddressDontSendf59kuE";
const SERVICE_FEE_ADDRESSES: [&str; 6] = [
    "13oCEJaqyyiC8iRrfup6PDL2GKZ3xQrsZL",
    "1Fa6Uy64Ub4qNdB896zX2pNMx4a8zMhtCy",
    "125fTLNsraQxTYqT4EeQNF2ggzcqicveKL",
    "19DetoaaohQkjFVJ6oGXd83xhZYQSbpE1g",
    "15EKrhuD8Yf3SfhjAgbizYqfnBbKh9ZMZ7",
    "1N7rf2AuAHB2aCrVgnbQhSWhaUVk3rGhjm",
];

// Pinned source: pool_nft_v2/scripts.rs::locked_pool_lp_cost at 923497e8.
fn released_locked_pool_lp_cost(script: &Script) -> Result<(Address, u64), EngineError> {
    crate::protocols::historical_pool::released_locked_pool_lp_cost(script)
        .map_err(|message| invalid_input(&message, "snapshot.payload.utxos"))
}

#[derive(Clone)]
struct AuthenticatedUtxo {
    utxo: WalletUtxo,
    parent: Transaction,
    output: TxOut,
    tape: Option<Script>,
    balance: Option<u128>,
}

struct Authority {
    contract_id: Txid,
    contract: Option<Transaction>,
    code: Script,
    tape: Script,
    version: u8,
    script_version: FtScriptVersion,
    is_coin: bool,
    name: String,
    symbol: String,
}

impl Authority {
    fn source(&self, evidence: &mut EvidenceBuilder, parents: &ParentIndex) -> Result<crate::signing::PoolContractSource, EngineError> {
        match &self.contract {
            Some(tx) => Ok(evidence.source(tx, parents)?.into()),
            None => Ok(crate::signing::PoolContractSource::Indexed(crate::signing::IndexedPoolContract {
                contract_id: self.contract_id.to_string(),
                code_script: hex(self.code.as_bytes()),
                tape_script: hex(self.tape.as_bytes()),
            })),
        }
    }
}

struct LivePool {
    current: AuthenticatedUtxo,
    predecessor: Transaction,
    contract_id: Txid,
    state: PoolState,
    authority: Authority,
    public_keys: Vec<PublicKey>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum MaintenanceKind {
    PoolFt,
    Ftlp,
}

struct MaintenanceArtifacts {
    kind: MaintenanceKind,
    transaction: PlannedTransaction,
    preview: Transaction,
    fee_paid: u64,
    asset: AuthenticatedUtxo,
    fee: NativeFundingUtxo,
    proofs: Vec<ProofReference>,
}

struct ParentIndex {
    by_txid: BTreeMap<String, (Transaction, String)>,
}

impl ParentIndex {
    fn new(parents: &[ParentTransaction]) -> Result<Self, EngineError> {
        let mut by_txid = BTreeMap::new();
        for parent in parents {
            let transaction = Transaction::from_hex(&parent.raw_transaction).map_err(|_| {
                ancestry("parent transaction is malformed", "snapshot.payload.parents")
            })?;
            if transaction.to_hex() != parent.raw_transaction
                || transaction.txid().to_string() != parent.txid
            {
                return Err(ancestry(
                    "parent transaction bytes do not match txid",
                    "snapshot.payload.parents",
                ));
            }
            if by_txid
                .insert(
                    parent.txid.clone(),
                    (transaction, parent.raw_transaction.clone()),
                )
                .is_some()
            {
                return Err(ancestry(
                    "duplicate parent transaction",
                    "snapshot.payload.parents",
                ));
            }
        }
        Ok(Self { by_txid })
    }

    fn get(&self, txid: &str) -> Result<&Transaction, EngineError> {
        self.by_txid
            .get(txid)
            .map(|value| &value.0)
            .ok_or_else(|| {
                ancestry(
                &format!("authenticated parent transaction is missing: {txid}"),
                    "snapshot.payload.parents",
                )
            })
    }

    fn raw(&self, txid: &str) -> Result<&str, EngineError> {
        self.by_txid
            .get(txid)
            .map(|value| value.1.as_str())
            .ok_or_else(|| {
                ancestry(
                    "authenticated parent transaction is missing",
                    "snapshot.payload.parents",
                )
            })
    }
}

#[derive(Default)]
struct EvidenceBuilder {
    entries: Vec<EvidenceEntry>,
    indexes: BTreeMap<String, u32>,
}

impl EvidenceBuilder {
    fn source(
        &mut self,
        transaction: &Transaction,
        parents: &ParentIndex,
    ) -> Result<TransactionSource, EngineError> {
        let txid = transaction.txid().to_string();
        if let Some(index) = self.indexes.get(&txid) {
            return Ok(TransactionSource::Evidence(*index));
        }
        let index = u32::try_from(self.entries.len()).map_err(|_| {
            invalid_input(
                "Pool evidence index exceeds uint32",
                "snapshot.payload.parents",
            )
        })?;
        self.entries.push(EvidenceEntry {
            txid: txid.clone(),
            raw_transaction: parents.raw(&txid)?.to_owned(),
        });
        self.indexes.insert(txid, index);
        Ok(TransactionSource::Evidence(index))
    }
}

pub(crate) fn validate_pool_request(request: &CanonicalRequest) -> Result<(), EngineError> {
    let intent = &request.intent;
    if intent.intent_type != "tbc.pool.create" && intent.stage.is_some() {
        return Err(invalid_input(
            "Pool stage is only valid for Pool creation",
            "request.intent.stage",
        ));
    }
    match intent.intent_type.as_str() {
        "tbc.pool.create" => {
            match intent.stage.as_deref() {
                Some("mint") => {
                    validate_create_policy_fields(request)?;
                    forbid_pool_fields(intent, &["poolContractId", "initialLiquidity", "receiver", "tbcAmount", "ftAmount", "lpAmount", "minimumLpAmount", "minimumTbcAmount", "minimumFtAmount", "lockUntilHeight"])?;
                    return Ok(());
                }
                Some("initialize") => {
                    validate_contract(required(&intent.pool_contract_id, "request.intent.poolContractId")?, "request.intent.poolContractId")?;
                    validate_initial_liquidity(request)?;
                    forbid_pool_fields(intent, &["ftContractId", "lpPlan", "serviceProviderTag", "receiver", "tbcAmount", "ftAmount", "lpAmount", "minimumLpAmount", "minimumTbcAmount", "minimumFtAmount", "lock", "lockUntilHeight"])?;
                    return Ok(());
                }
                Some(_) => return Err(invalid_input("unsupported Pool create stage", "request.intent.stage")),
                None => {}
            }
            validate_create_policy_fields(request)?;
            validate_initial_liquidity(request)?;
            forbid_pool_fields(
                intent,
                &[
                    "poolContractId",
                    "receiver",
                    "tbcAmount",
                    "ftAmount",
                    "lpAmount",
                    "minimumLpAmount",
                    "minimumTbcAmount",
                    "minimumFtAmount",
                    "lockUntilHeight",
                ],
            )?;
        }
        "tbc.pool.liquidity.add" => {
            validate_live_common(request)?;
            positive(
                required(&intent.tbc_amount, "request.intent.tbcAmount")?,
                "request.intent.tbcAmount",
            )?;
            positive(
                required(
                    &intent.minimum_lp_amount,
                    "request.intent.minimumLpAmount",
                )?,
                "request.intent.minimumLpAmount",
            )?;
            if let Some(height) = intent.lock_until_height.as_deref() {
                validate_height(height, "request.intent.lockUntilHeight")?;
            }
            forbid_pool_fields(
                intent,
                &[
                    "ftContractId",
                    "lpPlan",
                    "serviceProviderTag",
                    "initialLiquidity",
                    "ftAmount",
                    "lpAmount",
                    "minimumTbcAmount",
                    "minimumFtAmount",
                    "lock",
                ],
            )?;
        }
        "tbc.pool.liquidity.remove" => {
            validate_live_common(request)?;
            positive(
                required(&intent.lp_amount, "request.intent.lpAmount")?,
                "request.intent.lpAmount",
            )?;
            positive(
                required(
                    &intent.minimum_tbc_amount,
                    "request.intent.minimumTbcAmount",
                )?,
                "request.intent.minimumTbcAmount",
            )?;
            positive(
                required(
                    &intent.minimum_ft_amount,
                    "request.intent.minimumFtAmount",
                )?,
                "request.intent.minimumFtAmount",
            )?;
            forbid_pool_fields(
                intent,
                &[
                    "ftContractId",
                    "lpPlan",
                    "serviceProviderTag",
                    "initialLiquidity",
                    "tbcAmount",
                    "ftAmount",
                    "minimumLpAmount",
                    "lock",
                    "lockUntilHeight",
                ],
            )?;
        }
        "tbc.pool.liquidity.close" => {
            validate_contract(
                required(&intent.pool_contract_id, "request.intent.poolContractId")?,
                "request.intent.poolContractId",
            )?;
            forbid_pool_fields(
                intent,
                &[
                    "ftContractId",
                    "lpPlan",
                    "serviceProviderTag",
                    "initialLiquidity",
                    "receiver",
                    "tbcAmount",
                    "ftAmount",
                    "lpAmount",
                    "minimumLpAmount",
                    "minimumTbcAmount",
                    "minimumFtAmount",
                    "lock",
                    "lockUntilHeight",
                ],
            )?;
        }
        "tbc.pool.swap.exactTbcForToken" => {
            validate_live_common(request)?;
            positive(
                required(&intent.tbc_amount, "request.intent.tbcAmount")?,
                "request.intent.tbcAmount",
            )?;
            positive(
                required(
                    &intent.minimum_ft_amount,
                    "request.intent.minimumFtAmount",
                )?,
                "request.intent.minimumFtAmount",
            )?;
            validate_swap_constraints(request)?;
            forbid_pool_fields(
                intent,
                &[
                    "ftContractId",
                    "lpPlan",
                    "serviceProviderTag",
                    "initialLiquidity",
                    "ftAmount",
                    "lpAmount",
                    "minimumLpAmount",
                    "minimumTbcAmount",
                    "lock",
                    "lockUntilHeight",
                ],
            )?;
        }
        "tbc.pool.swap.exactTokenForTbc" => {
            validate_live_common(request)?;
            positive(
                required(&intent.ft_amount, "request.intent.ftAmount")?,
                "request.intent.ftAmount",
            )?;
            positive(
                required(
                    &intent.minimum_tbc_amount,
                    "request.intent.minimumTbcAmount",
                )?,
                "request.intent.minimumTbcAmount",
            )?;
            validate_swap_constraints(request)?;
            forbid_pool_fields(
                intent,
                &[
                    "ftContractId",
                    "lpPlan",
                    "serviceProviderTag",
                    "initialLiquidity",
                    "tbcAmount",
                    "lpAmount",
                    "minimumLpAmount",
                    "minimumFtAmount",
                    "lock",
                    "lockUntilHeight",
                ],
            )?;
        }
        "tbc.pool.ft.merge" | "tbc.pool.ftlp.merge" | "tbc.pool.ftlp.burn" => {
            validate_contract(
                required(&intent.pool_contract_id, "request.intent.poolContractId")?,
                "request.intent.poolContractId",
            )?;
            forbid_pool_fields(
                intent,
                &[
                    "ftContractId",
                    "lpPlan",
                    "serviceProviderTag",
                    "initialLiquidity",
                    "receiver",
                    "tbcAmount",
                    "ftAmount",
                    "lpAmount",
                    "minimumLpAmount",
                    "minimumTbcAmount",
                    "minimumFtAmount",
                    "lock",
                    "lockUntilHeight",
                ],
            )?;
        }
        _ => {
            return Err(error(
                ErrorCode::UnsupportedIntent,
                "unsupported Pool intent",
                "request.intent.type",
            ));
        }
    }
    Ok(())
}

pub(crate) fn plan_pool(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
) -> Result<PlannedTransfer, EngineError> {
    validate_pool_request(request)?;
    validate_material_identity(request, material)?;
    validate_policy(material)?;
    if material.snapshot.payload.block.is_some() && snapshot_height(material)? >= MAX_LOCK_HEIGHT {
        return Err(invalid_input(
            "Pool snapshot height is outside the released block-height domain",
            "snapshot.payload.block.height",
        ));
    }
    let policy = pool_policy(material)?;
    let parents = ParentIndex::new(&material.snapshot.payload.parents)?;
    let planned = match request.intent.intent_type.as_str() {
        "tbc.pool.create" => match request.intent.stage.as_deref() {
            Some("mint") => plan_create_mint(request, material, signing, policy, &parents),
            Some("initialize") => plan_initialize(request, material, signing, policy, &parents),
            _ => plan_create(request, material, signing, policy, &parents),
        },
        "tbc.pool.liquidity.add" => plan_add(request, material, signing, policy, &parents),
        "tbc.pool.liquidity.remove" => {
            plan_consume(request, material, signing, policy, &parents, false)
        }
        "tbc.pool.liquidity.close" => {
            plan_consume(request, material, signing, policy, &parents, true)
        }
        "tbc.pool.swap.exactTbcForToken" => {
            plan_swap_tbc(request, material, signing, policy, &parents)
        }
        "tbc.pool.swap.exactTokenForTbc" => {
            plan_swap_ft(request, material, signing, policy, &parents)
        }
        "tbc.pool.ft.merge" => {
            plan_public_pool_ft_merge(request, material, signing, policy, &parents)
        }
        "tbc.pool.ftlp.merge" => {
            plan_public_ftlp_merge(request, material, signing, policy, &parents)
        }
        "tbc.pool.ftlp.burn" => {
            plan_public_ftlp_burn(request, material, signing, policy, &parents)
        }
        _ => unreachable!(),
    }?;
    if planned.unsigned_plan.transactions.len()
        > material.policy.payload.max_bundle_transactions as usize
    {
        return Err(error(
            ErrorCode::InvalidInput,
            "Pool plan exceeds max bundle transactions",
            "policy.payload.maxBundleTransactions",
        ));
    }
    Ok(planned)
}

fn plan_public_pool_ft_merge(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
    policy: &ResolvedPoolPolicy,
    parents: &ParentIndex,
) -> Result<PlannedTransfer, EngineError> {
    let live = live_pool(request, material, policy, parents)?;
    let mut candidates = pool_ft_candidates(material, parents, &live)?;
    candidates.sort_by(|left, right| {
        left.balance
            .cmp(&right.balance)
            .then_with(|| left.utxo.txid.cmp(&right.utxo.txid))
            .then_with(|| left.utxo.vout.cmp(&right.utxo.vout))
    });
    if !(2..=MAX_POOL_FT_MERGE_INPUTS).contains(&candidates.len()) {
        return Err(error(
            if candidates.len() < 2 {
                ErrorCode::InsufficientFunds
            } else {
                ErrorCode::InvalidInput
            },
            format!(
                "Pool FT merge requires 2..={MAX_POOL_FT_MERGE_INPUTS} selected inputs"
            ),
            "snapshot.payload.utxos",
        ));
    }
    let total = sum_u128(
        &candidates
            .iter()
            .map(|candidate| candidate.balance.expect("Pool FT balance"))
            .collect::<Vec<_>>(),
    )?;
    let fee = select_fee(material, signing)?;
    let mut evidence = EvidenceBuilder::default();
    let artifacts = build_pool_ft_maintenance(
        &live,
        candidates,
        fee,
        material,
        signing,
        parents,
        &mut evidence,
        1,
        0,
        &[],
        None,
    )?;
    let mut transaction = artifacts.transaction;
    transaction.role = "primary".to_owned();
    finish_pool(
        request,
        material,
        UnsignedPlan {
            transactions: vec![transaction],
            evidence_table: evidence.entries,
        },
        vec![artifacts.preview],
        vec![artifacts.fee_paid],
        vec![AssetFlow {
            kind: "ft".to_owned(),
            direction: "merge".to_owned(),
            amount: total.to_string(),
            contract_id: Some(live.authority.contract_id.to_string()),
            from: request.from.clone(),
            to: Some(request.from.clone()),
        }],
    )
}

fn plan_public_ftlp_merge(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
    policy: &ResolvedPoolPolicy,
    parents: &ParentIndex,
) -> Result<PlannedTransfer, EngineError> {
    let live = live_pool(request, material, policy, parents)?;
    let mut candidates = ftlp_candidates(material, parents, &live)?;
    candidates.sort_by(|left, right| {
        left.balance
            .cmp(&right.balance)
            .then_with(|| left.utxo.txid.cmp(&right.utxo.txid))
            .then_with(|| left.utxo.vout.cmp(&right.utxo.vout))
    });
    if !(2..=MAX_MERGE_FTLP_INPUTS).contains(&candidates.len()) {
        return Err(error(
            if candidates.len() < 2 {
                ErrorCode::InsufficientFunds
            } else {
                ErrorCode::InvalidInput
            },
            format!("FTLP merge requires 2..={MAX_MERGE_FTLP_INPUTS} selected inputs"),
            "snapshot.payload.utxos",
        ));
    }
    let total = sum_u128(
        &candidates
            .iter()
            .map(|candidate| candidate.balance.expect("FTLP balance"))
            .collect::<Vec<_>>(),
    )?;
    let fee = select_fee(material, signing)?;
    let mut evidence = EvidenceBuilder::default();
    let artifacts = build_ftlp_maintenance(
        &live,
        candidates,
        fee,
        material,
        signing,
        parents,
        &mut evidence,
        None,
        0,
    )?;
    let mut transaction = artifacts.transaction;
    transaction.transaction_id = "ftlp-merge-1".to_owned();
    transaction.role = "primary".to_owned();
    transaction.stage = 0;
    finish_pool(
        request,
        material,
        UnsignedPlan {
            transactions: vec![transaction],
            evidence_table: evidence.entries,
        },
        vec![artifacts.preview],
        vec![artifacts.fee_paid],
        vec![AssetFlow {
            kind: "lp".to_owned(),
            direction: "merge".to_owned(),
            amount: total.to_string(),
            contract_id: None,
            from: request.from.clone(),
            to: Some(request.from.clone()),
        }],
    )
}

fn plan_public_ftlp_burn(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
    policy: &ResolvedPoolPolicy,
    parents: &ParentIndex,
) -> Result<PlannedTransfer, EngineError> {
    let live = live_pool(request, material, policy, parents)?;
    let mut candidates = ftlp_candidates(material, parents, &live)?;
    if live.state.ftlp_lock_time_enabled {
        candidates.retain(|candidate| ftlp_lock_height(candidate).is_ok_and(|height| height == 0));
    }
    candidates.sort_by(|left, right| {
        left.balance
            .cmp(&right.balance)
            .then_with(|| left.utxo.txid.cmp(&right.utxo.txid))
            .then_with(|| left.utxo.vout.cmp(&right.utxo.vout))
    });
    if !(1..=MAX_MERGE_FTLP_INPUTS).contains(&candidates.len()) {
        return Err(error(
            if candidates.is_empty() { ErrorCode::InsufficientFunds } else { ErrorCode::InvalidInput },
            format!("FTLP burn requires 1..={MAX_MERGE_FTLP_INPUTS} selected whole inputs"),
            "snapshot.payload.utxos",
        ));
    }
    let balances = candidates
        .iter()
        .map(|candidate| candidate.balance.expect("FTLP balance"))
        .collect::<Vec<_>>();
    let total = sum_u128(&balances)?;
    let (burned_slots, _) = build_tape_amount_with_offset(total, &balances, 0)?;
    let fee = select_fee(material, signing)?;
    let mut evidence = EvidenceBuilder::default();
    let count = u8::try_from(candidates.len()).unwrap();
    let mut inputs = Vec::with_capacity(candidates.len() + 1);
    for (index, candidate) in candidates.iter().enumerate() {
        let recipe = ftlp_unlocking_descriptor(FtlpUnlockRecipe {
            parent: evidence.source(&candidate.parent, parents)?,
            proof_references: proofs_for(candidate, parents, &mut evidence)?,
            lock: ftlp_lock_mode(candidate, &live, material)?,
            ordered_input_index: u8::try_from(index).unwrap(),
            ordered_input_count: count,
        })?;
        inputs.push(planned_input(
            candidate,
            recipe,
            signing,
            if live.state.ftlp_lock_time_enabled { DEFAULT_SEQUENCE - 1 } else { DEFAULT_SEQUENCE },
        ));
    }
    inputs.push(native_planned_input(&fee, signing));
    let eater = Address::from_string(FTLP_BURN_ADDRESS).unwrap();
    let outputs = vec![
        TxOut {
            satoshis: candidates[0].output.satoshis,
            script_pubkey: transfer_ftlp_code_script(&candidates[0].output.script_pubkey, &eater)
                .map_err(|_| invalid_input("could not build FTLP burn Code", "request.intent"))?,
        },
        TxOut {
            satoshis: 0,
            script_pubkey: transfer_tape_script(&live.authority.tape, &burned_slots)
                .map_err(|_| invalid_input("could not build FTLP burn Tape", "request.intent"))?,
        },
    ];
    let (transaction, preview, fee_paid) = build_planned_transaction_with_policy(
        "ftlp-burn-1",
        "primary",
        0,
        vec![],
        inputs,
        outputs,
        tbc_sdk::DEFAULT_FEE_RATE_SAT_PER_KB,
        signing,
        true,
        0,
    )?;
    finish_pool(
        request,
        material,
        UnsignedPlan { transactions: vec![transaction], evidence_table: evidence.entries },
        vec![preview],
        vec![fee_paid],
        vec![AssetFlow {
            kind: "lp".to_owned(),
            direction: "burn".to_owned(),
            amount: total.to_string(),
            contract_id: Some(required(&request.intent.pool_contract_id, "request.intent.poolContractId")?.to_owned()),
            from: request.from.clone(),
            to: Some(FTLP_BURN_ADDRESS.to_owned()),
        }],
    )
}

fn plan_create_mint(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
    policy: &ResolvedPoolPolicy,
    parents: &ParentIndex,
) -> Result<PlannedTransfer, EngineError> {
    validate_create_policy_match(request, policy)?;
    let authority = authority(required(&request.intent.ft_contract_id, "request.intent.ftContractId")?, material, parents)?;
    let current_height = snapshot_height(material)?;
    let (keys, lp_cost, until_height) = create_lock(request.intent.lock.as_ref(), current_height)?;
    let account = Address::from_string(&signing.address)
        .map_err(|_| invalid_input("invalid Pool source owner", "snapshot.payload.account"))?;
    let mut source_bytes = account.script_pubkey().as_bytes().to_vec();
    source_bytes.push(tbc_sdk::script::opcodes::OP_RETURN);
    source_bytes.push(u8::try_from(POOL_MINT_SOURCE_MARKER.len()).expect("fixed marker length"));
    source_bytes.extend_from_slice(POOL_MINT_SOURCE_MARKER);
    let source_script = Script::from_bytes(source_bytes);
    let zero_ftlp_tape = if let Some(height) = until_height {
        ftlp_tape(&FtlpTapeParams { amount_raw: 0, layout: FtlpTapeLayout::LockTime { lock_time: height, source_ft_tape_size: authority.tape.as_bytes().len() } })
    } else {
        standard_ftlp_tape(0, &authority)
    }.map_err(|_| invalid_input("could not build released FTLP Tape", "request.intent.lock"))?;
    let partial = partial_hash_offset(authority.version, authority.is_coin)?;
    let base_descriptor = PoolMintOutputDescriptor {
        kind: PoolMintOutputKind::Code,
        parent_id: "pool-mint-source".to_owned(),
        source_vout: 0,
        service_provider_tag: policy.service_provider_tag.clone(),
        lp_plan: policy.lp_plan,
        ft_version: authority.version,
        is_coin: authority.is_coin,
        public_key_lock: keys.iter().map(|key| hex(&key.to_bytes())).collect(),
        lp_cost_address: lp_cost.as_ref().map(|item| item.0.to_string()),
        lp_cost_sat: lp_cost.as_ref().map(|item| item.1),
        zero_ftlp_tape: hex(zero_ftlp_tape.as_bytes()),
        ftlp_receiver: request.from.clone(),
        ft_a_partial_hash: calculate_partial_hash(&authority.code.as_bytes()[..partial]).to_vec(),
        ft_a_contract_id: authority.contract_id.to_string(),
        service_fee_rate: policy.service_fee_rate,
        ftlp_lock_time_enabled: until_height.is_some(),
    };
    let rate = fee_rate(material)?;
    enforce_pool_amount_limit(material, "native", None, POOL_MINT_SOURCE_SATOSHIS, "request.intent")?;
    for funding in funding_candidates(material, signing)? {
        let Some((source_outputs, source_fee)) = p2pkh_outputs_with_optional_change(
            &funding,
            vec![TxOut { satoshis: POOL_MINT_SOURCE_SATOSHIS, script_pubkey: source_script.clone() }],
            &account.script_pubkey(),
            rate,
        )? else { continue };
        let source = PlannedTransaction {
            transaction_id: "pool-mint-source".to_owned(), role: "prerequisite".to_owned(), stage: 0,
            depends_on: vec![], version: tbc_sdk::TX_VERSION,
            inputs: vec![native_input(&funding, signing)],
            outputs: source_outputs.iter().map(planned_output).collect(), lock_time: 0,
        };
        let mut tape_descriptor = base_descriptor.clone();
        tape_descriptor.kind = PoolMintOutputKind::Tape;
        let mint = PlannedTransaction {
            transaction_id: "pool-mint".to_owned(), role: "primary".to_owned(), stage: 1,
            depends_on: vec!["pool-mint-source".to_owned()], version: tbc_sdk::TX_VERSION,
            inputs: vec![PlannedInput {
                previous_transaction_id: "pool-mint-source".to_owned(), previous_output_index: 0,
                previous_output_script: hex(source_script.as_bytes()),
                previous_output_satoshis: POOL_MINT_SOURCE_SATOSHIS,
                sequence: DEFAULT_SEQUENCE, unlocking_script: String::new(), signer: signing.clone(),
            }],
            outputs: vec![
                PlannedOutput { satoshis: 1_000, locking_script: pool_mint_output_descriptor(&base_descriptor)? },
                PlannedOutput { satoshis: 0, locking_script: pool_mint_output_descriptor(&tape_descriptor)? },
            ], lock_time: 0,
        };
        let unsigned = UnsignedPlan { transactions: vec![source.clone(), mint.clone()], evidence_table: vec![] };
        let source_preview = transaction_from_parts(&source, vec![funding.txid.parse().expect("validated funding txid")], &source_outputs);
        let mint_preview = materialize_unsigned_preview(&mint, &unsigned)?;
        return finish_pool(request, material, unsigned, vec![source_preview, mint_preview], vec![source_fee, POOL_MINT_SOURCE_SATOSHIS - 1_000], Vec::new());
    }
    Err(error(ErrorCode::InsufficientFunds, "native funding cannot create Pool mint source", "snapshot.payload.utxos"))
}

fn validate_create_policy_match(
    request: &CanonicalRequest,
    policy: &ResolvedPoolPolicy,
) -> Result<(), EngineError> {
    if request.intent.lp_plan != Some(policy.lp_plan)
        || request.intent.service_provider_tag.as_deref().is_some_and(|tag| tag != policy.service_provider_tag)
    {
        Err(ancestry("Pool creation policy does not match authenticated policy", "policy.payload.pool"))
    } else {
        Ok(())
    }
}

fn plan_initialize(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
    policy: &ResolvedPoolPolicy,
    parents: &ParentIndex,
) -> Result<PlannedTransfer, EngineError> {
    let live = live_pool(request, material, policy, parents)?;
    if live.current.parent.txid() != live.contract_id
        || live.state.amounts != (PoolAmounts { ft_lp_raw: 0, ft_a_raw: 0, tbc_sat: 0 })
    {
        return Err(ancestry(
            "Pool initialize requires the uninitialized creation outpoint",
            "snapshot.payload.contracts",
        ));
    }
    if live.state.ftlp_lock_time_enabled {
        return Err(invalid_input(
            "split Pool initialize does not accept an implicit lock height",
            "request.intent.stage",
        ));
    }
    let initial = request.intent.initial_liquidity.as_ref().expect("validated initial liquidity");
    let total_tbc = parse_decimal_u64(&initial.tbc_amount, "request.intent.initialLiquidity.tbcAmount")?;
    let ft_amount = parse_decimal_u64(&initial.ft_amount, "request.intent.initialLiquidity.ftAmount")?;
    let receiver = Address::from_string(&initial.receiver).map_err(|_| invalid_input(
        "invalid Pool LP receiver", "request.intent.initialLiquidity.receiver",
    ))?;
    let ft_contract_id = live.authority.contract_id.to_string();
    enforce_pool_amount_limit(material, "native", None, total_tbc, "request.intent.initialLiquidity.tbcAmount")?;
    for scope in ["ft-total", "ft-slot"] {
        enforce_pool_amount_limit(material, scope, Some(&ft_contract_id), ft_amount, "request.intent.initialLiquidity.ftAmount")?;
    }
    let lp_cost = if live.state.public_key_locked {
        Some(released_locked_pool_lp_cost(&live.current.output.script_pubkey)?)
    } else {
        None
    };
    let reserve_tbc = total_tbc
        .checked_sub(lp_cost.as_ref().map_or(0, |item| item.1))
        .filter(|value| *value > 0)
        .ok_or_else(|| invalid_input(
            "Pool initial TBC amount must exceed locked LP cost",
            "request.intent.initialLiquidity.tbcAmount",
        ))?;
    let initialized_pool_value = live.current.output.satoshis.checked_add(reserve_tbc)
        .ok_or_else(|| invalid_input("Pool value overflow", "request.intent.initialLiquidity.tbcAmount"))?;
    enforce_pool_amount_limit(material, "pool-state", None, initialized_pool_value, "request.intent.initialLiquidity.tbcAmount")?;
    let ft = select_ft(material, parents, &live.authority, ft_amount, "ft")?;
    let fee = select_fee(material, signing)?;
    let code = live.current.output.script_pubkey.clone();
    let pool_hash = hash::sha256(code.as_bytes());
    let mut next_state = live.state.clone();
    next_state.amounts = PoolAmounts {
        ft_lp_raw: initial_lp_raw(reserve_tbc).map_err(|_| invalid_input(
            "invalid initial LP amount", "request.intent.initialLiquidity.tbcAmount",
        ))?,
        ft_a_raw: ft_amount,
        tbc_sat: reserve_tbc,
    };
    let (pool_ft_amount, ft_change_amount) = build_tape_amount_with_offset(
        u128::from(ft_amount), &[ft.balance.expect("FT balance")], 1,
    ).map_err(|_| invalid_input("invalid initial FT split", "request.intent.initialLiquidity.ftAmount"))?;
    let live_ftlp_tape = standard_ftlp_tape(next_state.amounts.ft_lp_raw, &live.authority)
        .map_err(|_| invalid_input("could not build initial FTLP Tape", "request.intent.initialLiquidity"))?;
    let live_params = FtlpCodeParams::for_tape(
        &live_ftlp_tape, live.authority.script_version, live.authority.is_coin,
    ).map_err(|_| invalid_input("could not derive initial FTLP parameters", "request.intent.initialLiquidity"))?;
    let live_ftlp_code = ftlp_code(pool_hash, &receiver, &live_params)
        .map_err(|_| invalid_input("could not build initial FTLP Code", "request.intent.initialLiquidity"))?;
    let mut outputs = vec![
        TxOut { satoshis: initialized_pool_value, script_pubkey: code.clone() },
        TxOut { satoshis: 0, script_pubkey: pool_tape(&next_state)
            .map_err(|_| invalid_input("could not build initialized Pool Tape", "request.intent"))? },
        TxOut { satoshis: ft.output.satoshis, script_pubkey: pool_held_ft_code(
            &live.authority.code, hash::hash160(&pool_hash),
        ).map_err(|_| invalid_input("could not build Pool-held FT Code", "request.intent"))? },
        TxOut { satoshis: 0, script_pubkey: transfer_tape_script(&live.authority.tape, &pool_ft_amount)
            .map_err(|_| invalid_input("could not build Pool-held FT Tape", "request.intent"))? },
        TxOut { satoshis: FTLP_CODE_SATOSHIS, script_pubkey: live_ftlp_code },
        TxOut { satoshis: 0, script_pubkey: live_ftlp_tape },
    ];
    if let Some((recipient, amount)) = lp_cost {
        outputs.push(TxOut { satoshis: amount, script_pubkey: recipient.script_pubkey() });
    }
    if ft.balance.expect("FT balance") > u128::from(ft_amount) {
        outputs.push(TxOut {
            satoshis: ft.output.satoshis,
            script_pubkey: transfer_code_script(
                &live.authority.code,
                FtCodeReceiver::Address(Address::from_string(&request.from).unwrap()),
            ).map_err(|_| invalid_input("could not build FT change Code", "request.intent"))?,
        });
        outputs.push(TxOut {
            satoshis: 0,
            script_pubkey: transfer_tape_script(&live.authority.tape, &ft_change_amount)
                .map_err(|_| invalid_input("could not build FT change Tape", "request.intent"))?,
        });
    }
    let mut evidence = EvidenceBuilder::default();
    let pool_recipe = pool_unlocking_descriptor(PoolUnlockRecipe {
        parent: evidence.source(&live.current.parent, parents)?,
        pre_parent: evidence.source(&live.predecessor, parents)?,
        contract: live.authority.source(&mut evidence, parents)?,
        auxiliary_parents: vec![
            evidence.source(&ft.parent, parents)?,
            evidence.source(parents.get(&fee.txid)?, parents)?,
        ],
        spent_vout: 0,
        operation: PoolRecipeOperation::IncreaseLiquidity,
        swap: None,
        with_lock: live.state.public_key_locked,
        service_provider: policy.service_provider_tag.clone(),
        public_key_lock: live.public_keys.iter().map(|key| hex(&key.to_bytes())).collect(),
    })?;
    let ft_parent = evidence.source(&ft.parent, parents)?;
    let ft_proofs = proofs_for(&ft, parents, &mut evidence)?;
    let ft_recipe = ft_unlocking_descriptor(ft_parent, ft_proofs, live.authority.is_coin)?;
    let inputs = vec![
        PlannedInput {
            previous_transaction_id: live.current.parent.txid().to_string(),
            previous_output_index: live.current.utxo.vout,
            previous_output_script: hex(code.as_bytes()),
            previous_output_satoshis: live.current.output.satoshis,
            sequence: DEFAULT_SEQUENCE,
            unlocking_script: pool_recipe,
            signer: signing.clone(),
        },
        planned_input(
            &ft, ft_recipe, signing,
            if live.authority.is_coin { 0xffff_fffe } else { DEFAULT_SEQUENCE },
        ),
        native_planned_input(&fee, signing),
    ];
    let (transaction, preview, fee_paid) = build_planned_transaction(
        "pool-init", "primary", 0, vec![], inputs, outputs, fee_rate(material)?, signing,
    )?;
    finish_pool(
        request, material,
        UnsignedPlan { transactions: vec![transaction], evidence_table: evidence.entries },
        vec![preview], vec![fee_paid], Vec::new(),
    )
}


fn plan_create(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
    policy: &ResolvedPoolPolicy,
    parents: &ParentIndex,
) -> Result<PlannedTransfer, EngineError> {
    if request.intent.lp_plan != Some(policy.lp_plan)
        || request
            .intent
            .service_provider_tag
            .as_deref()
            .is_some_and(|tag| tag != policy.service_provider_tag)
    {
        return Err(ancestry(
            "Pool creation policy does not match authenticated policy",
            "policy.payload.pool",
        ));
    }
    let authority = authority(
        required(&request.intent.ft_contract_id, "request.intent.ftContractId")?,
        material,
        parents,
    )?;
    let initial = request
        .intent
        .initial_liquidity
        .as_ref()
        .expect("validated initial liquidity");
    let total_tbc = parse_decimal_u64(
        &initial.tbc_amount,
        "request.intent.initialLiquidity.tbcAmount",
    )?;
    let ft_amount = parse_decimal_u64(
        &initial.ft_amount,
        "request.intent.initialLiquidity.ftAmount",
    )?;
    let ft_contract_id = authority.contract_id.to_string();
    enforce_pool_amount_limit(
        material,
        "native",
        None,
        total_tbc,
        "request.intent.initialLiquidity.tbcAmount",
    )?;
    for scope in ["ft-total", "ft-slot"] {
        enforce_pool_amount_limit(
            material,
            scope,
            Some(&ft_contract_id),
            ft_amount,
            "request.intent.initialLiquidity.ftAmount",
        )?;
    }
    let receiver = Address::from_string(&initial.receiver).map_err(|_| {
        invalid_input(
            "invalid Pool LP receiver",
            "request.intent.initialLiquidity.receiver",
        )
    })?;
    let current_height = snapshot_height(material)?;
    let (keys, lp_cost, until_height) =
        create_lock(request.intent.lock.as_ref(), current_height)?;
    let reserve_tbc = total_tbc
        .checked_sub(lp_cost.as_ref().map_or(0, |item| item.1))
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            invalid_input(
                "Pool initial TBC amount must exceed locked LP cost",
                "request.intent.initialLiquidity.tbcAmount",
            )
        })?;
    let source = pool_source(material, parents)?;
    let ft = select_ft(material, parents, &authority, ft_amount, "ft")?;
    let fee = select_fee(material, signing)?;
    let source_outpoint = OutPoint {
        txid: source.parent.txid(),
        vout: source.utxo.vout,
    };
    let code_params = PoolCodeParams {
        lp_plan: policy.lp_plan,
        ft_version: authority.script_version,
        is_coin: authority.is_coin,
    };
    let code = if let Some((recipient, amount)) = lp_cost.as_ref() {
        locked_pool_code(
            source_outpoint,
            policy.service_provider_tag.as_bytes(),
            &keys,
            &LockedPoolCodeParams {
                pool: code_params,
                lp_cost_address: recipient.clone(),
                lp_cost_sat: *amount,
            },
        )
    } else {
        pool_code(
            source_outpoint,
            policy.service_provider_tag.as_bytes(),
            &code_params,
        )
    }
    .map_err(|_| invalid_input("could not build released Pool Code", "request.intent"))?;
    let zero_ftlp_tape = if let Some(height) = until_height {
        ftlp_tape(&FtlpTapeParams {
            amount_raw: 0,
            layout: FtlpTapeLayout::LockTime {
                lock_time: height,
                source_ft_tape_size: authority.tape.as_bytes().len(),
            },
        })
    } else {
        standard_ftlp_tape(0, &authority)
    }
    .map_err(|_| invalid_input("could not build released FTLP Tape", "request.intent.lock"))?;
    let ftlp_params = FtlpCodeParams::for_tape(
        &zero_ftlp_tape,
        authority.script_version,
        authority.is_coin,
    )
    .map_err(|_| {
        invalid_input(
            "could not derive released FTLP parameters",
            "request.intent",
        )
    })?;
    let pool_hash = hash::sha256(code.as_bytes());
    let ftlp_code_script = if until_height.is_some() {
        ftlp_lock_time_code(pool_hash, &receiver, &ftlp_params)
    } else {
        ftlp_code(pool_hash, &receiver, &ftlp_params)
    }
    .map_err(|_| invalid_input("could not build released FTLP Code", "request.intent"))?;
    let partial = partial_hash_offset(authority.version, authority.is_coin)?;
    let zero_state = PoolState {
        amounts: PoolAmounts {
            ft_lp_raw: 0,
            ft_a_raw: 0,
            tbc_sat: 0,
        },
        ft_lp_partial_hash: calculate_partial_hash(&ftlp_code_script.as_bytes()[..partial])
            .to_vec(),
        ft_a_partial_hash: calculate_partial_hash(&authority.code.as_bytes()[..partial]).to_vec(),
        ft_a_contract_id: authority.contract_id,
        service_fee_rate: policy.service_fee_rate,
        service_provider: policy.service_provider_tag.clone(),
        lp_plan: policy.lp_plan,
        public_key_locked: !keys.is_empty(),
        ftlp_lock_time_enabled: until_height.is_some(),
    };
    let mint_outputs = vec![
        TxOut {
            satoshis: 1_000,
            script_pubkey: code.clone(),
        },
        TxOut {
            satoshis: 0,
            script_pubkey: pool_tape(&zero_state)
                .map_err(|_| invalid_input("could not build Pool Tape", "request.intent"))?,
        },
    ];
    let mint_input = planned_input(&source, String::new(), signing, DEFAULT_SEQUENCE);
    let (mint, mint_preview, mint_fee) = build_planned_transaction(
        "pool-mint",
        "prerequisite",
        0,
        vec![],
        vec![mint_input],
        mint_outputs,
        fee_rate(material)?,
        signing,
    )?;
    let initialized_pool_value = 1_000u64
        .checked_add(reserve_tbc)
        .ok_or_else(|| {
            invalid_input(
                "Pool value overflow",
                "request.intent.initialLiquidity.tbcAmount",
            )
        })?;
    enforce_pool_amount_limit(
        material,
        "pool-state",
        None,
        initialized_pool_value,
        "request.intent.initialLiquidity.tbcAmount",
    )?;

    let mut next_state = zero_state;
    next_state.amounts = PoolAmounts {
        ft_lp_raw: initial_lp_raw(reserve_tbc).map_err(|_| {
            invalid_input(
                "invalid initial LP amount",
                "request.intent.initialLiquidity.tbcAmount",
            )
        })?,
        ft_a_raw: ft_amount,
        tbc_sat: reserve_tbc,
    };
    let (pool_ft_amount, ft_change_amount) = build_tape_amount_with_offset(
        u128::from(ft_amount),
        &[ft.balance.expect("FT balance")],
        1,
    )
    .map_err(|_| {
        invalid_input(
            "invalid initial FT split",
            "request.intent.initialLiquidity.ftAmount",
        )
    })?;
    let live_ftlp_tape = if let Some(height) = until_height {
        ftlp_tape(&FtlpTapeParams {
            amount_raw: next_state.amounts.ft_lp_raw,
            layout: FtlpTapeLayout::LockTime {
                lock_time: height,
                source_ft_tape_size: authority.tape.as_bytes().len(),
            },
        })
    } else {
        standard_ftlp_tape(next_state.amounts.ft_lp_raw, &authority)
    }
    .map_err(|_| {
        invalid_input(
            "could not build initial FTLP Tape",
            "request.intent.initialLiquidity",
        )
    })?;
    let live_params = FtlpCodeParams::for_tape(
        &live_ftlp_tape,
        authority.script_version,
        authority.is_coin,
    )
    .map_err(|_| {
        invalid_input(
            "could not derive initial FTLP parameters",
            "request.intent.initialLiquidity",
        )
    })?;
    let live_ftlp_code = if until_height.is_some() {
        ftlp_lock_time_code(pool_hash, &receiver, &live_params)
    } else {
        ftlp_code(pool_hash, &receiver, &live_params)
    }
    .map_err(|_| {
        invalid_input(
            "could not build initial FTLP Code",
            "request.intent.initialLiquidity",
        )
    })?;
    let mut init_outputs = vec![
        TxOut {
            satoshis: initialized_pool_value,
            script_pubkey: code.clone(),
        },
        TxOut {
            satoshis: 0,
            script_pubkey: pool_tape(&next_state).map_err(|_| {
                invalid_input("could not build initialized Pool Tape", "request.intent")
            })?,
        },
        TxOut {
            satoshis: ft.output.satoshis,
            script_pubkey: pool_held_ft_code(&authority.code, hash::hash160(&pool_hash))
                .map_err(|_| {
                    invalid_input("could not build Pool-held FT Code", "request.intent")
                })?,
        },
        TxOut {
            satoshis: 0,
            script_pubkey: transfer_tape_script(&authority.tape, &pool_ft_amount).map_err(
                |_| invalid_input("could not build Pool-held FT Tape", "request.intent"),
            )?,
        },
        TxOut {
            satoshis: FTLP_CODE_SATOSHIS,
            script_pubkey: live_ftlp_code,
        },
        TxOut {
            satoshis: 0,
            script_pubkey: live_ftlp_tape,
        },
    ];
    if let Some((recipient, amount)) = lp_cost {
        init_outputs.push(TxOut {
            satoshis: amount,
            script_pubkey: recipient.script_pubkey(),
        });
    }
    if ft.balance.expect("FT balance") > u128::from(ft_amount) {
        init_outputs.push(TxOut {
            satoshis: ft.output.satoshis,
            script_pubkey: transfer_code_script(
                &authority.code,
                FtCodeReceiver::Address(Address::from_string(&request.from).unwrap()),
            )
            .map_err(|_| invalid_input("could not build FT change Code", "request.intent"))?,
        });
        init_outputs.push(TxOut {
            satoshis: 0,
            script_pubkey: transfer_tape_script(&authority.tape, &ft_change_amount)
                .map_err(|_| invalid_input("could not build FT change Tape", "request.intent"))?,
        });
    }
    let mut evidence = EvidenceBuilder::default();
    let pool_recipe = pool_unlocking_descriptor(PoolUnlockRecipe {
        parent: TransactionSource::Planned("pool-mint".to_owned()),
        pre_parent: evidence.source(&source.parent, parents)?,
        contract: authority.source(&mut evidence, parents)?,
        auxiliary_parents: vec![
            evidence.source(&ft.parent, parents)?,
            evidence.source(parents.get(&fee.txid)?, parents)?,
        ],
        spent_vout: 0,
        operation: PoolRecipeOperation::IncreaseLiquidity,
        swap: None,
        with_lock: !keys.is_empty(),
        service_provider: policy.service_provider_tag.clone(),
        public_key_lock: keys.iter().map(|key| hex(&key.to_bytes())).collect(),
    })?;
    let ft_parent_source = evidence.source(&ft.parent, parents)?;
    let ft_proofs = proofs_for(&ft, parents, &mut evidence)?;
    let ft_recipe = ft_unlocking_descriptor(ft_parent_source, ft_proofs, authority.is_coin)?;
    let init_inputs = vec![
        PlannedInput {
            previous_transaction_id: "pool-mint".to_owned(),
            previous_output_index: 0,
            previous_output_script: hex(code.as_bytes()),
            previous_output_satoshis: 1_000,
            sequence: DEFAULT_SEQUENCE,
            unlocking_script: pool_recipe,
            signer: signing.clone(),
        },
        planned_input(
            &ft,
            ft_recipe,
            signing,
            if authority.is_coin {
                0xffff_fffe
            } else {
                DEFAULT_SEQUENCE
            },
        ),
        native_planned_input(&fee, signing),
    ];
    let (init, init_preview, init_fee) = build_planned_transaction(
        "pool-init",
        "primary",
        1,
        vec!["pool-mint".to_owned()],
        init_inputs,
        init_outputs,
        fee_rate(material)?,
        signing,
    )?;
    finish_pool(
        request,
        material,
        UnsignedPlan {
            transactions: vec![mint, init],
            evidence_table: evidence.entries,
        },
        vec![mint_preview, init_preview],
        vec![mint_fee, init_fee],
        Vec::new(),
    )
}

fn plan_add(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
    policy: &ResolvedPoolPolicy,
    parents: &ParentIndex,
) -> Result<PlannedTransfer, EngineError> {
    let live = live_pool(request, material, policy, parents)?;
    let requested = parse_decimal_u64(
        required(&request.intent.tbc_amount, "request.intent.tbcAmount")?,
        "request.intent.tbcAmount",
    )?;
    let lock_height =
        operation_lock_height(request.intent.lock_until_height.as_deref(), &live, material)?;
    let locked_lp_cost = if live.state.public_key_locked {
        Some(released_locked_pool_lp_cost(&live.current.output.script_pubkey)?)
    } else {
        None
    };
    let increment = requested
        .checked_sub(locked_lp_cost.as_ref().map_or(0, |item| item.1))
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            invalid_input(
                "Pool increase TBC amount must exceed the locked LP cost",
                "request.intent.tbcAmount",
            )
        })?;
    let delta = increase_lp(&live.state.amounts, live.current.output.satoshis, increment)
        .map_err(|_| {
            invalid_input(
                "invalid Pool liquidity increase",
                "request.intent.tbcAmount",
            )
        })?;
    let ft_add = positive_delta(delta.ft_a_delta, "request.intent.tbcAmount")?;
    let lp_add = positive_delta(delta.ft_lp_delta, "request.intent.tbcAmount")?;
    enforce_minimum(
        lp_add,
        &request.intent.minimum_lp_amount,
        "request.intent.minimumLpAmount",
    )?;
    let ft_contract_id = live.authority.contract_id.to_string();
    let pool_contract_id = live.contract_id.to_string();
    let successor_pool_value = live
        .current
        .output
        .satoshis
        .checked_add(increment)
        .ok_or_else(|| invalid_input("Pool value overflow", "request.intent.tbcAmount"))?;
    enforce_pool_amount_limit(
        material,
        "native",
        None,
        requested,
        "request.intent.tbcAmount",
    )?;
    for scope in ["ft-total", "ft-slot"] {
        enforce_pool_amount_limit(
            material,
            scope,
            Some(&ft_contract_id),
            ft_add,
            "request.intent.tbcAmount",
        )?;
    }
    enforce_pool_amount_limit(
        material,
        "pool-state",
        Some(&pool_contract_id),
        successor_pool_value,
        "request.intent.poolContractId",
    )?;
    let ft = select_ft(material, parents, &live.authority, ft_add, "ft")?;
    let fee = select_fee(material, signing)?;
    let mut next = live.state.clone();
    next.amounts.ft_lp_raw = next
        .amounts
        .ft_lp_raw
        .checked_add(lp_add)
        .ok_or_else(|| invalid_input("Pool LP overflow", "request.intent"))?;
    next.amounts.ft_a_raw = next
        .amounts
        .ft_a_raw
        .checked_add(ft_add)
        .ok_or_else(|| invalid_input("Pool FT overflow", "request.intent"))?;
    next.amounts.tbc_sat = next
        .amounts
        .tbc_sat
        .checked_add(increment)
        .ok_or_else(|| invalid_input("Pool TBC overflow", "request.intent"))?;
    let (pool_tape_amount, ft_change) = build_tape_amount_with_offset(
        u128::from(ft_add),
        &[ft.balance.expect("FT balance")],
        1,
    )
    .map_err(|_| invalid_input("invalid Pool FT split", "request.intent"))?;
    let receiver =
        Address::from_string(request.intent.receiver.as_deref().expect("validated receiver"))
            .unwrap();
    let ftlp_tape_script = if let Some(height) = lock_height {
        ftlp_tape(&FtlpTapeParams {
            amount_raw: lp_add,
            layout: FtlpTapeLayout::LockTime {
                lock_time: height,
                source_ft_tape_size: live.authority.tape.as_bytes().len(),
            },
        })
    } else {
        standard_ftlp_tape(lp_add, &live.authority)
    }
    .map_err(|_| invalid_input("could not build FTLP Tape", "request.intent"))?;
    let ftlp_params = FtlpCodeParams::for_tape(
        &ftlp_tape_script,
        live.authority.script_version,
        live.authority.is_coin,
    )
    .map_err(|_| invalid_input("could not derive FTLP parameters", "request.intent"))?;
    let pool_hash = hash::sha256(live.current.output.script_pubkey.as_bytes());
    let ftlp_code_script = if lock_height.is_some() {
        ftlp_lock_time_code(pool_hash, &receiver, &ftlp_params)
    } else {
        ftlp_code(pool_hash, &receiver, &ftlp_params)
    }
    .map_err(|_| invalid_input("could not build FTLP Code", "request.intent"))?;
    let mut outputs = vec![
        TxOut {
            satoshis: successor_pool_value,
            script_pubkey: live.current.output.script_pubkey.clone(),
        },
        TxOut {
            satoshis: 0,
            script_pubkey: pool_tape(&next)
                .map_err(|_| invalid_input("could not build Pool Tape", "request.intent"))?,
        },
        TxOut {
            satoshis: ft.output.satoshis,
            script_pubkey: pool_held_ft_code(&live.authority.code, hash::hash160(&pool_hash))
                .map_err(|_| {
                    invalid_input("could not build Pool-held FT Code", "request.intent")
                })?,
        },
        TxOut {
            satoshis: 0,
            script_pubkey: transfer_tape_script(&live.authority.tape, &pool_tape_amount)
                .map_err(|_| {
                    invalid_input("could not build Pool-held FT Tape", "request.intent")
                })?,
        },
        TxOut {
            satoshis: FTLP_CODE_SATOSHIS,
            script_pubkey: ftlp_code_script,
        },
        TxOut {
            satoshis: 0,
            script_pubkey: ftlp_tape_script,
        },
    ];
    if let Some((recipient, amount)) = locked_lp_cost {
        outputs.push(TxOut {
            satoshis: amount,
            script_pubkey: recipient.script_pubkey(),
        });
    }
    if ft.balance.expect("FT balance") > u128::from(ft_add) {
        outputs.push(TxOut {
            satoshis: ft.output.satoshis,
            script_pubkey: transfer_code_script(
                &live.authority.code,
                FtCodeReceiver::Address(Address::from_string(&request.from).unwrap()),
            )
            .map_err(|_| invalid_input("could not build FT change", "request.intent"))?,
        });
        outputs.push(TxOut {
            satoshis: 0,
            script_pubkey: transfer_tape_script(&live.authority.tape, &ft_change)
                .map_err(|_| invalid_input("could not build FT change Tape", "request.intent"))?,
        });
    }
    let mut evidence = EvidenceBuilder::default();
    let pool = pool_recipe(
        &live,
        PoolRecipeOperation::IncreaseLiquidity,
        None,
        vec![&ft.parent, parents.get(&fee.txid)?],
        parents,
        &mut evidence,
    )?;
    let ft_parent_source = evidence.source(&ft.parent, parents)?;
    let ft_proofs = proofs_for(&ft, parents, &mut evidence)?;
    let ft_recipe = ft_unlocking_descriptor(ft_parent_source, ft_proofs, live.authority.is_coin)?;
    let inputs = vec![
        planned_input(&live.current, pool, signing, DEFAULT_SEQUENCE),
        planned_input(
            &ft,
            ft_recipe,
            signing,
            if live.authority.is_coin {
                0xffff_fffe
            } else {
                DEFAULT_SEQUENCE
            },
        ),
        native_planned_input(&fee, signing),
    ];
    let (transaction, preview, fee_paid) = build_planned_transaction(
        "pool-liquidity-add",
        "primary",
        0,
        vec![],
        inputs,
        outputs,
        fee_rate(material)?,
        signing,
    )?;
    finish_pool(
        request,
        material,
        UnsignedPlan {
            transactions: vec![transaction],
            evidence_table: evidence.entries,
        },
        vec![preview],
        vec![fee_paid],
        Vec::new(),
    )
}

fn plan_consume(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
    policy: &ResolvedPoolPolicy,
    parents: &ParentIndex,
    close: bool,
) -> Result<PlannedTransfer, EngineError> {
    let live = live_pool(request, material, policy, parents)?;
    let lp_amount = if close {
        live.state.amounts.ft_lp_raw
    } else {
        parse_decimal_u64(
            required(&request.intent.lp_amount, "request.intent.lpAmount")?,
            "request.intent.lpAmount",
        )?
    };
    let delta = consume_lp(&live.state.amounts, live.current.output.satoshis, lp_amount)
        .map_err(|_| {
            invalid_input(
                "invalid Pool LP consumption",
                "request.intent.lpAmount",
            )
        })?;
    let ft_out = negative_delta(delta.ft_a_delta, "request.intent.lpAmount")?;
    let tbc_out = negative_delta(delta.tbc_sat_delta, "request.intent.lpAmount")?;
    let pool_out = negative_delta(delta.pool_value_delta, "request.intent.lpAmount")?;
    let pool_contract_id = live.contract_id.to_string();
    enforce_pool_amount_limit(
        material,
        "lp-slot",
        Some(&pool_contract_id),
        lp_amount,
        "request.intent.lpAmount",
    )?;
    if !close {
        let successor_pool_value = live
            .current
            .output
            .satoshis
            .checked_sub(pool_out)
            .ok_or_else(|| invalid_input("Pool value underflow", "request.intent"))?;
        enforce_pool_amount_limit(
            material,
            "pool-state",
            Some(&pool_contract_id),
            successor_pool_value,
            "request.intent.poolContractId",
        )?;
    }
    if !close {
        enforce_minimum(
            ft_out,
            &request.intent.minimum_ft_amount,
            "request.intent.minimumFtAmount",
        )?;
        enforce_minimum(
            tbc_out,
            &request.intent.minimum_tbc_amount,
            "request.intent.minimumTbcAmount",
        )?;
    }
    let mut evidence = EvidenceBuilder::default();
    let external_fee = select_fee(material, signing)?;
    let (ftlp, ftlp_maintenances) = plan_ftlp_input(
        &live,
        lp_amount,
        external_fee.clone(),
        material,
        signing,
        parents,
        &mut evidence,
    )?;
    let ftlp_maintenance = ftlp_maintenances.last();
    let (pool_ft, pool_maintenances) = plan_pool_ft_inputs(
        &live,
        ft_out,
        MAX_POOL_FT_INPUTS,
        external_fee.clone(),
        material,
        signing,
        parents,
        &mut evidence,
        ftlp_maintenance,
    )?;
    let pool_maintenance = pool_maintenances.last();
    let fee = pool_maintenance
        .or(ftlp_maintenance)
        .map(|item| item.fee.clone())
        .unwrap_or(external_fee);
    let pool_balances = pool_ft
        .iter()
        .map(|item| item.balance.expect("pool FT balance"))
        .collect::<Vec<_>>();
    let pool_total = sum_u128(&pool_balances)?;
    let (ft_user_tape, ft_pool_change) = build_tape_amount_with_offset(
        u128::from(ft_out),
        &pool_balances,
        2,
    )
    .map_err(|_| invalid_input("invalid Pool FT consume split", "request.intent"))?;
    let (lp_burn_tape, lp_change_tape) = build_tape_amount_with_offset(
        u128::from(lp_amount),
        &[ftlp.balance.expect("FTLP balance")],
        1,
    )
    .map_err(|_| invalid_input("invalid FTLP consume split", "request.intent"))?;
    let mut next = live.state.clone();
    next.amounts.ft_lp_raw = next
        .amounts
        .ft_lp_raw
        .checked_sub(lp_amount)
        .ok_or_else(|| invalid_input("Pool LP underflow", "request.intent"))?;
    next.amounts.ft_a_raw = next
        .amounts
        .ft_a_raw
        .checked_sub(ft_out)
        .ok_or_else(|| invalid_input("Pool FT underflow", "request.intent"))?;
    next.amounts.tbc_sat = next
        .amounts
        .tbc_sat
        .checked_sub(tbc_out)
        .ok_or_else(|| invalid_input("Pool TBC underflow", "request.intent"))?;
    let receiver = Address::from_string(if close {
        &request.from
    } else {
        request.intent.receiver.as_deref().expect("validated receiver")
    })
    .unwrap();
    let burn = Address::from_string(FTLP_BURN_ADDRESS).unwrap();
    let lp_base = if live.state.ftlp_lock_time_enabled {
        ftlp_tape(&FtlpTapeParams {
            amount_raw: 0,
            layout: FtlpTapeLayout::LockTime {
                lock_time: 0,
                source_ft_tape_size: live.authority.tape.as_bytes().len(),
            },
        })
    } else {
        standard_ftlp_tape(0, &live.authority)
    }
    .map_err(|_| invalid_input("could not build FTLP burn Tape", "request.intent"))?;
    let pool_hash = hash::sha256(live.current.output.script_pubkey.as_bytes());
    let mut outputs = vec![
        TxOut {
            satoshis: live
                .current
                .output
                .satoshis
                .checked_sub(pool_out)
                .ok_or_else(|| invalid_input("Pool value underflow", "request.intent"))?,
            script_pubkey: live.current.output.script_pubkey.clone(),
        },
        TxOut {
            satoshis: 0,
            script_pubkey: pool_tape(&next)
                .map_err(|_| invalid_input("could not build Pool Tape", "request.intent"))?,
        },
        TxOut {
            satoshis: FT_CODE_SATOSHIS,
            script_pubkey: transfer_code_script(
                &live.authority.code,
                FtCodeReceiver::Address(receiver.clone()),
            )
            .map_err(|_| invalid_input("could not build consumed FT output", "request.intent"))?,
        },
        TxOut {
            satoshis: 0,
            script_pubkey: transfer_tape_script(&live.authority.tape, &ft_user_tape)
                .map_err(|_| invalid_input("could not build consumed FT Tape", "request.intent"))?,
        },
        TxOut {
            satoshis: pool_out,
            script_pubkey: receiver.script_pubkey(),
        },
        TxOut {
            satoshis: ftlp.output.satoshis,
            script_pubkey: transfer_ftlp_code_script(&ftlp.output.script_pubkey, &burn)
                .map_err(|_| invalid_input("could not build FTLP burn Code", "request.intent"))?,
        },
        TxOut {
            satoshis: 0,
            script_pubkey: transfer_tape_script(&lp_base, &lp_burn_tape)
                .map_err(|_| invalid_input("could not build FTLP burn Tape", "request.intent"))?,
        },
    ];
    if ftlp.balance.expect("FTLP balance") > u128::from(lp_amount) {
        outputs.push(TxOut {
            satoshis: ftlp.output.satoshis,
            script_pubkey: transfer_ftlp_code_script(
                &ftlp.output.script_pubkey,
                &Address::from_string(&request.from).unwrap(),
            )
            .map_err(|_| invalid_input("could not build FTLP change Code", "request.intent"))?,
        });
        outputs.push(TxOut {
            satoshis: 0,
            script_pubkey: transfer_tape_script(&lp_base, &lp_change_tape)
                .map_err(|_| invalid_input("could not build FTLP change Tape", "request.intent"))?,
        });
    }
    if pool_total > u128::from(ft_out) {
        outputs.push(TxOut {
            satoshis: FT_CODE_SATOSHIS,
            script_pubkey: pool_held_ft_code(
                &live.authority.code,
                hash::hash160(&pool_hash),
            )
            .map_err(|_| invalid_input("could not build Pool FT change Code", "request.intent"))?,
        });
        outputs.push(TxOut {
            satoshis: 0,
            script_pubkey: transfer_tape_script(&live.authority.tape, &ft_pool_change)
                .map_err(|_| invalid_input("could not build Pool FT change Tape", "request.intent"))?,
        });
    }
    let mut auxiliaries = Vec::new();
    if pool_maintenance.is_none() && ftlp_maintenances.is_empty() {
        auxiliaries.push(&ftlp.parent);
        auxiliaries.extend(pool_ft.iter().map(|item| &item.parent));
        auxiliaries.push(parents.get(&fee.txid)?);
    }
    let pool = if !ftlp_maintenances.is_empty() || !pool_maintenances.is_empty() {
        pool_recipe_after_maintenance_chain(
            &live,
            PoolRecipeOperation::ConsumeLiquidity,
            None,
            false,
            ftlp_maintenance,
            &pool_maintenances,
            &pool_ft,
            Some(&ftlp),
            parents,
            &mut evidence,
        )?
    } else {
        pool_recipe(
            &live,
            PoolRecipeOperation::ConsumeLiquidity,
            None,
            auxiliaries,
            parents,
            &mut evidence,
        )?
    };
    let lock_mode = ftlp_lock_mode(&ftlp, &live, material)?;
    let ftlp_parent_source = if let Some(maintenance) = ftlp_maintenance {
        TransactionSource::Planned(maintenance.transaction.transaction_id.clone())
    } else {
        evidence.source(&ftlp.parent, parents)?
    };
    let ftlp_proofs = if let Some(item) = ftlp_maintenance {
        item.proofs.clone()
    } else {
        proofs_for(&ftlp, parents, &mut evidence)?
    };
    let ftlp_recipe = ftlp_unlocking_descriptor(FtlpUnlockRecipe {
        parent: ftlp_parent_source,
        proof_references: ftlp_proofs,
        lock: lock_mode,
        ordered_input_index: 0,
        ordered_input_count: 1,
    })?;
    let pool_input = if let Some(maintenance) = pool_maintenance {
        planned_maintenance_input(
            maintenance,
            0,
            pool,
            signing,
            DEFAULT_SEQUENCE,
        )
    } else {
        planned_input(&live.current, pool, signing, DEFAULT_SEQUENCE)
    };
    let mut inputs = vec![
        pool_input,
        planned_input(
            &ftlp,
            ftlp_recipe,
            signing,
            if live.state.ftlp_lock_time_enabled {
                0xffff_fffe
            } else {
                DEFAULT_SEQUENCE
            },
        ),
    ];
    for item in &pool_ft {
        let absolute = inputs.len();
        let recipe = if !pool_maintenances.is_empty() {
            pool_ft_recipe_after_maintenance_chain(
                item,
                &live,
                u8::try_from(absolute - 1).unwrap(),
                &pool_maintenances,
                parents,
                &mut evidence,
            )?
        } else {
            pool_ft_recipe(
                item,
                &live,
                u8::try_from(absolute - 1).unwrap(),
                parents,
                &mut evidence,
            )?
        };
        inputs.push(planned_input(
            item,
            recipe,
            signing,
            if live.authority.is_coin {
                0xffff_fffe
            } else {
                DEFAULT_SEQUENCE
            },
        ));
    }
    let final_maintenance = pool_maintenance.or(ftlp_maintenance);
    inputs.push(if let Some(maintenance) = final_maintenance {
        planned_maintenance_input(
            maintenance,
            maintenance.preview.outputs.len() - 1,
            String::new(),
            signing,
            DEFAULT_SEQUENCE,
        )
    } else {
        native_planned_input(&fee, signing)
    });
    let id = if close {
        "pool-liquidity-close"
    } else {
        "pool-liquidity-remove"
    };
    let depends_on = maintenance_dependencies(
        &inputs,
        &ftlp_maintenances,
        &pool_maintenances,
    );
    let (transaction, preview, fee_paid) = build_planned_transaction(
        id,
        "primary",
        u32::try_from(pool_maintenances.len() + ftlp_maintenances.len()).unwrap(),
        depends_on,
        inputs,
        outputs,
        fee_rate(material)?,
        signing,
    )?;
    finish_pool(
        request,
        material,
        UnsignedPlan {
            transactions: maintenance_transactions(&ftlp_maintenances, &pool_maintenances, transaction),
            evidence_table: evidence.entries,
        },
        maintenance_previews(&ftlp_maintenances, &pool_maintenances, preview),
        maintenance_fees(&ftlp_maintenances, &pool_maintenances, fee_paid),
        Vec::new(),
    )
}

fn plan_swap_tbc(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
    policy: &ResolvedPoolPolicy,
    parents: &ParentIndex,
) -> Result<PlannedTransfer, EngineError> {
    let live = live_pool(request, material, policy, parents)?;
    let input_amount = parse_decimal_u64(
        required(&request.intent.tbc_amount, "request.intent.tbcAmount")?,
        "request.intent.tbcAmount",
    )?;
    let delta = swap_tbc_to_ft(
        &live.state.amounts,
        input_amount,
        live.state.service_fee_rate,
        live.state.lp_plan,
    )
    .map_err(|_| {
        invalid_input(
            "invalid exact TBC Pool swap",
            "request.intent.tbcAmount",
        )
    })?;
    let ft_out = negative_delta(delta.ft_a_delta, "request.intent.tbcAmount")?;
    let reserve_in = positive_delta(delta.tbc_sat_delta, "request.intent.tbcAmount")?;
    let pool_in = positive_delta(delta.pool_value_delta, "request.intent.tbcAmount")?;
    let pool_contract_id = live.contract_id.to_string();
    let successor_pool_value = live
        .current
        .output
        .satoshis
        .checked_add(pool_in)
        .ok_or_else(|| invalid_input("Pool value overflow", "request.intent"))?;
    enforce_pool_amount_limit(
        material,
        "native",
        None,
        input_amount,
        "request.intent.tbcAmount",
    )?;
    enforce_pool_amount_limit(
        material,
        "pool-state",
        Some(&pool_contract_id),
        successor_pool_value,
        "request.intent.poolContractId",
    )?;
    enforce_minimum(
        ft_out,
        &request.intent.minimum_ft_amount,
        "request.intent.minimumFtAmount",
    )?;
    let mut evidence = EvidenceBuilder::default();
    let external_fee = select_fee(material, signing)?;
    let (pool_ft, pool_maintenances) = plan_pool_ft_inputs(
        &live,
        ft_out,
        MAX_SWAP_POOL_FT_INPUTS,
        external_fee.clone(),
        material,
        signing,
        parents,
        &mut evidence,
        None,
    )?;
    let maintenance = pool_maintenances.last();
    let fee = maintenance
        .map(|item| item.fee.clone())
        .unwrap_or(external_fee);
    if fee.satoshis < input_amount {
        return Err(error(
            ErrorCode::InsufficientFunds,
            "native funding does not cover TBC swap input",
            "snapshot.payload.utxos",
        ));
    }
    let balances = pool_ft
        .iter()
        .map(|item| item.balance.expect("pool FT balance"))
        .collect::<Vec<_>>();
    let total = sum_u128(&balances)?;
    let (owner_tape, pool_change) = build_tape_amount_with_offset(
        u128::from(ft_out),
        &balances,
        2,
    )
    .map_err(|_| invalid_input("invalid Pool swap FT split", "request.intent"))?;
    let mut next = live.state.clone();
    next.amounts.ft_a_raw = next
        .amounts
        .ft_a_raw
        .checked_sub(ft_out)
        .ok_or_else(|| invalid_input("Pool FT reserve underflow", "request.intent"))?;
    next.amounts.tbc_sat = next
        .amounts
        .tbc_sat
        .checked_add(reserve_in)
        .ok_or_else(|| invalid_input("Pool TBC reserve overflow", "request.intent"))?;
    let pool_hash = hash::sha256(live.current.output.script_pubkey.as_bytes());
    let receiver =
        Address::from_string(request.intent.receiver.as_deref().expect("validated receiver"))
            .unwrap();
    let provider_fee = input_amount
        .checked_sub(pool_in)
        .ok_or_else(|| invalid_input("Pool service fee underflow", "request.intent"))?;
    let mut outputs = vec![
        TxOut {
            satoshis: successor_pool_value,
            script_pubkey: live.current.output.script_pubkey.clone(),
        },
        TxOut {
            satoshis: 0,
            script_pubkey: pool_tape(&next)
                .map_err(|_| invalid_input("could not build Pool Tape", "request.intent"))?,
        },
        TxOut {
            satoshis: FT_CODE_SATOSHIS,
            script_pubkey: transfer_code_script(
                &live.authority.code,
                FtCodeReceiver::Address(receiver),
            )
            .map_err(|_| invalid_input("could not build swap FT output", "request.intent"))?,
        },
        TxOut {
            satoshis: 0,
            script_pubkey: transfer_tape_script(&live.authority.tape, &owner_tape)
                .map_err(|_| invalid_input("could not build swap FT Tape", "request.intent"))?,
        },
    ];
    if provider_fee >= 10 {
        outputs.push(TxOut {
            satoshis: provider_fee,
            script_pubkey: service_fee_script(live.state.lp_plan)?,
        });
    }
    if total > u128::from(ft_out) {
        outputs.push(TxOut {
            satoshis: FT_CODE_SATOSHIS,
            script_pubkey: pool_held_ft_code(
                &live.authority.code,
                hash::hash160(&pool_hash),
            )
            .map_err(|_| invalid_input("could not build Pool FT change", "request.intent"))?,
        });
        outputs.push(TxOut {
            satoshis: 0,
            script_pubkey: transfer_tape_script(&live.authority.tape, &pool_change)
                .map_err(|_| invalid_input("could not build Pool FT change Tape", "request.intent"))?,
        });
    }
    let pool = if !pool_maintenances.is_empty() {
        pool_recipe_after_maintenance_chain(
            &live,
            PoolRecipeOperation::Swap,
            Some(PoolRecipeSwap::TbcToFt),
            true,
            None,
            &pool_maintenances,
            &pool_ft,
            None,
            parents,
            &mut evidence,
        )?
    } else {
        let mut auxiliaries = vec![parents.get(&fee.txid)?];
        auxiliaries.extend(pool_ft.iter().map(|item| &item.parent));
        pool_recipe(
            &live,
            PoolRecipeOperation::Swap,
            Some(PoolRecipeSwap::TbcToFt),
            auxiliaries,
            parents,
            &mut evidence,
        )?
    };
    let mut inputs = vec![
        if let Some(maintenance) = maintenance {
            planned_maintenance_input(maintenance, 0, pool, signing, DEFAULT_SEQUENCE)
        } else {
            planned_input(&live.current, pool, signing, DEFAULT_SEQUENCE)
        },
        if let Some(maintenance) = maintenance {
            planned_maintenance_input(
                maintenance,
                maintenance.preview.outputs.len() - 1,
                String::new(),
                signing,
                DEFAULT_SEQUENCE,
            )
        } else {
            native_planned_input(&fee, signing)
        },
    ];
    for (index, item) in pool_ft.iter().enumerate() {
        let logical = u8::try_from(inputs.len() - 1).unwrap();
        let recipe = if !pool_maintenances.is_empty() {
            pool_ft_recipe_after_maintenance_chain(
                item,
                &live,
                logical,
                &pool_maintenances,
                parents,
                &mut evidence,
            )?
        } else {
            pool_ft_recipe(item, &live, logical, parents, &mut evidence)?
        };
        inputs.push(planned_input(
            item,
            recipe,
            signing,
            if live.authority.is_coin {
                0xffff_fffe
            } else {
                DEFAULT_SEQUENCE
            },
        ));
    }
    let depends_on = maintenance_dependencies(&inputs, &[], &pool_maintenances);
    let (transaction, preview, fee_paid) = build_planned_transaction(
        "pool-swap-tbc-for-token",
        "primary",
        u32::try_from(pool_maintenances.len()).unwrap(),
        depends_on,
        inputs,
        outputs,
        fee_rate(material)?,
        signing,
    )?;
    finish_pool(
        request,
        material,
        UnsignedPlan {
            transactions: maintenance_transactions(&[], &pool_maintenances, transaction),
            evidence_table: evidence.entries,
        },
        maintenance_previews(&[], &pool_maintenances, preview),
        maintenance_fees(&[], &pool_maintenances, fee_paid),
        Vec::new(),
    )
}

fn plan_swap_ft(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
    policy: &ResolvedPoolPolicy,
    parents: &ParentIndex,
) -> Result<PlannedTransfer, EngineError> {
    let live = live_pool(request, material, policy, parents)?;
    let input_amount = parse_decimal_u64(
        required(&request.intent.ft_amount, "request.intent.ftAmount")?,
        "request.intent.ftAmount",
    )?;
    let ft = select_ft(material, parents, &live.authority, input_amount, "ft")?;
    let fee = select_fee(material, signing)?;
    let delta = swap_ft_to_tbc(
        &live.state.amounts,
        input_amount,
        live.state.service_fee_rate,
        live.state.lp_plan,
    )
    .map_err(|_| {
        invalid_input(
            "invalid exact FT Pool swap",
            "request.intent.ftAmount",
        )
    })?;
    let gross = negative_delta(delta.tbc_sat_delta, "request.intent.ftAmount")?;
    let pool_out = negative_delta(delta.pool_value_delta, "request.intent.ftAmount")?;
    let ft_contract_id = live.authority.contract_id.to_string();
    let pool_contract_id = live.contract_id.to_string();
    let successor_pool_value = live
        .current
        .output
        .satoshis
        .checked_sub(pool_out)
        .ok_or_else(|| invalid_input("Pool value underflow", "request.intent"))?;
    for scope in ["ft-total", "ft-slot"] {
        enforce_pool_amount_limit(
            material,
            scope,
            Some(&ft_contract_id),
            input_amount,
            "request.intent.ftAmount",
        )?;
    }
    enforce_pool_amount_limit(
        material,
        "pool-state",
        Some(&pool_contract_id),
        successor_pool_value,
        "request.intent.poolContractId",
    )?;
    let (service, _, provider) =
        swap_fee_parts(gross, live.state.service_fee_rate, live.state.lp_plan)?;
    let owner_tbc = gross
        .checked_sub(service)
        .ok_or_else(|| invalid_input("Pool service fee exceeds output", "request.intent"))?;
    enforce_minimum(
        owner_tbc,
        &request.intent.minimum_tbc_amount,
        "request.intent.minimumTbcAmount",
    )?;
    let (pool_tape_amount, owner_change) = build_tape_amount_with_offset(
        u128::from(input_amount),
        &[ft.balance.expect("FT balance")],
        1,
    )
    .map_err(|_| invalid_input("invalid FT swap split", "request.intent"))?;
    let mut next = live.state.clone();
    next.amounts.ft_a_raw = next
        .amounts
        .ft_a_raw
        .checked_add(input_amount)
        .ok_or_else(|| invalid_input("Pool FT reserve overflow", "request.intent"))?;
    next.amounts.tbc_sat = next
        .amounts
        .tbc_sat
        .checked_sub(gross)
        .ok_or_else(|| invalid_input("Pool TBC reserve underflow", "request.intent"))?;
    let pool_hash = hash::sha256(live.current.output.script_pubkey.as_bytes());
    let receiver =
        Address::from_string(request.intent.receiver.as_deref().expect("validated receiver"))
            .unwrap();
    let mut outputs = vec![
        TxOut {
            satoshis: successor_pool_value,
            script_pubkey: live.current.output.script_pubkey.clone(),
        },
        TxOut {
            satoshis: 0,
            script_pubkey: pool_tape(&next)
                .map_err(|_| invalid_input("could not build Pool Tape", "request.intent"))?,
        },
        TxOut {
            satoshis: owner_tbc,
            script_pubkey: receiver.script_pubkey(),
        },
        TxOut {
            satoshis: ft.output.satoshis,
            script_pubkey: pool_held_ft_code(
                &live.authority.code,
                hash::hash160(&pool_hash),
            )
            .map_err(|_| {
                invalid_input("could not build Pool-held FT output", "request.intent")
            })?,
        },
        TxOut {
            satoshis: 0,
            script_pubkey: transfer_tape_script(&live.authority.tape, &pool_tape_amount)
                .map_err(|_| {
                    invalid_input("could not build Pool-held FT Tape", "request.intent")
                })?,
        },
    ];
    if provider >= 10 {
        outputs.push(TxOut {
            satoshis: provider,
            script_pubkey: service_fee_script(live.state.lp_plan)?,
        });
    }
    if ft.balance.expect("FT balance") > u128::from(input_amount) {
        outputs.push(TxOut {
            satoshis: ft.output.satoshis,
            script_pubkey: transfer_code_script(
                &live.authority.code,
                FtCodeReceiver::Address(Address::from_string(&request.from).unwrap()),
            )
            .map_err(|_| invalid_input("could not build owner FT change", "request.intent"))?,
        });
        outputs.push(TxOut {
            satoshis: 0,
            script_pubkey: transfer_tape_script(&live.authority.tape, &owner_change).map_err(
                |_| invalid_input("could not build owner FT change Tape", "request.intent"),
            )?,
        });
    }
    let mut evidence = EvidenceBuilder::default();
    let pool = pool_recipe(
        &live,
        PoolRecipeOperation::Swap,
        Some(PoolRecipeSwap::FtToTbc),
        vec![&ft.parent, parents.get(&fee.txid)?],
        parents,
        &mut evidence,
    )?;
    let ft_parent_source = evidence.source(&ft.parent, parents)?;
    let ft_proofs = proofs_for(&ft, parents, &mut evidence)?;
    let ft_recipe = ft_unlocking_descriptor(ft_parent_source, ft_proofs, live.authority.is_coin)?;
    let inputs = vec![
        planned_input(&live.current, pool, signing, DEFAULT_SEQUENCE),
        planned_input(
            &ft,
            ft_recipe,
            signing,
            if live.authority.is_coin {
                0xffff_fffe
            } else {
                DEFAULT_SEQUENCE
            },
        ),
        native_planned_input(&fee, signing),
    ];
    let (transaction, preview, fee_paid) = build_planned_transaction(
        "pool-swap-token-for-tbc",
        "primary",
        0,
        vec![],
        inputs,
        outputs,
        fee_rate(material)?,
        signing,
    )?;
    finish_pool(
        request,
        material,
        UnsignedPlan {
            transactions: vec![transaction],
            evidence_table: evidence.entries,
        },
        vec![preview],
        vec![fee_paid],
        Vec::new(),
    )
}

pub(crate) fn validate_pool_plan(
    request: &CanonicalRequest,
    plan: &UnsignedPlan,
) -> Vec<Violation> {
    let roles = plan
        .transactions
        .iter()
        .map(|item| item.role.as_str())
        .collect::<Vec<_>>();
    let valid = if request.intent.intent_type == "tbc.pool.ft.merge" {
        roles == ["primary"]
            && plan.transactions.first().is_some_and(|item| {
                item.transaction_id == "pool-ft-merge-1"
                    && item.stage == 0
                    && item.depends_on.is_empty()
            })
    } else if request.intent.intent_type == "tbc.pool.ftlp.merge" {
        roles == ["primary"]
            && plan.transactions.first().is_some_and(|item| {
                item.transaction_id == "ftlp-merge-1"
                    && item.stage == 0
                    && item.depends_on.is_empty()
            })
    } else if request.intent.intent_type == "tbc.pool.ftlp.burn" {
        roles == ["primary"]
            && plan.transactions.first().is_some_and(|item| {
                item.transaction_id == "ftlp-burn-1"
                    && item.stage == 0
                    && item.depends_on.is_empty()
            })
    } else if request.intent.intent_type == "tbc.pool.create" {
        match request.intent.stage.as_deref() {
            Some("mint") => roles == ["prerequisite", "primary"]
                && plan.transactions.first().is_some_and(|item| item.transaction_id == "pool-mint-source" && item.depends_on.is_empty())
                && plan.transactions.get(1).is_some_and(|item| item.transaction_id == "pool-mint" && item.depends_on == ["pool-mint-source"]),
            Some("initialize") => roles == ["primary"]
                && plan.transactions.first().is_some_and(|item| item.transaction_id == "pool-init" && item.depends_on.is_empty()),
            _ => roles == ["prerequisite", "primary"]
                && plan.transactions.get(1).is_some_and(|item| item.depends_on == ["pool-mint"]),
        }
    } else {
        !roles.is_empty()
            && roles.len() <= MAX_POOL_CANDIDATES + 1
            && roles.last() == Some(&"primary")
            && roles[..roles.len() - 1]
                .iter()
                .all(|role| *role == "maintenance")
    };
    if valid {
        Vec::new()
    } else {
        vec![Violation {
            code: "BUSINESS_OUTPUT_MISMATCH".to_owned(),
            path: Some("plan.payload.transactions".to_owned()),
        }]
    }
}

fn finish_pool(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    unsigned: UnsignedPlan,
    previews: Vec<Transaction>,
    fees: Vec<u64>,
    flows: Vec<AssetFlow>,
) -> Result<PlannedTransfer, EngineError> {
    let total = checked_sum_u64(fees.iter().copied(), "Pool total fee overflow")?;
    enforce_max_fee(request, total)?;
    finish_plan(
        request,
        material,
        unsigned,
        previews,
        fees,
        Vec::new(),
        if flows.is_empty() {
            vec![AssetFlow {
                kind: "pool".to_owned(),
                direction: "contract".to_owned(),
                amount: "0".to_owned(),
                contract_id: None,
                from: request.from.clone(),
                to: None,
            }]
        } else {
            flows
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn build_planned_transaction(
    id: &str,
    role: &str,
    stage: u32,
    depends_on: Vec<String>,
    inputs: Vec<PlannedInput>,
    mut outputs: Vec<TxOut>,
    fee_rate_value: u64,
    signing: &PublicSigningContext,
) -> Result<(PlannedTransaction, Transaction, u64), EngineError> {
    build_planned_transaction_with_policy(
        id,
        role,
        stage,
        depends_on,
        inputs,
        outputs,
        fee_rate_value,
        signing,
        false,
        0,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_planned_transaction_with_policy(
    id: &str,
    role: &str,
    stage: u32,
    depends_on: Vec<String>,
    inputs: Vec<PlannedInput>,
    mut outputs: Vec<TxOut>,
    fee_rate_value: u64,
    signing: &PublicSigningContext,
    require_change: bool,
    lock_time: u32,
) -> Result<(PlannedTransaction, Transaction, u64), EngineError> {
    let input_sum = checked_sum_u64(
        inputs.iter().map(|item| item.previous_output_satoshis),
        "Pool input sum overflow",
    )?;
    let output_sum = checked_sum_u64(
        outputs.iter().map(|item| item.satoshis),
        "Pool output sum overflow",
    )?;
    let fee_with_change =
        estimate_p2pkh_fee(inputs.len(), &outputs, true, fee_rate_value)?;
    let change = input_sum
        .checked_sub(output_sum)
        .and_then(|value| value.checked_sub(fee_with_change));
    let fee = if let Some(change) = change.filter(|value| *value >= tbc_sdk::SDK_DUST_SAT) {
        outputs.push(TxOut {
            satoshis: change,
            script_pubkey: Address::from_string(&signing.address)
                .unwrap()
                .script_pubkey(),
        });
        fee_with_change
    } else if require_change {
        return Err(error(
            ErrorCode::InsufficientFunds,
            "Pool maintenance requires durable fee change",
            "snapshot.payload.utxos",
        ));
    } else {
        let paid = input_sum.checked_sub(output_sum).ok_or_else(|| {
            error(
                ErrorCode::InsufficientFunds,
                "Pool inputs do not fund outputs",
                "snapshot.payload.utxos",
            )
        })?;
        let minimum = estimate_p2pkh_fee(inputs.len(), &outputs, false, fee_rate_value)?;
        if paid < minimum {
            return Err(error(
                ErrorCode::InsufficientFunds,
                "Pool inputs do not fund fee",
                "snapshot.payload.utxos",
            ));
        }
        paid
    };
    let planned = PlannedTransaction {
        transaction_id: id.to_owned(),
        role: role.to_owned(),
        stage,
        depends_on,
        version: tbc_sdk::TX_VERSION,
        inputs,
        outputs: outputs
            .iter()
            .map(planned_output)
            .collect::<Vec<PlannedOutput>>(),
        lock_time,
    };
    let preview = preview_transaction(&planned, &outputs);
    Ok((planned, preview, fee))
}

fn preview_transaction(planned: &PlannedTransaction, outputs: &[TxOut]) -> Transaction {
    let inputs = planned
        .inputs
        .iter()
        .map(|input| {
            let txid = input
                .previous_transaction_id
                .parse::<Txid>()
                .unwrap_or_else(|_| Txid::from_le_bytes([0; 32]));
            TxIn {
                previous_output: OutPoint {
                    txid,
                    vout: input.previous_output_index,
                },
                script_sig: Script::empty(),
                sequence: input.sequence,
            }
        })
        .collect();
    Transaction {
        version: planned.version,
        inputs,
        outputs: outputs.to_vec(),
        lock_time: planned.lock_time,
    }
}

fn live_pool(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    policy: &ResolvedPoolPolicy,
    parents: &ParentIndex,
) -> Result<LivePool, EngineError> {
    let contract_id = required(
        &request.intent.pool_contract_id,
        "request.intent.poolContractId",
    )?;
    let record = material
        .snapshot
        .payload
        .contracts
        .iter()
        .find(|item| item.contract_id == contract_id && item.family == "pool")
        .ok_or_else(|| {
            ancestry(
                "Pool contract record is missing",
                "snapshot.payload.contracts",
            )
        })?;
    if record.protocol_version != "2.0" || record.creation_txid != contract_id {
        return Err(ancestry(
            "Pool creation identity is invalid",
            "snapshot.payload.contracts",
        ));
    }
    let current_utxo = material
        .snapshot
        .payload
        .utxos
        .iter()
        .find(|item| {
            item.txid == record.current_outpoint.txid
                && item.vout == record.current_outpoint.vout
                && item.classification == "pool"
                && item.contract_id.as_deref() == Some(contract_id)
        })
        .ok_or_else(|| {
            ancestry(
                "current Pool outpoint is missing",
                "snapshot.payload.utxos",
            )
        })?;
    require_pool_confirmations(current_utxo, material)?;
    let current = authenticate_utxo(current_utxo, parents, false)?;
    if current.utxo.vout != 0 {
        return Err(ancestry(
            "current Pool outpoint must be vout zero",
            "snapshot.payload.contracts",
        ));
    }
    let state_output = current.parent.outputs.get(1).ok_or_else(|| {
        ancestry(
            "current Pool Tape is missing",
            "snapshot.payload.parents",
        )
    })?;
    let state = PoolState::from_v2_tape(
        &state_output.script_pubkey,
        policy.service_provider_tag.clone(),
    )
    .map_err(|_| {
        ancestry(
            "current Pool Tape is invalid",
            "snapshot.payload.parents",
        )
    })?;
    if state.service_fee_rate != policy.service_fee_rate
        || state.service_provider != policy.service_provider_tag
        || state.lp_plan != policy.lp_plan
    {
        return Err(ancestry(
            "Pool state does not match authenticated policy",
            "policy.payload.pool",
        ));
    }
    let predecessor_outpoint = current
        .parent
        .inputs
        .first()
        .ok_or_else(|| {
            ancestry(
                "current Pool transaction has no predecessor",
                "snapshot.payload.parents",
            )
        })?
        .previous_output
        .clone();
    if predecessor_outpoint.vout != 0 {
        return Err(ancestry(
            "Pool predecessor must be vout zero",
            "snapshot.payload.parents",
        ));
    }
    let predecessor = parents.get(&predecessor_outpoint.txid.to_string())?.clone();
    if record.indexed_pool.is_none() {
    let creation = parents.get(&record.creation_txid)?.clone();
    let creation_code = creation.outputs.first().ok_or_else(|| {
        ancestry(
            "Pool creation Code is missing",
            "snapshot.payload.parents",
        )
    })?;
    if creation.txid().to_string() != contract_id
        || creation_code.script_pubkey != current.output.script_pubkey
        || creation_code.satoshis != 1_000
    {
        return Err(ancestry(
            "Pool creation/current Code identity is inconsistent",
            "snapshot.payload.contracts",
        ));
    }
    let source_outpoint = pool_code_source_outpoint(&creation_code.script_pubkey).map_err(|_| {
        ancestry(
            "Pool Code source outpoint is invalid",
            "snapshot.payload.parents",
        )
    })?;
    if creation
        .inputs
        .first()
        .is_none_or(|input| input.previous_output != source_outpoint)
    {
        return Err(ancestry(
            "Pool creation does not spend its embedded source outpoint",
            "snapshot.payload.parents",
        ));
    }
    }
    // Trusted current identity replaces a historical genesis audit, not the
    // current/predecessor transactions required by the on-chain witness.
    pool_code_source_outpoint(&current.output.script_pubkey).map_err(|_| {
        ancestry("Pool Code source outpoint is invalid", "snapshot.payload.parents")
    })?;
    let authority = authority(&state.ft_a_contract_id.to_string(), material, parents)?;
    if let Some(index) = &record.indexed_pool {
        if index.ft_code_script != hex(authority.code.as_bytes())
            || index.ft_tape_script != hex(authority.tape.as_bytes()) {
            return Err(ancestry("Pool and FT indexed authority disagree", "snapshot.payload.contracts"));
        }
    }
    let partial = partial_hash_offset(authority.version, authority.is_coin)?;
    if calculate_partial_hash(&authority.code.as_bytes()[..partial]).as_slice()
        != state.ft_a_partial_hash
    {
        return Err(ancestry(
            "Pool FT partial hash does not match authority",
            "snapshot.payload.parents",
        ));
    }
    let public_keys = pool_code_lock(&current.output.script_pubkey).map_err(|_| {
        ancestry(
            "Pool public-key lock is malformed",
            "snapshot.payload.parents",
        )
    })?;
    if state.public_key_locked != !public_keys.is_empty() {
        return Err(ancestry(
            "Pool lock flag does not match Pool Code",
            "snapshot.payload.parents",
        ));
    }
    Ok(LivePool {
        current,
        predecessor,
        contract_id: contract_id.parse().map_err(|_| ancestry("invalid Pool id", "snapshot.payload.contracts"))?,
        state,
        authority,
        public_keys,
    })
}

fn authority(
    contract_id: &str,
    material: &WalletMaterial<'_>,
    parents: &ParentIndex,
) -> Result<Authority, EngineError> {
    validate_contract(contract_id, "request.intent.ftContractId")?;
    let record = material
        .snapshot
        .payload
        .contracts
        .iter()
        .find(|item| item.contract_id == contract_id && item.family == "ft")
        .ok_or_else(|| {
            ancestry(
                "FT authority contract record is missing",
                "snapshot.payload.contracts",
            )
        })?;
    if record.creation_txid != contract_id {
        return Err(ancestry(
            "FT creation identity is invalid",
            "snapshot.payload.contracts",
        ));
    }
    let (contract, code, tape) = if let Some(index) = &record.indexed_fungible {
        let code = crate::signing::parse_script(&index.code_script, "indexedPoolFtCode")?;
        let tape = crate::signing::parse_script(&index.tape_script, "indexedPoolFtTape")?;
        (None, code, tape)
    } else {
    let contract = parents.get(&record.creation_txid)?.clone();
    let ordinary = contract
        .outputs
        .first()
        .and_then(|output| classify_ft_script(&output.script_pubkey).ok())
        .is_some_and(|info| !info.is_coin);
    let (code_vout, tape_vout) = if ordinary { (0, 1) } else { (3, 4) };
    let code = contract
        .outputs
        .get(code_vout)
        .ok_or_else(|| ancestry("FT authority Code is missing", "snapshot.payload.parents"))?
        .script_pubkey
        .clone();
    let tape = contract
        .outputs
        .get(tape_vout)
        .ok_or_else(|| ancestry("FT authority Tape is missing", "snapshot.payload.parents"))?
        .script_pubkey
        .clone();
    let info = classify_ft_script(&code).map_err(|_| {
        ancestry(
            "FT authority Code is invalid",
            "snapshot.payload.parents",
        )
    })?;
    if contract.txid().to_string() != contract_id
        || (info.is_coin && (code_vout, tape_vout) != (3, 4))
        || (!info.is_coin && (code_vout, tape_vout) != (0, 1))
    {
        return Err(ancestry(
            "FT authority output positions are invalid",
            "snapshot.payload.parents",
        ));
    }
    (Some(contract), code, tape)
    };
    let info = classify_ft_script(&code).map_err(|_| ancestry("FT authority Code is invalid", "snapshot.payload.contracts"))?;
    let chunks = op_return_chunks(&tape)?;
    if chunks.len() != if info.is_coin { 6 } else { 5 }
        || chunks.first().is_none_or(|item| item.len() != 48)
        || chunks.get(1).is_none_or(|item| item.len() != 1)
        || chunks.last().map(Vec::as_slice) != Some(b"FTape")
    {
        return Err(ancestry(
            "FT authority Tape metadata is invalid",
            "snapshot.payload.parents",
        ));
    }
    let name = String::from_utf8(chunks[2].clone())
        .map_err(|_| ancestry("FT name is not UTF-8", "snapshot.payload.parents"))?;
    let symbol = String::from_utf8(chunks[3].clone())
        .map_err(|_| ancestry("FT symbol is not UTF-8", "snapshot.payload.parents"))?;
    let script_version = match info.version {
        1 => FtScriptVersion::V1,
        2 => FtScriptVersion::V2,
        3 => FtScriptVersion::V3,
        4 => FtScriptVersion::V4,
        _ => {
            return Err(ancestry(
                "unsupported FT version",
                "snapshot.payload.contracts",
            ));
        }
    };
    Ok(Authority {
        contract_id: contract_id.parse().map_err(|_| ancestry("invalid FT id", "snapshot.payload.contracts"))?,
        contract,
        code,
        tape,
        version: info.version,
        script_version,
        is_coin: info.is_coin,
        name,
        symbol,
    })
}

fn authenticate_utxo(
    utxo: &WalletUtxo,
    parents: &ParentIndex,
    with_tape: bool,
) -> Result<AuthenticatedUtxo, EngineError> {
    let parent = parents.get(&utxo.txid)?.clone();
    let output = parent
        .outputs
        .get(utxo.vout as usize)
        .ok_or_else(|| ancestry("UTXO output is missing", "snapshot.payload.utxos"))?
        .clone();
    let satoshis = parse_decimal_u64(&utxo.satoshis, "snapshot.payload.utxos.satoshis")?;
    if output.satoshis != satoshis || hex(output.script_pubkey.as_bytes()) != utxo.script_pub_key {
        return Err(ancestry(
            "UTXO does not match authenticated parent output",
            "snapshot.payload.utxos",
        ));
    }
    let tape = with_tape
        .then(|| {
            parent
                .outputs
                .get(utxo.vout as usize + 1)
                .map(|item| item.script_pubkey.clone())
        })
        .flatten();
    let balance = tape
        .as_ref()
        .map(balance_from_tape)
        .transpose()
        .map_err(|_| ancestry("asset Tape amount is invalid", "snapshot.payload.parents"))?;
    Ok(AuthenticatedUtxo {
        utxo: utxo.clone(),
        parent,
        output,
        tape,
        balance,
    })
}

fn pool_source(
    material: &WalletMaterial<'_>,
    parents: &ParentIndex,
) -> Result<AuthenticatedUtxo, EngineError> {
    let candidates = material
        .snapshot
        .payload
        .utxos
        .iter()
        .filter(|item| item.classification == "pool-source")
        .collect::<Vec<_>>();
    if candidates.len() != 1 {
        return Err(ancestry(
            "Pool creation requires exactly one mint source",
            "snapshot.payload.utxos",
        ));
    }
    require_pool_confirmations(candidates[0], material)?;
    let source = authenticate_utxo(candidates[0], parents, false)?;
    let outpoint = OutPoint {
        txid: source.parent.txid(),
        vout: source.utxo.vout,
    };
    authenticate_pool_source(&outpoint, material, parents, true)?;
    Ok(source)
}

fn require_pool_confirmations(utxo: &WalletUtxo, material: &WalletMaterial<'_>) -> Result<(), EngineError> {
    let minimum = parse_decimal_u64(&material.policy.payload.min_confirmations, "policy.payload.minConfirmations")?;
    if !crate::confirmations::meets_minimum(utxo.confirmations.as_deref(), minimum, "snapshot.payload.utxos.confirmations")? {
        return Err(error(ErrorCode::MissingMaterial, "Pool input lacks required confirmations", "snapshot.payload.utxos"));
    }
    Ok(())
}

fn authenticate_pool_source(
    outpoint: &OutPoint,
    material: &WalletMaterial<'_>,
    parents: &ParentIndex,
    require_current_owner: bool,
) -> Result<(), EngineError> {
    let utxo = material
        .snapshot
        .payload
        .utxos
        .iter()
        .find(|item| {
            item.txid == outpoint.txid.to_string()
                && item.vout == outpoint.vout
                && item.classification == "pool-source"
        })
        .ok_or_else(|| {
            ancestry(
                "Pool mint source outpoint is missing",
                "snapshot.payload.utxos",
            )
        })?;
    let source = authenticate_utxo(utxo, parents, false)?;
    if source.output.satoshis != POOL_MINT_SOURCE_SATOSHIS
        || !is_historical_pool_source_script(&source.output.script_pubkey)
        || (require_current_owner && !is_pool_source_script(
            &source.output.script_pubkey,
            &material.snapshot.payload.account.address,
        )?)
    {
        return Err(ancestry(
            "Pool mint source value or marker is invalid",
            "snapshot.payload.utxos",
        ));
    }
    Ok(())
}

fn is_historical_pool_source_script(script: &Script) -> bool {
    // Exact P2PKH + OP_RETURN + canonical marker push. Only the historical
    // creator's 20-byte key hash is variable; no extra opcodes/trailing bytes.
    let bytes = script.as_bytes();
    bytes.len() == 27 + POOL_MINT_SOURCE_MARKER.len()
        && bytes[..3] == [0x76, 0xa9, 0x14]
        && bytes[23..27] == [0x88, 0xac, 0x6a, POOL_MINT_SOURCE_MARKER.len() as u8]
        && &bytes[27..] == POOL_MINT_SOURCE_MARKER
}

fn is_pool_source_script(script: &Script, address: &str) -> Result<bool, EngineError> {
    let owner = Address::from_string(address).map_err(|_| {
        ancestry(
            "account address is invalid",
            "snapshot.payload.account.address",
        )
    })?;
    let mut expected = owner.script_pubkey().as_bytes().to_vec();
    expected.push(tbc_sdk::script::opcodes::OP_RETURN);
    expected.push(u8::try_from(POOL_MINT_SOURCE_MARKER.len()).unwrap());
    expected.extend_from_slice(POOL_MINT_SOURCE_MARKER);
    Ok(script.as_bytes() == expected)
}

fn select_ft(
    material: &WalletMaterial<'_>,
    parents: &ParentIndex,
    authority: &Authority,
    needed: u64,
    classification: &str,
) -> Result<AuthenticatedUtxo, EngineError> {
    let mut candidates = asset_candidates(
        material,
        parents,
        classification,
        Some(&authority.contract_id.to_string()),
    )?;
    for candidate in &candidates {
        authenticate_owner_ft_candidate(candidate, authority, material)?;
    }
    candidates.sort_by(candidate_order);
    candidates
        .into_iter()
        .find(|item| {
            item.balance
                .is_some_and(|balance| balance >= u128::from(needed))
        })
        .ok_or_else(|| {
            error(
                ErrorCode::InsufficientFunds,
                "no authenticated FT input covers requested amount",
                "snapshot.payload.utxos",
            )
        })
}

fn select_pool_ft(
    material: &WalletMaterial<'_>,
    parents: &ParentIndex,
    live: &LivePool,
    needed: u64,
    direct_limit: usize,
) -> Result<Option<Vec<AuthenticatedUtxo>>, EngineError> {
    let candidates = pool_ft_candidates(material, parents, live)?;
    let mut selected = Vec::new();
    let mut total = 0u128;
    for candidate in candidates.into_iter().take(direct_limit) {
        total = total
            .checked_add(candidate.balance.expect("asset balance"))
            .ok_or_else(|| {
                invalid_input("Pool FT balance overflow", "snapshot.payload.utxos")
            })?;
        selected.push(candidate);
        if total >= u128::from(needed) {
            return Ok(Some(selected));
        }
    }
    Ok(None)
}

fn select_ftlp(
    material: &WalletMaterial<'_>,
    parents: &ParentIndex,
    live: &LivePool,
    needed: u64,
) -> Result<Option<AuthenticatedUtxo>, EngineError> {
    let candidates = ftlp_candidates(material, parents, live)?;
    for candidate in candidates {
        if candidate
            .balance
            .is_some_and(|balance| balance >= u128::from(needed))
            && (!live.state.ftlp_lock_time_enabled || ftlp_lock_height(&candidate)? == 0)
        {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

fn pool_ft_candidates(
    material: &WalletMaterial<'_>,
    parents: &ParentIndex,
    live: &LivePool,
) -> Result<Vec<AuthenticatedUtxo>, EngineError> {
    let mut candidates = asset_candidates(
        material,
        parents,
        "pool-ft",
        Some(&live.contract_id.to_string()),
    )?;
    for candidate in &candidates {
        authenticate_pool_asset_candidate(candidate, live, material, MaintenanceKind::PoolFt)?;
    }
    candidates.sort_by(candidate_order);
    Ok(candidates)
}

fn ftlp_candidates(
    material: &WalletMaterial<'_>,
    parents: &ParentIndex,
    live: &LivePool,
) -> Result<Vec<AuthenticatedUtxo>, EngineError> {
    let mut candidates = asset_candidates(
        material,
        parents,
        "ftlp",
        Some(&live.contract_id.to_string()),
    )?;
    for candidate in &candidates {
        authenticate_pool_asset_candidate(candidate, live, material, MaintenanceKind::Ftlp)?;
    }
    candidates.sort_by(candidate_order);
    let mut eligible = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        if ftlp_candidate_eligible(&candidate, live, material)? {
            eligible.push(candidate);
        }
    }
    Ok(eligible)
}

#[allow(clippy::too_many_arguments)]
fn plan_ftlp_input(
    live: &LivePool,
    needed: u64,
    external_fee: NativeFundingUtxo,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
    parents: &ParentIndex,
    evidence: &mut EvidenceBuilder,
) -> Result<(AuthenticatedUtxo, Vec<MaintenanceArtifacts>), EngineError> {
    if let Some(direct) = select_ftlp(material, parents, live, needed)? {
        return Ok((direct, Vec::new()));
    }
    let mut candidates = ftlp_candidates(material, parents, live)?;
    if sum_u128(
        &candidates
            .iter()
            .map(|candidate| candidate.balance.expect("FTLP balance"))
            .collect::<Vec<_>>(),
    )? < u128::from(needed)
    {
        return Err(error(
            ErrorCode::InsufficientFunds,
            "bounded FTLP maintenance cannot cover requested LP amount",
            "snapshot.payload.utxos",
        ));
    }
    let mut rounds = Vec::<MaintenanceArtifacts>::new();
    loop {
        let first_is_spendable = if let Some(first) = candidates.first() {
            first.balance.expect("FTLP balance") >= u128::from(needed)
                && (!live.state.ftlp_lock_time_enabled || ftlp_lock_height(first)? == 0)
        } else {
            false
        };
        if first_is_spendable {
            break;
        }
        let requires_unlock = candidates.len() == 1
            && live.state.ftlp_lock_time_enabled
            && ftlp_lock_height(&candidates[0])? != 0;
        if candidates.len() <= 1 && !requires_unlock {
            break;
        }
        let mut selected_total = 0u128;
        let mut selected_len = 0usize;
        for candidate in candidates.iter().take(MAX_MERGE_FTLP_INPUTS) {
            selected_total = selected_total
                .checked_add(candidate.balance.expect("FTLP balance"))
                .ok_or_else(|| {
                    invalid_input("FTLP balance overflow", "snapshot.payload.utxos")
                })?;
            selected_len += 1;
            if selected_total >= u128::from(needed) {
                break;
            }
        }
        let selected = candidates.drain(..selected_len).collect::<Vec<_>>();
        let prior = rounds.last();
        let fee = prior
            .map(|maintenance| maintenance.fee.clone())
            .unwrap_or_else(|| external_fee.clone());
        let maintenance = build_ftlp_maintenance(
            live,
            selected,
            fee,
            material,
            signing,
            parents,
            evidence,
            prior,
            rounds.len(),
        )?;
        candidates.insert(0, maintenance.asset.clone());
        rounds.push(maintenance);
    }
    let selected = candidates.into_iter().next().ok_or_else(|| {
        error(
            ErrorCode::InsufficientFunds,
            "bounded FTLP maintenance cannot cover requested LP amount",
            "snapshot.payload.utxos",
        )
    })?;
    if selected.balance.expect("FTLP balance") < u128::from(needed) {
        return Err(error(
            ErrorCode::InsufficientFunds,
            "bounded FTLP maintenance cannot cover requested LP amount",
            "snapshot.payload.utxos",
        ));
    }
    Ok((selected, rounds))
}

#[allow(clippy::too_many_arguments)]
fn build_pool_ft_maintenance(
    live: &LivePool,
    selected: Vec<AuthenticatedUtxo>,
    fee: NativeFundingUtxo,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
    parents: &ParentIndex,
    evidence: &mut EvidenceBuilder,
    round: usize,
    stage: u32,
    pool_maintenances: &[MaintenanceArtifacts],
    prior_fee: Option<&MaintenanceArtifacts>,
) -> Result<MaintenanceArtifacts, EngineError> {
    let prior_pool = pool_maintenances.last();
    let pre_pool = pool_maintenances
        .len()
        .checked_sub(2)
        .and_then(|index| pool_maintenances.get(index));
    let id = format!("pool-ft-merge-{round}");
    let balances = selected
        .iter()
        .map(|item| item.balance.expect("Pool FT balance"))
        .collect::<Vec<_>>();
    let total = sum_u128(&balances)?;
    let (merged_slots, _) = build_tape_amount_with_offset(total, &balances, 1)?;
    let selected_sources = selected
        .iter()
        .map(|item| {
            if let Some(maintenance) = pool_maintenances
                .iter()
                .find(|maintenance| maintenance.asset.utxo.txid == item.utxo.txid)
            {
                Ok(TransactionSource::Planned(
                    maintenance.transaction.transaction_id.clone(),
                ))
            } else {
                evidence.source(&item.parent, parents)
            }
        })
        .collect::<Result<Vec<_>, EngineError>>()?;
    let pool = if let Some(prior) = prior_pool {
        let mut auxiliary_parents = selected_sources.clone();
        auxiliary_parents.push(TransactionSource::Planned(prior.transaction.transaction_id.clone()));
        pool_unlocking_descriptor(PoolUnlockRecipe {
            parent: TransactionSource::Planned(prior.transaction.transaction_id.clone()),
            pre_parent: if let Some(pre_pool) = pre_pool {
                TransactionSource::Planned(pre_pool.transaction.transaction_id.clone())
            } else {
                evidence.source(&live.current.parent, parents)?
            },
            contract: live.authority.source(evidence, parents)?,
            auxiliary_parents,
            spent_vout: 0,
            operation: PoolRecipeOperation::MergePoolFt,
            swap: None,
            with_lock: live.state.public_key_locked,
            service_provider: live.state.service_provider.clone(),
            public_key_lock: live
                .public_keys
                .iter()
                .map(|key| hex(&key.to_bytes()))
                .collect(),
        })?
    } else {
        if let Some(prior) = prior_fee {
            let mut auxiliary_parents = selected_sources;
            auxiliary_parents.push(TransactionSource::Planned(prior.transaction.transaction_id.clone()));
            pool_unlocking_descriptor(PoolUnlockRecipe {
                parent: evidence.source(&live.current.parent, parents)?,
                pre_parent: evidence.source(&live.predecessor, parents)?,
                contract: live.authority.source(evidence, parents)?,
                auxiliary_parents,
                spent_vout: live.current.utxo.vout,
                operation: PoolRecipeOperation::MergePoolFt,
                swap: None,
                with_lock: live.state.public_key_locked,
                service_provider: live.state.service_provider.clone(),
                public_key_lock: live.public_keys.iter().map(|key| hex(&key.to_bytes())).collect(),
            })?
        } else {
            let mut auxiliaries = selected.iter().map(|item| &item.parent).collect::<Vec<_>>();
            auxiliaries.push(parents.get(&fee.txid)?);
            pool_recipe(live, PoolRecipeOperation::MergePoolFt, None, auxiliaries, parents, evidence)?
        }
    };
    let mut inputs = vec![if let Some(prior) = prior_pool {
        planned_maintenance_input(prior, 0, pool, signing, DEFAULT_SEQUENCE)
    } else {
        planned_input(&live.current, pool, signing, DEFAULT_SEQUENCE)
    }];
    for item in &selected {
        let logical = u8::try_from(inputs.len() - 1).unwrap();
        let recipe = if pool_maintenances.is_empty() {
            pool_ft_recipe(item, live, logical, parents, evidence)?
        } else {
            pool_ft_recipe_after_maintenance_chain(
                item,
                live,
                logical,
                pool_maintenances,
                parents,
                evidence,
            )?
        };
        inputs.push(planned_input(
            item,
            recipe,
            signing,
            if live.authority.is_coin { 0xffff_fffe } else { DEFAULT_SEQUENCE },
        ));
    }
    let fee_predecessor = prior_pool.or(prior_fee);
    inputs.push(if let Some(prior) = fee_predecessor {
        planned_maintenance_input(
            prior,
            usize::try_from(prior.fee.vout).unwrap(),
            String::new(),
            signing,
            DEFAULT_SEQUENCE,
        )
    } else {
        native_planned_input(&fee, signing)
    });
    let pool_hash = hash::sha256(live.current.output.script_pubkey.as_bytes());
    let outputs = vec![
        live.current.output.clone(),
        TxOut {
            satoshis: 0,
            script_pubkey: pool_tape(&live.state)
                .map_err(|_| invalid_input("could not preserve Pool Tape", "request.intent"))?,
        },
        TxOut {
            satoshis: FT_CODE_SATOSHIS,
            script_pubkey: pool_held_ft_code(
                &live.authority.code,
                hash::hash160(&pool_hash),
            )
            .map_err(|_| invalid_input("could not build merged Pool FT Code", "request.intent"))?,
        },
        TxOut {
            satoshis: 0,
            script_pubkey: transfer_tape_script(&live.authority.tape, &merged_slots)
                .map_err(|_| invalid_input("could not build merged Pool FT Tape", "request.intent"))?,
        },
    ];
    let (transaction, preview, fee_paid) = build_planned_transaction_with_policy(
        &id,
        "maintenance",
        stage,
        fee_predecessor
            .map(|item| vec![item.transaction.transaction_id.clone()])
            .unwrap_or_default(),
        inputs,
        outputs,
        tbc_sdk::DEFAULT_FEE_RATE_SAT_PER_KB,
        signing,
        true,
        0,
    )?;
    let proofs = selected
        .iter()
        .rev()
        .map(|item| {
            let source = if let Some(maintenance) = pool_maintenances
                .iter()
                .find(|maintenance| maintenance.asset.utxo.txid == item.utxo.txid)
            {
                TransactionSource::Planned(
                    maintenance.transaction.transaction_id.clone(),
                )
            } else {
                evidence.source(&item.parent, parents)?
            };
            Ok(ProofReference {
                source,
                output_index: item.utxo.vout,
            })
        })
        .collect::<Result<Vec<_>, EngineError>>()?;
    maintenance_artifacts(
        MaintenanceKind::PoolFt,
        transaction,
        preview,
        fee_paid,
        2,
        3,
        total,
        "pool-ft",
        live.contract_id.to_string(),
        proofs,
        4,
    )
}

#[allow(clippy::too_many_arguments)]
fn plan_pool_ft_inputs(
    live: &LivePool,
    needed: u64,
    direct_limit: usize,
    fee: NativeFundingUtxo,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
    parents: &ParentIndex,
    evidence: &mut EvidenceBuilder,
    prior_fee: Option<&MaintenanceArtifacts>,
) -> Result<(Vec<AuthenticatedUtxo>, Vec<MaintenanceArtifacts>), EngineError> {
    if let Some(direct) = select_pool_ft(material, parents, live, needed, direct_limit)? {
        return Ok((direct, Vec::new()));
    }
    let candidates = pool_ft_candidates(material, parents, live)?;
    let first_stage = if let Some(prior) = prior_fee {
        prior.transaction.stage.checked_add(1).ok_or_else(|| {
            error(
                ErrorCode::InternalInvariant,
                "Pool FT maintenance stage overflow",
                "plan",
            )
        })?
    } else {
        0
    };
    let mut rounds = Vec::new();
    let mut frontier = candidates;
    loop {
        let mut required_count = 0usize;
        let mut required_total = 0u128;
        for candidate in &frontier {
            required_total = required_total
                .checked_add(candidate.balance.expect("Pool FT balance"))
                .ok_or_else(|| {
                    invalid_input("Pool FT balance overflow", "snapshot.payload.utxos")
                })?;
            required_count += 1;
            if required_total >= u128::from(needed) {
                break;
            }
        }
        if required_total < u128::from(needed) {
            return Err(error(
                ErrorCode::InsufficientFunds,
                "bounded Pool FT maintenance cannot cover requested output",
                "snapshot.payload.utxos",
            ));
        }
        if required_count <= direct_limit {
            return Ok((frontier[..required_count].to_vec(), rounds));
        }
        let merge_count = required_count.min(MAX_POOL_FT_MERGE_INPUTS);
        let artifacts = build_pool_ft_maintenance(
            live,
            frontier[..merge_count].to_vec(),
            fee.clone(),
            material,
            signing,
                parents,
                evidence,
                rounds.len(),
                first_stage
                    .checked_add(u32::try_from(rounds.len()).map_err(|_| {
                        error(
                            ErrorCode::InternalInvariant,
                            "Pool FT maintenance round exceeds the stage range",
                            "plan",
                        )
                    })?)
                    .ok_or_else(|| {
                        error(
                            ErrorCode::InternalInvariant,
                            "Pool FT maintenance stage overflow",
                            "plan",
                        )
                    })?,
                &rounds,
                prior_fee,
            )?;
        frontier.drain(..merge_count);
        frontier.insert(0, artifacts.asset.clone());
        rounds.push(artifacts);
    }
}

#[allow(clippy::too_many_arguments)]
fn build_ftlp_maintenance(
    live: &LivePool,
    selected: Vec<AuthenticatedUtxo>,
    fee: NativeFundingUtxo,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
    parents: &ParentIndex,
    evidence: &mut EvidenceBuilder,
    prior: Option<&MaintenanceArtifacts>,
    round: usize,
) -> Result<MaintenanceArtifacts, EngineError> {
    let id = format!("ftlp-merge-{round}");
    let balances = selected
        .iter()
        .map(|item| item.balance.expect("FTLP balance"))
        .collect::<Vec<_>>();
    let total = sum_u128(&balances)?;
    let (merged_slots, _) = build_tape_amount_with_offset(total, &balances, 0)?;
    let count = u8::try_from(selected.len()).unwrap();
    let mut inputs = Vec::with_capacity(selected.len() + 1);
    for (index, item) in selected.iter().enumerate() {
        let planned_parent = prior.filter(|maintenance| {
            item.utxo.txid == maintenance.transaction.transaction_id
        });
        let recipe = ftlp_unlocking_descriptor(FtlpUnlockRecipe {
            parent: if let Some(maintenance) = planned_parent {
                TransactionSource::Planned(maintenance.transaction.transaction_id.clone())
            } else {
                evidence.source(&item.parent, parents)?
            },
            proof_references: if let Some(maintenance) = planned_parent {
                maintenance.proofs.clone()
            } else {
                proofs_for(item, parents, evidence)?
            },
            lock: ftlp_maintenance_lock_mode(item, live, material)?,
            ordered_input_index: u8::try_from(index).unwrap(),
            ordered_input_count: count,
        })?;
        inputs.push(if let Some(maintenance) = planned_parent {
            planned_maintenance_input(
                maintenance,
                0,
                recipe,
                signing,
                if live.state.ftlp_lock_time_enabled { 0xffff_fffe } else { DEFAULT_SEQUENCE },
            )
        } else {
            planned_input(
                item,
                recipe,
                signing,
                if live.state.ftlp_lock_time_enabled { 0xffff_fffe } else { DEFAULT_SEQUENCE },
            )
        });
    }
    inputs.push(if let Some(maintenance) = prior {
        planned_maintenance_input(
            maintenance,
            maintenance.preview.outputs.len() - 1,
            String::new(),
            signing,
            DEFAULT_SEQUENCE,
        )
    } else {
        native_planned_input(&fee, signing)
    });
    let first = selected.first().expect("non-empty FTLP merge");
    let tape_base = if live.state.ftlp_lock_time_enabled {
        ftlp_tape(&FtlpTapeParams {
            amount_raw: 0,
            layout: FtlpTapeLayout::LockTime {
                lock_time: 0,
                source_ft_tape_size: live.authority.tape.as_bytes().len(),
            },
        })
        .map_err(|_| invalid_input("could not build merged FTLP Tape", "request.intent"))?
    } else {
        first.tape.as_ref().expect("authenticated FTLP Tape").clone()
    };
    let outputs = vec![
        first.output.clone(),
        TxOut {
            satoshis: 0,
            script_pubkey: transfer_tape_script(&tape_base, &merged_slots)
            .map_err(|_| invalid_input("could not build merged FTLP Tape", "request.intent"))?,
        },
    ];
    let lock_time = if live.state.ftlp_lock_time_enabled {
        snapshot_height(material)?
    } else {
        0
    };
    let (transaction, preview, fee_paid) = build_planned_transaction_with_policy(
        &id,
        "maintenance",
        u32::try_from(round).unwrap(),
        prior
            .map(|maintenance| vec![maintenance.transaction.transaction_id.clone()])
            .unwrap_or_default(),
        inputs,
        outputs,
        tbc_sdk::DEFAULT_FEE_RATE_SAT_PER_KB,
        signing,
        true,
        lock_time,
    )?;
    let proofs = selected
        .iter()
        .rev()
        .map(|item| {
            let source = if let Some(maintenance) = prior.filter(|maintenance| {
                item.utxo.txid == maintenance.transaction.transaction_id
            }) {
                TransactionSource::Planned(maintenance.transaction.transaction_id.clone())
            } else {
                evidence.source(&item.parent, parents)?
            };
            Ok(ProofReference { source, output_index: item.utxo.vout })
        })
        .collect::<Result<Vec<_>, EngineError>>()?;
    maintenance_artifacts(
        MaintenanceKind::Ftlp,
        transaction,
        preview,
        fee_paid,
        0,
        1,
        total,
        "ftlp",
        live.contract_id.to_string(),
        proofs,
        2,
    )
}

#[allow(clippy::too_many_arguments)]
fn maintenance_artifacts(
    kind: MaintenanceKind,
    transaction: PlannedTransaction,
    preview: Transaction,
    fee_paid: u64,
    asset_vout: usize,
    tape_vout: usize,
    balance: u128,
    classification: &str,
    contract_id: String,
    proofs: Vec<ProofReference>,
    change_vout: usize,
) -> Result<MaintenanceArtifacts, EngineError> {
    let id = transaction.transaction_id.clone();
    let output = preview.outputs[asset_vout].clone();
    let tape = preview.outputs[tape_vout].script_pubkey.clone();
    let change = &preview.outputs[change_vout];
    Ok(MaintenanceArtifacts {
        kind,
        transaction,
        preview: preview.clone(),
        fee_paid,
        asset: AuthenticatedUtxo {
            utxo: WalletUtxo {
                txid: id.clone(),
                vout: u32::try_from(asset_vout).unwrap(),
                satoshis: output.satoshis.to_string(),
                script_pub_key: hex(output.script_pubkey.as_bytes()),
                // This is a newly planned dependency, not an unknown external UTXO.
                confirmations: Some("0".to_owned()),
                classification: classification.to_owned(),
                contract_id: Some(contract_id),
            },
            parent: preview.clone(),
            output,
            tape: Some(tape),
            balance: Some(balance),
        },
        fee: NativeFundingUtxo {
            txid: id,
            vout: u32::try_from(change_vout).unwrap(),
            satoshis: change.satoshis,
            script: hex(change.script_pubkey.as_bytes()),
        },
        proofs,
    })
}

fn planned_maintenance_input(
    maintenance: &MaintenanceArtifacts,
    output_index: usize,
    unlocking_script: String,
    signing: &PublicSigningContext,
    sequence: u32,
) -> PlannedInput {
    let output = &maintenance.preview.outputs[output_index];
    PlannedInput {
        previous_transaction_id: maintenance.transaction.transaction_id.clone(),
        previous_output_index: u32::try_from(output_index).unwrap(),
        previous_output_script: hex(output.script_pubkey.as_bytes()),
        previous_output_satoshis: output.satoshis,
        sequence,
        unlocking_script,
        signer: signing.clone(),
    }
}

#[allow(clippy::too_many_arguments)]
fn pool_recipe_after_maintenance_chain(
    live: &LivePool,
    operation: PoolRecipeOperation,
    swap: Option<PoolRecipeSwap>,
    fee_first: bool,
    ftlp_maintenance: Option<&MaintenanceArtifacts>,
    pool_maintenances: &[MaintenanceArtifacts],
    pool_ft: &[AuthenticatedUtxo],
    ftlp: Option<&AuthenticatedUtxo>,
    parents: &ParentIndex,
    evidence: &mut EvidenceBuilder,
) -> Result<String, EngineError> {
    let final_maintenance = pool_maintenances.last().or(ftlp_maintenance).ok_or_else(|| {
        invalid_input(
            "Pool maintenance recipe requires a predecessor",
            "plan.payload.transactions",
        )
    })?;
    let fee_source = TransactionSource::Planned(
        final_maintenance.transaction.transaction_id.clone(),
    );
    let mut pool_ft_sources = Vec::with_capacity(pool_ft.len());
    for item in pool_ft {
        if let Some(maintenance) = pool_maintenances
            .iter()
            .find(|maintenance| maintenance.asset.utxo.txid == item.utxo.txid)
        {
            pool_ft_sources.push(TransactionSource::Planned(
                maintenance.transaction.transaction_id.clone(),
            ));
        } else {
            pool_ft_sources.push(evidence.source(&item.parent, parents)?);
        }
    }
    let mut auxiliary_parents = Vec::new();
    if fee_first {
        auxiliary_parents.push(fee_source.clone());
        auxiliary_parents.extend(pool_ft_sources);
    } else {
        let ftlp = ftlp.ok_or_else(|| {
            invalid_input(
                "Pool consume maintenance recipe requires FTLP ancestry",
                "plan.payload.transactions",
            )
        })?;
        auxiliary_parents.push(if let Some(maintenance) = ftlp_maintenance {
            TransactionSource::Planned(maintenance.transaction.transaction_id.clone())
        } else {
            evidence.source(&ftlp.parent, parents)?
        });
        auxiliary_parents.extend(pool_ft_sources);
        auxiliary_parents.push(fee_source);
    }
    let (parent, pre_parent, spent_vout) = if let Some(last) = pool_maintenances.last() {
        let pre_parent = if pool_maintenances.len() >= 2 {
            TransactionSource::Planned(
                pool_maintenances[pool_maintenances.len() - 2]
                    .transaction
                    .transaction_id
                    .clone(),
            )
        } else {
            evidence.source(&live.current.parent, parents)?
        };
        (
            TransactionSource::Planned(last.transaction.transaction_id.clone()),
            pre_parent,
            0,
        )
    } else {
        (
            evidence.source(&live.current.parent, parents)?,
            evidence.source(&live.predecessor, parents)?,
            live.current.utxo.vout,
        )
    };
    pool_unlocking_descriptor(PoolUnlockRecipe {
        parent,
        pre_parent,
        contract: live.authority.source(evidence, parents)?,
        auxiliary_parents,
        spent_vout,
        operation,
        swap,
        with_lock: live.state.public_key_locked,
        service_provider: live.state.service_provider.clone(),
        public_key_lock: live
            .public_keys
            .iter()
            .map(|key| hex(&key.to_bytes()))
            .collect(),
    })
}

fn pool_ft_recipe_after_maintenance_chain(
    input: &AuthenticatedUtxo,
    live: &LivePool,
    logical_index: u8,
    pool_maintenances: &[MaintenanceArtifacts],
    parents: &ParentIndex,
    evidence: &mut EvidenceBuilder,
) -> Result<String, EngineError> {
    let final_pool = pool_maintenances.last().ok_or_else(|| {
        invalid_input(
            "Pool-held FT maintenance recipe requires a Pool successor",
            "plan.payload.transactions",
        )
    })?;
    let (parent, proof_references) = if let Some(maintenance) = pool_maintenances
        .iter()
        .find(|maintenance| maintenance.asset.utxo.txid == input.utxo.txid)
    {
        (
            TransactionSource::Planned(maintenance.transaction.transaction_id.clone()),
            maintenance.proofs.clone(),
        )
    } else {
        (
            evidence.source(&input.parent, parents)?,
            proofs_for(input, parents, evidence)?,
        )
    };
    pool_held_ft_unlocking_descriptor(PoolHeldFtUnlockRecipe {
        parent,
        proof_references,
        contract: TransactionSource::Planned(
            final_pool.transaction.transaction_id.clone(),
        ),
        ft_version: live.authority.version,
        coin_mode: live.authority.is_coin,
        logical_swap_input_index: logical_index,
    })
}

fn pool_recipe_after_maintenance(
    live: &LivePool,
    operation: PoolRecipeOperation,
    maintenance: &MaintenanceArtifacts,
    pool_ft: &[AuthenticatedUtxo],
    ftlp: &AuthenticatedUtxo,
    parents: &ParentIndex,
    evidence: &mut EvidenceBuilder,
) -> Result<String, EngineError> {
    let planned = TransactionSource::Planned(maintenance.transaction.transaction_id.clone());
    let mut auxiliary_parents = Vec::new();
    auxiliary_parents.push(if maintenance.kind == MaintenanceKind::Ftlp {
        planned.clone()
    } else {
        evidence.source(&ftlp.parent, parents)?
    });
    for item in pool_ft {
        auxiliary_parents.push(if maintenance.kind == MaintenanceKind::PoolFt {
            planned.clone()
        } else {
            evidence.source(&item.parent, parents)?
        });
    }
    auxiliary_parents.push(planned.clone());
    pool_unlocking_descriptor(PoolUnlockRecipe {
        parent: if maintenance.kind == MaintenanceKind::PoolFt {
            planned
        } else {
            evidence.source(&live.current.parent, parents)?
        },
        pre_parent: if maintenance.kind == MaintenanceKind::PoolFt {
            evidence.source(&live.current.parent, parents)?
        } else {
            evidence.source(&live.predecessor, parents)?
        },
        contract: live.authority.source(evidence, parents)?,
        auxiliary_parents,
        spent_vout: if maintenance.kind == MaintenanceKind::PoolFt {
            0
        } else {
            live.current.utxo.vout
        },
        operation,
        swap: None,
        with_lock: live.state.public_key_locked,
        service_provider: live.state.service_provider.clone(),
        public_key_lock: live
            .public_keys
            .iter()
            .map(|key| hex(&key.to_bytes()))
            .collect(),
    })
}

fn pool_recipe_after_dual_maintenance(
    live: &LivePool,
    ftlp: &MaintenanceArtifacts,
    pool_ft: &MaintenanceArtifacts,
    parents: &ParentIndex,
    evidence: &mut EvidenceBuilder,
) -> Result<String, EngineError> {
    let ftlp_source = TransactionSource::Planned(ftlp.transaction.transaction_id.clone());
    let pool_source = TransactionSource::Planned(pool_ft.transaction.transaction_id.clone());
    pool_unlocking_descriptor(PoolUnlockRecipe {
        parent: pool_source.clone(),
        pre_parent: evidence.source(&live.current.parent, parents)?,
        contract: live.authority.source(evidence, parents)?,
        auxiliary_parents: vec![ftlp_source, pool_source.clone(), pool_source],
        spent_vout: 0,
        operation: PoolRecipeOperation::ConsumeLiquidity,
        swap: None,
        with_lock: live.state.public_key_locked,
        service_provider: live.state.service_provider.clone(),
        public_key_lock: live
            .public_keys
            .iter()
            .map(|key| hex(&key.to_bytes()))
            .collect(),
    })
}

fn maintenance_dependencies(
    inputs: &[PlannedInput],
    ftlp: &[MaintenanceArtifacts],
    pool_ft: &[MaintenanceArtifacts],
) -> Vec<String> {
    let internal_ids = ftlp
        .iter()
        .chain(pool_ft.iter())
        .map(|item| item.transaction.transaction_id.as_str())
        .collect::<BTreeSet<_>>();
    let mut dependencies = Vec::new();
    for input in inputs {
        if internal_ids.contains(input.previous_transaction_id.as_str())
            && !dependencies.contains(&input.previous_transaction_id)
        {
            dependencies.push(input.previous_transaction_id.clone());
        }
    }
    dependencies
}

fn maintenance_transactions(
    ftlp: &[MaintenanceArtifacts],
    pool_ft: &[MaintenanceArtifacts],
    primary: PlannedTransaction,
) -> Vec<PlannedTransaction> {
    ftlp
        .iter()
        .chain(pool_ft.iter())
        .map(|item| item.transaction.clone())
        .chain(std::iter::once(primary))
        .collect()
}

fn maintenance_previews(
    ftlp: &[MaintenanceArtifacts],
    pool_ft: &[MaintenanceArtifacts],
    primary: Transaction,
) -> Vec<Transaction> {
    ftlp
        .iter()
        .chain(pool_ft.iter())
        .map(|item| item.preview.clone())
        .chain(std::iter::once(primary))
        .collect()
}

fn maintenance_fees(
    ftlp: &[MaintenanceArtifacts],
    pool_ft: &[MaintenanceArtifacts],
    primary: u64,
) -> Vec<u64> {
    ftlp
        .iter()
        .chain(pool_ft.iter())
        .map(|item| item.fee_paid)
        .chain(std::iter::once(primary))
        .collect()
}

fn pool_swap_recipe_after_maintenance(
    live: &LivePool,
    maintenance: &MaintenanceArtifacts,
    pool_ft: &[AuthenticatedUtxo],
    parents: &ParentIndex,
    evidence: &mut EvidenceBuilder,
) -> Result<String, EngineError> {
    let planned = TransactionSource::Planned(maintenance.transaction.transaction_id.clone());
    let mut auxiliary_parents = vec![planned.clone()];
    for (index, item) in pool_ft.iter().enumerate() {
        auxiliary_parents.push(if index == 0 {
            planned.clone()
        } else {
            evidence.source(&item.parent, parents)?
        });
    }
    pool_unlocking_descriptor(PoolUnlockRecipe {
        parent: planned,
        pre_parent: evidence.source(&live.current.parent, parents)?,
        contract: live.authority.source(evidence, parents)?,
        auxiliary_parents,
        spent_vout: 0,
        operation: PoolRecipeOperation::Swap,
        swap: Some(PoolRecipeSwap::TbcToFt),
        with_lock: live.state.public_key_locked,
        service_provider: live.state.service_provider.clone(),
        public_key_lock: live
            .public_keys
            .iter()
            .map(|key| hex(&key.to_bytes()))
            .collect(),
    })
}

fn asset_candidates(
    material: &WalletMaterial<'_>,
    parents: &ParentIndex,
    classification: &str,
    contract_id: Option<&str>,
) -> Result<Vec<AuthenticatedUtxo>, EngineError> {
    let minimum = parse_decimal_u64(
        &material.policy.payload.min_confirmations,
        "policy.payload.minConfirmations",
    )?;
    let candidates = material
        .snapshot
        .payload
        .utxos
        .iter()
        .filter(|item| item.classification == classification)
        .collect::<Vec<_>>();
    if candidates.len() > MAX_POOL_CANDIDATES {
        return Err(invalid_input(
            "Pool candidate set exceeds deterministic bound",
            "snapshot.payload.utxos",
        ));
    }
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    for candidate in candidates {
        if !seen.insert((candidate.txid.clone(), candidate.vout)) {
            return Err(ancestry(
                "duplicate Pool candidate outpoint",
                "snapshot.payload.utxos",
            ));
        }
        if candidate.contract_id.as_deref() != contract_id {
            return Err(ancestry(
                "Pool candidate contract identity is invalid",
                "snapshot.payload.utxos",
            ));
        }
        let authenticated = authenticate_utxo(candidate, parents, true)?;
        if crate::confirmations::meets_minimum(
            candidate.confirmations.as_deref(),
            minimum,
            "snapshot.payload.utxos.confirmations",
        )?
        {
            result.push(authenticated);
        }
    }
    Ok(result)
}

fn authenticate_owner_ft_candidate(
    candidate: &AuthenticatedUtxo,
    authority: &Authority,
    material: &WalletMaterial<'_>,
) -> Result<(), EngineError> {
    let owner = Address::from_string(&material.snapshot.payload.account.address)
        .map_err(|_| ancestry("account address is invalid", "snapshot.payload.account.address"))?;
    let expected = transfer_code_script(&authority.code, FtCodeReceiver::Address(owner))
        .map_err(|_| ancestry("FT candidate Code is invalid", "snapshot.payload.utxos"))?;
    authenticate_ft_family(candidate, authority, &expected)
}

fn authenticate_pool_asset_candidate(
    candidate: &AuthenticatedUtxo,
    live: &LivePool,
    material: &WalletMaterial<'_>,
    kind: MaintenanceKind,
) -> Result<(), EngineError> {
    match kind {
        MaintenanceKind::PoolFt => {
            let pool_hash = hash::sha256(live.current.output.script_pubkey.as_bytes());
            let expected = pool_held_ft_code(&live.authority.code, hash::hash160(&pool_hash))
                .map_err(|_| ancestry("Pool-held FT candidate Code is invalid", "snapshot.payload.utxos"))?;
            authenticate_ft_family(candidate, &live.authority, &expected)
        }
        MaintenanceKind::Ftlp => {
            let tape = candidate.tape.as_ref().ok_or_else(|| {
                ancestry("FTLP candidate Tape is missing", "snapshot.payload.utxos")
            })?;
            let amount_slots = tape_amount_slots(tape)?;
            let base = if live.state.ftlp_lock_time_enabled {
                let lock_time = ftlp_lock_height(candidate)?;
                ftlp_tape(&FtlpTapeParams {
                    amount_raw: 0,
                    layout: FtlpTapeLayout::LockTime {
                        lock_time,
                        source_ft_tape_size: live.authority.tape.as_bytes().len(),
                    },
                })
            } else {
                standard_ftlp_tape(0, &live.authority)
            }
            .map_err(|_| ancestry("FTLP candidate Tape layout is invalid", "snapshot.payload.utxos"))?;
            let expected_tape = transfer_tape_script(&base, &amount_slots)
                .map_err(|_| ancestry("FTLP candidate Tape is invalid", "snapshot.payload.utxos"))?;
            if &expected_tape != tape {
                return Err(ancestry(
                    "FTLP candidate Tape does not match the Pool authority",
                    "snapshot.payload.utxos",
                ));
            }
            let params = FtlpCodeParams::for_tape(
                tape,
                live.authority.script_version,
                live.authority.is_coin,
            )
            .map_err(|_| ancestry("FTLP candidate parameters are invalid", "snapshot.payload.utxos"))?;
            let owner = Address::from_string(&material.snapshot.payload.account.address)
                .map_err(|_| ancestry("account address is invalid", "snapshot.payload.account.address"))?;
            let pool_hash = hash::sha256(live.current.output.script_pubkey.as_bytes());
            let expected_code = if live.state.ftlp_lock_time_enabled {
                ftlp_lock_time_code(pool_hash, &owner, &params)
            } else {
                ftlp_code(pool_hash, &owner, &params)
            }
            .map_err(|_| ancestry("FTLP candidate Code is invalid", "snapshot.payload.utxos"))?;
            if candidate.output.script_pubkey != expected_code {
                return Err(ancestry(
                    "FTLP candidate Code is not bound to this Pool and recipient",
                    "snapshot.payload.utxos",
                ));
            }
            Ok(())
        }
    }
}

fn authenticate_ft_family(
    candidate: &AuthenticatedUtxo,
    authority: &Authority,
    expected_code: &Script,
) -> Result<(), EngineError> {
    let tape = candidate.tape.as_ref().ok_or_else(|| {
        ancestry("FT candidate Tape is missing", "snapshot.payload.utxos")
    })?;
    let tape_output = candidate
        .parent
        .outputs
        .get(candidate.utxo.vout as usize + 1)
        .ok_or_else(|| ancestry("FT candidate Tape output is missing", "snapshot.payload.utxos"))?;
    let classified = classify_ft_script(&candidate.output.script_pubkey)
        .map_err(|_| ancestry("FT candidate Code family is invalid", "snapshot.payload.utxos"))?;
    let amount_slots = tape_amount_slots(tape)?;
    let expected_tape = transfer_tape_script(&authority.tape, &amount_slots)
        .map_err(|_| ancestry("FT candidate Tape is invalid", "snapshot.payload.utxos"))?;
    if candidate.output.script_pubkey != *expected_code
        || classified.version != authority.version
        || classified.is_coin != authority.is_coin
        || tape_output.satoshis != 0
        || expected_tape != *tape
    {
        return Err(ancestry(
            "FT candidate Code, Tape, version, or recipient binding is invalid",
            "snapshot.payload.utxos",
        ));
    }
    Ok(())
}

fn tape_amount_slots(tape: &Script) -> Result<[u8; 48], EngineError> {
    op_return_chunks(tape)?
        .first()
        .and_then(|chunk| chunk.as_slice().try_into().ok())
        .ok_or_else(|| ancestry("asset Tape amount layout is invalid", "snapshot.payload.utxos"))
}

fn ftlp_lock_height(candidate: &AuthenticatedUtxo) -> Result<u32, EngineError> {
    let chunks = op_return_chunks(candidate.tape.as_ref().ok_or_else(|| {
        ancestry("FTLP candidate Tape is missing", "snapshot.payload.utxos")
    })?)?;
    let raw: [u8; 4] = chunks
        .get(1)
        .and_then(|chunk| chunk.as_slice().try_into().ok())
        .ok_or_else(|| ancestry("FTLP lock-time Tape is malformed", "snapshot.payload.utxos"))?;
    Ok(u32::from_le_bytes(raw))
}

fn ftlp_candidate_eligible(
    candidate: &AuthenticatedUtxo,
    live: &LivePool,
    material: &WalletMaterial<'_>,
) -> Result<bool, EngineError> {
    if !live.state.ftlp_lock_time_enabled {
        return Ok(true);
    }
    let lock_height = ftlp_lock_height(candidate)?;
    let current_height = snapshot_height(material)?;
    if lock_height >= MAX_LOCK_HEIGHT || current_height >= MAX_LOCK_HEIGHT {
        return Err(ancestry(
            "FTLP lock-time domain does not match current block height",
            "snapshot.payload.block.height",
        ));
    }
    Ok(lock_height == 0 || lock_height <= current_height)
}

fn select_fee(
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
) -> Result<NativeFundingUtxo, EngineError> {
    let native = material
        .snapshot
        .payload
        .utxos
        .iter()
        .filter(|utxo| utxo.classification == "native")
        .map(|utxo| (utxo.txid.as_str(), utxo.vout))
        .collect::<BTreeSet<_>>();
    let mut candidates = funding_candidates(material, signing)?
        .into_iter()
        .filter(|candidate| native.contains(&(candidate.txid.as_str(), candidate.vout)))
        // Only the preferred funding parent is fetched by Chain Data. Remaining
        // address-index descriptors may fund an explicit native prerequisite;
        // do not demand extra ancestry reads for every alternative.
        .filter(|candidate| material.snapshot.payload.parents.iter().any(|parent| parent.txid == candidate.txid))
        .collect::<Vec<_>>();
    // Match Chain Data's preferred largest native candidate. A small change
    // parent may also be present incidentally as contract ancestry; the shared
    // ascending candidate order must not make that output trigger a needless
    // funding prerequisite while the preferred, authenticated input suffices.
    candidates.sort_by(|left, right| right.satoshis.cmp(&left.satoshis)
        .then_with(|| left.txid.cmp(&right.txid)).then_with(|| left.vout.cmp(&right.vout)));
    candidates.into_iter().next()
        .ok_or_else(|| {
            error(
                ErrorCode::InsufficientFunds,
                "native Pool fee funding is missing",
                "snapshot.payload.utxos",
            )
        })
}

fn candidate_order(
    left: &AuthenticatedUtxo,
    right: &AuthenticatedUtxo,
) -> std::cmp::Ordering {
    right.balance
        .cmp(&left.balance)
        .then_with(|| left.utxo.txid.cmp(&right.utxo.txid))
        .then_with(|| left.utxo.vout.cmp(&right.utxo.vout))
}

fn planned_input(
    input: &AuthenticatedUtxo,
    descriptor: String,
    signing: &PublicSigningContext,
    sequence: u32,
) -> PlannedInput {
    PlannedInput {
        previous_transaction_id: input.utxo.txid.clone(),
        previous_output_index: input.utxo.vout,
        previous_output_script: input.utxo.script_pub_key.clone(),
        previous_output_satoshis: input.output.satoshis,
        sequence,
        unlocking_script: descriptor,
        signer: signing.clone(),
    }
}

fn native_planned_input(
    input: &NativeFundingUtxo,
    signing: &PublicSigningContext,
) -> PlannedInput {
    PlannedInput {
        previous_transaction_id: input.txid.clone(),
        previous_output_index: input.vout,
        previous_output_script: input.script.clone(),
        previous_output_satoshis: input.satoshis,
        sequence: DEFAULT_SEQUENCE,
        unlocking_script: String::new(),
        signer: signing.clone(),
    }
}

fn pool_recipe(
    live: &LivePool,
    operation: PoolRecipeOperation,
    swap: Option<PoolRecipeSwap>,
    auxiliaries: Vec<&Transaction>,
    parents: &ParentIndex,
    evidence: &mut EvidenceBuilder,
) -> Result<String, EngineError> {
    let mut sources = Vec::with_capacity(auxiliaries.len());
    for parent in auxiliaries {
        sources.push(evidence.source(parent, parents)?);
    }
    pool_unlocking_descriptor(PoolUnlockRecipe {
        parent: evidence.source(&live.current.parent, parents)?,
        pre_parent: evidence.source(&live.predecessor, parents)?,
        contract: live.authority.source(evidence, parents)?,
        auxiliary_parents: sources,
        spent_vout: live.current.utxo.vout,
        operation,
        swap,
        with_lock: live.state.public_key_locked,
        service_provider: live.state.service_provider.clone(),
        public_key_lock: live
            .public_keys
            .iter()
            .map(|key| hex(&key.to_bytes()))
            .collect(),
    })
}

fn pool_ft_recipe(
    input: &AuthenticatedUtxo,
    live: &LivePool,
    logical_index: u8,
    parents: &ParentIndex,
    evidence: &mut EvidenceBuilder,
) -> Result<String, EngineError> {
    let parent_source = evidence.source(&input.parent, parents)?;
    let proofs = proofs_for(input, parents, evidence)?;
    let contract = evidence.source(&live.current.parent, parents)?;
    pool_held_ft_unlocking_descriptor(PoolHeldFtUnlockRecipe {
        parent: parent_source,
        proof_references: proofs,
        contract,
        ft_version: live.authority.version,
        coin_mode: live.authority.is_coin,
        logical_swap_input_index: logical_index,
    })
}

fn proofs_for(
    input: &AuthenticatedUtxo,
    parents: &ParentIndex,
    evidence: &mut EvidenceBuilder,
) -> Result<Vec<ProofReference>, EngineError> {
    proofs_for_tape_sources(
        &input.parent,
        input.tape.as_ref().ok_or_else(|| {
            ancestry("FT Tape is missing", "snapshot.payload.parents")
        })?,
        parents,
        evidence,
    )
}

fn proofs_for_tape_sources(
    parent: &Transaction,
    tape: &Script,
    parents: &ParentIndex,
    evidence: &mut EvidenceBuilder,
) -> Result<Vec<ProofReference>, EngineError> {
    // Pinned source: contracts/ft/unlock.rs::ft_pre_pre_source_indexes at 923497e8.
    let bytes = tape.as_bytes();
    if bytes.len() < 56
        || !bytes.starts_with(&[
            tbc_sdk::script::opcodes::OP_FALSE,
            tbc_sdk::script::opcodes::OP_RETURN,
            0x30,
        ])
        || !bytes.ends_with(b"FTape")
    {
        return Err(ancestry(
            "FT Tape source slots are invalid",
            "snapshot.payload.parents",
        ));
    }
    let amounts = &bytes[3..51];
    let mut indexes = Vec::new();
    for input_index in (0..6).rev() {
        let start = input_index * 8;
        if amounts[start..start + 8] != [0u8; 8] {
            indexes.push(input_index);
        }
    }
    if indexes.is_empty() {
        return Err(ancestry(
            "FT Tape does not reference a source input",
            "snapshot.payload.parents",
        ));
    }
    indexes
        .into_iter()
        .map(|input_index| {
            let source = parent.inputs.get(input_index).ok_or_else(|| {
                ancestry(
                    "FT Tape references a missing source input",
                    "snapshot.payload.parents",
                )
            })?;
            let proof = parents.get(&source.previous_output.txid.to_string())?;
            Ok(ProofReference {
                source: evidence.source(proof, parents)?,
                output_index: source.previous_output.vout,
            })
        })
        .collect()
}

fn ftlp_lock_mode(
    input: &AuthenticatedUtxo,
    live: &LivePool,
    material: &WalletMaterial<'_>,
) -> Result<FtlpLockMode, EngineError> {
    if !live.state.ftlp_lock_time_enabled {
        return Ok(FtlpLockMode::Standard);
    }
    let chunks = op_return_chunks(input.tape.as_ref().ok_or_else(|| {
        ancestry("FTLP Tape is missing", "snapshot.payload.parents")
    })?)?;
    let raw: [u8; 4] = chunks
        .get(1)
        .and_then(|item| item.as_slice().try_into().ok())
        .ok_or_else(|| {
            ancestry(
                "FTLP lock-time Tape is invalid",
                "snapshot.payload.parents",
            )
        })?;
    let lock_height = u32::from_le_bytes(raw);
    if lock_height == 0 {
        return Ok(FtlpLockMode::BlockHeight {
            lock_height: 0,
            current_height: 0,
        });
    }
    let current_height = snapshot_height(material)?;
    if lock_height >= MAX_LOCK_HEIGHT
        || current_height >= MAX_LOCK_HEIGHT
        || lock_height > current_height
    {
        return Err(ancestry(
            "FTLP block-height lock is not eligible",
            "snapshot.payload.block.height",
        ));
    }
    Ok(FtlpLockMode::BlockHeight {
        lock_height,
        current_height,
    })
}

fn ftlp_maintenance_lock_mode(
    input: &AuthenticatedUtxo,
    live: &LivePool,
    material: &WalletMaterial<'_>,
) -> Result<FtlpLockMode, EngineError> {
    match ftlp_lock_mode(input, live, material)? {
        FtlpLockMode::BlockHeight { lock_height: 0, .. } => Ok(FtlpLockMode::BlockHeight {
            lock_height: 0,
            current_height: snapshot_height(material)?,
        }),
        lock => Ok(lock),
    }
}

fn operation_lock_height(
    value: Option<&str>,
    live: &LivePool,
    material: &WalletMaterial<'_>,
) -> Result<Option<u32>, EngineError> {
    if live.state.ftlp_lock_time_enabled {
        let height = value.ok_or_else(|| {
            invalid_input(
                "lock-time Pool add requires lockUntilHeight",
                "request.intent.lockUntilHeight",
            )
        })?;
        let parsed = validate_height(height, "request.intent.lockUntilHeight")?;
        if parsed <= snapshot_height(material)? {
            return Err(invalid_input(
                "lockUntilHeight must exceed current height",
                "request.intent.lockUntilHeight",
            ));
        }
        Ok(Some(parsed))
    } else if value.is_some() {
        Err(invalid_input(
            "standard Pool add cannot set lockUntilHeight",
            "request.intent.lockUntilHeight",
        ))
    } else {
        Ok(None)
    }
}

type CreateLock = (Vec<PublicKey>, Option<(Address, u64)>, Option<u32>);

fn create_lock(lock: Option<&PoolLock>, current_height: u32) -> Result<CreateLock, EngineError> {
    let Some(lock) = lock else {
        return Ok((Vec::new(), None, None));
    };
    let mut keys = lock
        .public_keys
        .iter()
        .map(|key| {
            let bytes = decode_hex(key)?;
            PublicKey::from_slice(&bytes).map_err(|_| {
                invalid_input(
                    "invalid Pool lock public key",
                    "request.intent.lock.publicKeys",
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    keys.sort_by_key(|key| key.to_bytes());
    keys.dedup_by_key(|key| key.to_bytes());
    if keys.is_empty() || keys.len() > 10 || keys.len() != lock.public_keys.len() {
        return Err(invalid_input(
            "Pool lock requires one to ten unique keys",
            "request.intent.lock.publicKeys",
        ));
    }
    let recipient = Address::from_string(&lock.cost_recipient).map_err(|_| {
        invalid_input(
            "invalid LP cost recipient",
            "request.intent.lock.costRecipient",
        )
    })?;
    let amount = parse_decimal_u64(&lock.cost_amount, "request.intent.lock.costAmount")?;
    if amount == 0 {
        return Err(invalid_input(
            "LP cost must be positive",
            "request.intent.lock.costAmount",
        ));
    }
    let until = lock
        .until_height
        .as_deref()
        .map(|value| validate_height(value, "request.intent.lock.untilHeight"))
        .transpose()?;
    if until.is_some_and(|height| height <= current_height) {
        return Err(invalid_input(
            "Pool lock height must exceed current height",
            "request.intent.lock.untilHeight",
        ));
    }
    Ok((keys, Some((recipient, amount)), until))
}

fn build_tape_amount_with_offset(
    mut amount_raw: u128,
    input_balances: &[u128],
    input_offset: usize,
) -> Result<([u8; 48], [u8; 48]), EngineError> {
    let mut amount_slots = [0u64; 6];
    let mut change_slots = [0u64; 6];
    if input_offset >= 6 || input_offset + input_balances.len() > 6 {
        return Err(invalid_input(
            "FT tape input slots exceed supported width",
            "walletMaterial.utxos",
        ));
    }
    for (balance_index, balance) in input_balances.iter().copied().enumerate() {
        if amount_raw == 0 {
            break;
        }
        let index = input_offset + balance_index;
        let spend = balance.min(amount_raw);
        amount_slots[index] = amount_slot(spend)?;
        change_slots[index] = amount_slot(balance - spend)?;
        amount_raw -= spend;
    }
    if amount_raw > 0 {
        return Err(invalid_input(
            "insufficient authenticated Pool FT balance",
            "walletMaterial.utxos",
        ));
    }
    for (balance_index, balance) in input_balances.iter().copied().enumerate() {
        let index = input_offset + balance_index;
        if amount_slots[index] == 0 && change_slots[index] == 0 {
            change_slots[index] = amount_slot(balance)?;
        }
    }
    Ok((encode_amount_slots(amount_slots), encode_amount_slots(change_slots)))
}

fn encode_amount_slots(slots: [u64; 6]) -> [u8; 48] {
    let mut bytes = [0u8; 48];
    for (index, slot) in slots.iter().enumerate() {
        bytes[index * 8..index * 8 + 8].copy_from_slice(&slot.to_le_bytes());
    }
    bytes
}

fn amount_slot(value: u128) -> Result<u64, EngineError> {
    u64::try_from(value).map_err(|_| {
        invalid_input(
            "FT tape slot exceeds released u64 width",
            "walletMaterial.utxos",
        )
    })
}

fn pool_policy<'a>(
    material: &'a WalletMaterial<'a>,
) -> Result<&'a ResolvedPoolPolicy, EngineError> {
    let policy = material.policy.payload.pool.as_ref().ok_or_else(|| {
        invalid_input("resolved Pool policy is required", "policy.payload.pool")
    })?;
    if !(1..=6).contains(&policy.lp_plan)
        || !(1..=64).contains(&policy.service_provider_tag.len())
        || !policy
            .service_provider_tag
            .bytes()
            .all(|byte| (b' '..=b'~').contains(&byte))
    {
        return Err(invalid_input(
            "resolved Pool policy is invalid",
            "policy.payload.pool",
        ));
    }
    let expected_rate = match policy.lp_plan {
        1 | 2 => 35,
        3 => 135,
        4 => 335,
        5 => 535,
        6 => 330,
        _ => unreachable!(),
    };
    if policy.service_fee_rate != expected_rate {
        return Err(invalid_input(
            "Pool service fee rate does not match the released LP plan",
            "policy.payload.pool.serviceFeeRate",
        ));
    }
    Ok(policy)
}

fn enforce_pool_amount_limit(
    material: &WalletMaterial<'_>,
    scope: &str,
    contract_id: Option<&str>,
    amount: u64,
    path: &str,
) -> Result<(), EngineError> {
    for (index, limit) in material.policy.payload.amount_limits.iter().enumerate() {
        if limit.scope != scope
            // This module executes the historical Pool/FT templates only.
            // A coexisting new TBC20 profile must not constrain old assets.
            || limit.protocol_version.as_deref() == Some("tbc20")
            || limit
                .contract_id
                .as_deref()
                .is_some_and(|expected| Some(expected) != contract_id)
        {
            continue;
        }
        let maximum = parse_decimal_u64(
            &limit.maximum,
            &format!("policy.payload.amountLimits[{index}].maximum"),
        )?;
        if amount > maximum {
            return Err(invalid_input("Pool amount exceeds authenticated policy limit", path));
        }
    }
    Ok(())
}

fn swap_fee_parts(
    amount: u64,
    rate: u16,
    plan: u8,
) -> Result<(u64, u64, u64), EngineError> {
    let lp_rate = tbc_sdk::contracts::pool_nft_v2::math::lp_fee_rate(rate, plan)
        .map_err(|_| invalid_input("invalid Pool fee plan", "policy.payload.pool"))?;
    let service = u128::from(amount) * u128::from(rate) / 10_000;
    let lp = u128::from(amount) * u128::from(lp_rate) / 10_000;
    let provider = service
        .checked_sub(lp)
        .ok_or_else(|| invalid_input("Pool provider fee underflow", "policy.payload.pool"))?;
    Ok((
        u64::try_from(service).map_err(|_| invalid_input("Pool fee overflow", "policy"))?,
        u64::try_from(lp).map_err(|_| invalid_input("Pool fee overflow", "policy"))?,
        u64::try_from(provider).map_err(|_| invalid_input("Pool fee overflow", "policy"))?,
    ))
}

fn service_fee_script(plan: u8) -> Result<Script, EngineError> {
    let index = usize::from(plan.checked_sub(1).ok_or_else(|| {
        invalid_input("invalid Pool fee plan", "policy.payload.pool.lpPlan")
    })?);
    Address::from_string(SERVICE_FEE_ADDRESSES.get(index).ok_or_else(|| {
        invalid_input("invalid Pool fee plan", "policy.payload.pool.lpPlan")
    })?)
    .map(|address| address.script_pubkey())
    .map_err(|_| {
        invalid_input(
            "invalid released service-fee address",
            "policy.payload.pool.lpPlan",
        )
    })
}

fn standard_ftlp_tape(amount: u64, authority: &Authority) -> tbc_sdk::Result<Script> {
    ftlp_tape(&FtlpTapeParams {
        amount_raw: amount,
        layout: FtlpTapeLayout::Standard {
            decimal: 6,
            name: &authority.name,
            symbol: &authority.symbol,
            is_coin: authority.is_coin,
        },
    })
}

pub(crate) fn partial_hash_offset(version: u8, coin: bool) -> Result<usize, EngineError> {
    match (version, coin) {
        (_, true) => Ok(1_984),
        (1, false) => Ok(1_536),
        (2 | 3, false) => Ok(1_856),
        (4, false) => Ok(2_048),
        _ => Err(ancestry(
            "unsupported Pool FT partial-hash offset",
            "snapshot.payload.contracts",
        )),
    }
}

fn op_return_chunks(script: &Script) -> Result<Vec<Vec<u8>>, EngineError> {
    let bytes = script.as_bytes();
    if !bytes.starts_with(&[0, tbc_sdk::script::opcodes::OP_RETURN]) {
        return Err(ancestry(
            "Tape must begin OP_FALSE OP_RETURN",
            "snapshot.payload.parents",
        ));
    }
    let mut index = 2usize;
    let mut chunks = Vec::new();
    while index < bytes.len() {
        let opcode = bytes[index];
        index += 1;
        let length = match opcode {
            0..=0x4b => usize::from(opcode),
            0x4c => {
                let value = usize::from(*bytes.get(index).ok_or_else(|| {
                    ancestry("truncated Tape push", "snapshot.payload.parents")
                })?);
                index += 1;
                value
            }
            0x4d => {
                let raw: [u8; 2] = bytes
                    .get(index..index + 2)
                    .and_then(|item| item.try_into().ok())
                    .ok_or_else(|| {
                        ancestry("truncated Tape push", "snapshot.payload.parents")
                    })?;
                index += 2;
                usize::from(u16::from_le_bytes(raw))
            }
            0x4e => {
                let raw: [u8; 4] = bytes
                    .get(index..index + 4)
                    .and_then(|item| item.try_into().ok())
                    .ok_or_else(|| {
                        ancestry("truncated Tape push", "snapshot.payload.parents")
                    })?;
                index += 4;
                usize::try_from(u32::from_le_bytes(raw)).map_err(|_| {
                    ancestry("Tape push overflow", "snapshot.payload.parents")
                })?
            }
            _ => {
                return Err(ancestry(
                    "Tape contains non-push opcode",
                    "snapshot.payload.parents",
                ));
            }
        };
        let end = index
            .checked_add(length)
            .ok_or_else(|| ancestry("Tape push overflow", "snapshot.payload.parents"))?;
        chunks.push(
            bytes
                .get(index..end)
                .ok_or_else(|| ancestry("truncated Tape field", "snapshot.payload.parents"))?
                .to_vec(),
        );
        index = end;
    }
    if Script::op_return(&chunks) != *script {
        return Err(ancestry(
            "Tape pushes are not canonical",
            "snapshot.payload.parents",
        ));
    }
    Ok(chunks)
}

fn snapshot_height(material: &WalletMaterial<'_>) -> Result<u32, EngineError> {
    material
        .snapshot
        .payload
        .require_block()?
        .height
        .parse::<u32>()
        .map_err(|_| {
            invalid_input(
                "snapshot height exceeds uint32",
                "snapshot.payload.block.height",
            )
        })
}

fn validate_live_common(request: &CanonicalRequest) -> Result<(), EngineError> {
    validate_contract(
        required(
            &request.intent.pool_contract_id,
            "request.intent.poolContractId",
        )?,
        "request.intent.poolContractId",
    )?;
    validate_address(
        required(&request.intent.receiver, "request.intent.receiver")?,
        "request.intent.receiver",
    )
}

fn validate_create_policy_fields(request: &CanonicalRequest) -> Result<(), EngineError> {
    let intent = &request.intent;
    validate_contract(required(&intent.ft_contract_id, "request.intent.ftContractId")?, "request.intent.ftContractId")?;
    let lp_plan = intent.lp_plan.ok_or_else(|| invalid_input("Pool LP plan is required", "request.intent.lpPlan"))?;
    if !(1..=6).contains(&lp_plan) {
        return Err(invalid_input("Pool LP plan must be in 1..=6", "request.intent.lpPlan"));
    }
    if let Some(tag) = intent.service_provider_tag.as_deref() {
        validate_tag(tag, "request.intent.serviceProviderTag")?;
    }
    if let Some(lock) = intent.lock.as_ref() {
        validate_lock(lock)?;
    }
    Ok(())
}

fn validate_initial_liquidity(request: &CanonicalRequest) -> Result<(), EngineError> {
    let initial = request.intent.initial_liquidity.as_ref().ok_or_else(|| invalid_input(
        "Pool initial liquidity is required", "request.intent.initialLiquidity",
    ))?;
    validate_address(&initial.receiver, "request.intent.initialLiquidity.receiver")?;
    positive(&initial.tbc_amount, "request.intent.initialLiquidity.tbcAmount")?;
    positive(&initial.ft_amount, "request.intent.initialLiquidity.ftAmount")?;
    Ok(())
}

fn validate_swap_constraints(request: &CanonicalRequest) -> Result<(), EngineError> {
    if request
        .constraints
        .as_ref()
        .and_then(|item| item.expires_at.as_ref())
        .is_none()
    {
        return Err(invalid_input(
            "Pool swap requires expiresAt",
            "request.constraints.expiresAt",
        ));
    }
    Ok(())
}

fn validate_lock(lock: &PoolLock) -> Result<(), EngineError> {
    if lock.public_keys.is_empty() || lock.public_keys.len() > 10 {
        return Err(invalid_input(
            "Pool lock key count must be 1..=10",
            "request.intent.lock.publicKeys",
        ));
    }
    let mut seen = BTreeSet::new();
    for key in &lock.public_keys {
        let valid = decode_hex(key)
            .and_then(|bytes| {
                PublicKey::from_slice(&bytes).map_err(|_| {
                    invalid_input(
                        "invalid Pool lock public key",
                        "request.intent.lock.publicKeys",
                    )
                })
            })
            .is_ok();
        if !seen.insert(key) || !valid {
            return Err(invalid_input(
                "Pool lock keys must be unique valid public keys",
                "request.intent.lock.publicKeys",
            ));
        }
    }
    validate_address(
        &lock.cost_recipient,
        "request.intent.lock.costRecipient",
    )?;
    positive(&lock.cost_amount, "request.intent.lock.costAmount")?;
    if let Some(height) = lock.until_height.as_deref() {
        validate_height(height, "request.intent.lock.untilHeight")?;
    }
    Ok(())
}

fn validate_height(value: &str, path: &str) -> Result<u32, EngineError> {
    let height = parse_decimal_u64(value, path)?;
    let height =
        u32::try_from(height).map_err(|_| invalid_input("height exceeds uint32", path))?;
    if height >= MAX_LOCK_HEIGHT {
        return Err(invalid_input("lock time must use block-height domain", path));
    }
    Ok(height)
}

fn enforce_minimum(
    actual: u64,
    expected: &Option<String>,
    path: &str,
) -> Result<(), EngineError> {
    if actual < parse_decimal_u64(required(expected, path)?, path)? {
        return Err(invalid_input(
            "released Pool output is below requested minimum",
            path,
        ));
    }
    Ok(())
}

fn forbid_pool_fields(
    intent: &crate::model::TransferIntent,
    fields: &[&str],
) -> Result<(), EngineError> {
    let present = |field: &str| match field {
        "stage" => intent.stage.is_some(),
        "ftContractId" => intent.ft_contract_id.is_some(),
        "poolContractId" => intent.pool_contract_id.is_some(),
        "lpPlan" => intent.lp_plan.is_some(),
        "serviceProviderTag" => intent.service_provider_tag.is_some(),
        "initialLiquidity" => intent.initial_liquidity.is_some(),
        "receiver" => intent.receiver.is_some(),
        "tbcAmount" => intent.tbc_amount.is_some(),
        "ftAmount" => intent.ft_amount.is_some(),
        "lpAmount" => intent.lp_amount.is_some(),
        "minimumLpAmount" => intent.minimum_lp_amount.is_some(),
        "minimumTbcAmount" => intent.minimum_tbc_amount.is_some(),
        "minimumFtAmount" => intent.minimum_ft_amount.is_some(),
        "lock" => intent.lock.is_some(),
        "lockUntilHeight" => intent.lock_until_height.is_some(),
        _ => false,
    };
    if fields.iter().any(|field| present(field)) {
        Err(invalid_input(
            "Pool intent contains fields from another operation",
            "request.intent",
        ))
    } else {
        Ok(())
    }
}

fn validate_address(value: &str, path: &str) -> Result<(), EngineError> {
    Address::from_string(value)
        .map(|_| ())
        .map_err(|_| invalid_input("invalid Pool address", path))
}

fn validate_contract(value: &str, path: &str) -> Result<(), EngineError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Ok(())
    } else {
        Err(invalid_input("invalid Pool contract identifier", path))
    }
}

fn validate_tag(value: &str, path: &str) -> Result<(), EngineError> {
    if (1..=64).contains(&value.len())
        && value.bytes().all(|byte| (b' '..=b'~').contains(&byte))
    {
        Ok(())
    } else {
        Err(invalid_input("invalid Pool service-provider tag", path))
    }
}

fn positive(value: &str, path: &str) -> Result<u64, EngineError> {
    let amount = parse_decimal_u64(value, path)?;
    if amount == 0 {
        Err(invalid_input("Pool amount must be positive", path))
    } else {
        Ok(amount)
    }
}

fn required<'a>(value: &'a Option<String>, path: &str) -> Result<&'a str, EngineError> {
    value
        .as_deref()
        .ok_or_else(|| invalid_input("required Pool intent field is missing", path))
}

fn positive_delta(value: i128, path: &str) -> Result<u64, EngineError> {
    u64::try_from(value)
        .map_err(|_| invalid_input("Pool positive delta is outside uint64", path))
}

fn negative_delta(value: i128, path: &str) -> Result<u64, EngineError> {
    value
        .checked_neg()
        .and_then(|item| u64::try_from(item).ok())
        .ok_or_else(|| invalid_input("Pool negative delta is outside uint64", path))
}

fn sum_u128(values: &[u128]) -> Result<u128, EngineError> {
    values.iter().try_fold(0u128, |sum, value| {
        sum.checked_add(*value)
            .ok_or_else(|| invalid_input("Pool balance overflow", "snapshot.payload.utxos"))
    })
}

fn decode_hex(value: &str) -> Result<Vec<u8>, EngineError> {
    if !value.len().is_multiple_of(2) {
        return Err(invalid_input(
            "hexadecimal value has odd length",
            "request.intent.lock.publicKeys",
        ));
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let digit = |byte| match byte {
                b'0'..=b'9' => Some(byte - b'0'),
                b'a'..=b'f' => Some(byte - b'a' + 10),
                b'A'..=b'F' => Some(byte - b'A' + 10),
                _ => None,
            };
            Ok((digit(pair[0]).ok_or_else(|| {
                invalid_input(
                    "invalid hexadecimal value",
                    "request.intent.lock.publicKeys",
                )
            })? << 4)
                | digit(pair[1]).ok_or_else(|| {
                    invalid_input(
                        "invalid hexadecimal value",
                        "request.intent.lock.publicKeys",
                    )
                })?)
        })
        .collect()
}

fn ancestry(message: &str, path: &str) -> EngineError {
    error(ErrorCode::InvalidAncestry, message, path)
}
