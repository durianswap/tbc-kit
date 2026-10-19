use serde_json::Value;
use tbc_engine_core::protocols::amm_pool_proof::*;
use tbc_sdk::{Transaction,hash,script::Script};
fn fixture()->Value{serde_json::from_str(include_str!("../../../fixtures/amm-pool-proof.json")).unwrap()}
fn bytes(s:&str)->Vec<u8>{(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
fn hex(b:&[u8])->String{b.iter().map(|b|format!("{b:02x}")).collect()}
fn tx(f:&Value,id:&Value)->Transaction{Transaction::from_hex(f["raws"][id.as_str().unwrap()].as_str().unwrap()).unwrap()}
struct Case{current:Transaction,parent:Transaction,ancestor:Transaction,aux:Vec<Transaction>,operation:Operation,pool_hash:[u8;32],key:Option<Vec<u8>>}
impl Case{
    fn load(f:&Value,v:&Value)->Self{Self{
        current:Transaction::from_hex(v["currentRaw"].as_str().unwrap()).unwrap(),parent:tx(f,&v["parentTxid"]),ancestor:tx(f,&v["ancestorTxid"]),
        aux:v["auxiliaryTxids"].as_array().unwrap().iter().map(|id|tx(f,id)).collect(),
        operation:match v["operation"].as_u64().unwrap(){1=>Operation::AddLp,2=>Operation::RemoveLp,3=>Operation::BuyFt,4=>Operation::SellFt,_=>panic!()},
        pool_hash:bytes(v["poolHash"].as_str().unwrap()).try_into().unwrap(),key:v["publicKeyHex"].as_str().map(bytes),
    }}
    fn options<'a>(&'a self,aux:&'a [&'a Transaction])->UnlockOptions<'a>{UnlockOptions{current_tx:&self.current,parent:&self.parent,ancestor:&self.ancestor,
        auxiliary_parents:aux,operation:self.operation,expected_pool_hash:&self.pool_hash,controller_public_key:self.key.as_deref()}}
    fn prepare(&self)->Result<PreparedUnlock,tbc_engine_core::EngineError>{let aux:Vec<_>=self.aux.iter().collect();prepare_unlock(self.options(&aux))}
}

#[test]
fn sixteen_pool_abis_external_controller_signatures_and_raw_match_sdk(){
    let f=fixture();assert_eq!(f["vectors"].as_array().unwrap().len(),16);
    for v in f["vectors"].as_array().unwrap(){
        let c=Case::load(&f,v);let prepared=c.prepare().unwrap();
        assert_eq!(prepared.proof_fields().len(),c.operation.leaf_count(c.key.is_some()));
        for (index,field) in prepared.proof_fields().iter().enumerate(){
            if index==0&&c.key.is_some(){assert!(field.is_empty());continue;}
            assert_eq!(hex(&hash::sha256(field)),v["fieldHashes"][index].as_str().unwrap(),"{} leaf {index}",v["id"]);
        }
        assert_eq!(prepared.signing_digest().map(|d|hex(d)),v["digestHex"].as_str().map(str::to_owned));
        assert_eq!(prepared.controller_public_key(),c.key.as_deref());
        let signature=v["signatureHex"].as_str().map(bytes);
        let script=prepared.finalize(signature.as_deref()).unwrap();
        assert_eq!(hex(&hash::sha256(script.as_bytes())),v["unlockHash"].as_str().unwrap());
        assert!(script.as_bytes().len()<=prepared.max_unlocking_script_bytes());
        let mut signed=tx(&f,&v["signedTxid"]);assert_eq!(signed.inputs[0].script_sig,script);
        signed.inputs[0].script_sig=script;
        assert_eq!(signed.to_hex(),f["raws"][v["signedTxid"].as_str().unwrap()].as_str().unwrap());
        assert_eq!(signed.txid().to_string(),v["signedTxid"].as_str().unwrap());
    }
}

#[test]
fn pool_material_identity_layout_and_controller_fail_before_digest(){
    let f=fixture();
    for v in f["vectors"].as_array().unwrap(){
        for mutation in 0..12{
            let mut c=Case::load(&f,v);
            match mutation {
                0=>c.pool_hash[0]^=1,
                1=>c.current.inputs[0].previous_output.vout=1,
                2=>c.current.inputs[1].previous_output=c.current.inputs[0].previous_output.clone(),
                3=>c.aux.pop().map(|_|()).unwrap(),
                4=>c.aux.swap(0,1),
                5=>c.ancestor.lock_time^=1,
                6=>c.current.outputs[0].script_pubkey=Script::from_bytes(vec![0x51]),
                7=>c.current.outputs[1].satoshis=1,
                8=>c.current.version=9,
                9=>{c.current.outputs.truncate(2);},
                10=>{let mut tape=c.current.outputs[1].script_pubkey.as_bytes().to_vec();tape[96]^=1;c.current.outputs[1].script_pubkey=Script::from_bytes(tape);},
                _=>{c.key=if c.key.is_some(){None}else{Some(bytes("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"))};},
            }
            // Several inputs legitimately share one parent, so swapping their
            // identical parent object has no effect and must not be called bad.
            if mutation==4&&c.aux[0].txid()==c.aux[1].txid(){continue;}
            assert!(c.prepare().is_err(),"{} mutation {mutation}",v["id"]);
        }
    }
}

#[test]
fn controller_signature_is_bound_to_frozen_digest_and_public_has_none(){
    let f=fixture();
    for v in f["vectors"].as_array().unwrap(){
        let c=Case::load(&f,v);let prepared=c.prepare().unwrap();
        if let Some(s)=v["signatureHex"].as_str(){
            let sig=bytes(s);assert!(prepared.finalize(None).is_err());
            let mut bad=sig.clone();*bad.last_mut().unwrap()=1;assert!(prepared.finalize(Some(&bad)).is_err());
            let mut bad=sig.clone();bad[10]^=1;assert!(prepared.finalize(Some(&bad)).is_err());
            let mut changed=Case::load(&f,v);changed.current.lock_time+=1;let changed=changed.prepare().unwrap();
            assert!(changed.finalize(Some(&sig)).is_err());
            let mut wrong=Case::load(&f,v);wrong.key=Some(bytes("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"));assert!(wrong.prepare().is_err());
            // Finalize owns the proof snapshot and has no material resolver.
            drop(c);assert!(prepared.finalize(Some(&sig)).is_ok());
        }else{assert!(prepared.signing_digest().is_none());assert!(prepared.finalize(Some(&[0x41])).is_err());assert!(prepared.finalize(None).is_ok());}
    }
}

#[test]
fn four_output_layouts_keep_optional_pair_and_native_change_distinct(){
    for op in [Operation::AddLp,Operation::RemoveLp,Operation::BuyFt,Operation::SellFt]{
        let (min,max)=match op{Operation::BuyFt=>(7,8),Operation::RemoveLp=>(9,12),_=>(6,9)};
        for count in 0..16{
            let result=output_layout(op,count);
            if count<min||count>max{assert!(result.is_err());continue;}
            let layout=result.unwrap();let delta=count-min;
            assert_eq!(layout.native_change,((delta%2)==1).then_some(count-1));
            let paired=match op {Operation::AddLp|Operation::SellFt=>layout.ft_change,Operation::RemoveLp=>layout.lp_change,Operation::BuyFt=>None};
            assert_eq!(paired.is_some(),delta>=2);
        }
    }
}
