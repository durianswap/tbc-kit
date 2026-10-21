use std::collections::{BTreeMap, BTreeSet};

use sha2::{Digest, Sha256};
use tbc_sdk::{
    Address, DEFAULT_SEQUENCE, DEFAULT_SIGHASH, OutPoint, PublicKey, Transaction, TxIn, TxOut,
    Txid, script::Script,
};

use crate::fee_envelope::{fee_for_size, p2pkh_max_signed_size};
use crate::model::{
    AssetFlow, CanonicalRequest, ExecutionPlan, ExecutionPlanPayload, OutputRole, PlanResult,
    PlannedTransfer, TransactionPreview, TransactionTemplate, Violation,
    WIRE_VERSION, WalletMaterial, error,
};
use crate::normalize::{canonical_hash, hex, parse_decimal_u64, validate_request, validate_version};
use crate::signing::{
    PlannedInput, PlannedOutput, PlannedTransaction, PublicSigningContext, UnsignedPlan,
    begin_signing,
};
use crate::{EngineError, ErrorCode};

const MAX_TBC_INPUTS: usize = 1_000;
// Match tbc-contract API.mergeUTXO's bounded single-page consolidation.
pub(crate) const MAX_TBC_MERGE_INPUTS: usize = 500;

#[derive(Clone)]
struct Spendable {
    txid: String,
    vout: u32,
    satoshis: u64,
    script: String,
}

struct FundingSelection {
    selected: Vec<Spendable>,
    paid_fee: u64,
    change_amount: Option<u64>,
}

pub(crate) fn plan_tbc_transfer(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
) -> Result<PlannedTransfer, EngineError> {
    validate_request(request)?;
    validate_material_identity(request, material)?;
    let policy = &material.policy.payload;
    validate_version(&policy.version, "policy.payload.version")?;
    if policy.chain_id != request.chain_id || policy.sighash_type != DEFAULT_SIGHASH {
        return Err(error(
            ErrorCode::InvalidInput,
            "policy chain or sighash does not match the request",
            "policy.payload",
        ));
    }
    let dust = parse_decimal_u64(&policy.dust_threshold, "policy.payload.dustThreshold")?;
    if dust != tbc_sdk::SDK_DUST_SAT {
        return Err(error(
            ErrorCode::InvalidInput,
            format!("TBC dust threshold must be {} satoshis", tbc_sdk::SDK_DUST_SAT),
            "policy.payload.dustThreshold",
        ));
    }
    let fee_rate = parse_decimal_u64(
        &policy.fee_rate_sat_per_kb,
        "policy.payload.feeRateSatPerKb",
    )?;
    if fee_rate == 0 {
        return Err(error(
            ErrorCode::InvalidInput,
            "fee rate must be greater than zero",
            "policy.payload.feeRateSatPerKb",
        ));
    }
    let minimum_confirmations = parse_decimal_u64(
        &policy.min_confirmations,
        "policy.payload.minConfirmations",
    )?;
    if minimum_confirmations > u32::MAX as u64 {
        return Err(error(
            ErrorCode::InvalidInput,
            "minimum confirmations exceeds uint32",
            "policy.payload.minConfirmations",
        ));
    }
    let amount = parse_decimal_u64(
        request.intent.amount.as_deref().ok_or_else(|| {
            error(
                ErrorCode::InvalidInput,
                "native transfer amount is missing",
                "request.intent.amount",
            )
        })?,
        "request.intent.amount",
    )?;
    validate_amount_limit(amount, policy)?;

    let account = &material.snapshot.payload.account;
    let public_key_bytes = decode_hex(&account.public_key, "snapshot.payload.account.publicKey")?;
    let public_key = PublicKey::from_slice(&public_key_bytes).map_err(|_| {
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
    let account_script = hex(public_key.address().script_pubkey().as_bytes());
    let mut spendable = validate_wallet_utxos(material, &account_script, minimum_confirmations)?;
    if let Some(requested) = request
        .constraints
        .as_ref()
        .and_then(|constraints| constraints.input_outpoints.as_ref())
    {
        let allowed = requested
            .iter()
            .map(|outpoint| (outpoint.txid.as_str(), outpoint.vout))
            .collect::<BTreeSet<_>>();
        spendable.retain(|candidate| allowed.contains(&(candidate.txid.as_str(), candidate.vout)));
        if spendable.len() != allowed.len() {
            return Err(error(
                ErrorCode::MissingMaterial,
                "one or more explicit native TBC input outpoints are unavailable",
                "request.constraints.inputOutpoints",
            ));
        }
    }
    if spendable.is_empty() {
        return Err(error(
            ErrorCode::InsufficientFunds,
            "no spendable native TBC inputs are available",
            "snapshot.payload.utxos",
        ));
    }

    let recipient = request.intent.to.as_deref().ok_or_else(|| {
        error(
            ErrorCode::InvalidInput,
            "native transfer recipient is missing",
            "request.intent.to",
        )
    })?;
    let recipient_script = Address::from_string(recipient)
        .map_err(|_| error(ErrorCode::InvalidInput, "invalid recipient address", "request.intent.to"))?
        .script_pubkey();
    let funding = select_for_fee_envelope(&spendable, amount, fee_rate)?;
    let selected = funding.selected;
    let input_sum = checked_sum(selected.iter().map(|input| input.satoshis), "input amount overflow")?;
    let paid_fee = funding.paid_fee;
    let change_amount = funding.change_amount;
    let accounted = amount
        .checked_add(paid_fee)
        .and_then(|value| value.checked_add(change_amount.unwrap_or(0)))
        .ok_or_else(|| error(ErrorCode::InternalInvariant, "fee accounting overflow", "plan"))?;
    if accounted != input_sum {
        return Err(error(ErrorCode::InternalInvariant, "fee accounting mismatch", "plan"));
    }
    if let Some(max_fee) = request
        .constraints
        .as_ref()
        .and_then(|constraints| constraints.max_fee.as_ref())
    {
        let max_fee = parse_decimal_u64(max_fee, "request.constraints.maxFee")?;
        if paid_fee > max_fee {
            return Err(error(
                ErrorCode::FeeCapExceeded,
                "planned fee exceeds the request maximum",
                "request.constraints.maxFee",
            ));
        }
    }

    let signer = PublicSigningContext {
        address: account.address.clone(),
        public_key: hex(&public_key.to_bytes()),
        public_key_hash: hex(&public_key.hash160()),
    };
    let planned_inputs = selected
        .iter()
        .map(|input| PlannedInput {
            previous_transaction_id: input.txid.clone(),
            previous_output_index: input.vout,
            previous_output_script: input.script.clone(),
            previous_output_satoshis: input.satoshis,
            sequence: DEFAULT_SEQUENCE,
            unlocking_script: String::new(),
            signer: signer.clone(),
        })
        .collect::<Vec<_>>();
    let mut planned_outputs = vec![PlannedOutput {
        satoshis: amount,
        locking_script: hex(recipient_script.as_bytes()),
    }];
    let mut output_roles = vec![OutputRole::Recipient];
    if let Some(change_amount) = change_amount {
        planned_outputs.push(PlannedOutput {
            satoshis: change_amount,
            locking_script: account_script.clone(),
        });
        output_roles.push(OutputRole::Change);
    }
    let planned_transaction = PlannedTransaction {
        transaction_id: "tx-1".to_owned(),
        role: "primary".to_owned(),
        stage: 0,
        depends_on: Vec::new(),
        version: tbc_sdk::TX_VERSION,
        inputs: planned_inputs,
        outputs: planned_outputs,
        lock_time: tbc_sdk::DEFAULT_LOCK_TIME,
    };
    let unsigned_plan = UnsignedPlan {
        evidence_table: Vec::new(),
        transactions: vec![planned_transaction.clone()],
    };
    let signing_stage = begin_signing(&unsigned_plan)?;
    let unsigned_transaction = materialize(&planned_transaction)?;
    let unsigned_bytes = unsigned_transaction.serialize();
    let signing_tasks = crate::signing_wire::public_signing_tasks(&signing_stage, account)?;
    let request_hash = canonical_hash(request)?;
    let expires_at = earliest_expiry(request, material)?;
    let payload = ExecutionPlanPayload {
        version: WIRE_VERSION.to_owned(),
        request_hash,
        snapshot_hash: material.snapshot.snapshot_hash.clone(),
        policy_hash: material.policy.policy_hash.clone(),
        chain_id: request.chain_id.clone(),
        account_id: account.account_id.clone(),
        expires_at,
        transactions: vec![TransactionTemplate {
            id: "tx-1".to_owned(),
            role: "primary".to_owned(),
            depends_on: Vec::new(),
            unsigned_transaction: unsigned_transaction.to_hex(),
            deferred_inputs: None,
            template_hash: hex(&Sha256::digest(unsigned_bytes)),
            fee: paid_fee.to_string(),
            output_review: crate::output_review::outputs(&unsigned_transaction),
        }],
        signing_tasks,
        preview: TransactionPreview {
            operation_kind: "transaction".to_owned(),
            contract_execution: None,
            asset_flows: vec![
                AssetFlow {
                    kind: "native".to_owned(),
                    direction: "send".to_owned(),
                    amount: amount.to_string(),
                    contract_id: None,
                    from: request.from.clone(),
                    to: Some(recipient.to_owned()),
                },
                AssetFlow {
                    kind: "native".to_owned(),
                    direction: "fee".to_owned(),
                    amount: paid_fee.to_string(),
                    contract_id: None,
                    from: request.from.clone(),
                    to: None,
                },
            ],
            total_fee: paid_fee.to_string(),
            transaction_count: 1,
            signing_task_count: crate::signing::planned_signing_task_count(&unsigned_plan, &signing_stage),
            signing_roles: None,
            warnings: Vec::new(),
            irreversible: true,
        },
    };
    let plan_hash = canonical_hash(&payload)?;
    Ok(PlannedTransfer {
        business_plan: None,
        resolved_request: None,
        result: PlanResult {
            plan: ExecutionPlan { payload, plan_hash },
        },
        unsigned_plan,
        signing_stage,
        output_roles,
    })
}

pub(crate) fn plan_tbc_merge(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
) -> Result<PlannedTransfer, EngineError> {
    validate_request(request)?;
    validate_material_identity(request, material)?;
    let policy = &material.policy.payload;
    validate_version(&policy.version, "policy.payload.version")?;
    if policy.chain_id != request.chain_id || policy.sighash_type != DEFAULT_SIGHASH {
        return Err(error(
            ErrorCode::InvalidInput,
            "policy chain or sighash does not match the request",
            "policy.payload",
        ));
    }
    if parse_decimal_u64(&policy.dust_threshold, "policy.payload.dustThreshold")?
        != tbc_sdk::SDK_DUST_SAT
    {
        return Err(error(
            ErrorCode::InvalidInput,
            format!("TBC dust threshold must be {} satoshis", tbc_sdk::SDK_DUST_SAT),
            "policy.payload.dustThreshold",
        ));
    }
    let fee_rate = parse_decimal_u64(
        &policy.fee_rate_sat_per_kb,
        "policy.payload.feeRateSatPerKb",
    )?;
    if fee_rate == 0 {
        return Err(error(
            ErrorCode::InvalidInput,
            "fee rate must be greater than zero",
            "policy.payload.feeRateSatPerKb",
        ));
    }
    let minimum_confirmations = parse_decimal_u64(
        &policy.min_confirmations,
        "policy.payload.minConfirmations",
    )?;
    if minimum_confirmations > u32::MAX as u64 {
        return Err(error(
            ErrorCode::InvalidInput,
            "minimum confirmations exceeds uint32",
            "policy.payload.minConfirmations",
        ));
    }

    let account = &material.snapshot.payload.account;
    let public_key_bytes = decode_hex(&account.public_key, "snapshot.payload.account.publicKey")?;
    let public_key = PublicKey::from_slice(&public_key_bytes).map_err(|_| {
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
    let account_script = hex(public_key.address().script_pubkey().as_bytes());
    let mut selected = validate_wallet_utxos(material, &account_script, minimum_confirmations)?;
    if let Some(requested) = request.constraints.as_ref().and_then(|c| c.input_outpoints.as_ref()) {
        let allowed = requested.iter().map(|p| (p.txid.as_str(), p.vout)).collect::<BTreeSet<_>>();
        selected.retain(|candidate| allowed.contains(&(candidate.txid.as_str(), candidate.vout)));
        if selected.len() != allowed.len() {
            return Err(error(ErrorCode::MissingMaterial,
                "one or more explicit native TBC merge input outpoints are unavailable",
                "request.constraints.inputOutpoints"));
        }
    }
    selected.sort_by(|left, right| {
        left.satoshis
            .cmp(&right.satoshis)
            .then_with(|| left.txid.cmp(&right.txid))
            .then_with(|| left.vout.cmp(&right.vout))
    });
    if selected.len() < 2 {
        return Err(error(
            ErrorCode::InsufficientFunds,
            "TBC merge requires at least two spendable native inputs",
            "snapshot.payload.utxos",
        ));
    }
    if selected.len() > MAX_TBC_MERGE_INPUTS {
        return Err(error(
            ErrorCode::InvalidInput,
            format!("TBC merge exceeds {MAX_TBC_MERGE_INPUTS} inputs"),
            "snapshot.payload.utxos",
        ));
    }
    let input_sum = checked_sum(
        selected.iter().map(|input| input.satoshis),
        "TBC merge input amount overflow",
    )?;
    validate_amount_limit(input_sum, policy)?;
    let paid_fee = fee_for_size(p2pkh_max_signed_size(selected.len(), 1)?, fee_rate)?;
    let output_amount = input_sum.checked_sub(paid_fee).ok_or_else(|| {
        error(
            ErrorCode::InsufficientFunds,
            "TBC merge inputs cannot cover the transaction fee",
            "snapshot.payload.utxos",
        )
    })?;
    if output_amount < tbc_sdk::SDK_DUST_SAT {
        return Err(error(
            ErrorCode::InsufficientFunds,
            "TBC merge output is below dust",
            "snapshot.payload.utxos",
        ));
    }
    if let Some(max_fee) = request
        .constraints
        .as_ref()
        .and_then(|constraints| constraints.max_fee.as_ref())
    {
        if paid_fee > parse_decimal_u64(max_fee, "request.constraints.maxFee")? {
            return Err(error(
                ErrorCode::FeeCapExceeded,
                "planned fee exceeds the request maximum",
                "request.constraints.maxFee",
            ));
        }
    }

    let signer = PublicSigningContext {
        address: account.address.clone(),
        public_key: hex(&public_key.to_bytes()),
        public_key_hash: hex(&public_key.hash160()),
    };
    let planned = PlannedTransaction {
        transaction_id: "tbc-merge-1".to_owned(),
        role: "primary".to_owned(),
        stage: 0,
        depends_on: Vec::new(),
        version: tbc_sdk::TX_VERSION,
        inputs: selected
            .iter()
            .map(|input| PlannedInput {
                previous_transaction_id: input.txid.clone(),
                previous_output_index: input.vout,
                previous_output_script: input.script.clone(),
                previous_output_satoshis: input.satoshis,
                sequence: DEFAULT_SEQUENCE,
                unlocking_script: String::new(),
                signer: signer.clone(),
            })
            .collect(),
        outputs: vec![PlannedOutput {
            satoshis: output_amount,
            locking_script: account_script,
        }],
        lock_time: tbc_sdk::DEFAULT_LOCK_TIME,
    };
    let unsigned_plan = UnsignedPlan {
        evidence_table: Vec::new(),
        transactions: vec![planned.clone()],
    };
    let signing_stage = begin_signing(&unsigned_plan)?;
    let unsigned_transaction = materialize(&planned)?;
    let signing_tasks = crate::signing_wire::public_signing_tasks(&signing_stage, account)?;
    let payload = ExecutionPlanPayload {
        version: WIRE_VERSION.to_owned(),
        request_hash: canonical_hash(request)?,
        snapshot_hash: material.snapshot.snapshot_hash.clone(),
        policy_hash: material.policy.policy_hash.clone(),
        chain_id: request.chain_id.clone(),
        account_id: account.account_id.clone(),
        expires_at: earliest_expiry(request, material)?,
        transactions: vec![TransactionTemplate {
            id: planned.transaction_id.clone(),
            role: planned.role.clone(),
            depends_on: Vec::new(),
            unsigned_transaction: unsigned_transaction.to_hex(),
            deferred_inputs: None,
            template_hash: hex(&Sha256::digest(unsigned_transaction.serialize())),
            fee: paid_fee.to_string(),
            output_review: crate::output_review::outputs(&unsigned_transaction),
        }],
        signing_tasks,
        preview: TransactionPreview {
            operation_kind: "transaction".to_owned(),
            contract_execution: None,
            asset_flows: vec![
                AssetFlow {
                    kind: "native".to_owned(),
                    direction: "merge".to_owned(),
                    amount: input_sum.to_string(),
                    contract_id: None,
                    from: request.from.clone(),
                    to: Some(request.from.clone()),
                },
                AssetFlow {
                    kind: "native".to_owned(),
                    direction: "fee".to_owned(),
                    amount: paid_fee.to_string(),
                    contract_id: None,
                    from: request.from.clone(),
                    to: None,
                },
            ],
            total_fee: paid_fee.to_string(),
            transaction_count: 1,
            signing_task_count: crate::signing::planned_signing_task_count(&unsigned_plan, &signing_stage),
            signing_roles: None,
            warnings: Vec::new(),
            irreversible: true,
        },
    };
    let plan_hash = canonical_hash(&payload)?;
    Ok(PlannedTransfer {
        business_plan: None,
        resolved_request: None,
        result: PlanResult {
            plan: ExecutionPlan { payload, plan_hash },
        },
        unsigned_plan,
        signing_stage,
        output_roles: vec![OutputRole::Change],
    })
}

pub(crate) fn validate_tbc_transfer(
    request: &CanonicalRequest,
    plan: &UnsignedPlan,
) -> Vec<Violation> {
    let mut violations = Vec::new();
    let expected_amount = request.intent.amount.as_deref().unwrap_or_default();
    if request.intent.intent_type != "tbc.transfer" || plan.transactions.len() != 1 {
        violations.push(violation("BUSINESS_OUTPUT_MISMATCH", "plan.transactions"));
        return violations;
    }
    let transaction = &plan.transactions[0];
    if transaction.role != "primary"
        || transaction.stage != 0
        || !transaction.depends_on.is_empty()
        || transaction.inputs.is_empty()
    {
        violations.push(violation("DEPENDENCY_INVALID", "plan.transactions[0]"));
    }
    if transaction.outputs.is_empty()
        || transaction.outputs[0].satoshis.to_string() != expected_amount
    {
        violations.push(violation("BUSINESS_OUTPUT_MISMATCH", "plan.transactions[0].outputs"));
    }
    violations
}

pub(crate) fn validate_tbc_merge(
    request: &CanonicalRequest,
    plan: &UnsignedPlan,
) -> Vec<Violation> {
    if request.intent.intent_type != "tbc.maintenance.merge" || plan.transactions.len() != 1 {
        return vec![violation("BUSINESS_OUTPUT_MISMATCH", "plan.transactions")];
    }
    let transaction = &plan.transactions[0];
    if transaction.transaction_id != "tbc-merge-1"
        || transaction.role != "primary"
        || transaction.stage != 0
        || !transaction.depends_on.is_empty()
        || !(2..=MAX_TBC_MERGE_INPUTS).contains(&transaction.inputs.len())
        || transaction.outputs.len() != 1
    {
        vec![violation("BUSINESS_OUTPUT_MISMATCH", "plan.transactions[0]")]
    } else {
        Vec::new()
    }
}

fn validate_material_identity(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
) -> Result<(), EngineError> {
    let snapshot = &material.snapshot.payload;
    validate_version(&snapshot.version, "snapshot.payload.version")?;
    let account = &snapshot.account;
    let expected_account_id = format!("{}:{}", request.chain_id, request.from);
    if snapshot.chain_id != request.chain_id
        || account.chain_id != request.chain_id
        || account.address != request.from
        || account.account_id != expected_account_id
    {
        return Err(error(
            ErrorCode::MissingMaterial,
            "snapshot chain or account does not match the request",
            "snapshot.payload.account",
        ));
    }
    if !snapshot.contracts.is_empty() || !material.policy.payload.contract_policies.is_empty() {
        return Err(error(
            ErrorCode::InvalidInput,
            "plain TBC transfer does not accept contract material",
            "snapshot.payload.contracts",
        ));
    }
    Ok(())
}

pub(crate) fn validate_amount_limit(
    amount: u64,
    policy: &crate::model::PolicyPayload,
) -> Result<(), EngineError> {
    let native = policy
        .amount_limits
        .iter()
        .filter(|limit| limit.scope == "native" && limit.contract_id.is_none())
        .collect::<Vec<_>>();
    if native.len() != 1 {
        return Err(error(
            ErrorCode::InvalidInput,
            "policy must contain exactly one unscoped native amount limit",
            "policy.payload.amountLimits",
        ));
    }
    let maximum = parse_decimal_u64(&native[0].maximum, "policy.payload.amountLimits[0].maximum")?;
    if amount > maximum {
        return Err(error(
            ErrorCode::InvalidInput,
            "transfer exceeds the native amount limit",
            "request.intent.amount",
        ));
    }
    Ok(())
}

fn validate_wallet_utxos(
    material: &WalletMaterial<'_>,
    account_script: &str,
    minimum_confirmations: u64,
) -> Result<Vec<Spendable>, EngineError> {
    let mut parents = BTreeMap::new();
    for parent in &material.snapshot.payload.parents {
        if parents.contains_key(&parent.txid) {
            return Err(error(
                ErrorCode::InvalidAncestry,
                "snapshot contains duplicate parent transactions",
                "snapshot.payload.parents",
            ));
        }
        let transaction = Transaction::from_hex(&parent.raw_transaction).map_err(|_| {
            error(
                ErrorCode::InvalidAncestry,
                "parent transaction bytes are invalid",
                "snapshot.payload.parents",
            )
        })?;
        if transaction.txid().to_string() != parent.txid || transaction.to_hex() != parent.raw_transaction {
            return Err(error(
                ErrorCode::InvalidAncestry,
                "parent transaction id or canonical bytes do not match",
                "snapshot.payload.parents",
            ));
        }
        parents.insert(parent.txid.clone(), transaction);
    }

    let mut outpoints = BTreeSet::new();
    let mut spendable = Vec::new();
    for (index, utxo) in material.snapshot.payload.utxos.iter().enumerate() {
        if utxo.classification != "native" || utxo.contract_id.is_some() {
            return Err(error(
                ErrorCode::InvalidAncestry,
                "plain TBC transfer requires an unscoped native UTXO classification",
                "snapshot.payload.utxos",
            ));
        }
        if !outpoints.insert((utxo.txid.clone(), utxo.vout)) {
            return Err(error(
                ErrorCode::InvalidAncestry,
                "snapshot contains a duplicate outpoint",
                "snapshot.payload.utxos",
            ));
        }
        let satoshis = parse_decimal_u64(
            &utxo.satoshis,
            &format!("snapshot.payload.utxos[{index}].satoshis"),
        )?;
        if satoshis == 0 {
            return Err(error(
                ErrorCode::InvalidAncestry,
                "UTXO value must be positive",
                "snapshot.payload.utxos",
            ));
        }
        let confirmations_sufficient = crate::confirmations::meets_minimum(
            utxo.confirmations.as_deref(),
            minimum_confirmations,
            &format!("snapshot.payload.utxos[{index}].confirmations"),
        )?;
        // Native P2PKH signs the supplied prevout amount and script. Fresh UTXO
        // state is the wallet-owned resolver's responsibility; parent bytes are
        // optional consistency evidence, not proof of chain membership/unspentness.
        if let Some(parent) = parents.get(&utxo.txid) {
            let output = parent.outputs.get(utxo.vout as usize).ok_or_else(|| {
                error(
                    ErrorCode::InvalidAncestry,
                    "UTXO parent output index is invalid",
                    "snapshot.payload.utxos",
                )
            })?;
            if output.satoshis != satoshis
                || hex(output.script_pubkey.as_bytes()) != utxo.script_pub_key
            {
                return Err(error(
                    ErrorCode::InvalidAncestry,
                    "UTXO does not match its parent transaction output",
                    "snapshot.payload.utxos",
                ));
            }
        }
        if utxo.script_pub_key != account_script {
            return Err(error(
                ErrorCode::InvalidAncestry,
                "native UTXO is not controlled by the snapshot account",
                "snapshot.payload.utxos",
            ));
        }
        if confirmations_sufficient {
            spendable.push(Spendable {
                txid: utxo.txid.clone(),
                vout: utxo.vout,
                satoshis,
                script: utxo.script_pub_key.clone(),
            });
        }
    }
    Ok(spendable)
}

fn select_for_fee_envelope(
    candidates: &[Spendable],
    amount: u64,
    fee_rate: u64,
) -> Result<FundingSelection, EngineError> {
    let mut ordered = candidates.to_vec();
    ordered.sort_by(|left, right| {
        left.satoshis
            .cmp(&right.satoshis)
            .then_with(|| right.txid.cmp(&left.txid))
            .then_with(|| right.vout.cmp(&left.vout))
    });

    let mut index = 0usize;
    while index < ordered.len() {
        let value = ordered[index].satoshis;
        let after_equal = ordered.partition_point(|candidate| candidate.satoshis <= value);
        let selected_index = after_equal - 1;
        if let Some(selection) = evaluate_fee_shape(
            vec![ordered[selected_index].clone()],
            value,
            amount,
            fee_rate,
        )? {
            return Ok(selection);
        }
        index = after_equal;
    }

    let mut selected = Vec::with_capacity(ordered.len());
    let mut total = 0u64;
    for candidate in ordered.iter().rev() {
        if selected.len() == MAX_TBC_INPUTS {
            return Err(error(
                ErrorCode::InvalidInput,
                format!("TBC transfer exceeds {MAX_TBC_INPUTS} inputs"),
                "snapshot.payload.utxos",
            ));
        }
        total = total.checked_add(candidate.satoshis).ok_or_else(|| {
            error(
                ErrorCode::InvalidInput,
                "candidate input amount overflows uint64",
                "snapshot.payload.utxos",
            )
        })?;
        selected.push(candidate.clone());
        if let Some(mut selection) =
            evaluate_fee_shape(selected.clone(), total, amount, fee_rate)?
        {
            selection.selected.sort_by(|left, right| {
                left.txid.cmp(&right.txid).then_with(|| left.vout.cmp(&right.vout))
            });
            return Ok(selection);
        }
    }

    Err(error(
        ErrorCode::InsufficientFunds,
        "native TBC balance is insufficient",
        "snapshot.payload.utxos",
    ))
}

fn evaluate_fee_shape(
    selected: Vec<Spendable>,
    input_sum: u64,
    amount: u64,
    fee_rate: u64,
) -> Result<Option<FundingSelection>, EngineError> {
    let Some(value) = input_sum.checked_sub(amount) else {
        return Ok(None);
    };
    let input_count = selected.len();
    let no_change_fee = fee_for_size(p2pkh_max_signed_size(input_count, 1)?, fee_rate)?;
    if value < no_change_fee {
        return Ok(None);
    }
    let change_fee = fee_for_size(p2pkh_max_signed_size(input_count, 2)?, fee_rate)?;
    let change_threshold = change_fee.checked_add(tbc_sdk::SDK_DUST_SAT).ok_or_else(|| {
        error(
            ErrorCode::InvalidInput,
            "fee calculation overflow",
            "policy.payload.feeRateSatPerKb",
        )
    })?;
    if value < change_threshold {
        return Ok(Some(FundingSelection {
            selected,
            paid_fee: value,
            change_amount: None,
        }));
    }
    Ok(Some(FundingSelection {
        selected,
        paid_fee: change_fee,
        change_amount: Some(value.checked_sub(change_fee).ok_or_else(|| {
            error(ErrorCode::InternalInvariant, "change accounting underflow", "plan")
        })?),
    }))
}

fn checked_sum(mut values: impl Iterator<Item = u64>, message: &str) -> Result<u64, EngineError> {
    values.try_fold(0u64, |total, value| {
        total.checked_add(value).ok_or_else(|| {
            error(ErrorCode::InvalidInput, message, "snapshot.payload.utxos")
        })
    })
}

fn materialize(planned: &PlannedTransaction) -> Result<Transaction, EngineError> {
    let inputs = planned
        .inputs
        .iter()
        .map(|input| {
            let txid = input.previous_transaction_id.parse::<Txid>().map_err(|_| {
                error(ErrorCode::InvalidAncestry, "input transaction id is invalid", "plan.transactions.inputs")
            })?;
            Ok(TxIn {
                previous_output: OutPoint { txid, vout: input.previous_output_index },
                script_sig: Script::empty(),
                sequence: input.sequence,
            })
        })
        .collect::<Result<Vec<_>, EngineError>>()?;
    let outputs = planned
        .outputs
        .iter()
        .map(|output| {
            Ok(TxOut {
                satoshis: output.satoshis,
                script_pubkey: Script::from_bytes(decode_hex(&output.locking_script, "plan.transactions.outputs")?),
            })
        })
        .collect::<Result<Vec<_>, EngineError>>()?;
    Ok(Transaction {
        version: planned.version,
        inputs,
        outputs,
        lock_time: planned.lock_time,
    })
}

fn earliest_expiry(request: &CanonicalRequest, material: &WalletMaterial<'_>) -> Result<String, EngineError> {
    let mut expiries = vec![
        material.snapshot.payload.expires_at.clone(),
        material.policy.payload.expires_at.clone(),
    ];
    if let Some(expiry) = request
        .constraints
        .as_ref()
        .and_then(|constraints| constraints.expires_at.clone())
    {
        expiries.push(expiry);
    }
    Ok(crate::plan::earliest_canonical_timestamp(expiries.iter().map(String::as_str))?.to_owned())
}

fn decode_hex(value: &str, path: &str) -> Result<Vec<u8>, EngineError> {
    if value.len() % 2 != 0 {
        return Err(error(ErrorCode::InvalidInput, "hex value has odd length", path));
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = hex_nibble(pair[0]).ok_or_else(|| error(ErrorCode::InvalidInput, "invalid hexadecimal value", path))?;
            let low = hex_nibble(pair[1]).ok_or_else(|| error(ErrorCode::InvalidInput, "invalid hexadecimal value", path))?;
            Ok((high << 4) | low)
        })
        .collect()
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn violation(code: &str, path: &str) -> Violation {
    Violation { code: code.to_owned(), path: Some(path.to_owned()) }
}
