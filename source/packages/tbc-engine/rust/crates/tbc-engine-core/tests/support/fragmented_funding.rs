use serde_json::{Value, json};
use tbc_sdk::{Transaction, TxIn, TxOut, OutPoint, Txid, script::Script};

// Public, synthetic funding parents; no network or private wallet material.
pub fn replace(input: &mut Value, count: usize, amount: u64) {
    let native = input["snapshot"]["payload"]["utxos"].as_array().unwrap().iter()
        .find(|item| item["classification"] == "native").unwrap().clone();
    let old_ids = input["snapshot"]["payload"]["utxos"].as_array().unwrap().iter()
        .filter(|item| item["classification"] == "native")
        .map(|item| item["txid"].clone()).collect::<Vec<_>>();
    input["snapshot"]["payload"]["utxos"].as_array_mut().unwrap()
        .retain(|item| item["classification"] != "native");
    input["snapshot"]["payload"]["parents"].as_array_mut().unwrap()
        .retain(|parent| !old_ids.contains(&parent["txid"]));
    let script = native["scriptPubKey"].as_str().unwrap().as_bytes().chunks_exact(2)
        .map(|bytes| u8::from_str_radix(std::str::from_utf8(bytes).unwrap(), 16).unwrap()).collect();
    let script = Script::from_bytes(script);
    for index in 0..count {
        let transaction = Transaction { version: tbc_sdk::TX_VERSION,
            inputs: vec![TxIn::new(OutPoint { txid: Txid::from_le_bytes([0xaa;32]), vout: index as u32 })],
            outputs: vec![TxOut { satoshis: amount, script_pubkey: script.clone() }], lock_time: 0 };
        let mut candidate = native.clone();
        candidate["txid"] = json!(transaction.txid().to_string());
        candidate["vout"] = json!(0);
        candidate["satoshis"] = json!(amount.to_string());
        input["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().push(candidate);
        input["snapshot"]["payload"]["parents"].as_array_mut().unwrap().push(json!({
            "txid": transaction.txid().to_string(), "rawTransaction": transaction.to_hex()
        }));
    }
}
