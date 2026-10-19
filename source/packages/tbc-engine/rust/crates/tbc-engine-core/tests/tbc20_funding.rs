use secp256k1::{Message,Secp256k1,SecretKey};
use serde_json::{Value,json};
use sha2::{Digest,Sha256};
use tbc_engine_core::{EngineMethod,call_json};
use tbc_sdk::Transaction;

fn base()->Value {serde_json::from_str(include_str!("../../../fixtures/tbc-transfer.json")).unwrap()}
fn oracle()->Value {serde_json::from_str(include_str!("../../../fixtures/tbc20-standard-transfer.json")).unwrap()}
fn hex(bytes:&[u8])->String {bytes.iter().map(|b|format!("{b:02x}")).collect()}
fn bytes(s:&str)->Vec<u8> {(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
fn hash(v:&Value)->String {hex(&Sha256::digest(serde_json::to_vec(v).unwrap()))}
fn call(method:EngineMethod,v:&Value)->Value {serde_json::from_str(&call_json(method,&v.to_string())).unwrap()}
fn ok(method:EngineMethod,v:&Value)->Value {let result=call(method,v);assert_eq!(result["ok"],true,"{result}");result["result"].clone()}
fn bind(mut p:Value)->Value {
    let n=ok(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":p["request"]}));
    p["request"]=n["request"].clone();p["requestHash"]=n["requestHash"].clone();
    p["snapshot"]["snapshotHash"]=json!(hash(&p["snapshot"]["payload"]));
    p["policy"]["policyHash"]=json!(hash(&p["policy"]["payload"]));p
}
fn input(create:bool)->Value {
    let mut p=base()["planInput"].clone();
    p["policy"]["payload"]["dustThreshold"]=json!("42");
    p["policy"]["payload"]["minConfirmations"]=json!("1");
    p["request"]["constraints"]["maxFee"]=json!("5000");
    if create {
        p["request"]["intent"]=json!({"type":"tbc20-standard-create","version":"1.0","name":"Token","symbol":"TBCX","decimals":6,"initialSupply":"123456"});
    } else {
        let f=oracle();let stage=&f["stages"][1];let tx=Transaction::from_hex(stage["signedRaw"].as_str().unwrap()).unwrap();
        let contract=stage["txid"].as_str().unwrap();
        p["request"]["intent"]=json!({"type":"tbc20-standard-transfer","version":"1.0","contractId":contract,"amount":"40000","to":p["request"]["from"]});
        p["snapshot"]["payload"]["utxos"]=json!([
            {"txid":contract,"vout":0,"satoshis":"500","scriptPubKey":hex(tx.outputs[0].script_pubkey.as_bytes()),"confirmations":"1","classification":"ft","contractId":contract},
            {"txid":contract,"vout":2,"satoshis":tx.outputs[2].satoshis.to_string(),"scriptPubKey":hex(tx.outputs[2].script_pubkey.as_bytes()),"confirmations":"1","classification":"native"}]);
        p["snapshot"]["payload"]["parents"]=json!((0..2).map(|i|json!({"txid":f["stages"][i]["txid"],"rawTransaction":f["stages"][i]["signedRaw"]})).collect::<Vec<_>>());
        p["snapshot"]["payload"]["contracts"]=json!([{"contractId":contract,"family":"ft","protocolVersion":"tbc20","standardId":"tbc20-standard",
            "templateRevision":"0f5db33bb46e4517963cbd383518f74283b5c2c4efb0a733522a1fbc0d4a9f84","creationTxid":contract,
            "genesisOutpoint":{"txid":contract,"vout":0},"currentOutpoint":{"txid":contract,"vout":0}}]);
    }
    bind(p)
}
fn fragmented(mut p:Value,count:usize,amount:u64,explicit:bool)->Value {
    let mut native=p["snapshot"]["payload"]["utxos"].as_array().unwrap().iter().find(|u|u["classification"]=="native").unwrap().clone();
    p["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().retain(|u|u["classification"]!="native");
    for i in 0..count {
        // Fabricated public-only funding descriptors, never read from a wallet.
        native["txid"]=json!(format!("{:064x}",1000+i));native["vout"]=json!(0);
        native["satoshis"]=json!(amount.to_string());native["confirmations"]=json!("1");
        p["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().push(native.clone());
    }
    if explicit {p["request"]["constraints"]["inputOutpoints"]=json!(p["snapshot"]["payload"]["utxos"].as_array().unwrap().iter()
        .map(|u|json!({"txid":u["txid"],"vout":u["vout"]})).collect::<Vec<_>>());}
    bind(p)
}
fn sign(tasks:&Value)->Value {
    let mut scalar=[0;32];scalar[31]=1;let key=SecretKey::from_byte_array(scalar).unwrap();
    json!(tasks.as_array().unwrap().iter().map(|task|json!({"taskId":task["taskId"],"signatureEncoding":"compact64",
        "signature":hex(&Secp256k1::new().sign_ecdsa(Message::from_digest(bytes(task["digest"].as_str().unwrap()).try_into().unwrap()),&key).serialize_compact())})).collect::<Vec<_>>())
}
fn finalize(p:&Value,planned:&Value)->(Value,usize) {
    let mut b=base()["finalizeInput"]["binding"].clone();b["payload"]["requestHash"]=p["requestHash"].clone();
    b["payload"]["operationHash"]=planned["plan"]["planHash"].clone();b["payload"]["expiresAt"]=planned["plan"]["payload"]["expiresAt"].clone();
    b["bindingHash"]=json!(hash(&b["payload"]));
    let mut a=base()["finalizeInput"]["approval"].clone();a["bindingHash"]=b["bindingHash"].clone();a["expiresAt"]=b["payload"]["expiresAt"].clone();
    let mut f=p.clone();f["plan"]=planned["plan"].clone();f["binding"]=b;f["approval"]=a;
    f["signatures"]=sign(&planned["plan"]["payload"]["signingTasks"]);
    let mut result=ok(EngineMethod::Finalize,&f);let mut rounds=1;
    while result.get("continuation").is_some() {
        f["continuation"]=result["continuation"].clone();f["signatures"]=sign(&result["signingRequests"]);
        result=ok(EngineMethod::Finalize,&f);rounds+=1;assert!(rounds<=3);
    }
    f["phase"]=json!("pre-broadcast");f["bundle"]=result["bundle"].clone();
    assert_eq!(ok(EngineMethod::Validate,&f)["valid"],true);
    (result,rounds)
}

#[test]
fn tbc20_create_native_prerequisite_three_external_signing_stages() {
    for explicit in [false,true] {
        let p=fragmented(input(true),3,400,explicit);let planned=ok(EngineMethod::Plan,&p);
        assert_eq!(planned["plan"]["payload"]["transactions"][0]["id"],"native-funding-1");
        let (result,rounds)=finalize(&p,&planned);assert_eq!(rounds,3);
        let txs:Vec<_>=result["bundle"]["transactions"].as_array().unwrap().iter()
            .map(|t|Transaction::from_hex(t["rawTransaction"].as_str().unwrap()).unwrap()).collect();
        assert_eq!(txs.len(),3);assert_eq!(txs[1].inputs[0].previous_output.txid,txs[0].txid());
        assert_eq!(txs[2].inputs[0].previous_output.txid,txs[1].txid());
    }
}

#[test]
fn tbc20_funding_keeps_sufficient_native_hot_path_without_maintenance() {
    for create in [false,true] {
        let p=input(create);let planned=ok(EngineMethod::Plan,&p);
        assert!(planned["plan"]["payload"]["transactions"].as_array().unwrap().iter().all(|tx|tx["id"]!="native-funding-1"));
        let (_,rounds)=finalize(&p,&planned);assert_eq!(rounds,if create {2}else{1});
    }
}

#[test]
fn tbc20_transfer_native_prerequisite_does_not_spend_tokens_or_bypass_vin_limit() {
    for explicit in [false,true] {
        let p=fragmented(input(false),12,100,explicit);let planned=ok(EngineMethod::Plan,&p);
        let (result,rounds)=finalize(&p,&planned);assert_eq!(rounds,2);
        let txs:Vec<_>=result["bundle"]["transactions"].as_array().unwrap().iter()
            .map(|t|Transaction::from_hex(t["rawTransaction"].as_str().unwrap()).unwrap()).collect();
        assert_eq!(txs.len(),2);assert_eq!(txs[1].inputs.len(),2);
        assert_eq!(txs[1].inputs[1].previous_output.txid,txs[0].txid());
        if explicit {assert_eq!(txs[0].inputs.len(),12);}
        let token=&p["snapshot"]["payload"]["utxos"][0];
        assert!(txs[0].inputs.iter().all(|i|i.previous_output.txid.to_string()!=token["txid"].as_str().unwrap()));
    }
}

#[test]
fn tbc20_funding_preserves_total_limits_and_exact_external_selection() {
    let p=fragmented(input(false),12,100,true);let plan=ok(EngineMethod::Plan,&p);
    let total=plan["plan"]["payload"]["preview"]["totalFee"].as_str().unwrap().parse::<u64>().unwrap();
    for mutation in 0..6 {
        let mut bad=p.clone();match mutation {
            0=>bad["request"]["constraints"]["maxFee"]=json!((total-1).to_string()),
            1=>bad["policy"]["payload"]["maxBundleTransactions"]=json!(1),
            2=>bad["request"]["constraints"]["inputOutpoints"].as_array_mut().unwrap().push(json!({"txid":"55".repeat(32),"vout":0})),
            3=>bad["snapshot"]["payload"]["utxos"][1]["confirmations"]=json!("0"),
            4=>bad["snapshot"]["payload"]["utxos"][1]["scriptPubKey"]=json!(format!("76a914{}88ac","00".repeat(20))),
            _=>{let duplicate=bad["snapshot"]["payload"]["utxos"][1].clone();bad["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().push(duplicate);},
        }
        let result=call(EngineMethod::Plan,&bind(bad));assert_eq!(result["ok"],false,"mutation {mutation}: {result}");
    }
}
