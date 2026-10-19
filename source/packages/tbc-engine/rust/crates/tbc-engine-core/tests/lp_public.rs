use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use secp256k1::{Message,Secp256k1,SecretKey};
use std::collections::BTreeSet;
#[path = "support/unified_business.rs"]
mod unified_business;

#[test]
fn unified_lp_rejects_unsupported_current_pool_operations() {
    unified_business::reject_unsupported_pool_operations(input("public-plain-transfer-0").0, true);
}
#[test]
fn unified_lp_holder_operations_preserve_current_transactions() {
    for name in ["public-plain-transfer-0","public-plain-merge-0","controller-locked-transfer-0","controller-locked-merge-0","controller-locked-unlock-0"] {
        unified_business::exercise_pool(input(name).0);
    }
    let (mut p,_)=input("controller-locked-transfer-0");
    p["request"]["intent"]["type"]=json!("tbc20-lp-lock");
    p["request"]["intent"].as_object_mut().unwrap().remove("to");
    p["request"]["intent"]["lockTime"]=json!("900000");
    unified_business::exercise_pool(bind(p));
}
use tbc_engine_core::{call_json,EngineMethod};
use tbc_sdk::Transaction;
fn base()->Value{serde_json::from_str(include_str!("../../../fixtures/tbc-transfer.json")).unwrap()}
fn oracle()->Value{serde_json::from_str(include_str!("../../../fixtures/amm-lp-proof.json")).unwrap()}
fn hex(b:&[u8])->String{b.iter().map(|v|format!("{v:02x}")).collect()}
fn bytes(s:&str)->Vec<u8>{(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
fn hash(v:&Value)->String{hex(&Sha256::digest(serde_json::to_vec(v).unwrap()))}
fn call(method:EngineMethod,v:&Value)->Value{serde_json::from_str(&call_json(method,&v.to_string())).unwrap()}
fn ok(method:EngineMethod,v:&Value)->Value{
    let r=call(method,v);assert_eq!(r["ok"],true,"{r}");
    if std::env::var("LP_DUMP_WIRE").as_deref()==Ok("1"){
        let (a,b)=match method{EngineMethod::NormalizeRequest=>("normalizeRequestParams","normalizeRequestResult"),EngineMethod::Plan=>("planParams","planResult"),EngineMethod::Validate=>("validateParams","validationResult"),EngineMethod::Finalize=>("finalizeParams","finalizeResult")};
        println!("LP_WIRE:{}",json!({"definition":a,"value":v}));println!("LP_WIRE:{}",json!({"definition":b,"value":r["result"]}));
    }r["result"].clone()
}
fn bind(mut p:Value)->Value{
    let r=ok(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":p["request"]}));
    p["request"]=r["request"].clone();p["requestHash"]=r["requestHash"].clone();
    p["snapshot"]["snapshotHash"]=json!(hash(&p["snapshot"]["payload"]));p["policy"]["policyHash"]=json!(hash(&p["policy"]["payload"]));p
}
fn input(label:&str)->(Value,Value){
    let f=oracle();let v=f["vectors"].as_array().unwrap().iter().find(|v|v["id"]==label).unwrap();
    let locked=label.starts_with("controller");let seq=&f["sequences"][usize::from(locked)];
    let pool=seq["transactions"][2].as_str().unwrap();
    let parent=Transaction::from_hex(f["raws"][v["parentTxid"].as_str().unwrap()].as_str().unwrap()).unwrap();
    let current=Transaction::from_hex(v["currentRaw"].as_str().unwrap()).unwrap();
    let genesis=Transaction::from_hex(f["raws"][pool].as_str().unwrap()).unwrap();
    let mut ids=BTreeSet::new();ids.insert(pool.to_owned());ids.insert(seq["transactions"][1].as_str().unwrap().into());
    ids.insert(genesis.inputs[0].previous_output.txid.to_string());ids.insert(parent.txid().to_string());
    for id in v["ancestors"].as_array().unwrap(){ids.insert(id.as_str().unwrap().into());}
    let mut p=base()["planInput"].clone();
    let operation=if label.contains("merge"){"merge"}else if label.contains("unlock"){"unlock"}else{"transfer"};
    p["request"]["intent"]=json!({"type":format!("tbc20-lp-{operation}"),"version":"1.0","poolContractId":pool});
    if operation=="transfer"{p["request"]["intent"]["to"]=p["request"]["from"].clone();p["request"]["intent"]["amount"]=json!(if label.contains("transfer"){ "40000" }else{"100000"});}
    p["request"]["constraints"]["maxFee"]=json!("10000");
    p["snapshot"]["payload"]["block"]["height"]=json!("830000");
    p["snapshot"]["payload"]["parents"]=json!(ids.iter().map(|id|json!({"txid":id,"rawTransaction":f["raws"][id]})).collect::<Vec<_>>());
    p["snapshot"]["payload"]["utxos"]=json!(current.inputs.iter().enumerate().map(|(n,i)|{
        assert_eq!(i.previous_output.txid,parent.txid());let out=&parent.outputs[i.previous_output.vout as usize];let native=n==current.inputs.len()-1;
        let mut u=json!({"txid":parent.txid().to_string(),"vout":i.previous_output.vout,"satoshis":out.satoshis.to_string(),"scriptPubKey":hex(out.script_pubkey.as_bytes()),"classification":if native{"native"}else{"ftlp"},"confirmations":"0"});
        if !native{u["contractId"]=json!(pool);}u
    }).collect::<Vec<_>>());
    p["snapshot"]["payload"]["contracts"]=json!([{"contractId":pool,"family":"pool","protocolVersion":"pool3","standardId":"tbc-amm",
        "templateRevision":if locked{"cf7f95c0483b56ad24825591acbce6e82e37890aa0047fc63183d3fb7a7a4ffc"}else{"c98ecae0a22452ce37bcaf24be0c836521d3de3a75aa8f16cef587b8b6f031b2"},
        "creationTxid":pool,"genesisOutpoint":{"txid":pool,"vout":0},"currentOutpoint":{"txid":"ee".repeat(32),"vout":0}}]);
    p["policy"]["payload"]["dustThreshold"]=json!("10");p["policy"]["payload"]["minConfirmations"]=json!("0");
    p["policy"]["payload"]["contractPolicies"]=json!([{"family":"pool","allowedVersions":["pool3"]}]);
    (bind(p),v.clone())
}
fn approved(p:&Value,plan:&Value)->Value{
    let mut b=base()["finalizeInput"]["binding"].clone();b["payload"]["requestHash"]=p["requestHash"].clone();b["payload"]["operationHash"]=plan["plan"]["planHash"].clone();
    b["payload"]["expiresAt"]=plan["plan"]["payload"]["expiresAt"].clone();b["bindingHash"]=json!(hash(&b["payload"]));
    let mut approval=base()["finalizeInput"]["approval"].clone();approval["bindingHash"]=b["bindingHash"].clone();approval["expiresAt"]=b["payload"]["expiresAt"].clone();
    // Public offline scalar, never an installed wallet key.
    let mut scalar=[0;32];scalar[31]=1;let key=SecretKey::from_byte_array(scalar).unwrap();let secp=Secp256k1::new();
    let sigs:Vec<_>=plan["plan"]["payload"]["signingTasks"].as_array().unwrap().iter().map(|t|{
        assert_eq!(t["signatureEncoding"],"compact64");let digest=bytes(t["digest"].as_str().unwrap()).try_into().unwrap();
        json!({"taskId":t["taskId"],"signatureEncoding":"compact64","signature":hex(&secp.sign_ecdsa(Message::from_digest(digest),&key).serialize_compact())})
    }).collect();let mut r=p.clone();r["plan"]=plan["plan"].clone();r["binding"]=b;r["approval"]=approval;r["signatures"]=json!(sigs);r
}
fn finish(p:&Value)->Value{
    let plan=ok(EngineMethod::Plan,p);let signed=approved(p,&plan);let mut check=signed.clone();check["phase"]=json!("pre-sign");check.as_object_mut().unwrap().remove("signatures");
    let v=ok(EngineMethod::Validate,&check);assert_eq!(v["valid"],true,"{v}");
    let result=ok(EngineMethod::Finalize,&signed);check=signed.clone();check["phase"]=json!("pre-broadcast");check["bundle"]=result["bundle"].clone();
    let v=ok(EngineMethod::Validate,&check);assert_eq!(v["valid"],true,"{v}");result
}
#[test]
fn six_public_lp_flows_match_sdk_without_current_pool_read(){
    let f=oracle();
    for name in ["public-plain-transfer-0","public-plain-merge-0","public-plain-again-0","controller-locked-transfer-0","controller-locked-merge-0","controller-locked-unlock-0"]{
        let (p,v)=input(name);let result=finish(&p);let tx=&result["bundle"]["transactions"][0];
        assert_eq!(tx["rawTransaction"],f["raws"][v["signedTxid"].as_str().unwrap()],"{name}");assert_eq!(tx["txid"],v["signedTxid"],"{name}");
    }
}
#[test]
fn public_lp_lock_uses_same_signer_and_preserves_change_lock(){
    let (mut p,_)=input("controller-locked-transfer-0");p["request"]["intent"]["type"]=json!("tbc20-lp-lock");p["request"]["intent"].as_object_mut().unwrap().remove("to");p["request"]["intent"]["lockTime"]=json!("900000");p=bind(p);
    let r=finish(&p);let tx=Transaction::from_hex(r["bundle"]["transactions"][0]["rawTransaction"].as_str().unwrap()).unwrap();
    let tape=|i:usize|tbc_engine_core::protocols::amm_lp::Tape::decode(tx.outputs[i].script_pubkey.as_bytes(),true,None).unwrap();
    assert_eq!(tape(1).lock_time,900000);assert_eq!(tape(3).lock_time,829999);
    for lock in ["829998","500000001"]{let mut bad=p.clone();bad["request"]["intent"]["lockTime"]=json!(lock);bad=bind(bad);assert_eq!(call(EngineMethod::Plan,&bad)["ok"],false);}
}
#[test]
fn public_lp_exact_inputs_do_not_require_native_parent_raw_or_current_pool(){
    let (mut p,_)=input("public-plain-transfer-0");
    let native=base()["planInput"]["snapshot"]["payload"]["utxos"][0].clone();
    let list=p["snapshot"]["payload"]["utxos"].as_array_mut().unwrap();list.pop();list.push(native.clone());
    p["request"]["constraints"]["inputOutpoints"]=json!(list.iter().map(|u|json!({"txid":u["txid"],"vout":u["vout"]})).collect::<Vec<_>>());
    p=bind(p);finish(&p);
    assert!(!p["snapshot"]["payload"]["parents"].as_array().unwrap().iter().any(|r|r["txid"]==native["txid"]));
    let mut bad=p.clone();bad["request"]["constraints"]["inputOutpoints"].as_array_mut().unwrap().pop();bad=bind(bad);assert_eq!(call(EngineMethod::Plan,&bad)["ok"],false);
    let mut bad=p.clone();bad["request"]["constraints"]["inputOutpoints"].as_array_mut().unwrap().push(json!({"txid":"ff".repeat(32),"vout":0}));bad=bind(bad);assert_eq!(call(EngineMethod::Plan,&bad)["ok"],false);
}
#[test]
fn public_lp_rejects_unbound_identity_missing_proof_limits_and_immature_inputs(){
    let (p,_)=input("controller-locked-transfer-0");
    for case in 0..9{
        let mut bad=p.clone();match case{
            0=>bad["snapshot"]["payload"]["contracts"][0]["templateRevision"]=json!("00".repeat(32)),
            1=>bad["snapshot"]["payload"]["contracts"][0]["protocolVersion"]=json!("1.0"),
            2=>bad["snapshot"]["payload"]["contracts"][0]["creationTxid"]=json!("00".repeat(32)),
            3=>bad["snapshot"]["payload"]["parents"]=json!([]),
            4=>bad["snapshot"]["payload"]["utxos"][0]["satoshis"]=json!("501"),
            5=>bad["snapshot"]["payload"]["block"]["height"]=json!("829998"),
            6=>bad["policy"]["payload"]["amountLimits"]=json!([{"scope":"lp-total","protocolVersion":"pool3","maximum":"39999"}]),
            7=>bad["request"]["constraints"]["maxFee"]=json!("1"),
            _=>bad["policy"]["payload"]["contractPolicies"]=json!([]),
        }bad=bind(bad);assert_eq!(call(EngineMethod::Plan,&bad)["ok"],false,"case {case}");
    }
    for field in ["payment","name","receivers","contractId"]{
        let mut request=p["request"].clone();request["intent"][field]=json!("1");assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":request}))["ok"],false);
    }
}
