//! Shared HTLC public intents. Explicit asset standards dispatch to authenticated
//! Token Code/Tape/ancestry planning, never an inferred legacy profile.
use std::collections::{BTreeMap, BTreeSet};
use tbc_sdk::{Address, OutPoint, PublicKey, Transaction, UtxoInfo, script::Script};
use crate::{EngineError, ErrorCode, model::{AssetFlow, CanonicalRequest, PlannedTransfer, WalletMaterial, error},
    normalize::{hex, parse_decimal_u64, validate_request, validate_version},
    protocols::{htlc::{Code, LOCKTIME_THRESHOLD}, htlc_transaction::{build_lock_plan, build_spend_plan, SpendBranch, MAX_PREIMAGE_BYTES}},
    signing::{MAX_SIGNING_PLAN_INPUTS, PublicSigningContext}};
use super::{ft::{decode_hex, funding_candidates, validate_material_identity},
    tbc20::{Parents, finish_with_warnings, max_fee, permitted}, tbc::validate_amount_limit};

fn invalid(message: &str) -> EngineError { error(ErrorCode::InvalidInput, message, "request.intent") }
fn missing(message: &str) -> EngineError { error(ErrorCode::MissingMaterial, message, "snapshot.payload") }
fn canonical_hex(value: &str, max: usize) -> bool {
    value.len() <= max * 2 && value.len() % 2 == 0
        && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) fn validate_htlc_request(request: &CanonicalRequest) -> Result<(), EngineError> {
    let intent = &request.intent;
    let fields = serde_json::to_value(intent).map_err(|_| invalid("HTLC intent encoding invalid"))?;
    let token=intent.asset_standard.is_some();
    if token {
        if !matches!(intent.asset_standard.as_deref(),Some("tbc20-standard"|"tbc20-stablecoin"))
            || intent.contract_id.as_deref().is_none_or(|id|id.len()!=64 || !canonical_hex(id,32)) {
            return Err(invalid("HTLC Token requires an explicit supported assetStandard and contractId"));
        }
        if intent.intent_type!="tbc-htlc-lock" {
            let targets=intent.target_outpoints.as_ref().ok_or_else(||invalid("HTLC Token spend requires one targetOutpoints entry"))?;
            if targets.len()!=1 || targets[0].vout!=1 || targets[0].txid.len()!=64 || !canonical_hex(&targets[0].txid,32) {
                return Err(invalid("HTLC Token target must select the deployment Token Code at vout one"));
            }
        }
    }
    let allowed: &[&str] = match (intent.intent_type.as_str(),token) {
        ("tbc-htlc-lock",false) => &["type", "version", "amount", "to", "hashlock", "lockTime"],
        ("tbc-htlc-claim",false) => &["type", "version", "preimage"],
        ("tbc-htlc-refund",false) => &["type", "version"],
        ("tbc-htlc-lock",true) => &["type", "version", "amount", "to", "hashlock", "lockTime", "assetStandard", "contractId"],
        ("tbc-htlc-claim",true) => &["type", "version", "preimage", "assetStandard", "contractId", "targetOutpoints"],
        ("tbc-htlc-refund",true) => &["type", "version", "assetStandard", "contractId", "targetOutpoints"],
        _ => return Err(invalid("Unsupported HTLC operation")),
    };
    if fields.as_object().unwrap().keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(invalid("HTLC fields must match the exact operation"));
    }
    if intent.intent_type == "tbc-htlc-lock" {
        let amount = parse_decimal_u64(intent.amount.as_deref().ok_or_else(|| invalid("HTLC amount required"))?, "request.intent.amount")?;
        let until = parse_decimal_u64(intent.lock_time.as_deref().ok_or_else(|| invalid("HTLC lockTime required"))?, "request.intent.lockTime")?;
        let hash = intent.hashlock.as_deref().ok_or_else(|| invalid("HTLC hashlock required"))?;
        let maximum=if token{i64::MAX as u64}else{9_007_199_254_740_991};
        if amount == 0 || amount > maximum || until == 0 || until > i32::MAX as u64
            || hash.len() != 64 || !canonical_hex(hash,32) {
            return Err(invalid("HTLC amount, safe lock time or SHA256 hashlock invalid"));
        }
        Address::from_string(intent.to.as_deref().ok_or_else(|| invalid("HTLC receiver required"))?)
            .map_err(|_| invalid("HTLC receiver address invalid"))?;
    } else {
        if !token && request.constraints.as_ref().and_then(|c| c.input_outpoints.as_ref()).is_none_or(|v| v.is_empty()) {
            return Err(invalid("HTLC claim/refund requires exact deposit inputOutpoints"));
        }
        if intent.intent_type == "tbc-htlc-claim" {
            let preimage = intent.preimage.as_deref().ok_or_else(|| invalid("HTLC preimage required"))?;
            if !canonical_hex(preimage, MAX_PREIMAGE_BYTES) { return Err(invalid("HTLC preimage encoding or size invalid")); }
        }
    }
    Ok(())
}

pub(crate) fn plan_htlc(request: &CanonicalRequest, material: &WalletMaterial<'_>, signing: &PublicSigningContext) -> Result<PlannedTransfer, EngineError> {
    validate_request(request)?;
    validate_material_identity(request,material)?;
    let policy = &material.policy.payload;
    validate_version(&policy.version,"policy.payload.version")?;
    if policy.chain_id != request.chain_id || policy.fee_rate_sat_per_kb != "80" || policy.dust_threshold != "42" || policy.sighash_type != 65 {
        return Err(invalid("HTLC policy requires 80 atomic/kB, dust42 and sighash65"));
    }
    let public = PublicKey::from_slice(&decode_hex(&signing.public_key,"snapshot.payload.account.publicKey")?)
        .map_err(|_| missing("HTLC public key invalid"))?;
    let block = material.snapshot.payload.block.as_ref();
    let height = block.map(|b|parse_decimal_u64(&b.height,"snapshot.payload.block.height")).transpose()?;
    if height.is_some_and(|h| h >= u64::from(LOCKTIME_THRESHOLD)) { return Err(missing("HTLC snapshot height is outside height domain")); }
    let mtp = block.and_then(|b| b.median_time_past.as_deref())
        .map(|v|parse_decimal_u64(v,"snapshot.payload.block.medianTimePast")).transpose()?;
    let maximum = max_fee(request)?;
    if request.intent.asset_standard.is_some() {
        return super::htlc_token::plan_token_htlc(request,material,signing,&public,
            crate::protocols::htlc_token::ChainContext{height,median_time_past:mtp});
    }
    let lock = request.intent.intent_type == "tbc-htlc-lock";
    let built = if lock {
        let amount = parse_decimal_u64(request.intent.amount.as_deref().unwrap(),"request.intent.amount")?;
        let until = parse_decimal_u64(request.intent.lock_time.as_deref().unwrap(),"request.intent.lockTime")?;
        let observed = if until < u64::from(LOCKTIME_THRESHOLD) {height.ok_or_else(||missing("HTLC height creation requires observed chain height"))?} else {
            mtp.ok_or_else(||missing("HTLC timestamp creation requires trusted medianTimePast"))?
        };
        if until <= observed { return Err(invalid("HTLC creation lock must be after the bound chain observation")); }
        validate_amount_limit(amount,policy)?;
        let receiver = Address::from_string(request.intent.to.as_deref().unwrap()).map_err(|_|invalid("HTLC receiver invalid"))?;
        let code = Code {sender_hash:public.hash160(),receiver_hash:receiver.hash160(),raw_lock_time:until as u32,
            hashlock:decode_hex(request.intent.hashlock.as_deref().unwrap(),"request.intent.hashlock")?.try_into().unwrap()};
        let mut funding = funding_candidates(material,signing)?;
        funding.retain(|u|permitted(request,&u.txid,u.vout));
        funding.sort_by(|a,b|b.satoshis.cmp(&a.satoshis).then_with(||(&a.txid,a.vout).cmp(&(&b.txid,b.vout))));
        let exact = request.constraints.as_ref().and_then(|c|c.input_outpoints.as_ref()).is_some();
        let mut inputs=vec![];let mut total=0u64;let mut result=None;
        let mut last=error(ErrorCode::InsufficientFunds,"HTLC funding is insufficient","snapshot.payload.utxos");
        for (index,u) in funding.iter().enumerate() {
            if inputs.len()==MAX_SIGNING_PLAN_INPUTS { return Err(invalid("HTLC funding exceeds shared input bound")); }
            inputs.push(UtxoInfo {outpoint:OutPoint {txid:u.txid.parse().map_err(|_|missing("Invalid HTLC funding txid"))?,vout:u.vout},
                satoshis:u.satoshis,script_pubkey:Script::from_bytes(decode_hex(&u.script,"snapshot.payload.utxos.scriptPubKey")?)});
            total=total.checked_add(u.satoshis).ok_or_else(||invalid("HTLC funding overflow"))?;
            if exact && index+1!=funding.len() {continue;}
            // Only constant-time size arithmetic for insufficient prefixes;
            // 137-byte HTLC output replaces the 25-byte P2PKH output.
            let minimum=crate::fee_envelope::p2pkh_max_signed_size(inputs.len(),1)?+112;
            if total < amount.saturating_add(crate::fee_envelope::fee_for_size(minimum,80)?) {continue;}
            match build_lock_plan(&inputs,&public,&code,amount,maximum) {
                Ok(plan)=>{result=Some(plan);break;},
                Err(e) if matches!(e.code,ErrorCode::InsufficientFunds|ErrorCode::FeeCapExceeded)=>last=e,
                Err(e)=>return Err(e),
            }
        }
        result.ok_or(last)?
    } else {
        let minimum=parse_decimal_u64(&policy.min_confirmations,"policy.payload.minConfirmations")?;
        let mut parents=Parents::new(material)?;let mut parsed=BTreeMap::new();let mut seen=BTreeSet::new();
        let mut deposits:Vec<_>=material.snapshot.payload.utxos.iter().filter(|u|permitted(request,&u.txid,u.vout)).collect();
        deposits.sort_by(|a,b|(&a.txid,a.vout).cmp(&(&b.txid,b.vout)));
        if deposits.is_empty() || deposits.len()>MAX_SIGNING_PLAN_INPUTS {return Err(missing("HTLC selected deposits missing or over bound"));}
        let mut inputs=vec![];
        for u in deposits {
            if u.classification!="htlc" || u.contract_id.is_some() || !seen.insert((&u.txid,u.vout)) {
                return Err(missing("HTLC native deposit classification or identity invalid"));
            }
            if !crate::confirmations::meets_minimum(u.confirmations.as_deref(),minimum,"snapshot.payload.utxos.confirmations")? {
                return Err(missing("HTLC deposit does not meet confirmation policy"));
            }
            if !parsed.contains_key(&u.txid) {
                let tx=Transaction::from_bytes(parents.bytes(&u.txid)?).map_err(|_|missing("HTLC parent invalid"))?;
                if tx.txid().to_string()!=u.txid {return Err(missing("HTLC parent hash differs from selected outpoint"));}
                parsed.insert(u.txid.clone(),tx);
            }
            let out=parsed[&u.txid].outputs.get(u.vout as usize).ok_or_else(||missing("HTLC parent output missing"))?;
            if u.satoshis!=out.satoshis.to_string() || u.script_pub_key!=hex(out.script_pubkey.as_bytes()) {
                return Err(missing("HTLC descriptor differs from authenticated parent"));
            }
            inputs.push(UtxoInfo {outpoint:OutPoint{txid:u.txid.parse().map_err(|_|missing("Invalid HTLC deposit txid"))?,vout:u.vout},
                satoshis:out.satoshis,script_pubkey:out.script_pubkey.clone()});
        }
        let branch=if request.intent.intent_type=="tbc-htlc-claim" {
            SpendBranch::Claim(decode_hex(request.intent.preimage.as_deref().unwrap(),"request.intent.preimage")?)
        }else{SpendBranch::Refund};
        let plan=build_spend_plan(&inputs,&public,&branch,height,mtp,maximum)?;
        validate_amount_limit(plan.unsigned_plan.transactions[0].outputs[0].satoshis,policy)?;plan
    };
    let amount=built.unsigned_plan.transactions[0].outputs[0].satoshis.to_string();
    let warnings=if request.intent.intent_type=="tbc-htlc-claim" {
        vec!["HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE".into()]
    }else{vec![]};
    finish_with_warnings(request,material,built.unsigned_plan,vec![built.fee],vec![AssetFlow {
        kind:"native".into(),direction:if lock{"lock"}else{"unlock"}.into(),amount,contract_id:None,
        from:request.from.clone(),to:Some(if lock{request.intent.to.as_ref().unwrap().clone()}else{request.from.clone()}),
    }],warnings)
}
