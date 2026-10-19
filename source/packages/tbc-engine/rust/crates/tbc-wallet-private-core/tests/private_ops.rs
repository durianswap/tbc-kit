use std::str::FromStr;

use serde_json::json;
use tbc_sdk::{OutPoint, PrivateKey, Transaction, TxIn, TxOut, Txid};

const MESSAGE_HEX: &str = "54424320527573742063727970746f20e4bda0e5a5bd";
const ENCRYPTED: &str = "QklFMQKYnAt2y1Y5cf3JvvMewGw1YPMknW7p5dg8V2JVluBfbxkXjTaszWJ/1/baWMgM/7zj79O3TqfLNiMd/7Q2qR6qDJ/3VcXmNpNtrBT7PdZxQXdEJqpm4T3WyZjF2Zyke/w=";

fn fixture() -> (PrivateKey, Transaction, String) {
    let key = PrivateKey::from_slice(&[7u8; 32]).unwrap();
    let script = hex::encode(key.address().script_pubkey().as_bytes());
    let mut transaction = Transaction::new();
    transaction.inputs.push(TxIn::new(OutPoint {
        txid: Txid::from_str(&"11".repeat(32)).unwrap(),
        vout: 0,
    }));
    transaction.outputs.push(TxOut {
        satoshis: 9_000,
        script_pubkey: key.address().script_pubkey(),
    });
    (key, transaction, script)
}

#[test]
fn signs_raw_and_associated_transactions_without_a_key_in_json() {
    let (_key, transaction, script) = fixture();
    let raw: serde_json::Value = serde_json::from_str(
        &tbc_wallet_private_core::call(
            "signP2pkh",
            &json!({
                "txraws": [transaction.to_hex()],
                "utxosSatoshis": [[10_000]],
                "scriptPubkeys": [[script]],
            }).to_string(),
            &[7u8; 32],
        ).unwrap(),
    ).unwrap();
    assert!(raw["sigs"][0][0].as_str().unwrap().ends_with("41"));

    let associated: serde_json::Value = serde_json::from_str(
        &tbc_wallet_private_core::call(
            "signAssociated",
            &json!({
                "sourceTxraw": transaction.to_hex(),
                "sourceUtxos": [{
                    "txId": "11".repeat(32), "outputIndex": 0,
                    "satoshis": 10_000, "script": script,
                    "scriptSigType": "p2pkh"
                }],
                "inputs": [[{ "outputIndex": 0, "scriptSigType": "p2pkh" }]],
                "outputs": [[{ "satoshis": 8_000, "script": script }]],
            }).to_string(),
            &[7u8; 32],
        ).unwrap(),
    ).unwrap();
    let raws = associated["txraws"].as_array().unwrap();
    assert_eq!(raws.len(), 2);
    let parent = Transaction::from_hex(raws[0].as_str().unwrap()).unwrap();
    let child = Transaction::from_hex(raws[1].as_str().unwrap()).unwrap();
    assert!(!parent.inputs[0].script_sig.as_bytes().is_empty());
    assert_eq!(child.inputs[0].previous_output.txid, parent.txid());
    assert!(!child.inputs[0].script_sig.as_bytes().is_empty());
}

#[test]
fn encrypts_and_decrypts_the_existing_bie1_vector() {
    let key = PrivateKey::from_wif("KwTNVQ9B4wXUfnTF6e1EQkTHJwbzeFGYyK7NdopxuJjQYvQkAxtA").unwrap();
    let encrypted: serde_json::Value = serde_json::from_str(
        &tbc_wallet_private_core::call(
            "encryptMessage",
            &json!({ "messageHex": MESSAGE_HEX }).to_string(),
            &key.to_bytes(),
        ).unwrap(),
    ).unwrap();
    assert_eq!(encrypted["encryptedMessage"], ENCRYPTED);
    let decrypted: serde_json::Value = serde_json::from_str(
        &tbc_wallet_private_core::call(
            "decryptMessage",
            &json!({ "encryptedMessage": ENCRYPTED }).to_string(),
            &key.to_bytes(),
        ).unwrap(),
    ).unwrap();
    assert_eq!(decrypted["messageHex"], MESSAGE_HEX);
}

#[test]
fn rejects_key_material_in_json_and_stablecoin_associated_inputs() {
    let (_, transaction, script) = fixture();
    let key_error = tbc_wallet_private_core::call(
        "signP2pkh",
        &json!({
            "privateKeyHex": "07".repeat(32),
            "txraws": [transaction.to_hex()],
            "utxosSatoshis": [[10_000]],
            "scriptPubkeys": [[script]],
        }).to_string(),
        &[7u8; 32],
    ).unwrap_err();
    assert!(key_error.contains("unknown field"));

    let stablecoin_error = tbc_wallet_private_core::call(
        "signAssociated",
        &json!({
            "sourceTxraw": transaction.to_hex(),
            "sourceUtxos": [{
                "txId": "11".repeat(32), "outputIndex": 0,
                "satoshis": 10_000, "script": script,
                "scriptSigType": "tbc20_coin", "preTx": transaction.to_hex()
            }]
        }).to_string(),
        &[7u8; 32],
    ).unwrap_err();
    assert!(stablecoin_error.contains("StableCoin"));
}
