use std::{fs, process::Command, time::SystemTime};

#[test]
fn no_feature_sdk_hides_secret_taking_builders_and_signing_methods() {
    let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let sdk_dir = manifest_dir.join("../../vendor/tbc-sdk");
    let nonce = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let fixture = std::env::temp_dir().join(format!("tbc-keyless-boundary-{nonce}"));
    fs::create_dir_all(fixture.join("src")).unwrap();
    fs::write(
        fixture.join("Cargo.toml"),
        format!(
            "[package]\nname = \"keyless-boundary\"\nversion = \"0.0.0\"\nedition = \"2024\"\n\n[dependencies]\ntbc-sdk = {{ path = {:?}, default-features = false }}\n",
            sdk_dir
        ),
    )
    .unwrap();
    let secret_type = ["Private", "Key"].concat();
    let cases = [
        (
            secret_type.as_str(),
            format!(
                "use tbc_sdk::{secret_type}; fn main() {{ let _ = std::mem::size_of::<{secret_type}>(); }}"
            ),
        ),
        (
            "keys",
            "use tbc_sdk::keys; fn main() { let _ = std::mem::size_of::<keys::PublicKey>(); }"
                .to_owned(),
        ),
        (
            "TransactionBuilder",
            "use tbc_sdk::TransactionBuilder; fn main() { let _ = std::mem::size_of::<TransactionBuilder>(); }"
                .to_owned(),
        ),
        (
            "sign_p2pkh_input",
            "fn main() { let _ = tbc_sdk::Transaction::sign_p2pkh_input; }".to_owned(),
        ),
        (
            "contracts::ft::builder",
            "use tbc_sdk::contracts::ft::builder; fn main() { let _ = stringify!(builder); }"
                .to_owned(),
        ),
        (
            "transfer_nft",
            "fn main() { let _ = tbc_sdk::Nft::transfer_nft; }".to_owned(),
        ),
        (
            "contracts::stable_coin::builder",
            "use tbc_sdk::contracts::stable_coin::builder; fn main() { let _ = stringify!(builder); }"
                .to_owned(),
        ),
        (
            "Tbc20::transfer",
            "fn main() { let _ = tbc_sdk::Tbc20::transfer; }".to_owned(),
        ),
        (
            "contracts::pool_nft_v2::builder",
            "use tbc_sdk::contracts::pool_nft_v2::builder; fn main() { let _ = stringify!(builder); }"
                .to_owned(),
        ),
        (
            "PoolNftV2",
            "use tbc_sdk::PoolNftV2; fn main() { let _ = std::mem::size_of::<PoolNftV2>(); }"
                .to_owned(),
        ),
    ];

    for (unavailable, source) in cases {
        fs::write(fixture.join("src/main.rs"), source).unwrap();
        let output = Command::new(env!("CARGO"))
            .args(["check", "--offline", "--quiet"])
            .env(
                "CARGO_TARGET_DIR",
                manifest_dir.join("../../target/consumer-tests/keyless-boundary"),
            )
            .current_dir(&fixture)
            .output()
            .unwrap();
        assert!(
            !output.status.success(),
            "secret-taking SDK surface compiled: {unavailable}"
        );
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(
                unavailable
                    .rsplit("::")
                    .next()
                    .unwrap_or(unavailable)
            ),
            "compiler failure did not identify {unavailable}:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let _ = fs::remove_dir_all(&fixture);
}

#[test]
fn no_feature_core_dependency_tree_excludes_network_hd_and_randomness_crates() {
    let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let output = Command::new(env!("CARGO"))
        .args([
            "tree",
            "--manifest-path",
            manifest_dir.join("../../Cargo.toml").to_str().unwrap(),
            "-p",
            "tbc-engine-core",
            "--edges",
            "normal",
            "--no-default-features",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let tree = String::from_utf8_lossy(&output.stdout);
    for denied in [
        "bip32 v",
        "bip39 v",
        "rand v",
        "rand_core v",
        "getrandom v",
        "reqwest v",
        "tokio v",
    ] {
        assert!(!tree.contains(denied), "forbidden dependency {denied}:\n{tree}");
    }
}
