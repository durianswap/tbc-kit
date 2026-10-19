use serde_json::{Value,json};
use tbc_sdk::{Transaction,hash};
const KEY:&str="0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
fn fixture()->Value{serde_json::from_str(include_str!("../../../fixtures/amm-pool-proof.json")).unwrap()}
fn row<'a>(f:&'a Value,label:&str,op:&str)->&'a Value{f["vectors"].as_array().unwrap().iter().find(|r|r["id"]==format!("{label}-{op}")).unwrap()}
fn raw(f:&Value,id:&str)->Value{json!({"txid":id,"rawTransaction":f["raws"][id]})}
fn call(input:&Value)->Value{
    let result:Value=serde_json::from_str(&tbc_keyless_core::call("inspectAmmMaterial",&input.to_string()).expect("AMM material inspection")).unwrap();
    if std::env::var("AMM_MATERIAL_DUMP_WIRE").as_deref()==Ok("1"){println!("AMM_MATERIAL_WIRE:{}",json!({"input":input,"result":result}));}result
}
#[test]
fn explicit_fee_material_bridge_restores_chain_configuration_and_quotes_without_io(){
    let f:Value=serde_json::from_str(include_str!("../../../fixtures/amm-explicit173-lifecycle.json")).unwrap();
    for row in f["cases"].as_array().unwrap(){
        let id=row["genesisId"].as_str().unwrap();let inspected=call(&json!({"phase":"inspectPool","pool":raw(&f,id)}));
        let mut expected=row["rates"].clone();expected["feeAddress"]=row["feeAddress"].clone();
        assert_eq!(inspected["feePolicy"],expected);assert_eq!(inspected["serviceProviderTagHex"],row["serviceProviderTag"]);
        assert!(inspected.get("lpPlan").is_none());assert!(inspected.get("serviceFeeRate").is_none());
        assert_eq!(inspected["templateRevision"],if row["controlled"]==true{"834610c0726fa0829c50aaa75c3a0b58c046105248f0b023257437a22f8aca22"}else{"a821abdb280268430ad7ea7a9421068a719a8e959b84c11265d4456e8d740db7"});
        for a in row["actions"].as_array().unwrap(){
            let tx=Transaction::from_hex(f["raws"][a["txid"].as_str().unwrap()].as_str().unwrap()).unwrap();
            let current=raw(&f,&tx.inputs[0].previous_output.txid.to_string());
            let action=match a["operation"].as_str().unwrap(){
                "add"=>json!({"kind":"addTbc","amount":"100000","initialFtAmount":"200000"}),
                "buy"=>json!({"kind":"buy","amount":"10000"}),"sell"=>json!({"kind":"sell","amount":"1000"}),
                _=>json!({"kind":"remove","amount":"10000"}),
            };
            let descriptor=call(&json!({"phase":"describe","poolGenesis":raw(&f,id),"ftGenesis":raw(&f,row["ftGenesisId"].as_str().unwrap()),
                "currentPool":current,"publicKey":KEY,"action":action}));
            assert_eq!(descriptor["feePolicy"],expected);assert!(descriptor.get("lpPlan").is_none());
            let quote=call(&json!({"phase":"quote","pool":current,"action":action}));
            assert_eq!(quote["quote"],a["quote"]);
            assert_eq!(quote["feePolicy"]["totalFeeBps"],row["rates"].as_object().unwrap().values().map(|v|v.as_u64().unwrap()).sum::<u64>());
        }
    }
}
fn describe(f:&Value,label:&str,op:Option<&str>)->Value{
    let id=row(f,label,"add")["parentTxid"].as_str().unwrap();
    let inspected=call(&json!({"phase":"inspectPool","pool":raw(f,id)}));
    let mut input=json!({"phase":"describe","poolGenesis":raw(f,id),"ftGenesis":raw(f,inspected["ftContractId"].as_str().unwrap()),"publicKey":KEY});
    if let Some(op)=op{input["currentPool"]=raw(f,row(f,label,op)["parentTxid"].as_str().unwrap());}input
}
#[test]
fn four_profiles_material_keys_and_dependencies_match_actual_sdk_transactions(){
    let f=fixture();
    for label in ["public-plain","public-locked","controller-plain","controller-locked"]{
        let input=describe(&f,label,None);let genesis=call(&input);
        if label.starts_with("public") {
            assert_eq!(genesis["authorization"],json!({"kind":"public"}));
        } else {
            assert_eq!(genesis["authorization"]["kind"],"controller");
            assert_eq!(genesis["authorization"]["accountMatches"],false);
            assert_eq!(genesis["authorization"]["controllerHashes"].as_array().unwrap().len(),1);
        }
        assert_eq!(genesis["state"]["lpAmount"],"0");assert_eq!(genesis["state"]["poolValue"],"1500");
        assert_eq!(genesis["lpTimelock"],label.ends_with("locked"));
        let mut hash=hash::sha256(&hex::decode(genesis["ownerLpScript"].as_str().unwrap()).unwrap());hash.reverse();assert_eq!(genesis["ownerLpScriptHash"],hex::encode(hash));
        for op in ["add","buy","sell","remove"]{
            let desc=call(&describe(&f,label,Some(op)));let vector=row(&f,label,op);
            let mut quote_input=describe(&f,label,Some(op));
            quote_input["action"]=match op{
                "add"=>json!({"kind":"addTbc","amount":"100000","initialFtAmount":"200000"}),
                "buy"=>json!({"kind":"buy","amount":"10000"}),
                "sell"=>json!({"kind":"sell","amount":"1000"}),
                _=>json!({"kind":"remove","amount":"10000"}),
            };
            let q=call(&quote_input);
            assert_eq!(q["requirements"]["nativeAmount"],match op{"add"=>"100000","buy"=>"10000",_=>"0"});
            assert_eq!(q["requirements"]["holderAmount"],match op{"add"=>"200000","sell"=>"1000","remove"=>"10000",_=>"0"});
            assert_eq!(q["requirements"]["holderKind"],match op{"buy"=>Value::Null,"remove"=>json!("lp"),_=>json!("ft")});
            let tx=Transaction::from_hex(vector["currentRaw"].as_str().unwrap()).unwrap();
            let mut parents=std::collections::BTreeMap::new();let mut outputs=vec![];
            for(vin,i)in tx.inputs.iter().enumerate(){
                let id=i.previous_output.txid.to_string();let parent=Transaction::from_hex(f["raws"][&id].as_str().unwrap()).unwrap();
                let script=hex::encode(parent.outputs[i.previous_output.vout as usize].script_pubkey.as_bytes());
                let kind=if vin==2{assert_eq!(script,desc["poolFtScript"]);Some("ft")}
                    else if vin==1&&op!="buy"{assert_eq!(script,desc[if op=="remove"{"ownerLpScript"}else{"ownerFtScript"}]);Some(if op=="remove"{"lp"}else{"ft"})}else{None};
                if let Some(kind)=kind{parents.insert(id.clone(),raw(&f,&id));outputs.push(json!({"txid":id,"vout":i.previous_output.vout,"kind":kind}));}
            }
            let inspected=call(&json!({"phase":"inspectAssets","parents":parents.values().collect::<Vec<_>>(),"outputs":outputs}));
            assert_eq!(inspected["items"].as_array().unwrap().len(),outputs.len());
            for item in inspected["items"].as_array().unwrap(){
                let parent=Transaction::from_hex(f["raws"][item["txid"].as_str().unwrap()].as_str().unwrap()).unwrap();
                assert!(item["balance"].as_str().unwrap().parse::<u128>().is_ok());
                let mut unique=std::collections::BTreeSet::new();
                for d in item["dependencies"].as_array().unwrap(){let key=(d["txid"].as_str().unwrap(),d["vout"].as_u64().unwrap());assert!(unique.insert(key));
                    assert!(parent.inputs.iter().any(|i|i.previous_output.txid.to_string()==key.0&&i.previous_output.vout as u64==key.1));}
                assert!(unique.len()<=6);
                if item["kind"]=="lp" {assert_eq!(item["lockTime"],if label.ends_with("locked"){json!(829999)}else{json!(0)});}
            }
        }
    }
}
#[test]
fn controller_material_reports_required_role_without_granting_account_authority(){
    let f=fixture();
    // Public fixture keys only: controller scalar 2, unrelated scalar 3.
    let controller="02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    let unrelated="02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
    for label in ["public-plain","public-locked","controller-plain","controller-locked"] {
        let input=describe(&f,label,Some("buy"));
        let baseline=call(&input);
        for key in [controller,unrelated] {
            let mut selected=input.clone();selected["publicKey"]=json!(key);
            let result=call(&selected);
            assert_eq!(result["poolCodeScript"],baseline["poolCodeScript"]);
            assert_eq!(result["snapshotHash"],baseline["snapshotHash"]);
            if label.starts_with("public") {
                assert_eq!(result["authorization"],json!({"kind":"public"}));
            } else {
                assert_eq!(result["authorization"]["controllerHashes"],baseline["authorization"]["controllerHashes"]);
                assert_eq!(result["authorization"]["accountMatches"],key==controller);
            }
        }
    }
}
#[test]
fn explicit_controller_does_not_replace_holder_material_identity(){
    let f=fixture();
    let controller="02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    for label in ["controller-plain","controller-locked"] {
        let mut input=describe(&f,label,Some("buy"));
        let baseline=call(&input);
        input["controllerPublicKey"]=json!(controller);
        let explicit=call(&input);
        assert_eq!(explicit["authorization"]["accountMatches"],true);
        for field in ["ownerLpScript","ownerLpScriptHash","ownerFtScript","ownerFtScriptHash","ownerCombineScript","poolFtScript","snapshotHash"] {
            assert_eq!(explicit[field],baseline[field],"Holder and material identity changed: {field}");
        }
        input["controllerPublicKey"]=json!(KEY);
        assert_eq!(call(&input)["authorization"]["accountMatches"],false);
        input["controllerPublicKey"]=json!("00".repeat(33));
        assert!(tbc_keyless_core::call("inspectAmmMaterial",&input.to_string()).is_err());
    }
}
#[test]
fn material_quote_uses_bound_state_and_canonical_amounts(){
    let f=fixture();let mut input=describe(&f,"public-plain",Some("buy"));
    input["action"]=json!({"kind":"addFt","amount":"2000"});
    let quoted=call(&input);assert_eq!(quoted["requirements"]["holderAmount"],"2000");
    assert_eq!(quoted["requirements"]["nativeAmount"],"1000");
    for value in ["0","01","-1","1.5","9223372036854775808"]{
        let mut bad=input.clone();bad["action"]["amount"]=json!(value);
        assert!(tbc_keyless_core::call("inspectAmmMaterial",&bad.to_string()).is_err());
    }
    input.as_object_mut().unwrap().remove("currentPool");
    assert!(tbc_keyless_core::call("inspectAmmMaterial",&input.to_string()).is_err());
}
#[test]
fn public_quote_matches_fixed_sdk_next_pool_without_an_account_or_network(){
    let f=fixture();
    for label in ["public-plain","public-locked","controller-plain","controller-locked"]{
        for op in ["add","buy","sell","remove"]{
            let vector=row(&f,label,op);
            let action=match op{
                "add"=>json!({"kind":"addTbc","amount":"100000","initialFtAmount":"200000"}),
                "buy"=>json!({"kind":"buy","amount":"10000"}),
                "sell"=>json!({"kind":"sell","amount":"1000"}),
                _=>json!({"kind":"remove","amount":"10000"}),
            };
            let input=json!({"phase":"quote","pool":raw(&f,vector["parentTxid"].as_str().unwrap()),"action":action});
            let quoted=call(&input);
            let tx=Transaction::from_hex(vector["currentRaw"].as_str().unwrap()).unwrap();
            let actual=call(&json!({"phase":"inspectPool","pool":{"txid":tx.txid().to_string(),"rawTransaction":vector["currentRaw"]}}));
            assert_eq!(quoted["kind"],action["kind"]);
            assert_eq!(quoted["basis"],"local-pool-transaction");
            assert_eq!(quoted["poolOutpoint"],json!({"txid":vector["parentTxid"],"vout":0}));
            for (amount,state) in [("ftLpAmount","lpAmount"),("ftAAmount","ftAmount"),("tbcAmount","tbcAmount"),("poolValue","poolValue")]{
                assert_eq!(quoted["quote"]["nextState"][amount],actual["state"][state],"{label}/{op}/{amount}");
                assert!(quoted["quote"]["nextState"][amount].is_string());
            }
        }
    }
}
#[test]
fn public_quote_rejects_fee_overrides_wrong_identity_and_invalid_amounts(){
    let f=fixture();let parent=row(&f,"public-plain","buy")["parentTxid"].as_str().unwrap();
    let input=json!({"phase":"quote","pool":raw(&f,parent),"action":{"kind":"buy","amount":"10000"}});
    for case in 0..8{let mut bad=input.clone();match case{
        0=>bad["pool"]["txid"]=json!("00".repeat(32)),
        1=>bad["feePolicy"]=json!({"totalFeeBps":0}),
        2=>bad["action"]["serviceFeeRate"]=json!(0),
        3=>bad["action"]["amount"]=json!("0"),
        4=>bad["action"]["amount"]=json!("01"),
        5=>bad["action"]["amount"]=json!("9223372036854775808"),
        6=>bad["action"]["amount"]=json!(10000),
        _=>bad["privateKey"]=json!("forbidden"),
    }assert!(tbc_keyless_core::call("inspectAmmMaterial",&bad.to_string()).is_err(),"case {case}");}
}
#[test]
fn public_quote_add_ft_uses_existing_reserve_rounding(){
    let f=fixture();let id=row(&f,"public-plain","buy")["parentTxid"].as_str().unwrap();
    let input=json!({"phase":"quote","pool":raw(&f,id),"action":{"kind":"addFt","amount":"2000"}});
    let q=call(&input);
    assert_eq!(q["quote"]["ftAIncrementRaw"],"2000");
    assert_eq!(q["quote"]["tbcIncrementSat"],"1000");
    assert_eq!(q["quote"]["tbcReserveIncrementSat"],"1000");
    assert_eq!(q["quote"]["ftLpIncrementRaw"],"1000");
    assert_eq!(q["quote"]["isFirstAddLP"],false);
}
#[test]
fn material_api_rejects_wrong_identity_template_shape_and_secret_fields(){
    let f=fixture();let good=describe(&f,"public-plain",Some("buy"));
    for case in 0..7{let mut bad=good.clone();match case{
        0=>bad["poolGenesis"]["txid"]=json!("00".repeat(32)),
        1=>bad["ftGenesis"]=describe(&f,"public-locked",None)["ftGenesis"].clone(),
        2=>bad["publicKey"]=json!("00".repeat(33)),
        3=>bad["currentPool"]=raw(&f,row(&f,"controller-plain","buy")["parentTxid"].as_str().unwrap()),
        4=>bad["privateKey"]=json!("forbidden"),
        5=>bad["poolGenesis"]["secret"]=json!("forbidden"),
        _=>bad["poolGenesis"]=raw(&f,row(&f,"public-plain","buy")["parentTxid"].as_str().unwrap()),
    }assert!(tbc_keyless_core::call("inspectAmmMaterial",&bad.to_string()).is_err(),"case {case}");}
    let id=row(&f,"public-plain","add")["parentTxid"].as_str().unwrap();let parent=raw(&f,id);
    for input in [json!({"phase":"inspectAssets","parents":[parent.clone(),parent.clone()],"outputs":[{"txid":id,"vout":2,"kind":"ft"}]}),
        json!({"phase":"inspectAssets","parents":[parent],"outputs":[{"txid":id,"vout":2,"kind":"lp"}]}),
        json!({"phase":"inspectAssets","parents":[],"outputs":[]})]{assert!(tbc_keyless_core::call("inspectAmmMaterial",&input.to_string()).is_err());}
}
