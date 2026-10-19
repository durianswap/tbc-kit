//! Offline recognition is not permission, consensus or authenticated asset identity.
use serde_json::{Value, json};
use tbc_sdk::{Address, Transaction, TxOut, contracts::{ft::scripts as ft, stable_coin::scripts as stable}};

fn wire(code: &TxOut, tape: &TxOut) -> Value {
    json!({"codeScript":hex::encode(code.script_pubkey.as_bytes()),"codeSatoshis":code.satoshis,
        "tapeScript":hex::encode(tape.script_pubkey.as_bytes()),"tapeSatoshis":tape.satoshis})
}
fn samples() -> Vec<(Value, &'static str, &'static str, u8)> {
    let ft_fixture:Value=serde_json::from_str(include_str!("../../../fixtures/tbc20-standard-transfer.json")).unwrap();
    let coin_fixture:Value=serde_json::from_str(include_str!("../../../fixtures/coin-proof.json")).unwrap();
    let current_ft=Transaction::from_hex(ft_fixture["stages"][1]["signedRaw"].as_str().unwrap()).unwrap();
    let coin=Transaction::from_hex(coin_fixture["vectors"][0]["parentRaw"].as_str().unwrap()).unwrap();
    let mut rows=vec![(wire(&current_ft.outputs[0],&current_ft.outputs[1]),"tbc20","current",1),
        (wire(&coin.outputs[3],&coin.outputs[4]),"tbc20Stablecoin","current",1)];
    let current=tbc_engine_core::protocols::tbc20::parse_code(current_ft.outputs[0].script_pubkey.as_bytes()).unwrap();
    let original=tbc_sdk::contracts::tbc20::Tbc20Outpoint{txid:tbc_sdk::Txid::from_le_bytes([7;32]),output_index:0};
    let code=tbc_sdk::contracts::tbc20::instantiate_tbc20_code(&original,current.controller,61).unwrap();
    let tape=tbc_sdk::contracts::tbc20::build_tbc20_tape([25,0,0,0,0,0],61,&[9]).unwrap();
    rows.push((wire(&TxOut{satoshis:500,script_pubkey:code},&TxOut{satoshis:0,script_pubkey:tape}),"tbc20","historical",1));
    let owner=Address::from_string("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH").unwrap();
    let mut amounts=[0;48];amounts[..8].copy_from_slice(&25u64.to_le_bytes());
    for (version,number) in [(ft::FtMintVersion::V3,3),(ft::FtMintVersion::V4,4)] {
        let tape=ft::mint_tape_script(&amounts,6,"Old FT","OLD");
        let code=ft::mint_code_script_with_version(&"11".repeat(32),0,&owner,tape.as_bytes().len(),version).unwrap();
        rows.push((wire(&TxOut{satoshis:500,script_pubkey:code},&TxOut{satoshis:0,script_pubkey:tape}),"tbc20","historical",number));
    }
    for (version,number) in [(stable::StableCoinMintVersion::V3,3),(stable::StableCoinMintVersion::V4,4)] {
        let tape=stable::coin_tape_script(&amounts,6,"Old Coin","OLD",100);
        let code=stable::coin_mint_code_script_with_version(&[7;20],&owner,&[8;32],tape.as_bytes().len(),version).unwrap();
        rows.push((wire(&TxOut{satoshis:500,script_pubkey:code},&TxOut{satoshis:0,script_pubkey:tape}),"tbc20Stablecoin","historical",number));
    }
    rows
}
fn invoke(pairs:Vec<Value>)->Result<Value,String>{
    let input=json!({"phase":"identifyPairs","pairs":pairs});
    let result:Value=serde_json::from_str(&tbc_keyless_core::call("inspectTokenMaterial",&input.to_string())?).unwrap();
    if std::env::var("TOKEN_IDENTIFICATION_DUMP_WIRE").as_deref()==Ok("1") {println!("TOKEN_IDENTIFICATION_WIRE:{}",json!({"input":input,"result":result}));}
    Ok(result)
}
#[test]
fn identifies_exact_current_and_historical_templates_without_claiming_authority(){
    let samples=samples();let result=invoke(samples.iter().map(|r|r.0.clone()).collect()).unwrap();
    for (i,(_,family,generation,version)) in samples.iter().enumerate(){
        let row=&result["identities"][i];assert_eq!(row["family"],*family);assert_eq!(row["generation"],*generation);assert_eq!(row["protocolVersion"],*version);
        assert_eq!(row["verification"],"exact-template");assert_eq!(row["assetIdentityVerified"],false);
        // SDK identity is SHA256 midstate + ScriptNum code length, not txid.
        assert!(row["codeIdentity"].as_str().is_some_and(|s|(66..=74).contains(&s.len())&&s.len()%2==0));assert!(row["balanceRaw"].as_str().unwrap().parse::<u128>().is_ok());
        assert_eq!(row.get("standardId").is_some(),*generation=="current");
    }
}
#[test]
fn malformed_known_pairs_do_not_downgrade_and_unknown_does_not_mean_native(){
    for (sample,_,_,_) in samples(){
        for field in ["codeSatoshis","tapeSatoshis","tapeScript"]{
            let mut bad=sample.clone();bad[field]=if field=="tapeScript"{json!("006a")}else{json!(1)};
            assert!(invoke(vec![bad]).is_err(),"{field}");
        }
        let mut mutated=sample.clone();let mut code=hex::decode(mutated["codeScript"].as_str().unwrap()).unwrap();code[0]^=1;
        mutated["codeScript"]=json!(hex::encode(code));
        match invoke(vec![mutated]){Ok(r)=>assert!(r["identities"][0].is_null()),Err(_)=>{}}
    }
    let unknown=json!({"codeScript":"51","codeSatoshis":500,"tapeScript":"006a","tapeSatoshis":0});
    assert_eq!(invoke(vec![unknown]).unwrap()["identities"],json!([null]));
}
#[test]
fn identification_bounds_and_input_lock_are_not_authority(){
    let sample=samples()[0].0.clone();assert!(invoke(vec![]).is_err());assert!(invoke(vec![sample.clone();257]).is_err());
    for (key,value) in [("inputLock",json!({"sequence":0,"transactionLockTime":0})),("admin",json!(true)),("codeScript",json!("AB"))]{
        let mut bad=sample.clone();bad[key]=value;assert!(invoke(vec![bad]).is_err());
    }
}
