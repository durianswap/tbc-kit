use tbc_engine_core::{call_json, call_json_name, EngineMethod, ErrorCode};

#[test]
fn unknown_method_is_a_stable_error_envelope() {
    let response = call_json_name("execute", "{}");
    assert_eq!(
        response,
        r#"{"version":"1.0","ok":false,"error":{"code":"UNSUPPORTED_METHOD","message":"unsupported Engine method: execute","path":"method"}}"#
    );
}

#[test]
fn malformed_json_is_an_invalid_input_envelope() {
    let response = call_json(EngineMethod::Plan, "{");
    assert!(response.contains(r#""code":"INVALID_INPUT""#));
    assert!(!response.contains("panicked"));
}

#[test]
fn valid_tbc_json_is_returned_in_a_stable_success_envelope() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/tbc-transfer.json")).unwrap();
    let response: serde_json::Value = serde_json::from_str(&call_json(
        EngineMethod::NormalizeRequest,
        &fixture["normalizeInput"].to_string(),
    ))
    .unwrap();
    assert_eq!(response["version"], "1.0");
    assert_eq!(response["ok"], true);
    assert_eq!(response["result"], fixture["normalizedRequest"]);
}

#[test]
fn stable_method_names_dispatch_to_the_wire_envelope() {
    for method in ["normalizeRequest", "plan", "validate", "finalize"] {
        let response = call_json_name(method, "{}");
        assert!(response.contains(r#""code":"INVALID_INPUT""#), "{response}");
        assert!(
            !response.contains("UNSUPPORTED_METHOD"),
            "method {method} must remain supported"
        );
    }
}

#[test]
fn error_taxonomy_serializes_to_finite_stable_codes() {
    let codes = [
        ErrorCode::InvalidInput,
        ErrorCode::UnsupportedMethod,
        ErrorCode::UnsupportedIntent,
        ErrorCode::MissingMaterial,
        ErrorCode::InvalidAncestry,
        ErrorCode::InsufficientFunds,
        ErrorCode::FeeCapExceeded,
        ErrorCode::InvalidPlan,
        ErrorCode::MissingSignature,
        ErrorCode::InvalidSignature,
        ErrorCode::InternalInvariant,
    ];

    assert_eq!(
        serde_json::to_string(&codes).unwrap(),
        r#"["INVALID_INPUT","UNSUPPORTED_METHOD","UNSUPPORTED_INTENT","MISSING_MATERIAL","INVALID_ANCESTRY","INSUFFICIENT_FUNDS","FEE_CAP_EXCEEDED","INVALID_PLAN","MISSING_SIGNATURE","INVALID_SIGNATURE","INTERNAL_INVARIANT"]"#
    );
}

#[test]
fn sdk_transaction_and_contract_types_link_without_network_features() {
    assert!(std::mem::size_of::<tbc_sdk::Transaction>() > 0);
    assert!(std::mem::size_of::<tbc_sdk::Tbc20>() > 0);
}
