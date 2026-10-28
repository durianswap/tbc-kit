//! Shared current/historical NFT transfer composition. No I/O or private keys.
//! Each existing family authenticates its own Code/Hold/Tape and ancestry.
//! The outer request, all recipients, aggregate fee and dependency edges form
//! one plan; no child request can acquire a separate approval or broadcast.
use std::collections::{BTreeMap, BTreeSet};
use tbc_sdk::Address;
use crate::{EngineError, ErrorCode, funding::NativeFundingUtxo,
    model::{CanonicalRequest, NftTransferItem, PlannedTransfer, Violation, WalletMaterial, error},
    normalize::{canonical_hash, parse_decimal_u64},
    signing::{UnsignedPlan, PublicSigningContext, materialize_unsigned_preview, remap_nft_evidence}};
use super::ft::{finish_profile_plan, funding_candidates, validate_material_identity};

pub(crate) const MAX_TRANSFERS: usize = 100;
fn invalid(message: &str) -> EngineError { error(ErrorCode::InvalidInput, message, "request.intent.transfers") }

fn child(request: &CanonicalRequest, item: &NftTransferItem) -> Result<CanonicalRequest, EngineError> {
    let mut value = serde_json::to_value(request).map_err(|_| invalid("invalid NFT batch"))?;
    value["intent"] = serde_json::json!({"version":request.intent.version,"type":"tbc721.transfer",
        "contractId":item.contract_id,"to":item.to});
    if let Some(payment) = &item.payment {
        value["intent"]["payment"] = serde_json::to_value(payment).map_err(|_| invalid("invalid NFT payment"))?;
    }
    serde_json::from_value(value).map_err(|_| invalid("invalid NFT transfer projection"))
}

pub(crate) fn validate_request(request: &CanonicalRequest) -> Result<(), EngineError> {
    let value = serde_json::to_value(&request.intent).map_err(|_| invalid("invalid NFT batch"))?;
    if value.as_object().unwrap().keys().any(|key| !["type", "version", "transfers"].contains(&key.as_str())) {
        return Err(invalid("NFT batch only accepts transfers"));
    }
    let items = request.intent.transfers.as_deref().ok_or_else(|| invalid("NFT transfers are required"))?;
    if items.is_empty() || items.len() > MAX_TRANSFERS { return Err(invalid("NFT batch requires 1 to 100 transfers")); }
    let mut contracts = BTreeSet::new();
    for item in items {
        if !contracts.insert(&item.contract_id) { return Err(invalid("an NFT cannot be sent twice in one batch")); }
        // Reuse full single-request validation, including chain/account, recipient,
        // payment, explicit input syntax, expiry and fee constraints.
        crate::normalize::validate_request(&child(request, item)?)?;
    }
    Ok(())
}

#[derive(Clone)]
struct Funding {
    value: NativeFundingUtxo,
    /// Only an internally constructed output can have this trusted binding.
    source: Option<(String, u32)>,
}

pub(crate) fn plan(request: &CanonicalRequest, material: &WalletMaterial<'_>, signing: &PublicSigningContext)
    -> Result<PlannedTransfer, EngineError> {
    validate_request(request)?;
    validate_material_identity(request, material)?;
    let items = request.intent.transfers.as_ref().unwrap();
    if items.len() > material.policy.payload.max_bundle_transactions as usize {
        return Err(invalid("NFT batch exceeds the policy transaction budget"));
    }
    // The outer shared policy uses the current profile's change floor. A legacy
    // child still uses its fixed SDK floor, not a new or relaxed covenant rule.
    if material.policy.payload.dust_threshold != "42" || material.policy.payload.fee_rate_sat_per_kb != "80"
        || material.policy.payload.sighash_type != 65 || material.policy.payload.chain_id != request.chain_id {
        return Err(invalid("shared NFT batch requires the canonical 80 atomic/kB, dust 42, sighash 65 policy"));
    }
    let cap = request.constraints.as_ref().and_then(|c| c.max_fee.as_deref())
        .map(|v| parse_decimal_u64(v, "request.constraints.maxFee")).transpose()?.unwrap_or(u64::MAX);
    let nft_rules: Vec<_> = material.policy.payload.contract_policies.iter()
        .filter(|rule| rule.get("family").and_then(|v| v.as_str()) == Some("nft")).collect();
    if nft_rules.len() > 1 { return Err(invalid("duplicate NFT contract policies")); }
    let allowed = nft_rules.first().map(|rule| {
        let versions = rule.get("allowedVersions").and_then(|v| v.as_array())
            .ok_or_else(|| invalid("NFT allowedVersions missing"))?;
        let set = versions.iter().map(|v| v.as_str().ok_or_else(|| invalid("invalid NFT allowedVersion")))
            .collect::<Result<BTreeSet<_>,_>>()?;
        if set.len() != versions.len() { return Err(invalid("duplicate NFT allowedVersions")); }
        Ok(set)
    }).transpose()?;
    let payment_total = items.iter().filter_map(|item| item.payment.as_ref()).try_fold(0u64, |sum,p| {
        sum.checked_add(parse_decimal_u64(&p.amount, "request.intent.transfers.payment.amount")?)
            .ok_or_else(|| invalid("NFT batch payment overflow"))
    })?;
    if payment_total > 0 {
        let limits: Vec<_> = material.policy.payload.amount_limits.iter().filter(|l|
            l.scope == "native" && l.contract_id.is_none() && l.protocol_version.is_none()).collect();
        if limits.len() != 1 || payment_total > parse_decimal_u64(&limits[0].maximum, "policy.payload.amountLimits")? {
            return Err(invalid("NFT batch exceeds aggregate native payment limit"));
        }
    }
    let exact = request.constraints.as_ref().and_then(|c| c.input_outpoints.as_ref());
    let mut funding = funding_candidates(material, signing)?.into_iter()
        .filter(|u| exact.is_none_or(|points| points.iter().any(|p| p.txid == u.txid && p.vout == u.vout)))
        .map(|value| Funding { value, source: None }).collect::<Vec<_>>();
    // Select sufficient fee capacity before signing. Normal single-NFT selection
    // is unchanged; no unused candidate requires a parent fetch here.
    funding.sort_by(|a,b| b.value.satoshis.cmp(&a.value.satoshis)
        .then_with(|| a.value.txid.cmp(&b.value.txid)).then_with(|| a.value.vout.cmp(&b.value.vout)));
    let owner_script = crate::normalize::hex(Address::from_string(&request.from).unwrap().script_pubkey().as_bytes());
    let mut unsigned = UnsignedPlan { transactions: Vec::new(), evidence_table: Vec::new() };
    let mut evidence_by_id = BTreeMap::<String, u32>::new();
    let mut external = BTreeSet::new();
    let mut fees = Vec::new();
    let mut flows = Vec::new();
    let mut total_fee = 0u64;
    for (index, item) in items.iter().enumerate() {
        let mut projected = child(request, item)?;
        if let Some(constraints) = &mut projected.constraints {
            constraints.input_outpoints = None; // Exact external set checked on the composed plan below.
            if constraints.max_fee.is_some() { constraints.max_fee = Some(cap.saturating_sub(total_fee).to_string()); }
        }
        let resolved = crate::business::resolve(&projected, material)?;
        let historical = resolved.intent.intent_type == "tbc.nft.transfer";
        if allowed.as_ref().is_some_and(|versions| !versions.contains(if historical {"2.0"} else {"tbc721"})) {
            return Err(invalid("NFT batch policy does not allow the resolved asset profile"));
        }
        let mut policy = material.policy.clone();
        if historical { policy.payload.dust_threshold = tbc_sdk::SDK_DUST_SAT.to_string(); }
        policy.payload.max_bundle_transactions -= unsigned.transactions.len() as u32;
        policy.policy_hash = canonical_hash(&policy.payload)?;
        let mut selected = None;
        let mut last_error = None;
        for candidate in &funding {
            // Every external candidate already passed confirmation/ownership
            // selection above. A generated change is a typed prior-plan output,
            // not a false claim of confirmed API data.
            let internal = WalletMaterial { snapshot: material.snapshot, policy: &policy, planned_native: Some(std::slice::from_ref(&candidate.value)) };
            let result = if historical { super::nft::plan_nft(&resolved, &internal, signing) }
                else { super::tbc721::plan_tbc721(&resolved, &internal, signing) };
            match result {
                Ok(value) => { selected = Some(value); break; }
                Err(e) if matches!(e.code, ErrorCode::InsufficientFunds | ErrorCode::FeeCapExceeded) => last_error = Some(e),
                Err(e) => return Err(e),
            }
        }
        if selected.is_none() && funding.len() > 1 {
            // Only the insufficient single-input path tries multiple inputs.
            // Current NFT supports them directly; historical NFT reuses the
            // existing bounded funding prerequisite. Both consume this already
            // authenticated pool, never a fabricated confirmed snapshot.
            let candidates = funding.iter().map(|f| f.value.clone()).collect::<Vec<_>>();
            let internal = WalletMaterial { snapshot: material.snapshot, policy: &policy, planned_native: Some(&candidates) };
            let result = if historical {
                crate::funding_fallback::plan_with_funding(&resolved, &internal, |r,m| super::nft::plan_nft(r,m,signing))
            } else { super::tbc721::plan_tbc721(&resolved, &internal, signing) };
            match result { Ok(value) => selected = Some(value), Err(e) => last_error = Some(e) }
        }
        let built = selected.ok_or_else(|| last_error.unwrap_or_else(||
            error(ErrorCode::InsufficientFunds, "NFT batch requires sufficient fee funding", "snapshot.payload.utxos")))?;
        if built.unsigned_plan.transactions.iter().filter(|t| t.role == "primary").count() != 1 {
            return Err(invalid("NFT transfer must resolve to one business transaction"));
        }
        if unsigned.transactions.len() + built.unsigned_plan.transactions.len() > material.policy.payload.max_bundle_transactions as usize {
            return Err(invalid("NFT batch including funding exceeds the policy transaction budget"));
        }
        let mut remap = BTreeMap::new();
        for (old_index, entry) in built.unsigned_plan.evidence_table.into_iter().enumerate() {
            let target = if let Some(target) = evidence_by_id.get(&entry.txid) {
                if unsigned.evidence_table[*target as usize] != entry { return Err(invalid("NFT batch evidence conflicts")); }
                *target
            } else {
                let target = unsigned.evidence_table.len() as u32;
                evidence_by_id.insert(entry.txid.clone(), target);
                unsigned.evidence_table.push(entry);
                target
            };
            remap.insert(old_index as u32, target);
        }
        let ids = built.unsigned_plan.transactions.iter().enumerate()
            .map(|(child,tx)| (tx.transaction_id.clone(), format!("nft-batch-{index}-{child}"))).collect::<BTreeMap<_,_>>();
        let mut consumed = BTreeSet::new();
        for mut tx in built.unsigned_plan.transactions {
            tx.transaction_id = ids[&tx.transaction_id].clone(); tx.depends_on.clear(); tx.stage = 0;
            for input in &mut tx.inputs {
                input.unlocking_script = remap_nft_evidence(&input.unlocking_script, &remap)?;
                let local = ids.get(&input.previous_transaction_id);
                if let Some(id) = local { input.previous_transaction_id = id.clone(); }
                else if let Some((funding_index, used)) = funding.iter().enumerate().find(|(_,f)|
                    input.previous_transaction_id == f.value.txid && input.previous_output_index == f.value.vout) {
                    if !input.unlocking_script.is_empty() || input.previous_output_satoshis != used.value.satoshis
                        || input.previous_output_script != used.value.script || !consumed.insert(funding_index) {
                        return Err(invalid("NFT batch funding edge differs or is reused"));
                    }
                    if let Some((id, _)) = &used.source { input.previous_transaction_id = id.clone(); }
                }
                if let Some(parent) = unsigned.transactions.iter().find(|t| t.transaction_id == input.previous_transaction_id) {
                    if !tx.depends_on.contains(&parent.transaction_id) { tx.depends_on.push(parent.transaction_id.clone()); }
                    tx.stage = tx.stage.max(parent.stage + 1);
                } else if !external.insert((input.previous_transaction_id.clone(), input.previous_output_index)) {
                    return Err(invalid("NFT batch would spend the same external input twice"));
                }
            }
            unsigned.transactions.push(tx);
        }
        if consumed.is_empty() { return Err(invalid("NFT batch must bind its selected funding")); }
        for position in consumed.into_iter().rev() { funding.remove(position); }
        for transaction in &built.result.plan.payload.transactions {
            let fee = parse_decimal_u64(&transaction.fee, "plan.fee")?;
            total_fee = total_fee.checked_add(fee).ok_or_else(|| invalid("NFT batch fee overflow"))?;
            fees.push(fee);
        }
        if total_fee > cap { return Err(error(ErrorCode::FeeCapExceeded, "NFT batch exceeds aggregate fee cap", "request.constraints.maxFee")); }
        for mut flow in built.result.plan.payload.preview.asset_flows {
            if flow.direction == "fee" { continue; }
            // Historical single-transfer previews predate the unified identity.
            if flow.kind == "nft" { flow.contract_id = Some(item.contract_id.clone()); }
            flows.push(flow);
        }
        let change_index = 3 + usize::from(item.payment.is_some());
        let tx = unsigned.transactions.last().unwrap();
        if let Some(change) = tx.outputs.get(change_index) {
            if tx.outputs.len() != change_index + 1 || change.locking_script != owner_script {
                return Err(invalid("NFT batch change layout differs"));
            }
            let preview = materialize_unsigned_preview(tx, &unsigned)?;
            // Consume available signed change first. Its final txid is resolved
            // by the existing continuation, never by downloading our own parent.
            funding.insert(0, Funding { value: NativeFundingUtxo { txid: preview.txid().to_string(),
                vout: change_index as u32, satoshis: change.satoshis, script: change.locking_script.clone() },
                source: Some((tx.transaction_id.clone(), tx.stage)) });
        }
    }
    if exact.is_some_and(|points| points.iter().map(|p| (p.txid.clone(), p.vout)).collect::<BTreeSet<_>>() != external) {
        return Err(invalid("NFT batch must spend the exact requested external inputs"));
    }
    let previews = unsigned.transactions.iter().map(|tx| materialize_unsigned_preview(tx, &unsigned)).collect::<Result<Vec<_>, _>>()?;
    finish_profile_plan(request, material, unsigned, previews, fees,
        if items.len() > 1 { vec!["MULTI_TRANSACTION".into()] } else { vec![] }, flows)
}

pub(crate) fn validate_plan(request: &CanonicalRequest, plan: &UnsignedPlan) -> Vec<Violation> {
    if plan.transactions.iter().filter(|tx| tx.role == "primary").count() == request.intent.transfers.as_ref().map_or(0, Vec::len)
        && plan.transactions.iter().all(|tx| tx.role == "primary" || tx.role == "maintenance") { vec![] }
    else { vec![Violation { code: "BUSINESS_OUTPUT_MISMATCH".into(), path: Some("plan.payload.transactions".into()) }] }
}
