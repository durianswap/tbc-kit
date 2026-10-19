//! Local read hints only. Public fixtures; no I/O or signing authority.
use serde_json::{Value,json};
use tbc_sdk::{Transaction,TxOut,script::Script};
use tbc_engine_core::protocols::lop::{Code,Market,Side,TapeMarker,Terms,AssetTerms};
fn raw(tx:&Transaction)->Value{json!({"txid":tx.txid().to_string(),"rawTransaction":tx.to_hex()})}
fn call(input:&Value)->Value{
    let result:Value=serde_json::from_str(&tbc_keyless_core::call("inspectLopMaterial",&input.to_string()).unwrap()).unwrap();
    if std::env::var("LOP_MATERIAL_DUMP_WIRE").as_deref()==Ok("1") {println!("LOP_MATERIAL_WIRE:{}",json!({"input":input,"result":result}));}result
}
fn coin()->(Transaction,Transaction){
    let f:Value=serde_json::from_str(include_str!("../../../fixtures/coin-proof.json")).unwrap();
    (Transaction::from_hex(f["vectors"][0]["parentRaw"].as_str().unwrap()).unwrap(),
     Transaction::from_hex(f["vectors"][0]["ancestorsRaw"][0].as_str().unwrap()).unwrap())
}
fn order()->Transaction{
    let mut tx=coin().0;
    let code=Code{side:Side::Sell,market:Market::NativeToken{token_code_bytes:2981,marker:TapeMarker::Modern},tax_hash:[2;20],
        terms:Terms{owner_hash:[1;20],sale_volume:10000,unit_price:2000000,fee_rate:100,
            asset_a:AssetTerms{partial_hash:[3;32],contract_id:[4;32]},asset_b:None}};
    tx.outputs=vec![TxOut{satoshis:10000,script_pubkey:Script::from_bytes(code.encode().unwrap())}];tx
}
#[test]
fn exact_public_token_and_order_material_is_keyless(){
    let f:Value=serde_json::from_str(include_str!("../../../fixtures/tbc20-standard-transfer.json")).unwrap();
    let ft=Transaction::from_hex(f["stages"][1]["signedRaw"].as_str().unwrap()).unwrap();
    let (holder,issuer)=coin();
    for(tx,vout,standard)in [(&ft,0,"tbc20-standard"),(&holder,3,"tbc20-stablecoin")]{
        let value=call(&json!({"phase":"inspectAsset","parent":raw(tx),"vout":vout}));
        assert_eq!(value["standardId"],standard);assert_eq!(value["txid"],tx.txid().to_string());
        assert!(value["dependencies"].as_array().unwrap().len()<=6);
        assert_eq!(value["scriptPubKey"],hex::encode(tx.outputs[vout as usize].script_pubkey.as_bytes()));
    }
    let sample=call(&json!({"phase":"coinSample","issuer":raw(&issuer),"parent":raw(&holder)}));
    assert_eq!(sample["standardId"],"tbc20-stablecoin");assert_eq!(sample["vout"],3);
    let value=call(&json!({"phase":"inspectOrder","parent":raw(&order()),"vout":0}));
    assert_eq!(value["market"],"native-token");assert_eq!(value["side"],"sell");assert_eq!(value["escrow"],Value::Null);
    assert_eq!(value["saleVolume"],"10000");assert_eq!(value["ownerHash"],"01".repeat(20));
}
#[test]
fn malformed_raw_identity_unknown_fields_and_unbound_coin_fail_closed(){
    let baseline=json!({"phase":"inspectOrder","parent":raw(&order()),"vout":0});
    for n in 0..6{
        let mut bad=baseline.clone();match n{
            0=>bad["parent"]["txid"]=json!("00".repeat(32)),
            1=>bad["parent"]["rawTransaction"]=json!(baseline["parent"]["rawTransaction"].as_str().unwrap().to_uppercase()),
            2=>bad["vout"]=json!(u32::MAX),3=>bad["privateKey"]=json!("forbidden"),
            4=>bad["phase"]=json!("sign"),_=>bad["parent"]["rawTransaction"]=json!("00"),
        }assert!(tbc_keyless_core::call("inspectLopMaterial",&bad.to_string()).is_err());
    }
    let (holder,mut issuer)=coin();issuer.lock_time+=1;
    assert!(tbc_keyless_core::call("inspectLopMaterial",&json!({"phase":"coinSample","issuer":raw(&issuer),"parent":raw(&holder)}).to_string()).is_err());
    let mut changed=order();let mut script=changed.outputs[0].script_pubkey.as_bytes().to_vec();script[0]^=1;
    changed.outputs[0].script_pubkey=Script::from_bytes(script);
    assert!(tbc_keyless_core::call("inspectLopMaterial",&json!({"phase":"inspectOrder","parent":raw(&changed),"vout":0}).to_string()).is_err());
}

#[test]
fn exact_order_script_batch_preserves_all_terms_without_authority(){
    let original=order();let base=Code::decode(original.outputs[0].script_pubkey.as_bytes()).unwrap();
    let mut codes=Vec::new();
    for pair in [false,true]{for side in [Side::Buy,Side::Sell]{
        let mut code=base.clone();code.side=side;
        // Never coerce u64 order fields through JS Number.
        code.terms.sale_volume=9_007_199_254_740_993;
        if pair{code.market=Market::TokenToken{a:TapeMarker::Modern,b:TapeMarker::Modern};
            code.terms.asset_b=Some(AssetTerms{partial_hash:[5;32],contract_id:[6;32]});}
        codes.push(code);
    }}
    let mut scripts=codes.iter().map(|c|hex::encode(c.encode().unwrap())).collect::<Vec<_>>();
    let mut altered=codes[0].encode().unwrap();altered[0]^=1;
    scripts.push(hex::encode(altered));scripts.push("51".into());
    let request=json!({"phase":"inspectOrderScripts","scripts":scripts});
    let result:Value=serde_json::from_str(&tbc_keyless_core::call("inspectLopMaterial",&request.to_string()).unwrap()).unwrap();
    if std::env::var("LOP_REVIEW_DUMP_WIRE").as_deref()==Ok("1"){
        println!("LOP_REVIEW_WIRE:{}",json!({"input":request,"result":result}));
    }
    let rows=result["orders"].as_array().unwrap();assert_eq!(rows.len(),6);
    for (index,code) in codes.iter().enumerate(){
        assert_eq!(result["controllers"][index],hex::encode(code.token_controller().unwrap()));
        let row=&rows[index];assert_eq!(row["saleVolume"],"9007199254740993");
        assert_eq!(row["side"],if code.side==Side::Buy{"buy"}else{"sell"});
        assert_eq!(row["feeScale"],"1000000");assert_eq!(row["priceScale"],"1000000");
        assert_eq!(row["ownerHash"],"01".repeat(20));assert_eq!(row["feeRecipientHash"],"02".repeat(20));
        assert_eq!(row["quoteAsset"]["contractId"],if index<2{"04".repeat(32)}else{"06".repeat(32)});
        if index<2{assert_eq!(row["baseAsset"]["kind"],"native");}
        else{assert_eq!(row["baseAsset"]["partialHash"],"03".repeat(32));}
    }
    assert!(rows[4].is_null());assert!(rows[5].is_null());
    for bad in [json!({"phase":"inspectOrderScripts","scripts":[]}),
        json!({"phase":"inspectOrderScripts","scripts":vec!["51";257]}),
        json!({"phase":"inspectOrderScripts","scripts":["AB"]}),
        json!({"phase":"inspectOrderScripts","scripts":["51"],"privateKey":"forbidden"})]{
        assert!(tbc_keyless_core::call("inspectLopMaterial",&bad.to_string()).is_err());
    }
}
