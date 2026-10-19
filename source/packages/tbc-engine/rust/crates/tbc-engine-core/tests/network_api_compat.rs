use std::{
    fs::{create_dir_all, remove_dir_all, write},
    path::PathBuf,
    process::Command,
};

#[test]
fn network_api_preserves_established_dto_import_paths() {
    let rust_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let sdk_path = rust_root.join("vendor/tbc-sdk");
    let fixture = std::env::temp_dir().join(format!(
        "tbc-engine-network-api-compat-{}",
        std::process::id()
    ));
    create_dir_all(fixture.join("src")).unwrap();
    write(
        fixture.join("Cargo.toml"),
        format!(
            "[package]\nname = \"network-api-compat\"\nversion = \"0.0.0\"\nedition = \"2024\"\n\n[workspace]\n\n[dependencies]\ntbc-sdk = {{ path = {:?}, default-features = false, features = [\"network-api\"] }}\n",
            sdk_path
        ),
    )
    .unwrap();
    write(
        fixture.join("src/main.rs"),
        "use tbc_sdk::api::{FtlpUtxo, UtxoInfo};\nfn main() { let _ = std::mem::size_of::<UtxoInfo>(); let _ = std::mem::size_of::<FtlpUtxo>(); }\n",
    )
    .unwrap();

    let output = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned()))
        .args([
            "check",
            "--quiet",
            "--offline",
            "--manifest-path",
            fixture.join("Cargo.toml").to_str().unwrap(),
        ])
        .env(
            "CARGO_TARGET_DIR",
            rust_root.join("target/consumer-tests/network-api-compat"),
        )
        .output()
        .unwrap();
    remove_dir_all(&fixture).unwrap();

    assert!(
        output.status.success(),
        "established network API DTO imports failed:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
