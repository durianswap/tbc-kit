//! On-demand native funding prerequisite for single-fee-input contract families.
//! No I/O, keys, reservation state, or broadcast. The prerequisite is part of the
//! same approval-bound plan and its signed outpoint is resolved by continuation.

use std::collections::BTreeSet;
use tbc_sdk::{Address, OutPoint, Transaction, TxIn, TxOut};
use crate::{EngineError, ErrorCode};
use crate::families::ft::{estimate_p2pkh_fee, fee_rate, finish_plan, finish_profile_plan, funding_candidates,
    native_input, planned_output, public_signing_context};
use crate::funding::NativeFundingUtxo;
use crate::model::{CanonicalRequest, ParentTransaction, PlannedTransfer, WalletMaterial,
    WalletUtxo, RequestedOutpoint, error};
use crate::normalize::hex;
use crate::signing::{PlannedTransaction, bind_funding_recipe,
    materialize_unsigned_preview};

const FUNDING_ID: &str = "native-funding-1";

fn new_tbc20_profile(request: &CanonicalRequest) -> bool {
    matches!(request.intent.intent_type.as_str(),
        "tbc20-standard-create" | "tbc20-standard-transfer" | "tbc20-standard-merge")
}

fn coin_holder_profile(request: &CanonicalRequest) -> bool {
    matches!(request.intent.intent_type.as_str(), "tbc20-stablecoin-transfer" | "tbc20-stablecoin-merge")
}

fn exact_profile(request: &CanonicalRequest) -> bool {
    new_tbc20_profile(request) || coin_holder_profile(request)
}

pub(crate) fn plan_with_funding(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    build: impl Fn(&CanonicalRequest, &WalletMaterial<'_>) -> Result<PlannedTransfer, EngineError>,
) -> Result<PlannedTransfer, EngineError> {
    let original = match build(request, material) {
        Ok(plan) => return Ok(plan), // Preserve the existing successful hot path.
        Err(source) => source,
    };
    let tbc20 = new_tbc20_profile(request);
    let coin = coin_holder_profile(request);
    if original.code != ErrorCode::InsufficientFunds
        || matches!(request.intent.intent_type.as_str(), "tbc.transfer" | "tbc.maintenance.merge")
        // New NFT already tries direct multi-input funding. A consolidation
        // prerequisite cannot create extra balance and would only add fees.
        || crate::normalize::TBC721_INTENTS.contains(&request.intent.intent_type.as_str())
        || crate::normalize::TIMELOCK_INTENTS.contains(&request.intent.intent_type.as_str())
        || crate::normalize::HTLC_INTENTS.contains(&request.intent.intent_type.as_str())
        || crate::normalize::LOP_INTENTS.contains(&request.intent.intent_type.as_str())
    {
        return Err(original);
    }
    let signing = public_signing_context(material)?;
    let mut candidates = funding_candidates(material, &signing)?;
    if let Some(outpoints) = request.constraints.as_ref().and_then(|c| c.input_outpoints.as_ref()) {
        candidates.retain(|candidate| outpoints.iter().any(|point|
            point.txid == candidate.txid && point.vout == candidate.vout));
    }
    candidates.sort_by(|a, b| b.satoshis.cmp(&a.satoshis)
        .then_with(|| a.txid.cmp(&b.txid)).then_with(|| a.vout.cmp(&b.vout)));
    // Keep the existing automatic funding policy; 500 is for explicit public
    // native consolidation, not a reason to grow ordinary transaction work.
    let limit = candidates.len().min(100);
    if limit < 2 { return Err(original); }
    let exact_external = exact_profile(request) && request.constraints.as_ref().and_then(|c| c.input_outpoints.as_ref()).is_some();
    if exact_external && candidates.len() > limit {
        return Err(error(ErrorCode::InvalidInput, "specified native inputs exceed funding prerequisite limit", "request.constraints.inputOutpoints"));
    }
    let rate = fee_rate(material)?;
    let script = Address::from_string(&signing.address).expect("validated account").script_pubkey();
    // Geometric, bounded retries only on the failing path, using the same snapshot.
    let mut count = if exact_external { limit } else { 2 };
    loop {
        let selected = &candidates[..count];
        let sum = selected.iter().try_fold(0u64, |sum, item| sum.checked_add(item.satoshis))
            .ok_or_else(|| error(ErrorCode::InvalidInput, "native funding amount overflow", "snapshot.payload.utxos"))?;
        let fee = estimate_p2pkh_fee(count, &[TxOut { satoshis: 0, script_pubkey: script.clone() }], false, rate)?;
        let dust = if tbc20 { 42 } else if coin { 24 } else { tbc_sdk::SDK_DUST_SAT };
        if let Some(amount) = sum.checked_sub(fee).filter(|amount| *amount >= dust) {
            let output = TxOut { satoshis: amount, script_pubkey: script.clone() };
            let preview = Transaction {
                version: tbc_sdk::TX_VERSION,
                inputs: selected.iter().map(|item| TxIn::new(OutPoint {
                    txid: item.txid.parse().expect("validated funding txid"), vout: item.vout,
                })).collect(),
                outputs: vec![output.clone()], lock_time: tbc_sdk::DEFAULT_LOCK_TIME,
            };
            let txid = preview.txid().to_string();
            let raw = preview.to_hex();
            let funding = NativeFundingUtxo { txid: txid.clone(), vout: 0,
                satoshis: amount, script: hex(script.as_bytes()) };
            let mut snapshot = material.snapshot.clone();
            snapshot.payload.utxos.retain(|utxo| utxo.classification != "native");
            snapshot.payload.utxos.push(WalletUtxo { txid: txid.clone(), vout: 0,
                satoshis: amount.to_string(), script_pub_key: funding.script.clone(),
                confirmations: None, classification: "native".to_owned(), contract_id: None });
            if snapshot.payload.parents.iter().any(|parent| parent.txid == txid) {
                return Err(error(ErrorCode::InvalidAncestry, "funding preview collides with supplied ancestry", "snapshot.payload.parents"));
            }
            snapshot.payload.parents.push(ParentTransaction { txid: txid.clone(), raw_transaction: raw.clone() });
            let internal = WalletMaterial { snapshot: &snapshot, policy: material.policy, planned_native: Some(std::slice::from_ref(&funding)) };
            // Only the new profile has an exact external-input contract here.
            // Its internal business sees the prerequisite output instead of the
            // native inputs already consumed by that prerequisite. Final compose
            // checks the original external set, never the transformed request.
            let mut remapped;
            let business_request = if exact_external {
                remapped = request.clone();
                let points = remapped.constraints.as_mut().unwrap().input_outpoints.as_mut().unwrap();
                points.retain(|point| !selected.iter().any(|native| native.txid == point.txid && native.vout == point.vout));
                points.push(RequestedOutpoint { txid: txid.clone(), vout: 0 });
                &remapped
            } else { request };
            match build(business_request, &internal) {
                Ok(business) => {
                    let prerequisite = PlannedTransaction {
                        transaction_id: FUNDING_ID.to_owned(), role: "maintenance".to_owned(),
                        stage: 0, depends_on: Vec::new(), version: preview.version,
                        inputs: selected.iter().map(|item| native_input(item, &signing)).collect(),
                        outputs: vec![planned_output(&output)], lock_time: preview.lock_time,
                    };
                    return compose(request, material, business, prerequisite, &txid, &raw, fee);
                }
                Err(source) if source.code == ErrorCode::InsufficientFunds => {}
                Err(source) => return Err(source),
            }
        }
        if count == limit { break; }
        count = (count * 2).min(limit);
    }
    Err(original)
}

fn compose(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    business: PlannedTransfer,
    prerequisite: PlannedTransaction,
    preview_txid: &str,
    raw: &str,
    fee: u64,
) -> Result<PlannedTransfer, EngineError> {
    let original_business = business.unsigned_plan.clone();
    let mut unsigned = business.unsigned_plan;
    if unsigned.transactions.len() + 1 > material.policy.payload.max_bundle_transactions as usize {
        return Err(error(ErrorCode::InvalidInput, "funding prerequisite exceeds bundle transaction limit", "policy.payload.maxBundleTransactions"));
    }
    let indexes = unsigned.evidence_table.iter().enumerate()
        .filter(|(_, item)| item.txid == preview_txid && item.raw_transaction == raw)
        .map(|(index, _)| index as u32).collect::<Vec<_>>();
    let mut uses = 0;
    for transaction in &mut unsigned.transactions {
        if transaction.transaction_id == FUNDING_ID {
            return Err(error(ErrorCode::InvalidPlan, "funding plan identifier collision", "plan"));
        }
        for input in &mut transaction.inputs {
            if input.previous_transaction_id == preview_txid {
                if input.previous_output_index != 0 || input.previous_output_satoshis != prerequisite.outputs[0].satoshis
                    || input.previous_output_script != prerequisite.outputs[0].locking_script
                    || !input.unlocking_script.is_empty()
                {
                    return Err(error(ErrorCode::InvalidPlan, "funding successor does not match prerequisite", "plan"));
                }
                input.previous_transaction_id = FUNDING_ID.to_owned();
                uses += 1;
            }
            input.unlocking_script = bind_funding_recipe(&input.unlocking_script, raw, &indexes, FUNDING_ID)?;
        }
    }
    if uses != 1 {
        return Err(error(ErrorCode::InvalidPlan, "funding prerequisite must be spent exactly once", "plan"));
    }
    unsigned.transactions.insert(0, prerequisite);
    // Derive dependencies from actual input order (including an existing
    // business prerequisite), rather than appending an out-of-order edge.
    for index in 1..unsigned.transactions.len() {
        let mut dependencies = Vec::new();
        let mut stage = 0;
        for input in &unsigned.transactions[index].inputs {
            if let Some(parent) = unsigned.transactions[..index].iter()
                .find(|parent| parent.transaction_id == input.previous_transaction_id)
            {
                if !dependencies.contains(&parent.transaction_id) {
                    dependencies.push(parent.transaction_id.clone());
                }
                stage = stage.max(parent.stage + 1);
            }
        }
        unsigned.transactions[index].stage = stage;
        unsigned.transactions[index].depends_on = dependencies;
    }
    let previews = unsigned.transactions.iter()
        .map(|transaction| materialize_unsigned_preview(transaction, &unsigned)).collect::<Result<Vec<_>, _>>()?;
    let mut fees = vec![fee];
    fees.extend(business.result.plan.payload.transactions.iter().map(|item|
        item.fee.parse::<u64>().expect("validated fee")));
    let mut flows = business.result.plan.payload.preview.asset_flows;
    flows.retain(|flow| !(flow.kind == "native" && flow.direction == "fee"));
    let mut warnings = business.result.plan.payload.preview.warnings;
    for warning in ["MULTI_TRANSACTION", "MAINTENANCE_TRANSACTION"] {
        if !warnings.iter().any(|item| item == warning) { warnings.push(warning.to_owned()); }
    }
    let mut result = if exact_profile(request) {
        if let Some(points) = request.constraints.as_ref().and_then(|c| c.input_outpoints.as_ref()) {
            let wanted: BTreeSet<_> = points.iter().map(|p| (p.txid.as_str(), p.vout)).collect();
            let ids: BTreeSet<_> = unsigned.transactions.iter().map(|tx| tx.transaction_id.as_str()).collect();
            let external: Vec<_> = unsigned.transactions.iter().flat_map(|tx| &tx.inputs)
                .filter(|input| !ids.contains(input.previous_transaction_id.as_str()))
                .map(|input| (input.previous_transaction_id.as_str(), input.previous_output_index)).collect();
            let actual: BTreeSet<_> = external.iter().copied().collect();
            if actual != wanted || actual.len() != external.len() {
                return Err(error(ErrorCode::InvalidInput, "funding plan must spend the exact external input set once", "request.constraints.inputOutpoints"));
            }
        }
        finish_profile_plan(request, material, unsigned, previews, fees, warnings, flows)?
    } else {
        finish_plan(request, material, unsigned, previews, fees, warnings, flows)?
    };
    // Preserve the family-specific structural checks on the original business
    // recipe. Full composed bytes/tasks/fees remain checked against recomputation.
    result.business_plan = Some(original_business);
    Ok(result)
}
