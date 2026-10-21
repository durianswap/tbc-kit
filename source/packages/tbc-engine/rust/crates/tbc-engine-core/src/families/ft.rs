use std::collections::BTreeMap;
use std::ops::Bound::{Included, Unbounded};

use sha2::{Digest, Sha256};
use tbc_sdk::{
    Address, DEFAULT_LOCK_TIME, DEFAULT_SEQUENCE, DEFAULT_SIGHASH, OutPoint, PublicKey,
    Transaction, TxIn, TxOut, Txid,
    contracts::ft::{
        amount::{build_tape_amount, build_multi_tape_amounts},
        scripts::{
            FT_CODE_SATOSHIS, FT_MINT_SOURCE_SATOSHIS, FT_TAPE_SATOSHIS, FtCodeReceiver,
            mint_source_script, mint_tape_script, transfer_code_script, transfer_tape_script,
        },
        unlock::{current_tx_data, pre_pre_tx_data, pre_tx_data},
    },
    script::Script,
};

use crate::ancestry::{AssetSpend, FtMetadata, prepare_asset_ancestry, prepare_stablecoin_ancestry};
use crate::funding::{NativeFundingUtxo, conservative_transaction_fee, native_funding_candidates};
use crate::fee_envelope::reconcile_plan_fee_envelopes;
use crate::model::{
    AssetFlow, CanonicalRequest, ExecutionPlan, ExecutionPlanPayload, PlanResult, PlannedTransfer,
    TransactionPreview, TransactionTemplate, Violation, WIRE_VERSION,
    WalletMaterial, error,
};
use crate::normalize::{canonical_hash, hex, parse_decimal_u64, validate_request, validate_version};
use crate::signing::{
    EvidenceEntry, FtProofReference, FtTransactionSource, PlannedInput, PlannedOutput,
    PlannedTransaction, PublicSigningContext, UnsignedPlan, begin_signing, ft_mint_output_descriptor,
    ft_evidence_output_descriptor, ft_unlocking_descriptor, materialize_unsigned_preview,
};
use crate::{EngineError, ErrorCode};

const MAX_FT_INPUTS: usize = 500;
const MAX_FT_INPUTS_PER_TRANSACTION: usize = 5;
const MAX_FT_METADATA_BYTES: usize = 256;
const MAX_P2PKH_SCRIPT_SIG_BYTES: usize = 108;

struct AssetCandidate {
    previous_transaction_id: String,
    previous_output_index: u32,
    satoshis: u64,
    code_script: String,
    balance_raw: u128,
    parent_source: FtTransactionSource,
    parent_preview: Transaction,
    proof_references: Vec<FtProofReference>,
    proof_previews: Vec<(Transaction, u32)>,
    parent_stage: Option<u32>,
    sequence: u32,
    lock_time: u32,
    coin_mode: bool,
}

struct FeeCandidate {
    previous_transaction_id: String,
    previous_output_index: u32,
    satoshis: u64,
    script: String,
    preview_txid: Txid,
    parent_stage: Option<u32>,
}

struct FeePool {
    candidates: BTreeMap<(u64, [u8; 32], u32), FeeCandidate>,
}

impl FeePool {
    fn new(candidates: Vec<FeeCandidate>) -> Result<Self, EngineError> {
        let mut indexed = BTreeMap::new();
        for candidate in candidates {
            let txid = decode_hex(&candidate.previous_transaction_id, "snapshot.payload.utxos")?
                .try_into()
                .map_err(|_| invalid_input("native funding txid width is invalid", "snapshot.payload.utxos"))?;
            let key = (candidate.satoshis, txid, candidate.previous_output_index);
            if indexed.insert(key, candidate).is_some() {
                return Err(error(
                    ErrorCode::InvalidAncestry,
                    "native funding snapshot contains a duplicate outpoint",
                    "snapshot.payload.utxos",
                ));
            }
        }
        Ok(Self { candidates: indexed })
    }

    fn take_smallest_at_least(&mut self, minimum: u64) -> Option<FeeCandidate> {
        let key = self
            .candidates
            .range((Included((minimum, [0; 32], 0)), Unbounded))
            .next()
            .map(|(key, _)| *key)?;
        self.candidates.remove(&key)
    }

    fn restore(&mut self, candidate: FeeCandidate) -> Result<(), EngineError> {
        let txid = decode_hex(&candidate.previous_transaction_id, "snapshot.payload.utxos")?
            .try_into()
            .map_err(|_| invalid_input("native funding txid width is invalid", "snapshot.payload.utxos"))?;
        self.candidates.insert(
            (candidate.satoshis, txid, candidate.previous_output_index),
            candidate,
        );
        Ok(())
    }
}

struct BuiltAssetTransaction {
    planned: PlannedTransaction,
    preview: Transaction,
    fee: u64,
    change: u64,
}

#[derive(Default)]
struct EvidenceBuilder {
    entries: Vec<EvidenceEntry>,
    indexes: BTreeMap<String, u32>,
}

impl EvidenceBuilder {
    fn register(&mut self, raw: String) -> Result<FtTransactionSource, EngineError> {
        let transaction = Transaction::from_hex(&raw)
            .map_err(|_| invalid_input("FT evidence transaction is malformed", "snapshot.payload.parents"))?;
        if transaction.to_hex() != raw {
            return Err(invalid_input(
                "FT evidence transaction encoding is not canonical",
                "snapshot.payload.parents",
            ));
        }
        let txid = transaction.txid().to_string();
        if let Some(index) = self.indexes.get(&txid) {
            let entry = &self.entries[*index as usize];
            if entry.raw_transaction != raw {
                return Err(invalid_input(
                    "FT evidence transaction conflicts with an existing txid",
                    "snapshot.payload.parents",
                ));
            }
            return Ok(FtTransactionSource::Evidence(*index));
        }
        let index = u32::try_from(self.entries.len())
            .map_err(|_| invalid_input("FT evidence index exceeds uint32", "snapshot.payload.parents"))?;
        self.entries.push(EvidenceEntry {
            txid: txid.clone(),
            raw_transaction: raw,
        });
        self.indexes.insert(txid, index);
        Ok(FtTransactionSource::Evidence(index))
    }
}

pub(crate) fn public_signing_context(
    material: &WalletMaterial<'_>,
) -> Result<PublicSigningContext, EngineError> {
    let account = &material.snapshot.payload.account;
    let bytes = decode_hex(&account.public_key, "snapshot.payload.account.publicKey")?;
    let public_key = PublicKey::from_slice(&bytes).map_err(|_| {
        error(
            ErrorCode::MissingMaterial,
            "snapshot account public key is invalid",
            "snapshot.payload.account.publicKey",
        )
    })?;
    if public_key.address().to_string() != account.address {
        return Err(error(
            ErrorCode::MissingMaterial,
            "snapshot public key does not control the account address",
            "snapshot.payload.account",
        ));
    }
    Ok(PublicSigningContext {
        address: account.address.clone(),
        public_key: hex(&public_key.to_bytes()),
        public_key_hash: hex(&public_key.hash160()),
    })
}

pub(crate) fn plan_ft(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
) -> Result<PlannedTransfer, EngineError> {
    validate_request(request)?;
    validate_material_identity(request, material)?;
    validate_policy(material)?;
    match request.intent.intent_type.as_str() {
        "tbc.ft.create" => plan_create(request, material, signing),
        "tbc.ft.transfer" => plan_transfer(request, material, signing),
        "tbc.ft.merge" | "tbc.stablecoin.merge" => plan_merge(request, material, signing),
        "tbc.stablecoin.transfer" => plan_transfer(request, material, signing),
        _ => Err(error(
            ErrorCode::UnsupportedIntent,
            "unsupported FT intent",
            "request.intent.type",
        )),
    }
}

pub(crate) fn validate_ft_plan(
    request: &CanonicalRequest,
    plan: &UnsignedPlan,
) -> Vec<Violation> {
    let mut violations = Vec::new();
    let roles = plan
        .transactions
        .iter()
        .map(|transaction| transaction.role.as_str())
        .collect::<Vec<_>>();
    match request.intent.intent_type.as_str() {
        "tbc.ft.create" if roles != ["prerequisite", "primary"] => violations.push(violation(
            "BUSINESS_OUTPUT_MISMATCH",
            "plan.payload.transactions",
        )),
        "tbc.ft.transfer" | "tbc.stablecoin.transfer"
            if roles.last() != Some(&"primary")
                || roles[..roles.len().saturating_sub(1)]
                    .iter()
                    .any(|role| *role != "maintenance") =>
        {
            violations.push(violation(
                "BUSINESS_OUTPUT_MISMATCH",
                "plan.payload.transactions",
            ));
        }
        "tbc.ft.merge" | "tbc.stablecoin.merge"
            if roles != ["primary"]
                || plan.transactions.first().is_none_or(|transaction| {
                    transaction.transaction_id
                        != if request.intent.intent_type == "tbc.stablecoin.merge" {
                            "stablecoin-merge-1"
                        } else {
                            "ft-merge-1"
                        }
                        || !(2..=MAX_FT_INPUTS_PER_TRANSACTION)
                            .contains(&transaction.inputs.len().saturating_sub(1))
                }) =>
        {
            violations.push(violation(
                "BUSINESS_OUTPUT_MISMATCH",
                "plan.payload.transactions",
            ));
        }
        _ => {}
    }
    if begin_signing(plan).is_err() {
        violations.push(violation("SIGNING_TASK_MISMATCH", "plan.payload.signingTasks"));
    }
    violations
}

fn plan_create(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
) -> Result<PlannedTransfer, EngineError> {
    if material.policy.payload.max_bundle_transactions < 2 {
        return Err(error(
            ErrorCode::InvalidInput,
            "FT V4 creation requires a two-transaction bundle",
            "policy.payload.maxBundleTransactions",
        ));
    }
    let name = required(&request.intent.name, "request.intent.name")?;
    let symbol = required(&request.intent.symbol, "request.intent.symbol")?;
    let decimals = request.intent.decimals.ok_or_else(|| {
        error(ErrorCode::InvalidInput, "FT decimals are required", "request.intent.decimals")
    })?;
    let supply = parse_u128(
        required(&request.intent.initial_supply, "request.intent.initialSupply")?,
        "request.intent.initialSupply",
    )?;
    let supply_slot = u64::try_from(supply).map_err(|_| {
        error(
            ErrorCode::InvalidInput,
            "FT supply exceeds the V4 tape slot width",
            "request.intent.initialSupply",
        )
    })?;
    let account = Address::from_string(&signing.address).map_err(|_| {
        error(ErrorCode::MissingMaterial, "account address is invalid", "snapshot.payload.account")
    })?;
    let fee_rate = fee_rate(material)?;
    let native = funding_candidates(material, signing)?;
    let mut amount = [0u8; 48];
    amount[..8].copy_from_slice(&supply_slot.to_le_bytes());
    let tape = mint_tape_script(&amount, decimals, name, symbol);
    let source_script = mint_source_script(&account);

    for funding in native {
        let source_base = vec![
            TxOut {
                satoshis: FT_MINT_SOURCE_SATOSHIS,
                script_pubkey: source_script.clone(),
            },
            TxOut {
                satoshis: FT_TAPE_SATOSHIS,
                script_pubkey: tape.clone(),
            },
        ];
        let Some((source_outputs, source_fee)) = p2pkh_outputs_with_optional_change(
            &funding,
            source_base,
            &account.script_pubkey(),
            fee_rate,
        )? else {
            continue;
        };
        let source = PlannedTransaction {
            transaction_id: "ft-source-1".to_owned(),
            role: "prerequisite".to_owned(),
            stage: 0,
            depends_on: Vec::new(),
            version: tbc_sdk::TX_VERSION,
            inputs: vec![native_input(&funding, signing)],
            outputs: source_outputs.iter().map(planned_output).collect(),
            lock_time: DEFAULT_LOCK_TIME,
        };
        let source_preview = transaction_from_parts(
            &source,
            vec![funding.preview_txid()],
            &source_outputs,
        );

        let code_descriptor = ft_mint_output_descriptor(
            &source.transaction_id,
            0,
            &signing.address,
            tape.as_bytes().len(),
        );
        let zero_code = tbc_sdk::contracts::ft::scripts::mint_code_script_with_version(
            &"00".repeat(32),
            0,
            &account,
            tape.as_bytes().len(),
            tbc_sdk::contracts::ft::scripts::FtMintVersion::V4,
        )
        .map_err(|_| internal("could not instantiate FT V4 mint preview"))?;
        let mint_base = vec![
            TxOut {
                satoshis: FT_CODE_SATOSHIS,
                script_pubkey: zero_code,
            },
            TxOut {
                satoshis: FT_TAPE_SATOSHIS,
                script_pubkey: tape.clone(),
            },
        ];
        let mint_fee = estimate_p2pkh_fee(1, &mint_base, true, fee_rate)?;
        let mint_change = FT_MINT_SOURCE_SATOSHIS
            .checked_sub(FT_CODE_SATOSHIS + mint_fee)
            .ok_or_else(|| internal("FT mint source cannot fund its child"))?;
        if mint_change < tbc_sdk::SDK_DUST_SAT {
            return Err(internal("FT mint source change is below dust"));
        }
        let mint = PlannedTransaction {
            transaction_id: "ft-mint-1".to_owned(),
            role: "primary".to_owned(),
            stage: 1,
            depends_on: vec![source.transaction_id.clone()],
            version: tbc_sdk::TX_VERSION,
            inputs: vec![PlannedInput {
                previous_transaction_id: source.transaction_id.clone(),
                previous_output_index: 0,
                previous_output_script: hex(source_script.as_bytes()),
                previous_output_satoshis: FT_MINT_SOURCE_SATOSHIS,
                sequence: DEFAULT_SEQUENCE,
                unlocking_script: String::new(),
                signer: signing.clone(),
            }],
            outputs: vec![
                PlannedOutput {
                    satoshis: FT_CODE_SATOSHIS,
                    locking_script: code_descriptor,
                },
                planned_output(&mint_base[1]),
                PlannedOutput {
                    satoshis: mint_change,
                    locking_script: hex(account.script_pubkey().as_bytes()),
                },
            ],
            lock_time: DEFAULT_LOCK_TIME,
        };
        let unsigned_plan = UnsignedPlan {
            evidence_table: Vec::new(),
            transactions: vec![source.clone(), mint.clone()],
        };
        let mint_preview = materialize_unsigned_preview(&mint, &unsigned_plan)?;
        let total_fee = source_fee
            .checked_add(mint_fee)
            .ok_or_else(|| internal("FT creation fee overflow"))?;
        enforce_max_fee(request, total_fee)?;
        return finish_plan(
            request,
            material,
            unsigned_plan,
            vec![source_preview, mint_preview],
            vec![source_fee, mint_fee],
            vec!["FT_MINT_V4".to_owned()],
            vec![AssetFlow {
                kind: "ft".to_owned(),
                direction: "create".to_owned(),
                amount: supply.to_string(),
                contract_id: None,
                from: request.from.clone(),
                to: Some(request.from.clone()),
            }],
        );
    }
    Err(error(
        ErrorCode::InsufficientFunds,
        "no single native UTXO can fund the FT V4 source transaction",
        "snapshot.payload.utxos",
    ))
}

fn plan_transfer(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
) -> Result<PlannedTransfer, EngineError> {
    let contract_id = required(&request.intent.contract_id, "request.intent.contractId")?;
    let recipients = crate::normalize::tbc20_transfer_recipients(request)?.into_iter()
        .map(|recipient| Ok((Address::from_string(recipient.to)
            .map_err(|_| error(ErrorCode::InvalidInput, "invalid FT recipient", "request.intent.to"))?, recipient.amount)))
        .collect::<Result<Vec<_>, EngineError>>()?;
    let amount = checked_sum_u128(recipients.iter().map(|(_, amount)| *amount), "FT amount overflow")?;
    let attached = request
        .intent
        .attached_tbc_amount
        .as_deref()
        .map(|value| parse_decimal_u64(value, "request.intent.attachedTbcAmount"))
        .transpose()?;
    if attached.is_some_and(|value| value < tbc_sdk::SDK_DUST_SAT) {
        return Err(error(
            ErrorCode::InvalidInput,
            "attached TBC output is below the SDK dust threshold",
            "request.intent.attachedTbcAmount",
        ));
    }
    let coin_mode = request.intent.intent_type == "tbc.stablecoin.transfer";
    let classification = if coin_mode { "stablecoin" } else { "ft" };
    let selected_contract_candidates = material
        .snapshot
        .payload
        .utxos
        .iter()
        .filter(|utxo| {
            utxo.classification == classification
                && utxo.contract_id.as_deref() == Some(contract_id)
        })
        .count();
    if selected_contract_candidates > MAX_FT_INPUTS {
        return Err(error(
            ErrorCode::InvalidInput,
            "selected FT contract candidates exceed the 500 input limit",
            "snapshot.payload.utxos",
        ));
    }
    let owner_hash: [u8; 20] = decode_hex(&signing.public_key_hash, "snapshot.payload.account.publicKey")?
        .try_into()
        .map_err(|_| internal("public key hash width is invalid"))?;
    let min_confirmations = parse_decimal_u64(
        &material.policy.payload.min_confirmations,
        "policy.payload.minConfirmations",
    )?;
    let ancestry = if coin_mode {
        prepare_stablecoin_ancestry(material.snapshot, contract_id, &owner_hash, min_confirmations)?
    } else {
        prepare_asset_ancestry(material.snapshot, contract_id, &owner_hash, min_confirmations)?
    };
    validate_metadata(&ancestry.metadata)?;
    let selected = select_asset_inputs(&ancestry.spends, amount)?;
    if selected.len() > MAX_FT_INPUTS {
        return Err(error(
            ErrorCode::InvalidInput,
            "selected FT inputs exceed the source limit",
            "snapshot.payload.utxos",
        ));
    }
    let mut evidence = EvidenceBuilder::default();
    let candidates = selected
        .into_iter()
        .map(|spend| asset_candidate(spend, &mut evidence, ancestry.metadata.is_coin))
        .collect::<Result<Vec<_>, EngineError>>()?;
    let fee_rate = fee_rate(material)?;
    let native = funding_candidates(material, signing)?;
    build_transfer_with_funding(
        request,
        material,
        signing,
        &ancestry.metadata,
        &recipients,
        amount,
        attached,
        candidates,
        native.iter().map(fee_candidate).collect(),
        fee_rate,
        evidence.entries,
    )
}

fn plan_merge(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
) -> Result<PlannedTransfer, EngineError> {
    let contract_id = required(&request.intent.contract_id, "request.intent.contractId")?;
    let coin_mode = request.intent.intent_type == "tbc.stablecoin.merge";
    let classification = if coin_mode { "stablecoin" } else { "ft" };
    let selected_contract_candidates = material
        .snapshot
        .payload
        .utxos
        .iter()
        .filter(|utxo| {
            utxo.classification == classification && utxo.contract_id.as_deref() == Some(contract_id)
        })
        .count();
    if !(2..=MAX_FT_INPUTS_PER_TRANSACTION).contains(&selected_contract_candidates) {
        return Err(error(
            if selected_contract_candidates < 2 {
                ErrorCode::InsufficientFunds
            } else {
                ErrorCode::InvalidInput
            },
            format!(
                "{} merge requires 2..={MAX_FT_INPUTS_PER_TRANSACTION} selected contract inputs",
                if coin_mode { "StableCoin" } else { "FT" }
            ),
            "snapshot.payload.utxos",
        ));
    }
    let owner_hash: [u8; 20] = decode_hex(
        &signing.public_key_hash,
        "snapshot.payload.account.publicKey",
    )?
    .try_into()
    .map_err(|_| internal("public key hash width is invalid"))?;
    let min_confirmations = parse_decimal_u64(
        &material.policy.payload.min_confirmations,
        "policy.payload.minConfirmations",
    )?;
    let ancestry = if coin_mode {
        prepare_stablecoin_ancestry(material.snapshot, contract_id, &owner_hash, min_confirmations)?
    } else {
        prepare_asset_ancestry(material.snapshot, contract_id, &owner_hash, min_confirmations)?
    };
    validate_metadata(&ancestry.metadata)?;
    if !(2..=MAX_FT_INPUTS_PER_TRANSACTION).contains(&ancestry.spends.len()) {
        return Err(error(
            ErrorCode::InvalidAncestry,
            "authenticated FT merge inputs do not match the bounded request material",
            "snapshot.payload.utxos",
        ));
    }
    let mut spends = ancestry.spends;
    spends.sort_by(|left, right| {
        left.balance_raw
            .cmp(&right.balance_raw)
            .then_with(|| left.txid.cmp(&right.txid))
            .then_with(|| left.vout.cmp(&right.vout))
    });
    let total = checked_sum_u128(
        spends.iter().map(|spend| spend.balance_raw),
        "FT merge balance overflow",
    )?;
    let balances = spends
        .iter()
        .map(|spend| spend.balance_raw)
        .collect::<Vec<_>>();
    let (tape_amount, _) = build_tape_amount(total, &balances)
        .map_err(|_| invalid_input("FT merge tape amount is invalid", "snapshot.payload.utxos"))?;
    let mut evidence = EvidenceBuilder::default();
    let candidates = spends
        .into_iter()
        .map(|spend| asset_candidate(spend, &mut evidence, ancestry.metadata.is_coin))
        .collect::<Result<Vec<_>, EngineError>>()?;
    let outputs = merge_outputs(&ancestry.metadata, signing, &tape_amount)?;
    let rate = fee_rate(material)?;
    let mut fees = FeePool::new(
        funding_candidates(material, signing)?
            .iter()
            .map(fee_candidate)
            .collect(),
    )?;
    let built = build_primary_with_funding(
        request,
        if coin_mode { "stablecoin-merge-1" } else { "ft-merge-1" },
        &candidates,
        &mut fees,
        outputs,
        signing,
        rate,
        0,
    )?;
    enforce_max_fee(request, built.fee)?;
    finish_plan(
        request,
        material,
        UnsignedPlan {
            transactions: vec![built.planned],
            evidence_table: evidence.entries,
        },
        vec![built.preview],
        vec![built.fee],
        Vec::new(),
        vec![AssetFlow {
            kind: classification.to_owned(),
            direction: "merge".to_owned(),
            amount: total.to_string(),
            contract_id: None,
            from: request.from.clone(),
            to: Some(request.from.clone()),
        }],
    )
}

#[allow(clippy::too_many_arguments)]
fn build_transfer_with_funding(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
    metadata: &FtMetadata,
    recipients: &[(Address, u128)],
    amount: u128,
    attached: Option<u64>,
    mut candidates: Vec<AssetCandidate>,
    fee_inputs: Vec<FeeCandidate>,
    fee_rate: u64,
    evidence_table: Vec<EvidenceEntry>,
) -> Result<PlannedTransfer, EngineError> {
    let mut transactions = Vec::new();
    let mut previews = Vec::new();
    let mut fees = Vec::new();
    let mut fee_inputs = FeePool::new(fee_inputs)?;
    let mut terminal_fee_changes = Vec::new();
    let balances = candidates.iter().map(|candidate| candidate.balance_raw).collect::<Vec<_>>();
    let total = checked_sum_u128(balances.iter().copied(), "FT balance overflow")?;
    if amount > total {
        return Err(error(
            ErrorCode::InsufficientFunds,
            "FT balance is insufficient",
            "snapshot.payload.utxos",
        ));
    }
    while candidates.len() > MAX_FT_INPUTS_PER_TRANSACTION {
        let next_level_count = candidates.len().div_ceil(MAX_FT_INPUTS_PER_TRANSACTION);
        let terminal_required_change = if next_level_count <= MAX_FT_INPUTS_PER_TRANSACTION {
            let predicted = predict_merge_level(&candidates, metadata, signing, fee_rate)?;
            let predicted_outputs = transfer_outputs(
                metadata,
                signing,
                recipients,
                amount,
                attached,
                &predicted,
            )?;
            Some(minimum_asset_funding(
                &predicted,
                &predicted_outputs,
                signing,
                fee_rate,
                None,
            )?)
        } else {
            None
        };
        let mut source = candidates.into_iter();
        let mut next_level = Vec::new();
        terminal_fee_changes.clear();
        let mut merge_index = 0usize;
        loop {
            let mut chunk = source
                .by_ref()
                .take(MAX_FT_INPUTS_PER_TRANSACTION)
                .collect::<Vec<_>>();
            if chunk.is_empty() {
                break;
            }
            if chunk.len() == 1 {
                next_level.push(chunk.pop().expect("single merge carry"));
                continue;
            }
            let balances = chunk
                .iter()
                .map(|candidate| candidate.balance_raw)
                .collect::<Vec<_>>();
            let total = checked_sum_u128(balances.iter().copied(), "FT merge balance overflow")?;
            let (tape_amount, _) = build_tape_amount(total, &balances).map_err(|_| {
                invalid_input("FT merge tape amount is invalid", "snapshot.payload.utxos")
            })?;
            let required_change = if merge_index == 0 {
                terminal_required_change.unwrap_or(tbc_sdk::SDK_DUST_SAT)
            } else {
                tbc_sdk::SDK_DUST_SAT
            };
            let merge_outputs = merge_outputs(metadata, signing, &tape_amount)?;
            let required_funding = minimum_asset_funding(
                &chunk,
                &merge_outputs,
                signing,
                fee_rate,
                Some(required_change),
            )?;
            let transaction_id = format!("ft-merge-{}", transactions.len() + 1);
            let code = merge_outputs[0].script_pubkey.clone();
            let (_, built) = build_with_smallest_sufficient(
                &mut fee_inputs,
                required_funding,
                "distinct native fee inputs are insufficient for the FT merge DAG",
                |fee_input| build_asset_transaction(
                    &transaction_id,
                    "maintenance",
                    &chunk,
                    fee_input,
                    &merge_outputs,
                    signing,
                    fee_rate,
                    true,
                ),
            )?;
            let proof_references = chunk
                .iter()
                .rev()
                .map(|candidate| FtProofReference {
                    source: candidate.parent_source.clone(),
                    output_index: candidate.previous_output_index,
                })
                .collect::<Vec<_>>();
            let proof_previews = chunk
                .iter()
                .rev()
                .map(|candidate| {
                    (candidate.parent_preview.clone(), candidate.previous_output_index)
                })
                .collect::<Vec<_>>();
            let stage = built.planned.stage;
            let preview_txid = built.preview.txid();
            next_level.push(AssetCandidate {
                previous_transaction_id: transaction_id.clone(),
                previous_output_index: 0,
                satoshis: FT_CODE_SATOSHIS,
                code_script: hex(code.as_bytes()),
                balance_raw: total,
                parent_source: FtTransactionSource::Planned(transaction_id.clone()),
                parent_preview: built.preview.clone(),
            proof_references,
            proof_previews,
            parent_stage: Some(stage),
            sequence: metadata_sequence(metadata),
            lock_time: metadata.lock_time,
            coin_mode: metadata.is_coin,
            });
            terminal_fee_changes.push(FeeCandidate {
                previous_transaction_id: transaction_id,
                previous_output_index: 2,
                satoshis: built.change,
                script: hex(
                    Address::from_string(&signing.address)
                        .unwrap()
                        .script_pubkey()
                        .as_bytes(),
                ),
                preview_txid,
                parent_stage: Some(stage),
            });
            fees.push(built.fee);
            previews.push(built.preview);
            transactions.push(built.planned);
            merge_index += 1;
        }
        candidates = next_level;
    }

    let primary_outputs = transfer_outputs(
        metadata,
        signing,
        recipients,
        amount,
        attached,
        &candidates,
    )?;
    let primary = if transactions.is_empty() {
        build_primary_with_funding(
            request,
            "ft-transfer-1",
            &candidates,
            &mut fee_inputs,
            primary_outputs,
            signing,
            fee_rate,
            checked_sum_u64(fees.iter().copied(), "FT fee overflow")?,
        )?
    } else {
        let fee_input = terminal_fee_changes
            .into_iter()
            .next()
            .ok_or_else(|| internal("FT merge DAG did not retain terminal fee change"))?;
        build_asset_transaction(
            "ft-transfer-1",
            "primary",
            &candidates,
            &fee_input,
            &primary_outputs,
            signing,
            fee_rate,
            false,
        )?
    };
    fees.push(primary.fee);
    previews.push(primary.preview);
    transactions.push(primary.planned);
    if transactions.len() > material.policy.payload.max_bundle_transactions as usize {
        return Err(error(
            ErrorCode::InvalidInput,
            "FT maintenance chain exceeds the policy bundle limit",
            "policy.payload.maxBundleTransactions",
        ));
    }
    let total_fee = checked_sum_u64(fees.iter().copied(), "FT fee overflow")?;
    enforce_max_fee(request, total_fee)?;
    let mut flows = recipients.iter().map(|(recipient, amount)| AssetFlow {
        kind: if metadata.is_coin { "stablecoin" } else { "ft" }.to_owned(),
        direction: "send".to_owned(),
        amount: amount.to_string(),
        contract_id: None,
        from: request.from.clone(),
        to: Some(recipient.to_string()),
    }).collect::<Vec<_>>();
    if let Some(value) = attached {
        flows.push(AssetFlow {
            kind: "native".to_owned(),
            direction: "send".to_owned(),
            amount: value.to_string(),
            contract_id: None,
            from: request.from.clone(),
            to: Some(recipients[0].0.to_string()),
        });
    }
    finish_plan(
        request,
        material,
        UnsignedPlan { transactions, evidence_table },
        previews,
        fees,
        Vec::new(),
        flows,
    )
}

fn transfer_outputs(
    metadata: &FtMetadata,
    signing: &PublicSigningContext,
    recipients: &[(Address, u128)],
    amount: u128,
    attached: Option<u64>,
    candidates: &[AssetCandidate],
) -> Result<Vec<TxOut>, EngineError> {
    let balances = candidates.iter().map(|candidate| candidate.balance_raw).collect::<Vec<_>>();
    let total = checked_sum_u128(balances.iter().copied(), "FT balance overflow")?;
    let amounts = recipients.iter().map(|(_, amount)| *amount).collect::<Vec<_>>();
    let tapes = build_multi_tape_amounts(&amounts, &balances)
        .map_err(|_| error(ErrorCode::InsufficientFunds, "FT balance is insufficient", "snapshot.payload.utxos"))?;
    let base_code = Script::from_bytes(decode_hex(&metadata.code_script, "contract.codeScript")?);
    let base_tape = Script::from_bytes(decode_hex(&metadata.tape_script, "contract.tapeScript")?);
    let mut outputs = Vec::with_capacity(2 * (recipients.len() + 1) + 1);
    for ((recipient, _), tape) in recipients.iter().zip(&tapes) {
        outputs.push(TxOut {
            satoshis: FT_CODE_SATOSHIS,
            script_pubkey: transfer_code_script(&base_code, FtCodeReceiver::Address(recipient.clone()))
                .map_err(|_| invalid_input("FT recipient code script is invalid", "request.intent.to"))?,
        });
        outputs.push(TxOut {
            satoshis: FT_TAPE_SATOSHIS,
            script_pubkey: asset_tape_script(metadata, &base_tape, tape)?,
        });
    }
    if let Some(value) = attached {
        outputs.push(TxOut { satoshis: value, script_pubkey: recipients[0].0.script_pubkey() });
    }
    if amount < total {
        let change_address = Address::from_string(&signing.address).map_err(|_| {
            invalid_input("account address is invalid", "snapshot.payload.account.address")
        })?;
        outputs.push(TxOut {
            satoshis: FT_CODE_SATOSHIS,
            script_pubkey: transfer_code_script(
                &base_code,
                FtCodeReceiver::Address(change_address),
            )
            .map_err(|_| invalid_input("FT change code is invalid", "snapshot.payload.contracts"))?,
        });
        outputs.push(TxOut {
            satoshis: FT_TAPE_SATOSHIS,
            script_pubkey: asset_tape_script(metadata, &base_tape, &tapes[recipients.len()])?,
        });
    }
    Ok(outputs)
}

fn merge_outputs(
    metadata: &FtMetadata,
    signing: &PublicSigningContext,
    tape_amount: &[u8; 48],
) -> Result<Vec<TxOut>, EngineError> {
    let code = transfer_code_script(
        &Script::from_bytes(decode_hex(&metadata.code_script, "contract.codeScript")?),
        FtCodeReceiver::Address(Address::from_string(&signing.address).map_err(|_| {
            invalid_input("account address is invalid", "snapshot.payload.account.address")
        })?),
    )
    .map_err(|_| invalid_input("FT merge code script is invalid", "snapshot.payload.contracts"))?;
    let base_tape = Script::from_bytes(decode_hex(&metadata.tape_script, "contract.tapeScript")?);
    let tape = asset_tape_script(metadata, &base_tape, tape_amount)?;
    Ok(vec![
        TxOut {
            satoshis: FT_CODE_SATOSHIS,
            script_pubkey: code,
        },
        TxOut {
            satoshis: FT_TAPE_SATOSHIS,
            script_pubkey: tape,
        },
    ])
}

fn asset_tape_script(metadata: &FtMetadata, base_tape: &Script, amount: &[u8; 48]) -> Result<Script, EngineError> {
    if metadata.is_coin {
        Ok(tbc_sdk::contracts::stable_coin::scripts::coin_tape_script(
            amount,
            metadata.decimal,
            &metadata.name,
            &metadata.symbol,
            metadata.lock_time,
        ))
    } else {
        transfer_tape_script(base_tape, amount)
            .map_err(|_| invalid_input("FT Tape is invalid", "snapshot.payload.contracts"))
    }
}

fn metadata_sequence(metadata: &FtMetadata) -> u32 {
    if metadata.is_coin { tbc_sdk::contracts::stable_coin::scripts::COIN_FT_SEQUENCE } else { DEFAULT_SEQUENCE }
}

fn minimum_asset_funding(
    assets: &[AssetCandidate],
    base_outputs: &[TxOut],
    signing: &PublicSigningContext,
    fee_rate: u64,
    required_change: Option<u64>,
) -> Result<u64, EngineError> {
    let synthetic_fee = FeeCandidate {
        previous_transaction_id: "00".repeat(32),
        previous_output_index: 0,
        satoshis: 0,
        script: String::new(),
        preview_txid: Txid::from_le_bytes([0; 32]),
        parent_stage: None,
    };
    let mut outputs = base_outputs.to_vec();
    if let Some(required_change) = required_change {
        let change_script = Address::from_string(&signing.address)
            .map_err(|_| invalid_input("account address is invalid", "snapshot.payload.account.address"))?
            .script_pubkey();
        outputs.push(TxOut {
            satoshis: required_change,
            script_pubkey: change_script,
        });
    }
    let preview = transaction_preview(assets, &synthetic_fee, &outputs);
    let fee = estimate_asset_fee(&preview, assets, fee_rate)?;
    let fixed = checked_sum_u64(
        base_outputs.iter().map(|output| output.satoshis),
        "FT output sum overflow",
    )?;
    let required_total = fixed
        .checked_add(fee)
        .and_then(|value| value.checked_add(required_change.unwrap_or(0)))
        .ok_or_else(|| internal("FT funding threshold overflow"))?;
    let asset_total = checked_sum_u64(
        assets.iter().map(|candidate| candidate.satoshis),
        "FT native input sum overflow",
    )?;
    Ok(required_total.saturating_sub(asset_total))
}

fn restore_fee_candidates(
    fee_pool: &mut FeePool,
    candidates: Vec<FeeCandidate>,
) -> Result<(), EngineError> {
    for candidate in candidates {
        fee_pool.restore(candidate)?;
    }
    Ok(())
}

fn build_with_smallest_sufficient<F>(
    fee_pool: &mut FeePool,
    minimum: u64,
    unavailable_message: &'static str,
    mut build: F,
) -> Result<(FeeCandidate, BuiltAssetTransaction), EngineError>
where
    F: FnMut(&FeeCandidate) -> Result<BuiltAssetTransaction, EngineError>,
{
    let mut recoverable = Vec::new();
    loop {
        let Some(candidate) = fee_pool.take_smallest_at_least(minimum) else {
            restore_fee_candidates(fee_pool, recoverable)?;
            return Err(error(
                ErrorCode::InsufficientFunds,
                unavailable_message,
                "snapshot.payload.utxos",
            ));
        };
        match build(&candidate) {
            Ok(built) => {
                restore_fee_candidates(fee_pool, recoverable)?;
                return Ok((candidate, built));
            }
            Err(failure) if failure.code == ErrorCode::InsufficientFunds => {
                recoverable.push(candidate);
            }
            Err(failure) => {
                restore_fee_candidates(fee_pool, recoverable)?;
                fee_pool.restore(candidate)?;
                return Err(failure);
            }
        }
    }
}

fn predict_merge_level(
    candidates: &[AssetCandidate],
    metadata: &FtMetadata,
    signing: &PublicSigningContext,
    fee_rate: u64,
) -> Result<Vec<AssetCandidate>, EngineError> {
    let mut predicted = Vec::with_capacity(candidates.len().div_ceil(MAX_FT_INPUTS_PER_TRANSACTION));
    for (index, chunk) in candidates.chunks(MAX_FT_INPUTS_PER_TRANSACTION).enumerate() {
        if chunk.len() == 1 {
            predicted.push(clone_candidate_for_fee(&chunk[0]));
            continue;
        }
        let balances = chunk.iter().map(|candidate| candidate.balance_raw).collect::<Vec<_>>();
        let total = checked_sum_u128(balances.iter().copied(), "FT merge balance overflow")?;
        let (tape_amount, _) = build_tape_amount(total, &balances)
            .map_err(|_| invalid_input("FT merge tape amount is invalid", "snapshot.payload.utxos"))?;
        let outputs = merge_outputs(metadata, signing, &tape_amount)?;
        let minimum = minimum_asset_funding(
            chunk,
            &outputs,
            signing,
            fee_rate,
            Some(tbc_sdk::SDK_DUST_SAT),
        )?;
        let synthetic_fee = FeeCandidate {
            previous_transaction_id: format!("{:064x}", index + 1),
            previous_output_index: 0,
            satoshis: minimum,
            script: hex(Address::from_string(&signing.address).unwrap().script_pubkey().as_bytes()),
            preview_txid: Txid::from_le_bytes([u8::try_from(index + 1).unwrap_or(1); 32]),
            parent_stage: None,
        };
        let built = build_asset_transaction(
            &format!("predicted-merge-{index}"),
            "maintenance",
            chunk,
            &synthetic_fee,
            &outputs,
            signing,
            fee_rate,
            true,
        )?;
        predicted.push(AssetCandidate {
            previous_transaction_id: format!("predicted-merge-{index}"),
            previous_output_index: 0,
            satoshis: FT_CODE_SATOSHIS,
            code_script: built.planned.outputs[0].locking_script.clone(),
            balance_raw: total,
            parent_source: FtTransactionSource::Planned(format!("predicted-merge-{index}")),
            parent_preview: built.preview,
            proof_references: Vec::new(),
            proof_previews: chunk
                .iter()
                .rev()
                .map(|candidate| {
                    (candidate.parent_preview.clone(), candidate.previous_output_index)
                })
                .collect(),
            parent_stage: Some(built.planned.stage),
            sequence: metadata_sequence(metadata),
            lock_time: metadata.lock_time,
            coin_mode: metadata.is_coin,
        });
    }
    Ok(predicted)
}

fn clone_candidate_for_fee(candidate: &AssetCandidate) -> AssetCandidate {
    AssetCandidate {
        previous_transaction_id: candidate.previous_transaction_id.clone(),
        previous_output_index: candidate.previous_output_index,
        satoshis: candidate.satoshis,
        code_script: candidate.code_script.clone(),
        balance_raw: candidate.balance_raw,
        parent_source: candidate.parent_source.clone(),
        parent_preview: candidate.parent_preview.clone(),
        proof_references: Vec::new(),
        proof_previews: candidate.proof_previews.clone(),
        parent_stage: candidate.parent_stage,
        sequence: candidate.sequence,
        lock_time: candidate.lock_time,
        coin_mode: candidate.coin_mode,
    }
}

#[allow(clippy::too_many_arguments)]
fn build_primary_with_funding(
    request: &CanonicalRequest,
    transaction_id: &str,
    assets: &[AssetCandidate],
    fee_pool: &mut FeePool,
    outputs: Vec<TxOut>,
    signing: &PublicSigningContext,
    fee_rate: u64,
    preceding_fees: u64,
) -> Result<BuiltAssetTransaction, EngineError> {
    let minimum = minimum_asset_funding(assets, &outputs, signing, fee_rate, None)?;
    let (candidate, built) = build_with_smallest_sufficient(
        fee_pool,
        minimum,
        "native fee funds are insufficient",
        |candidate| build_asset_transaction(
            transaction_id,
            "primary",
            assets,
            candidate,
            &outputs,
            signing,
            fee_rate,
            false,
        ),
    )?;
    let total_fee = preceding_fees
        .checked_add(built.fee)
        .ok_or_else(|| internal("FT fee overflow"))?;
    if let Err(cap_error) = enforce_max_fee(request, total_fee) {
        if built.change > 0 {
            return Err(cap_error);
        }
        fee_pool.restore(candidate)?;
        let change_threshold = minimum_asset_funding(
            assets,
            &outputs,
            signing,
            fee_rate,
            Some(tbc_sdk::SDK_DUST_SAT),
        )?;
        let (_, changed) = build_with_smallest_sufficient(
            fee_pool,
            change_threshold,
            "native fee funds are insufficient",
            |candidate| {
                let built = build_asset_transaction(
                    transaction_id,
                    "primary",
                    assets,
                    candidate,
                    &outputs,
                    signing,
                    fee_rate,
                    false,
                )?;
                if built.change == 0 {
                    return Err(error(
                        ErrorCode::InsufficientFunds,
                        "native fee change is below dust",
                        "snapshot.payload.utxos",
                    ));
                }
                Ok(built)
            },
        ).map_err(|failure| {
            if failure.code == ErrorCode::InsufficientFunds { cap_error } else { failure }
        })?;
        enforce_max_fee(
            request,
            preceding_fees
                .checked_add(changed.fee)
                .ok_or_else(|| internal("FT fee overflow"))?,
        )?;
        return Ok(changed);
    }
    Ok(built)
}

#[allow(clippy::too_many_arguments)]
fn build_asset_transaction(
    transaction_id: &str,
    role: &str,
    assets: &[AssetCandidate],
    fee_input: &FeeCandidate,
    base_outputs: &[TxOut],
    signing: &PublicSigningContext,
    fee_rate: u64,
    force_change: bool,
) -> Result<BuiltAssetTransaction, EngineError> {
    if assets.is_empty() || assets.len() > MAX_FT_INPUTS_PER_TRANSACTION {
        return Err(invalid_input("FT transaction input count is invalid", "snapshot.payload.utxos"));
    }
    let stage = assets
        .iter()
        .filter_map(|candidate| candidate.parent_stage)
        .chain(fee_input.parent_stage)
        .max()
        .map_or(0, |stage| stage + 1);
    let mut dependencies = Vec::new();
    for candidate in assets {
        if let FtTransactionSource::Planned(id) = &candidate.parent_source {
            if !dependencies.contains(id) {
                dependencies.push(id.clone());
            }
        }
    }
    if fee_input.parent_stage.is_some() {
        if !dependencies.contains(&fee_input.previous_transaction_id) {
            dependencies.push(fee_input.previous_transaction_id.clone());
        }
    }
    let mut planned_inputs = assets
        .iter()
        .map(|candidate| {
            Ok(PlannedInput {
                previous_transaction_id: candidate.previous_transaction_id.clone(),
                previous_output_index: candidate.previous_output_index,
                previous_output_script: candidate.code_script.clone(),
                previous_output_satoshis: candidate.satoshis,
                sequence: candidate.sequence,
                unlocking_script: ft_unlocking_descriptor(
                    candidate.parent_source.clone(),
                    candidate.proof_references.clone(),
                    candidate.coin_mode,
                )?,
                signer: signing.clone(),
            })
        })
        .collect::<Result<Vec<_>, EngineError>>()?;
    planned_inputs.push(PlannedInput {
        previous_transaction_id: fee_input.previous_transaction_id.clone(),
        previous_output_index: fee_input.previous_output_index,
        previous_output_script: fee_input.script.clone(),
        previous_output_satoshis: fee_input.satoshis,
        sequence: DEFAULT_SEQUENCE,
        unlocking_script: String::new(),
        signer: signing.clone(),
    });
    let input_sum = checked_sum_u64(
        assets.iter().map(|candidate| candidate.satoshis).chain(std::iter::once(fee_input.satoshis)),
        "FT native input sum overflow",
    )?;
    let fixed_sum = checked_sum_u64(base_outputs.iter().map(|output| output.satoshis), "FT output sum overflow")?;
    let account_script = Address::from_string(&signing.address).unwrap().script_pubkey();
    let mut preview_outputs = base_outputs.to_vec();
    preview_outputs.push(TxOut { satoshis: 1, script_pubkey: account_script.clone() });
    let preview_with_change = transaction_preview(assets, fee_input, &preview_outputs);
    let fee_with_change = estimate_asset_fee(&preview_with_change, assets, fee_rate)?;
    let remainder = input_sum.checked_sub(fixed_sum + fee_with_change);
    let (outputs, fee, change) = if let Some(change) = remainder.filter(|value| *value >= tbc_sdk::SDK_DUST_SAT) {
        let mut outputs = base_outputs.to_vec();
        outputs.push(TxOut { satoshis: change, script_pubkey: account_script });
        (outputs, fee_with_change, change)
    } else {
        if force_change {
            return Err(error(
                ErrorCode::InsufficientFunds,
                "FT maintenance fee change is insufficient",
                "snapshot.payload.utxos",
            ));
        }
        let preview_without = transaction_preview(assets, fee_input, base_outputs);
        let minimum_fee = estimate_asset_fee(&preview_without, assets, fee_rate)?;
        let paid = input_sum.checked_sub(fixed_sum).ok_or_else(|| {
            error(ErrorCode::InsufficientFunds, "native fee funds are insufficient", "snapshot.payload.utxos")
        })?;
        if paid < minimum_fee {
            return Err(error(
                ErrorCode::InsufficientFunds,
                "native fee funds are insufficient",
                "snapshot.payload.utxos",
            ));
        }
        (base_outputs.to_vec(), paid, 0)
    };
    let planned = PlannedTransaction {
        transaction_id: transaction_id.to_owned(),
        role: role.to_owned(),
        stage,
        depends_on: dependencies,
        version: tbc_sdk::TX_VERSION,
        inputs: planned_inputs,
        outputs: outputs.iter().map(planned_output).collect(),
        lock_time: assets.iter().map(|candidate| candidate.lock_time).max().unwrap_or(DEFAULT_LOCK_TIME),
    };
    let preview = transaction_preview(assets, fee_input, &outputs);
    Ok(BuiltAssetTransaction { planned, preview, fee, change })
}

fn estimate_asset_fee(
    transaction: &Transaction,
    assets: &[AssetCandidate],
    fee_rate: u64,
) -> Result<u64, EngineError> {
    let mut headroom = MAX_P2PKH_SCRIPT_SIG_BYTES as u64;
    for (index, candidate) in assets.iter().enumerate() {
        let mut script = current_tx_data(transaction, index)
            .map_err(|_| internal("could not estimate FT current transaction data"))?;
        script.push(0x57);
        for (proof, output_index) in &candidate.proof_previews {
            script.extend_from_slice(
                &pre_pre_tx_data(proof, *output_index as usize)
                    .map_err(|_| internal("could not estimate FT grandparent proof"))?,
            );
        }
        push_len(&mut script, 72);
        script.resize(script.len() + 72, 0);
        push_len(&mut script, 33);
        script.resize(script.len() + 33, 0);
        if candidate.coin_mode {
            script.push(tbc_sdk::script::opcodes::OP_0);
        }
        script.extend_from_slice(
            &pre_tx_data(&candidate.parent_preview, candidate.previous_output_index as usize)
                .map_err(|_| internal("could not estimate FT parent data"))?,
        );
        let growth = script
            .len()
            .checked_add(compact_size_len(script.len()))
            .and_then(|value| value.checked_sub(1))
            .ok_or_else(|| internal("FT signature size overflow"))?;
        headroom = headroom
            .checked_add(u64::try_from(growth).map_err(|_| internal("FT signature size overflow"))?)
            .ok_or_else(|| internal("FT signature size overflow"))?;
    }
    conservative_transaction_fee(transaction.serialize().len(), headroom, fee_rate)
}

fn transaction_preview(
    assets: &[AssetCandidate],
    fee: &FeeCandidate,
    outputs: &[TxOut],
) -> Transaction {
    Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: assets
            .iter()
            .map(|candidate| TxIn {
                previous_output: OutPoint { txid: candidate.parent_preview.txid(), vout: candidate.previous_output_index },
                script_sig: Script::empty(),
                sequence: candidate.sequence,
            })
            .chain(std::iter::once(TxIn::new(OutPoint {
                txid: fee.preview_txid,
                vout: fee.previous_output_index,
            })))
            .collect(),
        outputs: outputs.to_vec(),
        lock_time: assets.iter().map(|candidate| candidate.lock_time).max().unwrap_or(DEFAULT_LOCK_TIME),
    }
}

fn asset_candidate(
    spend: AssetSpend,
    evidence: &mut EvidenceBuilder,
    coin_mode: bool,
) -> Result<AssetCandidate, EngineError> {
    let proof_previews = spend
        .proof_references
        .iter()
        .filter_map(|reference| match &reference.source {
            FtTransactionSource::Raw(raw) => Transaction::from_hex(raw)
                .ok()
                .map(|transaction| (transaction, reference.output_index)),
            FtTransactionSource::Planned(_) => None,
            FtTransactionSource::Evidence(_) => None,
        })
        .collect();
    let parent_source = evidence.register(spend.parent_raw)?;
    let code_script = match parent_source {
        FtTransactionSource::Evidence(index) => ft_evidence_output_descriptor(index, spend.vout),
        _ => return Err(internal("initial FT parent was not entered in the evidence table")),
    };
    let proof_references = spend
        .proof_references
        .into_iter()
        .map(|reference| {
            let source = match reference.source {
                FtTransactionSource::Raw(raw) => evidence.register(raw)?,
                source => source,
            };
            Ok(FtProofReference {
                source,
                output_index: reference.output_index,
            })
        })
        .collect::<Result<Vec<_>, EngineError>>()?;
    Ok(AssetCandidate {
        previous_transaction_id: spend.txid,
        previous_output_index: spend.vout,
        satoshis: spend.satoshis,
        code_script,
        balance_raw: spend.balance_raw,
        parent_source,
        parent_preview: spend.parent,
        proof_references,
        proof_previews,
        parent_stage: None,
        sequence: spend.sequence,
        lock_time: spend.lock_time,
        coin_mode,
    })
}

fn select_asset_inputs(
    spends: &[AssetSpend],
    amount: u128,
) -> Result<Vec<AssetSpend>, EngineError> {
    if let Some(single) = spends
        .iter()
        .filter(|spend| spend.balance_raw >= amount)
        .min_by(|left, right| {
            left.balance_raw
                .cmp(&right.balance_raw)
                .then_with(|| left.txid.cmp(&right.txid))
                .then_with(|| left.vout.cmp(&right.vout))
        })
    {
        return Ok(vec![single.clone()]);
    }
    let mut ordered = spends.to_vec();
    ordered.sort_by(|left, right| {
        right
            .balance_raw
            .cmp(&left.balance_raw)
            .then_with(|| left.txid.cmp(&right.txid))
            .then_with(|| left.vout.cmp(&right.vout))
    });
    let mut sum = 0u128;
    let mut selected = Vec::new();
    for spend in ordered {
        sum = sum.checked_add(spend.balance_raw).ok_or_else(|| {
            invalid_input("FT balance overflow", "snapshot.payload.utxos")
        })?;
        selected.push(spend);
        if sum >= amount {
            return Ok(selected);
        }
    }
    Err(error(
        ErrorCode::InsufficientFunds,
        "FT token balance is insufficient",
        "snapshot.payload.utxos",
    ))
}

pub(crate) fn funding_candidates(
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
) -> Result<Vec<NativeFundingUtxo>, EngineError> {
    if let Some(planned) = material.planned_native {
        // Its external inputs were checked against the original snapshot and
        // confirmation policy. This output is signed in a preceding plan stage,
        // not an allegedly confirmed UTXO received from an API.
        return Ok(vec![planned.clone()]);
    }
    let minimum = parse_decimal_u64(
        &material.policy.payload.min_confirmations,
        "policy.payload.minConfirmations",
    )?;
    let script = hex(Address::from_string(&signing.address).unwrap().script_pubkey().as_bytes());
    native_funding_candidates(material.snapshot, &script, minimum)
}

fn fee_candidate(funding: &NativeFundingUtxo) -> FeeCandidate {
    FeeCandidate {
        previous_transaction_id: funding.txid.clone(),
        previous_output_index: funding.vout,
        satoshis: funding.satoshis,
        script: funding.script.clone(),
        preview_txid: funding.preview_txid(),
        parent_stage: None,
    }
}

trait FundingTxid {
    fn preview_txid(&self) -> Txid;
}

impl FundingTxid for NativeFundingUtxo {
    fn preview_txid(&self) -> Txid {
        self.txid.parse().expect("validated native funding txid")
    }
}

pub(crate) fn native_input(funding: &NativeFundingUtxo, signing: &PublicSigningContext) -> PlannedInput {
    PlannedInput {
        previous_transaction_id: funding.txid.clone(),
        previous_output_index: funding.vout,
        previous_output_script: funding.script.clone(),
        previous_output_satoshis: funding.satoshis,
        sequence: DEFAULT_SEQUENCE,
        unlocking_script: String::new(),
        signer: signing.clone(),
    }
}

pub(crate) fn p2pkh_outputs_with_optional_change(
    funding: &NativeFundingUtxo,
    base: Vec<TxOut>,
    change_script: &Script,
    fee_rate: u64,
) -> Result<Option<(Vec<TxOut>, u64)>, EngineError> {
    let fixed = checked_sum_u64(base.iter().map(|output| output.satoshis), "output sum overflow")?;
    let fee_with = estimate_p2pkh_fee(1, &base, true, fee_rate)?;
    if let Some(change) = funding
        .satoshis
        .checked_sub(fixed + fee_with)
        .filter(|value| *value >= tbc_sdk::SDK_DUST_SAT)
    {
        let mut outputs = base;
        outputs.push(TxOut { satoshis: change, script_pubkey: change_script.clone() });
        return Ok(Some((outputs, fee_with)));
    }
    let minimum = estimate_p2pkh_fee(1, &base, false, fee_rate)?;
    let Some(paid) = funding.satoshis.checked_sub(fixed) else {
        return Ok(None);
    };
    if paid < minimum {
        return Ok(None);
    }
    Ok(Some((base, paid)))
}

pub(crate) fn estimate_p2pkh_fee(
    inputs: usize,
    outputs: &[TxOut],
    include_change: bool,
    fee_rate: u64,
) -> Result<u64, EngineError> {
    let output_count = outputs.len() + usize::from(include_change);
    let size = 4usize
        .checked_add(compact_size_len(inputs))
        .and_then(|value| value.checked_add(inputs.checked_mul(41)?))
        .and_then(|value| value.checked_add(compact_size_len(output_count)))
        .and_then(|value| {
            outputs.iter().try_fold(value, |sum, output| {
                sum.checked_add(8 + compact_size_len(output.script_pubkey.as_bytes().len()) + output.script_pubkey.as_bytes().len())
            })
        })
        .and_then(|value| if include_change { value.checked_add(34) } else { Some(value) })
        .and_then(|value| value.checked_add(4))
        .ok_or_else(|| internal("FT fee size overflow"))?;
    let headroom = inputs
        .checked_mul(MAX_P2PKH_SCRIPT_SIG_BYTES)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| internal("FT signature headroom overflow"))?;
    conservative_transaction_fee(size, headroom, fee_rate)
}

pub(crate) fn finish_plan(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    mut unsigned_plan: UnsignedPlan,
    mut previews: Vec<Transaction>,
    mut fees: Vec<u64>,
    warnings: Vec<String>,
    flows: Vec<AssetFlow>,
) -> Result<PlannedTransfer, EngineError> {
    let rate = fee_rate(material)?;
    let account_change_script = Address::from_string(&material.snapshot.payload.account.address)
        .map_err(|_| internal("account address is invalid while reconciling fees"))?
        .script_pubkey();
    let changed_transactions = reconcile_plan_fee_envelopes(
        &mut unsigned_plan,
        &mut fees,
        rate,
        &hex(account_change_script.as_bytes()),
    )?;
    if previews.len() != unsigned_plan.transactions.len() {
        return Err(internal("unsigned preview count does not match the plan"));
    }
    for index in 0..unsigned_plan.transactions.len() {
        if !changed_transactions[index] {
            continue;
        }
        let planned = &unsigned_plan.transactions[index];
        let preview = &mut previews[index];
        if preview.outputs.len() < planned.outputs.len() {
            return Err(internal("unsigned preview is missing planned outputs"));
        }
        preview.outputs.truncate(planned.outputs.len());
        for (output, planned_output) in preview.outputs.iter_mut().zip(&planned.outputs) {
            output.satoshis = planned_output.satoshis;
        }
    }
    finish_profile_plan(request, material, unsigned_plan, previews, fees, warnings, flows)
}

/// Shared binding and preview assembly after a protocol-specific fee policy has
/// been applied. New contract profiles must not inherit the legacy dust policy.
pub(crate) fn finish_profile_plan(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    unsigned_plan: UnsignedPlan,
    previews: Vec<Transaction>,
    fees: Vec<u64>,
    warnings: Vec<String>,
    mut flows: Vec<AssetFlow>,
) -> Result<PlannedTransfer, EngineError> {
    if previews.len() != unsigned_plan.transactions.len() || fees.len() != previews.len() {
        return Err(internal("preview and fee counts must match the plan"));
    }
    let signing_accounts = crate::signing_wire::SigningAccounts::resolve(request, &material.snapshot.payload)?;
    signing_accounts.authorize_plan(&unsigned_plan)?;
    let signing_stage = begin_signing(&unsigned_plan).map_err(|source| {
        error(
            source.code,
            format!("final fee envelope signing plan is invalid: {}", source.message),
            source.path.as_deref().unwrap_or("plan"),
        )
    })?;
    let templates = unsigned_plan
        .transactions
        .iter()
        .zip(&previews)
        .zip(&fees)
        .map(|((transaction, preview), fee)| TransactionTemplate {
            id: transaction.transaction_id.clone(),
            role: transaction.role.clone(),
            depends_on: transaction.depends_on.clone(),
            unsigned_transaction: preview.to_hex(),
            deferred_inputs: {
                let edges: Vec<_> = transaction.inputs.iter().enumerate()
                    .filter(|(_, input)| transaction.depends_on.contains(&input.previous_transaction_id))
                    .map(|(index, input)| crate::model::DeferredTransactionInput {
                        input_index: index as u32,
                        source_transaction_id: input.previous_transaction_id.clone(),
                        source_output_index: input.previous_output_index,
                    }).collect();
                (edges.len() != transaction.depends_on.len()).then_some(edges)
            },
            template_hash: hex(&Sha256::digest(preview.serialize())),
            fee: fee.to_string(),
            output_review: crate::output_review::outputs(preview),
        })
        .collect::<Vec<_>>();
    let signing_tasks = signing_accounts.tasks(&signing_stage)?;
    let total_fee = checked_sum_u64(fees.iter().copied(), "FT total fee overflow")?;
    enforce_max_fee(request, total_fee)?;
    flows.push(AssetFlow {
        kind: "native".to_owned(),
        direction: "fee".to_owned(),
        amount: total_fee.to_string(),
        contract_id: None,
        from: request.from.clone(),
        to: None,
    });
    let payload = ExecutionPlanPayload {
        version: WIRE_VERSION.to_owned(),
        request_hash: canonical_hash(request)?,
        snapshot_hash: material.snapshot.snapshot_hash.clone(),
        policy_hash: material.policy.policy_hash.clone(),
        chain_id: request.chain_id.clone(),
        account_id: material.snapshot.payload.account.account_id.clone(),
        expires_at: earliest_expiry(request, material)?,
        transactions: templates,
        signing_tasks,
        preview: TransactionPreview {
            operation_kind: "transaction".to_owned(),
            contract_execution: None,
            asset_flows: flows,
            total_fee: total_fee.to_string(),
            transaction_count: unsigned_plan.transactions.len() as u32,
            signing_task_count: crate::signing::planned_signing_task_count(&unsigned_plan, &signing_stage),
            signing_roles: signing_accounts.preview(),
            warnings,
            irreversible: true,
        },
    };
    let plan_hash = canonical_hash(&payload)?;
    Ok(PlannedTransfer {
        resolved_request: None,
        result: PlanResult {
            plan: ExecutionPlan { payload, plan_hash },
        },
        unsigned_plan,
        signing_stage,
        output_roles: Vec::new(),
        business_plan: None,
    })
}

pub(crate) fn transaction_from_parts(
    planned: &PlannedTransaction,
    txids: Vec<Txid>,
    outputs: &[TxOut],
) -> Transaction {
    Transaction {
        version: planned.version,
        inputs: planned
            .inputs
            .iter()
            .zip(txids)
            .map(|(input, txid)| TxIn {
                previous_output: OutPoint {
                    txid,
                    vout: input.previous_output_index,
                },
                script_sig: Script::empty(),
                sequence: input.sequence,
            })
            .collect(),
        outputs: outputs.to_vec(),
        lock_time: planned.lock_time,
    }
}

pub(crate) fn planned_output(output: &TxOut) -> PlannedOutput {
    PlannedOutput {
        satoshis: output.satoshis,
        locking_script: hex(output.script_pubkey.as_bytes()),
    }
}

pub(crate) fn validate_material_identity(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
) -> Result<(), EngineError> {
    let snapshot = &material.snapshot.payload;
    if snapshot.chain_id != request.chain_id
        || snapshot.account.chain_id != request.chain_id
        || snapshot.account.address != request.from
    {
        return Err(error(
            ErrorCode::MissingMaterial,
            "snapshot account does not match the request",
            "snapshot.payload.account",
        ));
    }
    Ok(())
}

pub(crate) fn validate_policy(material: &WalletMaterial<'_>) -> Result<(), EngineError> {
    let policy = &material.policy.payload;
    validate_version(&policy.version, "policy.payload.version")?;
    if policy.chain_id != material.snapshot.payload.chain_id || policy.sighash_type != DEFAULT_SIGHASH {
        return Err(invalid_input("policy chain or sighash is incompatible", "policy.payload"));
    }
    if parse_decimal_u64(&policy.dust_threshold, "policy.payload.dustThreshold")?
        != tbc_sdk::SDK_DUST_SAT
    {
        return Err(invalid_input("policy dust threshold differs from the SDK", "policy.payload.dustThreshold"));
    }
    if fee_rate(material)? == 0 {
        return Err(invalid_input("fee rate must be positive", "policy.payload.feeRateSatPerKb"));
    }
    Ok(())
}

fn validate_metadata(metadata: &FtMetadata) -> Result<(), EngineError> {
    if metadata.version == 0
        || metadata.decimal > 18
        || !valid_existing_metadata_text(&metadata.name)
        || !valid_existing_metadata_text(&metadata.symbol)
        || metadata.total_supply_raw == 0
        || metadata.total_supply_raw > 10u128.pow(18)
    {
        return Err(error(
            ErrorCode::InvalidAncestry,
            "authenticated FT metadata is outside protocol bounds",
            "snapshot.payload.contracts",
        ));
    }
    Ok(())
}

pub(crate) fn enforce_max_fee(request: &CanonicalRequest, fee: u64) -> Result<(), EngineError> {
    if let Some(maximum) = request
        .constraints
        .as_ref()
        .and_then(|constraints| constraints.max_fee.as_deref())
    {
        if fee > parse_decimal_u64(maximum, "request.constraints.maxFee")? {
            return Err(error(
                ErrorCode::FeeCapExceeded,
                "planned FT fee exceeds the request maximum",
                "request.constraints.maxFee",
            ));
        }
    }
    Ok(())
}

pub(crate) fn fee_rate(material: &WalletMaterial<'_>) -> Result<u64, EngineError> {
    parse_decimal_u64(
        &material.policy.payload.fee_rate_sat_per_kb,
        "policy.payload.feeRateSatPerKb",
    )
}

fn earliest_expiry(request: &CanonicalRequest, material: &WalletMaterial<'_>) -> Result<String, EngineError> {
    Ok(crate::plan::earliest_canonical_timestamp([
        request
            .constraints
            .as_ref()
            .and_then(|constraints| constraints.expires_at.as_deref()),
        Some(material.snapshot.payload.expires_at.as_str()),
        Some(material.policy.payload.expires_at.as_str()),
    ]
    .into_iter()
    .flatten())?.to_owned())
}

pub(crate) fn required<'a>(value: &'a Option<String>, path: &str) -> Result<&'a str, EngineError> {
    value.as_deref().ok_or_else(|| invalid_input("required intent field is missing", path))
}

fn parse_u128(value: &str, path: &str) -> Result<u128, EngineError> {
    if value.is_empty()
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err(invalid_input("value must be a canonical unsigned decimal integer", path));
    }
    value.parse().map_err(|_| invalid_input("value exceeds uint128", path))
}

fn valid_existing_metadata_text(value: &str) -> bool {
    // Authenticated on-chain text is not a new-token identifier policy. Preserve
    // UTF-8 bytes and case; retain a resource bound without imposing an alphabet.
    !value.is_empty() && value.len() <= MAX_FT_METADATA_BYTES
}

#[cfg(test)]
mod existing_metadata_text_tests {
    use super::{MAX_FT_METADATA_BYTES, valid_existing_metadata_text};

    #[test]
    fn authenticated_names_and_symbols_allow_lowercase_utf8_and_punctuation() {
        for value in ["tws", "TwS", "tws-1", "tws.token", "name with spaces", "\u{5e01}", "\u{1fa99}"] {
            assert!(valid_existing_metadata_text(value), "authenticated UTF-8 text must not require uppercase identifiers");
        }
        assert!(valid_existing_metadata_text(&"a".repeat(65)), "existing names must not inherit the new-token character limit");
    }

    #[test]
    fn authenticated_text_retains_nonempty_and_utf8_byte_resource_bounds() {
        assert!(!valid_existing_metadata_text(""));
        assert!(valid_existing_metadata_text(&"a".repeat(MAX_FT_METADATA_BYTES)));
        assert!(!valid_existing_metadata_text(&"a".repeat(MAX_FT_METADATA_BYTES + 1)));
        assert!(!valid_existing_metadata_text(&"\u{1fa99}".repeat(MAX_FT_METADATA_BYTES)));
    }
}

fn checked_sum_u128(
    values: impl IntoIterator<Item = u128>,
    message: &str,
) -> Result<u128, EngineError> {
    values.into_iter().try_fold(0u128, |sum, value| {
        sum.checked_add(value).ok_or_else(|| internal(message))
    })
}

pub(crate) fn checked_sum_u64(
    values: impl IntoIterator<Item = u64>,
    message: &str,
) -> Result<u64, EngineError> {
    values.into_iter().try_fold(0u64, |sum, value| {
        sum.checked_add(value).ok_or_else(|| internal(message))
    })
}

fn compact_size_len(value: usize) -> usize {
    match value {
        0..=0xfc => 1,
        0xfd..=0xffff => 3,
        0x1_0000..=0xffff_ffff => 5,
        _ => 9,
    }
}

fn push_len(output: &mut Vec<u8>, length: usize) {
    if length <= 75 {
        output.push(length as u8);
    } else {
        output.extend_from_slice(&[0x4c, length as u8]);
    }
}

pub(crate) fn decode_hex(value: &str, path: &str) -> Result<Vec<u8>, EngineError> {
    if !value.len().is_multiple_of(2) {
        return Err(invalid_input("value is not hexadecimal", path));
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let nibble = |byte| match byte {
                b'0'..=b'9' => Some(byte - b'0'),
                b'a'..=b'f' => Some(byte - b'a' + 10),
                b'A'..=b'F' => Some(byte - b'A' + 10),
                _ => None,
            };
            Ok((nibble(pair[0]).ok_or_else(|| invalid_input("value is not hexadecimal", path))? << 4)
                | nibble(pair[1]).ok_or_else(|| invalid_input("value is not hexadecimal", path))?)
        })
        .collect()
}

pub(crate) fn invalid_input(message: &str, path: &str) -> EngineError {
    error(ErrorCode::InvalidInput, message, path)
}

pub(crate) fn internal(message: &str) -> EngineError {
    EngineError {
        code: ErrorCode::InternalInvariant,
        message: message.to_owned(),
        path: None,
    }
}

fn violation(code: &str, path: &str) -> Violation {
    Violation {
        code: code.to_owned(),
        path: Some(path.to_owned()),
    }
}
