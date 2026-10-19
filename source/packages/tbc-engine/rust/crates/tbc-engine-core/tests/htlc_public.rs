use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use secp256k1::{Message,Secp256k1,SecretKey};
use tbc_engine_core::{call_json,EngineMethod,protocols::htlc::Code};
use tbc_sdk::{PrivateKey,Transaction,TxIn,TxOut,OutPoint,Txid,script::Script};
fn base()->Value{serde_json::from_str(include_str!("../../../fixtures/tbc-transfer.json")).unwrap()}
fn hex(b:&[u8])->String{b.iter().map(|v|format!("{v:02x}")).collect()}
fn bytes(s:&str)->Vec<u8>{s.as_bytes().chunks_exact(2).map(|b|u8::from_str_radix(std::str::from_utf8(b).unwrap(),16).unwrap()).collect()}
fn hash(v:&Value)->String{hex(&Sha256::digest(serde_json::to_vec(v).unwrap()))}
fn key(n:u8)->PrivateKey{let mut s=[0;32];s[31]=n;PrivateKey::from_slice(&s).unwrap()}
fn call(m:EngineMethod,v:&Value)->Value{serde_json::from_str(&call_json(m,&v.to_string())).unwrap()}
fn ok(m:EngineMethod,v:&Value)->Value{
    let r=call(m,v);assert_eq!(r["ok"],true,"{r}");
    if std::env::var("HTLC_PUBLIC_DUMP_WIRE").as_deref()==Ok("1"){
        let (a,b)=match m{EngineMethod::NormalizeRequest=>("normalizeRequestParams","normalizeRequestResult"),EngineMethod::Plan=>("planParams","planResult"),
            EngineMethod::Validate=>("validateParams","validationResult"),EngineMethod::Finalize=>("finalizeParams","finalizeResult")};
        // Contains only public synthetic fixtures, never a real secret.
        println!("HTLC_PUBLIC_WIRE:{}",json!({"definition":a,"value":v}));
        println!("HTLC_PUBLIC_WIRE:{}",json!({"definition":b,"value":r["result"]}));
    }r["result"].clone()
}
fn bind(mut p:Value)->Value{
    let n=ok(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":p["request"]}));p["request"]=n["request"].clone();p["requestHash"]=n["requestHash"].clone();
    p["snapshot"]["snapshotHash"]=json!(hash(&p["snapshot"]["payload"]));p["policy"]["policyHash"]=json!(hash(&p["policy"]["payload"]));p
}
fn replace_deposit(p:&mut Value,code:&Code){
    let tx=Transaction{version:10,inputs:vec![TxIn::new(OutPoint{txid:Txid::from_le_bytes([7;32]),vout:0})],
        outputs:vec![TxOut{satoshis:10000,script_pubkey:Script::from_bytes(code.encode())}],lock_time:0};let id=tx.txid().to_string();
    p["snapshot"]["payload"]["parents"]=json!([{"txid":id,"rawTransaction":tx.to_hex()}]);
    p["snapshot"]["payload"]["utxos"]=json!([{"txid":id,"vout":0,"satoshis":"10000","scriptPubKey":hex(tx.outputs[0].script_pubkey.as_bytes()),"classification":"htlc","confirmations":"6"}]);
    p["request"]["constraints"]["inputOutpoints"]=json!([{"txid":id,"vout":0}]);
}
fn input(operation:&str,timestamp:bool)->Value{
    let mut p=base()["planInput"].clone();let owner=key(1).public_key();let other=key(2).public_key();
    let until=if timestamp{1774427165}else if operation=="lock"{830010}else{829990};
    let code=Code{sender_hash:if operation=="claim"{other.hash160()}else{owner.hash160()},
        receiver_hash:if operation=="claim"{owner.hash160()}else{other.hash160()},hashlock:Sha256::digest([0x33;32]).into(),raw_lock_time:until};
    p["request"]["intent"]=match operation{
        "lock"=>json!({"version":"1.0","type":"tbc-htlc-lock","amount":"1000","to":other.address().to_string(),"lockTime":until.to_string(),"hashlock":hex(&code.hashlock)}),
        "claim"=>json!({"version":"1.0","type":"tbc-htlc-claim","preimage":"33".repeat(32)}),
        _=>json!({"version":"1.0","type":"tbc-htlc-refund"}),
    };
    p["policy"]["payload"]["dustThreshold"]=json!("42");p["snapshot"]["payload"]["block"]["height"]=json!("830000");
    if timestamp{p["snapshot"]["payload"]["block"]["medianTimePast"]=json!(if operation=="lock"{"1774427164"}else{"1774427166"});}
    if operation!="lock"{replace_deposit(&mut p,&code);}bind(p)
}
fn approved(p:&Value,plan:&Value)->Value{
    let mut b=base()["finalizeInput"]["binding"].clone();b["payload"]["requestHash"]=p["requestHash"].clone();
    b["payload"]["chainId"]=p["request"]["chainId"].clone();b["payload"]["accountId"]=p["snapshot"]["payload"]["account"]["accountId"].clone();
    b["payload"]["operationHash"]=plan["plan"]["planHash"].clone();b["payload"]["expiresAt"]=plan["plan"]["payload"]["expiresAt"].clone();b["bindingHash"]=json!(hash(&b["payload"]));
    let mut approval=base()["finalizeInput"]["approval"].clone();approval["bindingHash"]=b["bindingHash"].clone();approval["expiresAt"]=b["payload"]["expiresAt"].clone();
    let mut scalar=[0;32];scalar[31]=if p["request"]["from"]==json!(key(2).public_key().address().to_string()){2}else{1};let key=SecretKey::from_byte_array(scalar).unwrap();
    let sigs:Vec<_>=plan["plan"]["payload"]["signingTasks"].as_array().unwrap().iter().map(|t|json!({"taskId":t["taskId"],"signatureEncoding":"compact64",
        "signature":hex(&Secp256k1::new().sign_ecdsa(Message::from_digest(bytes(t["digest"].as_str().unwrap()).try_into().unwrap()),&key).serialize_compact())})).collect();
    let mut r=p.clone();r["plan"]=plan["plan"].clone();r["binding"]=b;r["approval"]=approval;r["signatures"]=json!(sigs);r
}
#[test]
fn public_htlc_uses_shared_plan_approval_and_finalize(){
    for timestamp in [false,true]{for operation in ["lock","claim","refund"]{
        let p=input(operation,timestamp);let plan=ok(EngineMethod::Plan,&p);let signed=approved(&p,&plan);
        assert_eq!(plan["plan"]["payload"]["preview"]["warnings"],if operation=="claim" {
            json!(["HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE"])
        }else{json!([])});
        let mut check=signed.clone();check["phase"]=json!("pre-sign");check.as_object_mut().unwrap().remove("signatures");assert_eq!(ok(EngineMethod::Validate,&check)["valid"],true);
        let result=ok(EngineMethod::Finalize,&signed);let tx=Transaction::from_hex(result["bundle"]["transactions"][0]["rawTransaction"].as_str().unwrap()).unwrap();
        assert_eq!(tx.lock_time,if operation=="refund"{if timestamp{1774427165}else{829990}}else{0});
        check=signed.clone();check["phase"]=json!("pre-broadcast");check["bundle"]=result["bundle"].clone();assert_eq!(ok(EngineMethod::Validate,&check)["valid"],true);
        let mut tampered=signed.clone();tampered["binding"]["payload"]["operationHash"]=json!("ff".repeat(32));assert_eq!(call(EngineMethod::Finalize,&tampered)["ok"],false);
        let mut changed=signed;changed["plan"]["payload"]["transactions"][0]["fee"]=json!("79");assert_eq!(call(EngineMethod::Finalize,&changed)["ok"],false);
    }}
}
#[test]
fn public_htlc_authenticates_exact_deposits_role_context_and_policy(){
    for case in 0..12{
        let mut p=input("refund",false);
        match case{
            0=>p["snapshot"]["payload"]["parents"]=json!([]),
            1=>p["snapshot"]["payload"]["utxos"][0]["satoshis"]=json!("10001"),
            2=>p["snapshot"]["payload"]["block"]["height"]=json!("829989"),
            3=>p["policy"]["payload"]["feeRateSatPerKb"]=json!("1"),
            4=>p["policy"]["payload"]["amountLimits"][0]["maximum"]=json!("1"),
            5=>p["snapshot"]["payload"]["utxos"][0]["confirmations"]=json!("0"),
            6=>p["snapshot"]["payload"]["utxos"][0]["classification"]=json!("native"),
            7=>p["request"]["constraints"]["inputOutpoints"].as_array_mut().unwrap().push(json!({"txid":"ff".repeat(32),"vout":0})),
            8=>{let id=json!("ef".repeat(32));p["request"]["constraints"]["inputOutpoints"][0]["txid"]=id.clone();p["snapshot"]["payload"]["parents"][0]["txid"]=id.clone();p["snapshot"]["payload"]["utxos"][0]["txid"]=id;},
            9=>{let code=Code{sender_hash:key(2).public_key().hash160(),receiver_hash:key(1).public_key().hash160(),hashlock:Sha256::digest([0x33;32]).into(),raw_lock_time:829990};replace_deposit(&mut p,&code);},
            10=>p["snapshot"]["payload"]["utxos"][0]["contractId"]=json!("aa".repeat(32)),
            _=>p["request"]["constraints"]["maxFee"]=json!("79"),
        }
        p=bind(p);assert_eq!(call(EngineMethod::Plan,&p)["ok"],false,"case {case}");
    }
    for operation in ["lock","refund"]{
        let mut p=input(operation,true);p["snapshot"]["payload"]["block"].as_object_mut().unwrap().remove("medianTimePast");p=bind(p);assert_eq!(call(EngineMethod::Plan,&p)["ok"],false);
        let mut p=input(operation,true);p["snapshot"]["payload"]["block"]["medianTimePast"]=json!("1774427165");p=bind(p);assert_eq!(call(EngineMethod::Plan,&p)["ok"],false);
    }
    let mut p=input("claim",false);p["request"]["intent"]["preimage"]=json!("34".repeat(32));p=bind(p);let failed=call(EngineMethod::Plan,&p);
    assert_eq!(failed["ok"],false);assert!(!failed.to_string().contains(&"34".repeat(32)));
    let mut p=input("lock",false);p["request"]["intent"]["lockTime"]=json!("829999");p=bind(p);assert_eq!(call(EngineMethod::Plan,&p)["ok"],false);
}
#[test]
fn public_htlc_strict_request_and_direct_funding(){
    for operation in ["lock","claim","refund"]{
        let p=input(operation,false);
        for field in ["contractId","payment","receivers","receiver"]{
            let mut r=p["request"].clone();r["intent"][field]=json!("unexpected");assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":r}))["ok"],false);
        }
        if operation!="lock"{let mut r=p["request"].clone();r["constraints"].as_object_mut().unwrap().remove("inputOutpoints");assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":r}))["ok"],false);}
    }
    let mut old=base()["planInput"]["request"].clone();old["intent"]["preimage"]=json!("aa");assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":old}))["ok"],false);
    let mut p=input("lock",false);let template=p["snapshot"]["payload"]["utxos"][0].clone();p["snapshot"]["payload"]["parents"]=json!([]);
    let funding:Vec<_>=(1..=7).map(|i|{let mut u=template.clone();u["txid"]=json!(format!("{i:02x}").repeat(32));u["satoshis"]=json!("1000");u}).collect();
    p["snapshot"]["payload"]["utxos"]=json!(funding);p["request"]["constraints"]["maxFee"]=json!("1000");p["request"]["intent"]["amount"]=json!("6800");p=bind(p);
    let plan=ok(EngineMethod::Plan,&p);assert_eq!(plan["plan"]["payload"]["transactions"].as_array().unwrap().len(),1);assert_eq!(plan["plan"]["payload"]["signingTasks"].as_array().unwrap().len(),7);ok(EngineMethod::Finalize,&approved(&p,&plan));
    p["request"]["intent"]["amount"]=json!("500");p=bind(p);assert_eq!(ok(EngineMethod::Plan,&p)["plan"]["payload"]["signingTasks"].as_array().unwrap().len(),1);
    p["request"]["constraints"]["inputOutpoints"]=json!(funding.iter().map(|u|json!({"txid":u["txid"],"vout":u["vout"]})).collect::<Vec<_>>());p=bind(p);
    assert_eq!(ok(EngineMethod::Plan,&p)["plan"]["payload"]["signingTasks"].as_array().unwrap().len(),7);
}

fn token_input(coin:bool)->Value{
    let (parent,ancestors,vout,asset,template)=if coin{
        let f:Value=serde_json::from_str(include_str!("../../../fixtures/coin-proof.json")).unwrap();
        let p=Transaction::from_hex(f["vectors"][0]["parentRaw"].as_str().unwrap()).unwrap();
        let a=Transaction::from_hex(f["vectors"][0]["ancestorsRaw"][0].as_str().unwrap()).unwrap();let id=a.txid().to_string();
        (p,vec![a],3,id,"c686fc271f0ee8116325bf541d87c4d2e6ad839896a9d9dd21dcf2ac847660e3")
    }else{
        let f:Value=serde_json::from_str(include_str!("../../../fixtures/tbc20-standard-transfer.json")).unwrap();
        let p=Transaction::from_hex(f["stages"][1]["signedRaw"].as_str().unwrap()).unwrap();let id=p.txid().to_string();
        (p,vec![Transaction::from_hex(f["stages"][0]["signedRaw"].as_str().unwrap()).unwrap()],0,id,"0f5db33bb46e4517963cbd383518f74283b5c2c4efb0a733522a1fbc0d4a9f84")
    };
    let standard=if coin{"tbc20-stablecoin"}else{"tbc20-standard"};let family=if coin{"stablecoin"}else{"ft"};
    let mut p=input("lock",false);p["request"]["intent"]["assetStandard"]=json!(standard);p["request"]["intent"]["contractId"]=json!(asset);
    p["request"]["intent"]["amount"]=json!("250");p["request"]["constraints"]["maxFee"]=json!("10000");
    let fee=parent.outputs.len()-1;
    let descriptor=|n:usize,kind:&str|json!({"txid":parent.txid().to_string(),"vout":n,"satoshis":parent.outputs[n].satoshis.to_string(),
        "scriptPubKey":hex(parent.outputs[n].script_pubkey.as_bytes()),"classification":kind,"confirmations":"6"});
    let mut token=descriptor(vout,family);token["contractId"]=json!(asset);
    p["snapshot"]["payload"]["utxos"]=json!([token,descriptor(fee,"native")]);
    p["snapshot"]["payload"]["parents"]=json!(std::iter::once(&parent).chain(ancestors.iter()).map(|tx|json!({"txid":tx.txid().to_string(),"rawTransaction":tx.to_hex()})).collect::<Vec<_>>());
    p["snapshot"]["payload"]["contracts"]=json!([{"contractId":asset,"family":family,"protocolVersion":if coin{"coin"}else{"tbc20"},
        "standardId":standard,"templateRevision":template,"creationTxid":asset,"genesisOutpoint":{"txid":asset,"vout":0},
        "currentOutpoint":{"txid":parent.txid().to_string(),"vout":vout}}]);
    p["policy"]["payload"]["contractPolicies"]=json!([{"family":family,"allowedVersions":[if coin{"coin"}else{"tbc20"}]}]);
    bind(p)
}
fn token_spend_input(lock:&Value,deploy:&Transaction,claim:bool)->Value{
    let mut p=lock.clone();let public=key(if claim{2}else{1}).public_key();let address=public.address().to_string();
    let network=p["request"]["chainId"].as_str().unwrap().to_owned();
    p["request"]["from"]=json!(address);p["snapshot"]["payload"]["account"]=json!({"address":address,"accountId":format!("{network}:{address}"),"chainId":network,"publicKey":hex(&public.to_bytes())});
    p["request"]["intent"]=json!({"type":if claim{"tbc-htlc-claim"}else{"tbc-htlc-refund"},"version":"1.0",
        "assetStandard":lock["request"]["intent"]["assetStandard"],"contractId":lock["request"]["intent"]["contractId"],
        "targetOutpoints":[{"txid":deploy.txid().to_string(),"vout":1}]});
    if claim{p["request"]["intent"]["preimage"]=json!("33".repeat(32));}
    let mut utxos:Vec<_>=[0usize,1].iter().map(|n|json!({"txid":deploy.txid().to_string(),"vout":n,"satoshis":deploy.outputs[*n].satoshis.to_string(),
        "scriptPubKey":hex(deploy.outputs[*n].script_pubkey.as_bytes()),"classification":if *n==0{"htlc"}else if p["request"]["intent"]["assetStandard"]=="tbc20-standard"{"ft"}else{"stablecoin"},"confirmations":"6"})).collect();
    utxos[1]["contractId"]=p["request"]["intent"]["contractId"].clone();
    utxos.push(json!({"txid":"ee".repeat(32),"vout":0,"satoshis":"100000","scriptPubKey":hex(Script::p2pkh(&public.hash160()).as_bytes()),"classification":"native","confirmations":"6"}));
    p["snapshot"]["payload"]["utxos"]=json!(utxos);
    p["snapshot"]["payload"]["parents"].as_array_mut().unwrap().push(json!({"txid":deploy.txid().to_string(),"rawTransaction":deploy.to_hex()}));
    p["snapshot"]["payload"]["block"]["height"]=json!("830010");bind(p)
}
#[test]
fn public_htlc_token_lifecycle_uses_shared_bound_signatures(){
    for coin in [false,true]{for chain in ["tbc:mainnet","tbc:testnet"]{
        let mut p=token_input(coin);let account=p["request"]["from"].as_str().unwrap().to_owned();
        p["request"]["chainId"]=json!(chain);p["snapshot"]["payload"]["chainId"]=json!(chain);p["policy"]["payload"]["chainId"]=json!(chain);
        p["snapshot"]["payload"]["account"]["chainId"]=json!(chain);p["snapshot"]["payload"]["account"]["accountId"]=json!(format!("{chain}:{account}"));p=bind(p);
        let plan=ok(EngineMethod::Plan,&p);let result=ok(EngineMethod::Finalize,&approved(&p,&plan));
        let deploy=Transaction::from_hex(result["bundle"]["transactions"][0]["rawTransaction"].as_str().unwrap()).unwrap();
        for claim in [true,false]{
            let p=token_spend_input(&p,&deploy,claim);let plan=ok(EngineMethod::Plan,&p);let signed=approved(&p,&plan);
            assert_eq!(plan["plan"]["payload"]["preview"]["warnings"],if claim{json!(["HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE"])}else{json!([])});
            assert!(!plan["plan"]["payload"]["signingTasks"].to_string().contains(&"33".repeat(32)));
            let mut check=signed.clone();check["phase"]=json!("pre-sign");check.as_object_mut().unwrap().remove("signatures");assert_eq!(ok(EngineMethod::Validate,&check)["valid"],true);
            let result=ok(EngineMethod::Finalize,&signed);check=signed.clone();check["phase"]=json!("pre-broadcast");check["bundle"]=result["bundle"].clone();assert_eq!(ok(EngineMethod::Validate,&check)["valid"],true);
            let mut tampered=signed.clone();tampered["binding"]["payload"]["operationHash"]=json!("ff".repeat(32));assert_eq!(call(EngineMethod::Finalize,&tampered)["ok"],false);
            if claim{let mut changed=signed;changed["request"]["intent"]["preimage"]=json!("34".repeat(32));assert_eq!(call(EngineMethod::Finalize,&changed)["ok"],false);}
        }
    }}
}
#[test]
fn public_token_htlc_rejects_identity_policy_target_escrow_and_secret_tampering(){
    for coin in [false,true]{
        let p=token_input(coin);
        for case in 0..6{let mut bad=p.clone();match case{
            0=>bad["snapshot"]["payload"]["contracts"][0]["standardId"]=json!("legacy-ft"),
            1=>bad["snapshot"]["payload"]["utxos"][0]["satoshis"]=json!("499"),
            2=>bad["snapshot"]["payload"]["parents"]=json!([]),
            3=>bad["policy"]["payload"]["contractPolicies"][0]["allowedVersions"]=json!(["v1"]),
            4=>bad["policy"]["payload"]["amountLimits"]=json!([{"scope":if coin{"stablecoin-total"}else{"ft-total"},"maximum":"1"}]),
            _=>bad["request"]["constraints"]["maxFee"]=json!("1"),
        }bad=bind(bad);assert_eq!(call(EngineMethod::Plan,&bad)["ok"],false,"case {case}");}
        let plan=ok(EngineMethod::Plan,&p);let result=ok(EngineMethod::Finalize,&approved(&p,&plan));
        let deploy=Transaction::from_hex(result["bundle"]["transactions"][0]["rawTransaction"].as_str().unwrap()).unwrap();
        let spend=token_spend_input(&p,&deploy,true);
        for case in 0..6{let mut bad=spend.clone();match case{
            0=>{bad["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().remove(0);},
            1=>bad["snapshot"]["payload"]["utxos"][0]["satoshis"]=json!("101"),
            2=>bad["snapshot"]["payload"]["utxos"][0]["confirmations"]=json!("0"),
            3=>bad["request"]["intent"]["preimage"]=json!("34".repeat(32)),
            4=>bad["request"]["intent"]["targetOutpoints"][0]["txid"]=json!("aa".repeat(32)),
            _=>bad["request"]["constraints"]["inputOutpoints"]=json!([{"txid":deploy.txid().to_string(),"vout":1}]),
        }bad=bind(bad);let r=call(EngineMethod::Plan,&bad);assert_eq!(r["ok"],false,"case {case}");assert!(!r.to_string().contains(&"34".repeat(32)));}
        for field in ["assetStandard","contractId","targetOutpoints"]{let mut bad=spend["request"].clone();bad["intent"].as_object_mut().unwrap().remove(field);
            assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":bad}))["ok"],false);}
    }
}
