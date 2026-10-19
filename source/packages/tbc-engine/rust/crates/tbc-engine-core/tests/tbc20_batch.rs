//! Fully offline, public scalar-1 synthetic funding. No funded wallet or transport.
use std::collections::{BTreeMap,BTreeSet};
use secp256k1::{Message,Secp256k1,SecretKey};
use tbc_sdk::{OutPoint,PublicKey,Transaction,TxOut,script::Script};
use tbc_engine_core::{ErrorCode,protocols::{tbc20::{parse_code,parse_tape},
    tbc20_material::{ParentMaterial,LinkedAncestors,inspect_parent,link_ancestors},
    tbc20_transfer::{TokenInput,FeeInput,Receiver,TransferOptions,build_transfer_plan},
    tbc20_batch::{BatchOptions,build_batch_transfer_plan,build_batch_merge_plan}},
    signing::{UnsignedPlan,SignedBundle,ExternalSignature,StageOutcome,begin_signing,finalize_signing_stage}};
fn bytes(value:&str)->Vec<u8>{(0..value.len()).step_by(2).map(|i|u8::from_str_radix(&value[i..i+2],16).unwrap()).collect()}
fn hex(value:&[u8])->String{value.iter().map(|b|format!("{b:02x}")).collect()}
fn controller(key:&PublicKey)->[u8;21]{let mut c=[0;21];c[..20].copy_from_slice(&key.hash160());c}
fn signed(plan:&UnsignedPlan)->SignedBundle {
    let mut state=begin_signing(plan).unwrap();
    let mut scalar=[0;32];scalar[31]=1;
    let secret=SecretKey::from_byte_array(scalar).unwrap();let secp=Secp256k1::new();
    loop {
        let signatures:Vec<_>=state.signing_requests.iter().map(|request|ExternalSignature{
            session_id:request.session_id.clone(),stage:request.stage,stage_commitment:request.stage_commitment.clone(),
            transaction_id:request.transaction_id.clone(),input_index:request.input_index,digest:request.digest.clone(),
            public_key:request.public_key.clone(),signature:hex(&secp.sign_ecdsa(Message::from_digest(bytes(&request.digest).try_into().unwrap()),&secret).serialize_der()),
        }).collect();
        match finalize_signing_stage(plan,state,&signatures).unwrap(){
            StageOutcome::Complete(bundle)=>return bundle,
            StageOutcome::Pending(next)=>state=next,
        }
    }
}
struct Material { parents:Vec<ParentMaterial>, ancestors:Vec<LinkedAncestors>, fee_point:OutPoint, fee_output:TxOut, key:PublicKey }
fn fragmented(count:usize)->Material {
    let f:serde_json::Value=serde_json::from_str(include_str!("../../../fixtures/tbc20-standard-transfer.json")).unwrap();
    let key=PublicKey::from_slice(&bytes(f["request"]["publicKeyHex"].as_str().unwrap())).unwrap();
    let mut known=BTreeMap::new();
    for stage in f["stages"].as_array().unwrap().iter().take(2){
        let tx=Transaction::from_bytes(&bytes(stage["signedRaw"].as_str().unwrap())).unwrap();known.insert(tx.txid().to_string(),tx);
    }
    let genesis=known[&f["stages"][1]["txid"].as_str().unwrap().to_owned()].clone();
    let mut points=vec![OutPoint{txid:genesis.txid(),vout:0}];
    let mut fee_point=OutPoint{txid:genesis.txid(),vout:2};
    // Repeatedly split the last large output, producing a genuine signed chain.
    while points.len()<count {
        let output_count=(count-points.len()+1).min(6);
        let selected=points.pop().unwrap();let source=&known[&selected.txid.to_string()];
        let parent=inspect_parent(&source.serialize(),&selected,None).unwrap();
        let required:BTreeSet<_>=parent.dependencies().iter().map(|d|d.outpoint.txid.to_string()).collect();
        let ancestor_raws:Vec<_>=required.iter().map(|id|known[id].serialize()).collect();
        let ancestors=link_ancestors(&parent,&ancestor_raws.iter().map(Vec::as_slice).collect::<Vec<_>>()).unwrap();
        let inputs=[TokenInput{parent:&parent,ancestors:&ancestors,public_key:&key}];
        let fee_tx=&known[&fee_point.txid.to_string()];
        let fees=[FeeInput{outpoint:fee_point.clone(),output:&fee_tx.outputs[fee_point.vout as usize],public_key:&key}];
        let mut receivers=vec![Receiver{controller:controller(&key),amount:1000};output_count-1];
        receivers.push(Receiver{controller:controller(&key),amount:parent.tape().balance-1000*(output_count as u128-1)});
        let plan=build_transfer_plan(TransferOptions{inputs:&inputs,fee_inputs:&fees,receivers:&receivers,
            expected_identity:parent.identity(),token_change_controller:controller(&key),native_change_hash:key.hash160(),max_fee:10000}).unwrap();
        let signed=signed(&plan.unsigned_plan);let tx=Transaction::from_bytes(&bytes(&signed.transactions[0].raw_transaction)).unwrap();
        for (vout,output) in tx.outputs.iter().enumerate(){
            if parse_code(output.script_pubkey.as_bytes()).is_ok(){points.push(OutPoint{txid:tx.txid(),vout:vout as u32});}
            else if output.script_pubkey==Script::p2pkh(&key.hash160()){fee_point=OutPoint{txid:tx.txid(),vout:vout as u32};}
        }
        known.insert(tx.txid().to_string(),tx);
    }
    assert_eq!(points.len(),count);
    let parents:Vec<_>=points.iter().map(|point|inspect_parent(&known[&point.txid.to_string()].serialize(),point,None).unwrap()).collect();
    let ancestors=parents.iter().map(|parent|{
        let required:BTreeSet<_>=parent.dependencies().iter().map(|d|d.outpoint.txid.to_string()).collect();
        let raws:Vec<_>=required.iter().map(|id|known[id].serialize()).collect();
        link_ancestors(parent,&raws.iter().map(Vec::as_slice).collect::<Vec<_>>()).unwrap()
    }).collect();
    let fee_output=known[&fee_point.txid.to_string()].outputs[fee_point.vout as usize].clone();
    Material{parents,ancestors,fee_point,fee_output,key}
}

#[test]
fn tbc20_batch_seven_and_ten_fragments_sign_actual_planned_dependencies_without_rereads(){
    for (count,merge,with_fee) in [(7,false,true),(10,true,true),(7,false,false),(20,true,true)] {
        let m=fragmented(count);
        let inputs:Vec<_>=m.parents.iter().zip(&m.ancestors).map(|(parent,ancestors)|TokenInput{parent,ancestors,public_key:&m.key}).collect();
        let fees:Vec<_>=with_fee.then_some(FeeInput{outpoint:m.fee_point.clone(),output:&m.fee_output,public_key:&m.key}).into_iter().collect();
        let receivers=[Receiver{controller:controller(&m.key),amount:1000}];
        let options=BatchOptions{transfer:TransferOptions{inputs:&inputs,fee_inputs:&fees,receivers:&receivers,
            expected_identity:m.parents[0].identity(),token_change_controller:controller(&m.key),native_change_hash:m.key.hash160(),max_fee:10000},max_transactions:8};
        let batch=if merge{build_batch_merge_plan(options)}else{build_batch_transfer_plan(options)}.unwrap();
        assert!(batch.unsigned_plan.transactions.len()>1);
        let bundle=signed(&batch.unsigned_plan);
        let mut spent=BTreeSet::new();let mut resolved=BTreeMap::new();
        for (index,item) in bundle.transactions.iter().enumerate(){
            let tx=Transaction::from_bytes(&bytes(&item.raw_transaction)).unwrap();
            assert_eq!(tx.txid().to_string(),item.txid);
            assert!(tx.serialize().len()<=batch.maximum_signed_bytes[index]);
            let planned=&batch.unsigned_plan.transactions[index];
            for (input,planned_input) in tx.inputs.iter().zip(&planned.inputs){
                assert!(spent.insert((input.previous_output.txid.to_string(),input.previous_output.vout)),"no input can be consumed twice");
                if let Some(actual)=resolved.get(&planned_input.previous_transaction_id){assert_eq!(&input.previous_output.txid.to_string(),actual);}
            }
            resolved.insert(item.transaction_id.clone(),item.txid.clone());
        }
        for parent in &m.parents{assert!(spent.contains(&(parent.selected().txid.to_string(),parent.selected().vout)));}
        if with_fee{assert!(spent.contains(&(m.fee_point.txid.to_string(),m.fee_point.vout)));}
        let final_tx=Transaction::from_bytes(&bytes(&bundle.transactions.last().unwrap().raw_transaction)).unwrap();
        let balance:u128=final_tx.outputs.iter().filter_map(|output|parse_tape(output.script_pubkey.as_bytes()).ok()).map(|tape|tape.balance).sum();
        assert_eq!(balance,123456);
        assert_eq!(batch.token_outputs.iter().map(|output|output.amount).sum::<u128>(),123456);
    }
}

#[test]
fn tbc20_batch_bounds_global_fees_duplicate_inputs_and_signing_binding(){
    let m=fragmented(7);
    let inputs:Vec<_>=m.parents.iter().zip(&m.ancestors).map(|(parent,ancestors)|TokenInput{parent,ancestors,public_key:&m.key}).collect();
    let fees=[FeeInput{outpoint:m.fee_point.clone(),output:&m.fee_output,public_key:&m.key}];
    let receivers=[Receiver{controller:controller(&m.key),amount:1000}];
    let options=|inputs|BatchOptions{transfer:TransferOptions{inputs,fee_inputs:&fees,receivers:&receivers,
        expected_identity:m.parents[0].identity(),token_change_controller:controller(&m.key),native_change_hash:m.key.hash160(),max_fee:10000},max_transactions:8};
    let good=build_batch_transfer_plan(options(&inputs)).unwrap();
    let mut capped=options(&inputs);capped.max_transactions=1;
    assert!(build_batch_transfer_plan(capped).unwrap_err().message.contains("bundle"));
    let mut capped=options(&inputs);capped.transfer.max_fee=good.fees.iter().sum::<u64>()-1;
    assert_eq!(build_batch_transfer_plan(capped).unwrap_err().code,ErrorCode::FeeCapExceeded);
    let state=begin_signing(&good.unsigned_plan).unwrap();
    let wrong:Vec<_>=state.signing_requests.iter().map(|r|ExternalSignature{session_id:r.session_id.clone(),stage:r.stage,
        stage_commitment:r.stage_commitment.clone(),transaction_id:r.transaction_id.clone(),input_index:r.input_index,
        digest:"00".repeat(32),public_key:r.public_key.clone(),signature:"00".repeat(64)}).collect();
    assert!(finalize_signing_stage(&good.unsigned_plan,state,&wrong).is_err());
    let mut repeated:Vec<_>=m.parents.iter().zip(&m.ancestors).map(|(parent,ancestors)|TokenInput{parent,ancestors,public_key:&m.key}).collect();
    repeated.push(TokenInput{parent:&m.parents[0],ancestors:&m.ancestors[0],public_key:&m.key});
    assert!(build_batch_transfer_plan(options(&repeated)).unwrap_err().message.contains("repeats"));
}

#[test]
fn tbc20_batch_small_plan_is_byte_identical_and_cannot_loop_without_reduction(){
    use tbc_engine_core::protocols::tbc20::{build_tape,MAX_SLOT_AMOUNT};
    let m=fragmented(7);
    let inputs=[TokenInput{parent:&m.parents[0],ancestors:&m.ancestors[0],public_key:&m.key}];
    let fees=[FeeInput{outpoint:m.fee_point.clone(),output:&m.fee_output,public_key:&m.key}];
    let receivers=[Receiver{controller:controller(&m.key),amount:1000}];
    let options=||TransferOptions{inputs:&inputs,fee_inputs:&fees,receivers:&receivers,
        expected_identity:m.parents[0].identity(),token_change_controller:controller(&m.key),native_change_hash:m.key.hash160(),max_fee:10000};
    let original=build_transfer_plan(options()).unwrap();
    let batch=build_batch_transfer_plan(BatchOptions{transfer:options(),max_transactions:1}).unwrap();
    assert_eq!(batch.unsigned_plan,original.unsigned_plan);
    assert_eq!(batch.fees,vec![original.fee]);
    assert_eq!(batch.maximum_signed_bytes,vec![original.maximum_signed_bytes]);

    // Synthetic parser-valid amount-capacity boundary, not a consensus-valid issuance.
    let mut large_parents=Vec::new();let mut large_ancestors=Vec::new();
    for index in 0..7 {
        let mut tx=m.parents[0].transaction().clone();tx.lock_time=index+1;
        tx.inputs=vec![tx.inputs[0].clone();6];
        tx.outputs[1].script_pubkey=Script::from_bytes(build_tape([MAX_SLOT_AMOUNT;6],&m.parents[0].tape().extension).unwrap());
        let parent=inspect_parent(&tx.serialize(),&OutPoint{txid:tx.txid(),vout:0},Some(m.parents[0].identity())).unwrap();
        let raws:Vec<_>=m.ancestors[0].transactions().iter().map(Transaction::serialize).collect();
        let ancestors=link_ancestors(&parent,&raws.iter().map(Vec::as_slice).collect::<Vec<_>>()).unwrap();
        large_parents.push(parent);large_ancestors.push(ancestors);
    }
    let large:Vec<_>=large_parents.iter().zip(&large_ancestors).map(|(parent,ancestors)|TokenInput{parent,ancestors,public_key:&m.key}).collect();
    let invalid=build_batch_merge_plan(BatchOptions{transfer:TransferOptions{inputs:&large,..options()},max_transactions:8}).unwrap_err();
    assert!(invalid.message.contains("reducing maintenance"),"{}",invalid.message);
}
