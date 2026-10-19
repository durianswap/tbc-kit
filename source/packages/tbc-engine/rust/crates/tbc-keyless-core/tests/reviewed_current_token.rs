use std::{collections::{BTreeMap,BTreeSet},io::Write};
use serde_json::{Value,json};
use secp256k1::{Secp256k1,SecretKey,Message};
use tbc_sdk::{Transaction,TxIn,TxOut,OutPoint,Txid,script::Script};
use tbc_engine_core::protocols::{coin,coin_proof,tbc20,tbc20_material};

fn call(op:&str,input:&Value)->Value{
    serde_json::from_str(&tbc_keyless_core::call(op,&input.to_string()).unwrap()).unwrap()
}
fn signed(stage:&Value,alternate:bool)->Value{
    let mut secret=[0u8;32];secret[31]=1;let key=SecretKey::from_byte_array(secret).unwrap();let secp=Secp256k1::new();
    let sigs=stage["digests"].as_array().unwrap().iter().map(|d|{
        let bytes:[u8;32]=hex::decode(d.as_str().unwrap()).unwrap().try_into().unwrap();let message=Message::from_digest(bytes);
        let sig=if alternate{secp.sign_ecdsa_with_noncedata(message,&key,&[42u8;32])}else{secp.sign_ecdsa(message,&key)};
        hex::encode(sig.serialize_der())+"41"
    }).collect::<Vec<_>>();json!({"stage":stage,"signatures":sigs})
}
struct Case { id:String, reference:Transaction, parents:BTreeMap<String,Transaction>, public:String }
fn cases()->Vec<Case>{
    let fixture:Value=serde_json::from_str(include_str!("../../../fixtures/coin-proof.json")).unwrap();
    let token:Value=serde_json::from_str(include_str!("../../../fixtures/tbc20-standard-transfer.json")).unwrap();
    let mut result=Vec::new();
    for v in fixture["vectors"].as_array().unwrap(){
        let raws=std::iter::once(v["parentRaw"].as_str().unwrap()).chain(v["ancestorsRaw"].as_array().unwrap().iter().map(|v|v.as_str().unwrap()));
        result.push(Case{id:v["id"].as_str().unwrap().into(),reference:Transaction::from_hex(v["signedRaw"].as_str().unwrap()).unwrap(),
            parents:raws.map(|raw|{let tx=Transaction::from_hex(raw).unwrap();(tx.txid().to_string(),tx)}).collect(),public:v["publicKeyHex"].as_str().unwrap().into()});
    }
    let stages=token["stages"].as_array().unwrap();
    for n in 2..stages.len(){result.push(Case{id:format!("token-{}",stages[n]["id"].as_str().unwrap()),
        reference:Transaction::from_hex(stages[n]["signedRaw"].as_str().unwrap()).unwrap(),
        parents:stages[..n].iter().map(|s|{let tx=Transaction::from_hex(s["signedRaw"].as_str().unwrap()).unwrap();(tx.txid().to_string(),tx)}).collect(),
        public:token["request"]["publicKeyHex"].as_str().unwrap().into()});}result
}
fn request(case:&Case)->Value{
    let mut tx=case.reference.clone();for i in &mut tx.inputs{i.script_sig=Script::empty();}
    let inputs=tx.inputs.iter().map(|i|{
        let parent=&case.parents[&i.previous_output.txid.to_string()];let raw=parent.serialize();let output=&parent.outputs[i.previous_output.vout as usize];
        let script=output.script_pubkey.as_bytes();
        let mut item=json!({"txId":parent.txid().to_string(),"outputIndex":i.previous_output.vout,"script":hex::encode(script),"satoshis":output.satoshis,"scriptSigType":"p2pkh"});
        let (profile,ids)=if coin::parse_code(script).is_ok(){
            let p=coin_proof::inspect_parent(&raw,&i.previous_output,None).unwrap();
            ("tbc20-stablecoin",p.dependencies().iter().map(|d|d.txid.to_string()).collect::<BTreeSet<_>>())
        }else if tbc20::parse_code(script).is_ok(){
            let p=tbc20_material::inspect_parent(&raw,&i.previous_output,None).unwrap();
            ("tbc20-standard",p.dependencies().iter().map(|d|d.outpoint.txid.to_string()).collect::<BTreeSet<_>>())
        }else{return item;};
        item["scriptSigType"]=json!(profile);item["preTx"]=json!(parent.to_hex());
        item["ancestorTransactions"]=json!(ids.iter().map(|id|case.parents[id].to_hex()).collect::<Vec<_>>());item
    }).collect::<Vec<_>>();
    json!({"sourceTxraw":tx.to_hex(),"sourceUtxos":inputs,"inputs":[],"outputs":[]})
}
fn prepare(case:&Case,request:Value)->Value{
    let outputs=case.parents.values().flat_map(|p|p.outputs.iter().enumerate().map(move |(vout,o)|json!({"txid":p.txid().to_string(),"vout":vout,
        "satoshis":o.satoshis.to_string(),"scriptPubKey":hex::encode(o.script_pubkey.as_bytes())}))).collect::<Vec<_>>();
    json!({"format":"associated","publicKey":case.public,"request":request,"resolvedOutputs":outputs})
}
fn reject(op:&str,input:Value,label:&str,failures:&mut Vec<Value>){
    let error=tbc_keyless_core::call(op,&input.to_string()).expect_err(label);
    failures.push(json!({"label":label,"operation":op,"input":input,"error":error}));
}

#[test]
fn current_associated_shared_proofs_and_finalized_parent_continuation(){
    let cases=cases();let mut rows=Vec::new();let mut failures=Vec::new();let mut source_inputs=0;
    for case in &cases{
        let input=prepare(case,request(case));let stage=call("prepareReviewedStage",&input);let finish=signed(&stage,false);
        let result=call("finalizeReviewedStage",&finish);assert_eq!(result["txraw"],case.reference.to_hex(),"{}",case.id);
        source_inputs+=case.reference.inputs.len();
        rows.push(json!({"id":case.id,"prepare":input,"stage":stage,"finalize":finish,"result":result,"parents":case.parents.values().map(Transaction::to_hex).collect::<Vec<_>>()}));
        let index=input["request"]["sourceUtxos"].as_array().unwrap().iter().position(|i|i["scriptSigType"]!="p2pkh").unwrap();
        for label in ["missing-ancestors","duplicate-ancestor","unrelated-ancestor","wrong-parent","wrong-amount","wrong-script","wrong-profile","template-override","context-override","contract-override","version-override","wrong-key"]{
            let mut bad=input.clone();let item=&mut bad["request"]["sourceUtxos"][index];
            match label{
                "missing-ancestors"=>{item.as_object_mut().unwrap().remove("ancestorTransactions");},
                "duplicate-ancestor"=>{let first=item["ancestorTransactions"][0].clone();item["ancestorTransactions"].as_array_mut().unwrap().push(first);},
                "unrelated-ancestor"=>item["ancestorTransactions"].as_array_mut().unwrap().push(json!(case.reference.to_hex())),
                "wrong-parent"=>item["preTx"]=json!(case.reference.to_hex()),
                "wrong-amount"=>item["satoshis"]=json!(499),
                "wrong-script"=>item["script"]=json!("51"),
                "wrong-profile"=>item["scriptSigType"]=json!(if item["scriptSigType"]=="tbc20-standard"{"tbc20-stablecoin"}else{"tbc20-standard"}),
                "template-override"=>item["unfinishedScriptSig"]=json!("097369676e6174757265"),
                "context-override"=>item["prePreTxData"]=json!("00"),
                "contract-override"=>item["contractTx"]=json!(case.reference.to_hex()),
                "version-override"=>item["ftVersion"]=json!(1),
                "wrong-key"=>bad["publicKey"]=json!("02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"),
                _=>unreachable!(),
            }reject("prepareReviewedStage",bad,&format!("{}:{label}",case.id),&mut failures);
        }
        let mut altered=finish.clone();altered["stage"]["inputs"][index]["unfinishedScriptSig"]=json!("097369676e6174757265");
        reject("finalizeReviewedStage",altered,"finalize-witness-override",&mut failures);
        let mut wrong_signature=finish.clone();let mut wire=hex::decode(wrong_signature["signatures"][index].as_str().unwrap()).unwrap();wire[10]^=1;
        wrong_signature["signatures"][index]=json!(hex::encode(wire));
        reject("finalizeReviewedStage",wrong_signature,"finalize-current-signature",&mut failures);
    }
    assert_eq!(source_inputs,15);
    // Source transfer -> dependent merge: all prevouts come from the finalized
    // transfer, and all proofs must be rebuilt after a different valid signature
    // changes that parent's txid. The public outputs/approval shape stay fixed.
    for (source,child) in [(&cases[0],&cases[1]),(&cases[4],&cases[5])]{
    let child_request=request(child);let mut req=request(source);
    let mut children=child_request["sourceUtxos"].as_array().unwrap().clone();
    for item in &mut children{
        assert_eq!(item["txId"],source.reference.txid().to_string());
        for key in ["txId","script","satoshis","preTx","ancestorTransactions"]{item.as_object_mut().unwrap().remove(key);}
    }
    req["inputs"]=json!([children]);req["outputs"]=json!([child.reference.outputs.iter().map(|o|json!({"satoshis":o.satoshis,"script":hex::encode(o.script_pubkey.as_bytes())})).collect::<Vec<_>>()]);
    let base=prepare(source,req);
    for alternate in [false,true]{
        let stage=call("prepareReviewedStage",&base);let finish=signed(&stage,alternate);let first=call("finalizeReviewedStage",&finish);
        let parent=Transaction::from_hex(first["txraw"].as_str().unwrap()).unwrap();
        assert_eq!(parent.txid()==source.reference.txid(),!alternate);
        let mut second=base.clone();second["transactionIndex"]=json!(1);second["previousTransactions"]=json!([parent.to_hex()]);
        let next=call("prepareReviewedStage",&second);let final_input=signed(&next,false);let result=call("finalizeReviewedStage",&final_input);
        let final_tx=Transaction::from_hex(result["txraw"].as_str().unwrap()).unwrap();
        assert!(final_tx.inputs.iter().all(|i|i.previous_output.txid==parent.txid()));
        if !alternate{assert_eq!(final_tx.to_hex(),child.reference.to_hex());}
        rows.push(json!({"id":format!("{}-parent-{alternate}",source.id),"prepare":base,"stage":stage,"finalize":finish,"result":first,
            "parents":source.parents.values().map(Transaction::to_hex).collect::<Vec<_>>()}));
        rows.push(json!({"id":format!("{}-child-{alternate}",source.id),"prepare":second,"stage":next,"finalize":final_input,"result":result,"parents":[parent.to_hex()]}));
        let mut changed=second.clone();let mut tampered=parent.clone();tampered.outputs[0].satoshis+=1;changed["previousTransactions"]=json!([tampered.to_hex()]);
        reject("prepareReviewedStage",changed,"finalized-parent-shape",&mut failures);
    }
    }
    assert_eq!(rows.len(),14);assert_eq!(failures.len(),88);
    // A holder may receive a nonzero Coin lock. Its dependent merge must
    // derive nLockTime from those actual parent outputs, not default to zero.
    // Public synthetic keys only; script-level validity is not chain maturity.
    for (domain, locks) in [("height", [41u32,72]), ("time", [1_790_000_000,1_790_000_072])] {
        let source=&cases[0];let child=&cases[1];let mut req=request(source);
        let mut tx=Transaction::from_hex(req["sourceTxraw"].as_str().unwrap()).unwrap();
        let tapes=tx.outputs.iter().enumerate().filter(|(_,o)|coin::parse_tape(o.script_pubkey.as_bytes(),None).is_ok()).map(|(i,_)|i).collect::<Vec<_>>();
        assert_eq!(tapes.len(),2);
        for (index, lock) in tapes.into_iter().zip(locks) {
            tx.outputs[index].script_pubkey=Script::from_bytes(coin::set_lock_time(tx.outputs[index].script_pubkey.as_bytes(),lock).unwrap());
        }
        req["sourceTxraw"]=json!(tx.to_hex());
        let mut children=request(child)["sourceUtxos"].as_array().unwrap().clone();
        for item in &mut children {for k in ["txId","script","satoshis","preTx","ancestorTransactions"]{item.as_object_mut().unwrap().remove(k);}}
        req["inputs"]=json!([children]);
        req["outputs"]=json!([child.reference.outputs.iter().map(|o|json!({"satoshis":o.satoshis,"script":hex::encode(o.script_pubkey.as_bytes())})).collect::<Vec<_>>()]);
        let base=prepare(source,req);
        for alternate in [false,true] {
            let stage=call("prepareReviewedStage",&base);let finish=signed(&stage,alternate);let first=call("finalizeReviewedStage",&finish);
            let mut next_input=base.clone();next_input["transactionIndex"]=json!(1);next_input["previousTransactions"]=json!([first["txraw"]]);
            let next=call("prepareReviewedStage",&next_input);
            let next_tx=Transaction::from_hex(next["txraw"].as_str().unwrap()).unwrap();
            assert_eq!(next_tx.lock_time,locks[1],"dependent Coin {domain} lock");
            let final_input=signed(&next,false);let result=call("finalizeReviewedStage",&final_input);
            rows.push(json!({"id":format!("coin-lock-{domain}-source-{alternate}"),"prepare":base,"stage":stage,"finalize":finish,"result":first,
                "parents":source.parents.values().map(Transaction::to_hex).collect::<Vec<_>>()}));
            rows.push(json!({"id":format!("coin-lock-{domain}-child-{alternate}"),"prepare":next_input,"stage":next,"finalize":final_input,"result":result,"parents":[first["txraw"]]}));
            for sequence in [false,true] {
                let mut bad=final_input.clone();let mut bad_tx=next_tx.clone();
                if sequence {bad_tx.inputs[0].sequence=u32::MAX;} else {bad_tx.lock_time=locks[0];}
                bad["stage"]["txraw"]=json!(bad_tx.to_hex());
                reject("finalizeReviewedStage",bad,"coin-child-lock-or-sequence-tamper",&mut failures);
            }
        }
    }
    // Mixed domains cannot be represented by one nLockTime. Reject before
    // exposing even the source digest, rather than halfway through signing.
    let mut mixed=rows.iter().find(|r|r["id"]=="coin-lock-height-source-false").unwrap()["prepare"].clone();
    let mut mixed_tx=Transaction::from_hex(mixed["request"]["sourceTxraw"].as_str().unwrap()).unwrap();
    let tape_index=mixed_tx.outputs.iter().position(|o|coin::parse_tape(o.script_pubkey.as_bytes(),None).is_ok()).unwrap();
    mixed_tx.outputs[tape_index].script_pubkey=Script::from_bytes(coin::set_lock_time(mixed_tx.outputs[tape_index].script_pubkey.as_bytes(),1_790_000_000).unwrap());
    mixed["request"]["sourceTxraw"]=json!(mixed_tx.to_hex());
    reject("prepareReviewedStage",mixed,"coin-child-mixed-lock-domains",&mut failures);
    assert_eq!(rows.len(),22);assert_eq!(failures.len(),97);
    // A separate fee parent plus already-existing locked Coin inputs. Unlike
    // the local-chain cases, the child must authenticate external preTx bytes.
    // Funding is synthetic public material, disjoint from the Coin ancestry.
    for domain in ["height","time"] {
        let prior=rows.iter().find(|r|r["id"]==format!("coin-lock-{domain}-child-false")).unwrap().clone();
        let coin_parent=Transaction::from_hex(prior["parents"][0].as_str().unwrap()).unwrap();
        let fee_script=cases[1].reference.outputs.last().unwrap().script_pubkey.clone();
        let mut funding=Transaction::new();
        funding.inputs.push(TxIn::new(OutPoint{txid:Txid::from_le_bytes([0x56;32]),vout:0}));
        funding.outputs.push(TxOut{satoshis:100_000,script_pubkey:fee_script.clone()});
        let mut source=Transaction::new();source.inputs.push(TxIn::new(OutPoint{txid:funding.txid(),vout:0}));
        source.outputs.push(TxOut{satoshis:99_900,script_pubkey:fee_script.clone()});
        let mut children=Vec::new();
        for item in prior["stage"]["inputs"].as_array().unwrap(){
            if item["scriptSigType"]=="p2pkh" {children.push(json!({"outputIndex":0,"scriptSigType":"p2pkh"}));}
            else {let mut out=serde_json::Map::new();
                for k in ["txId","script","satoshis","outputIndex","scriptSigType","preTx","ancestorTransactions"]{out.insert(k.into(),item[k].clone());}
                children.push(Value::Object(out));}
        }
        let mut outputs=prior["prepare"]["request"]["outputs"][0].as_array().unwrap().clone();
        outputs.last_mut().unwrap()["satoshis"]=json!(98_500);
        let req=json!({"sourceTxraw":source.to_hex(),"sourceUtxos":[{"txId":funding.txid().to_string(),"outputIndex":0,
            "script":hex::encode(fee_script.as_bytes()),"satoshis":100_000,"scriptSigType":"p2pkh"}],"inputs":[children],"outputs":[outputs]});
        let mut parents=cases[0].parents.clone();parents.insert(coin_parent.txid().to_string(),coin_parent);parents.insert(funding.txid().to_string(),funding);
        let case=Case{id:format!("coin-external-{domain}"),reference:source,parents,public:cases[0].public.clone()};
        let base=prepare(&case,req);
        let stage=call("prepareReviewedStage",&base);let finish=signed(&stage,false);let first=call("finalizeReviewedStage",&finish);
        let mut child=base.clone();child["transactionIndex"]=json!(1);child["previousTransactions"]=json!([first["txraw"]]);
        let next=call("prepareReviewedStage",&child);let final_input=signed(&next,false);let result=call("finalizeReviewedStage",&final_input);
        assert_eq!(Transaction::from_hex(next["txraw"].as_str().unwrap()).unwrap().lock_time,
            Transaction::from_hex(prior["stage"]["txraw"].as_str().unwrap()).unwrap().lock_time);
        let parent_raws=case.parents.values().map(Transaction::to_hex).collect::<Vec<_>>();
        rows.push(json!({"id":format!("coin-external-{domain}-source"),"prepare":base,"stage":stage,"finalize":finish,"result":first,"parents":parent_raws}));
        let mut child_parents=parent_raws;child_parents.push(first["txraw"].as_str().unwrap().into());
        rows.push(json!({"id":format!("coin-external-{domain}-child"),"prepare":child,"stage":next,"finalize":final_input,"result":result,"parents":child_parents}));
        for label in ["missing-external-parent","external-parent-id","external-value","external-script"] {
            let mut bad=base.clone();let input=&mut bad["request"]["inputs"][0][0];
            match label {
                "missing-external-parent"=>{input.as_object_mut().unwrap().remove("preTx");},
                "external-parent-id"=>input["txId"]=json!("00".repeat(32)),
                "external-value"=>input["satoshis"]=json!(499),
                _=>input["script"]=json!("51"),
            }
            reject("prepareReviewedStage",bad,label,&mut failures);
        }
    }
    assert_eq!(rows.len(),26);assert_eq!(failures.len(),105);
    if let Ok(path)=std::env::var("TBC_CURRENT_ASSOCIATED_OUTPUT"){
        let mut file=std::fs::OpenOptions::new().create_new(true).write(true).open(path).unwrap();
        let evidence=json!({"status":"PASS_NATIVE_CURRENT_ASSOCIATED","publicFixtureOnly":true,"sourceInputs":source_inputs,"rows":rows,"failures":failures,
            "actualHttp":0,"broadcast":0,"deviceAcceptance":false});
        file.write_all(serde_json::to_string(&evidence).unwrap().as_bytes()).unwrap();
    }
}
