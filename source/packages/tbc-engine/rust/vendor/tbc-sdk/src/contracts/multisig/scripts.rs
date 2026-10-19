use crate::{
    PublicKey, Result, hash,
    script::{Script, opcodes},
};

use super::address::{MultiSig, canonical_public_keys, decode_address};

const HOLD_MARKER: &[u8] = b"multisig";
const TAPE_MARKER: &[u8] = b"MTape";

impl MultiSig {
    pub fn lock_script(address: &str) -> Result<Script> {
        let decoded = decode_address(address)?;
        let mut asm = format!("OP_{} OP_SWAP ", decoded.info.required_signatures);
        for _ in 0..decoded.info.public_key_count - 1 {
            asm.push_str("21 OP_SPLIT ");
        }
        for _ in 0..decoded.info.public_key_count {
            asm.push_str(&format!(
                "OP_{} OP_PICK ",
                decoded.info.public_key_count - 1
            ));
        }
        for _ in 0..decoded.info.public_key_count - 1 {
            asm.push_str("OP_CAT ");
        }
        asm.push_str(&format!(
            "OP_HASH160 {} OP_EQUALVERIFY OP_{} OP_CHECKMULTISIG",
            hex::encode(decoded.public_key_hash),
            decoded.info.public_key_count
        ));
        Script::from_asm(&asm)
    }

    pub fn combine_hash(address: &str) -> Result<[u8; 21]> {
        let script = Self::lock_script(address)?;
        let mut combine_hash = [0u8; 21];
        combine_hash[..20].copy_from_slice(&hash::hash160(&hash::sha256(script.as_bytes())));
        combine_hash[20] = 0x01;
        Ok(combine_hash)
    }
}

pub fn hold_script(public_key: &PublicKey) -> Script {
    let mut bytes = Script::p2pkh(&public_key.hash160()).into_bytes();
    bytes.push(opcodes::OP_RETURN);
    bytes.push(HOLD_MARKER.len() as u8);
    bytes.extend_from_slice(HOLD_MARKER);
    Script::from_bytes(bytes)
}

pub fn tape_script(address: &str, public_keys: &[PublicKey]) -> Result<Script> {
    let canonical_keys = canonical_public_keys(public_keys, 1)?;
    let public_keys = canonical_keys
        .iter()
        .map(hex::encode)
        .collect::<Vec<_>>()
        .join("\",\"");
    let json = format!("{{\"address\":\"{address}\",\"pubkeys\":[\"{public_keys}\"]}}");
    Ok(Script::op_return(&[
        json.into_bytes(),
        TAPE_MARKER.to_vec(),
    ]))
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use sha2::{Digest, Sha256};

    use crate::{MultiSig, MultiSigAddressInfo, PrivateKey, PublicKey};

    const JS_165_FIXTURE: &str = include_str!("../../../tests/fixtures/multisig-js-165.json");

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct JsFixture {
        contract_name: String,
        contract_version: String,
        tbc_lib_version: String,
        public_key_order: String,
        cases: Vec<JsCase>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct JsCase {
        name: String,
        required_signatures: u8,
        public_key_count: u8,
        public_keys: Vec<String>,
        address: String,
        lock_script: ScriptFixture,
        combine_hash: String,
        hold_scripts: Vec<ScriptFixture>,
        tape_script: ScriptFixture,
    }

    #[derive(Debug, Deserialize)]
    struct ScriptFixture {
        hex: String,
        length: usize,
        sha256: String,
    }

    const JS_2_OF_3_ADDRESS: &str = "F6TyXNS7WVsihUYW8VZkunTp2gFKq6Npq2";
    const JS_HOLD_HEX: &str =
        "76a914ebc0ee0b2ab9e8277a600c251475e22a3241a1c188ac6a086d756c7469736967";
    const JS_TAPE_HEX: &str = "006a4d0b017b2261646472657373223a2246365479584e5337575673696855595738565a6b756e54703267464b71364e707132222c227075626b657973223a5b22303234643462366364313336313033326361396264326165623964393030616134643435643965616438306163393432333337346334353161373235346430373636222c22303235333166653630363831333435303364323732333133333232376338363761633866613663383363353337653961343463336335626462646362316665333337222c22303331623834633535363762313236343430393935643365643561616261303536356437316531383334363034383139666639633137663565396435646430373866225d7d054d54617065";

    fn fixture_public_keys() -> Vec<PublicKey> {
        let mut keys = [[1u8; 32], [2u8; 32], [3u8; 32]]
            .into_iter()
            .map(|bytes| PrivateKey::from_slice(&bytes).unwrap().public_key())
            .collect::<Vec<_>>();
        keys.sort_by_key(PublicKey::to_bytes);
        keys
    }

    fn assert_script_fixture(actual: &[u8], expected: &ScriptFixture) {
        assert_eq!(hex::encode(actual), expected.hex);
        assert_eq!(actual.len(), expected.length);
        assert_eq!(hex::encode(Sha256::digest(actual)), expected.sha256);
    }

    #[test]
    fn multisig_js_165_fixture_matches() {
        let fixture: JsFixture = serde_json::from_str(JS_165_FIXTURE).unwrap();
        assert_eq!(fixture.contract_name, "tbc-contract");
        assert_eq!(fixture.contract_version, "1.6.5");
        assert_eq!(fixture.tbc_lib_version, "1.0.31");
        assert_eq!(fixture.public_key_order, "compressed-hex-ascending");
        assert_eq!(
            fixture
                .cases
                .iter()
                .map(|case| case.name.as_str())
                .collect::<Vec<_>>(),
            ["1-of-3", "2-of-3", "6-of-10"]
        );

        for case in fixture.cases {
            let public_keys = case
                .public_keys
                .iter()
                .map(|value| PublicKey::from_slice(&hex::decode(value).unwrap()).unwrap())
                .collect::<Vec<_>>();
            assert!(
                public_keys
                    .windows(2)
                    .all(|pair| pair[0].to_bytes() < pair[1].to_bytes())
            );
            assert_eq!(public_keys.len(), case.public_key_count as usize);

            assert_eq!(
                MultiSig::address(&public_keys, case.required_signatures).unwrap(),
                case.address
            );
            assert_eq!(
                MultiSig::address_info(&case.address).unwrap(),
                MultiSigAddressInfo {
                    required_signatures: case.required_signatures,
                    public_key_count: case.public_key_count,
                }
            );
            assert!(MultiSig::verify_address(&public_keys, &case.address).unwrap());
            assert_script_fixture(
                MultiSig::lock_script(&case.address).unwrap().as_bytes(),
                &case.lock_script,
            );
            assert_eq!(
                hex::encode(MultiSig::combine_hash(&case.address).unwrap()),
                case.combine_hash
            );

            assert_eq!(case.hold_scripts.len(), public_keys.len());
            for (public_key, hold) in public_keys.iter().zip(&case.hold_scripts) {
                assert_script_fixture(super::hold_script(public_key).as_bytes(), hold);
            }
            assert_script_fixture(
                super::tape_script(&case.address, &public_keys)
                    .unwrap()
                    .as_bytes(),
                &case.tape_script,
            );
        }
    }

    #[test]
    fn participant_hold_and_wallet_tape_match_js_1_6_5() {
        let keys = fixture_public_keys();
        assert_eq!(
            hex::encode(super::hold_script(&keys[0]).as_bytes()),
            JS_HOLD_HEX
        );
        assert_eq!(
            hex::encode(
                super::tape_script(JS_2_OF_3_ADDRESS, &keys)
                    .unwrap()
                    .as_bytes()
            ),
            JS_TAPE_HEX
        );
        assert!(
            hex::encode(super::hold_script(&keys[0]).as_bytes()).ends_with("6a086d756c7469736967")
        );
        assert!(
            hex::encode(
                super::tape_script(JS_2_OF_3_ADDRESS, &keys)
                    .unwrap()
                    .as_bytes()
            )
            .ends_with("054d54617065")
        );
    }

    #[test]
    fn tape_script_rejects_invalid_or_duplicate_public_keys_without_panicking() {
        let keys = fixture_public_keys();
        let duplicate_keys = [keys[0].clone(), keys[0].clone(), keys[1].clone()];

        let result =
            std::panic::catch_unwind(|| super::tape_script(JS_2_OF_3_ADDRESS, &duplicate_keys));
        assert!(result.is_ok());
        assert!(result.unwrap().is_err());
        assert!(super::tape_script(JS_2_OF_3_ADDRESS, &keys[..2]).is_err());
    }
}
