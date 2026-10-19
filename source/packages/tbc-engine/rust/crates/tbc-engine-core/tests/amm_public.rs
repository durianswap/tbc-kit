use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use secp256k1::{Message,Secp256k1,SecretKey};
use tbc_engine_core::{call_json,EngineMethod,protocols::{amm_code,amm_profile,amm_state::PoolConfig}};
use tbc_sdk::{Transaction,hash as tbc_hash};
fn base()->Value{serde_json::from_str(include_str!("../../../fixtures/tbc-transfer.json")).unwrap()}
#[path = "support/unified_business.rs"]
mod unified_business;
#[path = "support/fragmented_funding.rs"]
mod fragmented_funding;

#[test]
fn amm_fragmented_native_funding_uses_shared_prerequisite_without_alternative_parent_reads() {
    fn replace(p: &mut Value, count: usize, amount: u64) {
        // The original fee parent may also prove a contract input.
        let originals=p["snapshot"]["payload"]["parents"].as_array().unwrap().clone();
        fragmented_funding::replace(p,count,amount);
        let parents=p["snapshot"]["payload"]["parents"].as_array_mut().unwrap();
        for parent in originals { if !parents.iter().any(|v|v["txid"]==parent["txid"]) { parents.push(parent); } }
    }
    for action in ["buy", "sell", "add", "remove"] {
        let original = business_input("public-plain", action).0;
        let ceiling=original["snapshot"]["payload"]["utxos"].as_array().unwrap().iter()
            .find(|u|u["classification"]=="native").unwrap()["satoshis"].as_str().unwrap().parse::<u64>().unwrap();
        let (mut low, mut high) = (0u64, ceiling);
        while low + 1 < high {
            let mid = (low + high) / 2;
            let mut p = original.clone();
            replace(&mut p, 1, mid);
            if call(EngineMethod::Plan, &bind(p))["ok"] == true { high = mid; } else { low = mid; }
        }
        assert!(high > 1 && high < ceiling, "{action}: {high}");
        let mut p = original;
        replace(&mut p, 3, high - 1);
        // Chain Data proves only the preferred largest-first candidate's parent.
        // Other native descriptors come from the trusted fresh address index.
        let mut ids = p["snapshot"]["payload"]["utxos"].as_array().unwrap().iter()
            .filter(|u| u["classification"] == "native").map(|u| u["txid"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        ids.sort();
        p["snapshot"]["payload"]["parents"].as_array_mut().unwrap().retain(|v|
            !ids[1..].iter().any(|id| v["txid"] == *id));
        let p = bind(p);
        let plan = ok(EngineMethod::Plan, &p);
        assert_eq!(plan["plan"]["payload"]["transactions"][0]["id"], "native-funding-1");
        let mut signed = approved(&p, &plan);
        let result = loop {
            let result = ok(EngineMethod::Finalize, &signed);
            if result["status"] != "pending" { break result; }
            signed["continuation"] = result["continuation"].clone();
            signed["signatures"] = signatures(&result["signingRequests"]);
        };
        let transactions = result["bundle"]["transactions"].as_array().unwrap();
        let funding = Transaction::from_hex(transactions[0]["rawTransaction"].as_str().unwrap()).unwrap();
        assert!(transactions[1..].iter().any(|tx| Transaction::from_hex(tx["rawTransaction"].as_str().unwrap())
            .unwrap().inputs.iter().any(|i| i.previous_output.txid == funding.txid())));
        signed["phase"] = json!("pre-broadcast");
        signed["bundle"] = result["bundle"].clone();
        assert_eq!(ok(EngineMethod::Validate, &signed)["valid"], true, "{action}");
    }
}
#[test]
fn unified_pool_business_preserves_current_transactions() {
    for label in ["public-plain", "public-locked", "controller-plain", "controller-locked"] {
        for action in ["buy", "sell", "add", "remove"] {
            let input = business_input(label, action).0;
            unified_business::exercise_pool(if label.starts_with("controller-") {bind_controller(input)} else {input});
        }
    }
}
fn fixture()->Value{serde_json::from_str(include_str!("../../../fixtures/amm-explicit173-lifecycle.json")).unwrap()}
fn oracle()->Value{serde_json::from_str(include_str!("../../../fixtures/amm-pool-proof.json")).unwrap()}
fn hex(b:&[u8])->String{b.iter().map(|b|format!("{b:02x}")).collect()}
fn bytes(s:&str)->Vec<u8>{(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
fn hash(v:&Value)->String{hex(&Sha256::digest(serde_json::to_vec(v).unwrap()))}
fn call(method:EngineMethod,v:&Value)->Value{serde_json::from_str(&call_json(method,&v.to_string())).unwrap()}
fn ok(method:EngineMethod,v:&Value)->Value{
    let r=call(method,v);assert_eq!(r["ok"],true,"{r}");
    if std::env::var("AMM_DUMP_WIRE").as_deref()==Ok("1"){
        let(a,b)=match method{EngineMethod::NormalizeRequest=>("normalizeRequestParams","normalizeRequestResult"),EngineMethod::Plan=>("planParams","planResult"),EngineMethod::Validate=>("validateParams","validationResult"),EngineMethod::Finalize=>("finalizeParams","finalizeResult")};
        println!("AMM_WIRE:{}",json!({"definition":a,"value":v}));println!("AMM_WIRE:{}",json!({"definition":b,"value":r["result"]}));
    }r["result"].clone()
}
fn bind(mut p:Value)->Value{
    let n=ok(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":p["request"]}));p["request"]=n["request"].clone();p["requestHash"]=n["requestHash"].clone();
    p["snapshot"]["snapshotHash"]=json!(hash(&p["snapshot"]["payload"]));p["policy"]["policyHash"]=json!(hash(&p["policy"]["payload"]));p
}
fn input(v:&Value)->Value{
    let f=fixture();let id=v["ftGenesisId"].as_str().unwrap();let ft=Transaction::from_hex(f["raws"][id].as_str().unwrap()).unwrap();
    let source_id=ft.inputs[0].previous_output.txid.to_string();let point=v["fundingVout"].as_u64().unwrap()as usize;
    let pool=Transaction::from_hex(f["raws"][v["genesisId"].as_str().unwrap()].as_str().unwrap()).unwrap();
    let authorization=amm_profile::Code::decode(pool.outputs[0].script_pubkey.as_bytes()).unwrap().authorization;
    let mut policy=v["rates"].clone();policy["feeAddress"]=v["feeAddress"].clone();
    let mut p=base()["planInput"].clone();p["request"]["intent"]=json!({"type":"tbc-amm-create","version":"1.0","ftContractId":id,"feePolicy":policy,"lpTimelock":v["locked"],"serviceProviderTag":String::from_utf8(bytes(v["serviceProviderTag"].as_str().unwrap())).unwrap()});
    if let amm_code::Authorization::Controller(hashes)=authorization{p["request"]["intent"]["controllers"]=json!(hashes.iter().map(|h|hex(h)).collect::<Vec<_>>());}
    p["request"]["constraints"]["maxFee"]=json!("10000");
    p["snapshot"]["payload"]["utxos"]=json!([{"txid":id,"vout":point,"satoshis":ft.outputs[point].satoshis.to_string(),"scriptPubKey":hex(ft.outputs[point].script_pubkey.as_bytes()),"classification":"native","confirmations":"0"}]);
    p["snapshot"]["payload"]["parents"]=json!([{"txid":id,"rawTransaction":f["raws"][id]},{"txid":source_id,"rawTransaction":f["raws"][&source_id]}]);
    p["snapshot"]["payload"]["contracts"]=json!([{"contractId":id,"family":"ft","protocolVersion":"tbc20","standardId":"tbc20-standard","templateRevision":"0f5db33bb46e4517963cbd383518f74283b5c2c4efb0a733522a1fbc0d4a9f84","creationTxid":id,"genesisOutpoint":{"txid":id,"vout":0},"currentOutpoint":{"txid":id,"vout":0}}]);
    p["policy"]["payload"]["minConfirmations"]=json!("0");p["policy"]["payload"]["dustThreshold"]=json!("10");p["policy"]["payload"]["contractPolicies"]=json!([{"family":"pool","allowedVersions":["pool3"],"createVersion":"pool3"}]);bind(p)
}
fn signatures(tasks:&Value)->Value{
    // Fixed public scalar used exclusively for invented offline transactions.
    let secp=Secp256k1::new();
    json!(tasks.as_array().unwrap().iter().map(|t|{
        let mut scalar=[0;32];scalar[31]=if t["publicKey"]==controller_account("tbc:mainnet")["publicKey"]{2}else{1};
        let key=SecretKey::from_byte_array(scalar).unwrap();
        assert_eq!(t["publicKey"],hex(&secp256k1::PublicKey::from_secret_key(&secp,&key).serialize()));
        assert_eq!(t["signatureEncoding"],"compact64");let digest=bytes(t["digest"].as_str().unwrap()).try_into().unwrap();
        json!({"taskId":t["taskId"],"signatureEncoding":"compact64","signature":hex(&secp.sign_ecdsa(Message::from_digest(digest),&key).serialize_compact())})
    }).collect::<Vec<_>>())
}
fn controller_account(chain:&str)->Value{
    let public_key="02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
    let key=tbc_sdk::PublicKey::from_slice(&bytes(public_key)).unwrap();
    let address=tbc_sdk::Address::from_hash160(key.hash160()).to_string();
    json!({"chainId":chain,"address":address,"accountId":format!("{chain}:{address}"),"publicKey":public_key})
}
fn bind_controller(mut p:Value)->Value{
    let controller=controller_account(p["request"]["chainId"].as_str().unwrap());
    p["request"]["signingRoles"]=json!([{"role":"pool-controller","accountId":controller["accountId"]}]);
    p["snapshot"]["payload"]["signingAccounts"]=json!([controller]);bind(p)
}
#[test]
fn explicit_controller_amm_actions_and_continuation_match_sdk(){
    let f=oracle();
    for label in ["controller-plain","controller-locked"]{for action in ["add","buy","sell","remove"]{
        let(p,v)=business_input(label,action);let p=bind_controller(p);let plan=ok(EngineMethod::Plan,&p);
        let payload=&plan["plan"]["payload"];
        assert_eq!(payload["preview"]["signingRoles"],json!([{"role":"pool-controller","account":controller_account("tbc:mainnet")} ]));
        let tasks=payload["signingTasks"].as_array().unwrap();
        assert_eq!(tasks.iter().filter(|t|t["accountId"]==controller_account("tbc:mainnet")["accountId"]).count(),1);
        for t in tasks { assert_eq!(t["accountId"],if t["inputIndex"]==0 {controller_account("tbc:mainnet")["accountId"].clone()}else{p["snapshot"]["payload"]["account"]["accountId"].clone()}); }
        let signed=approved(&p,&plan);let mut check=signed.clone();check["phase"]=json!("pre-sign");check.as_object_mut().unwrap().remove("signatures");assert_eq!(ok(EngineMethod::Validate,&check)["valid"],true);
        let result=ok(EngineMethod::Finalize,&signed);check=signed.clone();check["phase"]=json!("pre-broadcast");check["bundle"]=result["bundle"].clone();assert_eq!(ok(EngineMethod::Validate,&check)["valid"],true);
        assert_eq!(result["bundle"]["transactions"][0]["rawTransaction"],f["raws"][v["signedTxid"].as_str().unwrap()],"{label}-{action}");
        let mut wrong=signed.clone();wrong["signatures"][0]["signature"]=wrong["signatures"][1]["signature"].clone();assert_eq!(call(EngineMethod::Finalize,&wrong)["ok"],false);
        let mut wrong=signed;wrong["snapshot"]["payload"]["signingAccounts"][0]["publicKey"]=p["snapshot"]["payload"]["account"]["publicKey"].clone();
        wrong["snapshot"]["snapshotHash"]=json!(hash(&wrong["snapshot"]["payload"]));assert_eq!(call(EngineMethod::Finalize,&wrong)["ok"],false);
    }}
    // The independent controller is needed only after holder maintenance.
    // Its role must be bound before the fee-only/holder-only first stage.
    let p=bind_controller(fragmented_business_input("controller-plain","sell",6));
    let plan=ok(EngineMethod::Plan,&p);let primary=p["snapshot"]["payload"]["account"]["accountId"].clone();
    assert!(plan["plan"]["payload"]["signingTasks"].as_array().unwrap().iter().all(|t|t["accountId"]==primary));
    let mut signed=approved(&p,&plan);let mut stages=0;let mut controllers=0;
    let result=loop{
        let result=ok(EngineMethod::Finalize,&signed);stages+=1;
        if result["status"]!="pending"{break result;}
        controllers+=result["signingRequests"].as_array().unwrap().iter().filter(|t|t["accountId"]==controller_account("tbc:mainnet")["accountId"]).count();
        signed["continuation"]=result["continuation"].clone();signed["signatures"]=signatures(&result["signingRequests"]);
        let mut wrong=signed.clone();wrong["request"].as_object_mut().unwrap().remove("signingRoles");assert_eq!(call(EngineMethod::Finalize,&wrong)["ok"],false);
    };
    assert_eq!(stages,3);assert_eq!(controllers,1);assert_eq!(result["bundle"]["transactions"].as_array().unwrap().len(),3);
    let mut check=signed;check["phase"]=json!("pre-broadcast");check["bundle"]=result["bundle"].clone();assert_eq!(ok(EngineMethod::Validate,&check)["valid"],true);
}
#[test]
fn explicit_controller_roles_reject_unbound_duplicate_foreign_and_unneeded_accounts(){
    let(p,_)=business_input("controller-plain","buy");let good=bind_controller(p);
    for case in 0..8 {let mut p=good.clone();match case{
        0=>{p["snapshot"]["payload"].as_object_mut().unwrap().remove("signingAccounts");},
        1=>p["snapshot"]["payload"]["signingAccounts"]=json!([]),
        2=>p["snapshot"]["payload"]["signingAccounts"]=json!([controller_account("tbc:mainnet"),controller_account("tbc:mainnet")]),
        3=>p["snapshot"]["payload"]["signingAccounts"][0]["chainId"]=json!("tbc:testnet"),
        4=>p["snapshot"]["payload"]["signingAccounts"][0]["address"]=p["request"]["from"].clone(),
        5=>p["snapshot"]["payload"]["signingAccounts"][0]["publicKey"]=p["snapshot"]["payload"]["account"]["publicKey"].clone(),
        6=>{p["request"].as_object_mut().unwrap().remove("signingRoles");},
        _=>p["snapshot"]["payload"]["account"]["accountId"]=controller_account("tbc:mainnet")["accountId"].clone(),
    }p=bind(p);assert_eq!(call(EngineMethod::Plan,&p)["ok"],false,"case {case}");}
    for roles in [json!([]),json!([{"role":"pool-controller","accountId":controller_account("tbc:testnet")["accountId"]}]),
        json!([{"role":"fee-payer","accountId":controller_account("tbc:mainnet")["accountId"]}]),
        json!([good["request"]["signingRoles"][0].clone(),good["request"]["signingRoles"][0].clone()])] {
        let mut request=good["request"].clone();request["signingRoles"]=roles;assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":request}))["ok"],false);
    }
    let(public,_)=business_input("public-plain","buy");let public=bind_controller(public);assert_eq!(call(EngineMethod::Plan,&public)["ok"],false);
    let mut unrelated=base()["planInput"]["request"].clone();unrelated["signingRoles"]=good["request"]["signingRoles"].clone();assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":unrelated}))["ok"],false);
}
fn approved(p:&Value,plan:&Value)->Value{
    let mut b=base()["finalizeInput"]["binding"].clone();b["payload"]["requestHash"]=p["requestHash"].clone();b["payload"]["operationHash"]=plan["plan"]["planHash"].clone();b["payload"]["expiresAt"]=plan["plan"]["payload"]["expiresAt"].clone();b["bindingHash"]=json!(hash(&b["payload"]));
    let mut a=base()["finalizeInput"]["approval"].clone();a["bindingHash"]=b["bindingHash"].clone();a["expiresAt"]=b["payload"]["expiresAt"].clone();
    let mut r=p.clone();r["plan"]=plan["plan"].clone();r["binding"]=b;r["approval"]=a;r["signatures"]=signatures(&plan["plan"]["payload"]["signingTasks"]);r
}
fn business_input(label:&str,operation:&str)->(Value,Value){
    business_input_fixture(&oracle(),label,operation)
}

#[test]
fn trusted_indexed_amm_keeps_direct_proofs_and_identical_signed_transactions() {
    use std::collections::BTreeSet;
    use tbc_engine_core::protocols::{amm_lp_proof, amm_material, tbc20_material};
    for label in ["public-plain", "public-locked"] {
        for action in ["buy", "sell", "add", "remove"] {
            let (mut p, _) = business_input(label, action);
            let baseline = ok(EngineMethod::Plan, &p);
            let original = ok(EngineMethod::Finalize, &approved(&p, &baseline));
            let parents = p["snapshot"]["payload"]["parents"].as_array().unwrap().clone();
            let tx = |id: &str| Transaction::from_hex(parents.iter().find(|r| r["txid"] == id).unwrap()["rawTransaction"].as_str().unwrap()).unwrap();
            let current_id = p["snapshot"]["payload"]["contracts"][0]["currentOutpoint"]["txid"].as_str().unwrap().to_owned();
            let current = tx(&current_id);
            let ft_id = hex(&amm_material::inspect_pool(&current).unwrap().tape.ft_a_contract_id);
            let ft = tx(&ft_id);
            p["snapshot"]["payload"]["contracts"][0]["indexedPool"] = json!({
                "ftCodeScript":hex(ft.outputs[0].script_pubkey.as_bytes()),
                "ftTapeScript":hex(ft.outputs[1].script_pubkey.as_bytes())
            });
            let mut keep = BTreeSet::from([current_id, current.inputs[0].previous_output.txid.to_string()]);
            for u in p["snapshot"]["payload"]["utxos"].as_array().unwrap() {
                let id=u["txid"].as_str().unwrap(); keep.insert(id.to_owned());
                let parent=tx(id); let point=tbc_sdk::OutPoint{txid:id.parse().unwrap(),vout:u["vout"].as_u64().unwrap() as u32};
                match u["classification"].as_str().unwrap() {
                    "ft"|"pool-ft" => {for d in tbc20_material::inspect_parent(&parent.serialize(),&point,None).unwrap().dependencies(){keep.insert(d.outpoint.txid.to_string());}},
                    "ftlp" => {for d in amm_lp_proof::inspect_parent(&parent.serialize(),&point,None).unwrap().dependencies(){keep.insert(d.txid.to_string());}},
                    _=>{}
                }
            }
            p["snapshot"]["payload"]["parents"].as_array_mut().unwrap().retain(|r|keep.contains(r["txid"].as_str().unwrap()));
            if label=="public-plain" {p["snapshot"]["payload"].as_object_mut().unwrap().remove("block");}
            let p=bind(p); let planned=ok(EngineMethod::Plan,&p);
            for field in ["transactions","signingTasks"] {assert_eq!(planned["plan"]["payload"][field],baseline["plan"]["payload"][field]);}
            let result=ok(EngineMethod::Finalize,&approved(&p,&planned));
            assert_eq!(result["bundle"]["transactions"],original["bundle"]["transactions"]);
            for field in ["ftCodeScript","ftTapeScript"] {
                let mut bad=p.clone();bad["snapshot"]["payload"]["contracts"][0]["indexedPool"][field]=json!("51");
                let bad=bind(bad);assert_eq!(call(EngineMethod::Plan,&bad)["ok"],false);
            }
            let mut bad=p.clone();bad["snapshot"]["payload"]["parents"].as_array_mut().unwrap().retain(|r|r["txid"]!=p["snapshot"]["payload"]["contracts"][0]["currentOutpoint"]["txid"]);
            assert_eq!(call(EngineMethod::Plan,&bind(bad))["ok"],false);
        }
    }
}
fn business_input_fixture(f:&Value,label:&str,operation:&str)->(Value,Value){
    use std::collections::BTreeSet;
    use tbc_engine_core::protocols::{amm_lp_proof,tbc20_material};
    let row=|op:&str|f["vectors"].as_array().unwrap().iter().find(|v|v["id"]==format!("{label}-{op}")).unwrap();
    let v=row(operation);let current=Transaction::from_hex(v["currentRaw"].as_str().unwrap()).unwrap();let id=row("add")["parentTxid"].as_str().unwrap();
    let genesis=Transaction::from_hex(f["raws"][id].as_str().unwrap()).unwrap();
    let inspected=tbc_engine_core::protocols::amm_material::inspect_pool(&genesis).unwrap();
    let ftid=hex(&inspected.tape.ft_a_contract_id);
    let mut ids=BTreeSet::from([id.to_owned(),ftid.clone(),v["parentTxid"].as_str().unwrap().into(),v["ancestorTxid"].as_str().unwrap().into()]);
    ids.insert(genesis.inputs[0].previous_output.txid.to_string());
    let mut p=base()["planInput"].clone();let mut intent=match operation{
        "add"=>json!({"type":"tbc-amm-add-liquidity","version":"1.0","poolContractId":id,"budgetAsset":"tbc","amount":"100000","initialFtAmount":"200000","minimumLpAmount":"0"}),
        "buy"=>json!({"type":"tbc-amm-swap","version":"1.0","poolContractId":id,"direction":"tbc-to-ft","amount":"10000","minimumOutput":"0"}),
        "sell"=>json!({"type":"tbc-amm-swap","version":"1.0","poolContractId":id,"direction":"ft-to-tbc","amount":"1000","minimumOutput":"0"}),
        _=>json!({"type":"tbc-amm-remove-liquidity","version":"1.0","poolContractId":id,"lpAmount":"10000","minimumFtAmount":"0","minimumTbcAmount":"0"}),
    };
    if operation=="add"&&label.ends_with("locked"){intent["lockTime"]=json!("829999");}
    p["request"]["intent"]=intent;p["request"]["constraints"]["maxFee"]=json!("10000");p["snapshot"]["payload"]["block"]["height"]=json!("830000");
    p["snapshot"]["payload"]["utxos"]=json!(current.inputs.iter().enumerate().map(|(vin,i)|{
        let parentid=i.previous_output.txid.to_string();ids.insert(parentid.clone());let tx=Transaction::from_hex(f["raws"][&parentid].as_str().unwrap()).unwrap();let out=&tx.outputs[i.previous_output.vout as usize];
        let class=if vin==0{"pool"}else if vin==2{"pool-ft"}else if (operation=="buy"&&vin==1)||(operation!="buy"&&vin==3){"native"}else if operation=="remove"{"ftlp"}else{"ft"};
        if matches!(class,"pool-ft"|"ft"|"ftlp"){
            if class=="ftlp"{for d in amm_lp_proof::inspect_parent(&tx.serialize(),&i.previous_output,None).unwrap().dependencies(){ids.insert(d.txid.to_string());}}
            else{for d in tbc20_material::inspect_parent(&tx.serialize(),&i.previous_output,None).unwrap().dependencies(){ids.insert(d.outpoint.txid.to_string());}}
        }
        let mut u=json!({"txid":parentid,"vout":i.previous_output.vout,"satoshis":out.satoshis.to_string(),"scriptPubKey":hex(out.script_pubkey.as_bytes()),"classification":class,"confirmations":"0"});
        if class!="native"{u["contractId"]=json!(if class=="ft"{&ftid}else{id});}u
    }).collect::<Vec<_>>());
    p["snapshot"]["payload"]["parents"]=json!(ids.iter().map(|id|json!({"txid":id,"rawTransaction":f["raws"][id]})).collect::<Vec<_>>());
    p["snapshot"]["payload"]["contracts"]=json!([{"contractId":id,"family":"pool","protocolVersion":"pool3","standardId":"tbc-amm","templateRevision":inspected.template_revision,"creationTxid":id,"genesisOutpoint":{"txid":id,"vout":0},"currentOutpoint":{"txid":v["parentTxid"],"vout":0}}]);
    p["policy"]["payload"]["dustThreshold"]=json!("10");p["policy"]["payload"]["minConfirmations"]=json!("0");p["policy"]["payload"]["contractPolicies"]=json!([{"family":"pool","allowedVersions":["pool3"]}]);(bind(p),v.clone())
}
#[test]
fn explicit173_public_business_lifecycle_matches_sdk_and_binding(){
    let f=fixture();
    let mut vectors=vec![];
    for row in f["cases"].as_array().unwrap(){
        for action in row["actions"].as_array().unwrap(){
            let txid=action["txid"].as_str().unwrap();let tx=Transaction::from_hex(f["raws"][txid].as_str().unwrap()).unwrap();
            let parent_id=tx.inputs[0].previous_output.txid.to_string();let parent=Transaction::from_hex(f["raws"][&parent_id].as_str().unwrap()).unwrap();
            vectors.push(json!({"id":format!("{}-{}",row["label"].as_str().unwrap(),action["operation"].as_str().unwrap()),
                "currentRaw":f["raws"][txid],"signedTxid":txid,"parentTxid":parent_id,"ancestorTxid":parent.inputs[0].previous_output.txid.to_string()}));
        }
    }
    let adapted=json!({"raws":f["raws"],"vectors":vectors});
    for row in f["cases"].as_array().unwrap(){for action in ["add","buy","sell","remove"]{
        let label=row["label"].as_str().unwrap();let(p,v)=business_input_fixture(&adapted,label,action);
        let p=if row["controlled"]==true{bind_controller(p)}else{p};
        let plan=ok(EngineMethod::Plan,&p);let signed=approved(&p,&plan);
        let mut check=signed.clone();check["phase"]=json!("pre-sign");check.as_object_mut().unwrap().remove("signatures");
        assert_eq!(ok(EngineMethod::Validate,&check)["valid"],true);
        let result=ok(EngineMethod::Finalize,&signed);check=signed;check["phase"]=json!("pre-broadcast");check["bundle"]=result["bundle"].clone();
        assert_eq!(ok(EngineMethod::Validate,&check)["valid"],true);
        let tx=&result["bundle"]["transactions"][0];assert_eq!(tx["txid"],v["signedTxid"],"{label}-{action}");
        assert_eq!(tx["rawTransaction"],f["raws"][v["signedTxid"].as_str().unwrap()],"{label}-{action}");
    }}
}
#[test]
fn eight_public_amm_actions_match_sdk_raw_with_shared_account_and_binding(){
    let f=oracle();
    for label in ["public-plain","public-locked"]{for action in ["add","buy","sell","remove"]{
        let(p,v)=business_input(label,action);let plan=ok(EngineMethod::Plan,&p);let signed=approved(&p,&plan);let mut check=signed.clone();check["phase"]=json!("pre-sign");check.as_object_mut().unwrap().remove("signatures");assert_eq!(ok(EngineMethod::Validate,&check)["valid"],true);
        let result=ok(EngineMethod::Finalize,&signed);check=signed;check["phase"]=json!("pre-broadcast");check["bundle"]=result["bundle"].clone();assert_eq!(ok(EngineMethod::Validate,&check)["valid"],true);
        let tx=&result["bundle"]["transactions"][0];assert_eq!(tx["txid"],v["signedTxid"],"{label}-{action}");assert_eq!(tx["rawTransaction"],f["raws"][v["signedTxid"].as_str().unwrap()],"{label}-{action}");
    }}
}
#[test]
fn public_amm_business_binds_state_slippage_exact_inputs_locks_and_controller(){
    for action in ["add","buy","sell","remove"]{
        let(p,_)=business_input("public-locked",action);
        for case in 0..6{let mut bad=p.clone();match case{
            0=>bad["request"]["intent"]["poolStateHash"]=json!("00".repeat(32)),
            1=>bad["snapshot"]["payload"]["contracts"][0]["currentOutpoint"]["txid"]=json!("00".repeat(32)),
            2=>bad["snapshot"]["payload"]["utxos"][2]["satoshis"]=json!("501"),
            3=>bad["request"]["constraints"]["maxFee"]=json!("1"),
            4=>bad["request"]["intent"][if action=="add"{"minimumLpAmount"}else if action=="remove"{"minimumFtAmount"}else{"minimumOutput"}]=json!("90000000"),
            _=>bad["request"]["constraints"]["inputOutpoints"]=json!([{"txid":p["snapshot"]["payload"]["utxos"][0]["txid"],"vout":0}]),
        }bad=bind(bad);assert_eq!(call(EngineMethod::Plan,&bad)["ok"],false,"{action} {case}");}
        let(controller,_)=business_input("controller-plain",action);let verdict=call(EngineMethod::Plan,&controller);assert_eq!(verdict["ok"],false);assert!(verdict["error"]["message"].as_str().unwrap().contains("controller"));
    }
    let(mut p,_)=business_input("public-locked","remove");p["snapshot"]["payload"]["block"]["height"]=json!("829998");p=bind(p);assert_eq!(call(EngineMethod::Plan,&p)["ok"],false);
    // Burn is only 10,000 but the selected holder balance/change is larger.
    // Checking the requested trade alone must not bypass the bound asset cap.
    for scope in ["lp-total","lp-slot"]{
        let(mut p,_)=business_input("public-plain","remove");let id=p["request"]["intent"]["poolContractId"].clone();
        p["policy"]["payload"]["amountLimits"]=json!([{"scope":scope,"contractId":id,"protocolVersion":"pool3","maximum":"50000"}]);
        p=bind(p);let rejected=call(EngineMethod::Plan,&p);assert_eq!(rejected["ok"],false);assert!(rejected["error"]["message"].as_str().unwrap().contains("policy"));
    }
}
#[test]
fn eight_explicit_public_amm_creates_bind_funded_continuation_and_match_sdk(){
    let f=fixture();
    for v in f["cases"].as_array().unwrap(){
        let p=input(v);let plan=ok(EngineMethod::Plan,&p);assert_eq!(plan["plan"]["payload"]["preview"]["signingTaskCount"],2);
        assert_eq!(plan["plan"]["payload"]["transactions"][0]["role"],"prerequisite");
        let mut signed=approved(&p,&plan);let mut check=signed.clone();check["phase"]=json!("pre-sign");check.as_object_mut().unwrap().remove("signatures");assert_eq!(ok(EngineMethod::Validate,&check)["valid"],true);
        let pending=ok(EngineMethod::Finalize,&signed);assert_eq!(pending["status"],"pending");assert_eq!(pending["continuation"]["family"],"pool");
        signed["continuation"]=pending["continuation"].clone();signed["signatures"]=signatures(&pending["signingRequests"]);
        let result=ok(EngineMethod::Finalize,&signed);check=signed.clone();check["phase"]=json!("pre-broadcast");check["bundle"]=result["bundle"].clone();assert_eq!(ok(EngineMethod::Validate,&check)["valid"],true);
        let txs=result["bundle"]["transactions"].as_array().unwrap();assert_eq!(txs.len(),2);assert_eq!(txs[0]["rawTransaction"],f["raws"][v["sourceId"].as_str().unwrap()]);
        let genesis=Transaction::from_hex(txs[1]["rawTransaction"].as_str().unwrap()).unwrap();assert_eq!(txs[1]["txid"],v["genesisId"]);assert_eq!(txs[1]["rawTransaction"],f["raws"][v["genesisId"].as_str().unwrap()]);
        let ft=Transaction::from_hex(p["snapshot"]["payload"]["parents"][0]["rawTransaction"].as_str().unwrap()).unwrap();
        let code=amm_profile::Code::decode(genesis.outputs[0].script_pubkey.as_bytes()).unwrap();
        let tape=amm_profile::Tape::decode(genesis.outputs[1].script_pubkey.as_bytes()).unwrap();
        let profile=amm_profile::Profile::from_parts(&code,&tape).unwrap();
        let config=PoolConfig::with_profile(&ft,&ft.txid(),code.authorization,v["locked"].as_bool().unwrap(),profile).unwrap();
        assert_eq!(config.read_pool(&genesis,&tbc_hash::sha256(genesis.outputs[0].script_pubkey.as_bytes())).unwrap().math().ft_lp_amount,0);
    }
}
#[test]
fn public_amm_native_descriptor_needs_no_extra_raw_and_exact_scope_is_preserved(){
    let mut p=input(&fixture()["cases"][0]);let native=base()["planInput"]["snapshot"]["payload"]["utxos"][0].clone();
    p["snapshot"]["payload"]["utxos"]=json!([native.clone()]);p["request"]["constraints"]["inputOutpoints"]=json!([{"txid":native["txid"],"vout":native["vout"]}]);p=bind(p);
    let plan=ok(EngineMethod::Plan,&p);let mut signed=approved(&p,&plan);let pending=ok(EngineMethod::Finalize,&signed);
    signed["signatures"]=signatures(&pending["signingRequests"]);signed["continuation"]=pending["continuation"].clone();let done=ok(EngineMethod::Finalize,&signed);assert_eq!(done["bundle"]["transactions"].as_array().unwrap().len(),2);
    assert!(!p["snapshot"]["payload"]["parents"].as_array().unwrap().iter().any(|r|r["txid"]==native["txid"]));
    let mut bad=p.clone();bad["request"]["constraints"]["inputOutpoints"].as_array_mut().unwrap().push(json!({"txid":"ff".repeat(32),"vout":0}));bad=bind(bad);assert_eq!(call(EngineMethod::Plan,&bad)["ok"],false);
    let mut testnet=p;testnet["request"]["chainId"]=json!("tbc:testnet");testnet["snapshot"]["payload"]["chainId"]=json!("tbc:testnet");testnet["snapshot"]["payload"]["account"]["chainId"]=json!("tbc:testnet");
    testnet["snapshot"]["payload"]["account"]["accountId"]=json!(format!("tbc:testnet:{}",testnet["request"]["from"].as_str().unwrap()));testnet["policy"]["payload"]["chainId"]=json!("tbc:testnet");testnet=bind(testnet);ok(EngineMethod::Plan,&testnet);
}
#[test]
fn public_amm_create_rejects_cross_fields_malformed_authority_and_unbound_material(){
    let p=input(&fixture()["cases"][0]);
    for(field,value)in [("controllers",json!([])),("controllers",json!(["ff".repeat(20),"00".repeat(20)])),("controllers",json!(["11".repeat(20),"11".repeat(20)])),("controllers",json!(["00"])),("lpPlan",json!(7)),("lpTimelock",json!("false")),("amount",json!("1")),("serviceFeeRate",json!(65535))]{
        let mut bad=p["request"].clone();bad["intent"][field]=value;assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":bad}))["ok"],false,"{field}");
    }
    for(field,value)in [("lpFeeRate",json!(-1)),("taxFeeRate",json!(0.5)),("protocolFeeRate",json!(10000)),("serviceProviderFeeRate",json!(9900)),("feeAddress",json!("not-an-address")),("unknown",json!(1))]{
        let mut bad=p["request"].clone();bad["intent"]["feePolicy"][field]=value;
        assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":bad}))["ok"],false,"{field}");
    }
    let mut missing=p["request"].clone();missing["intent"].as_object_mut().unwrap().remove("feePolicy");
    assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":missing}))["ok"],false);
    for rates in [[0,0,0,0],[9999,0,0,0],[0,9999,0,0]]{
        let mut valid=p["request"].clone();valid["intent"]["feePolicy"]=json!({"lpFeeRate":rates[0],"taxFeeRate":rates[1],"serviceProviderFeeRate":rates[2],"protocolFeeRate":rates[3],"feeAddress":p["request"]["intent"]["feePolicy"]["feeAddress"]});
        valid["intent"].as_object_mut().unwrap().remove("serviceProviderTag");
        ok(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":valid}));
    }
    for case in 0..6{let mut bad=p.clone();match case{
        0=>bad["snapshot"]["payload"]["contracts"][0]["templateRevision"]=json!("00".repeat(32)),
        1=>bad["snapshot"]["payload"]["parents"].as_array_mut().unwrap().truncate(1),
        2=>bad["request"]["constraints"]["maxFee"]=json!("1"),
        3=>bad["policy"]["payload"]["contractPolicies"][0]["createVersion"]=json!("4.0"),
        4=>bad["snapshot"]["payload"]["utxos"][0]["satoshis"]=json!("10000"),
        _=>bad["policy"]["payload"]["maxBundleTransactions"]=json!(1),
    }bad=bind(bad);assert_eq!(call(EngineMethod::Plan,&bad)["ok"],false,"case{case}");}
    let mut old=base()["planInput"]["request"].clone();old["intent"]["lpTimelock"]=json!(false);assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":old}))["ok"],false);
}

fn fragmented_business_input(label:&str,operation:&str,count:usize)->Value{
    use std::collections::{BTreeMap,BTreeSet};
    use tbc_sdk::{PublicKey,OutPoint,script::Script};
    use tbc_engine_core::{protocols::{tbc20_material,tbc20_transfer as ft,amm_lp_proof,amm_lp_transfer as lp},signing::*};
    let(mut p,_)=business_input(label,operation);let f=oracle();
    let mut known:BTreeMap<_,_>=f["raws"].as_object().unwrap().iter().map(|(id,raw)|(id.clone(),Transaction::from_hex(raw.as_str().unwrap()).unwrap())).collect();
    let key=PublicKey::from_slice(&bytes(p["snapshot"]["payload"]["account"]["publicKey"].as_str().unwrap())).unwrap();let mut owner=[0;21];owner[..20].copy_from_slice(&key.hash160());
    let mut scalar=[0;32];scalar[31]=1;let secret=SecretKey::from_byte_array(scalar).unwrap();let secp=Secp256k1::new();
    let lp=operation=="remove";let old=p["snapshot"]["payload"]["utxos"].as_array().unwrap();
    let user=old.iter().find(|u|u["classification"]==if lp{"ftlp"}else{"ft"}).unwrap();let native=old.iter().find(|u|u["classification"]=="native").unwrap();
    let mut selected=OutPoint{txid:user["txid"].as_str().unwrap().parse().unwrap(),vout:user["vout"].as_u64().unwrap()as u32};
    let mut fee_point=OutPoint{txid:native["txid"].as_str().unwrap().parse().unwrap(),vout:native["vout"].as_u64().unwrap()as u32};
    let needed=match operation{"add"=>200000,"sell"=>1000,_=>10000};let amount=needed/count as u64+1;let mut points=vec![];
    for _ in 0..count{
        let parent=&known[&selected.txid.to_string()];let fee=ft::FeeInput{outpoint:fee_point.clone(),output:&known[&fee_point.txid.to_string()].outputs[fee_point.vout as usize],public_key:&key};
        let plan=if lp{
            let parent=amm_lp_proof::inspect_parent(&parent.serialize(),&selected,None).unwrap();let ids:BTreeSet<_>=parent.dependencies().iter().map(|p|p.txid.to_string()).collect();let raws:Vec<_>=ids.iter().map(|id|known[id].serialize()).collect();let refs:Vec<_>=raws.iter().map(Vec::as_slice).collect();
            lp::build_transfer_plan(lp::TransferOptions{inputs:&[lp::LpInput{parent:&parent,ancestor_raws:&refs,public_key:&key}],fee_input:&fee,expected_identity:parent.identity(),receiver_controller:owner,amount,lp_change_controller:Some(owner),native_change_hash:key.hash160(),lock_time:None,output_lock_time:None,fee_policy:lp::MinerFeePolicy::default(),max_fee:10000}).unwrap().unsigned_plan
        }else{
            let parent=tbc20_material::inspect_parent(&parent.serialize(),&selected,None).unwrap();let ids:BTreeSet<_>=parent.dependencies().iter().map(|d|d.outpoint.txid.to_string()).collect();let raws:Vec<_>=ids.iter().map(|id|known[id].serialize()).collect();let refs:Vec<_>=raws.iter().map(Vec::as_slice).collect();let linked=tbc20_material::link_ancestors(&parent,&refs).unwrap();
            ft::build_transfer_plan(ft::TransferOptions{inputs:&[ft::TokenInput{parent:&parent,ancestors:&linked,public_key:&key}],fee_inputs:&[fee],receivers:&[ft::Receiver{controller:owner,amount:amount as u128}],expected_identity:parent.identity(),token_change_controller:owner,native_change_hash:key.hash160(),max_fee:10000}).unwrap().unsigned_plan
        };
        let stage=begin_signing(&plan).unwrap();let sigs:Vec<_>=stage.signing_requests.iter().map(|r|ExternalSignature{session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),transaction_id:r.transaction_id.clone(),input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),signature:hex(&secp.sign_ecdsa(Message::from_digest(bytes(&r.digest).try_into().unwrap()),&secret).serialize_der())}).collect();
        let StageOutcome::Complete(bundle)=finalize_signing_stage(&plan,stage,&sigs).unwrap()else{panic!("one split")};let tx=Transaction::from_hex(&bundle.transactions[0].raw_transaction).unwrap();
        points.push(OutPoint{txid:tx.txid(),vout:0});selected=OutPoint{txid:tx.txid(),vout:2};
        fee_point=OutPoint{txid:tx.txid(),vout:tx.outputs.iter().position(|o|o.script_pubkey==Script::p2pkh(&key.hash160())).unwrap()as u32};known.insert(tx.txid().to_string(),tx);
    }
    let contract=user["contractId"].clone();let mut utxos:Vec<_>=old.iter().filter(|u|matches!(u["classification"].as_str(),Some("pool"|"pool-ft"))).cloned().collect();
    for point in &points{let out=&known[&point.txid.to_string()].outputs[point.vout as usize];utxos.push(json!({"txid":point.txid.to_string(),"vout":point.vout,"satoshis":"500","scriptPubKey":hex(out.script_pubkey.as_bytes()),"classification":if lp{"ftlp"}else{"ft"},"contractId":contract,"confirmations":"0"}));}
    let out=&known[&fee_point.txid.to_string()].outputs[fee_point.vout as usize];utxos.push(json!({"txid":fee_point.txid.to_string(),"vout":fee_point.vout,"satoshis":out.satoshis.to_string(),"scriptPubKey":hex(out.script_pubkey.as_bytes()),"classification":"native","confirmations":"0"}));
    let poolid=p["request"]["intent"]["poolContractId"].as_str().unwrap();let mut ids=BTreeSet::from([poolid.to_owned(),known[poolid].inputs[0].previous_output.txid.to_string()]);
    for u in &utxos{
        let id=u["txid"].as_str().unwrap();ids.insert(id.into());let tx=&known[id];let point=OutPoint{txid:tx.txid(),vout:u["vout"].as_u64().unwrap()as u32};
        match u["classification"].as_str().unwrap(){
            "pool"=>{ids.insert(tx.inputs[0].previous_output.txid.to_string());},
            "ftlp"=>{for d in amm_lp_proof::inspect_parent(&tx.serialize(),&point,None).unwrap().dependencies(){ids.insert(d.txid.to_string());}},
            "ft"|"pool-ft"=>{for d in tbc20_material::inspect_parent(&tx.serialize(),&point,None).unwrap().dependencies(){ids.insert(d.outpoint.txid.to_string());}},_=>{}
        }
    }
    p["request"]["constraints"]["inputOutpoints"]=json!(utxos.iter().map(|u|json!({"txid":u["txid"],"vout":u["vout"]})).collect::<Vec<_>>());
    p["snapshot"]["payload"]["utxos"]=json!(utxos);p["snapshot"]["payload"]["parents"]=json!(ids.iter().map(|id|json!({"txid":id,"rawTransaction":known[id].to_hex()})).collect::<Vec<_>>());
    p["policy"]["payload"]["maxBundleTransactions"]=json!(32);bind(p)
}
#[test]
fn public_amm_fragmented_holders_share_bound_maintenance_and_business_signing(){
    for(label,op,count)in [("public-plain","add",2),("public-plain","sell",6),("public-locked","remove",6)]{
        let p=fragmented_business_input(label,op,count);let plan=ok(EngineMethod::Plan,&p);let mut signed=approved(&p,&plan);
        let mut automatic=p.clone();automatic["request"]["constraints"].as_object_mut().unwrap().remove("inputOutpoints");
        let automatic=call(EngineMethod::Plan,&bind(automatic));assert_eq!(automatic["ok"],true);
        assert_eq!(hash(&automatic["result"]["plan"]["payload"]["transactions"]),hash(&plan["plan"]["payload"]["transactions"]),"automatic insufficient-single selection must use the same bounded fragments");
        let mut check=signed.clone();check["phase"]=json!("pre-sign");check.as_object_mut().unwrap().remove("signatures");assert_eq!(ok(EngineMethod::Validate,&check)["valid"],true);
        let mut result=ok(EngineMethod::Finalize,&signed);let mut rounds=1;
        while result.get("continuation").is_some(){signed["continuation"]=result["continuation"].clone();signed["signatures"]=signatures(&result["signingRequests"]);result=ok(EngineMethod::Finalize,&signed);rounds+=1;assert!(rounds<=4);}
        assert_eq!(rounds,if count==2{2}else{3});check=signed.clone();check["phase"]=json!("pre-broadcast");check["bundle"]=result["bundle"].clone();let v=ok(EngineMethod::Validate,&check);assert_eq!(v["valid"],true,"{v}");
        let mut capped=p.clone();capped["policy"]["payload"]["maxBundleTransactions"]=json!(1);assert_eq!(call(EngineMethod::Plan,&bind(capped))["ok"],false);
        let total=plan["plan"]["payload"]["preview"]["totalFee"].as_str().unwrap().parse::<u64>().unwrap();let mut capped=p.clone();capped["request"]["constraints"]["maxFee"]=json!((total-1).to_string());assert_eq!(call(EngineMethod::Plan,&bind(capped))["ok"],false);
        let mut wrong=signed;wrong["approval"]["bindingHash"]=json!("00".repeat(32));assert_eq!(call(EngineMethod::Finalize,&wrong)["ok"],false);
    }
}
