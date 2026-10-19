#[test]
fn adapters_preserve_core_response_bytes() {
    let plan = include_str!("../../../fixtures/tbc-transfer.json");
    assert!(tbc_engine_adapter_parity::adapters_match("plan", plan));
    for method in ["normalizeRequest", "plan", "validate", "finalize", "unknown"] {
        assert!(tbc_engine_adapter_parity::adapters_match(method, "{}"), "{method}");
    }
}
