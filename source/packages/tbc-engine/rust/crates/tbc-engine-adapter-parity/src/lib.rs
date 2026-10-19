pub fn adapters_match(method: &str, input: &str) -> bool {
    let expected = tbc_engine_core::call_json_name(method, input);
    tbc_engine_native::call_for_test(method, input) == expected
        && tbc_engine_wasm::call_for_test(method, input) == expected
}
