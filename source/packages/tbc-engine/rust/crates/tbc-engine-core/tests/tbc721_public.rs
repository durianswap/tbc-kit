//! Public Engine boundary, fabricated offline funds and public test scalar 1.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use secp256k1::{Message, Secp256k1, SecretKey};
use tbc_engine_core::{call_json, EngineMethod};
use tbc_sdk::Transaction;
#[path = "support/unified_business.rs"]
mod unified_business;

#[test]
fn unified_current_nft_signing_matches_concrete() {
    unified_business::exercise(input("tbc721-standard-transfer"), "tbc721.transfer");
    let mut with_payment = input("tbc721-standard-transfer");
    with_payment["request"]["intent"]["payment"] = json!({"to":with_payment["request"]["from"],"amount":"1234"});
    unified_business::exercise(bind(with_payment), "tbc721.transfer");
}

fn base()->Value {serde_json::from_str(include_str!("../../../fixtures/tbc-transfer.json")).unwrap()}
fn oracle()->Value {serde_json::from_str(include_str!("../../../fixtures/tbc721-standard-proof.json")).unwrap()}
fn hex(b:&[u8])->String {b.iter().map(|b|format!("{b:02x}")).collect()}
fn bytes(s:&str)->Vec<u8> {(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
fn hash(v:&Value)->String {hex(&Sha256::digest(serde_json::to_vec(v).unwrap()))}
fn call(m:EngineMethod,v:&Value)->Value {serde_json::from_str(&call_json(m,&v.to_string())).unwrap()}
fn ok(m:EngineMethod,v:&Value)->Value {
    let result=call(m,v);assert_eq!(result["ok"],true,"{result}");
    if std::env::var("TBC721_DUMP_WIRE").as_deref()==Ok("1") {
        let (params,out)=match m {
            EngineMethod::NormalizeRequest=>("normalizeRequestParams","normalizeRequestResult"),
            EngineMethod::Plan=>("planParams","planResult"),
            EngineMethod::Validate=>("validateParams","validationResult"),
            EngineMethod::Finalize=>("finalizeParams","finalizeResult"),
        };
        println!("TBC721_WIRE:{}",json!({"definition":params,"value":v}));
        println!("TBC721_WIRE:{}",json!({"definition":out,"value":result["result"]}));
    }
    result["result"].clone()
}
fn bind(mut p:Value)->Value {
    let n=ok(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":p["request"]}));
    p["request"]=n["request"].clone();p["requestHash"]=n["requestHash"].clone();
    p["snapshot"]["snapshotHash"]=json!(hash(&p["snapshot"]["payload"]));
    p["policy"]["policyHash"]=json!(hash(&p["policy"]["payload"]));p
}
fn utxo(tx:&Transaction,vout:usize,class:&str,contract:Option<&str>)->Value {
    let output=&tx.outputs[vout];let mut value=json!({"txid":tx.txid().to_string(),"vout":vout,
        "satoshis":output.satoshis.to_string(),"scriptPubKey":hex(output.script_pubkey.as_bytes()),
        "confirmations":"0","classification":class});
    if let Some(id)=contract {value["contractId"]=json!(id);}value
}
fn input(kind:&str)->Value {
    let mut p=base()["planInput"].clone();
    p["policy"]["payload"]["dustThreshold"]=json!("42");p["policy"]["payload"]["minConfirmations"]=json!("0");
    p["request"]["constraints"]["maxFee"]=json!("5000");
    let owner=p["request"]["from"].clone();
    let metadata=json!({"name":"NFT","symbol":"N","description":"synthetic","attributes":[
        {"traitType":"string","value":"x"},{"traitType":"boolean","value":true},{"traitType":"number","value":-1}]});
    if kind=="tbc721-standard-create-collection" {
        p["request"]["intent"]=json!({"type":kind,"version":"1.0","name":"Collection","description":"offline","supply":"3",
            "media":{"kind":"uri","uri":"ipfs://synthetic"}});
    }else {
        let f=oracle();let collection=Transaction::from_hex(f["vectors"][0]["grandparentRaw"].as_str().unwrap()).unwrap();
        let genesis=Transaction::from_hex(f["vectors"][0]["parentRaw"].as_str().unwrap()).unwrap();
        let current=Transaction::from_hex(f["vectors"][1]["parentRaw"].as_str().unwrap()).unwrap();
        let mint=kind!="tbc721-standard-transfer";
        let id=if mint {collection.txid()}else{genesis.txid()}.to_string();
        let (utxos,parents,point)=if mint {
            (vec![utxo(&collection,1,"collection-slot",Some(&id)),utxo(&collection,3,"collection-slot",Some(&id)),utxo(&collection,4,"native",None)],
             vec![collection.clone()],json!({"txid":id,"vout":1}))
        } else {
            (vec![utxo(&current,0,"nft",Some(&id)),utxo(&current,1,"nft",Some(&id)),utxo(&current,3,"native",None)],
             vec![genesis,current.clone()],json!({"txid":current.txid().to_string(),"vout":0}))
        };
        p["snapshot"]["payload"]["utxos"]=json!(utxos);
        p["snapshot"]["payload"]["parents"]=json!(parents.iter().map(|tx|json!({"txid":tx.txid().to_string(),"rawTransaction":tx.to_hex()})).collect::<Vec<_>>());
        p["snapshot"]["payload"]["contracts"]=json!([{"contractId":id,"family":if mint {"collection"}else{"nft"},
            "protocolVersion":"tbc721","standardId":"tbc721-standard",
            "templateRevision":"a97688ec62777b01e93c8486e0505b56701f48dc8cf7947637ece57fe88df104",
            "creationTxid":id,"genesisOutpoint":{"txid":id,"vout":0},"currentOutpoint":point}]);
        p["request"]["intent"]=match kind {
            "tbc721-standard-mint"=>{let mut v=metadata.clone();v["type"]=json!(kind);v["version"]=json!("1.0");v["collectionId"]=json!(id);v["slot"]=json!(1);v},
            "tbc721-standard-batch-mint"=>{let mut a=metadata.clone();a["slot"]=json!(1);let mut b=metadata;b["slot"]=json!(3);
                json!({"type":kind,"version":"1.0","collectionId":id,"items":[a,b]})},
            _=>json!({"type":kind,"version":"1.0","contractId":id,"to":owner}),
        };
    }
    bind(p)
}
fn sign(tasks:&Value)->Value {
    let mut scalar=[0;32];scalar[31]=1;let key=SecretKey::from_byte_array(scalar).unwrap();
    json!(tasks.as_array().unwrap().iter().map(|t|json!({"taskId":t["taskId"],"signatureEncoding":"compact64",
        "signature":hex(&Secp256k1::new().sign_ecdsa(Message::from_digest(bytes(t["digest"].as_str().unwrap()).try_into().unwrap()),&key).serialize_compact())})).collect::<Vec<_>>())
}
fn approved(p:&Value,plan:&Value)->Value {
    let mut binding=base()["finalizeInput"]["binding"].clone();
    binding["payload"]["requestHash"]=p["requestHash"].clone();binding["payload"]["operationHash"]=plan["plan"]["planHash"].clone();
    binding["payload"]["expiresAt"]=plan["plan"]["payload"]["expiresAt"].clone();binding["bindingHash"]=json!(hash(&binding["payload"]));
    let mut approval=base()["finalizeInput"]["approval"].clone();approval["bindingHash"]=binding["bindingHash"].clone();
    approval["expiresAt"]=plan["plan"]["payload"]["expiresAt"].clone();
    let mut v=p.clone();v["plan"]=plan["plan"].clone();v["binding"]=binding;v["approval"]=approval;
    v["signatures"]=sign(&plan["plan"]["payload"]["signingTasks"]);v
}
fn phase(name:&str,finalize:&Value,bundle:Option<&Value>) {
    let mut p=finalize.clone();p["phase"]=json!(name);
    if matches!(name,"plan"|"pre-sign") {p.as_object_mut().unwrap().remove("signatures");}
    if name=="plan" {p.as_object_mut().unwrap().remove("binding");p.as_object_mut().unwrap().remove("approval");}
    if let Some(b)=bundle {p["bundle"]=b.clone();}
    let r=ok(EngineMethod::Validate,&p);assert_eq!(r["valid"],true,"{name}: {r}");
}

#[test]
fn public_nft_lifecycle_four_phases_and_external_batch_continuation() {
    let mut cases:Vec<_>=["tbc721-standard-create-collection","tbc721-standard-mint","tbc721-standard-batch-mint","tbc721-standard-transfer"]
        .into_iter().map(input).collect();
    let mut payment=input("tbc721-standard-transfer");payment["request"]["intent"]["payment"]=json!({"to":payment["request"]["from"],"amount":"1234"});
    cases.push(bind(payment));
    for p in cases {
        let plan=ok(EngineMethod::Plan,&p);let mut f=approved(&p,&plan);phase("plan",&f,None);phase("pre-sign",&f,None);
        let mut result=ok(EngineMethod::Finalize,&f);let mut rounds=1;
        while result.get("continuation").is_some() {
            f["continuation"]=result["continuation"].clone();f["signatures"]=sign(&result["signingRequests"]);
            result=ok(EngineMethod::Finalize,&f);rounds+=1;assert!(rounds<=2);
        }
        let batch=p["request"]["intent"]["type"]=="tbc721-standard-batch-mint";
        assert_eq!(rounds,if batch {2}else{1});
        for name in ["finalized","pre-broadcast"] {phase(name,&f,Some(&result["bundle"]));}
        let txs:Vec<_>=result["bundle"]["transactions"].as_array().unwrap().iter().map(|t|Transaction::from_hex(t["rawTransaction"].as_str().unwrap()).unwrap()).collect();
        if batch {assert_eq!(txs[1].inputs[1].previous_output.txid,txs[0].txid());}
        if p["request"]["intent"].get("payment").is_some() {assert_eq!(txs[0].outputs[3].satoshis,1234);}
        let mut wrong=f.clone();wrong["approval"]["bindingHash"]=json!("00".repeat(32));assert_eq!(call(EngineMethod::Finalize,&wrong)["ok"],false);
    }
}

#[test]
fn public_nft_rejects_identity_slot_funding_and_policy_tampering() {
    for i in 0..8 {
        let mut p=input("tbc721-standard-transfer");
        match i {
            0=>p["snapshot"]["payload"]["contracts"][0]["templateRevision"]=json!("00".repeat(32)),
            1=>p["snapshot"]["payload"]["contracts"][0]["protocolVersion"]=json!("1.0"),
            2=>p["snapshot"]["payload"]["contracts"][0]["genesisOutpoint"]["vout"]=json!(1),
            3=>p["snapshot"]["payload"]["utxos"][1]["satoshis"]=json!("101"),
            4=>{p["snapshot"]["payload"]["parents"].as_array_mut().unwrap().remove(0);},
            5=>p["policy"]["payload"]["dustThreshold"]=json!("24"),
            6=>p["policy"]["payload"]["contractPolicies"]=json!([{"family":"nft","allowedVersions":["1.0"]}]),
            _=>{p["request"]["intent"]["payment"]=json!({"to":p["request"]["from"],"amount":"1234"});p["policy"]["payload"]["amountLimits"][0]["maximum"]=json!("1000");},
        }
        assert_eq!(call(EngineMethod::Plan,&bind(p))["ok"],false,"case {i}");
    }
    let mut p=input("tbc721-standard-mint");p["request"]["intent"]["slot"]=json!(4);
    assert_eq!(call(EngineMethod::Plan,&bind(p))["ok"],false);
    let mut p=input("tbc721-standard-transfer");p["request"]["constraints"]["inputOutpoints"]=json!([{
        "txid":p["snapshot"]["payload"]["utxos"][2]["txid"],"vout":3}]);
    assert_eq!(call(EngineMethod::Plan,&bind(p))["ok"],false);
}

#[test]
fn public_nft_normalization_has_strict_fields_and_does_not_change_old_intents() {
    for patch in [json!({"slot":0}),json!({"slot":4294967296u64}),json!({"symbol":"two words"}),
        json!({"attributes":[{"traitType":"x","value":1.5}]}),json!({"attributes":[{"traitType":"x","value":null}]}),
        json!({"media":{"kind":"uri","uri":"http://not-allowed"}}),json!({"media":{"kind":"uri","uri":"ipfs://x","unknown":true}}),
        json!({"media":{"kind":"base64","mediaType":"image/png","data":"bad","sha256":"00".repeat(32)}}),
        json!({"payment":{"to":"1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH","amount":"100"}})] {
        let mut r=input("tbc721-standard-mint")["request"].clone();
        r["intent"].as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
        assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":r}))["ok"],false);
    }
    let mut p=input("tbc721-standard-batch-mint");p["request"]["intent"]["items"][1]["slot"]=json!(1);
    assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":p["request"]}))["ok"],false);
    let old=base()["planInput"]["request"].clone();ok(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":old}));
    let mut wrong=old;wrong["intent"]["slot"]=json!(1);
    assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":wrong}))["ok"],false);
}
