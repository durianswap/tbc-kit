use serde_json::{json,Value};
#[path = "support/unified_business.rs"]
mod unified_business;

#[test]
fn unified_current_ft_signing_matches_concrete() {
    unified_business::exercise(input("tbc20-standard-transfer"), "tbc20.transfer");
    unified_business::exercise(input("tbc20-standard-merge"), "tbc20.merge");
}
use sha2::{Digest,Sha256};
use secp256k1::{Message,Secp256k1,SecretKey};
use tbc_engine_core::{EngineMethod,call_json};
use tbc_sdk::{Transaction,OutPoint,PublicKey};
use tbc_engine_core::{protocols::{
    tbc20_material::{inspect_parent,link_ancestors},
    tbc20_transfer::{FeeInput,Receiver,TokenInput,TransferOptions,build_transfer_plan},
},signing::{ExternalSignature,StageOutcome,begin_signing,finalize_signing_stage}};

fn base()->Value {serde_json::from_str(include_str!("../../../fixtures/tbc-transfer.json")).unwrap()}
fn oracle()->Value {serde_json::from_str(include_str!("../../../fixtures/tbc20-standard-transfer.json")).unwrap()}
fn hex(bytes:&[u8])->String {bytes.iter().map(|v|format!("{v:02x}")).collect()}
fn bytes(value:&str)->Vec<u8> {(0..value.len()).step_by(2).map(|i|u8::from_str_radix(&value[i..i+2],16).unwrap()).collect()}
fn hash(value:&Value)->String {hex(&Sha256::digest(serde_json::to_vec(value).unwrap()))}
fn call(method:EngineMethod,input:&Value)->Value {serde_json::from_str(&call_json(method,&input.to_string())).unwrap()}
fn ok(method:EngineMethod,input:&Value)->Value {
    let r=call(method,input);assert_eq!(r["ok"],true,"{r}");
    if std::env::var("TBC20_DUMP_WIRE").as_deref()==Ok("1") {
        let (params,result)=match method {
            EngineMethod::NormalizeRequest=>("normalizeRequestParams","normalizeRequestResult"),
            EngineMethod::Plan=>("planParams","planResult"),
            EngineMethod::Validate=>("validateParams","validationResult"),
            EngineMethod::Finalize=>("finalizeParams","finalizeResult"),
        };
        println!("TBC20_WIRE:{}",json!({"definition":params,"value":input}));
        println!("TBC20_WIRE:{}",json!({"definition":result,"value":r["result"]}));
    }
    r["result"].clone()
}
fn bind(mut p:Value)->Value {
    let n=ok(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":p["request"]}));
    p["request"]=n["request"].clone();p["requestHash"]=n["requestHash"].clone();
    p["snapshot"]["snapshotHash"]=json!(hash(&p["snapshot"]["payload"]));
    p["policy"]["policyHash"]=json!(hash(&p["policy"]["payload"]));p
}
fn input(kind:&str)->Value {
    let mut p=base()["planInput"].clone();
    p["policy"]["payload"]["dustThreshold"]=json!("42");
    p["policy"]["payload"]["minConfirmations"]=json!("0");
    p["request"]["constraints"]["maxFee"]=json!("5000");
    p["request"]["intent"]=json!({"type":kind,"version":"1.0"});
    if kind=="tbc20-standard-create" {
        p["request"]["intent"]=json!({"type":kind,"version":"1.0","name":"Token","symbol":"TBCX","decimals":6,"initialSupply":"123456"});
    } else {
        let f=oracle();let stage_index=if kind=="tbc20-standard-transfer" {1}else{2};
        let stage=&f["stages"][stage_index];let tx=Transaction::from_hex(stage["signedRaw"].as_str().unwrap()).unwrap();
        let contract=f["stages"][1]["txid"].as_str().unwrap();
        let vouts=if stage_index==1 {vec![0]}else{vec![0,2]};
        let mut utxos:Vec<_>=vouts.into_iter().map(|vout|json!({"txid":stage["txid"],"vout":vout,"satoshis":"500",
            "scriptPubKey":hex(tx.outputs[vout].script_pubkey.as_bytes()),"confirmations":"0","classification":"ft","contractId":contract})).collect();
        let fee_vout=if stage_index==1 {2}else{4};
        utxos.push(json!({"txid":stage["txid"],"vout":fee_vout,"satoshis":tx.outputs[fee_vout].satoshis.to_string(),
            "scriptPubKey":hex(tx.outputs[fee_vout].script_pubkey.as_bytes()),"confirmations":"0","classification":"native"}));
        p["snapshot"]["payload"]["utxos"]=json!(utxos);
        p["snapshot"]["payload"]["parents"]=json!((0..=stage_index).map(|i|json!({"txid":f["stages"][i]["txid"],"rawTransaction":f["stages"][i]["signedRaw"]})).collect::<Vec<_>>());
        p["snapshot"]["payload"]["contracts"]=json!([{"contractId":contract,"family":"ft","protocolVersion":"tbc20",
            "standardId":"tbc20-standard","templateRevision":"0f5db33bb46e4517963cbd383518f74283b5c2c4efb0a733522a1fbc0d4a9f84",
            "creationTxid":contract,"genesisOutpoint":{"txid":contract,"vout":0},"currentOutpoint":{"txid":stage["txid"],"vout":0}}]);
        p["request"]["intent"]["contractId"]=json!(contract);
        if kind=="tbc20-standard-transfer" {
            p["request"]["intent"]["amount"]=json!("40000");p["request"]["intent"]["to"]=p["request"]["from"].clone();
        }
    }
    bind(p)
}
fn sign(tasks:&Value)->Value {
    // Public synthetic scalar 1, only fabricated offline funding. No wallet keys.
    let mut scalar=[0;32];scalar[31]=1;
    let key=SecretKey::from_byte_array(scalar).unwrap();let secp=Secp256k1::new();
    json!(tasks.as_array().unwrap().iter().map(|task| {
        let digest:[u8;32]=bytes(task["digest"].as_str().unwrap()).try_into().unwrap();
        json!({"taskId":task["taskId"],"signatureEncoding":"compact64",
            "signature":hex(&secp.sign_ecdsa(Message::from_digest(digest),&key).serialize_compact())})
    }).collect::<Vec<_>>())
}

#[test]
fn trusted_index_ft_uses_only_direct_proofs_with_identical_signed_transactions() {
    let f=oracle();let genesis=Transaction::from_hex(f["stages"][1]["signedRaw"].as_str().unwrap()).unwrap();
    for kind in ["tbc20-standard-transfer","tbc20-standard-merge"] {
        let original=input(kind);let mut indexed=original.clone();
        let p=&mut indexed["snapshot"]["payload"];
        p.as_object_mut().unwrap().remove("block");
        p["contracts"][0]["indexedFungible"]=json!({"codeScript":hex(genesis.outputs[0].script_pubkey.as_bytes()),
            "tapeScript":hex(genesis.outputs[1].script_pubkey.as_bytes()),"totalSupply":"123456"});
        if kind.ends_with("merge") {p["parents"].as_array_mut().unwrap().retain(|p|p["txid"]!=f["stages"][0]["txid"]);}
        let indexed=bind(indexed);let before=ok(EngineMethod::Plan,&original);let after=ok(EngineMethod::Plan,&indexed);
        for field in ["transactions","signingTasks","preview"]{assert_eq!(before["plan"]["payload"][field],after["plan"]["payload"][field]);}
        let a=ok(EngineMethod::Finalize,&approved(&original,&before));let b=ok(EngineMethod::Finalize,&approved(&indexed,&after));
        assert_eq!(a["bundle"]["transactions"],b["bundle"]["transactions"]);
        let mut bad=indexed.clone();bad["snapshot"]["payload"]["contracts"][0]["indexedFungible"]["totalSupply"]=json!("1");
        assert_eq!(call(EngineMethod::Plan,&bind(bad))["ok"],false);
        let mut bad=indexed.clone();bad["snapshot"]["payload"]["parents"]=json!([]);
        assert_eq!(call(EngineMethod::Plan,&bind(bad))["ok"],false);
    }
}
fn approved(input:&Value,planned:&Value)->Value {
    let mut binding=base()["finalizeInput"]["binding"].clone();
    binding["payload"]["requestHash"]=input["requestHash"].clone();
    binding["payload"]["operationHash"]=planned["plan"]["planHash"].clone();
    binding["payload"]["expiresAt"]=planned["plan"]["payload"]["expiresAt"].clone();
    binding["bindingHash"]=json!(hash(&binding["payload"]));
    let mut approval=base()["finalizeInput"]["approval"].clone();
    approval["bindingHash"]=binding["bindingHash"].clone();approval["expiresAt"]=planned["plan"]["payload"]["expiresAt"].clone();
    let mut value=input.clone();value["plan"]=planned["plan"].clone();value["binding"]=binding;value["approval"]=approval;
    value["signatures"]=sign(&planned["plan"]["payload"]["signingTasks"]);value
}

#[test]
fn sdk_gap_tbc20_native_payment_is_bound_and_accounted_once() {
    let mut p=input("tbc20-standard-transfer");
    let payee="1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";
    p["request"]["intent"]["payment"]=json!({"to":payee,"amount":"42"});
    let p=bind(p); let planned=ok(EngineMethod::Plan,&p);
    let finalize=approved(&p,&planned);let finalized=ok(EngineMethod::Finalize,&finalize);
    let tx=Transaction::from_hex(finalized["bundle"]["transactions"][0]["rawTransaction"].as_str().unwrap()).unwrap();
    let script=tbc_sdk::Address::from_string(payee).unwrap().script_pubkey();
    assert_eq!(tx.outputs.iter().filter(|output|output.script_pubkey==script&&output.satoshis==42).count(),1);
    assert!(planned["plan"]["payload"]["preview"]["assetFlows"].as_array().unwrap().iter().any(|flow|flow["kind"]=="native"&&flow["to"]==payee&&flow["amount"]=="42"));
    for phase in ["finalized", "pre-broadcast"] {
        assert_eq!(check_phase(phase,&finalize,Some(&finalized["bundle"]))["valid"],true);
    }
    for amount in ["0","41","9007199254740992"] {
        let mut bad=p.clone();bad["request"]["intent"]["payment"]["amount"]=json!(amount);
        assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":bad["request"]}))["ok"],false);
    }
    let mut changed=finalize.clone();changed["request"]["intent"]["payment"]["to"]=p["request"]["from"].clone();
    changed["requestHash"]=json!(hash(&changed["request"]));assert_eq!(call(EngineMethod::Finalize,&changed)["ok"],false);
    unified_business::exercise(p.clone(),"tbc20.transfer");
    if std::env::var("TBC_SDK_GAP_DUMP").as_deref()==Ok("1") {
        println!("SDK_GAP_VECTOR:{}",json!({"case":"tbc20-native-payment","input":p,"planned":planned,"finalizeInput":finalize,"finalized":finalized}));
    }
}
fn check_phase(phase:&str,finalize:&Value,bundle:Option<&Value>)->Value {
    let mut v=finalize.clone();v["phase"]=json!(phase);
    if phase=="pre-sign" {v.as_object_mut().unwrap().remove("signatures");}
    if phase=="plan" {v.as_object_mut().unwrap().remove("binding");v.as_object_mut().unwrap().remove("approval");v.as_object_mut().unwrap().remove("signatures");}
    if let Some(bundle)=bundle {v["bundle"]=bundle.clone();}
    ok(EngineMethod::Validate,&v)
}

// Produce an honestly signed synthetic split through the keyless new-contract
// builder, rather than editing an old FT script or pretending indexed balances.
fn fragmented_input(kind:&str,count:usize)->Value {
    let f=oracle();let raw=bytes(f["stages"][1]["signedRaw"].as_str().unwrap());
    let tx=Transaction::from_bytes(&raw).unwrap();
    let public=PublicKey::from_slice(&bytes(f["request"]["publicKeyHex"].as_str().unwrap())).unwrap();
    let mut owner=[0;21];owner[..20].copy_from_slice(&public.hash160());
    let parent=inspect_parent(&raw,&OutPoint{txid:tx.txid(),vout:0},None).unwrap();
    let source=bytes(f["stages"][0]["signedRaw"].as_str().unwrap());
    let ancestors=link_ancestors(&parent,&[&source]).unwrap();
    let tokens=[TokenInput{parent:&parent,ancestors:&ancestors,public_key:&public}];
    let fees=[FeeInput{outpoint:OutPoint{txid:tx.txid(),vout:2},output:&tx.outputs[2],public_key:&public}];
    let mut receivers=vec![Receiver{controller:owner,amount:123456/count as u128};count];
    receivers[count-1].amount+=123456%count as u128;
    let built=build_transfer_plan(TransferOptions{payment:None,inputs:&tokens,fee_inputs:&fees,receivers:&receivers,
        expected_identity:parent.identity(),token_change_controller:owner,native_change_hash:public.hash160(),max_fee:5000}).unwrap();
    let stage=begin_signing(&built.unsigned_plan).unwrap();
    let mut scalar=[0;32];scalar[31]=1;let key=SecretKey::from_byte_array(scalar).unwrap();
    let signatures:Vec<_>=stage.signing_requests.iter().map(|r|ExternalSignature{
        session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),
        transaction_id:r.transaction_id.clone(),input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),
        signature:hex(&Secp256k1::new().sign_ecdsa(Message::from_digest(bytes(&r.digest).try_into().unwrap()),&key).serialize_der()),
    }).collect();
    let StageOutcome::Complete(bundle)=finalize_signing_stage(&built.unsigned_plan,stage,&signatures).unwrap() else {panic!("split is one stage")};
    let split=Transaction::from_hex(&bundle.transactions[0].raw_transaction).unwrap();let id=split.txid().to_string();
    let mut p=input(kind);let contract=f["stages"][1]["txid"].clone();
    p["snapshot"]["payload"]["parents"].as_array_mut().unwrap().retain(|r|r["txid"]!=f["stages"][2]["txid"]);
    p["snapshot"]["payload"]["parents"].as_array_mut().unwrap().push(json!({"txid":id,"rawTransaction":split.to_hex()}));
    p["snapshot"]["payload"]["utxos"]=json!((0..count).map(|i|json!({"txid":id,"vout":2*i,"satoshis":"500",
        "scriptPubKey":hex(split.outputs[2*i].script_pubkey.as_bytes()),"confirmations":"0","classification":"ft","contractId":contract})).collect::<Vec<_>>());
    p["snapshot"]["payload"]["contracts"][0]["currentOutpoint"]=json!({"txid":id,"vout":0});
    if kind=="tbc20-standard-transfer" {p["request"]["intent"]["amount"]=json!("123456");}
    bind(p)
}

fn specify_all(p:&mut Value) {
    p["request"]["constraints"]["inputOutpoints"]=json!(p["snapshot"]["payload"]["utxos"].as_array().unwrap().iter()
        .map(|u|json!({"txid":u["txid"],"vout":u["vout"]})).collect::<Vec<_>>());
}

fn fragmented_funded_input(kind:&str,count:usize)->Value {
    let mut p=fragmented_input(kind,count);
    let parent=p["snapshot"]["payload"]["parents"].as_array().unwrap().last().unwrap();
    let tx=Transaction::from_hex(parent["rawTransaction"].as_str().unwrap()).unwrap();
    let vout=tx.outputs.len()-1;let output=&tx.outputs[vout];
    p["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().push(json!({
        "txid":tx.txid().to_string(),"vout":vout,"satoshis":output.satoshis.to_string(),
        "scriptPubKey":hex(output.script_pubkey.as_bytes()),"confirmations":"0","classification":"native"}));
    specify_all(&mut p);bind(p)
}

const FIRST_RECIPIENT: &str = "1FMZk84eVEJ1QHas3Gke1U9ZPMKrPk36ex";
const SECOND_RECIPIENT: &str = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
fn with_receivers(mut p:Value, receivers:Value)->Value {
    p["request"]["intent"].as_object_mut().unwrap().remove("to");
    p["request"]["intent"].as_object_mut().unwrap().remove("amount");
    p["request"]["intent"]["receivers"]=receivers;
    bind(p)
}

#[test]
fn tbc20_public_multi_recipient_binds_each_flow_and_final_output() {
    use tbc_engine_core::protocols::tbc20::{parse_code,parse_tape};
    let p=with_receivers(input("tbc20-standard-transfer"),json!([
        {"to":FIRST_RECIPIENT,"amount":"40000"},{"to":SECOND_RECIPIENT,"amount":"10000"}
    ]));
    let plan=ok(EngineMethod::Plan,&p);
    let all_flows=plan["plan"]["payload"]["preview"]["assetFlows"].as_array().unwrap();
    assert_eq!(all_flows.len(),3);
    assert_eq!(all_flows[2]["direction"],"fee");assert_eq!(all_flows[2]["kind"],"native");
    let flows:Vec<_>=all_flows.iter().filter(|flow|flow["direction"]=="send").collect();
    assert_eq!(flows.len(),2);
    for (flow,(to,amount)) in flows.iter().zip([(FIRST_RECIPIENT,"40000"),(SECOND_RECIPIENT,"10000")]) {
        assert_eq!(flow["to"],to);assert_eq!(flow["amount"],amount);assert_eq!(flow["direction"],"send");
    }
    let finalize=approved(&p,&plan);
    let result=ok(EngineMethod::Finalize,&finalize);
    let tx=Transaction::from_hex(result["bundle"]["transactions"][0]["rawTransaction"].as_str().unwrap()).unwrap();
    for (vout,to,amount) in [(0,FIRST_RECIPIENT,40000),(2,SECOND_RECIPIENT,10000),(4,p["request"]["from"].as_str().unwrap(),73456)] {
        let code=parse_code(tx.outputs[vout].script_pubkey.as_bytes()).unwrap();
        let address=tbc_sdk::Address::from_string(to).unwrap();
        assert_eq!(&code.controller[..20],&address.hash160());assert_eq!(code.controller[20],0);
        assert_eq!(parse_tape(tx.outputs[vout+1].script_pubkey.as_bytes()).unwrap().balance,amount);
    }
    assert_eq!(check_phase("pre-broadcast",&finalize,Some(&result["bundle"]))["valid"],true);
    // A request edit is never permission to reuse an earlier approval/plan.
    let mut tampered=finalize;
    tampered["request"]["intent"]["receivers"][1]["to"]=json!(FIRST_RECIPIENT);
    tampered["requestHash"]=json!(hash(&tampered["request"]));
    assert_eq!(call(EngineMethod::Finalize,&tampered)["ok"],false);
}

#[test]
fn tbc20_public_receiver_shapes_limits_and_old_single_bytes() {
    let single=input("tbc20-standard-transfer");
    let list=with_receivers(single.clone(),json!([{"to":single["request"]["intent"]["to"],"amount":"40000"}]));
    let a=ok(EngineMethod::Plan,&single);let b=ok(EngineMethod::Plan,&list);
    let signed_a=ok(EngineMethod::Finalize,&approved(&single,&a));
    let signed_b=ok(EngineMethod::Finalize,&approved(&list,&b));
    assert_eq!(signed_a["bundle"]["transactions"][0]["rawTransaction"],signed_b["bundle"]["transactions"][0]["rawTransaction"]);
    assert_eq!(a["plan"]["payload"]["preview"],b["plan"]["payload"]["preview"]);
    let owner=single["request"]["from"].clone();
    for receivers in [json!([]),json!([{"to":owner,"amount":"0"}]),json!([{"to":owner,"amount":"01"}]),
        json!([{"to":"invalid","amount":"1"}]),json!([{"to":owner,"amount":"340282366920938463463374607431768211456"}]),
        json!([{"to":owner,"amount":"332041393326771929052"},{"to":owner,"amount":"1"}]),
        json!((0..9).map(|_|json!({"to":owner,"amount":"1"})).collect::<Vec<_>>())] {
        let mut bad=single["request"].clone();bad["intent"].as_object_mut().unwrap().remove("to");bad["intent"].as_object_mut().unwrap().remove("amount");
        bad["intent"]["receivers"]=receivers;
        assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":bad}))["ok"],false);
    }
    let mut mixed=single["request"].clone();mixed["intent"]["receivers"]=json!([{"to":owner,"amount":"1"}]);
    assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":mixed}))["ok"],false);
    for kind in ["tbc20-standard-create","tbc20-standard-merge","tbc.transfer"] {
        let mut bad=if kind=="tbc.transfer" {base()["planInput"]["request"].clone()}else{input(kind)["request"].clone()};
        bad["intent"]["receivers"]=json!([{"to":owner,"amount":"1"}]);
        assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":bad}))["ok"],false);
    }
    // Eight list entries pass the material bound but cannot also fit both
    // Token and non-dust native change. Do not silently drop/burn change.
    let full=with_receivers(single,json!((0..8).map(|_|json!({"to":owner,"amount":"1"})).collect::<Vec<_>>()));
    assert_eq!(call(EngineMethod::Plan,&full)["ok"],false);
}

#[test]
fn tbc20_public_six_token_inputs_can_pay_fee_without_native_input() {
    for kind in ["tbc20-standard-transfer","tbc20-standard-merge"] {
        let mut p=fragmented_input(kind,6);specify_all(&mut p);let p=bind(p);
        let plan=ok(EngineMethod::Plan,&p);let finalize=approved(&p,&plan);
        let result=ok(EngineMethod::Finalize,&finalize);
        let tx=Transaction::from_hex(result["bundle"]["transactions"][0]["rawTransaction"].as_str().unwrap()).unwrap();
        assert_eq!(tx.inputs.len(),6);assert!(check_phase("pre-broadcast",&finalize,Some(&result["bundle"]))["valid"]==true);
    }
}

#[test]
fn tbc20_public_uses_multiple_native_fees_only_when_needed_and_honors_exact_set() {
    let mut p=input("tbc20-standard-transfer");
    let original=ok(EngineMethod::Plan,&p);
    let fee=original["plan"]["payload"]["preview"]["totalFee"].as_str().unwrap().parse::<u64>().unwrap();
    let mut native=p["snapshot"]["payload"]["utxos"][1].clone();
    p["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().pop();
    for byte in ["22","33"] {
        native["txid"]=json!(byte.repeat(32));native["vout"]=json!(0);
        native["satoshis"]=json!(((500+fee)/2+100).to_string());
        p["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().push(native.clone());
    }
    for explicit in [false,true] {
        let mut selected=p.clone();if explicit {specify_all(&mut selected);}
        let selected=bind(selected);let plan=ok(EngineMethod::Plan,&selected);
        let finalize=approved(&selected,&plan);let result=ok(EngineMethod::Finalize,&finalize);
        let tx=Transaction::from_hex(result["bundle"]["transactions"][0]["rawTransaction"].as_str().unwrap()).unwrap();assert_eq!(tx.inputs.len(),3);
        let mut capped=selected.clone();let fee=plan["plan"]["payload"]["preview"]["totalFee"].as_str().unwrap().parse::<u64>().unwrap();
        capped["request"]["constraints"]["maxFee"]=json!((fee-1).to_string());
        assert_eq!(call(EngineMethod::Plan,&bind(capped))["error"]["code"],"FEE_CAP_EXCEEDED");
    }
    let mut roomy=p.clone();
    for u in &mut roomy["snapshot"]["payload"]["utxos"].as_array_mut().unwrap()[1..] {u["satoshis"]=json!("5000");}
    specify_all(&mut roomy);let roomy=bind(roomy);let planned=ok(EngineMethod::Plan,&roomy);
    let result=ok(EngineMethod::Finalize,&approved(&roomy,&planned));
    assert_eq!(Transaction::from_hex(result["bundle"]["transactions"][0]["rawTransaction"].as_str().unwrap()).unwrap().inputs.len(),3,
        "exact selection must include both native inputs even if one could pay");
    let mut unconfirmed=roomy.clone();unconfirmed["policy"]["payload"]["minConfirmations"]=json!("1");
    for u in unconfirmed["snapshot"]["payload"]["utxos"].as_array_mut().unwrap() {u["confirmations"]=json!("1");}
    unconfirmed["snapshot"]["payload"]["utxos"][2]["confirmations"]=json!("0");
    assert_eq!(call(EngineMethod::Plan,&bind(unconfirmed))["ok"],false,"specified fee cannot bypass confirmation policy");
    let mut wrong_owner=roomy.clone();wrong_owner["snapshot"]["payload"]["utxos"][2]["scriptPubKey"]=json!(format!("76a914{}88ac","00".repeat(20)));
    assert_eq!(call(EngineMethod::Plan,&bind(wrong_owner))["ok"],false,"specified fee cannot bypass ownership");
    specify_all(&mut p);p["request"]["constraints"]["inputOutpoints"].as_array_mut().unwrap().push(json!({"txid":"44".repeat(32),"vout":0}));
    assert_eq!(call(EngineMethod::Plan,&bind(p))["ok"],false);
}

#[test]
fn tbc20_public_keeps_successful_single_fee_transaction_unchanged() {
    let p=input("tbc20-standard-transfer");let planned=ok(EngineMethod::Plan,&p);
    let original=ok(EngineMethod::Finalize,&approved(&p,&planned));
    let mut extra=p.clone();let mut tiny=extra["snapshot"]["payload"]["utxos"][1].clone();
    tiny["txid"]=json!("22".repeat(32));tiny["vout"]=json!(0);tiny["satoshis"]=json!("100");
    extra["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().push(tiny);
    let extra=bind(extra);let planned=ok(EngineMethod::Plan,&extra);
    let with_extra=ok(EngineMethod::Finalize,&approved(&extra,&planned));
    assert_eq!(original["bundle"]["transactions"][0]["rawTransaction"],with_extra["bundle"]["transactions"][0]["rawTransaction"]);
}

#[test]
fn tbc20_public_bounds_each_transaction_and_total_maintenance() {
    let p=fragmented_funded_input("tbc20-standard-merge",7);
    let plan=ok(EngineMethod::Plan,&p);
    assert_eq!(plan["plan"]["payload"]["transactions"].as_array().unwrap().len(),2);
    for tx in plan["plan"]["payload"]["transactions"].as_array().unwrap() {
        assert!(Transaction::from_hex(tx["unsignedTransaction"].as_str().unwrap()).unwrap().inputs.len()<=6);
    }
    let mut bounded=p.clone();bounded["policy"]["payload"]["maxBundleTransactions"]=json!(1);
    assert_eq!(call(EngineMethod::Plan,&bind(bounded))["ok"],false);
    let total=plan["plan"]["payload"]["preview"]["totalFee"].as_str().unwrap().parse::<u64>().unwrap();
    let mut capped=p;capped["request"]["constraints"]["maxFee"]=json!((total-1).to_string());
    assert_eq!(call(EngineMethod::Plan,&bind(capped))["ok"],false);
}

#[test]
fn tbc20_public_create_transfer_merge_all_four_validation_phases() {
    let mut cases:Vec<_>=["tbc20-standard-create","tbc20-standard-transfer","tbc20-standard-merge"].iter()
        .map(|kind|(*kind,input(kind),if *kind=="tbc20-standard-create" {2}else{1})).collect();
    for kind in ["tbc20-standard-transfer","tbc20-standard-merge"] {
        cases.push((kind,fragmented_funded_input(kind,7),2));
    }
    cases.push(("multi-recipient",with_receivers(input("tbc20-standard-transfer"),json!([
        {"to":FIRST_RECIPIENT,"amount":"40000"},{"to":SECOND_RECIPIENT,"amount":"10000"}])),1));
    cases.push(("multi-recipient-maintenance",with_receivers(fragmented_funded_input("tbc20-standard-transfer",7),json!([
        {"to":FIRST_RECIPIENT,"amount":"50000"},{"to":SECOND_RECIPIENT,"amount":"73456"}])),2));
    for (kind,input,expected_rounds) in cases {
        if expected_rounds==2 && kind!="tbc20-standard-create" && std::env::var("TBC20_DUMP_MATERIAL").as_deref()==Ok("1") {
            println!("TBC20_MATERIAL:{}",json!({"label":kind,"planInput":input}));
        }
        let planned=ok(EngineMethod::Plan,&input);let mut finalize=approved(&input,&planned);
        for tx in planned["plan"]["payload"]["transactions"].as_array().unwrap() {
            assert!(matches!(tx["role"].as_str(),Some("primary"|"prerequisite"|"maintenance")));
        }
        for phase in ["plan","pre-sign"] {let v=check_phase(phase,&finalize,None);assert_eq!(v["valid"],true,"{kind}/{phase}: {v}");}
        let mut result=ok(EngineMethod::Finalize,&finalize);let mut rounds=1;
        while result.get("continuation").is_some() {
            finalize["continuation"]=result["continuation"].clone();finalize["signatures"]=sign(&result["signingRequests"]);
            result=ok(EngineMethod::Finalize,&finalize);rounds+=1;assert!(rounds<=2);
        }
        assert_eq!(rounds,expected_rounds);
        for phase in ["finalized","pre-broadcast"] {let v=check_phase(phase,&finalize,Some(&result["bundle"]));assert_eq!(v["valid"],true,"{kind}/{phase}: {v}");}
        assert!(result["bundle"].is_object());
        let mut tampered=finalize.clone();tampered["approval"]["bindingHash"]=json!("00".repeat(32));
        assert_eq!(call(EngineMethod::Finalize,&tampered)["ok"],false);
    }
}

#[test]
fn tbc20_public_rejects_false_standard_anchor_amount_parent_and_policy() {
    for mutation in 0..7 {
        let mut p=input("tbc20-standard-transfer");
        match mutation {
            0=>p["snapshot"]["payload"]["contracts"][0]["standardId"]=json!("legacy-ft"),
            1=>p["snapshot"]["payload"]["contracts"][0]["templateRevision"]=json!("00".repeat(32)),
            2=>p["snapshot"]["payload"]["contracts"][0]["genesisOutpoint"]["vout"]=json!(2),
            3=>p["snapshot"]["payload"]["utxos"][0]["satoshis"]=json!("501"),
            4=>{p["snapshot"]["payload"]["parents"].as_array_mut().unwrap().remove(0);},
            5=>p["policy"]["payload"]["dustThreshold"]=json!("24"),
            _=>p["request"]["intent"]["amount"]=json!("123457"),
        }
        let p=bind(p);let r=call(EngineMethod::Plan,&p);assert_eq!(r["ok"],false,"mutation{mutation}: {r}");
    }
}

#[test]
fn tbc20_public_rejects_genesis_with_duplicate_identity_supply_pair() {
    let mut p=input("tbc20-standard-transfer");
    let mut genesis=Transaction::from_hex(p["snapshot"]["payload"]["parents"][1]["rawTransaction"].as_str().unwrap()).unwrap();
    genesis.outputs.push(genesis.outputs[0].clone());genesis.outputs.push(genesis.outputs[1].clone());
    let id=genesis.txid().to_string();
    p["request"]["intent"]["contractId"]=json!(id);
    let c=&mut p["snapshot"]["payload"]["contracts"][0];
    c["contractId"]=json!(id);c["creationTxid"]=json!(id);c["genesisOutpoint"]["txid"]=json!(id);c["currentOutpoint"]["txid"]=json!(id);
    for u in p["snapshot"]["payload"]["utxos"].as_array_mut().unwrap() {u["txid"]=json!(id);if u.get("contractId").is_some(){u["contractId"]=json!(id);}}
    p["snapshot"]["payload"]["parents"][1]=json!({"txid":id,"rawTransaction":genesis.to_hex()});
    let p=bind(p);let r=call(EngineMethod::Plan,&p);assert_eq!(r["ok"],false,"{r}");
    assert!(r["error"]["message"].as_str().unwrap().contains("single-supply"));
}

#[test]
fn tbc20_public_requires_nfc_and_rejects_cross_family_or_oversized_metadata() {
    let mut request=input("tbc20-standard-create")["request"].clone();
    request["intent"]["name"]=json!("Cafe\u{301}");
    assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":request}))["ok"],false);
    request["intent"]["name"]=json!("Café");
    let normalized=ok(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":request}));
    assert_eq!(normalized["request"]["intent"]["name"],"Café");
    assert_eq!(normalized["requestHash"],hash(&normalized["request"]));
    for (name,symbol,valid) in [("x".repeat(52),"X",true),("x".repeat(53),"X",false),("中".repeat(17),"XX",true),("中".repeat(18),"X",false)] {
        let mut r=request.clone();r["intent"]["name"]=json!(name);r["intent"]["symbol"]=json!(symbol);
        assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":r}))["ok"],valid);
    }
    for field in ["attachedTbcAmount","poolContractId","collectionId"] {
        let mut r=request.clone();r["intent"][field]=json!(if field=="attachedTbcAmount" {"1".to_owned()}else{"11".repeat(32)});
        assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":r}))["ok"],false);
    }
}

#[test]
fn tbc20_public_enforces_explicit_ft_contract_and_amount_policies() {
    for mutation in 0..6 {
        let mut p=input("tbc20-standard-create");
        p["policy"]["payload"]["contractPolicies"]=json!([{"family":"ft","allowedVersions":["tbc20"],"createVersion":"tbc20"}]);
        match mutation {
            0=>p["policy"]["payload"]["contractPolicies"][0]["allowedVersions"]=json!(["4.0"]),
            1=>p["policy"]["payload"]["contractPolicies"][0]["createVersion"]=json!("4.0"),
            2=>p["policy"]["payload"]["amountLimits"]=json!([{"scope":"ft-total","protocolVersion":"tbc20","maximum":"123455"}]),
            3=>p["policy"]["payload"]["amountLimits"]=json!([{"scope":"ft-slot","maximum":"123455"}]),
            4=>{let duplicate=p["policy"]["payload"]["contractPolicies"][0].clone();p["policy"]["payload"]["contractPolicies"].as_array_mut().unwrap().push(duplicate);},
            _=>p["policy"]["payload"]["amountLimits"]=json!([{"scope":"ft-total","maximum":"123456"},{"scope":"ft-total","maximum":"123457"}]),
        }
        let r=call(EngineMethod::Plan,&bind(p));assert_eq!(r["ok"],false,"mutation{mutation}: {r}");
    }
    let mut p=input("tbc20-standard-create");
    p["policy"]["payload"]["contractPolicies"]=json!([{"family":"ft","allowedVersions":["4.0","tbc20"],"createVersion":"tbc20"}]);
    p["policy"]["payload"]["amountLimits"]=json!([{"scope":"ft-total","protocolVersion":"tbc20","maximum":"123456"},{"scope":"ft-slot","protocolVersion":"4.0","maximum":"1"}]);
    ok(EngineMethod::Plan,&bind(p));
}

#[test]
fn tbc20_public_exact_input_selection_create_transfer_merge() {
    for kind in ["tbc20-standard-create","tbc20-standard-transfer","tbc20-standard-merge"] {
        let mut p=input(kind);
        let points:Vec<_>=p["snapshot"]["payload"]["utxos"].as_array().unwrap().iter()
            .map(|u|json!({"txid":u["txid"],"vout":u["vout"]})).collect();
        p["request"]["constraints"]["inputOutpoints"]=json!(points);
        ok(EngineMethod::Plan,&bind(p.clone()));
        let mut missing=p.clone();
        if points.len()==1 {
            // Empty input selections are rejected at normalization; there is no
            // implicit fallback to auto-selection when an explicit set is empty.
            missing["request"]["constraints"]["inputOutpoints"]=json!([]);
            assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":missing["request"]}))["ok"],false);
        } else {
            missing["request"]["constraints"]["inputOutpoints"].as_array_mut().unwrap().pop();
            // Merge releases one Code output's 500 atomic and this fixture can
            // pay its fee from that value. Transfer still needs native funding.
            assert_eq!(call(EngineMethod::Plan,&bind(missing))["ok"],kind=="tbc20-standard-merge","optional fee input: {kind}");
        }
        p["request"]["constraints"]["inputOutpoints"].as_array_mut().unwrap()
            .push(json!({"txid":"22".repeat(32),"vout":9}));
        assert_eq!(call(EngineMethod::Plan,&bind(p))["ok"],false,"unconsumed extra input: {kind}");
    }
}

#[test]
fn tbc20_public_tries_roomy_funding_after_dust_remainder_exceeds_fee_cap() {
    for kind in ["tbc20-standard-create","tbc20-standard-transfer"] {
        let mut p=input(kind);let good=ok(EngineMethod::Plan,&p);
        let max=good["plan"]["payload"]["preview"]["totalFee"].as_str().unwrap().parse::<u64>().unwrap();
        p["request"]["constraints"]["maxFee"]=json!(max.to_string());
        let mut boundary=p["snapshot"]["payload"]["utxos"].as_array().unwrap().iter()
            .find(|u|u["classification"]=="native").unwrap().clone();
        boundary["txid"]=json!("22".repeat(32));boundary["vout"]=json!(0);
        // Code output net cost 500, pinned fee, plus 41 atomic that cannot be
        // returned as change. This burns >max while the roomy UTXO does not.
        boundary["satoshis"]=json!((500+max+41).to_string());
        p["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().push(boundary.clone());
        let result=ok(EngineMethod::Plan,&bind(p.clone()));
        assert_eq!(result["plan"]["payload"]["preview"]["totalFee"],max.to_string());
        p["snapshot"]["payload"]["utxos"].as_array_mut().unwrap()
            .retain(|u|u["classification"]!="native" || u["txid"]==boundary["txid"]);
        let rejected=call(EngineMethod::Plan,&bind(p));
        assert_eq!(rejected["error"]["code"],"FEE_CAP_EXCEEDED","{kind}: {rejected}");
    }
}
