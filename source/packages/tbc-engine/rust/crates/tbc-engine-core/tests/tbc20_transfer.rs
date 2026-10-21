use tbc_engine_core::{ErrorCode, protocols::{
    tbc20_material::{inspect_parent, link_ancestors},
    tbc20_transfer::{FeeInput, Receiver, TokenInput, TransferOptions, build_merge_plan, build_transfer_plan},
}, signing::{ExternalSignature, StageOutcome, begin_signing, finalize_signing_stage}};
use tbc_sdk::{OutPoint, PublicKey, Transaction};

fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!("../../../fixtures/tbc20-standard-transfer.json")).unwrap()
}
fn bytes(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i+2],16).unwrap()).collect()
}
fn raw(stage: &serde_json::Value) -> Vec<u8> { bytes(stage["signedRaw"].as_str().unwrap()) }
fn public(f: &serde_json::Value) -> PublicKey {
    PublicKey::from_slice(&bytes(f["request"]["publicKeyHex"].as_str().unwrap())).unwrap()
}
fn controller(public: &PublicKey) -> [u8; 21] {
    let mut value = [0; 21]; value[..20].copy_from_slice(&public.hash160()); value
}

#[test]
fn tbc20_transfer_merge_match_upstream_full_raw_and_reuse_shared_evidence() {
    let f = fixture(); let public = public(&f);
    for (index, vouts, amount) in [(2, vec![0], 40000), (3, vec![0,2],123456)] {
        let parent_raw = raw(&f["stages"][index-1]);
        let parent_tx = Transaction::from_bytes(&parent_raw).unwrap();
        let ancestor_raw = raw(&f["stages"][index-2]);
        let parents: Vec<_> = vouts.iter().map(|vout| inspect_parent(&parent_raw,
            &OutPoint { txid: parent_tx.txid(), vout: *vout }, None).unwrap()).collect();
        let ancestors: Vec<_> = parents.iter().map(|p| link_ancestors(p, &[&ancestor_raw]).unwrap()).collect();
        let inputs: Vec<_> = parents.iter().zip(&ancestors).map(|(p,a)| TokenInput {
            parent:p, ancestors:a, public_key:&public,
        }).collect();
        let fee_vout = if index==2 {2} else {4};
        let fees = [FeeInput { outpoint: OutPoint {txid:parent_tx.txid(),vout:fee_vout},
            output:&parent_tx.outputs[fee_vout as usize], public_key:&public }];
        let receivers = [Receiver {controller:controller(&public), amount}];
        let options = TransferOptions {payment:None, inputs:&inputs, fee_inputs:&fees, receivers:&receivers,
            expected_identity:parents[0].identity(), token_change_controller:controller(&public),
            native_change_hash:public.hash160(), max_fee:1000 };
        let built = if index==2 {build_transfer_plan(options)} else {build_merge_plan(options,controller(&public))}.unwrap();
        let oracle = &f["stages"][index];
        assert_eq!(built.fee.to_string(),oracle["fee"].as_str().unwrap());
        assert_eq!(built.unsigned_plan.evidence_table.len(),2,"same parent/ancestor raw is interned once");
        let stage = begin_signing(&built.unsigned_plan).unwrap();
        let signatures: Vec<_> = stage.signing_requests.iter().zip(oracle["inputs"].as_array().unwrap()).map(|(r,i)| {
            assert_eq!(r.digest,i["digestBytesHex"].as_str().unwrap());
            let signature = i["signatureHex"].as_str().unwrap();
            assert!(signature.ends_with("41"));
            ExternalSignature { session_id:r.session_id.clone(), stage:r.stage, stage_commitment:r.stage_commitment.clone(),
                transaction_id:r.transaction_id.clone(),input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),
                signature:signature[..signature.len()-2].to_owned() }
        }).collect();
        assert_eq!(signatures.len(),oracle["inputs"].as_array().unwrap().len());
        let StageOutcome::Complete(bundle) = finalize_signing_stage(&built.unsigned_plan,stage,&signatures).unwrap()
            else {panic!("independent transfer finishes one signature stage")};
        assert_eq!(bundle.transactions[0].raw_transaction,oracle["signedRaw"].as_str().unwrap());
        assert_eq!(bundle.transactions[0].txid,oracle["txid"].as_str().unwrap());
        assert!(bundle.transactions[0].raw_transaction.len()/2<=built.maximum_signed_bytes);
        assert_eq!(built.token_outputs.iter().map(|o|o.amount).sum::<u128>(),123456);
    }
}

#[test]
fn tbc20_transfer_rejects_bad_identity_insufficient_balance_fee_cap_and_duplicate_input() {
    let f=fixture();let public=public(&f);
    let parent_raw=raw(&f["stages"][1]);let tx=Transaction::from_bytes(&parent_raw).unwrap();
    let parent=inspect_parent(&parent_raw,&OutPoint{txid:tx.txid(),vout:0},None).unwrap();
    let ancestor_raw=raw(&f["stages"][0]);let ancestors=link_ancestors(&parent,&[&ancestor_raw]).unwrap();
    let inputs=[TokenInput{parent:&parent,ancestors:&ancestors,public_key:&public}];
    let fees=[FeeInput{outpoint:OutPoint{txid:tx.txid(),vout:2},output:&tx.outputs[2],public_key:&public}];
    let receivers=[Receiver{controller:controller(&public),amount:40000}];
    let options=||TransferOptions{payment:None,inputs:&inputs,fee_inputs:&fees,receivers:&receivers,expected_identity:parent.identity(),
        token_change_controller:controller(&public),native_change_hash:public.hash160(),max_fee:1000};
    let mut bad=options();bad.expected_identity=&[0;34];assert!(build_transfer_plan(bad).is_err());
    let mut bad=options();bad.max_fee=1;assert_eq!(build_transfer_plan(bad).unwrap_err().code,ErrorCode::FeeCapExceeded);
    let too_much=[Receiver{controller:controller(&public),amount:123457}];
    let mut bad=options();bad.receivers=&too_much;assert_eq!(build_transfer_plan(bad).unwrap_err().code,ErrorCode::InsufficientFunds);
    let repeated=[TokenInput{parent:&parent,ancestors:&ancestors,public_key:&public},
        TokenInput{parent:&parent,ancestors:&ancestors,public_key:&public}];
    let mut bad=options();bad.inputs=&repeated;assert!(build_transfer_plan(bad).is_err());
    let zero=[Receiver{controller:controller(&public),amount:0}];
    let mut bad=options();bad.receivers=&zero;assert!(build_transfer_plan(bad).is_err());
    let duplicate_fee=[FeeInput{outpoint:OutPoint{txid:tx.txid(),vout:0},output:&tx.outputs[2],public_key:&public}];
    let mut bad=options();bad.fee_inputs=&duplicate_fee;assert!(build_transfer_plan(bad).is_err());
    let eight=vec![Receiver{controller:controller(&public),amount:15432};8];
    let mut bad=options();bad.receivers=&eight;
    assert!(build_transfer_plan(bad).unwrap_err().message.contains("no group left"));
    let seven=vec![Receiver{controller:controller(&public),amount:100};7];
    let mut bad=options();bad.receivers=&seven;
    bad.payment=Some(tbc_engine_core::protocols::tbc20_transfer::NativePayment{recipient_hash:[7;20],amount:42});
    assert!(build_transfer_plan(bad).unwrap_err().message.contains("no output group left"));
    let mut bad=options();
    bad.payment=Some(tbc_engine_core::protocols::tbc20_transfer::NativePayment{recipient_hash:[7;20],amount:9_007_199_254_740_991});
    assert_eq!(build_transfer_plan(bad).unwrap_err().code,ErrorCode::InsufficientFunds);
    let six:Vec<_>=(0..6).map(|_|TokenInput{parent:&parent,ancestors:&ancestors,public_key:&public}).collect();
    let mut bad=options();bad.inputs=&six;
    assert!(build_transfer_plan(bad).unwrap_err().message.contains("six total"));
}
