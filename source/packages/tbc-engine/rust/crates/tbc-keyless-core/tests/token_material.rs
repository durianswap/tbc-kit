//! Public fixtures only: exact pair recognition is not issuance/spend authority.
use serde_json::{Value,json};
use tbc_sdk::Transaction;

fn samples()->Vec<(String,Value)>{
    let ft:Value=serde_json::from_str(include_str!("../../../fixtures/tbc20-standard-transfer.json")).unwrap();
    let coin:Value=serde_json::from_str(include_str!("../../../fixtures/coin-proof.json")).unwrap();
    [(ft["stages"][1]["signedRaw"].as_str().unwrap(),0,"tbc20-standard"),
     (coin["vectors"][0]["parentRaw"].as_str().unwrap(),3,"tbc20-stablecoin")]
    .iter().map(|(raw,index,standard)|{
        let tx=Transaction::from_hex(raw).unwrap();
        ((*standard).to_string(),json!({"codeScript":hex::encode(tx.outputs[*index].script_pubkey.as_bytes()),
            "codeSatoshis":tx.outputs[*index].satoshis,"tapeScript":hex::encode(tx.outputs[*index+1].script_pubkey.as_bytes()),
            "tapeSatoshis":tx.outputs[*index+1].satoshis}))
    }).collect()
}
fn call(request:Value)->Value{
    let result:Value=serde_json::from_str(&tbc_keyless_core::call("inspectTokenMaterial",&request.to_string()).unwrap()).unwrap();
    if std::env::var("TOKEN_MATERIAL_DUMP_WIRE").as_deref()==Ok("1"){
        println!("TOKEN_MATERIAL_WIRE:{}",json!({"input":request,"result":result}));
    }result
}
#[test]
fn exact_codes_and_pairs_share_receipt_semantics(){
    let samples=samples();
    let codes=call(json!({"phase":"inspectCodes","scripts":samples.iter().map(|(_,p)|p["codeScript"].clone()).collect::<Vec<_>>()}));
    let pairs=call(json!({"phase":"inspectPairs","pairs":samples.iter().map(|(_,p)|p.clone()).collect::<Vec<_>>()}));
    for (i,(standard,pair)) in samples.iter().enumerate(){
        assert_eq!(codes["codes"][i]["standardId"],*standard);
        assert_eq!(pairs["pairs"][i]["code"],codes["codes"][i]);
        assert_eq!(codes["codes"][i]["tapeSize"].as_u64().unwrap() as usize,pair["tapeScript"].as_str().unwrap().len()/2);
        assert!(pairs["pairs"][i]["balanceRaw"].as_str().unwrap().parse::<u128>().is_ok());
        assert_eq!(codes["codes"][i]["assetIdentityVerified"],false);
        assert_eq!(codes["codes"][i]["verification"],"exact-template");
    }
    assert!(codes["codes"][0]["originalOutpoint"].is_object());
    assert!(codes["codes"][1]["coinNftCodeHash"].is_string());
    assert!(pairs["pairs"][1]["lockTime"].is_number());
}
#[test]
fn unknown_template_is_not_a_token_and_known_invalid_pair_fails(){
    let samples=samples();
    let mut altered=samples[0].1["codeScript"].as_str().unwrap().to_string();altered.replace_range(..2,"61");
    assert_eq!(call(json!({"phase":"inspectCodes","scripts":["51",altered]}))["codes"],json!([null,null]));
    for (_,pair) in samples{
        for field in ["codeSatoshis","tapeSatoshis","tapeScript"]{
            let mut bad=pair.clone();bad[field]=if field=="tapeScript"{json!("006a")}else{json!(1)};
            assert!(tbc_keyless_core::call("inspectTokenMaterial",&json!({"phase":"inspectPairs","pairs":[bad]}).to_string()).is_err());
        }
    }
    for bad in [json!({"phase":"inspectCodes","scripts":[]}),
        json!({"phase":"inspectCodes","scripts":vec!["51";257]}),
        json!({"phase":"inspectCodes","scripts":["AB"]}),
        json!({"phase":"inspectCodes","scripts":["51"],"privateKey":"forbidden"}),
        json!({"phase":"inspectPairs","pairs":[{"codeScript":"51","codeSatoshis":0,"tapeScript":"006a","tapeSatoshis":0}]})]{
        assert!(tbc_keyless_core::call("inspectTokenMaterial",&bad.to_string()).is_err());
    }
}

#[test]
fn coin_input_lock_is_verified_without_administrator_or_chain_authority(){
    let pair=samples()[1].1.clone();
    for lock in [0,12,500_000_001u32]{
        let mut p=pair.clone();let tape=hex::decode(p["tapeScript"].as_str().unwrap()).unwrap();
        p["tapeScript"]=json!(hex::encode(tbc_engine_core::protocols::coin::set_lock_time(&tape,lock).unwrap()));
        p["inputLock"]=json!({"sequence":u32::MAX-1,"transactionLockTime":lock});
        let result=call(json!({"phase":"inspectPairs","pairs":[p.clone()]}));
        assert_eq!(result["pairs"][0]["inputLockChecked"],true);assert_eq!(result["pairs"][0]["lockTime"],lock);
        for bad in [json!({"sequence":u32::MAX,"transactionLockTime":lock}),
            json!({"sequence":u32::MAX-1,"transactionLockTime":lock,"administrator":true})]{
            p["inputLock"]=bad;
            assert!(tbc_keyless_core::call("inspectTokenMaterial",&json!({"phase":"inspectPairs","pairs":[p.clone()]}).to_string()).is_err());
        }
        if lock!=0{
            for tx_lock in [lock-1,if lock<500_000_000{500_000_000}else{499_999_999}]{
                p["inputLock"]=json!({"sequence":u32::MAX-1,"transactionLockTime":tx_lock});
                assert!(tbc_keyless_core::call("inspectTokenMaterial",&json!({"phase":"inspectPairs","pairs":[p.clone()]}).to_string()).is_err());
            }
        }
    }
}
