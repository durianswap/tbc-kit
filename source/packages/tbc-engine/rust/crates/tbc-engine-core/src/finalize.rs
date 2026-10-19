use std::collections::BTreeMap;

use serde_json::Value;

use crate::fee_envelope::verify_final_fee_envelopes;
use crate::model::{
    ApprovalBinding, ApprovalReceipt, BundleTransaction, CanonicalRequest, ExecutionPlan,
    FinalizeContinuation, FinalizeOutcome, FinalizeParams, FinalizeResult, PendingFinalizeResult,
    PlanParams, SignedTransactionBundle, ValidationResult, WIRE_VERSION,
    error, parse_input, to_value,
};
use crate::normalize::{canonical_hash, parse_decimal_u64};
use crate::plan::{compare_canonical_timestamps, computation};
use crate::signing::{ExternalSignature, SigningRequest, SigningStage, StageOutcome, finalize_signing_stage};
use crate::signing_wire::{signing_profile, task_id};
use crate::{EngineError, ErrorCode};

pub(crate) fn finalize(input: Value) -> Result<Value, EngineError> {
    reject_secret_fields(&input)?;
    let params: FinalizeParams = parse_input(input)?;
    to_value(finalize_typed(params)?)
}

pub(crate) fn finalize_typed(params: FinalizeParams) -> Result<FinalizeOutcome, EngineError> {
    finalize_with_computation(params, None)
}

// Only validation may supply the computation made from these same parsed
// request/snapshot/policy values in this call. Nothing is cached across calls.
pub(crate) fn finalize_with_computation(
    params: FinalizeParams,
    precomputed: Option<Result<crate::model::PlannedTransfer, EngineError>>,
) -> Result<FinalizeOutcome, EngineError> {
    let FinalizeParams {
        version,
        request,
        request_hash,
        snapshot,
        policy,
        plan,
        binding,
        approval,
        signatures,
        continuation,
    } = params;
    if version != WIRE_VERSION {
        return Err(error(ErrorCode::InvalidInput, "unsupported wire version", "version"));
    }
    validate_approval_binding(
        &version,
        &request,
        &request_hash,
        &plan,
        &binding,
        &approval,
    )?;
    let authoritative = PlanParams {
        version,
        request,
        request_hash,
        snapshot,
        policy,
    };
    let expected = match precomputed {
        Some(result) => result?,
        None => computation(&authoritative)?,
    };
    if plan != expected.result.plan {
        return Err(error(
            ErrorCode::InvalidPlan,
            "execution plan differs from deterministic planning output",
            "plan",
        ));
    }
    let signing_stage = if let Some(continuation) = continuation {
        validate_finalize_continuation(
            &authoritative.request,
            &authoritative.request_hash,
            &plan,
            &binding,
            &approval,
            &expected,
            &continuation,
        )?;
        continuation.signing_stage
    } else {
        expected.signing_stage
    };
    let tasks = signing_stage
        .signing_requests
        .iter()
        .map(|request| (task_id(request), request))
        .collect::<BTreeMap<_, _>>();
    if signatures.len() < tasks.len() {
        return Err(error(
            ErrorCode::MissingSignature,
            "signature is missing for a signing task",
            "signatures",
        ));
    }
    if signatures.len() > tasks.len() {
        return Err(error(
            ErrorCode::InvalidSignature,
            "finalization contains extra signatures",
            "signatures",
        ));
    }
    let mut seen = BTreeMap::new();
    let mut external = Vec::with_capacity(signatures.len());
    for result in &signatures {
        if seen.insert(result.task_id.clone(), ()).is_some() {
            return Err(error(
                ErrorCode::InvalidSignature,
                "duplicate signature task id",
                "signatures",
            ));
        }
        let request = tasks.get(&result.task_id).ok_or_else(|| {
            error(ErrorCode::InvalidSignature, "signature task id is not in the plan", "signatures")
        })?;
        external.push(ExternalSignature {
            session_id: request.session_id.clone(),
            stage: request.stage,
            stage_commitment: request.stage_commitment.clone(),
            transaction_id: request.transaction_id.clone(),
            input_index: request.input_index,
            digest: request.digest.clone(),
            public_key: request.public_key.clone(),
            signature: external_signature_body(request, &result.signature_encoding, &result.signature)?,
        });
    }
    let signed = match finalize_signing_stage(&expected.unsigned_plan, signing_stage, &external)? {
        StageOutcome::Complete(bundle) => bundle,
        StageOutcome::Pending(next) => {
            // Continuations belong to the recomputed approval-bound dependency
            // plan, not a list of business names allowed to have two stages.
            if !expected.unsigned_plan.transactions.iter().any(|transaction| transaction.stage > 0) {
                return Err(error(
                    ErrorCode::InternalInvariant,
                    "single-stage operation unexpectedly requires another signing stage",
                    "plan",
                ));
            }
            let signing_requests = crate::signing_wire::SigningAccounts::resolve(
                &authoritative.request, &authoritative.snapshot.payload,
            )?.tasks(&next)?;
            let continuation = bind_finalize_continuation(
                &authoritative.request,
                &authoritative.request_hash,
                &plan,
                &binding,
                &approval,
                next,
            );
            return Ok(FinalizeOutcome::Pending(PendingFinalizeResult {
                status: "pending".to_owned(),
                continuation,
                signing_requests,
            }));
        }
    };
    let fee_rate = parse_decimal_u64(
        &authoritative.policy.payload.fee_rate_sat_per_kb,
        "policy.payload.feeRateSatPerKb",
    )?;
    let planned_paid_fees = expected
        .result
        .plan
        .payload
        .transactions
        .iter()
        .enumerate()
        .map(|(index, template)| {
            parse_decimal_u64(
                &template.fee,
                &format!("plan.payload.transactions[{index}].fee"),
            )
        })
        .collect::<Result<Vec<_>, EngineError>>()?;
    verify_final_fee_envelopes(
        &expected.unsigned_plan,
        &signed,
        &planned_paid_fees,
        fee_rate,
    )?;
    let transactions = signed
        .transactions
        .into_iter()
        .map(|transaction| {
            let template = expected
                .result
                .plan
                .payload
                .transactions
                .iter()
                .find(|template| template.id == transaction.transaction_id)
                .ok_or_else(|| {
                    error(ErrorCode::InternalInvariant, "signed transaction is not in the plan", "plan")
                })?;
            Ok(BundleTransaction {
                id: transaction.transaction_id,
                txid: transaction.txid,
                raw_transaction: transaction.raw_transaction,
                role: transaction.role,
                depends_on: template.depends_on.clone(),
            })
        })
        .collect::<Result<Vec<_>, EngineError>>()?;
    let total_fee = expected
        .result
        .plan
        .payload
        .transactions
        .iter()
        .try_fold(0u64, |sum, transaction| {
            let fee = transaction.fee.parse::<u64>().map_err(|_| {
                error(ErrorCode::InternalInvariant, "planned fee is not uint64", "plan")
            })?;
            sum.checked_add(fee).ok_or_else(|| {
                error(ErrorCode::InternalInvariant, "bundle fee overflow", "plan")
            })
        })?;
    Ok(FinalizeOutcome::Complete(FinalizeResult {
        bundle: SignedTransactionBundle {
            version: WIRE_VERSION.to_owned(),
            chain_id: authoritative.request.chain_id.clone(),
            from: authoritative.request.from.clone(),
            request_hash: authoritative.request_hash.clone(),
            approval_id: approval.approval_id.clone(),
            transactions,
            total_fee: total_fee.to_string(),
            artifacts: None,
        },
        validation: ValidationResult {
            valid: true,
            violations: Vec::new(),
        },
    }))
}

fn bind_finalize_continuation(
    request: &CanonicalRequest,
    request_hash: &str,
    plan: &ExecutionPlan,
    binding: &ApprovalBinding,
    approval: &ApprovalReceipt,
    signing_stage: SigningStage,
) -> FinalizeContinuation {
    FinalizeContinuation {
        version: WIRE_VERSION.to_owned(),
        method: "finalize".to_owned(),
        family: continuation_family(request).to_owned(),
        request_hash: request_hash.to_owned(),
        plan_hash: plan.plan_hash.clone(),
        binding_hash: binding.binding_hash.clone(),
        approval_id: approval.approval_id.clone(),
        session_id: signing_stage.session_id.clone(),
        stage: signing_stage.stage,
        stage_commitment: signing_stage.stage_commitment.clone(),
        signing_stage,
    }
}

fn validate_finalize_continuation(
    request: &CanonicalRequest,
    request_hash: &str,
    plan: &ExecutionPlan,
    binding: &ApprovalBinding,
    approval: &ApprovalReceipt,
    expected: &crate::model::PlannedTransfer,
    continuation: &FinalizeContinuation,
) -> Result<(), EngineError> {
    let stage = &continuation.signing_stage;
    if continuation.version != WIRE_VERSION
        || continuation.method != "finalize"
        || continuation.family != continuation_family(request)
        || continuation.request_hash != request_hash
        || continuation.plan_hash != plan.plan_hash
        || continuation.binding_hash != binding.binding_hash
        || continuation.approval_id != approval.approval_id
        || continuation.session_id != stage.session_id
        || continuation.stage != stage.stage
        || continuation.stage_commitment != stage.stage_commitment
        || stage.stage == 0
        || stage.continuation.plan_commitment
            != crate::signing::unsigned_plan_commitment(&expected.unsigned_plan)?
    {
        return Err(error(
            ErrorCode::InvalidPlan,
            "finalize continuation is not bound to the authoritative operation",
            "continuation",
        ));
    }
    Ok(())
}

fn continuation_family(request: &CanonicalRequest) -> &'static str {
    if request.intent.intent_type.starts_with("tbc.stablecoin.") || request.intent.intent_type.starts_with("tbc20Stablecoin.") || crate::normalize::COIN_INTENTS.contains(&request.intent.intent_type.as_str()) {
        "stablecoin"
    } else if request.intent.intent_type.starts_with("tbc.collection.") {
        "collection"
    } else if request.intent.intent_type.starts_with("tbc.nft.") || crate::normalize::TBC721_INTENTS.contains(&request.intent.intent_type.as_str()) {
        "nft"
    } else if request.intent.intent_type.starts_with("tbc.pool.") || crate::normalize::AMM_INTENTS.contains(&request.intent.intent_type.as_str()) || crate::normalize::LP_INTENTS.contains(&request.intent.intent_type.as_str()) {
        "pool"
    } else {
        "ft"
    }
}

pub(crate) fn validate_approval_binding(
    version: &str,
    request: &CanonicalRequest,
    request_hash: &str,
    plan: &ExecutionPlan,
    binding: &ApprovalBinding,
    approval: &ApprovalReceipt,
) -> Result<(), EngineError> {
    let payload = &binding.payload;
    let account_id = format!("{}:{}", request.chain_id, request.from);
    let hash_is_hex = |value: &str| {
        value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    };
    let invalid_time = || {
        error(
            ErrorCode::InvalidPlan,
            "caller-provided approval has invalid or incompatible timestamps",
            "binding",
        )
    };
    let approved_to_receipt = compare_canonical_timestamps(
        &approval.approved_at,
        "approval.approvedAt",
        &approval.expires_at,
        "approval.expiresAt",
    )
    .map_err(|_| invalid_time())?;
    let receipt_to_binding = compare_canonical_timestamps(
        &approval.expires_at,
        "approval.expiresAt",
        &payload.expires_at,
        "binding.payload.expiresAt",
    )
    .map_err(|_| invalid_time())?;
    let workflow_binding = matches!(
        payload.method.as_str(),
        "tbc_signWorkflow"
            | "tbc_signPreparedWorkflow"
            | "tbc_sendWorkflow"
            | "tbc_sendPreparedWorkflow"
    );
    let binding_to_plan = compare_canonical_timestamps(
        &payload.expires_at,
        "binding.payload.expiresAt",
        &plan.payload.expires_at,
        "plan.payload.expiresAt",
    )
    .map_err(|_| invalid_time())?;
    if version != WIRE_VERSION
        || payload.version != WIRE_VERSION
        || !matches!(
            (payload.method.as_str(), payload.operation_kind.as_str()),
            (
                "tbc_signTransaction"
                    | "tbc_signPreparedTransaction"
                    | "tbc_sendTransaction"
                    | "tbc_sendPreparedTransaction",
                "transaction"
            ) | (
                "tbc_signWorkflow"
                    | "tbc_signPreparedWorkflow"
                    | "tbc_sendWorkflow"
                    | "tbc_sendPreparedWorkflow",
                "workflow"
            )
        )
        || payload.chain_id != request.chain_id
        || payload.account_id != account_id
        || (!workflow_binding && payload.request_hash != request_hash)
        || (!workflow_binding && payload.operation_hash != plan.plan_hash)
        // Approval may deliberately shorten a valid plan's lifetime (e.g. a
        // Prepared proposal or the earliest child of a batch), never extend it.
        || binding_to_plan.is_gt()
        || payload.origin.is_empty()
        || payload.session_id.is_empty()
        || !hash_is_hex(&payload.context_hash)
        || canonical_hash(payload)? != binding.binding_hash
        || approval.status != "approved"
        || approval.approval_id.is_empty()
        || approval.approval_token.is_empty()
        || approval.binding_hash != binding.binding_hash
        || approved_to_receipt.is_gt()
        || receipt_to_binding.is_gt()
    {
        return Err(error(
            ErrorCode::InvalidPlan,
            "caller-provided approval does not bind the deterministic plan",
            "binding",
        ));
    }
    Ok(())
}

fn external_signature_body(request: &SigningRequest, encoding: &str, value: &str) -> Result<String, EngineError> {
    let (_, expected_encoding) = signing_profile(request)?;
    if encoding != expected_encoding {
        return Err(error(ErrorCode::InvalidSignature, "signature encoding differs from its bound task", "signatures"));
    }
    if encoding == "schnorr64" {
        if value.len() != 128 || !value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(error(ErrorCode::InvalidSignature, "schnorr64 requires a canonical 64-byte body without sighash suffix", "signatures"));
        }
        // Shared finalization verifies BIP340 against the recomputed digest.
        return Ok(value.into());
    }
    compact_to_der_hex(value)
}

fn compact_to_der_hex(value: &str) -> Result<String, EngineError> {
    let compact = decode_hex(value)?;
    if compact.len() != 64 {
        return Err(error(
            ErrorCode::InvalidSignature,
            "compact64 signature must contain exactly 64 bytes",
            "signatures",
        ));
    }
    let r = der_integer(&compact[..32]);
    let s = der_integer(&compact[32..]);
    let length = 2 + r.len() + 2 + s.len();
    let mut der = Vec::with_capacity(length + 2);
    der.extend_from_slice(&[0x30, length as u8, 0x02, r.len() as u8]);
    der.extend_from_slice(&r);
    der.extend_from_slice(&[0x02, s.len() as u8]);
    der.extend_from_slice(&s);
    Ok(crate::normalize::hex(&der))
}

#[cfg(test)]
mod signing_encoding_tests {
    use super::*;
    use crate::signing_wire::tests::request;

    #[test]
    fn schnorr_wire_preserves_body_and_never_uses_ecdsa_der_conversion() {
        let fixture: Value = serde_json::from_str(include_str!("../../../fixtures/coin-admin-proof.json")).unwrap();
        let signature = fixture["cases"][0]["signatureHex"].as_str().unwrap();
        assert_eq!(&signature[128..], "41");
        let body = &signature[..128];
        assert_eq!(external_signature_body(&request(true), "schnorr64", body).unwrap(), body);
        assert!(external_signature_body(&request(true), "compact64", body).is_err());
        assert!(external_signature_body(&request(false), "schnorr64", body).is_err());
        for bad in [signature.to_owned(), body[..126].to_owned(), body.to_uppercase(), "zz".repeat(64)] {
            assert!(external_signature_body(&request(true), "schnorr64", &bad).is_err());
        }
        // ECDSA retains the exact existing compact-to-DER mapping.
        let compact = "01".repeat(64);
        assert_eq!(external_signature_body(&request(false), "compact64", &compact).unwrap(), compact_to_der_hex(&compact).unwrap());
    }
}

fn der_integer(value: &[u8]) -> Vec<u8> {
    let first_non_zero = value
        .iter()
        .position(|byte| *byte != 0)
        .unwrap_or(value.len() - 1);
    let significant = &value[first_non_zero..];
    let mut encoded = Vec::with_capacity(significant.len() + 1);
    if significant[0] & 0x80 != 0 {
        encoded.push(0);
    }
    encoded.extend_from_slice(significant);
    encoded
}

fn decode_hex(value: &str) -> Result<Vec<u8>, EngineError> {
    if value.len() % 2 != 0 {
        return Err(error(ErrorCode::InvalidSignature, "signature is not hexadecimal", "signatures"));
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = nibble(pair[0]).ok_or_else(|| {
                error(ErrorCode::InvalidSignature, "signature is not hexadecimal", "signatures")
            })?;
            let low = nibble(pair[1]).ok_or_else(|| {
                error(ErrorCode::InvalidSignature, "signature is not hexadecimal", "signatures")
            })?;
            Ok((high << 4) | low)
        })
        .collect()
}

fn nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn reject_secret_fields(value: &Value) -> Result<(), EngineError> {
    fn visit(value: &Value) -> bool {
        match value {
            Value::Array(values) => values.iter().any(visit),
            Value::Object(values) => values.iter().any(|(key, value)| {
                let normalized = key
                    .chars()
                    .filter(|character| character.is_ascii_alphanumeric())
                    .flat_map(char::to_lowercase)
                    .collect::<String>();
                ["privatekey", "privatekeywif", "privatekeyhex", "seedphrase", "mnemonic", "wif"]
                    .contains(&normalized.as_str())
                    || visit(value)
            }),
            _ => false,
        }
    }
    if visit(value) {
        return Err(error(
            ErrorCode::InvalidInput,
            "finalization input contains secret-bearing fields",
            "input",
        ));
    }
    Ok(())
}
