use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use secp256k1::{Message, Secp256k1, SecretKey};
use tbc_engine_core::{call_json, EngineMethod, protocols::timelock::height_code};
use tbc_sdk::{PrivateKey, Transaction, TxIn, TxOut, OutPoint, Txid, script::Script};
fn base() -> Value { serde_json::from_str(include_str!("../../../fixtures/tbc-transfer.json")).unwrap() }
fn hex(b: &[u8]) -> String { b.iter().map(|v| format!("{v:02x}")).collect() }
fn bytes(s: &str) -> Vec<u8> { (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i+2],16).unwrap()).collect() }
fn hash(v: &Value) -> String { hex(&Sha256::digest(serde_json::to_vec(v).unwrap())) }
fn call(m: EngineMethod, v: &Value) -> Value { serde_json::from_str(&call_json(m, &v.to_string())).unwrap() }
fn ok(m: EngineMethod, v: &Value) -> Value {
    let r = call(m,v); assert_eq!(r["ok"],true,"{r}");
    if std::env::var("TIMELOCK_PUBLIC_DUMP_WIRE").as_deref() == Ok("1") {
        let (a,b) = match m { EngineMethod::NormalizeRequest => ("normalizeRequestParams","normalizeRequestResult"),
            EngineMethod::Plan => ("planParams","planResult"), EngineMethod::Validate => ("validateParams","validationResult"),
            EngineMethod::Finalize => ("finalizeParams","finalizeResult") };
        println!("TIMELOCK_PUBLIC_WIRE:{}",json!({"definition":a,"value":v}));
        println!("TIMELOCK_PUBLIC_WIRE:{}",json!({"definition":b,"value":r["result"]}));
    }
    r["result"].clone()
}
fn bind(mut p: Value) -> Value {
    let n = ok(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":p["request"]}));
    p["request"] = n["request"].clone(); p["requestHash"] = n["requestHash"].clone();
    p["snapshot"]["snapshotHash"] = json!(hash(&p["snapshot"]["payload"]));
    p["policy"]["policyHash"] = json!(hash(&p["policy"]["payload"])); p
}
fn input(unlock: bool) -> Value {
    let mut p = base()["planInput"].clone();
    p["request"]["intent"] = if unlock { json!({"version":"1.0","type":"tbc-timelock-unlock"}) }
        else { json!({"version":"1.0","type":"tbc-timelock-lock","amount":"1000","lockTime":"830010"}) };
    p["policy"]["payload"]["dustThreshold"] = json!("42");
    p["snapshot"]["payload"]["block"]["height"] = json!("830000");
    if unlock {
        let mut scalar=[0;32]; scalar[31]=1; let public=PrivateKey::from_slice(&scalar).unwrap().public_key();
        let tx = Transaction { version:10, inputs:vec![TxIn::new(OutPoint {txid:Txid::from_le_bytes([7;32]),vout:0})],
            outputs:vec![TxOut {satoshis:10000,script_pubkey:Script::from_bytes(height_code(public.hash160(),829990).unwrap())}],lock_time:0 };
        let id=tx.txid().to_string();
        p["snapshot"]["payload"]["parents"]=json!([{"txid":id,"rawTransaction":hex(&tx.serialize())}]);
        p["snapshot"]["payload"]["utxos"]=json!([{"txid":id,"vout":0,"satoshis":"10000","scriptPubKey":hex(tx.outputs[0].script_pubkey.as_bytes()),"classification":"timelock","confirmations":"6"}]);
        p["request"]["constraints"]["inputOutpoints"]=json!([{"txid":id,"vout":0}]);
    }
    bind(p)
}
fn approved(p:&Value, plan:&Value) -> Value {
    let mut b=base()["finalizeInput"]["binding"].clone();
    b["payload"]["requestHash"]=p["requestHash"].clone(); b["payload"]["operationHash"]=plan["plan"]["planHash"].clone();
    b["payload"]["expiresAt"]=plan["plan"]["payload"]["expiresAt"].clone(); b["bindingHash"]=json!(hash(&b["payload"]));
    let mut approval=base()["finalizeInput"]["approval"].clone();
    approval["bindingHash"]=b["bindingHash"].clone(); approval["expiresAt"]=b["payload"]["expiresAt"].clone();
    let mut scalar=[0;32]; scalar[31]=1; let key=SecretKey::from_byte_array(scalar).unwrap();
    let sigs:Vec<_>=plan["plan"]["payload"]["signingTasks"].as_array().unwrap().iter().map(|t| {
        let digest=bytes(t["digest"].as_str().unwrap()).try_into().unwrap();
        json!({"taskId":t["taskId"],"signatureEncoding":"compact64","signature":hex(&Secp256k1::new().sign_ecdsa(Message::from_digest(digest),&key).serialize_compact())})
    }).collect();
    let mut r=p.clone(); r["plan"]=plan["plan"].clone(); r["binding"]=b; r["approval"]=approval; r["signatures"]=json!(sigs); r
}
#[test]
fn public_timelock_uses_shared_plan_approval_and_finalize() {
    for unlock in [false,true] {
        let p=input(unlock); let plan=ok(EngineMethod::Plan,&p); let signed=approved(&p,&plan);
        let mut check=signed.clone(); check["phase"]=json!("pre-sign"); check.as_object_mut().unwrap().remove("signatures");
        assert_eq!(ok(EngineMethod::Validate,&check)["valid"],true);
        let result=ok(EngineMethod::Finalize,&signed); let tx=Transaction::from_hex(result["bundle"]["transactions"][0]["rawTransaction"].as_str().unwrap()).unwrap();
        assert_eq!(tx.lock_time,if unlock {830000}else{0});
        check=signed.clone(); check["phase"]=json!("pre-broadcast"); check["bundle"]=result["bundle"].clone();
        assert_eq!(ok(EngineMethod::Validate,&check)["valid"],true);
        let mut tampered=signed; tampered["plan"]["payload"]["transactions"][0]["fee"]=json!("79");
        assert_eq!(call(EngineMethod::Finalize,&tampered)["ok"],false);
    }
}
#[test]
fn public_timelock_rejects_wrong_parents_owner_policy_explicit_inputs_and_height() {
    for case in 0..11 {
        let mut p=input(true);
        match case {
            0 => p["snapshot"]["payload"]["parents"]=json!([]),
            1 => p["snapshot"]["payload"]["utxos"][0]["satoshis"]=json!("10001"),
            2 => p["snapshot"]["payload"]["block"]["height"]=json!("829989"),
            3 => p["snapshot"]["payload"]["block"]["height"]=json!("500000000"),
            4 => p["policy"]["payload"]["feeRateSatPerKb"]=json!("1"),
            5 => p["policy"]["payload"]["amountLimits"][0]["maximum"]=json!("1"),
            6 => p["snapshot"]["payload"]["utxos"][0]["confirmations"]=json!("0"),
            7 => p["snapshot"]["payload"]["utxos"][0]["classification"]=json!("native"),
            8 => p["request"]["constraints"]["inputOutpoints"].as_array_mut().unwrap().push(json!({"txid":"ff".repeat(32),"vout":0})),
            9 => { let id=json!("ef".repeat(32)); p["request"]["constraints"]["inputOutpoints"][0]["txid"]=id.clone();
                p["snapshot"]["payload"]["parents"][0]["txid"]=id.clone(); p["snapshot"]["payload"]["utxos"][0]["txid"]=id; }
            _ => {
                let raw=p["snapshot"]["payload"]["parents"][0]["rawTransaction"].as_str().unwrap();
                let mut tx=Transaction::from_hex(raw).unwrap();
                let mut code=tbc_engine_core::protocols::timelock::Code::decode(tx.outputs[0].script_pubkey.as_bytes()).unwrap();
                code.owner_hash=[0;20];tx.outputs[0].script_pubkey=Script::from_bytes(code.encode());
                let id=json!(tx.txid().to_string());
                p["snapshot"]["payload"]["parents"][0]=json!({"txid":id,"rawTransaction":hex(&tx.serialize())});
                p["snapshot"]["payload"]["utxos"][0]["txid"]=id.clone();
                p["snapshot"]["payload"]["utxos"][0]["scriptPubKey"]=json!(hex(tx.outputs[0].script_pubkey.as_bytes()));
                p["request"]["constraints"]["inputOutpoints"][0]["txid"]=id;
            }
        }
        p=bind(p); assert_eq!(call(EngineMethod::Plan,&p)["ok"],false,"case {case}");
    }
    let mut p=input(false); p["request"]["intent"]["lockTime"]=json!("829999"); p=bind(p);
    assert_eq!(call(EngineMethod::Plan,&p)["ok"],false);
    for unlock in [false,true] {
        let p=input(unlock);
        for field in ["to","contractId","payment","receivers"] {
            let mut r=p["request"].clone(); r["intent"][field]=json!("unexpected");
            assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":r}))["ok"],false);
        }
    }
}

#[test]
fn timelock_funding_is_direct_multi_input_without_consolidation_or_unused_inputs() {
    let mut p=input(false);
    let template=p["snapshot"]["payload"]["utxos"][0].clone();
    p["snapshot"]["payload"]["parents"]=json!([]);
    let funding:Vec<_>=(1..=7).map(|i| { let mut u=template.clone();u["txid"]=json!(format!("{i:02x}").repeat(32));u["satoshis"]=json!("1000");u }).collect();
    p["snapshot"]["payload"]["utxos"]=json!(funding);
    p["request"]["constraints"]["maxFee"]=json!("1000");
    p["request"]["intent"]["amount"]=json!("6800");p=bind(p);
    let plan=ok(EngineMethod::Plan,&p);assert_eq!(plan["plan"]["payload"]["transactions"].as_array().unwrap().len(),1);
    assert_eq!(plan["plan"]["payload"]["signingTasks"].as_array().unwrap().len(),7);
    ok(EngineMethod::Finalize,&approved(&p,&plan));
    p["request"]["intent"]["amount"]=json!("500");p=bind(p);
    assert_eq!(ok(EngineMethod::Plan,&p)["plan"]["payload"]["signingTasks"].as_array().unwrap().len(),1);
    p["request"]["constraints"]["inputOutpoints"]=json!(funding.iter().map(|u|json!({"txid":u["txid"],"vout":u["vout"]})).collect::<Vec<_>>());p=bind(p);
    let plan=ok(EngineMethod::Plan,&p);
    assert_eq!(plan["plan"]["payload"]["signingTasks"].as_array().unwrap().len(),7);
}
