use serde_json::Value;
use sha2::{Digest,Sha256};
use tbc_sdk::{Transaction,OutPoint,hash,script::Script};
use tbc_engine_core::protocols::{amm_lp as lp,amm_lp_proof as proof};
fn fixture()->Value{serde_json::from_str(include_str!("../../../fixtures/amm-lp-proof.json")).unwrap()}
fn b(v:&Value)->Vec<u8>{let h=v.as_str().unwrap();(0..h.len()).step_by(2).map(|i|u8::from_str_radix(&h[i..i+2],16).unwrap()).collect()}
fn tx(v:&Value)->Transaction{Transaction::from_bytes(&b(v)).unwrap()}
fn hex(b:&[u8])->String{b.iter().map(|b|format!("{b:02x}")).collect()}
struct Case{current:Transaction,parent:proof::ParentMaterial,ancestors:Vec<Vec<u8>>,groups:Vec<proof::OutputGroup>,key:Vec<u8>,vin:usize,witness:Option<(Transaction,usize)>}
impl Case{
    fn load(f:&Value,v:&Value)->Self{
        let raw=b(&f["raws"][v["parentTxid"].as_str().unwrap()]);let parent_tx=Transaction::from_bytes(&raw).unwrap();
        let parent=proof::inspect_parent(&raw,&OutPoint{txid:parent_tx.txid(),vout:v["parentCodeVout"].as_u64().unwrap() as u32},Some(&b(&v["identityHex"]))).unwrap();
        Self{current:tx(&v["currentRaw"]),parent,ancestors:v["ancestors"].as_array().unwrap().iter().map(|id|b(&f["raws"][id.as_str().unwrap()])).collect(),
            groups:v["outputGroups"].as_array().unwrap().iter().map(|g|proof::OutputGroup{code_vout:g["codeVout"].as_u64().unwrap() as usize,tape_vout:g["tapeVout"].as_u64().map(|n|n as usize)}).collect(),
            key:b(&v["publicKeyHex"]),vin:v["inputIndex"].as_u64().unwrap() as usize,
            witness:v.get("contractController").map(|w|(tx(&f["raws"][w["txid"].as_str().unwrap()]),w["currentInputIndex"].as_u64().unwrap() as usize))}
    }
    fn prepare(&self)->Result<proof::PreparedUnlock,tbc_engine_core::EngineError>{
        proof::prepare_unlock(proof::UnlockOptions{current_tx:&self.current,input_index:self.vin,parent:&self.parent,
            ancestor_raws:&self.ancestors.iter().map(Vec::as_slice).collect::<Vec<_>>(),output_groups:&self.groups,public_key:&self.key,
            contract_controller:self.witness.as_ref().map(|(transaction,index)|proof::ContractControllerWitness{transaction,current_input_index:*index})})
    }
    fn replace_parent(&mut self,parent:Transaction){
        let old=self.parent.transaction().txid();let point=OutPoint{txid:parent.txid(),vout:self.parent.selected().vout};
        self.parent=proof::inspect_parent(&parent.serialize(),&point,None).unwrap();
        for input in &mut self.current.inputs{if input.previous_output.txid==old{input.previous_output.txid=point.txid;}}
    }
}
#[test]
fn lp_exact_123_fields_real_external_signatures_and_full_signed_bytes_match_sdk(){
    let f=fixture();assert_eq!(f["vmInputs"],32);assert_eq!(f["vectors"].as_array().unwrap().len(),10);
    for v in f["vectors"].as_array().unwrap(){
        let case=Case::load(&f,v);let prepared=case.prepare().unwrap();
        assert_eq!(prepared.signing_digest().as_slice(),b(&v["digestHex"]));assert_eq!(prepared.public_key().as_slice(),case.key);
        assert_eq!(prepared.proof_fields().len(),123);
        for (index,field) in prepared.proof_fields().iter().enumerate(){
            if index==98{assert!(field.is_empty());continue;}
            assert_eq!(hex(&Sha256::digest(field)),v["fieldHashes"][index].as_str().unwrap(),"{} leaf {index}",v["id"]);
        }
        let signature=b(&v["signatureHex"]);let signed=prepared.finalize(&signature).unwrap();
        assert_eq!(hex(&Sha256::digest(signed.as_bytes())),v["unlockHash"].as_str().unwrap());
        assert!(signed.as_bytes().len()<=prepared.max_unlocking_script_bytes());
        let raw=&f["raws"][v["signedTxid"].as_str().unwrap()];let mut completed=tx(raw);completed.inputs[case.vin].script_sig=signed;
        assert_eq!(completed.serialize(),b(raw));assert_eq!(completed.txid().to_string(),v["signedTxid"].as_str().unwrap());
        let mut wrong=signature.clone();wrong[10]^=1;assert!(prepared.finalize(&wrong).is_err());
        let mut wrong=signature.clone();*wrong.last_mut().unwrap()=1;assert!(prepared.finalize(&wrong).is_err());
        assert!(prepared.finalize(&[0;65]).is_err());
        let mut changed=Case::load(&f,v);changed.current.outputs.last_mut().unwrap().satoshis-=1;
        assert!(changed.prepare().unwrap().finalize(&signature).is_err());
        // Finalize owns all evidence and survives dropping resolver/parent material.
        drop(case);assert!(prepared.finalize(&signature).is_ok());
    }
}
#[test]
fn lp_refuses_wrong_owner_allocation_identity_output_coverage_and_duplicate_inputs(){
    let f=fixture();let v=&f["vectors"][0];
    let mut c=Case::load(&f,v);c.key[0]^=1;assert!(c.prepare().is_err());
    let mut c=Case::load(&f,v);c.key.remove(0);assert!(c.prepare().is_err());
    let mut c=Case::load(&f,v);c.current.inputs[1].previous_output=c.current.inputs[0].previous_output.clone();assert!(c.prepare().is_err());
    let mut c=Case::load(&f,v);c.groups.reverse();assert!(c.prepare().is_err());
    let mut c=Case::load(&f,v);c.groups.pop();assert!(c.prepare().is_err());
    let mut c=Case::load(&f,v);c.current.outputs[0].script_pubkey=c.current.outputs[1].script_pubkey.clone();assert!(c.prepare().is_err());
    let mut c=Case::load(&f,v);let mut tape=lp::Tape::decode(c.current.outputs[1].script_pubkey.as_bytes(),false,None).unwrap();
    tape.amounts[c.vin]+=1;c.current.outputs[1].script_pubkey=Script::from_bytes(tape.encode().unwrap());assert!(c.prepare().is_err());
    let mut c=Case::load(&f,v);let mut code=lp::parse_code(c.current.outputs[0].script_pubkey.as_bytes()).unwrap();code.pool_code_hash[0]^=1;
    c.current.outputs[0].script_pubkey=Script::from_bytes(lp::instantiate_code(&code).unwrap());assert!(c.prepare().is_err());
    let mut c=Case::load(&f,v);c.current.outputs[0].satoshis=501;assert!(c.prepare().is_err());
    let mut c=Case::load(&f,v);c.current.outputs[1].satoshis=1;assert!(c.prepare().is_err());
}
#[test]
fn lp_locks_require_nonfinal_sequence_and_correct_height_or_timestamp(){
    let f=fixture();let v=f["vectors"].as_array().unwrap().iter().find(|v|v["id"].as_str().unwrap()=="controller-locked-transfer-0").unwrap();
    let c=Case::load(&f,v);assert!(c.parent.code().timelocked);assert!(c.prepare().is_ok());
    let mut c=Case::load(&f,v);c.current.inputs[c.vin].sequence=u32::MAX;assert!(c.prepare().is_err());
    let mut c=Case::load(&f,v);c.current.lock_time=829998;assert!(c.prepare().is_err());
    let mut c=Case::load(&f,v);c.current.lock_time=500000000;assert!(c.prepare().is_err());
    let mut c=Case::load(&f,v);let mut parent=c.parent.transaction().clone();let index=c.parent.selected().vout as usize;
    let mut tape=lp::Tape::decode(parent.outputs[index+1].script_pubkey.as_bytes(),true,None).unwrap();tape.lock_time=500000000;
    parent.outputs[index+1].script_pubkey=Script::from_bytes(tape.encode().unwrap());c.replace_parent(parent);assert!(c.prepare().is_err());
    c.current.lock_time=500000000;assert!(c.prepare().is_ok());
}
#[test]
fn lp_ancestor_set_is_minimal_and_pool_issuance_is_only_slot_zero_vout_zero(){
    let f=fixture();
    for v in f["vectors"].as_array().unwrap(){
        let mut c=Case::load(&f,v);c.ancestors.clear();assert!(c.prepare().is_err());
        let mut c=Case::load(&f,v);c.ancestors.push(c.ancestors[0].clone());assert!(c.prepare().is_err());
        let mut c=Case::load(&f,v);let mut wrong=Transaction::from_bytes(&c.ancestors[0]).unwrap();let old=wrong.txid();
        for output in &mut wrong.outputs{
            if let Ok(mut code)=lp::parse_code(output.script_pubkey.as_bytes()){code.pool_code_hash[0]^=1;output.script_pubkey=Script::from_bytes(lp::instantiate_code(&code).unwrap());}
            else{output.script_pubkey=Script::from_bytes(vec![0x51]);}
        }
        let new=wrong.txid();c.ancestors[0]=wrong.serialize();let mut parent=c.parent.transaction().clone();
        for input in &mut parent.inputs{if input.previous_output.txid==old{input.previous_output.txid=new;}}
        c.replace_parent(parent);
        if let Some((witness,_))=&mut c.witness{*witness=c.parent.transaction().clone();}
        assert!(c.prepare().unwrap_err().message.contains("neither same LP identity"));
    }
    // Preserve both Pool code and its hash; move the issuance source to vout 1.
    let v=&f["vectors"][0];let mut c=Case::load(&f,v);let mut ancestor=Transaction::from_bytes(&c.ancestors[0]).unwrap();
    ancestor.outputs.swap(0,1);c.ancestors[0]=ancestor.serialize();let mut parent=c.parent.transaction().clone();
    parent.inputs[0].previous_output=OutPoint{txid:ancestor.txid(),vout:1};c.replace_parent(parent);
    assert!(c.prepare().unwrap_err().message.contains("neither same LP identity"));
    // Same Pool source at vout 0 but amount moved from absolute vin 0 to vin 1.
    let mut c=Case::load(&f,v);let mut parent=c.parent.transaction().clone();parent.inputs.swap(0,1);
    let index=c.parent.selected().vout as usize;let mut tape=lp::Tape::decode(parent.outputs[index+1].script_pubkey.as_bytes(),false,None).unwrap();
    tape.amounts.swap(0,1);parent.outputs[index+1].script_pubkey=Script::from_bytes(tape.encode().unwrap());c.replace_parent(parent);
    assert!(c.prepare().unwrap_err().message.contains("neither same LP identity"));
}
#[test]
fn contract_lp_requires_consumed_contract_witness_not_address_or_self_authority(){
    let f=fixture();let v=&f["vectors"][0];let mut c=Case::load(&f,v);let mut parent=c.parent.transaction().clone();
    let index=c.parent.selected().vout as usize;let fee_vout=c.current.inputs.last().unwrap().previous_output.vout as usize;
    let mut code=lp::parse_code(parent.outputs[index].script_pubkey.as_bytes()).unwrap();
    code.controller[..20].copy_from_slice(&hash::hash160(&hash::sha256(parent.outputs[fee_vout].script_pubkey.as_bytes())));code.controller[20]=1;
    parent.outputs[index].script_pubkey=Script::from_bytes(lp::instantiate_code(&code).unwrap());c.replace_parent(parent.clone());
    assert!(c.prepare().is_err());
    let ancestors:Vec<_>=c.ancestors.iter().map(Vec::as_slice).collect();
    let prepare=|witness:&Transaction,vin|proof::prepare_unlock(proof::UnlockOptions{current_tx:&c.current,input_index:c.vin,parent:&c.parent,
        ancestor_raws:&ancestors,output_groups:&c.groups,public_key:&c.key,
        contract_controller:Some(proof::ContractControllerWitness{transaction:witness,current_input_index:vin})});
    assert!(prepare(&parent,c.current.inputs.len()-1).is_ok());assert!(prepare(&parent,c.vin).is_err());
    let mut wrong=parent.clone();wrong.lock_time=1;assert!(prepare(&wrong,c.current.inputs.len()-1).is_err());
}
