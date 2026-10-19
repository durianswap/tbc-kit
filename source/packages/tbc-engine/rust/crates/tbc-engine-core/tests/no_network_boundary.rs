use std::{
    fs::{create_dir_all, remove_dir_all, write},
    path::PathBuf,
    process::Command,
};

#[test]
fn no_network_consumers_cannot_compile_network_api_symbols() {
    let sdk_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vendor/tbc-sdk");
    let cases = [
        (
            "api-client",
            "use tbc_sdk::ApiClient; fn main() { let _ = ApiClient::main(); }",
            "ApiClient",
        ),
        (
            "api-module",
            "use tbc_sdk::api; fn main() { let _ = std::any::type_name::<api::ApiClient>(); }",
            "api",
        ),
        (
            "pool-online-helper",
            "use tbc_sdk::PoolNftV2; fn main() { let _ = PoolNftV2::resolve_pool_spend_context; }",
            "resolve_pool_spend_context",
        ),
        (
            "online-validator",
            "use tbc_sdk::validate_on_chain_transaction; fn main() { let _ = validate_on_chain_transaction; }",
            "validate_on_chain_transaction",
        ),
    ];
    let mut unexpectedly_compiled = Vec::new();

    for (name, source, expected_symbol) in cases {
        let fixture = std::env::temp_dir().join(format!(
            "tbc-engine-no-network-{name}-{}",
            std::process::id()
        ));
        let target = fixture.join("target");
        create_dir_all(fixture.join("src")).unwrap();
        write(
            fixture.join("Cargo.toml"),
            format!(
                "[package]\nname = \"{name}\"\nversion = \"0.0.0\"\nedition = \"2024\"\n\n[workspace]\n\n[dependencies]\ntbc-sdk = {{ path = {:?}, default-features = false }}\n",
                sdk_path
            ),
        )
        .unwrap();
        write(fixture.join("src/main.rs"), source).unwrap();

        let output = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned()))
            .args([
                "check",
                "--quiet",
                "--offline",
                "--manifest-path",
                fixture.join("Cargo.toml").to_str().unwrap(),
            ])
            .env("CARGO_TARGET_DIR", &target)
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        remove_dir_all(&fixture).unwrap();

        if output.status.success() {
            unexpectedly_compiled.push(name);
            continue;
        }
        assert!(
            stderr.contains(expected_symbol),
            "{name} failed for the wrong reason:\n{stderr}"
        );
    }

    assert!(
        unexpectedly_compiled.is_empty(),
        "network symbols unexpectedly compiled in the no-network public build: {}",
        unexpectedly_compiled.join(", ")
    );
}
