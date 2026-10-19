use serde_json::{Value,json};
use sha2::{Digest,Sha256};
use tbc_engine_core::protocols::{amm::{Result,MAX_AMOUNT},amm_code::{self as pool,Authorization},amm_lp as lp};
fn hex(bytes:&[u8])->String {bytes.iter().map(|b|format!("{b:02x}")).collect()}
fn bytes(h:&str)->Vec<u8>{(0..h.len()).step_by(2).map(|i|u8::from_str_radix(&h[i..i+2],16).unwrap()).collect()}
fn b(v:&Value)->Vec<u8>{bytes(v.as_str().unwrap())}
fn n(v:&Value)->u64 {v.as_u64().unwrap()}
fn flag(v:&Value)->bool {v.as_bool().unwrap()}
fn authorization(v:&Value)->Authorization {
    if v.is_null(){Authorization::Public}else{Authorization::Controller(v.as_array().unwrap().iter().map(|h|b(h).try_into().unwrap()).collect())}
}
fn fixture()->Value{serde_json::from_str(include_str!("../../../fixtures/amm-code.json")).unwrap()}
fn run(op:&str,i:&Value)->Result<Value>{
    match op {
        "pool"=>{
            let code=pool::Code{original_utxo:b(&i["original"]).try_into().unwrap(),fee_script_hash:b(&i["fee"]).try_into().unwrap(),
                ft_tape_size:n(&i["size"]) as u8,authorization:authorization(&i["controllers"])};
            let raw=pool::instantiate_code(&code)?;let parsed=pool::parse_code(&raw)?;
            let controllers=match parsed.authorization{Authorization::Public=>Value::Null,Authorization::Controller(h)=>json!(h.iter().map(|b|hex(b)).collect::<Vec<_>>())};
            Ok(json!({"hash":hex(&pool::code_hash(&raw)?),"size":raw.len(),"controllers":controllers}))
        },
        "lp"=>{
            let code=lp::Code{pool_code_hash:b(&i["poolHash"]).try_into().unwrap(),controller:b(&i["controller"]).try_into().unwrap(),
                tape_size:n(&i["size"]) as u8,timelocked:flag(&i["timelocked"])};
            let raw=lp::instantiate_code(&code)?;assert_eq!(lp::parse_code(&raw)?,code);
            let mut controller=[0x99;21];controller[20]=1;
            let replacement=lp::replace_controller(&raw,controller)?;
            assert_eq!(lp::code_identity(&raw)?,lp::code_identity(&replacement)?);
            Ok(json!({"hash":hex(&Sha256::digest(&raw)),"size":raw.len(),"identity":hex(&lp::code_identity(&raw)?),"replacementHash":hex(&Sha256::digest(&replacement))}))
        },
        "tape"=>{
            let tape=lp::Tape {size:n(&i["size"]) as u8,timelocked:flag(&i["timelocked"]),lock_time:n(&i["lockTime"]) as u32,
                amounts:std::array::from_fn(|j|i["amounts"][j].as_str().unwrap().parse().unwrap())};
            let raw=tape.encode()?;assert_eq!(lp::Tape::decode(&raw,tape.timelocked,Some(tape.size))?,tape);
            Ok(json!({"hex":hex(&raw),"balance":tape.balance()?.to_string()}))
        },
        "requiredLock"=>Ok(json!(lp::required_lock_time(&i["locks"].as_array().unwrap().iter().map(|v|n(v) as u32).collect::<Vec<_>>())?)),
        "inputLock"=>{
            lp::Tape{size:66,timelocked:flag(&i["timelocked"]),lock_time:n(&i["lockTime"]) as u32,amounts:[0;6]}
                .verify_input_lock(n(&i["sequence"]) as u32,n(&i["txLock"]) as u32)?;Ok(json!(true))
        },
        "controller"=>{authorization(&i["controllers"]).verify_controller(&b(&i["key"]))?;Ok(json!(true))},
        _=>panic!("unknown oracle operation"),
    }
}
#[test]
fn pool_lp_match_pinned_sdk_code_identity_tape_locks_and_controller(){
    let f=fixture();assert_eq!(f["cases"].as_array().unwrap().len(),100);
    for (index,row) in f["cases"].as_array().unwrap().iter().enumerate(){
        let result=run(row["op"].as_str().unwrap(),&row["input"]);
        let actual=match result{Ok(v)=>json!({"ok":true,"value":v}),Err(_)=>json!({"ok":false})};
        assert_eq!(actual,row["expected"],"SDK vector {index}: {}",row["op"]);
    }
}
#[test]
fn templates_reject_modified_bodies_truncation_trailing_and_marker_only(){
    for authorization in [Authorization::Public,Authorization::Controller(vec![[1;20],[2;20],[3;20]])]{
        let code=pool::Code{original_utxo:[0x12;36],fee_script_hash:[0x34;32],ft_tape_size:66,authorization};
        let raw=pool::instantiate_code(&code).unwrap();
        for i in 0..raw.len(){
            let mut altered=raw.clone();altered[i]^=1;
            if let Ok(parsed)=pool::parse_code(&altered){assert_ne!(parsed,code,"modified fixed byte {i}");assert_eq!(pool::instantiate_code(&parsed).unwrap(),altered);}
        }
        for len in [0,1,35,raw.len()-1]{assert!(pool::parse_code(&raw[..len]).is_err());}
        let mut trailing=raw.clone();trailing.push(0);assert!(pool::parse_code(&trailing).is_err());
    }
    for timelocked in [false,true]{
        let code=lp::Code{pool_code_hash:[0x56;32],controller:[0;21],tape_size:66,timelocked};
        let raw=lp::instantiate_code(&code).unwrap();
        for i in 0..raw.len(){
            let mut altered=raw.clone();altered[i]^=1;
            if let Ok(parsed)=lp::parse_code(&altered){assert_ne!(parsed,code,"modified fixed byte {i}");assert_eq!(lp::instantiate_code(&parsed).unwrap(),altered);}
        }
        for len in [0,1,35,raw.len()-1]{assert!(lp::parse_code(&raw[..len]).is_err());}
        let mut trailing=raw.clone();trailing.push(0);assert!(lp::parse_code(&trailing).is_err());
        assert!(pool::parse_code(&raw).is_err());
        let mut changed=code.clone();changed.pool_code_hash[0]^=1;
        assert_ne!(lp::code_identity(&raw).unwrap(),lp::code_identity(&lp::instantiate_code(&changed).unwrap()).unwrap());
    }
    assert!(pool::parse_code(b"POOLCODE2").is_err());assert!(lp::parse_code(b"LPTBC20CODE2").is_err());
}
#[test]
fn whitelist_rejects_unsorted_duplicate_indirect_pushes_and_extra_branches(){
    let hashes=vec![[1;20],[2;20],[3;20],[4;20],[5;20]];
    let valid=pool::controller_membership(&hashes).unwrap();assert_eq!(pool::parse_membership(&valid).unwrap(),hashes);
    for len in 0..valid.len(){assert!(pool::parse_membership(&valid[..len]).is_err());}
    let mut unsorted=valid.clone();unsorted[2..22].fill(6);assert!(pool::parse_membership(&unsorted).is_err());
    let mut duplicate=valid.clone();duplicate[2..22].fill(2);assert!(pool::parse_membership(&duplicate).is_err());
    let mut indirect=valid.clone();indirect.insert(1,0x4c);assert!(pool::parse_membership(&indirect).is_err());
    let mut trailing=valid.clone();trailing.push(0x68);assert!(pool::parse_membership(&trailing).is_err());
    assert!(pool::controller_membership(&[]).is_err());assert!(pool::controller_membership(&[[1;20];6]).is_err());
}
#[test]
fn lp_tape_requires_canonical_padding_and_code_mode_and_signed_slot_bounds(){
    for timelocked in [false,true]{
        let tape=lp::Tape{amounts:[MAX_AMOUNT;6],size:127,timelocked,lock_time:0};
        let raw=tape.encode().unwrap();assert_eq!(tape.balance().unwrap(),6*MAX_AMOUNT as u128);
        for offset in [0,1,2,70,117,126]{let mut changed=raw.clone();changed[offset]^=1;assert!(lp::Tape::decode(&changed,timelocked,None).is_err());}
        for slot in 0..6{let mut changed=raw.clone();changed[3+8*slot..11+8*slot].copy_from_slice(&(MAX_AMOUNT+1).to_le_bytes());assert!(lp::Tape::decode(&changed,timelocked,None).is_err());}
        assert!(lp::Tape::decode(&raw,!timelocked,None).is_err());
        assert!(lp::Tape::decode(&raw,timelocked,Some(66)).is_err());
        for len in [0,3,60,128,256]{let mut changed=raw.clone();changed.resize(len,0);assert!(lp::Tape::decode(&changed,timelocked,None).is_err());}
    }
}
