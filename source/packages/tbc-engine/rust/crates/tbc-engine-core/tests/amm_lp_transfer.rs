use serde_json::Value;
use tbc_engine_core::{ErrorCode,protocols::{amm_lp as lp,amm_lp_proof as proof,amm_lp_transfer::*},signing::*};
use tbc_sdk::{PublicKey,Transaction};
fn fixture()->Value{serde_json::from_str(include_str!("../../../fixtures/amm-lp-proof.json")).unwrap()}
fn bytes(h:&str)->Vec<u8>{(0..h.len()).step_by(2).map(|i|u8::from_str_radix(&h[i..i+2],16).unwrap()).collect()}
fn hex(b:&[u8])->String{b.iter().map(|b|format!("{b:02x}")).collect()}
fn controller(key:&PublicKey)->[u8;21]{let mut c=[0;21];c[..20].copy_from_slice(&key.hash160());c}
struct Case{parent:Transaction,current:Transaction,materials:Vec<proof::ParentMaterial>,ancestors:Vec<Vec<u8>>,key:PublicKey}
impl Case{
    fn load(f:&Value,v:&Value)->Self{
        let parent=Transaction::from_hex(f["raws"][v["parentTxid"].as_str().unwrap()].as_str().unwrap()).unwrap();
        let current=Transaction::from_hex(v["currentRaw"].as_str().unwrap()).unwrap();
        let materials=current.inputs[..current.inputs.len()-1].iter().map(|i|proof::inspect_parent(&parent.serialize(),&i.previous_output,None).unwrap()).collect();
        Self{parent,current,materials,ancestors:v["ancestors"].as_array().unwrap().iter().map(|id|bytes(f["raws"][id.as_str().unwrap()].as_str().unwrap())).collect(),key:PublicKey::from_slice(&bytes(v["publicKeyHex"].as_str().unwrap())).unwrap()}
    }
    fn options<'a>(&'a self,inputs:&'a [LpInput<'a>],fee:&'a FeeInput<'a>,amount:u64)->TransferOptions<'a>{
        TransferOptions{inputs,fee_input:fee,expected_identity:self.materials[0].identity(),receiver_controller:controller(&self.key),amount,
            lp_change_controller:None,native_change_hash:self.key.hash160(),lock_time:None,output_lock_time:None,fee_policy:MinerFeePolicy::default(),max_fee:10000}
    }
    fn fee(&self)->FeeInput<'_>{let p=&self.current.inputs.last().unwrap().previous_output;FeeInput{outpoint:p.clone(),output:&self.parent.outputs[p.vout as usize],public_key:&self.key}}
}
#[test]
fn six_lp_builds_match_sdk_raw_fee_and_shared_signer_without_any_engine_key(){
    let f=fixture();
    for id in ["public-plain-transfer-0","public-plain-merge-0","public-plain-again-0","controller-locked-transfer-0","controller-locked-merge-0","controller-locked-unlock-0"]{
        let v=f["vectors"].as_array().unwrap().iter().find(|v|v["id"]==id).unwrap();let c=Case::load(&f,v);let raw_refs:Vec<_>=c.ancestors.iter().map(Vec::as_slice).collect();
        let inputs:Vec<_>=c.materials.iter().map(|parent|LpInput{parent,ancestor_raws:&raw_refs,public_key:&c.key}).collect();let fee=c.fee();
        let opts=c.options(&inputs,&fee,if id.contains("transfer"){40000}else{100000});
        let built=if id.contains("merge"){build_merge_plan(opts)}else if id.contains("unlock"){build_unlock_plan(opts)}else{build_transfer_plan(opts)}.unwrap();
        assert_eq!(built.unsigned_plan.evidence_table.len(),2,"deduplicated shared parent and direct ancestor");
        let expected_fee=c.current.inputs.iter().map(|i|c.parent.outputs[i.previous_output.vout as usize].satoshis).sum::<u64>()-c.current.outputs.iter().map(|o|o.satoshis).sum::<u64>();
        assert_eq!(built.fee,expected_fee,"{id} fee");
        let signed=Transaction::from_hex(f["raws"][v["signedTxid"].as_str().unwrap()].as_str().unwrap()).unwrap();
        let stage=begin_signing(&built.unsigned_plan).unwrap();assert_eq!(stage.signing_requests.len(),c.current.inputs.len());
        let signatures:Vec<_>=stage.signing_requests.iter().map(|r|{
            let signature=if let Some(row)=f["vectors"].as_array().unwrap().iter().find(|row|row["signedTxid"]==v["signedTxid"]&&row["inputIndex"].as_u64()==Some(r.input_index as u64)){
                assert_eq!(r.script_class,"tbc20-lp");assert_eq!(r.digest,row["digestHex"].as_str().unwrap(),"{id} digest");
                let s=row["signatureHex"].as_str().unwrap();s[..s.len()-2].to_owned()
            }else{let s=signed.inputs[r.input_index as usize].script_sig.as_bytes();hex(&s[1..s[0] as usize])};
            ExternalSignature{session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),transaction_id:r.transaction_id.clone(),
                input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),signature}
        }).collect();
        let StageOutcome::Complete(bundle)=finalize_signing_stage(&built.unsigned_plan,stage,&signatures).unwrap()else{panic!("single-stage LP")};
        assert_eq!(bundle.transactions[0].raw_transaction,f["raws"][v["signedTxid"].as_str().unwrap()].as_str().unwrap(),"{id} raw");
        assert_eq!(bundle.transactions[0].txid,v["signedTxid"].as_str().unwrap());assert!(signed.serialize().len()<=built.maximum_signed_bytes);
    }
}
#[test]
fn lp_builder_keeps_strict_identity_ownership_lock_ancestry_and_fee_boundaries(){
    let f=fixture();let c=Case::load(&f,&f["vectors"][0]);let raws:Vec<_>=c.ancestors.iter().map(Vec::as_slice).collect();let fee=c.fee();
    let inputs=[LpInput{parent:&c.materials[0],ancestor_raws:&raws,public_key:&c.key}];let opts=||c.options(&inputs,&fee,40000);
    let mut o=opts();o.expected_identity=&[0;34];assert!(build_transfer_plan(o).is_err());
    let mut o=opts();o.amount=0;assert!(build_transfer_plan(o).is_err());
    let mut o=opts();o.amount=100001;assert_eq!(build_transfer_plan(o).unwrap_err().code,ErrorCode::InsufficientFunds);
    let mut o=opts();o.max_fee=1;assert_eq!(build_transfer_plan(o).unwrap_err().code,ErrorCode::FeeCapExceeded);
    let mut o=opts();o.output_lock_time=Some(0);assert!(build_transfer_plan(o).is_err());
    let mut o=opts();o.receiver_controller[20]=2;assert!(build_transfer_plan(o).is_err());
    assert!(build_unlock_plan(opts()).is_err());
    let duplicate=[LpInput{parent:&c.materials[0],ancestor_raws:&raws,public_key:&c.key},LpInput{parent:&c.materials[0],ancestor_raws:&raws,public_key:&c.key}];
    let mut o=opts();o.inputs=&duplicate;assert!(build_transfer_plan(o).is_err());
    let missing=[LpInput{parent:&c.materials[0],ancestor_raws:&[],public_key:&c.key}];let mut o=opts();o.inputs=&missing;assert!(build_transfer_plan(o).is_err());
    let two=[raws[0],raws[0]];let repeated=[LpInput{parent:&c.materials[0],ancestor_raws:&two,public_key:&c.key}];let mut o=opts();o.inputs=&repeated;assert!(build_transfer_plan(o).is_err());
    let mut o=opts();o.fee_policy.change_dust=9;assert!(build_transfer_plan(o).is_err());
    let mut o=opts();o.fee_policy.satoshis_per_kb=0;assert!(build_transfer_plan(o).is_err());
    let mut duplicate_fee=c.fee();duplicate_fee.outpoint=c.materials[0].selected().clone();let mut o=opts();o.fee_input=&duplicate_fee;assert!(build_transfer_plan(o).is_err());
}
#[test]
fn lp_fee_change_boundary_and_explicit_output_lock_preserve_shared_flow(){
    let f=fixture();let v=f["vectors"].as_array().unwrap().iter().find(|v|v["id"]=="controller-locked-transfer-0").unwrap();
    let c=Case::load(&f,v);let raws:Vec<_>=c.ancestors.iter().map(Vec::as_slice).collect();let inputs=[LpInput{parent:&c.materials[0],ancestor_raws:&raws,public_key:&c.key}];let fee=c.fee();
    let opts=||c.options(&inputs,&fee,40000);
    let mut o=opts();o.lock_time=Some(829998);assert!(build_transfer_plan(o).is_err());
    let mut o=opts();o.lock_time=Some(500000000);assert!(build_transfer_plan(o).is_err());
    let mut o=opts();o.output_lock_time=Some(900000);let built=build_transfer_plan(o).unwrap();
    let t=&built.unsigned_plan.transactions[0];assert_eq!(t.lock_time,829999);
    assert_eq!(lp::Tape::decode(&bytes(&t.outputs[1].locking_script),true,None).unwrap().lock_time,900000);
    assert_eq!(lp::Tape::decode(&bytes(&t.outputs[3].locking_script),true,None).unwrap().lock_time,829999);
    assert!(begin_signing(&built.unsigned_plan).is_ok());
    // No hidden ownership transfer in unlock.
    let mut o=opts();o.receiver_controller[0]^=1;assert!(build_unlock_plan(o).is_err());
    let normal=build_transfer_plan(opts()).unwrap();let mut small=fee.output.clone();small.satoshis=500+normal.fee+10;
    let adjusted=FeeInput{outpoint:fee.outpoint.clone(),output:&small,public_key:&c.key};let mut o=opts();o.fee_input=&adjusted;
    let exact=build_transfer_plan(o).unwrap();assert_eq!(exact.unsigned_plan.transactions[0].outputs.last().unwrap().satoshis,10);
    small.satoshis-=1;let adjusted=FeeInput{outpoint:fee.outpoint.clone(),output:&small,public_key:&c.key};let mut o=opts();o.fee_input=&adjusted;
    let no_change=build_transfer_plan(o).unwrap();assert_eq!(no_change.unsigned_plan.transactions[0].outputs.len(),4);assert!(no_change.fee>=normal.fee);
    assert!(begin_signing(&no_change.unsigned_plan).is_ok());
}
