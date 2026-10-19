//! Public fixed SDK freeze/unfreeze fixtures; no key or custody in the Engine.
use serde_json::{Value,json};
use tbc_sdk::{Transaction,script::Script};
use tbc_engine_core::protocols::coin;

const FEE_KEY:&str="0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
fn call(op:&str,input:&Value)->Value {
    serde_json::from_str(&tbc_keyless_core::call(op,&input.to_string()).unwrap()).unwrap()
}
fn input_for(f:&Value,index:usize)->(Value,Transaction,Vec<String>) {
    let v=&f["cases"][index];
    let reference=Transaction::from_hex(v["signedRaw"].as_str().unwrap()).unwrap();
    let parent=Transaction::from_hex(v["parentRaw"].as_str().unwrap()).unwrap();
    let mut unsigned=reference.clone();
    for input in &mut unsigned.inputs{input.script_sig=Script::empty();}
    let mut signatures=Vec::new();
    let inputs=reference.inputs.iter().enumerate().map(|(vin,input)|{
        assert_eq!(input.previous_output.txid,parent.txid());
        let output=&parent.outputs[input.previous_output.vout as usize];
        let mut item=json!({"txId":parent.txid().to_string(),"outputIndex":input.previous_output.vout,
            "script":hex::encode(output.script_pubkey.as_bytes()),"satoshis":output.satoshis,"scriptSigType":"p2pkh"});
        if coin::parse_code(output.script_pubkey.as_bytes()).is_ok(){
            let proof=f["cases"].as_array().unwrap().iter().find(|p|p["signedRaw"]==v["signedRaw"]&&p["inputIndex"]==vin).unwrap();
            item["scriptSigType"]=json!("tbc20-stablecoin");item["preTx"]=v["parentRaw"].clone();
            item["ancestorTransactions"]=proof["ancestorsRaw"].clone();
            item["signingPublicKey"]=proof["publicKeyHex"].clone();
            signatures.push(proof["signatureHex"].as_str().unwrap().to_string());
        }else{
            let script=input.script_sig.as_bytes();let n=script[0]as usize;assert!(n<76);
            signatures.push(hex::encode(&script[1..1+n]));
        }item
    }).collect::<Vec<_>>();
    let resolved=parent.outputs.iter().enumerate().map(|(vout,o)|json!({"txid":parent.txid().to_string(),"vout":vout,
        "satoshis":o.satoshis.to_string(),"scriptPubKey":hex::encode(o.script_pubkey.as_bytes())})).collect::<Vec<_>>();
    (json!({"format":"associated","publicKey":FEE_KEY,"request":{"sourceTxraw":unsigned.to_hex(),
        "sourceUtxos":inputs,"inputs":[],"outputs":[]},"resolvedOutputs":resolved}),reference,signatures)
}

#[test]
fn reviewed_coin_admin_binds_per_input_public_algorithms_and_fixed_sdk_signatures(){
    let fixture:Value=serde_json::from_str(include_str!("../../../fixtures/coin-admin-proof.json")).unwrap();
    let mut rows=Vec::new();
    for index in [0,2]{
        let (input,reference,signatures)=input_for(&fixture,index);
        let stage=call("prepareReviewedStage",&input);
        let tasks=stage["signingTasks"].as_array().expect("explicit public task bindings");
        assert_eq!(tasks.len(),reference.inputs.len());
        for (vin,task) in tasks.iter().enumerate(){
            assert_eq!(task["inputIndex"],vin);assert_eq!(task["digest"],stage["digests"][vin]);
            let key=&input["request"]["sourceUtxos"][vin]["signingPublicKey"];
            assert_eq!(task["publicKey"],if key.is_null(){json!(FEE_KEY)}else{key.clone()});
            assert_eq!(task["algorithm"],if key.is_null(){"secp256k1-ecdsa"}else{"secp256k1-schnorr"});
        }
        let finish=json!({"stage":stage,"signatures":signatures});
        let result=call("finalizeReviewedStage",&finish);
        assert_eq!(result["txraw"],reference.to_hex());assert_eq!(result["txid"],reference.txid().to_string());
        let mut compact=finish.clone();
        compact["signatureEncoding"]=json!("compact64");
        for (vin,signature) in signatures.iter().enumerate(){
            let bytes=hex::decode(signature).unwrap();
            compact["signatures"][vin]=json!(if tasks[vin]["algorithm"]=="secp256k1-schnorr"{
                hex::encode(&bytes[..64])
            }else{hex::encode(k256::ecdsa::Signature::from_der(&bytes[..bytes.len()-1]).unwrap().to_bytes())});
        }
        assert_eq!(call("finalizeReviewedStage",&compact),result);
        // Binding fields are recomputed, never accepted because a signature verifies somewhere.
        for field in ["inputIndex","digest","publicKey","algorithm"]{
            let mut bad=finish.clone();bad["stage"]["signingTasks"][0][field]=match field{
                "inputIndex"=>json!(99),"digest"=>json!("11".repeat(32)),"publicKey"=>json!(FEE_KEY),_=>json!("secp256k1-ecdsa")};
            assert!(tbc_keyless_core::call("finalizeReviewedStage",&bad.to_string()).is_err(),"{field}");
        }
        let mut absent=finish.clone();absent["stage"].as_object_mut().unwrap().remove("signingTasks");
        assert!(tbc_keyless_core::call("finalizeReviewedStage",&absent.to_string()).is_err());
        let mut wrong=finish.clone();wrong["signatures"].as_array_mut().unwrap().swap(0,signatures.len()-1);
        assert!(tbc_keyless_core::call("finalizeReviewedStage",&wrong.to_string()).is_err());
        for signature in ["00".repeat(65),"00".repeat(64),format!("{}42",&signatures[0][..128])]{
            let mut bad=finish.clone();bad["signatures"][0]=json!(signature);
            assert!(tbc_keyless_core::call("finalizeReviewedStage",&bad.to_string()).is_err());
        }
        for bad_key in [FEE_KEY.to_string(),"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798".to_string(),"ff".repeat(32)]{
            let mut bad=input.clone();bad["request"]["sourceUtxos"][0]["signingPublicKey"]=json!(bad_key);
            assert!(tbc_keyless_core::call("prepareReviewedStage",&bad.to_string()).is_err());
        }
        let mut fee_override=input.clone();let last=reference.inputs.len()-1;
        fee_override["request"]["sourceUtxos"][last]["signingPublicKey"]=fixture["cases"][index]["publicKeyHex"].clone();
        assert!(tbc_keyless_core::call("prepareReviewedStage",&fee_override.to_string()).is_err());
        rows.push(json!({"id":if index==0{"freeze"}else{"unfreeze"},"prepare":input,"stage":stage,"finalize":finish,"result":result}));
    }
    // The SDK's unfreeze spends freeze's finalized outputs. Public child role
    // metadata must not inherit the frozen holder's u32::MAX absolute lock.
    let (mut chain,_,freeze_signatures)=input_for(&fixture,0);
    let (unfreeze,reference,unfreeze_signatures)=input_for(&fixture,2);
    let mut children=unfreeze["request"]["sourceUtxos"].clone();
    for input in children.as_array_mut().unwrap(){
        for field in ["txId","preTx","ancestorTransactions","script","satoshis"]{input.as_object_mut().unwrap().remove(field);}
    }
    chain["request"]["inputs"]=json!([children]);
    chain["request"]["outputs"]=json!([reference.outputs.iter().map(|o|json!({"satoshis":o.satoshis,"script":hex::encode(o.script_pubkey.as_bytes())})).collect::<Vec<_>>()]);
    let first=call("prepareReviewedStage",&chain);
    let parent=call("finalizeReviewedStage",&json!({"stage":first,"signatures":freeze_signatures}));
    chain["transactionIndex"]=json!(1);chain["previousTransactions"]=json!([parent["txraw"]]);
    let stage=call("prepareReviewedStage",&chain);
    assert_eq!(Transaction::from_hex(stage["txraw"].as_str().unwrap()).unwrap().lock_time,0);
    let finish=json!({"stage":stage,"signatures":unfreeze_signatures});
    let result=call("finalizeReviewedStage",&finish);
    assert_eq!(result["txraw"],reference.to_hex());
    let mut unauthorized=chain.clone();unauthorized["request"]["inputs"][0][0]["signingPublicKey"]=json!(FEE_KEY);
    assert!(tbc_keyless_core::call("prepareReviewedStage",&unauthorized.to_string()).is_err());
    rows.push(json!({"id":"unfreeze-child","prepare":chain,"stage":stage,"finalize":finish,"result":result}));
    if let Ok(path)=std::env::var("TBC_REVIEWED_ADMIN_OUTPUT"){
        std::fs::write(path,serde_json::to_vec(&json!({"fixtureOnly":true,"network":false,"rows":rows})).unwrap()).unwrap();
    }
}

#[test]
fn reviewed_raw_coin_admin_returns_bound_detached_signatures_without_changing_raw(){
    let fixture:Value=serde_json::from_str(include_str!("../../../fixtures/coin-admin-proof.json")).unwrap();
    let mut rows=Vec::new();
    for index in [0,2]{
        let (associated,reference,signatures)=input_for(&fixture,index);
        let inputs=associated["request"]["sourceUtxos"].as_array().unwrap();
        let keys=inputs.iter().map(|i|i["signingPublicKey"].clone()).collect::<Vec<_>>();
        let raw=associated["request"]["sourceTxraw"].clone();
        let request=json!({"format":"raw","publicKey":FEE_KEY,"resolvedOutputs":associated["resolvedOutputs"],
            "request":{"txraws":[raw],"utxos_satoshis":[inputs.iter().map(|i|i["satoshis"].clone()).collect::<Vec<_>>()],
                "script_pubkeys":[inputs.iter().map(|i|i["script"].clone()).collect::<Vec<_>>()],"signingPublicKeys":[keys]}});
        let stage=call("prepareReviewedStage",&request);
        let expected=call("prepareReviewedStage",&associated);
        assert_eq!(stage["signingTasks"],expected["signingTasks"]);
        assert_eq!(stage["digests"],expected["digests"]);
        let finish=json!({"stage":stage,"signatures":signatures});
        let result=call("finalizeReviewedStage",&finish);
        assert_eq!(result["txraw"],raw,"raw must never synthesize witnesses");
        assert_eq!(result["sigs"],json!(signatures));
        assert_ne!(result["txraw"],reference.to_hex());
        for value in [json!([]),json!([[null]]),json!([[FEE_KEY]])]{
            let mut bad=request.clone();bad["request"]["signingPublicKeys"]=value;
            assert!(tbc_keyless_core::call("prepareReviewedStage",&bad.to_string()).is_err());
        }
        for vin in [0,inputs.len()-1]{
            let mut bad=request.clone();bad["request"]["signingPublicKeys"][0][vin]=json!(FEE_KEY);
            assert!(tbc_keyless_core::call("prepareReviewedStage",&bad.to_string()).is_err(),"key override {vin}");
        }
        for field in ["inputIndex","digest","publicKey","algorithm"]{
            let mut bad=finish.clone();bad["stage"]["signingTasks"][0][field]=json!("tampered");
            assert!(tbc_keyless_core::call("finalizeReviewedStage",&bad.to_string()).is_err());
        }
        let mut bad=finish.clone();bad["stage"]["inputs"][0]["signingPublicKey"]=json!(FEE_KEY);
        assert!(tbc_keyless_core::call("finalizeReviewedStage",&bad.to_string()).is_err());
        let mut bad=finish.clone();bad["signatures"].as_array_mut().unwrap().swap(0,inputs.len()-1);
        assert!(tbc_keyless_core::call("finalizeReviewedStage",&bad.to_string()).is_err());
        let mut compact=finish.clone();compact["signatureEncoding"]=json!("compact64");
        for (vin,text) in signatures.iter().enumerate(){
            let bytes=hex::decode(text).unwrap();compact["signatures"][vin]=json!(
                if stage["signingTasks"][vin]["algorithm"]=="secp256k1-schnorr"{hex::encode(&bytes[..64])}
                else{hex::encode(k256::ecdsa::Signature::from_der(&bytes[..bytes.len()-1]).unwrap().to_bytes())});
        }
        assert_eq!(call("finalizeReviewedStage",&compact),result);
        for bad_signature in ["00".repeat(64),"00".repeat(65),format!("{}42",&signatures[0][..128])]{
            let mut bad=finish.clone();bad["signatures"][0]=json!(bad_signature);
            assert!(tbc_keyless_core::call("finalizeReviewedStage",&bad.to_string()).is_err());
        }
        let mut wrong_format=finish.clone();wrong_format["stage"]["format"]=json!("associated");
        assert!(tbc_keyless_core::call("finalizeReviewedStage",&wrong_format.to_string()).is_err());
        rows.push(json!({"id":if index==0{"raw-freeze"}else{"raw-unfreeze"},"prepare":request,"stage":stage,
            "finalize":finish,"compact":compact,"result":result,"associated":associated,"referenceRaw":reference.to_hex()}));
    }
    if let Ok(path)=std::env::var("TBC_REVIEWED_RAW_ADMIN_OUTPUT"){
        std::fs::write(path,serde_json::to_vec(&json!({"fixtureOnly":true,"network":false,"rows":rows})).unwrap()).unwrap();
    }
}

#[test]
fn reviewed_raw_coin_admin_also_binds_compressed_ecdsa_keys(){
    use k256::ecdsa::{SigningKey,Signature,signature::hazmat::PrehashSigner};
    // Explicit public synthetic scalars, never custody or a real account.
    let fee=SigningKey::from_slice(&hex::decode(format!("{:064x}",1)).unwrap()).unwrap();
    let admin=SigningKey::from_slice(&hex::decode(format!("{:064x}",2)).unwrap()).unwrap();
    let public=admin.verifying_key().to_encoded_point(true);
    let replace=|script:&[u8]|{
        if let Ok(mut code)=coin::parse_code(script){code.admin_pubkey_hash=tbc_sdk::hash::hash160(public.as_bytes());coin::instantiate_code(&code).unwrap()}
        else{script.to_vec()}
    };
    let fixture:Value=serde_json::from_str(include_str!("../../../fixtures/coin-admin-proof.json")).unwrap();
    let (mut associated,_,_)=input_for(&fixture,0);
    let mut tx=Transaction::from_hex(associated["request"]["sourceTxraw"].as_str().unwrap()).unwrap();
    for output in &mut tx.outputs{output.script_pubkey=Script::from_bytes(replace(output.script_pubkey.as_bytes()));}
    for output in associated["resolvedOutputs"].as_array_mut().unwrap(){
        output["scriptPubKey"]=json!(hex::encode(replace(&hex::decode(output["scriptPubKey"].as_str().unwrap()).unwrap())));
    }
    let inputs=associated["request"]["sourceUtxos"].as_array().unwrap();
    let scripts=inputs.iter().map(|i|hex::encode(replace(&hex::decode(i["script"].as_str().unwrap()).unwrap()))).collect::<Vec<_>>();
    let keys=inputs.iter().map(|i|if i["signingPublicKey"].is_null(){Value::Null}else{json!(hex::encode(public.as_bytes()))}).collect::<Vec<_>>();
    let request=json!({"format":"raw","publicKey":FEE_KEY,"resolvedOutputs":associated["resolvedOutputs"],
        "request":{"txraws":[tx.to_hex()],"utxos_satoshis":[inputs.iter().map(|i|i["satoshis"].clone()).collect::<Vec<_>>()],
            "script_pubkeys":[scripts],"signingPublicKeys":[keys]}});
    let stage=call("prepareReviewedStage",&request);
    let signatures=stage["signingTasks"].as_array().unwrap().iter().map(|task|{
        assert_eq!(task["algorithm"],"secp256k1-ecdsa");
        let signer=if task["publicKey"]==FEE_KEY{&fee}else{assert_eq!(task["publicKey"],hex::encode(public.as_bytes()));&admin};
        let signature:Signature=signer.sign_prehash(&hex::decode(task["digest"].as_str().unwrap()).unwrap()).unwrap();
        hex::encode(signature.normalize_s().unwrap_or(signature).to_bytes())
    }).collect::<Vec<_>>();
    let finish=json!({"stage":stage,"signatures":signatures,"signatureEncoding":"compact64"});
    let result=call("finalizeReviewedStage",&finish);assert_eq!(result["txraw"],tx.to_hex());
    let mut bad=finish.clone();bad["signatures"].as_array_mut().unwrap().swap(0,inputs.len()-1);
    assert!(tbc_keyless_core::call("finalizeReviewedStage",&bad.to_string()).is_err());
    if let Ok(path)=std::env::var("TBC_REVIEWED_ECDSA_ADMIN_OUTPUT"){
        // Synthetic script substitution proves task/role binding only, not a
        // valid issuance ancestry or a spend accepted by the chain script VM.
        std::fs::write(path,serde_json::to_vec(&json!({"fixtureOnly":true,"network":false,
            "chainValidity":false,"rows":[{"id":"raw-ecdsa-freeze","prepare":request,
            "stage":stage,"finalize":finish,"result":result}]})).unwrap()).unwrap();
    }
}
