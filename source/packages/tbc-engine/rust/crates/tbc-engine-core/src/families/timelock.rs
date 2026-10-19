//! Height-profile PiggyBank intents using the shared planning/signing lifecycle.
//! Snapshot producers fetch data; this module only verifies supplied material.
use std::collections::{BTreeMap, BTreeSet};
use tbc_sdk::{OutPoint, PublicKey, UtxoInfo, script::Script};
use crate::{EngineError, ErrorCode, model::{AssetFlow, CanonicalRequest, PlannedTransfer, WalletMaterial, error},
    normalize::{hex, parse_decimal_u64, validate_request, validate_version},
    protocols::{timelock::{Code, LOCKTIME_THRESHOLD}, timelock_transaction::{build_lock_plan, build_unlock_plan}},
    signing::{MAX_SIGNING_PLAN_INPUTS, PublicSigningContext}};
use super::{ft::{decode_hex, funding_candidates, validate_material_identity},
    tbc20::{Parents, finish, max_fee, permitted}, tbc::validate_amount_limit};

fn invalid(message: &str) -> EngineError { error(ErrorCode::InvalidInput, message, "request.intent") }
fn missing(message: &str) -> EngineError { error(ErrorCode::MissingMaterial, message, "snapshot.payload") }
pub(crate) fn validate_timelock_request(request: &CanonicalRequest) -> Result<(), EngineError> {
    let intent = &request.intent;
    let fields = serde_json::to_value(intent).map_err(|_| invalid("Timelock intent encoding invalid"))?;
    let lock = intent.intent_type == "tbc-timelock-lock";
    let allowed: &[&str] = if lock { &["type", "version", "amount", "lockTime"] } else { &["type", "version"] };
    if fields.as_object().unwrap().keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(invalid("Timelock fields must match the exact operation"));
    }
    if lock {
        let amount = parse_decimal_u64(intent.amount.as_deref().ok_or_else(|| invalid("Timelock amount required"))?, "request.intent.amount")?;
        let height = parse_decimal_u64(intent.lock_time.as_deref().ok_or_else(|| invalid("Timelock lockTime height required"))?, "request.intent.lockTime")?;
        if amount == 0 || amount > 9_007_199_254_740_991 || height == 0 || height >= u64::from(LOCKTIME_THRESHOLD) {
            return Err(invalid("Timelock requires positive safe atomic amount and height-domain lockTime"));
        }
    } else if request.constraints.as_ref().and_then(|c| c.input_outpoints.as_ref()).is_none_or(|p| p.is_empty()) {
        return Err(invalid("Timelock unlock requires exact deposit inputOutpoints"));
    }
    Ok(())
}

pub(crate) fn plan_timelock(request: &CanonicalRequest, material: &WalletMaterial<'_>, signing: &PublicSigningContext) -> Result<PlannedTransfer, EngineError> {
    validate_request(request)?;
    validate_material_identity(request, material)?;
    let policy = &material.policy.payload;
    validate_version(&policy.version, "policy.payload.version")?;
    if policy.chain_id != request.chain_id || policy.fee_rate_sat_per_kb != "80" || policy.dust_threshold != "42" || policy.sighash_type != 65 {
        return Err(invalid("Timelock policy requires 80 atomic/kB, dust42 and sighash65"));
    }
    let public = PublicKey::from_slice(&decode_hex(&signing.public_key, "snapshot.payload.account.publicKey")?).map_err(|_| missing("Timelock public key invalid"))?;
    let height = parse_decimal_u64(&material.snapshot.payload.require_block()?.height, "snapshot.payload.block.height")?;
    if height >= u64::from(LOCKTIME_THRESHOLD) { return Err(missing("Timelock snapshot is outside the height profile")); }
    let maximum = max_fee(request)?;
    let lock = request.intent.intent_type == "tbc-timelock-lock";
    let built = if lock {
        let amount = parse_decimal_u64(request.intent.amount.as_deref().unwrap(), "request.intent.amount")?;
        let until = parse_decimal_u64(request.intent.lock_time.as_deref().unwrap(), "request.intent.lockTime")?;
        if until <= height { return Err(invalid("Timelock creation height must be after the bound tip")); }
        validate_amount_limit(amount, policy)?;
        let mut funding = funding_candidates(material, signing)?;
        funding.retain(|u| permitted(request, &u.txid, u.vout));
        funding.sort_by(|a,b| b.satoshis.cmp(&a.satoshis).then_with(|| (&a.txid,a.vout).cmp(&(&b.txid,b.vout))));
        let exact = request.constraints.as_ref().and_then(|c| c.input_outpoints.as_ref()).is_some();
        let mut inputs = vec![];
        let mut total = 0u64;
        let mut result = None;
        let mut last_error = error(ErrorCode::InsufficientFunds, "Timelock funding is insufficient", "snapshot.payload.utxos");
        for (index, u) in funding.iter().enumerate() {
            if inputs.len() == MAX_SIGNING_PLAN_INPUTS { return Err(invalid("Timelock funding exceeds shared input bound")); }
            inputs.push(UtxoInfo { outpoint: OutPoint { txid: u.txid.parse().map_err(|_| missing("Invalid funding txid"))?, vout: u.vout },
                satoshis: u.satoshis, script_pubkey: Script::from_bytes(decode_hex(&u.script, "snapshot.payload.utxos.scriptPubKey")?) });
            total = total.checked_add(u.satoshis).ok_or_else(|| invalid("Timelock funding total overflow"))?;
            if exact && index + 1 != funding.len() { continue; }
            // O(1) incremental lower bound avoids serializing every insufficient
            // prefix. A 53-byte lock output is 28 bytes longer than P2PKH.
            let minimum_size = crate::fee_envelope::p2pkh_max_signed_size(inputs.len(), 1)? + 28;
            let minimum_fee = crate::fee_envelope::fee_for_size(minimum_size, 80)?;
            if total < amount.saturating_add(minimum_fee) { continue; }
            match build_lock_plan(&inputs, &public, amount, until as u32, maximum) {
                Ok(plan) => { result = Some(plan); break; }
                Err(e) if matches!(e.code, ErrorCode::InsufficientFunds | ErrorCode::FeeCapExceeded) => last_error = e,
                Err(e) => return Err(e),
            }
        }
        result.ok_or(last_error)?
    } else {
        let minimum = parse_decimal_u64(&policy.min_confirmations, "policy.payload.minConfirmations")?;
        let mut parents = Parents::new(material)?;
        let mut parsed_parents = BTreeMap::new();
        let mut deposits: Vec<_> = material.snapshot.payload.utxos.iter().filter(|u| permitted(request, &u.txid, u.vout)).collect();
        deposits.sort_by(|a,b| (&a.txid,a.vout).cmp(&(&b.txid,b.vout)));
        if deposits.is_empty() || deposits.len() > MAX_SIGNING_PLAN_INPUTS { return Err(missing("Timelock selected deposits unavailable or over bound")); }
        let mut seen = BTreeSet::new();
        let mut inputs = vec![];
        for u in deposits {
            if u.classification != "timelock" || u.contract_id.is_some() || !seen.insert((&u.txid, u.vout)) {
                return Err(missing("Timelock deposit classification or identity invalid"));
            }
            if !crate::confirmations::meets_minimum(u.confirmations.as_deref(), minimum, "snapshot.payload.utxos.confirmations")? {
                return Err(missing("Timelock deposit does not meet confirmation policy"));
            }
            // Several deposits may share one parent; decode/hash it once for
            // this bound snapshot, never cache across mutable chain contexts.
            if !parsed_parents.contains_key(&u.txid) {
                let tx = tbc_sdk::Transaction::from_bytes(parents.bytes(&u.txid)?).map_err(|_| missing("Timelock parent is invalid"))?;
                if tx.txid().to_string() != u.txid { return Err(missing("Timelock parent hash differs from selected outpoint")); }
                parsed_parents.insert(u.txid.clone(), tx);
            }
            let tx = &parsed_parents[&u.txid];
            let output = tx.outputs.get(u.vout as usize).ok_or_else(|| missing("Timelock output missing from parent"))?;
            if u.satoshis != output.satoshis.to_string() || u.script_pub_key != hex(output.script_pubkey.as_bytes()) {
                return Err(missing("Timelock descriptor differs from parent output"));
            }
            let code = Code::decode(output.script_pubkey.as_bytes()).map_err(|_| missing("Timelock template is unsupported"))?;
            if code.owner_hash != public.hash160() { return Err(missing("Timelock owner differs from signer")); }
            inputs.push(UtxoInfo { outpoint: OutPoint { txid: u.txid.parse().map_err(|_| missing("Invalid deposit txid"))?, vout: u.vout }, satoshis: output.satoshis, script_pubkey: output.script_pubkey.clone() });
        }
        let plan = build_unlock_plan(&inputs, &public, height as u32, maximum)?;
        validate_amount_limit(plan.unsigned_plan.transactions[0].outputs[0].satoshis, policy)?;
        plan
    };
    let amount = built.unsigned_plan.transactions[0].outputs[0].satoshis.to_string();
    finish(request, material, built.unsigned_plan, vec![built.fee], vec![AssetFlow {
        kind: "native".into(), direction: if lock { "lock" } else { "unlock" }.into(), amount,
        contract_id: None, from: request.from.clone(), to: Some(request.from.clone()),
    }])
}
