use serde_json::{json,Value};
#[path = "support/unified_business.rs"]
mod unified_business;

#[test]
fn unified_current_coin_signing_matches_concrete() {
    unified_business::exercise(input(false), "tbc20Stablecoin.transfer");
    unified_business::exercise(input(true), "tbc20Stablecoin.merge");
}
use sha2::{Digest,Sha256};
use secp256k1::{Message,Secp256k1,SecretKey};
use tbc_engine_core::{call_json,EngineMethod};
use tbc_sdk::Transaction;
fn base()->Value {serde_json::from_str(include_str!("../../../fixtures/tbc-transfer.json")).unwrap()}
fn oracle()->Value {serde_json::from_str(include_str!("../../../fixtures/coin-proof.json")).unwrap()}
fn hex(bytes:&[u8])->String {bytes.iter().map(|v|format!("{v:02x}")).collect()}
fn bytes(s:&str)->Vec<u8> {(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
fn hash(v:&Value)->String {hex(&Sha256::digest(serde_json::to_vec(v).unwrap()))}
fn call(method:EngineMethod,input:&Value)->Value {serde_json::from_str(&call_json(method,&input.to_string())).unwrap()}
fn ok(method:EngineMethod,input:&Value)->Value {
    let result=call(method,input);assert_eq!(result["ok"],true,"{result}");
    if std::env::var("COIN_DUMP_WIRE").as_deref()==Ok("1") {
        let (params,result_type)=match method {EngineMethod::NormalizeRequest=>("normalizeRequestParams","normalizeRequestResult"),
            EngineMethod::Plan=>("planParams","planResult"),EngineMethod::Validate=>("validateParams","validationResult"),
            EngineMethod::Finalize=>("finalizeParams","finalizeResult")};
        println!("COIN_WIRE:{}",json!({"definition":params,"value":input}));
        println!("COIN_WIRE:{}",json!({"definition":result_type,"value":result["result"]}));
    }
    result["result"].clone()
}
fn bind(mut input:Value)->Value {
    let normalized=ok(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":input["request"]}));
    input["request"]=normalized["request"].clone();input["requestHash"]=normalized["requestHash"].clone();
    input["snapshot"]["snapshotHash"]=json!(hash(&input["snapshot"]["payload"]));
    input["policy"]["policyHash"]=json!(hash(&input["policy"]["payload"]));input
}
fn input(merge:bool)->Value {
    let f=oracle();let mint=Transaction::from_hex(f["vectors"][0]["parentRaw"].as_str().unwrap()).unwrap();
    let issuer=Transaction::from_hex(f["vectors"][0]["ancestorsRaw"][0].as_str().unwrap()).unwrap();
    let parent=if merge {Transaction::from_hex(f["vectors"][0]["signedRaw"].as_str().unwrap()).unwrap()}else{mint.clone()};
    let contract=issuer.txid().to_string();let mut p=base()["planInput"].clone();
    p["request"]["constraints"]["maxFee"]=json!("5000");
    p["request"]["intent"]=json!({"type":if merge {"tbc20-stablecoin-merge"}else{"tbc20-stablecoin-transfer"},"version":"1.0","contractId":contract});
    if !merge {p["request"]["intent"]["to"]=p["request"]["from"].clone();p["request"]["intent"]["amount"]=json!("250");}
    let mut utxos:Vec<_>=if merge {vec![0,2]}else{vec![3]}.into_iter().map(|vout|json!({"txid":parent.txid().to_string(),
        "vout":vout,"satoshis":"500","scriptPubKey":hex(parent.outputs[vout].script_pubkey.as_bytes()),"classification":"stablecoin","contractId":contract,"confirmations":"0"})).collect();
    let fee=parent.outputs.len()-1;utxos.push(json!({"txid":parent.txid().to_string(),"vout":fee,"satoshis":parent.outputs[fee].satoshis.to_string(),
        "scriptPubKey":hex(parent.outputs[fee].script_pubkey.as_bytes()),"classification":"native","confirmations":"0"}));
    p["snapshot"]["payload"]["utxos"]=json!(utxos);
    let mut parents=vec![issuer,mint];if merge {parents.push(parent.clone());}
    p["snapshot"]["payload"]["parents"]=json!(parents.iter().map(|tx|json!({"txid":tx.txid().to_string(),"rawTransaction":tx.to_hex()})).collect::<Vec<_>>());
    p["snapshot"]["payload"]["contracts"]=json!([{"contractId":contract,"family":"stablecoin","protocolVersion":"coin","standardId":"tbc20-stablecoin",
        "templateRevision":"c686fc271f0ee8116325bf541d87c4d2e6ad839896a9d9dd21dcf2ac847660e3","creationTxid":contract,
        "genesisOutpoint":{"txid":contract,"vout":0},"currentOutpoint":{"txid":parent.txid().to_string(),"vout":if merge {0}else{3}}}]);
    p["policy"]["payload"]["dustThreshold"]=json!("24");p["policy"]["payload"]["minConfirmations"]=json!("0");
    p["policy"]["payload"]["contractPolicies"]=json!([{"family":"stablecoin","allowedVersions":["coin"]}]);
    bind(p)
}
fn approved(p:&Value,plan:&Value)->Value {
    let mut binding=base()["finalizeInput"]["binding"].clone();
    binding["payload"]["requestHash"]=p["requestHash"].clone();binding["payload"]["operationHash"]=plan["plan"]["planHash"].clone();
    binding["payload"]["expiresAt"]=plan["plan"]["payload"]["expiresAt"].clone();binding["bindingHash"]=json!(hash(&binding["payload"]));
    let mut approval=base()["finalizeInput"]["approval"].clone();approval["bindingHash"]=binding["bindingHash"].clone();approval["expiresAt"]=binding["payload"]["expiresAt"].clone();
    // Public scalars 1/2 for invented offline material only; never wallet keys.
    let secp=Secp256k1::new();
    let signatures:Vec<_>=plan["plan"]["payload"]["signingTasks"].as_array().unwrap().iter().map(|t|{
        let mut scalar=[0;32];scalar[31]=if t["publicKey"]==admin_account(p["request"]["chainId"].as_str().unwrap())["publicKey"].as_str().unwrap()[2..] {2}else{1};
        let key=SecretKey::from_byte_array(scalar).unwrap();let pair=secp256k1::Keypair::from_secret_key(&secp,&key);
        let digest:[u8;32]=bytes(t["digest"].as_str().unwrap()).try_into().unwrap();
        let signature=if t["signatureEncoding"]=="schnorr64" {hex(secp.sign_schnorr_no_aux_rand(&digest,&pair).as_ref())}
            else{hex(&secp.sign_ecdsa(Message::from_digest(digest),&key).serialize_compact())};
        json!({"taskId":t["taskId"],"signatureEncoding":t["signatureEncoding"],"signature":signature})
    }).collect();
    let mut result=p.clone();result["plan"]=plan["plan"].clone();result["binding"]=binding;result["approval"]=approval;result["signatures"]=json!(signatures);result
}

#[test]
fn trusted_index_coin_keeps_signed_bytes_without_issuer_audit_or_unused_tip() {
    for merge in [false, true] {
        let original=input(merge);
        let first=Transaction::from_hex(oracle()["vectors"][0]["parentRaw"].as_str().unwrap()).unwrap();
        let mut indexed=original.clone();
        let payload=&mut indexed["snapshot"]["payload"];
        payload.as_object_mut().unwrap().remove("block");
        payload["contracts"][0]["indexedFungible"]=json!({
            "codeScript":hex(first.outputs[3].script_pubkey.as_bytes()),
            "tapeScript":hex(first.outputs[4].script_pubkey.as_bytes()),"totalSupply":"1000"});
        // First mint references its issuer as an unlock proof. A later holder
        // references only the mint: identity alone must not fetch the issuer.
        if merge {
            let id=payload["contracts"][0]["contractId"].clone();
            payload["parents"].as_array_mut().unwrap().retain(|p|p["txid"]!=id);
        }
        let indexed=bind(indexed);
        let before=ok(EngineMethod::Plan,&original);
        let after=ok(EngineMethod::Plan,&indexed);
        for key in ["transactions","signingTasks","preview"] {
            assert_eq!(before["plan"]["payload"][key],after["plan"]["payload"][key],"{key}");
        }
        let a=ok(EngineMethod::Finalize,&approved(&original,&before));
        let b=ok(EngineMethod::Finalize,&approved(&indexed,&after));
        assert_eq!(a["bundle"]["transactions"],b["bundle"]["transactions"]);
        for mutation in ["code","supply","holder","missing-proof"] {
            let mut bad=indexed.clone();
            match mutation {
                "code"=>bad["snapshot"]["payload"]["contracts"][0]["indexedFungible"]["codeScript"]=json!("00"),
                "supply"=>bad["snapshot"]["payload"]["contracts"][0]["indexedFungible"]["totalSupply"]=json!("1"),
                "holder"=>bad["snapshot"]["payload"]["utxos"][0]["satoshis"]=json!("501"),
                _=>bad["snapshot"]["payload"]["parents"]=json!([]),
            }
            assert_eq!(call(EngineMethod::Plan,&bind(bad))["ok"],false,"{mutation}");
        }
    }
}

fn create_input()->Value {
    let f:Value=serde_json::from_str(include_str!("../../../fixtures/coin-admin-proof.json")).unwrap();
    let funding=Transaction::from_hex(f["issuance"]["grandparentRaw"].as_str().unwrap()).unwrap();
    let mut p=base()["planInput"].clone();
    p["request"]["intent"]=json!({"type":"tbc20-stablecoin-create","version":"1.0","name":"Offline Coin","symbol":"OFF","decimals":6,"initialSupply":"2500000"});
    p["request"]["constraints"]["maxFee"]=json!("10000");
    p["snapshot"]["payload"]["utxos"]=json!([{"txid":funding.txid().to_string(),"vout":0,"satoshis":funding.outputs[0].satoshis.to_string(),
        "scriptPubKey":hex(funding.outputs[0].script_pubkey.as_bytes()),"classification":"native","confirmations":"0"}]);
    p["snapshot"]["payload"]["parents"]=json!([{"txid":funding.txid().to_string(),"rawTransaction":funding.to_hex()}]);
    p["snapshot"]["payload"]["contracts"]=json!([]);p["policy"]["payload"]["dustThreshold"]=json!("24");p["policy"]["payload"]["minConfirmations"]=json!("0");
    p["policy"]["payload"]["contractPolicies"]=json!([{"family":"stablecoin","allowedVersions":["coin"]}]);
    bind(p)
}

#[test]
fn coin_admin_public_intents_require_exact_targets_and_canonical_locks() {
    let mut request=base()["planInput"]["request"].clone();
    let target=json!({"txid":"11".repeat(32),"vout":3});
    for action in [
        json!({"type":"tbc20-stablecoin-freeze","version":"1.0","contractId":"22".repeat(32),"targetOutpoints":[target.clone()],"lockTime":"4294967295"}),
        json!({"type":"tbc20-stablecoin-unfreeze","version":"1.0","contractId":"22".repeat(32),"targetOutpoints":[target.clone()]}),
        json!({"type":"tbc20-stablecoin-mint","version":"1.0","contractId":"22".repeat(32),"certificateOutpoint":{"txid":"33".repeat(32),"vout":0},"amount":"25","to":request["from"]}),
    ] {
        request["intent"]=action.clone();ok(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":request}));
        for field in ["receivers","payment","name"] {
            let mut bad=request.clone();bad["intent"][field]=json!([]);
            assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":bad}))["ok"],false);
        }
    }
    request["intent"]=json!({"type":"tbc20-stablecoin-freeze","version":"1.0","contractId":"22".repeat(32),"targetOutpoints":[target],"lockTime":"4294967295"});
    for lock in [json!("0"),json!("01"),json!("4294967296"),json!("-1"),json!(100)] {
        let mut bad=request.clone();bad["intent"]["lockTime"]=lock;
        assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":bad}))["ok"],false);
    }
    for targets in [json!([]),json!([target.clone(),target.clone()])] {
        let mut bad=request.clone();bad["intent"]["targetOutpoints"]=targets;
        assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":bad}))["ok"],false);
    }
}

#[test]
fn coin_public_management_uses_common_binding_signer_and_conserves_targets() {
    management_lifecycle(false);
}

fn admin_account(chain:&str)->Value {
    let address="1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP";
    json!({"chainId":chain,"accountId":format!("{chain}:{address}"),"address":address,
        "publicKey":"02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"})
}
fn with_admin(mut p:Value)->Value {
    let account=admin_account(p["request"]["chainId"].as_str().unwrap());
    p["request"]["signingRoles"]=json!([{"role":"coin-admin","accountId":account["accountId"]}]);
    p["snapshot"]["payload"]["signingAccounts"]=json!([account]);bind(p)
}
#[test]
fn coin_explicit_admin_lifecycle_binds_both_roles_and_continuation() {
    management_lifecycle(true);
}
fn management_lifecycle(explicit_admin:bool) {
    let mut p=create_input();
    // Fee scalar1; admin scalar2 and recipient scalar3 in the explicit case.
    // Management must not require the asset to belong to either signing role.
    let mut recipient_scalar=[0;32];recipient_scalar[31]=if explicit_admin{3}else{2};
    let recipient_key=secp256k1::PublicKey::from_secret_key(&Secp256k1::new(),&SecretKey::from_byte_array(recipient_scalar).unwrap());
    let recipient=tbc_sdk::Address::from_hash160(tbc_sdk::PublicKey::from_slice(&recipient_key.serialize()).unwrap().hash160()).to_string();
    p["request"]["intent"]["to"]=json!(recipient);p=if explicit_admin{with_admin(p)}else{bind(p)};
    let plan=ok(EngineMethod::Plan,&p);let mut signed=approved(&p,&plan);
    if explicit_admin {
        let role=admin_account(p["request"]["chainId"].as_str().unwrap());
        assert_eq!(plan["plan"]["payload"]["preview"]["signingRoles"],json!([{"role":"coin-admin","account":role}]));
        assert_eq!(plan["plan"]["payload"]["signingTasks"][0]["accountId"],p["snapshot"]["payload"]["account"]["accountId"]);
        for case in 0..7 {
            let mut bad=p.clone();match case {
                0=>{bad["snapshot"]["payload"].as_object_mut().unwrap().remove("signingAccounts");},
                1=>bad["snapshot"]["payload"]["signingAccounts"]=json!([]),
                2=>bad["snapshot"]["payload"]["signingAccounts"]=json!([role.clone(),role.clone()]),
                3=>bad["snapshot"]["payload"]["signingAccounts"][0]["publicKey"]=p["snapshot"]["payload"]["account"]["publicKey"].clone(),
                4=>bad["snapshot"]["payload"]["signingAccounts"][0]["chainId"]=json!("tbc:foreign"),
                5=>{bad["request"].as_object_mut().unwrap().remove("signingRoles");},
                _=>bad["snapshot"]["payload"]["signingAccounts"][0]["accountId"]=p["snapshot"]["payload"]["account"]["accountId"].clone(),
            }
            bad=bind(bad);assert_eq!(call(EngineMethod::Plan,&bad)["ok"],false,"explicit admin case {case}");
        }
    }
    let pending=ok(EngineMethod::Finalize,&signed);
    if explicit_admin {
        let tasks=pending["signingRequests"].as_array().unwrap();
        assert_eq!(tasks.iter().filter(|t|t["accountId"]==p["request"]["signingRoles"][0]["accountId"]).count(),2);
        assert_eq!(tasks.last().unwrap()["accountId"],p["snapshot"]["payload"]["account"]["accountId"]);
    }
    let pending_plan=json!({"plan":{"planHash":plan["plan"]["planHash"],"payload":{"expiresAt":plan["plan"]["payload"]["expiresAt"],"signingTasks":pending["signingRequests"]}}});
    signed["signatures"]=approved(&p,&pending_plan)["signatures"].clone();signed["continuation"]=pending["continuation"].clone();
    if explicit_admin {
        let mut bad=signed.clone();bad["request"].as_object_mut().unwrap().remove("signingRoles");assert_eq!(call(EngineMethod::Finalize,&bad)["ok"],false);
        let mut bad=signed.clone();bad["signatures"][0]["signature"]=bad["signatures"][2]["signature"].clone();assert_eq!(call(EngineMethod::Finalize,&bad)["ok"],false);
    }
    let created=ok(EngineMethod::Finalize,&signed);
    let source=Transaction::from_hex(created["bundle"]["transactions"][0]["rawTransaction"].as_str().unwrap()).unwrap();
    let mint=Transaction::from_hex(created["bundle"]["transactions"][1]["rawTransaction"].as_str().unwrap()).unwrap();
    let id=source.txid().to_string();let mut holder=mint.clone();let mut ancestor=source.clone();
    for operation in ["tbc20-stablecoin-freeze","tbc20-stablecoin-unfreeze","tbc20-stablecoin-mint"] {
        let minting=operation=="tbc20-stablecoin-mint";let vout=if holder.txid()==mint.txid(){3}else{0};
        let mut p=input(false);
        p["request"]["constraints"]["maxFee"]=json!("10000");
        p["request"]["intent"]=json!({"type":operation,"version":"1.0","contractId":id});
        if minting {
            p["request"]["intent"]["certificateOutpoint"]=json!({"txid":mint.txid().to_string(),"vout":0});
            p["request"]["intent"]["amount"]=json!("25");p["request"]["intent"]["to"]=p["request"]["from"].clone();
        }else {
            p["request"]["intent"]["targetOutpoints"]=json!([{"txid":holder.txid().to_string(),"vout":vout}]);
            if operation.ends_with("-freeze"){p["request"]["intent"]["lockTime"]=json!("4294967295");}
        }
        let mut all=std::collections::BTreeMap::new();for tx in [&source,&mint,&holder,&ancestor]{all.insert(tx.txid().to_string(),tx);}
        p["snapshot"]["payload"]["parents"]=json!(all.values().map(|tx|json!({"txid":tx.txid().to_string(),"rawTransaction":tx.to_hex()})).collect::<Vec<_>>());
        let descriptor=|tx:&Transaction,n:usize,classification:&str|json!({"txid":tx.txid().to_string(),"vout":n,
            "satoshis":tx.outputs[n].satoshis.to_string(),"scriptPubKey":hex(tx.outputs[n].script_pubkey.as_bytes()),
            "classification":classification,"contractId":id,"confirmations":"0"});
        let mut utxos=if minting{vec![descriptor(&mint,0,"nft"),descriptor(&mint,1,"nft")]}else{vec![descriptor(&holder,vout,"stablecoin")]};
        let mut funding=descriptor(&holder,holder.outputs.len()-1,"native");funding.as_object_mut().unwrap().remove("contractId");utxos.push(funding);
        p["snapshot"]["payload"]["utxos"]=json!(utxos);
        let record=&mut p["snapshot"]["payload"]["contracts"][0];record["contractId"]=json!(id);record["creationTxid"]=json!(id);record["genesisOutpoint"]["txid"]=json!(id);
        record["currentOutpoint"]=if minting{json!({"txid":mint.txid().to_string(),"vout":0})}else{json!({"txid":holder.txid().to_string(),"vout":vout})};
        p=if explicit_admin{with_admin(p)}else{bind(p)};
        if explicit_admin {
            let mut bad=p.clone();bad["request"].as_object_mut().unwrap().remove("signingRoles");bad["snapshot"]["payload"].as_object_mut().unwrap().remove("signingAccounts");bad=bind(bad);
            assert_eq!(call(EngineMethod::Plan,&bad)["ok"],false,"Fee account must not inherit admin authority");
        }
        if minting {
            let mut unpinned=p.clone();unpinned["request"]["intent"].as_object_mut().unwrap().remove("certificateOutpoint");unpinned=bind(unpinned);
            assert_eq!(call(EngineMethod::Plan,&unpinned)["ok"],true);
            let mut stale=p.clone();stale["request"]["intent"]["certificateOutpoint"]["txid"]=json!("ee".repeat(32));stale=bind(stale);
            assert_eq!(call(EngineMethod::Plan,&stale)["ok"],false);
        }
        for bad_case in 0..5 {
            let mut bad=p.clone();
            match bad_case {
                0=>bad["snapshot"]["payload"]["utxos"][0]["satoshis"]=json!("499"),
                1=>{bad["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().remove(0);},
                2=>bad["request"]["constraints"]["maxFee"]=json!("1"),
                3=>bad["policy"]["payload"]["amountLimits"]=json!([{"scope":"stablecoin-total","protocolVersion":"coin","maximum":"1"}]),
                _=>bad["snapshot"]["payload"]["parents"]=json!([]),
            }
            bad=bind(bad);assert_eq!(call(EngineMethod::Plan,&bad)["ok"],false,"{operation} case{bad_case}");
        }
        let plan=ok(EngineMethod::Plan,&p);let signed=approved(&p,&plan);
        let tasks=plan["plan"]["payload"]["signingTasks"].as_array().unwrap();
        assert_eq!(tasks.len(),if minting{3}else{2});assert_eq!(tasks[0]["signatureEncoding"],"schnorr64");assert_eq!(tasks.last().unwrap()["signatureEncoding"],"compact64");
        if explicit_admin {
            assert_eq!(tasks[0]["accountId"],p["request"]["signingRoles"][0]["accountId"]);
            assert_eq!(tasks.last().unwrap()["accountId"],p["snapshot"]["payload"]["account"]["accountId"]);
        }
        let mut check=signed.clone();check["phase"]=json!("pre-sign");check.as_object_mut().unwrap().remove("signatures");
        let verdict=ok(EngineMethod::Validate,&check);assert_eq!(verdict["valid"],true,"{verdict}");
        let result=ok(EngineMethod::Finalize,&signed);check=signed.clone();check["phase"]=json!("pre-broadcast");check["bundle"]=result["bundle"].clone();
        let verdict=ok(EngineMethod::Validate,&check);assert_eq!(verdict["valid"],true,"{verdict}");
        let next=Transaction::from_hex(result["bundle"]["transactions"][0]["rawTransaction"].as_str().unwrap()).unwrap();
        if minting {
            let tape=next.outputs[2].script_pubkey.as_bytes();assert_eq!(&tape[..2],&[0,0x6a]);
            let (offset,length)=match tape[2]{0..=75=>(3,tape[2]as usize),0x4c=>(4,tape[3]as usize),0x4d=>(5,u16::from_le_bytes([tape[3],tape[4]])as usize),_=>panic!("bounded certificate data push")};
            let data:Value=serde_json::from_slice(&tape[offset..offset+length]).unwrap();
            assert_eq!(data["coinTotalSupply"],"2500025");
        }else{
            assert_eq!(next.outputs[0],holder.outputs[vout]);
            let tape=tbc_engine_core::protocols::coin::parse_tape(next.outputs[1].script_pubkey.as_bytes(),None).unwrap();
            assert_eq!(tape.balance,2500000);assert_eq!(tape.lock_time,if operation.ends_with("-freeze"){u32::MAX}else{0});
            assert_eq!(plan["plan"]["payload"]["preview"]["assetFlows"][0]["from"],recipient);
        }
        ancestor=holder;holder=next;
    }
}

#[test]
fn coin_explicit_admin_role_is_not_a_holder_or_pool_authorization() {
    let good=with_admin(create_input());
    for intent in [input(false)["request"]["intent"].clone(),input(true)["request"]["intent"].clone(),
        json!({"type":"tbc-amm-swap","version":"1.0","poolContractId":"11".repeat(32),"direction":"tbc-to-ft","amount":"100","minimumOutput":"0"})] {
        let mut request=good["request"].clone();request["intent"]=intent;
        assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":request}))["ok"],false);
    }
    for roles in [json!([]),json!([good["request"]["signingRoles"][0],good["request"]["signingRoles"][0]]),
        json!([{"role":"pool-controller","accountId":good["request"]["signingRoles"][0]["accountId"]}]),
        json!([{"role":"coin-admin","accountId":"tbc:foreign:1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP"}])] {
        let mut request=good["request"].clone();request["signingRoles"]=roles;
        assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":request}))["ok"],false);
    }
}

#[test]
fn coin_public_management_rejects_holder_without_administrator_authority() {
    let mut p=input(false);
    let target=p["snapshot"]["payload"]["utxos"][0].clone();
    let contract=p["request"]["intent"]["contractId"].clone();
    p["request"]["intent"]=json!({"type":"tbc20-stablecoin-freeze","version":"1.0","contractId":contract,
        "targetOutpoints":[{"txid":target["txid"],"vout":target["vout"]}],"lockTime":"4294967295"});
    p=bind(p);
    let result=call(EngineMethod::Plan,&p);assert_eq!(result["ok"],false);
    assert!(result["error"]["message"].as_str().unwrap().contains("administrator"));
}

#[test]
fn coin_public_creation_uses_approval_bound_schnorr_continuation() {
    let p=create_input();let plan=ok(EngineMethod::Plan,&p);
    assert_eq!(plan["plan"]["payload"]["preview"]["signingTaskCount"],4);
    assert_eq!(plan["plan"]["payload"]["transactions"][0]["role"],"prerequisite");
    let mut finalize=approved(&p,&plan);
    let mut check=finalize.clone();check["phase"]=json!("pre-sign");check.as_object_mut().unwrap().remove("signatures");
    let validation=ok(EngineMethod::Validate,&check);assert_eq!(validation["valid"],true,"{validation}");
    let pending=ok(EngineMethod::Finalize,&finalize);assert_eq!(pending["status"],"pending");
    let mut scalar=[0;32];scalar[31]=1;let key=SecretKey::from_byte_array(scalar).unwrap();let secp=Secp256k1::new();
    let pair=secp256k1::Keypair::from_secret_key(&secp,&key);
    let tasks=pending["signingRequests"].as_array().unwrap();assert_eq!(tasks.len(),3);
    assert_eq!(tasks.iter().map(|t|t["algorithm"].as_str().unwrap()).collect::<Vec<_>>(),vec!["secp256k1-schnorr-bip340","secp256k1-schnorr-bip340","secp256k1-ecdsa-sha256d"]);
    let signatures:Vec<_>=tasks.iter().map(|task|{
        assert_eq!(task["accountId"],p["snapshot"]["payload"]["account"]["accountId"]);
        let digest:[u8;32]=bytes(task["digest"].as_str().unwrap()).try_into().unwrap();
        let signature=if task["signatureEncoding"]=="schnorr64" {
            assert_eq!(task["publicKey"].as_str().unwrap(),&p["snapshot"]["payload"]["account"]["publicKey"].as_str().unwrap()[2..]);
            hex(secp.sign_schnorr_no_aux_rand(&digest,&pair).as_ref())
        }else{hex(&secp.sign_ecdsa(Message::from_digest(digest),&key).serialize_compact())};
        json!({"taskId":task["taskId"],"signatureEncoding":task["signatureEncoding"],"signature":signature})
    }).collect();
    finalize["continuation"]=pending["continuation"].clone();finalize["signatures"]=json!(signatures);
    let mut wrong=finalize.clone();wrong["signatures"][0]["signatureEncoding"]=json!("compact64");
    assert_eq!(call(EngineMethod::Finalize,&wrong)["ok"],false);
    let result=ok(EngineMethod::Finalize,&finalize);assert_eq!(result["bundle"]["transactions"].as_array().unwrap().len(),2);
    let source=Transaction::from_hex(result["bundle"]["transactions"][0]["rawTransaction"].as_str().unwrap()).unwrap();
    let mint=Transaction::from_hex(result["bundle"]["transactions"][1]["rawTransaction"].as_str().unwrap()).unwrap();
    let identity=tbc_engine_core::protocols::coin_identity::inspect_genesis(&mint.txid(),&mint.serialize(),&source.serialize()).unwrap();
    assert_eq!(identity.initial_supply,2500000);assert_eq!(identity.decimals,6);
    check=finalize.clone();check["phase"]=json!("pre-broadcast");check["bundle"]=result["bundle"].clone();
    assert_eq!(ok(EngineMethod::Validate,&check)["valid"],true);
    // Real creation uses the account as both x-only administrator and SEC
    // holder. Its first spend must use the shared mixed-algorithm signer.
    let mut transfer=input(false);let id=source.txid().to_string();
    transfer["request"]["intent"]["contractId"]=json!(id);
    transfer["request"]["intent"]["amount"]=json!("1");
    transfer["snapshot"]["payload"]["parents"]=json!([{"txid":id,"rawTransaction":source.to_hex()},
        {"txid":mint.txid().to_string(),"rawTransaction":mint.to_hex()}]);
    let fee=mint.outputs.len()-1;
    transfer["snapshot"]["payload"]["utxos"]=json!([{"txid":mint.txid().to_string(),"vout":3,"satoshis":"500",
        "scriptPubKey":hex(mint.outputs[3].script_pubkey.as_bytes()),"classification":"stablecoin","contractId":id,"confirmations":"0"},
        {"txid":mint.txid().to_string(),"vout":fee,"satoshis":mint.outputs[fee].satoshis.to_string(),
        "scriptPubKey":hex(mint.outputs[fee].script_pubkey.as_bytes()),"classification":"native","confirmations":"0"}]);
    let record=&mut transfer["snapshot"]["payload"]["contracts"][0];
    record["contractId"]=json!(id);record["creationTxid"]=json!(id);record["genesisOutpoint"]["txid"]=json!(id);
    record["currentOutpoint"]=json!({"txid":mint.txid().to_string(),"vout":3});transfer=bind(transfer);
    let plan=ok(EngineMethod::Plan,&transfer);let mut signed=approved(&transfer,&plan);
    let tasks=plan["plan"]["payload"]["signingTasks"].as_array().unwrap();
    assert_eq!(tasks[0]["signatureEncoding"],"schnorr64");assert_eq!(tasks[1]["signatureEncoding"],"compact64");
    signed["signatures"][0]["signatureEncoding"]=json!("schnorr64");
    signed["signatures"][0]["signature"]=json!(hex(secp.sign_schnorr_no_aux_rand(&bytes(tasks[0]["digest"].as_str().unwrap()),&pair).as_ref()));
    let mut validation=signed.clone();validation["phase"]=json!("pre-sign");validation.as_object_mut().unwrap().remove("signatures");
    let verdict=ok(EngineMethod::Validate,&validation);assert_eq!(verdict["valid"],true,"{verdict}");
    let moved=ok(EngineMethod::Finalize,&signed);validation=signed.clone();validation["phase"]=json!("pre-broadcast");validation["bundle"]=moved["bundle"].clone();
    let verdict=ok(EngineMethod::Validate,&validation);assert_eq!(verdict["valid"],true,"{verdict}");
    if let Ok(path)=std::env::var("COIN_OWNER_TRANSFER_REPORT") {
        std::fs::write(path,json!({"raws":[source.to_hex(),mint.to_hex(),moved["bundle"]["transactions"][0]["rawTransaction"]]}).to_string()).unwrap();
    }
}

#[test]
fn coin_public_creation_rejects_malformed_definition_policy_and_funding() {
    for case in 0..7 {
        let mut p=create_input();
        match case {
            0=>p["snapshot"]["payload"]["parents"]=json!([]),
            1=>p["snapshot"]["payload"]["utxos"][0]["satoshis"]=json!("999001"),
            2=>p["policy"]["payload"]["maxBundleTransactions"]=json!(1),
            3=>p["request"]["constraints"]["maxFee"]=json!("1"),
            4=>p["policy"]["payload"]["contractPolicies"][0]["allowedVersions"]=json!(["1.0"]),
            5=>p["policy"]["payload"]["amountLimits"]=json!([{"scope":"stablecoin-total","protocolVersion":"coin","maximum":"2499999"}]),
            _=>p["request"]["constraints"]["inputOutpoints"]=json!([{"txid":"ff".repeat(32),"vout":0}]),
        }
        p=bind(p);assert_eq!(call(EngineMethod::Plan,&p)["ok"],false,"case {case}");
    }
    for (field,value) in [("initialSupply",json!("9223372036854775808")),("name",json!("x".repeat(61))),
        ("decimals",json!(19)),("contractId",json!("11".repeat(32))),("receivers",json!([]))] {
        let mut p=create_input();p["request"]["intent"][field]=value;
        assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":p["request"]}))["ok"],false,"{field}");
    }
}

#[test]
fn coin_public_four_methods_bind_holder_transfer_merge_and_receivers() {
    for case in 0..4 {
        let mut p=input(case==1);
        if case==2 {p["request"]["intent"].as_object_mut().unwrap().remove("to");p["request"]["intent"].as_object_mut().unwrap().remove("amount");
            p["request"]["intent"]["receivers"]=json!([{"to":p["request"]["from"],"amount":"250"},{"to":p["request"]["from"],"amount":"300"}]);}
        if case==3 {p["request"]["intent"]["payment"]=json!({"to":p["request"]["from"],"amount":"24"});}
        p=bind(p);let plan=ok(EngineMethod::Plan,&p);let finalize=approved(&p,&plan);
        let mut check=finalize.clone();check["phase"]=json!("pre-sign");check.as_object_mut().unwrap().remove("signatures");
        assert_eq!(ok(EngineMethod::Validate,&check)["valid"],true);
        let result=ok(EngineMethod::Finalize,&finalize);
        check=finalize.clone();check["phase"]=json!("pre-broadcast");check["bundle"]=result["bundle"].clone();
        assert_eq!(ok(EngineMethod::Validate,&check)["valid"],true);
        if case<2 {assert_eq!(result["bundle"]["transactions"][0]["rawTransaction"],oracle()["vectors"][case]["signedRaw"]);}
    }
}

#[test]
fn coin_public_rejects_rehashed_wrong_identity_and_explicit_input_omissions() {
    for case in 0..8 {
        let mut p=input(false);
        match case {
            0=>p["snapshot"]["payload"]["contracts"][0]["genesisOutpoint"]["vout"]=json!(3),
            1=>p["snapshot"]["payload"]["contracts"][0]["standardId"]=json!("tbc20-standard"),
            2=>p["policy"]["payload"]["contractPolicies"][0]["allowedVersions"]=json!(["1.0"]),
            3=>p["snapshot"]["payload"]["utxos"][0]["satoshis"]=json!("501"),
            4=>{p["snapshot"]["payload"]["parents"].as_array_mut().unwrap().remove(0);},
            5=>p["request"]["constraints"]["maxFee"]=json!("1"),
            6=>p["request"]["constraints"]["inputOutpoints"]=json!([{"txid":p["snapshot"]["payload"]["utxos"][1]["txid"],"vout":5}]),
            _=>p["policy"]["payload"]["amountLimits"]=json!([{"scope":"stablecoin-total","protocolVersion":"coin","maximum":"999"}]),
        }
        p=bind(p);assert_eq!(call(EngineMethod::Plan,&p)["ok"],false,"case {case}");
    }
}

// A synthetic already-indexed holder parent, not a broadcast or full-node proof.
// Keep the original issuer/genesis so this exercises a spend lock, not issuance.
fn locked_holder(lock:u32)->Value {
    let mut p=input(true);
    let index=p["snapshot"]["payload"]["parents"].as_array().unwrap().len()-1;
    let mut parent=Transaction::from_hex(p["snapshot"]["payload"]["parents"][index]["rawTransaction"].as_str().unwrap()).unwrap();
    for vout in [1,3] {
        parent.outputs[vout].script_pubkey=tbc_sdk::script::Script::from_bytes(
            tbc_engine_core::protocols::coin::set_lock_time(parent.outputs[vout].script_pubkey.as_bytes(),lock).unwrap());
    }
    let id=parent.txid().to_string();
    p["snapshot"]["payload"]["parents"][index]=json!({"txid":id,"rawTransaction":parent.to_hex()});
    for u in p["snapshot"]["payload"]["utxos"].as_array_mut().unwrap() {u["txid"]=json!(id);}
    p["snapshot"]["payload"]["contracts"][0]["currentOutpoint"]["txid"]=json!(id);
    p["snapshot"]["payload"]["block"]["height"]=json!("100");
    p
}

#[test]
fn coin_public_lock_maturity_uses_bound_height_or_median_not_device_time() {
    for (lock,median,accepted) in [(100,None,true),(101,None,false),
        (500000100,None,false),(500000100,Some("500000100"),false),
        (500000100,Some("500000101"),true)] {
        let mut p=locked_holder(lock);
        if let Some(time)=median {p["snapshot"]["payload"]["block"]["medianTimePast"]=json!(time);}
        p=bind(p);
        let result=call(EngineMethod::Plan,&p);
        assert_eq!(result["ok"],accepted,"lock {lock}, median {median:?}: {result}");
        if !accepted {assert!(result.to_string().contains("Coin"));}
    }
}

#[test]
fn coin_public_skips_locked_candidates_but_never_replaces_explicit_inputs() {
    let mut p=locked_holder(101);
    let index=p["snapshot"]["payload"]["parents"].as_array().unwrap().len()-1;
    let mut parent=Transaction::from_hex(p["snapshot"]["payload"]["parents"][index]["rawTransaction"].as_str().unwrap()).unwrap();
    parent.outputs[3].script_pubkey=tbc_sdk::script::Script::from_bytes(
        tbc_engine_core::protocols::coin::set_lock_time(parent.outputs[3].script_pubkey.as_bytes(),0).unwrap());
    let id=parent.txid().to_string();
    p["snapshot"]["payload"]["parents"][index]=json!({"txid":id,"rawTransaction":parent.to_hex()});
    for u in p["snapshot"]["payload"]["utxos"].as_array_mut().unwrap() {u["txid"]=json!(id);}
    p["snapshot"]["payload"]["contracts"][0]["currentOutpoint"]["txid"]=json!(id);
    let contract=p["request"]["intent"]["contractId"].clone();
    p["request"]["intent"]=json!({"type":"tbc20-stablecoin-transfer","version":"1.0","contractId":contract,"to":p["request"]["from"],"amount":"500"});
    p=bind(p);let plan=ok(EngineMethod::Plan,&p);
    ok(EngineMethod::Finalize,&approved(&p,&plan));
    p["request"]["constraints"]["inputOutpoints"]=json!([{"txid":id,"vout":0},{"txid":id,"vout":4}]);
    p=bind(p);let result=call(EngineMethod::Plan,&p);
    assert_eq!(result["ok"],false);assert!(result.to_string().contains("explicitly selected input lock"));
}

#[test]
fn coin_public_accepts_testnet_and_rejects_cross_network_material() {
    let mut p=input(false);
    p["request"]["chainId"]=json!("tbc:testnet");
    p["snapshot"]["payload"]["chainId"]=json!("tbc:testnet");
    p["snapshot"]["payload"]["account"]["chainId"]=json!("tbc:testnet");
    p["policy"]["payload"]["chainId"]=json!("tbc:testnet");
    p=bind(p);assert_eq!(call(EngineMethod::Plan,&p)["ok"],true);
    p["snapshot"]["payload"]["account"]["chainId"]=json!("tbc:mainnet");
    p=bind(p);assert_eq!(call(EngineMethod::Plan,&p)["ok"],false);
}
