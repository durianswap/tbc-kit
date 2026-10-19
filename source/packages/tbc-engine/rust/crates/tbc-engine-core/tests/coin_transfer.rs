use tbc_engine_core::{ErrorCode, protocols::{coin, coin_proof, coin_transfer::{
    CoinInput, FeeInput, Receiver, TransferOptions, build_transfer_plan, build_merge_plan,
}}, signing::{ExternalSignature, StageOutcome, begin_signing, finalize_signing_stage}};
use tbc_sdk::{OutPoint, PublicKey, Transaction, script::Script};
fn fixture()->serde_json::Value {serde_json::from_str(include_str!("../../../fixtures/coin-proof.json")).unwrap()}
fn bytes(s:&str)->Vec<u8> {(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
fn hex(data:&[u8])->String {data.iter().map(|b|format!("{b:02x}")).collect()}
fn tx(v:&serde_json::Value)->Transaction {Transaction::from_hex(v.as_str().unwrap()).unwrap()}
fn controller(key:&PublicKey)->[u8;21] {let mut result=[0;21];result[..20].copy_from_slice(&key.hash160());result}

#[test]
fn coin_holder_builder_matches_sdk_transfer_merge_respend_and_maximum_fee() {
    let f=fixture(); let key=PublicKey::from_slice(&bytes(f["vectors"][0]["publicKeyHex"].as_str().unwrap())).unwrap();
    for (index,amount) in [(0usize,250),(1,1000),(3,1000)] {
        let vector=&f["vectors"][index];let current=tx(&vector["currentRaw"]);let parent=tx(&vector["parentRaw"]);
        let ancestors:Vec<_>=vector["ancestorsRaw"].as_array().unwrap().iter().map(|v|bytes(v.as_str().unwrap())).collect();
        let raws:Vec<_>=ancestors.iter().map(Vec::as_slice).collect();
        let parents:Vec<_>=current.inputs[..current.inputs.len()-1].iter().map(|i|
            coin_proof::inspect_parent(&parent.serialize(),&i.previous_output,None).unwrap()).collect();
        let inputs:Vec<_>=parents.iter().map(|parent|CoinInput {parent,ancestor_raws:&raws,public_key:&key}).collect();
        let fee_point=current.inputs.last().unwrap().previous_output.clone();
        let fee=FeeInput {outpoint:fee_point.clone(),output:&parent.outputs[fee_point.vout as usize],public_key:&key};
        let receivers=[Receiver {controller:controller(&key),amount}];
        let options=TransferOptions {inputs:&inputs,fee_input:&fee,receivers:&receivers,expected_identity:parents[0].identity(),
            token_change_controller:controller(&key),additional_payment:None,additional_info:None,max_fee:10000};
        let built=if index==1 {build_merge_plan(options,controller(&key))} else {build_transfer_plan(options)}.unwrap();
        assert_eq!(built.unsigned_plan.evidence_table.len(),2,"shared immutable parents are interned once");
        let expected_fee=current.inputs.iter().map(|i|parent.outputs[i.previous_output.vout as usize].satoshis).sum::<u64>()
            -current.outputs.iter().map(|o|o.satoshis).sum::<u64>();
        assert_eq!(built.fee,expected_fee);
        let signed=tx(&vector["signedRaw"]);let stage=begin_signing(&built.unsigned_plan).unwrap();
        let sigs:Vec<_>=stage.signing_requests.iter().map(|r|{
            let signature=if let Some(v)=f["vectors"].as_array().unwrap().iter().find(|v|
                v["txid"]==vector["txid"] && v["inputIndex"].as_u64()==Some(r.input_index as u64)) {
                assert_eq!(r.digest,v["digestHex"].as_str().unwrap());let s=v["signatureHex"].as_str().unwrap();s[..s.len()-2].to_owned()
            } else {let script=signed.inputs[r.input_index as usize].script_sig.as_bytes();hex(&script[1..script[0] as usize])};
            ExternalSignature {session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),
                transaction_id:r.transaction_id.clone(),input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),signature}
        }).collect();
        let StageOutcome::Complete(bundle)=finalize_signing_stage(&built.unsigned_plan,stage,&sigs).unwrap() else {panic!("single stage")};
        assert_eq!(bundle.transactions[0].raw_transaction,vector["signedRaw"].as_str().unwrap());
        assert_eq!(bundle.transactions[0].txid,vector["txid"].as_str().unwrap());
        assert!(signed.serialize().len()<=built.maximum_signed_bytes);
        assert_eq!(built.token_outputs.iter().map(|o|o.amount).sum::<u128>(),1000);
    }
}

#[test]
fn coin_holder_rejects_wrong_identity_inputs_roles_ancestry_and_fee_cap() {
    let f=fixture();let v=&f["vectors"][0];let tx=tx(&v["parentRaw"]);
    let key=PublicKey::from_slice(&bytes(v["publicKeyHex"].as_str().unwrap())).unwrap();
    let p=coin_proof::inspect_parent(&tx.serialize(),&OutPoint {txid:tx.txid(),vout:3},None).unwrap();
    let ancestor=bytes(v["ancestorsRaw"][0].as_str().unwrap());let raws=[ancestor.as_slice()];
    let inputs=[CoinInput {parent:&p,ancestor_raws:&raws,public_key:&key}];
    let fee=FeeInput {outpoint:OutPoint {txid:tx.txid(),vout:5},output:&tx.outputs[5],public_key:&key};
    let receivers=[Receiver {controller:controller(&key),amount:250}];
    let options=||TransferOptions {inputs:&inputs,fee_input:&fee,receivers:&receivers,expected_identity:p.identity(),
        token_change_controller:controller(&key),additional_payment:None,additional_info:None,max_fee:10000};
    let mut bad=options();bad.expected_identity=&[0;34];assert!(build_transfer_plan(bad).is_err());
    let mut bad=options();bad.max_fee=1;assert_eq!(build_transfer_plan(bad).unwrap_err().code,ErrorCode::FeeCapExceeded);
    let too_much=[Receiver {controller:controller(&key),amount:1001}];let mut bad=options();bad.receivers=&too_much;
    assert_eq!(build_transfer_plan(bad).unwrap_err().code,ErrorCode::InsufficientFunds);
    let zero=[Receiver {controller:controller(&key),amount:0}];let mut bad=options();bad.receivers=&zero;assert!(build_transfer_plan(bad).is_err());
    let duplicate=[CoinInput {parent:&p,ancestor_raws:&raws,public_key:&key},CoinInput {parent:&p,ancestor_raws:&raws,public_key:&key}];
    let mut bad=options();bad.inputs=&duplicate;assert!(build_transfer_plan(bad).is_err());
    let missing=[CoinInput {parent:&p,ancestor_raws:&[],public_key:&key}];let mut bad=options();bad.inputs=&missing;assert!(build_transfer_plan(bad).is_err());
    let extra_raws=[ancestor.as_slice(),ancestor.as_slice()];let extra=[CoinInput {parent:&p,ancestor_raws:&extra_raws,public_key:&key}];
    let mut bad=options();bad.inputs=&extra;assert!(build_transfer_plan(bad).is_err());
    let wrong_key=PublicKey::from_slice(&bytes("02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5")).unwrap();
    let wrong=[CoinInput {parent:&p,ancestor_raws:&raws,public_key:&wrong_key}];let mut bad=options();bad.inputs=&wrong;assert!(build_transfer_plan(bad).is_err());
    let mut tiny=tx.outputs[5].clone();tiny.satoshis=1;
    let tiny_fee=FeeInput {outpoint:fee.outpoint.clone(),output:&tiny,public_key:&key};let mut bad=options();bad.fee_input=&tiny_fee;
    assert_eq!(build_transfer_plan(bad).unwrap_err().code,ErrorCode::InsufficientFunds);
    let invalid_fee=FeeInput {outpoint:p.selected().clone(),output:&tx.outputs[5],public_key:&key};let mut bad=options();bad.fee_input=&invalid_fee;assert!(build_transfer_plan(bad).is_err());
    let eight_groups:Vec<_>=(0..7).map(|_|Receiver {controller:controller(&key),amount:1}).collect();
    let mut bad=options();bad.receivers=&eight_groups;assert!(build_transfer_plan(bad).unwrap_err().message.contains("eight output groups"));
    let normal=build_transfer_plan(options()).unwrap();
    let mut exact_change=tx.outputs[5].clone();exact_change.satoshis=500+normal.fee+24;
    let exact_fee=FeeInput {outpoint:fee.outpoint.clone(),output:&exact_change,public_key:&key};let mut exact=options();exact.fee_input=&exact_fee;
    let exact=build_transfer_plan(exact).unwrap();assert_eq!(exact.unsigned_plan.transactions[0].outputs.last().unwrap().satoshis,24);
    exact_change.satoshis-=1;
    let short_fee=FeeInput {outpoint:fee.outpoint.clone(),output:&exact_change,public_key:&key};let mut short=options();short.fee_input=&short_fee;
    assert_eq!(build_transfer_plan(short).unwrap_err().code,ErrorCode::InsufficientFunds);
}

#[test]
fn coin_holder_preserves_metadata_consumes_lock_and_uses_native_chain_domain() {
    let f=fixture();let v=&f["vectors"][0];let mut tx=tx(&v["parentRaw"]);
    tx.outputs[4].script_pubkey=Script::from_bytes(coin::set_lock_time(tx.outputs[4].script_pubkey.as_bytes(),1234).unwrap());
    let key=PublicKey::from_slice(&bytes(v["publicKeyHex"].as_str().unwrap())).unwrap();
    let p=coin_proof::inspect_parent(&tx.serialize(),&OutPoint {txid:tx.txid(),vout:3},None).unwrap();
    let ancestor=bytes(v["ancestorsRaw"][0].as_str().unwrap());let raws=[ancestor.as_slice()];
    let inputs=[CoinInput {parent:&p,ancestor_raws:&raws,public_key:&key}];
    let fee=FeeInput {outpoint:OutPoint {txid:tx.txid(),vout:5},output:&tx.outputs[5],public_key:&key};
    let receivers=[Receiver {controller:controller(&key),amount:250}];
    let built=build_transfer_plan(TransferOptions {inputs:&inputs,fee_input:&fee,receivers:&receivers,expected_identity:p.identity(),
        token_change_controller:controller(&key),additional_payment:None,additional_info:None,max_fee:10000}).unwrap();
    let tx=&built.unsigned_plan.transactions[0];assert_eq!(tx.lock_time,1234);assert_eq!(tx.inputs[0].sequence,0xfffffffe);
    assert_eq!(tx.inputs[1].sequence,u32::MAX);
    for vout in [1,3] {let tape=coin::parse_tape(&bytes(&tx.outputs[vout].locking_script),None).unwrap();
        assert_eq!(tape.lock_time,0);assert_eq!(tape.metadata,p.tape().metadata);}
    assert!(begin_signing(&built.unsigned_plan).is_ok()); // Not a claim of chain finality.
}

#[test]
fn coin_holder_additional_payment_info_and_multi_recipient_match_sdk() {
    let f=fixture();let v=&f["vectors"][0];let tx=tx(&v["parentRaw"]);
    let key=PublicKey::from_slice(&bytes(v["publicKeyHex"].as_str().unwrap())).unwrap();let address=key.address();
    let p=coin_proof::inspect_parent(&tx.serialize(),&OutPoint {txid:tx.txid(),vout:3},None).unwrap();
    let ancestor=bytes(v["ancestorsRaw"][0].as_str().unwrap());let raws=[ancestor.as_slice()];
    let inputs=[CoinInput {parent:&p,ancestor_raws:&raws,public_key:&key}];
    let fee=FeeInput {outpoint:OutPoint {txid:tx.txid(),vout:5},output:&tx.outputs[5],public_key:&key};
    let business:serde_json::Value=serde_json::from_str(include_str!("../../../fixtures/coin-holder-business.json")).unwrap();
    for case in business["cases"].as_array().unwrap() {
        let receivers:Vec<_>=case["amounts"].as_array().unwrap().iter().map(|n|Receiver {
            controller:controller(&key),amount:n.as_str().unwrap().parse().unwrap(),
        }).collect();
        let data=case["dataHex"].as_str().map(bytes);
        let built=build_transfer_plan(TransferOptions {inputs:&inputs,fee_input:&fee,receivers:&receivers,expected_identity:p.identity(),
            token_change_controller:controller(&key),additional_payment:case["paymentAtomic"].as_u64().map(|n|(&address,n)),
            additional_info:data.as_deref(),max_fee:10000}).unwrap();
        assert_eq!(built.fee,case["fee"].as_u64().unwrap());
        let stage=begin_signing(&built.unsigned_plan).unwrap();
        let sigs:Vec<_>=stage.signing_requests.iter().zip(case["signatures"].as_array().unwrap()).map(|(r,s)|{
            assert_eq!(r.digest,s["digestHex"].as_str().unwrap());let signature=s["signatureHex"].as_str().unwrap();
            ExternalSignature {session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),
                transaction_id:r.transaction_id.clone(),input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),
                signature:signature[..signature.len()-2].into()}
        }).collect();
        let StageOutcome::Complete(bundle)=finalize_signing_stage(&built.unsigned_plan,stage,&sigs).unwrap() else {panic!("single stage")};
        assert_eq!(bundle.transactions[0].raw_transaction,case["signedRaw"].as_str().unwrap());
        assert_eq!(bundle.transactions[0].txid,case["txid"].as_str().unwrap());
    }
}
