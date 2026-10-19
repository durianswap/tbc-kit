use serde_json::Value;
use tbc_engine_core::{ErrorCode,protocols::{amm_code,amm_mint::*,amm_state::*,amm_transaction::MinerFeePolicy,tbc20},signing::*};
use tbc_sdk::{Transaction,PublicKey,hash,script::Script};
fn fixture()->Value{serde_json::from_str(include_str!("../../../fixtures/amm-pool-proof.json")).unwrap()}
fn bytes(s:&str)->Vec<u8>{(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
fn hex(b:&[u8])->String{b.iter().map(|b|format!("{b:02x}")).collect()}
fn tx(f:&Value,id:&str)->Transaction{Transaction::from_hex(f["raws"][id].as_str().unwrap()).unwrap()}
fn row<'a>(f:&'a Value,id:&str)->&'a Value{f["vectors"].as_array().unwrap().iter().find(|v|v["id"]==id).unwrap()}
fn owner()->PublicKey{PublicKey::from_slice(&bytes("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")).unwrap()}
struct Case{genesis:Transaction,pool:Transaction,config:PoolConfig,key:PublicKey}
impl Case{
    fn load(f:&Value,label:&str)->Self{
        let v=row(f,&format!("{label}-add"));let pool=tx(f,v["parentTxid"].as_str().unwrap());
        let genesis=tx(f,&pool.inputs[0].previous_output.txid.to_string());
        let auth=amm_code::parse_code(pool.outputs[0].script_pubkey.as_bytes()).unwrap().authorization;
        let config=PoolConfig::new(&genesis,&genesis.txid(),auth,label.ends_with("locked"),1,None).unwrap();
        Self{genesis,pool,config,key:owner()}
    }
    fn options(&self)->MintOptions<'_>{MintOptions{config:&self.config,funding_parent:&self.genesis,funding_vout:self.pool.inputs[0].previous_output.vout,
        funding_public_key:&self.key,change_hash:self.key.hash160(),fee_policy:MinerFeePolicy::default(),max_fee:10000}}
}
#[test]
fn four_genesis_builders_match_sdk_outputs_fees_and_complete_external_signature(){
    let f=fixture();
    for label in ["public-plain","public-locked","controller-plain","controller-locked"]{
        let c=Case::load(&f,label);let built=build_mint_plan(c.options()).unwrap();
        assert_eq!(built.change_output_index,Some(4));assert_eq!(built.unsigned_plan.transactions[0].outputs.len(),5);
        let expected_fee=c.genesis.outputs[c.pool.inputs[0].previous_output.vout as usize].satoshis-c.pool.outputs.iter().map(|o|o.satoshis).sum::<u64>();
        assert_eq!(built.fee,expected_fee);assert!(c.pool.serialize().len()<=built.maximum_signed_bytes);
        let stage=begin_signing(&built.unsigned_plan).unwrap();assert_eq!(stage.signing_requests.len(),1,"Controller is not needed for genesis funding");
        let r=&stage.signing_requests[0];assert_eq!(r.script_class,"p2pkh");let script=c.pool.inputs[0].script_sig.as_bytes();
        let sig=ExternalSignature{session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),transaction_id:r.transaction_id.clone(),
            input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),signature:hex(&script[1..script[0] as usize])};
        let StageOutcome::Complete(bundle)=finalize_signing_stage(&built.unsigned_plan,stage,&[sig]).unwrap()else{panic!("single genesis")};
        assert_eq!(bundle.transactions[0].raw_transaction,c.pool.to_hex(),"{label}");assert_eq!(bundle.transactions[0].txid,c.pool.txid().to_string());
        let snapshot=c.config.read_pool(&c.pool,&hash::sha256(c.pool.outputs[0].script_pubkey.as_bytes())).unwrap();
        assert_eq!(snapshot.math().ft_lp_amount,0);assert_eq!(snapshot.math().pool_value,1500);
        assert_eq!(c.config.validate_ft(&c.pool,2,&c.key,Some(&snapshot)).unwrap().balance,0);
    }
}
#[test]
fn all_live_fixture_states_bind_asset_metadata_pool_holdings_and_lp(){
    let f=fixture();
    for label in ["public-plain","public-locked","controller-plain","controller-locked"]{
        let c=Case::load(&f,label);
        for action in ["add","buy","sell","remove"]{
            let v=row(&f,&format!("{label}-{action}"));let current=Transaction::from_hex(v["currentRaw"].as_str().unwrap()).unwrap();
            let parent=tx(&f,v["parentTxid"].as_str().unwrap());let expected=bytes(v["poolHash"].as_str().unwrap()).try_into().unwrap();
            let state=c.config.read_pool(&parent,&expected).unwrap();
            let point=&current.inputs[2].previous_output;let ft=tx(&f,&point.txid.to_string());
            assert_eq!(c.config.validate_ft(&ft,point.vout as usize,&c.key,Some(&state)).unwrap().balance,state.math().ft_a_amount as u128);
            if action=="remove"{let point=&current.inputs[1].previous_output;let lp=tx(&f,&point.txid.to_string());
                let tape=c.config.validate_lp(&lp,point.vout as usize,&c.key,&state).unwrap();assert_eq!(tape.balance().unwrap(),100000);
                let mut changed_genesis=c.genesis.clone();changed_genesis.lock_time+=1;
                let other=PoolConfig::new(&changed_genesis,&changed_genesis.txid(),c.config.authorization().clone(),c.config.timelocked(),1,None).unwrap();
                assert!(other.validate_lp(&lp,point.vout as usize,&c.key,&state).is_err(),"a snapshot cannot be borrowed by another FT config");
            }else if action!="buy"{let point=&current.inputs[1].previous_output;let ft=tx(&f,&point.txid.to_string());assert!(c.config.validate_ft(&ft,point.vout as usize,&c.key,None).is_ok());}
        }
    }
}
#[test]
fn state_rejects_wrong_genesis_pool_metadata_fee_controller_and_owned_funding(){
    let f=fixture();let c=Case::load(&f,"public-plain");
    assert!(PoolConfig::new(&c.genesis,&c.pool.txid(),c.config.authorization().clone(),false,1,None).is_err());
    assert!(PoolConfig::new(&c.genesis,&c.genesis.txid(),c.config.authorization().clone(),true,1,None).is_err());
    assert!(PoolConfig::new(&c.genesis,&c.genesis.txid(),c.config.authorization().clone(),false,1,Some(36)).is_err());
    let mut not_genesis=c.genesis.clone();not_genesis.inputs[0].previous_output.vout^=1;
    assert!(PoolConfig::new(&not_genesis,&not_genesis.txid(),c.config.authorization().clone(),false,1,None).is_err());
    let mut not_genesis=c.genesis.clone();let tape=tbc20::parse_tape(not_genesis.outputs[1].script_pubkey.as_bytes()).unwrap();let mut amounts=tape.amounts;amounts[1]=1;
    not_genesis.outputs[1].script_pubkey=Script::from_bytes(tbc20::build_tape(amounts,&tape.extension).unwrap());
    assert!(PoolConfig::new(&not_genesis,&not_genesis.txid(),c.config.authorization().clone(),false,1,None).is_err());
    let pool_hash=hash::sha256(c.pool.outputs[0].script_pubkey.as_bytes());
    assert!(c.config.read_pool(&c.pool,&[0;32]).is_err());
    for offset in [4,38,96,128,130,131,132]{let mut pool=c.pool.clone();let mut tape=pool.outputs[1].script_pubkey.as_bytes().to_vec();tape[offset]^=1;pool.outputs[1].script_pubkey=Script::from_bytes(tape);assert!(c.config.read_pool(&pool,&pool_hash).is_err(),"Tape {offset}");}
    let mut pool=c.pool.clone();let mut descriptor=amm_code::parse_code(pool.outputs[0].script_pubkey.as_bytes()).unwrap();descriptor.fee_script_hash[0]^=1;
    pool.outputs[0].script_pubkey=Script::from_bytes(amm_code::instantiate_code(&descriptor).unwrap());assert!(c.config.read_pool(&pool,&hash::sha256(pool.outputs[0].script_pubkey.as_bytes())).is_err());
    let mut o=c.options();o.max_fee=1;assert_eq!(build_mint_plan(o).unwrap_err().code,ErrorCode::FeeCapExceeded);
    let wrong=PublicKey::from_slice(&bytes("02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5")).unwrap();
    let mut o=c.options();o.funding_public_key=&wrong;assert!(build_mint_plan(o).is_err());
}
#[test]
fn mint_fee_exact_change_dust_no_change_and_insufficient_are_bounded(){
    let f=fixture();let c=Case::load(&f,"public-plain");let normal=build_mint_plan(c.options()).unwrap();
    // Changing funding creates a different Pool, but identical witness widths.
    let mut funding=c.genesis.clone();let index=c.pool.inputs[0].previous_output.vout as usize;
    funding.outputs[index].satoshis=2000+normal.fee+10;
    let mut o=c.options();o.funding_parent=&funding;let exact=build_mint_plan(o).unwrap();assert_eq!(exact.unsigned_plan.transactions[0].outputs[4].satoshis,10);
    funding.outputs[index].satoshis-=1;let mut o=c.options();o.funding_parent=&funding;let no_change=build_mint_plan(o).unwrap();assert_eq!(no_change.change_output_index,None);assert_eq!(no_change.unsigned_plan.transactions[0].outputs.len(),4);
    funding.outputs[index].satoshis=2001;let mut o=c.options();o.funding_parent=&funding;assert_eq!(build_mint_plan(o).unwrap_err().code,ErrorCode::InsufficientFunds);
}
