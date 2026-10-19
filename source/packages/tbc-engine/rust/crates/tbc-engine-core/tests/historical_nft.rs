use tbc_engine_core::protocols::historical_nft::{historical_nft_identity, inspect_historical_nft,
    inspect_historical_mint_slot, inspect_historical_collection_slot};
use tbc_sdk::{Address, OutPoint, TxOut, Txid, script::Script,
    contracts::nft::{CollectionData, NftData, scripts}};

fn owner(hash: u8) -> Address { Address::from_hash160([hash; 20]) }
fn pair(version: u8, token_id: u32, holder: u8) -> [TxOut; 3] {
    let collection = Txid::from_le_bytes([7; 32]).to_string();
    let code = if version == 1 { scripts::code_script_v1(&collection, token_id) } else { scripts::code_script(&collection, token_id) }.unwrap();
    [TxOut { satoshis: 200, script_pubkey: code },
     TxOut { satoshis: 100, script_pubkey: scripts::hold_script(&owner(holder)) },
     TxOut { satoshis: 0, script_pubkey: scripts::tape_script(&NftData {
        nft_name: "Historical NFT".into(), symbol: "OLD".into(), description: "unchanged".into(), attributes: "[]".into(), file: None,
     }).unwrap() }]
}

#[test]
fn full_identity_distinguishes_new_token_from_holder_transfer() {
    for version in [1, 2] {
        let before = pair(version, 3, 1); let after = pair(version, 3, 2); let minted = pair(version, 4, 2);
        let input = inspect_historical_nft(&before[0], Some(&before[1]), Some(&before[2])).unwrap().unwrap();
        let output = inspect_historical_nft(&after[0], Some(&after[1]), Some(&after[2])).unwrap().unwrap();
        let new_token = inspect_historical_nft(&minted[0], Some(&minted[1]), Some(&minted[2])).unwrap().unwrap();
        assert_eq!(input.identity, output.identity); assert_eq!(input.tape_script, output.tape_script);
        assert_ne!(input.controller, output.controller); assert_eq!(output.controller[20], 0);
        assert_ne!(input.identity, new_token.identity);
        assert_eq!(input.identity.collection_id, Txid::from_le_bytes([7; 32]).to_string());
        assert_eq!(input.identity.token_id, 3);
        let wrong = scripts::code_script(&Txid::from_le_bytes([8; 32]).to_string(), 3).unwrap();
        assert_ne!(historical_nft_identity(&wrong).unwrap().unwrap().collection_id, input.identity.collection_id);
    }
}

#[test]
fn suffixes_are_not_identity_and_current_code_is_not_historical() {
    let original = pair(2, 1, 1);
    let mut malformed = original[0].script_pubkey.as_bytes().to_vec(); malformed[0] ^= 1;
    assert!(historical_nft_identity(&Script::from_bytes(malformed)).is_err());
    let mut fake_v0 = vec![0; 142]; fake_v0[136..].copy_from_slice(b"\x053Code");
    assert!(historical_nft_identity(&Script::from_bytes(fake_v0)).unwrap_err().contains("complete origin-bound template"));
    let current = tbc_engine_core::protocols::tbc721::instantiate_code(
        &tbc_engine_core::protocols::tbc721::CodeDescriptor {
            original_outpoint: OutPoint {txid: Txid::from_le_bytes([7;32]), vout: 1},
        });
    assert!(historical_nft_identity(&Script::from_bytes(current)).unwrap().is_none());
    assert!(historical_nft_identity(&owner(1).script_pubkey()).unwrap().is_none());
    let mut fake_hold = original[1].clone();
    let mut script = fake_hold.script_pubkey.as_bytes().to_vec(); script[0] ^= 1;
    fake_hold.script_pubkey = Script::from_bytes(script);
    assert!(inspect_historical_nft(&original[0], Some(&fake_hold), Some(&original[2])).is_err());
}

#[test]
fn known_code_requires_complete_canonical_hold_and_tape() {
    let original = pair(2, 1, 1);
    assert!(inspect_historical_nft(&original[0], None, Some(&original[2])).is_err());
    assert!(inspect_historical_nft(&original[0], Some(&original[1]), None).is_err());
    for which in 0..3 {
        let mut bad = original.clone(); bad[which].satoshis += 1;
        assert!(inspect_historical_nft(&bad[0], Some(&bad[1]), Some(&bad[2])).is_err());
    }
    let mut bad = original.clone();
    bad[2].script_pubkey = scripts::tape_script(&serde_json::json!({"unrelated":true})).unwrap();
    assert!(inspect_historical_nft(&bad[0], Some(&bad[1]), Some(&bad[2])).is_err());
    for bytes in [vec![0,106,78,255,255,255,255], vec![0,106,76], vec![0,106,1,0,5,b'N',b'T',b'a',b'p',b'e',0]] {
        bad[2].script_pubkey = Script::from_bytes(bytes);
        assert!(inspect_historical_nft(&bad[0], Some(&bad[1]), Some(&bad[2])).is_err());
    }
    // Otherwise valid JSON with a non-direct marker must not silently widen the
    // historical receipt parser's accepted framing.
    let mut non_direct = original[2].script_pubkey.as_bytes().to_vec();
    let marker_start = non_direct.len() - 6;
    non_direct.splice(marker_start..marker_start + 1, [0x4c, 5]);
    bad[2].script_pubkey = Script::from_bytes(non_direct);
    assert!(inspect_historical_nft(&bad[0], Some(&bad[1]), Some(&bad[2])).is_err());
}

#[test]
fn collection_mint_slot_is_not_an_issued_nft_identity() {
    let point = OutPoint { txid: Txid::from_le_bytes([7;32]), vout: 2 };
    let slot = TxOut { satoshis: 100, script_pubkey: scripts::mint_script(&owner(1)) };
    let tape = TxOut { satoshis: 0, script_pubkey: scripts::tape_script(&CollectionData {
        collection_name: "Old collection".into(), description: "test".into(), supply: 3, file: "ipfs://example".into(),
    }).unwrap() };
    assert!(inspect_historical_nft(&slot, None, None).unwrap().is_none());
    assert!(inspect_historical_mint_slot(&slot).unwrap().is_some());
    let classified = inspect_historical_collection_slot(&point, &slot, Some(&tape)).unwrap().unwrap();
    assert_eq!(classified.collection_id, point.txid.to_string()); assert_eq!(classified.token_id, 2);
    assert!(inspect_historical_collection_slot(&point, &slot, None).is_err());
    for vout in [0,4] {
        assert!(inspect_historical_collection_slot(&OutPoint {txid:point.txid,vout}, &slot, Some(&tape)).is_err());
    }
    let current_hold = pair(2, 1, 1)[1].clone();
    assert!(inspect_historical_mint_slot(&current_hold).unwrap().is_none());
}
