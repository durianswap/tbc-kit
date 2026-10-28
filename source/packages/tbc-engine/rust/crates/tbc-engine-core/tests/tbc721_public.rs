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

fn complete_batch_fixture(p: &Value) -> (Value, Value, Value) {
    let plan=ok(EngineMethod::Plan,p);let mut f=approved(p,&plan);
    phase("plan",&f,None);phase("pre-sign",&f,None);
    let binding=f["binding"].clone();let approval=f["approval"].clone();
    for _ in 0..101 {
        let result=ok(EngineMethod::Finalize,&f);
        assert_eq!(f["binding"],binding);assert_eq!(f["approval"],approval);
        if result.get("bundle").is_some(){
            phase("finalized",&f,Some(&result["bundle"]));phase("pre-broadcast",&f,Some(&result["bundle"]));
            return (plan,result["bundle"].clone(),f);
        }
        f["continuation"]=result["continuation"].clone();f["signatures"]=sign(&result["signingRequests"]);
    }
    panic!("NFT fixture exceeded continuation budget")
}

fn batch_transfer_fixture(historical: bool) -> Value {
    use tbc_sdk::{Address,OutPoint,TxIn,TxOut,contracts::nft::{NftData,scripts}};
    let mint=input("tbc721-standard-batch-mint");
    let (_,bundle,_)=complete_batch_fixture(&mint);
    let mut txs:Vec<_>=bundle["transactions"].as_array().unwrap().iter()
        .map(|tx|Transaction::from_hex(tx["rawTransaction"].as_str().unwrap()).unwrap()).collect();
    let fee=txs[1].clone();
    let collection=Transaction::from_hex(mint["snapshot"]["payload"]["parents"][0]["rawTransaction"].as_str().unwrap()).unwrap();
    let from=mint["request"]["from"].as_str().unwrap();let owner=Address::from_string(from).unwrap();
    if historical {
        // Public synthetic historical holder, not an invocation of retired issuance.
        txs[1]=Transaction {version:10,inputs:vec![TxIn::new(OutPoint{txid:collection.txid(),vout:2})],
            outputs:vec![TxOut{satoshis:200,script_pubkey:scripts::code_script(&collection.txid().to_string(),2).unwrap()},
                TxOut{satoshis:100,script_pubkey:scripts::hold_script(&owner)},
                TxOut{satoshis:0,script_pubkey:scripts::tape_script(&NftData{nft_name:"Historical".into(),symbol:"H".into(),
                    description:"fixture".into(),attributes:"[]".into(),file:None}).unwrap()}],lock_time:0};
    }
    let mut p=mint.clone();let ids:Vec<_>=txs.iter().map(|tx|tx.txid().to_string()).collect();
    p["request"]["intent"]=json!({"version":"1.0","type":"tbc721.batchTransfer","transfers":ids.iter()
        .map(|id|json!({"contractId":id,"to":from})).collect::<Vec<_>>()});
    let mut utxos=vec![utxo(&fee,3,"native",None)];
    let mut records=Vec::new();
    for (index,tx) in txs.iter().enumerate(){
        utxos.extend([utxo(tx,0,"nft",Some(&ids[index])),utxo(tx,1,"nft",Some(&ids[index]))]);
        let mut record=json!({"contractId":ids[index],"creationTxid":ids[index],"family":"nft",
            "protocolVersion":if historical&&index==1{"2.0"}else{"tbc721"},"currentOutpoint":{"txid":ids[index],"vout":0}});
        if !historical||index==0 {
            record["standardId"]=json!("tbc721-standard");record["templateRevision"]=json!("a97688ec62777b01e93c8486e0505b56701f48dc8cf7947637ece57fe88df104");
            record["genesisOutpoint"]=json!({"txid":ids[index],"vout":0});
        }
        records.push(record);
    }
    p["snapshot"]["payload"]["utxos"]=json!(utxos);p["snapshot"]["payload"]["contracts"]=json!(records);
    let mut parents=txs;parents.push(collection);
    if historical {parents.push(fee);}
    p["snapshot"]["payload"]["parents"]=json!(parents.iter().map(|tx|json!({"txid":tx.txid().to_string(),"rawTransaction":tx.to_hex()})).collect::<Vec<_>>());
    bind(p)
}

fn batch_transfer_multi_collection_fixture() -> Value {
    let mut mint=input("tbc721-standard-batch-mint");
    let mut collection=Transaction::from_hex(mint["snapshot"]["payload"]["parents"][0]["rawTransaction"].as_str().unwrap()).unwrap();
    // A second synthetic collection with independent slot identity.
    collection.lock_time=1;
    let id=collection.txid().to_string();
    mint["request"]["intent"]["collectionId"]=json!(id);
    mint["snapshot"]["payload"]["parents"]=json!([{"txid":id,"rawTransaction":collection.to_hex()}]);
    for u in mint["snapshot"]["payload"]["utxos"].as_array_mut().unwrap(){
        u["txid"]=json!(id);if u.get("contractId").is_some(){u["contractId"]=json!(id);}
    }
    let record=&mut mint["snapshot"]["payload"]["contracts"][0];
    for field in ["contractId","creationTxid"]{record[field]=json!(id);}
    record["genesisOutpoint"]["txid"]=json!(id);record["currentOutpoint"]["txid"]=json!(id);
    let (_,bundle,_)=complete_batch_fixture(&bind(mint));
    let minted=Transaction::from_hex(bundle["transactions"][0]["rawTransaction"].as_str().unwrap()).unwrap();
    let nft_id=minted.txid().to_string();
    let mut p=batch_transfer_fixture(false);
    let replaced=p["request"]["intent"]["transfers"][1]["contractId"].clone();
    p["request"]["intent"]["transfers"][1]["contractId"]=json!(nft_id);
    p["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().retain(|u|u["contractId"]!=replaced);
    p["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().extend([utxo(&minted,0,"nft",Some(&nft_id)),utxo(&minted,1,"nft",Some(&nft_id))]);
    let record=&mut p["snapshot"]["payload"]["contracts"][1];
    for field in ["contractId","creationTxid"]{record[field]=json!(nft_id);}
    record["genesisOutpoint"]["txid"]=json!(nft_id);record["currentOutpoint"]["txid"]=json!(nft_id);
    for tx in [collection,minted]{
        p["snapshot"]["payload"]["parents"].as_array_mut().unwrap().push(json!({"txid":tx.txid().to_string(),"rawTransaction":tx.to_hex()}));
    }
    bind(p)
}

#[test]
fn shared_nft_batch_transfer_reuses_fee_change_and_authenticates_mixed_profiles() {
    for (label,p) in [("current",batch_transfer_fixture(false)),("mixed",batch_transfer_fixture(true)),
        ("collections",batch_transfer_multi_collection_fixture())] {
        let (plan,bundle,f)=complete_batch_fixture(&p);
        assert_eq!(plan["plan"]["payload"]["transactions"].as_array().unwrap().len(),2);
        let first=Transaction::from_hex(bundle["transactions"][0]["rawTransaction"].as_str().unwrap()).unwrap();
        let second=Transaction::from_hex(bundle["transactions"][1]["rawTransaction"].as_str().unwrap()).unwrap();
        assert_eq!(second.inputs[2].previous_output.txid,first.txid());
        assert_eq!(second.inputs[2].previous_output.vout,3);
        let flows=plan["plan"]["payload"]["preview"]["assetFlows"].as_array().unwrap();
        for (index,flow) in flows.iter().filter(|v|v["kind"]=="nft").enumerate(){
            assert_eq!(flow["contractId"],p["request"]["intent"]["transfers"][index]["contractId"]);
            assert_eq!(flow["to"],p["request"]["from"]);
        }
        let mut changed=f.clone();changed["request"]["intent"]["transfers"][1]["to"]=json!("1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP");
        assert_eq!(call(EngineMethod::Finalize,&changed)["ok"],false,"no replacement under the old approval");
        if let Ok(path)=std::env::var("NFT_BATCH_REPORT") {
            let path=format!("{path}-{label}.json");
            std::fs::write(path,serde_json::to_vec(&json!({"input":p,"planned":plan,"finalize":f,"parents":p["snapshot"]["payload"]["parents"],"transactions":bundle["transactions"]})).unwrap()).unwrap();
        }
    }
}

#[test]
fn shared_nft_batch_rejects_duplicates_bad_material_limits_and_changed_plan() {
    let p=batch_transfer_fixture(false);
    let mut duplicate=p.clone();duplicate["request"]["intent"]["transfers"][1]=duplicate["request"]["intent"]["transfers"][0].clone();
    assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":duplicate["request"]}))["ok"],false);
    let mut invalid=p.clone();invalid["request"]["intent"]["transfers"][1]["to"]=json!("invalid");
    assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":invalid["request"]}))["ok"],false);
    for case in 0..5 {
        let mut bad=p.clone();
        match case {
            0=>bad["request"]["constraints"]["maxFee"]=json!("1"),
            1=>bad["policy"]["payload"]["maxBundleTransactions"]=json!(1),
            2=>bad["snapshot"]["payload"]["contracts"][1]["currentOutpoint"]=bad["snapshot"]["payload"]["contracts"][0]["currentOutpoint"].clone(),
            3=>{bad["snapshot"]["payload"]["parents"].as_array_mut().unwrap().pop();},
            _=>bad["request"]["constraints"]["inputOutpoints"]=json!([{"txid":bad["snapshot"]["payload"]["utxos"][0]["txid"],"vout":3}]),
        }
        assert_eq!(call(EngineMethod::Plan,&bind(bad))["ok"],false,"negative {case}");
    }
    let plan=ok(EngineMethod::Plan,&p);let mut forged=plan["plan"].clone();
    forged["payload"]["transactions"][1]["dependsOn"]=json!([]);
    forged["planHash"]=json!(hash(&forged["payload"]));
    let mut check=p;check["plan"]=forged;check["phase"]=json!("plan");
    assert_eq!(ok(EngineMethod::Validate,&check)["valid"],false);
}

#[test]
fn shared_nft_batch_funds_fragmented_fees_without_duplicate_inputs_or_policy_bypass() {
    use tbc_sdk::{Address, OutPoint, TxIn, TxOut};
    for historical in [false,true] {
        let mut p=batch_transfer_fixture(historical);
        let from=p["request"]["from"].as_str().unwrap().to_owned();
        let owner=Address::from_string(&from).unwrap();
        let mut funding=Transaction{version:10,inputs:vec![TxIn::new(OutPoint{txid:"33".repeat(32).parse().unwrap(),vout:0})],
            outputs:vec![TxOut{satoshis:if historical{40}else{4000},script_pubkey:owner.script_pubkey()};20],lock_time:0};
        // No single input can cover the attached payment; current NFT should
        // use direct multi-input construction, not a maintenance transaction.
        if !historical {
            for item in p["request"]["intent"]["transfers"].as_array_mut().unwrap() {
                item["payment"]=json!({"to":from,"amount":"10000"});
            }
        } else { funding.outputs.resize(80,funding.outputs[0].clone()); }
        p["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().retain(|u|u["classification"]!="native");
        for index in 0..funding.outputs.len(){
            p["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().push(utxo(&funding,index,"native",None));
        }
        p["snapshot"]["payload"]["parents"].as_array_mut().unwrap().push(json!({"txid":funding.txid().to_string(),"rawTransaction":funding.to_hex()}));
        p["request"]["constraints"]["maxFee"]=json!("50000");
        let p=bind(p);
        let (plan,bundle,f)=complete_batch_fixture(&p);
        if !historical { assert_eq!(plan["plan"]["payload"]["transactions"].as_array().unwrap().len(),2); }
        else { assert!(plan["plan"]["payload"]["transactions"].as_array().unwrap().iter().any(|tx|tx["role"]=="maintenance")); }
        let mut seen=std::collections::BTreeSet::new();
        for tx in bundle["transactions"].as_array().unwrap(){
            let tx=Transaction::from_hex(tx["rawTransaction"].as_str().unwrap()).unwrap();
            for input in tx.inputs {assert!(seen.insert((input.previous_output.txid.to_string(),input.previous_output.vout)));}
        }
        if let Ok(path)=std::env::var("NFT_BATCH_REPORT") {
            let path=format!("{path}-funding-{}.json",if historical{"mixed"}else{"current"});
            std::fs::write(path,serde_json::to_vec(&json!({"input":p,"planned":plan,"finalize":f,"parents":p["snapshot"]["payload"]["parents"],"transactions":bundle["transactions"]})).unwrap()).unwrap();
        }
    }
    let mut denied=batch_transfer_fixture(true);
    denied["policy"]["payload"]["contractPolicies"]=json!([{"family":"nft","allowedVersions":["tbc721"]}]);
    assert_eq!(call(EngineMethod::Plan,&bind(denied))["ok"],false,"historical child cannot bypass family policy");
    let mut payment=batch_transfer_fixture(false);
    let from=payment["request"]["from"].clone();
    for item in payment["request"]["intent"]["transfers"].as_array_mut().unwrap() {
        item["payment"]=json!({"to":from,"amount":"60"});
    }
    payment["policy"]["payload"]["amountLimits"]=json!([{"scope":"native","maximum":"100"}]);
    assert_eq!(call(EngineMethod::Plan,&bind(payment))["ok"],false,"batch payments must obey aggregate policy");
}

#[test]
fn public_nft_hundred_item_construction_preserves_one_binding_and_signed_change() {
    use tbc_sdk::{Address, OutPoint, TxIn, TxOut};
    let mut create=input("tbc721-standard-create-collection");
    let from=create["request"]["from"].as_str().unwrap().to_owned();
    let funding=Transaction {version:10,inputs:vec![TxIn::new(OutPoint{txid:"66".repeat(32).parse().unwrap(),vout:0})],
        outputs:vec![TxOut{satoshis:2_000_000,script_pubkey:Address::from_string(&from).unwrap().script_pubkey()}],lock_time:0};
    // The remaining slots also feed the independent whole-job source check;
    // this Engine construction still signs exactly the first 100 items.
    create["request"]["intent"]["supply"]=json!("250");
    create["snapshot"]["payload"]["utxos"]=json!([utxo(&funding,0,"native",None)]);
    create["snapshot"]["payload"]["parents"]=json!([{"txid":funding.txid().to_string(),"rawTransaction":funding.to_hex()}]);
    let (_,created,_)=complete_batch_fixture(&bind(create));
    let collection=Transaction::from_hex(created["transactions"][0]["rawTransaction"].as_str().unwrap()).unwrap();
    let id=collection.txid().to_string();
    let mut p=input("tbc721-standard-batch-mint");
    p["request"]["intent"]["collectionId"]=json!(id);
    let item=p["request"]["intent"]["items"][0].clone();
    p["request"]["intent"]["items"]=json!((1..=100).map(|slot|{let mut v=item.clone();v["slot"]=json!(slot);v}).collect::<Vec<_>>());
    p["request"]["constraints"]["maxFee"]=json!("50000");
    p["policy"]["payload"]["maxBundleTransactions"]=json!(100);
    let mut inputs=(1..=100).map(|vout|utxo(&collection,vout,"collection-slot",Some(&id))).collect::<Vec<_>>();
    inputs.push(utxo(&collection,251,"native",None));
    p["snapshot"]["payload"]["utxos"]=json!(inputs);
    p["snapshot"]["payload"]["parents"]=json!([{"txid":id,"rawTransaction":collection.to_hex()}]);
    let record=&mut p["snapshot"]["payload"]["contracts"][0];
    for field in ["contractId","creationTxid"]{record[field]=json!(id);}
    record["genesisOutpoint"]["txid"]=json!(id);record["currentOutpoint"]["txid"]=json!(id);
    let p=bind(p);
    let (plan,bundle,f)=complete_batch_fixture(&p);
    assert_eq!(plan["plan"]["payload"]["transactions"].as_array().unwrap().len(),100);
    let txs=bundle["transactions"].as_array().unwrap();assert_eq!(txs.len(),100);
    for index in 1..100 {
        let tx=Transaction::from_hex(txs[index]["rawTransaction"].as_str().unwrap()).unwrap();
        assert_eq!(tx.inputs[1].previous_output.txid.to_string(),txs[index-1]["txid"].as_str().unwrap());
        assert_eq!(tx.inputs[1].previous_output.vout,3);
    }
    let mut too_many=p.clone();let mut item=item.clone();item["slot"]=json!(101);
    too_many["request"]["intent"]["items"].as_array_mut().unwrap().push(item);
    assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":too_many["request"]}))["ok"],false);
    if let Ok(path)=std::env::var("NFT_MINT_BATCH_REPORT") {
        std::fs::write(path,serde_json::to_vec(&json!({"input":p,"planned":plan,"finalize":f,"parents":p["snapshot"]["payload"]["parents"],"transactions":bundle["transactions"]})).unwrap()).unwrap();
    }
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

#[test]
fn inline_media_wire_limit_counts_stored_base64_not_decoded_bytes() {
    for size in [1_048_576,1_048_580] {
        for kind in ["tbc721-standard-create-collection","tbc721-standard-mint","tbc721-standard-batch-mint"] {
            let mut p=input(kind);
            let media=json!({"kind":"base64","mediaType":"image/png","data":"A".repeat(size),"sha256":"00".repeat(32)});
            if kind.ends_with("batch-mint") {p["request"]["intent"]["items"][0]["media"]=media;}
            else {p["request"]["intent"]["media"]=media;}
            let result=call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":p["request"]}));
            assert_eq!(result["ok"],size==1_048_576,"{kind} size {size}");
        }
    }
}
