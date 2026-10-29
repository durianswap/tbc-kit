use serde_json::Value;
use std::cmp::Ordering;

use crate::families::{
    ft::{plan_ft, public_signing_context},
    nft::plan_nft,
    pool::plan_pool,
    stablecoin::plan_stablecoin_transfer,
    tbc::{plan_tbc_merge, plan_tbc_transfer},
    tbc20::plan_tbc20,
    tbc721::plan_tbc721,
    coin::plan_coin,
};
use crate::model::{
    CanonicalRequest, ChainSnapshot, ExecutionPolicy, PlanParams, WIRE_VERSION, WalletMaterial,
    error, parse_input, to_value,
};
use crate::normalize::{canonical_hash, validate_request, validate_version};
use crate::{EngineError, ErrorCode};

pub(crate) fn plan(input: Value) -> Result<Value, EngineError> {
    reject_unsupported_intent(&input)?;
    let params: PlanParams = parse_input(input)?;
    let planned = computation(&params)?;
    to_value(planned.result)
}

#[derive(Clone, Copy)]
struct BorrowedPlanParams<'a> {
    version: &'a str,
    request: &'a CanonicalRequest,
    request_hash: &'a str,
    snapshot: &'a ChainSnapshot,
    policy: &'a ExecutionPolicy,
}

impl<'a> From<&'a PlanParams> for BorrowedPlanParams<'a> {
    fn from(params: &'a PlanParams) -> Self {
        Self {
            version: &params.version,
            request: &params.request,
            request_hash: &params.request_hash,
            snapshot: &params.snapshot,
            policy: &params.policy,
        }
    }
}

fn validate_plan_material(params: BorrowedPlanParams<'_>) -> Result<(), EngineError> {
    validate_version(params.version, "version")?;
    validate_request(params.request)?;
    crate::confirmations::validate_minimum(&params.policy.payload.min_confirmations)?;
    if params.snapshot.payload.utxos.len() > 10_000 {
        return Err(error(
            ErrorCode::InvalidInput,
            "snapshot exceeds the 10000 UTXO schema limit",
            "snapshot.payload.utxos",
        ));
    }
    if params.snapshot.payload.parents.len() > 10_000 {
        return Err(error(
            ErrorCode::InvalidInput,
            "snapshot exceeds the 10000 parent transaction schema limit",
            "snapshot.payload.parents",
        ));
    }
    if params.snapshot.payload.contracts.len() > 1_024 {
        return Err(error(
            ErrorCode::InvalidInput,
            "snapshot exceeds the 1024 contract schema limit",
            "snapshot.payload.contracts",
        ));
    }
    if let Some(expires_at) = params
        .request
        .constraints
        .as_ref()
        .and_then(|constraints| constraints.expires_at.as_deref())
    {
        validate_canonical_timestamp(expires_at, "request.constraints.expiresAt")?;
    }
    validate_canonical_timestamp(
        &params.snapshot.payload.captured_at,
        "snapshot.payload.capturedAt",
    )?;
    validate_canonical_timestamp(
        &params.snapshot.payload.expires_at,
        "snapshot.payload.expiresAt",
    )?;
    validate_canonical_timestamp(
        &params.policy.payload.expires_at,
        "policy.payload.expiresAt",
    )?;
    if canonical_hash(params.request)? != params.request_hash {
        return Err(error(
            ErrorCode::InvalidInput,
            "request hash does not bind the canonical request",
            "requestHash",
        ));
    }
    if canonical_hash(&params.snapshot.payload)? != params.snapshot.snapshot_hash {
        return Err(error(
            ErrorCode::InvalidAncestry,
            "snapshot hash does not bind the supplied wallet material",
            "snapshot.snapshotHash",
        ));
    }
    if canonical_hash(&params.policy.payload)? != params.policy.policy_hash {
        return Err(error(
            ErrorCode::InvalidInput,
            "policy hash does not bind the supplied policy",
            "policy.policyHash",
        ));
    }
    if params.policy.payload.max_bundle_transactions < 1 {
        return Err(error(
            ErrorCode::InvalidInput,
            "policy does not permit a transaction",
            "policy.payload.maxBundleTransactions",
        ));
    }
    crate::signing_wire::SigningAccounts::resolve(params.request, &params.snapshot.payload)?;
    if !matches!(
        params.request.intent.intent_type.as_str(),
        "tbc.transfer" | "tbc.maintenance.merge" | "tbc.collection.create" | "tbc.nft.mint" | "tbc.nft.transfer"
            | "tbc.ft.create" | "tbc.ft.transfer" | "tbc.ft.merge" | "tbc.stablecoin.transfer" | "tbc.stablecoin.merge"
            | "tbc.pool.create" | "tbc.pool.liquidity.add" | "tbc.pool.liquidity.remove"
            | "tbc.pool.liquidity.close" | "tbc.pool.swap.exactTbcForToken"
            | "tbc.pool.swap.exactTokenForTbc" | "tbc.pool.ft.merge" | "tbc.pool.ftlp.merge" | "tbc.pool.ftlp.burn"
            | "tbc20-standard-create" | "tbc20-standard-transfer" | "tbc20-standard-merge"
    ) && !crate::normalize::TBC721_INTENTS.contains(&params.request.intent.intent_type.as_str())
        && !crate::normalize::COIN_INTENTS.contains(&params.request.intent.intent_type.as_str())
        && !crate::normalize::LP_INTENTS.contains(&params.request.intent.intent_type.as_str())
        && !crate::normalize::AMM_INTENTS.contains(&params.request.intent.intent_type.as_str())
        && !crate::normalize::TIMELOCK_INTENTS.contains(&params.request.intent.intent_type.as_str())
        && !crate::normalize::HTLC_INTENTS.contains(&params.request.intent.intent_type.as_str())
        && !crate::normalize::LOP_INTENTS.contains(&params.request.intent.intent_type.as_str())
        && !crate::business::is_unified(&params.request.intent.intent_type) {
        return Err(error(
            ErrorCode::UnsupportedIntent,
            "unsupported transaction intent",
            "request.intent.type",
        ));
    }
    Ok(())
}

pub(crate) fn validate_canonical_timestamp(
    value: &str,
    path: &str,
) -> Result<(), EngineError> {
    let bytes = value.as_bytes();
    let fraction = (bytes.len() == 20 && bytes.get(19) == Some(&b'Z'))
        || ((22..=24).contains(&bytes.len())
            && bytes.get(19) == Some(&b'.')
            && bytes.last() == Some(&b'Z')
            && bytes[20..bytes.len() - 1].iter().all(u8::is_ascii_digit));
    let fixed = fraction
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.get(10) == Some(&b'T')
        && bytes.get(13) == Some(&b':')
        && bytes.get(16) == Some(&b':');
    let decimal = |start: usize, end: usize| -> Option<u32> {
        bytes.get(start..end)?.iter().try_fold(0u32, |value, byte| {
            byte.is_ascii_digit()
                .then(|| value * 10 + u32::from(*byte - b'0'))
        })
    };
    let valid = fixed
        && match (
            decimal(0, 4),
            decimal(5, 7),
            decimal(8, 10),
            decimal(11, 13),
            decimal(14, 16),
            decimal(17, 19),
        ) {
            (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) => {
                let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
                let days = match month {
                    1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
                    4 | 6 | 9 | 11 => 30,
                    2 if leap => 29,
                    2 => 28,
                    _ => 0,
                };
                day >= 1 && day <= days && hour < 24 && minute < 60 && second < 60
            }
            _ => false,
        };
    if !valid {
        return Err(error(
            ErrorCode::InvalidInput,
            "timestamp must be valid UTC seconds or milliseconds",
            path,
        ));
    }
    Ok(())
}

pub(crate) fn compare_canonical_timestamps(
    left: &str,
    left_path: &str,
    right: &str,
    right_path: &str,
) -> Result<Ordering, EngineError> {
    validate_canonical_timestamp(left, left_path)?;
    validate_canonical_timestamp(right, right_path)?;
    // Mixed precision cannot be compared lexically: '.001Z' sorts before 'Z'.
    // Validation above makes the fixed calendar prefix safe to compare. Keep
    // original timestamp strings intact for canonical hashes and bindings.
    let millis = |value: &str| -> u32 {
        if value.len() == 20 { return 0; }
        let digits = &value.as_bytes()[20..value.len() - 1];
        digits.iter().fold(0, |n, byte| n * 10 + u32::from(*byte - b'0'))
            * 10u32.pow(3 - digits.len() as u32)
    };
    Ok(left[..19].cmp(&right[..19]).then_with(|| millis(left).cmp(&millis(right))))
}

pub(crate) fn earliest_canonical_timestamp<'a>(
    values: impl IntoIterator<Item = &'a str>,
) -> Result<&'a str, EngineError> {
    let mut earliest: Option<&str> = None;
    for value in values {
        validate_canonical_timestamp(value, "expiry")?;
        earliest = Some(match earliest {
            None => value,
            Some(current) => {
                let order = compare_canonical_timestamps(value, "expiry", current, "expiry")?;
                // Tie-break on original text, without rewriting a bound value.
                if order.is_lt() || (order.is_eq() && value < current) { value } else { current }
            }
        });
    }
    earliest.ok_or_else(|| error(ErrorCode::InvalidInput, "missing expiry", "expiry"))
}

pub(crate) fn computation(params: &PlanParams) -> Result<crate::model::PlannedTransfer, EngineError> {
    computation_material(BorrowedPlanParams::from(params))
}

#[cfg(test)]
mod protocol_time_tests {
    use super::{compare_canonical_timestamps, validate_canonical_timestamp, earliest_canonical_timestamp};
    use std::cmp::Ordering;

    #[test]
    fn mixed_precision_orders_instants_not_wire_strings() {
        let compare = |a, b| compare_canonical_timestamps(a, "a", b, "b").unwrap();
        assert_eq!(compare("2026-10-07T00:00:00Z", "2026-10-07T00:00:00.000Z"), Ordering::Equal);
        assert_eq!(compare("2026-10-07T00:00:00.001Z", "2026-10-07T00:00:00Z"), Ordering::Greater);
        assert_eq!(compare("2026-10-07T00:00:00.1Z", "2026-10-07T00:00:00.100Z"), Ordering::Equal);
        assert_eq!(compare("2026-10-07T00:00:00.122Z", "2026-10-07T00:00:00.123Z"), Ordering::Less);
        assert_eq!(compare("2026-10-07T00:00:00.999Z", "2026-10-07T00:00:01Z"), Ordering::Less);
        assert_eq!(earliest_canonical_timestamp([
            "2026-10-07T00:00:00.999Z", "2026-10-07T00:00:00Z",
        ]).unwrap(), "2026-10-07T00:00:00Z");
    }

    #[test]
    fn calendar_and_precision_remain_strict() {
        for value in ["", "2026-02-30T00:00:00Z", "2026-10-07T24:00:00Z", "2026-10-07T00:00:60Z",
            "2026-10-07T00:00:00.123456Z", "2026-10-07T00:00:00+00:00", "2026-10-07T00:00:00.Z"] {
            assert!(validate_canonical_timestamp(value, "time").is_err(), "{value}");
        }
        assert!(validate_canonical_timestamp("2024-02-29T00:00:00.12Z", "time").is_ok());
    }
}

pub(crate) fn computation_borrowed(
    version: &str,
    request: &CanonicalRequest,
    request_hash: &str,
    snapshot: &ChainSnapshot,
    policy: &ExecutionPolicy,
) -> Result<crate::model::PlannedTransfer, EngineError> {
    computation_material(BorrowedPlanParams {
        version,
        request,
        request_hash,
        snapshot,
        policy,
    })
}

fn computation_material(
    params: BorrowedPlanParams<'_>,
) -> Result<crate::model::PlannedTransfer, EngineError> {
    validate_plan_material(params)?;
    // Normalization may still describe historical wire requests, but no public
    // plan/validation/finalization (including restored checkpoints) may execute
    // new historical issuance. Keep the archived builders until approved removal.
    // Existing-pool liquidity and its LP issuance are deliberately not blocked.
    if matches!(params.request.intent.intent_type.as_str(),
        "tbc.ft.create" | "tbc.nft.mint" | "tbc.pool.create") {
        return Err(error(ErrorCode::UnsupportedIntent,
            "historical asset issuance is disabled", "request.intent.type"));
    }
    let material = WalletMaterial {
        snapshot: params.snapshot,
        policy: params.policy,
        planned_native: None,
    };
    // The on-demand wrapper preserves successful plans and explicitly selects
    // new-profile dust/fee assembly; legacy fee reconciliation remains separate.
    if params.request.intent.intent_type == "tbc721.batchTransfer" {
        crate::families::nft_batch::plan(params.request, &material, &public_signing_context(&material)?)
    } else if crate::business::is_unified(&params.request.intent.intent_type) {
        let resolved = crate::business::resolve(params.request, &material)?;
        let mut planned = dispatch_with_funding(&resolved, &material)?;
        // Derivation occurs before approval and is repeatable at every validation
        // and finalization boundary. Never replace the caller's canonical request.
        planned.result.plan.payload.request_hash = params.request_hash.to_owned();
        // This is derived from the builder that actually succeeded, not an API
        // label or a DApp hint. It participates in the existing approval hash
        // and is recomputed by validation/finalization, without another read.
        planned.result.plan.payload.preview.contract_execution = Some(crate::model::ContractExecution {
            business_type: params.request.intent.intent_type.clone(),
            implementation: resolved.intent.intent_type.clone(),
            generation: if resolved.intent.intent_type.starts_with("tbc.") {"historical"} else {"current"}.into(),
        });
        planned.result.plan.plan_hash = canonical_hash(&planned.result.plan.payload)?;
        planned.resolved_request = Some(resolved);
        Ok(planned)
    } else {
        dispatch_with_funding(params.request, &material)
    }
}

fn dispatch_with_funding(request:&CanonicalRequest,material:&WalletMaterial<'_>)->Result<crate::model::PlannedTransfer,EngineError> {
    if matches!(request.intent.intent_type.as_str(),"tbc20-stablecoin-transfer"|"tbc20-stablecoin-merge") {
        crate::families::coin::plan_coin_with_funding(request,material,&public_signing_context(material)?)
    } else {
        crate::funding_fallback::plan_with_funding(request,material,dispatch_business)
    }
}

fn dispatch_business(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
) -> Result<crate::model::PlannedTransfer, EngineError> {
    match request.intent.intent_type.as_str() {
        "tbc-lop-create"=>crate::families::lop::plan_create(request,material,&public_signing_context(material)?),
        "tbc-lop-cancel"=>crate::families::lop::plan_cancel(request,material,&public_signing_context(material)?),
        "tbc-lop-match"=>crate::families::lop::plan_match(request,material,&public_signing_context(material)?),
        kind if crate::normalize::HTLC_INTENTS.contains(&kind)=>crate::families::htlc::plan_htlc(request,material,&public_signing_context(material)?),
        kind if crate::normalize::TIMELOCK_INTENTS.contains(&kind)=>crate::families::timelock::plan_timelock(request,material,&public_signing_context(material)?),
        "tbc-amm-create"=>crate::families::amm::plan_create(request,material,&public_signing_context(material)?),
        kind if crate::normalize::AMM_INTENTS.contains(&kind)=>crate::families::amm_actions::plan_action(request,material,&public_signing_context(material)?),
        kind if crate::normalize::LP_INTENTS.contains(&kind)=>crate::families::lp::plan_lp(request,material,&public_signing_context(material)?),
        kind if crate::normalize::COIN_INTENTS.contains(&kind) => {
            plan_coin(request, material, &public_signing_context(material)?)
        }
        kind if crate::normalize::TBC721_INTENTS.contains(&kind) => {
            plan_tbc721(request, material, &public_signing_context(material)?)
        }
        "tbc20-standard-create" | "tbc20-standard-transfer" | "tbc20-standard-merge" => {
            let signing = public_signing_context(material)?;
            plan_tbc20(request, material, &signing)
        }
        "tbc.transfer" => plan_tbc_transfer(request, material),
        "tbc.maintenance.merge" => plan_tbc_merge(request, material),
        "tbc.ft.create" | "tbc.ft.transfer" | "tbc.ft.merge" => {
            let signing = public_signing_context(&material)?;
            plan_ft(request, material, &signing)
        }
        "tbc.collection.create" | "tbc.nft.mint" | "tbc.nft.transfer" => {
            let signing = public_signing_context(&material)?;
            plan_nft(request, material, &signing)
        }
        "tbc.stablecoin.transfer" | "tbc.stablecoin.merge" => {
            let signing = public_signing_context(&material)?;
            plan_stablecoin_transfer(request, material, &signing)
        }
        "tbc.pool.create" | "tbc.pool.liquidity.add" | "tbc.pool.liquidity.remove"
        | "tbc.pool.liquidity.close" | "tbc.pool.swap.exactTbcForToken"
        | "tbc.pool.swap.exactTokenForTbc" | "tbc.pool.ft.merge"
        | "tbc.pool.ftlp.merge" | "tbc.pool.ftlp.burn" => {
            let signing = public_signing_context(&material)?;
            plan_pool(request, material, &signing)
        }
        _ => Err(error(
            ErrorCode::UnsupportedIntent,
            "unsupported transaction intent",
            "request.intent.type",
        )),
    }
}

fn reject_unsupported_intent(input: &Value) -> Result<(), EngineError> {
    if input.get("request").and_then(|r| r.get("intent")).and_then(|i| i.get("type"))
        .and_then(Value::as_str).is_some_and(crate::business::is_unified) { return Ok(()); }
    let intent = input
        .get("request")
        .and_then(|request| request.get("intent"))
        .and_then(|intent| intent.get("type"))
        .and_then(Value::as_str);
    if let Some(intent) = intent
        && !matches!(intent, "tbc.transfer" | "tbc.maintenance.merge" | "tbc.collection.create" | "tbc.nft.mint" | "tbc.nft.transfer" | "tbc.ft.create" | "tbc.ft.transfer" | "tbc.ft.merge" | "tbc.stablecoin.transfer" | "tbc.stablecoin.merge" | "tbc.pool.create" | "tbc.pool.liquidity.add" | "tbc.pool.liquidity.remove" | "tbc.pool.liquidity.close" | "tbc.pool.swap.exactTbcForToken" | "tbc.pool.swap.exactTokenForTbc" | "tbc.pool.ft.merge" | "tbc.pool.ftlp.merge" | "tbc.pool.ftlp.burn" | "tbc20-standard-create" | "tbc20-standard-transfer" | "tbc20-standard-merge")
        && !crate::normalize::TBC721_INTENTS.contains(&intent)
        && !crate::normalize::COIN_INTENTS.contains(&intent)
        && !crate::normalize::LP_INTENTS.contains(&intent)
        && !crate::normalize::AMM_INTENTS.contains(&intent)
        && !crate::normalize::TIMELOCK_INTENTS.contains(&intent)
        && !crate::normalize::HTLC_INTENTS.contains(&intent)
        && !crate::normalize::LOP_INTENTS.contains(&intent)
    {
        return Err(error(
            ErrorCode::UnsupportedIntent,
            format!("unsupported transaction intent: {intent}"),
            "request.intent.type",
        ));
    }
    let _ = WIRE_VERSION;
    Ok(())
}

#[cfg(test)]
mod issuance_policy_tests {
    use super::*;
    use serde_json::json;
    use crate::{call_json, EngineMethod};

    fn base() -> Value {
        serde_json::from_str(include_str!("../../../fixtures/tbc-transfer.json")).unwrap()
    }
    fn call(method: EngineMethod, input: &Value) -> Value {
        let result: Value = serde_json::from_str(&call_json(method, &input.to_string())).unwrap();
        if std::env::var_os("ISSUANCE_POLICY_DUMP_WIRE").is_some() {
            // Synthetic, public test fixtures only. The parity runner captures
            // these records in memory and never forwards transaction material.
            let name = match method {
                EngineMethod::NormalizeRequest => "normalizeRequest",
                EngineMethod::Plan => "plan",
                EngineMethod::Validate => "validate",
                EngineMethod::Finalize => "finalize",
            };
            println!("ISSUANCE_POLICY_WIRE:{}", json!({"method":name,"input":input,"result":result}));
        }
        result
    }
    fn request(intent: Value) -> PlanParams {
        let mut value = base()["planInput"].clone();
        value["request"]["intent"] = intent;
        value["request"]["constraints"]["maxFee"] = json!("5000");
        let normalized = call(EngineMethod::NormalizeRequest, &json!({"version":"1.0", "request":value["request"]}));
        assert_eq!(normalized["ok"], true, "normalization remains non-executing: {normalized}");
        value["request"] = normalized["result"]["request"].clone();
        value["requestHash"] = normalized["result"]["requestHash"].clone();
        parse_input(value).unwrap()
    }
    #[test]
    fn disabled_issuance_never_produces_a_public_plan() {
        let fixtures = [
            include_str!("../../../fixtures/ft-create-v4.json"),
            include_str!("../../../fixtures/nft-mint.json"),
            include_str!("../../../fixtures/pool-create.json"),
        ];
        for fixture in fixtures {
            let mut intent = serde_json::from_str::<Value>(fixture).unwrap()["intent"].clone();
            // These fixture IDs are placeholders for later material binding.
            for field in ["collectionId", "ftContractId", "poolContractId"] {
                if intent.get(field).is_some() { intent[field] = json!("11".repeat(32)); }
            }
            let params = request(intent);
            let result = call(EngineMethod::Plan, &serde_json::to_value(params).unwrap());
            assert_eq!(result["error"]["code"], "UNSUPPORTED_INTENT", "{result}");
            assert_eq!(result["error"]["message"], "historical asset issuance is disabled");
            assert!(result.get("result").is_none());
        }
        // Shared collection scripts carry no old/current covenant discriminator.
        // Keep one positive wire case alongside the three prohibited issuances.
        let collection: Value = serde_json::from_str(include_str!("../../../fixtures/collection-create.json")).unwrap();
        let params = request(collection["intent"].clone());
        let result = call(EngineMethod::Plan, &serde_json::to_value(params).unwrap());
        assert_eq!(result["ok"], true, "shared collection must remain usable: {result}");
    }
    #[test]
    fn authentic_prior_ft_creation_plan_cannot_be_validated_or_resumed() {
        let fixture: Value = serde_json::from_str(include_str!("../../../fixtures/ft-create-v4.json")).unwrap();
        let params = request(fixture["intent"].clone());
        // Exercise retained internal construction solely to model an authentic
        // pre-policy checkpoint. No production option bypasses public policy.
        let material = WalletMaterial { snapshot: &params.snapshot, policy: &params.policy, planned_native: None };
        let old = dispatch_business(&params.request, &material).unwrap();
        let plan = serde_json::to_value(&old.result.plan).unwrap();
        let mut value = serde_json::to_value(&params).unwrap();
        value["plan"] = plan.clone();
        value["phase"] = json!("plan");
        assert_eq!(call(EngineMethod::Validate, &value)["result"]["valid"], false);

        let mut binding = base()["finalizeInput"]["binding"].clone();
        binding["payload"]["requestHash"] = json!(params.request_hash);
        binding["payload"]["operationHash"] = plan["planHash"].clone();
        binding["payload"]["expiresAt"] = plan["payload"]["expiresAt"].clone();
        binding["bindingHash"] = json!(canonical_hash(&binding["payload"]).unwrap());
        let mut approval = base()["finalizeInput"]["approval"].clone();
        approval["bindingHash"] = binding["bindingHash"].clone();
        approval["expiresAt"] = plan["payload"]["expiresAt"].clone();
        value.as_object_mut().unwrap().remove("phase");
        value["binding"] = binding;
        value["approval"] = approval;
        value["signatures"] = json!([]);
        let result = call(EngineMethod::Finalize, &value);
        assert_eq!(result["error"]["code"], "UNSUPPORTED_INTENT", "{result}");
        assert_eq!(result["error"]["message"], "historical asset issuance is disabled");
        for phase in ["pre-sign", "finalized", "pre-broadcast"] {
            value["phase"] = json!(phase);
            let checked = call(EngineMethod::Validate, &value);
            assert!(checked["ok"] == false || checked["result"]["valid"] == false, "{checked}");
        }
    }
}
