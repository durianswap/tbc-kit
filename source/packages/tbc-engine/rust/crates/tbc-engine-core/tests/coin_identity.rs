use tbc_engine_core::protocols::{coin,coin_identity::{inspect_genesis,inspect_issuer,validate_holder_identity},coin_proof};
use tbc_sdk::{Transaction,script::Script};
fn fixture()->serde_json::Value {serde_json::from_str(include_str!("../../../fixtures/coin-proof.json")).unwrap()}
fn pair()->(Transaction,Transaction) {
    let f=fixture();(Transaction::from_hex(f["vectors"][0]["parentRaw"].as_str().unwrap()).unwrap(),
        Transaction::from_hex(f["vectors"][0]["ancestorsRaw"][0].as_str().unwrap()).unwrap())
}
fn tape(value:&serde_json::Value)->Script {
    let mut script=Script::from_bytes(vec![0,0x6a]);script.push_data(&serde_json::to_vec(value).unwrap());script.push_data(b"NTape");script
}
fn certificate(supply:&str)->serde_json::Value {
    serde_json::json!({"nftName":"Offline Coin NFT","nftSymbol":"OFF NFT",
        "description":"The issuance certificate for the stablecoin, recording cumulative supply and issuance history.",
        "coinDecimal":0,"coinTotalSupply":supply})
}

#[test]
fn coin_initial_identity_binds_fixed_sdk_certificate_and_vout_three() {
    let (mint,issuer)=pair();
    let identity=inspect_genesis(&mint.txid(),&mint.serialize(),&issuer.serialize()).unwrap();
    assert_eq!(identity.genesis.selected().vout,3);
    assert_eq!(identity.name,"Offline Coin");assert_eq!(identity.symbol,"OFF");
    assert_eq!(identity.decimals,0);assert_eq!(identity.initial_supply,1000);
    assert_eq!(identity.certificate_origin,issuer.inputs[0].previous_output);
    assert_eq!(identity.genesis.code().coin_nft_code_hash,tbc_sdk::hash::sha256(issuer.outputs[0].script_pubkey.as_bytes()));
    assert!(inspect_genesis(&issuer.txid(),&mint.serialize(),&issuer.serialize()).is_err());
    let f=fixture();let transferred=Transaction::from_hex(f["vectors"][0]["signedRaw"].as_str().unwrap()).unwrap();
    assert!(inspect_genesis(&transferred.txid(),&transferred.serialize(),&mint.serialize()).is_err());
}

#[test]
fn coin_public_asset_id_is_issuer_source_not_sdk_mutable_mint_id() {
    let (mint,issuer)=pair();
    let root=inspect_issuer(&issuer.txid(),&issuer.serialize()).unwrap();
    assert_eq!(root.name,"Offline Coin");assert_eq!(root.decimals,0);
    assert!(inspect_issuer(&mint.txid(),&mint.serialize()).is_err());
    assert!(inspect_issuer(&mint.txid(),&issuer.serialize()).is_err());
    let parent=coin_proof::inspect_parent(&mint.serialize(),&tbc_sdk::OutPoint{txid:mint.txid(),vout:3},None).unwrap();
    validate_holder_identity(&root,&parent).unwrap();
    for case in 0..4 {
        let mut bad=root.clone();
        match case {0=>bad.code_hash[0]^=1,1=>bad.admin_hash[0]^=1,2=>bad.name.push('x'),_=>bad.decimals+=1}
        assert!(validate_holder_identity(&bad,&parent).is_err());
    }
    let mut false_source=issuer.clone();false_source.inputs[0].previous_output.vout+=1;
    assert!(inspect_issuer(&false_source.txid(),&false_source.serialize()).is_err());
}

#[test]
fn coin_initial_identity_rejects_rehashed_mint_shape_supply_metadata_and_admin() {
    for case in 0..10 {
        let (mut mint,issuer)=pair();
        match case {
            0=>mint.inputs[2].previous_output.vout=2,
            1=>mint.outputs[3].satoshis=501,
            2=>{let mut amounts=coin::parse_tape(mint.outputs[4].script_pubkey.as_bytes(),None).unwrap().amounts;
                amounts[0]-=1;mint.outputs[4].script_pubkey=Script::from_bytes(coin::replace_tape_amounts(mint.outputs[4].script_pubkey.as_bytes(),amounts).unwrap());},
            3=>mint.outputs[2].script_pubkey=tape(&certificate("1001")),
            4=>{let mut data=certificate("1000");data["coinDecimal"]=serde_json::json!(1);mint.outputs[2].script_pubkey=tape(&data);},
            5=>{let mut code=coin::parse_code(mint.outputs[3].script_pubkey.as_bytes()).unwrap();code.admin_pubkey_hash[0]^=1;
                mint.outputs[3].script_pubkey=Script::from_bytes(coin::instantiate_code(&code).unwrap());},
            6=>mint.outputs.last_mut().unwrap().satoshis=issuer.outputs[3].satoshis,
            7=>mint.outputs[1].script_pubkey=Script::from_bytes(vec![0x51]),
            8=>mint.lock_time=1,
            _=>mint.outputs[4].script_pubkey=Script::from_bytes(coin::set_lock_time(mint.outputs[4].script_pubkey.as_bytes(),1).unwrap()),
        }
        // Use the changed mint's own txid; the error must be more than a stale
        // hash mismatch obscuring an omitted semantic binding.
        assert!(inspect_genesis(&mint.txid(),&mint.serialize(),&issuer.serialize()).is_err(),"case {case}");
    }
}

#[test]
fn coin_initial_identity_rejects_reissuance_as_genesis_and_forged_certificate_origin() {
    for case in 0..4 {
        let (mut mint,mut issuer)=pair();
        match case {
            0=>issuer.outputs[2].script_pubkey=tape(&certificate("1000")),
            1=>issuer.inputs[0].previous_output.vout+=1,
            2=>issuer.outputs[0].satoshis=201,
            _=>issuer.outputs[1].satoshis=101,
        }
        for input in &mut mint.inputs {input.previous_output.txid=issuer.txid();}
        mint.outputs[0]=issuer.outputs[0].clone();mint.outputs[1]=issuer.outputs[1].clone();
        assert!(inspect_genesis(&mint.txid(),&mint.serialize(),&issuer.serialize()).is_err(),"case {case}");
    }
}
