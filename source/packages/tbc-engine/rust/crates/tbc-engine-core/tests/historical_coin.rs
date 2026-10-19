use tbc_engine_core::protocols::historical_coin::{
    historical_coin_source, inspect_historical_coin_certificate,
};
use tbc_sdk::{TxOut, Txid, script::Script, contracts::{
    stable_coin::{CoinNftData, scripts}, nft::scripts as nft,
}};

fn certificate(supply: &str, source: u8) -> [TxOut; 3] {
    let data = CoinNftData { nft_name: "USD NFT".into(), nft_symbol: "USD NFT".into(),
        description: "Historical certificate".into(), coin_decimal: 6, coin_total_supply: supply.into() };
    [TxOut {satoshis: 200, script_pubkey: scripts::coin_nft_code_script(&Txid::from_le_bytes([source; 32]).to_string(), 2).unwrap()},
     TxOut {satoshis: 100, script_pubkey: scripts::coin_nft_hold_script_from_hash(&[5; 20], &data.nft_name)},
     TxOut {satoshis: 0, script_pubkey: scripts::coin_nft_tape_script(&data).unwrap()}]
}

#[test]
fn detects_new_certificate_and_existing_supply_increase() {
    let inspect = |outputs: &[TxOut; 3]| inspect_historical_coin_certificate(&outputs[0], Some(&outputs[1]), Some(&outputs[2])).unwrap().unwrap();
    let zero = inspect(&certificate("0", 1));
    let previous = inspect(&certificate("1000", 1));
    let same = inspect(&certificate("1000", 1));
    let reduced = inspect(&certificate("999", 1));
    let minted = inspect(&certificate("1001", 1));
    let changed_source = inspect(&certificate("1000", 2));
    assert!(zero.creates_or_increases_supply(None));
    assert!(!same.creates_or_increases_supply(Some(&previous)));
    assert!(!reduced.creates_or_increases_supply(Some(&previous)));
    assert!(minted.creates_or_increases_supply(Some(&previous)));
    assert!(changed_source.creates_or_increases_supply(Some(&previous)));
    assert_eq!(previous.admin_hash, [5; 20]);
    assert_eq!(previous.source.vout, 2);
}

#[test]
fn full_template_and_hold_tape_binding_are_required() {
    let material = certificate("1000", 1);
    assert!(inspect_historical_coin_certificate(&material[0], None, Some(&material[2])).is_err());
    assert!(inspect_historical_coin_certificate(&material[0], Some(&material[1]), None).is_err());
    for index in 0..3 {
        let mut bad = material.clone(); bad[index].satoshis += 1;
        assert!(inspect_historical_coin_certificate(&bad[0], Some(&bad[1]), Some(&bad[2])).is_err());
    }
    let mut bad = material.clone();
    bad[1].script_pubkey = scripts::coin_nft_hold_script_from_hash(&[5; 20], "Another name");
    assert!(inspect_historical_coin_certificate(&bad[0], Some(&bad[1]), Some(&bad[2])).is_err());
    let mut bytes = material[0].script_pubkey.as_bytes().to_vec(); bytes[0] ^= 1;
    assert!(historical_coin_source(&Script::from_bytes(bytes)).unwrap().is_none());
    let ordinary_nft = nft::code_script(&Txid::from_le_bytes([1; 32]).to_string(), 2).unwrap();
    assert!(historical_coin_source(&ordinary_nft).unwrap().is_none());
}

#[test]
fn malformed_supply_and_wrong_tape_type_fail_without_network() {
    for supply in ["01", "+1", "-1", "1.0", "1000000000000000001", "340282366920938463463374607431768211456"] {
        let bad = certificate(supply, 1);
        assert!(inspect_historical_coin_certificate(&bad[0], Some(&bad[1]), Some(&bad[2])).is_err(), "{supply}");
    }
    let mut bad = certificate("1000", 1);
    bad[2].script_pubkey = nft::tape_script(&serde_json::json!({"collectionName":"fake","supply":10,"description":"fake","file":""})).unwrap();
    assert!(inspect_historical_coin_certificate(&bad[0], Some(&bad[1]), Some(&bad[2])).is_err());
}

#[test]
fn deployed_testnet_certificate_code_requires_full_coin_group() {
    let source = "e70d9b9333e8c4202a22d506845c5bfef73a9ce2e6f650983ef6b57bb9795c07";
    let observed_hex = "5179537f01147f756b756ba87e6c7e786b6b7e6c7ea87e7801247f756b6ba87e6c7eaa56ba01207f547f7581008888786b7e7ea87e7e7eaa6c6c7601207f816b537a887c6c6c766b7b8763008875677524075c79b97bb5f63e9850f6e6e29c3af7fe5b5c8406d5222a20c4e833939b0de7020000008868786c887e7ea857ba8876a96c88ac6a0533436f6465";
    let observed: Vec<u8> = (0..observed_hex.len()).step_by(2)
        .map(|index| u8::from_str_radix(&observed_hex[index..index + 2], 16).unwrap()).collect();
    assert_eq!(observed, nft::code_script(source, 2).unwrap().as_bytes());
    assert!(historical_coin_source(&Script::from_bytes(observed.clone())).unwrap().is_none());
    let data = CoinNftData { nft_name: "Coin USD Test0924 NFT".into(), nft_symbol: "Coin USD Test0924".into(),
        description: "Historical certificate".into(), coin_decimal: 6, coin_total_supply: "0".into() };
    let code = TxOut { satoshis: 200, script_pubkey: Script::from_bytes(observed.clone()) };
    let hold = TxOut { satoshis: 100, script_pubkey: scripts::coin_nft_hold_script_from_hash(&[5; 20], &data.nft_name) };
    let tape = TxOut { satoshis: 0, script_pubkey: scripts::coin_nft_tape_script(&data).unwrap() };
    let certificate = inspect_historical_coin_certificate(&code, Some(&hold), Some(&tape)).unwrap().unwrap();
    assert_eq!(certificate.source.txid.to_string(), source);
    assert_eq!(certificate.source.vout, 2);
    let ordinary_tape = TxOut { satoshis: 0, script_pubkey: nft::tape_script(&serde_json::json!({"nftName":"ordinary","symbol":"NFT","description":"","attributes":"[]","file":""})).unwrap() };
    assert!(inspect_historical_coin_certificate(&code, Some(&hold), Some(&ordinary_tape)).unwrap().is_none());
    let mut changed = observed;
    changed[42] ^= 1;
    assert!(inspect_historical_coin_certificate(&TxOut { satoshis: 200, script_pubkey: Script::from_bytes(changed) }, Some(&hold), Some(&tape)).unwrap().is_none());
}
