//! Public synthetic collection bytes; recognition is not spend authorization.
use serde_json::{json, Value};
use tbc_sdk::{Address, OutPoint, Transaction, TxIn, TxOut, Txid,
    contracts::nft::{scripts, CollectionData}};

fn collection(media_bytes: usize) -> Transaction {
    let owner = Address::from_hash160([0x11; 20]);
    let data = CollectionData { collection_name: "Shared collection".into(),
        description: "public fixture".into(), supply: 3, file: "a".repeat(media_bytes) };
    let mut outputs = vec![TxOut { satoshis: 0, script_pubkey: scripts::tape_script(&data).unwrap() }];
    outputs.extend((0..3).map(|_| TxOut { satoshis: 100, script_pubkey: scripts::mint_script(&owner) }));
    Transaction { version: 10, inputs: vec![TxIn::new(OutPoint { txid: Txid::from_le_bytes([0x22; 32]), vout: 0 })], outputs, lock_time: 0 }
}
fn request(tx: &Transaction) -> Value {
    json!({"phase":"inspectCollection", "contractId":tx.txid().to_string(), "rawTransaction":tx.to_hex()})
}
fn inspect(tx: &Transaction) -> Result<Value, String> {
    tbc_keyless_core::call("inspectTokenMaterial", &request(tx).to_string())
        .map(|raw| serde_json::from_str(&raw).unwrap())
}

#[test]
fn collection_slots_and_owner_share_the_builder_codec_including_large_tape() {
    for bytes in [0, 255, 65_536] {
        let tx = collection(bytes);
        let result = inspect(&tx).unwrap();
        assert_eq!(result, json!({"collectionId":tx.txid().to_string(),
            "ownerAddress":Address::from_hash160([0x11;20]).to_string(), "supply":3,
            "slotScript":hex::encode(tx.outputs[1].script_pubkey.as_bytes()),
            "verification":"collection-template", "generation":"shared"}));
        // Current and historical collections share these bytes: do not invent
        // a generation marker or grant mint permission from this observation.
        if std::env::var("NFT_COLLECTION_DUMP_WIRE").as_deref() == Ok("1") {
            println!("NFT_COLLECTION_WIRE:{}", json!({"input":request(&tx),"result":result}));
        }
    }
}

#[test]
fn collection_inspection_rejects_wrong_identity_supply_slot_owner_and_tape() {
    let valid = collection(0);
    let mut wrong_id = request(&valid); wrong_id["contractId"] = json!("00".repeat(32));
    assert!(tbc_keyless_core::call("inspectTokenMaterial", &wrong_id.to_string()).is_err());
    for case in 0..7 {
        let mut tx = valid.clone();
        match case {
            0 => tx.outputs[1].satoshis = 99,
            1 => tx.outputs[2].script_pubkey = scripts::mint_script(&Address::from_hash160([0x33;20])),
            2 => { tx.outputs.pop(); },
            3 => tx.outputs[0].satoshis = 1,
            4 => tx.outputs[1].script_pubkey = scripts::hold_script(&Address::from_hash160([0x11;20])),
            5 => tx.inputs.clear(),
            _ => tx.version = 1,
        }
        assert!(inspect(&tx).is_err(), "invalid collection case {case}");
    }
    let mut truncated = request(&valid);
    truncated["rawTransaction"] = json!(format!("{}00", valid.to_hex()));
    assert!(tbc_keyless_core::call("inspectTokenMaterial", &truncated.to_string()).is_err());
}
