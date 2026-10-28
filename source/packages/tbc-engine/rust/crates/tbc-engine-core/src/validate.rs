use serde_json::Value;

use crate::families::{
    ft::validate_ft_plan,
    nft::validate_nft_plan,
    pool::validate_pool_plan,
    tbc::{validate_tbc_merge, validate_tbc_transfer},
    tbc20::validate_tbc20_plan,
    tbc721::validate_tbc721_plan,
};
use crate::finalize::{finalize_with_computation, validate_approval_binding};
use crate::model::{
    FinalizeOutcome, FinalizeParams, ValidateParams, ValidationResult, Violation,
    error, parse_input, to_value,
};
use crate::normalize::canonical_hash;
use crate::plan::{compare_canonical_timestamps, computation_borrowed, validate_canonical_timestamp};
use crate::{EngineError, ErrorCode};

pub(crate) fn validate(input: Value) -> Result<Value, EngineError> {
    let mut params: ValidateParams = parse_input(input)?;
    if !["plan", "pre-sign", "finalized", "pre-broadcast"].contains(&params.phase.as_str()) {
        return Err(error(
            ErrorCode::InvalidInput,
            "unsupported validation phase",
            "phase",
        ));
    }
    let mut violations = Vec::new();
    validate_phase_material(&params, &mut violations);
    collect_expiry_violations(&params, &mut violations);
    if canonical_hash(&params.plan.payload)? != params.plan.plan_hash {
        violations.push(violation("PLAN_HASH_MISMATCH", "plan.planHash"));
    }
    let expected_computation = computation_borrowed(
        &params.version,
        &params.request,
        &params.request_hash,
        &params.snapshot,
        &params.policy,
    );
    match &expected_computation {
        Ok(expected) => {
            let business_plan = expected.business_plan.as_ref().unwrap_or(&expected.unsigned_plan);
            let business_request = expected.resolved_request.as_ref().unwrap_or(&params.request);
            if business_request.intent.intent_type == "tbc721.batchTransfer" {
                violations.extend(crate::families::nft_batch::validate_plan(business_request, business_plan));
            } else if business_request.intent.intent_type == "tbc.transfer" {
                violations.extend(validate_tbc_transfer(business_request, &expected.unsigned_plan));
            } else if business_request.intent.intent_type == "tbc.maintenance.merge" {
                violations.extend(validate_tbc_merge(business_request, &expected.unsigned_plan));
            } else if matches!(business_request.intent.intent_type.as_str(), "tbc.collection.create" | "tbc.nft.mint" | "tbc.nft.transfer") {
                violations.extend(validate_nft_plan(business_request, business_plan));
            } else if business_request.intent.intent_type.starts_with("tbc20-standard-")
                || crate::normalize::LP_INTENTS.contains(&business_request.intent.intent_type.as_str())
                || crate::normalize::TIMELOCK_INTENTS.contains(&business_request.intent.intent_type.as_str())
                || crate::normalize::HTLC_INTENTS.contains(&business_request.intent.intent_type.as_str())
                || crate::normalize::LOP_INTENTS.contains(&business_request.intent.intent_type.as_str())
                || crate::normalize::AMM_INTENTS.contains(&business_request.intent.intent_type.as_str())
                || crate::normalize::COIN_INTENTS.contains(&business_request.intent.intent_type.as_str()) {
                violations.extend(validate_tbc20_plan(business_request, business_plan));
            } else if crate::normalize::TBC721_INTENTS.contains(&business_request.intent.intent_type.as_str()) {
                violations.extend(validate_tbc721_plan(business_request, business_plan));
            } else if business_request.intent.intent_type.starts_with("tbc.pool.") {
                violations.extend(validate_pool_plan(business_request, business_plan));
            } else {
                violations.extend(validate_ft_plan(business_request, business_plan));
            }
            if params
                .plan
                .payload
                .transactions
                .iter()
                .map(|item| &item.fee)
                .collect::<Vec<_>>()
                != expected
                    .result
                    .plan
                    .payload
                    .transactions
                    .iter()
                    .map(|item| &item.fee)
                    .collect::<Vec<_>>()
            {
                violations.push(violation("FEE_MISMATCH", "plan.payload.transactions[0].fee"));
            }
            if params.plan.payload.transactions != expected.result.plan.payload.transactions {
                violations.push(violation("BUSINESS_OUTPUT_MISMATCH", "plan.payload.transactions"));
            }
            if params.plan.payload.signing_tasks != expected.result.plan.payload.signing_tasks {
                violations.push(violation("SIGNING_TASK_MISMATCH", "plan.payload.signingTasks"));
            }
            if params.plan.payload.request_hash != params.request_hash {
                violations.push(violation("REQUEST_HASH_MISMATCH", "plan.payload.requestHash"));
            }
            if params.plan.payload.snapshot_hash != params.snapshot.snapshot_hash {
                violations.push(violation("SNAPSHOT_HASH_MISMATCH", "plan.payload.snapshotHash"));
            }
            if params.plan.payload.policy_hash != params.policy.policy_hash {
                violations.push(violation("POLICY_HASH_MISMATCH", "plan.payload.policyHash"));
            }
            if params.plan != expected.result.plan {
                violations.push(violation("PLAN_HASH_MISMATCH", "plan"));
            }
            if params.request.intent.intent_type == "tbc.transfer"
                && (expected.output_roles.first() != Some(&crate::model::OutputRole::Recipient)
                    || expected
                        .output_roles
                        .iter()
                        .skip(1)
                        .any(|role| *role != crate::model::OutputRole::Change))
            {
                violations.push(violation("CHANGE_NOT_CONTROLLED", "plan.payload.transactions[0]"));
            }
            if params.request.intent.intent_type == "tbc.maintenance.merge"
                && expected.output_roles != [crate::model::OutputRole::Change]
            {
                violations.push(violation("CHANGE_NOT_CONTROLLED", "plan.payload.transactions[0]"));
            }
        }
        Err(source) => violations.push(violation(
            match source.code {
                ErrorCode::InvalidAncestry => "ANCESTRY_INVALID",
                ErrorCode::InvalidInput if is_timestamp_path(source.path.as_deref()) => {
                    if source
                        .path
                        .as_deref()
                        .is_some_and(|path| path == "snapshot.payload.capturedAt")
                    {
                        "SNAPSHOT_EXPIRED"
                    } else {
                        "PLAN_EXPIRED"
                    }
                }
                ErrorCode::InvalidInput if source.path.as_deref().is_some_and(|path| path.contains("minimum")) => "INTENT_OUTPUT_MISMATCH",
                ErrorCode::InsufficientFunds | ErrorCode::InvalidInput => "AMOUNT_OUT_OF_RANGE",
                ErrorCode::FeeCapExceeded => "FEE_LIMIT_EXCEEDED",
                _ => "BUSINESS_OUTPUT_MISMATCH",
            },
            source.path.as_deref().unwrap_or("input"),
        )),
    }
    if matches!(params.phase.as_str(), "finalized" | "pre-broadcast")
        && params.binding.is_some()
        && params.approval.is_some()
        && params.signatures.is_some()
        && validate_approval_binding(
            &params.version,
            &params.request,
            &params.request_hash,
            &params.plan,
            params.binding.as_ref().expect("checked binding"),
            params.approval.as_ref().expect("checked approval"),
        )
        .is_ok()
    {
        let expected_bundle = params.bundle.take();
        let expected_pending = params.pending.take();
        let finalize_params = FinalizeParams {
            version: params.version,
            request: params.request,
            request_hash: params.request_hash,
            snapshot: params.snapshot,
            policy: params.policy,
            plan: params.plan,
            binding: params.binding.take().expect("checked binding"),
            approval: params.approval.take().expect("checked approval"),
            signatures: params.signatures.take().expect("checked signatures"),
            continuation: params.continuation.take(),
        };
        match finalize_with_computation(finalize_params, Some(expected_computation)) {
            Ok(FinalizeOutcome::Complete(recomputed)) if expected_bundle.is_some() && expected_pending.is_none() => {
                let bundle = expected_bundle.as_ref().expect("guarded complete bundle");
                if recomputed.bundle.transactions.iter().map(|tx| &tx.txid).collect::<Vec<_>>()
                    != bundle.transactions.iter().map(|tx| &tx.txid).collect::<Vec<_>>()
                {
                    violations.push(violation("TXID_MISMATCH", "bundle.transactions"));
                }
                if recomputed.bundle != *bundle {
                    violations.push(violation("ARTIFACT_MISMATCH", "bundle"));
                }
            }
            Ok(FinalizeOutcome::Pending(recomputed))
                if expected_pending.is_some() && expected_bundle.is_none() =>
            {
                if expected_pending.as_ref() != Some(&recomputed) {
                    violations.push(violation("ARTIFACT_MISMATCH", "pending"));
                }
            }
            Ok(_) => violations.push(violation("ARTIFACT_MISMATCH", "result")),
            Err(source) => violations.push(violation(
                match source.code {
                    ErrorCode::InvalidSignature | ErrorCode::MissingSignature => "SIGNATURE_INVALID",
                    _ => "ARTIFACT_MISMATCH",
                },
                source.path.as_deref().unwrap_or("input"),
            )),
        }
    }
    violations.sort_by(|left, right| {
        violation_rank(&left.code)
            .cmp(&violation_rank(&right.code))
            .then_with(|| left.path.cmp(&right.path))
    });
    violations.dedup();
    to_value(ValidationResult {
        valid: violations.is_empty(),
        violations,
    })
}

fn collect_expiry_violations(params: &ValidateParams, violations: &mut Vec<Violation>) {
    let request_expiry = params
        .request
        .constraints
        .as_ref()
        .and_then(|constraints| constraints.expires_at.as_deref());
    let candidate_expiries = [
        request_expiry,
        Some(params.snapshot.payload.expires_at.as_str()),
        Some(params.policy.payload.expires_at.as_str()),
    ];
    let candidates_valid = candidate_expiries.iter().flatten().all(|value| {
        validate_canonical_timestamp(value, "expiry").is_ok()
    });
    let plan_valid = validate_canonical_timestamp(
        &params.plan.payload.expires_at,
        "plan.payload.expiresAt",
    )
    .is_ok();
    let captured_valid = validate_canonical_timestamp(
        &params.snapshot.payload.captured_at,
        "snapshot.payload.capturedAt",
    )
    .is_ok();
    let snapshot_valid = validate_canonical_timestamp(
        &params.snapshot.payload.expires_at,
        "snapshot.payload.expiresAt",
    )
    .is_ok();

    if !candidates_valid || !plan_valid {
        violations.push(violation("PLAN_EXPIRED", "plan.payload.expiresAt"));
    } else {
        let earliest = crate::plan::earliest_canonical_timestamp(
            candidate_expiries.iter().flatten().copied(),
        ).expect("snapshot and policy expiry have been validated above");
        if params.plan.payload.expires_at != earliest
            || (captured_valid
                && compare_canonical_timestamps(
                    earliest,
                    "expiry",
                    &params.snapshot.payload.captured_at,
                    "snapshot.payload.capturedAt",
                )
                .is_ok_and(|order| !order.is_gt()))
        {
            violations.push(violation("PLAN_EXPIRED", "plan.payload.expiresAt"));
        }
    }

    if !captured_valid
        || !snapshot_valid
        || compare_canonical_timestamps(
            &params.snapshot.payload.captured_at,
            "snapshot.payload.capturedAt",
            &params.snapshot.payload.expires_at,
            "snapshot.payload.expiresAt",
        )
        .is_ok_and(|order| !order.is_lt())
    {
        violations.push(violation(
            "SNAPSHOT_EXPIRED",
            "snapshot.payload.expiresAt",
        ));
    }

    if params.phase != "plan"
        && let (Some(binding), Some(approval)) = (&params.binding, &params.approval)
    {
        let approval_expired = compare_canonical_timestamps(
            &approval.approved_at,
            "approval.approvedAt",
            &approval.expires_at,
            "approval.expiresAt",
        )
        .is_ok_and(|order| !order.is_lt());
        let receipt_exceeds_binding = compare_canonical_timestamps(
            &approval.expires_at,
            "approval.expiresAt",
            &binding.payload.expires_at,
            "binding.payload.expiresAt",
        )
        .is_ok_and(|order| order.is_gt());
        let receipt_exceeds_plan = compare_canonical_timestamps(
            &approval.expires_at,
            "approval.expiresAt",
            &params.plan.payload.expires_at,
            "plan.payload.expiresAt",
        )
        .is_ok_and(|order| order.is_gt());
        let approval_times_valid = validate_canonical_timestamp(
            &approval.approved_at,
            "approval.approvedAt",
        )
        .is_ok()
            && validate_canonical_timestamp(&approval.expires_at, "approval.expiresAt").is_ok()
            && validate_canonical_timestamp(
                &binding.payload.expires_at,
                "binding.payload.expiresAt",
            )
            .is_ok();
        if !approval_times_valid
            || approval_expired
            || receipt_exceeds_binding
            || receipt_exceeds_plan
        {
            violations.push(violation("PLAN_EXPIRED", "approval.expiresAt"));
            violations.push(violation("APPROVAL_BINDING_MISMATCH", "binding"));
        }
    }
}

fn is_timestamp_path(path: Option<&str>) -> bool {
    path.is_some_and(|path| path.ends_with("expiresAt") || path.ends_with("capturedAt"))
}

fn validate_phase_material(params: &ValidateParams, violations: &mut Vec<Violation>) {
    let approval_present = params.binding.is_some() && params.approval.is_some();
    let approval_absent = params.binding.is_none() && params.approval.is_none();
    let signatures_present = params.signatures.is_some();
    let bundle_present = params.bundle.is_some();
    let pending_present = params.pending.is_some();
    let continuation_present = params.continuation.is_some();
    let (approval_required, signatures_required, artifact_required) = match params.phase.as_str() {
        "plan" => (false, false, false),
        "pre-sign" => (true, false, false),
        "finalized" | "pre-broadcast" => (true, true, true),
        _ => return,
    };
    if (approval_required && !approval_present) || (!approval_required && !approval_absent) {
        violations.push(violation("APPROVAL_BINDING_MISMATCH", "binding"));
    } else if approval_required
        && let (Some(binding), Some(approval)) = (&params.binding, &params.approval)
        && validate_approval_binding(
            &params.version,
            &params.request,
            &params.request_hash,
            &params.plan,
            binding,
            approval,
        )
        .is_err()
    {
        violations.push(violation("APPROVAL_BINDING_MISMATCH", "binding"));
    }
    if signatures_present != signatures_required {
        violations.push(violation("SIGNATURE_INVALID", "signatures"));
    }
    let exactly_one_artifact = bundle_present ^ pending_present;
    if artifact_required != exactly_one_artifact
        || (!artifact_required && (bundle_present || pending_present || continuation_present))
    {
        violations.push(violation("ARTIFACT_MISMATCH", "result"));
    }
}

const VIOLATION_REGISTRY: &[&str] = &[
    "REQUEST_HASH_MISMATCH", "SNAPSHOT_HASH_MISMATCH", "POLICY_HASH_MISMATCH",
    "PLAN_HASH_MISMATCH", "APPROVAL_BINDING_MISMATCH", "PLAN_EXPIRED",
    "SNAPSHOT_EXPIRED", "CHAIN_MISMATCH", "ACCOUNT_MISMATCH", "INPUT_NOT_IN_SNAPSHOT",
    "INPUT_ALREADY_SPENT", "ANCESTRY_INVALID", "UNSUPPORTED_CONTRACT_VERSION",
    "AMOUNT_OUT_OF_RANGE", "BUSINESS_OUTPUT_MISMATCH", "MINIMUM_OUTPUT_NOT_MET",
    "CHANGE_NOT_CONTROLLED", "FEE_MISMATCH", "FEE_LIMIT_EXCEEDED", "DEPENDENCY_INVALID",
    "SIGNING_TASK_MISMATCH", "SIGNATURE_INVALID", "TXID_MISMATCH", "ARTIFACT_MISMATCH",
    "BUNDLE_LIMIT_EXCEEDED", "SECRET_FIELD_PRESENT",
];

fn violation_rank(code: &str) -> usize {
    VIOLATION_REGISTRY
        .iter()
        .position(|registered| *registered == code)
        .unwrap_or(VIOLATION_REGISTRY.len())
}

fn violation(code: &str, path: &str) -> Violation {
    Violation {
        code: code.to_owned(),
        path: Some(path.to_owned()),
    }
}
