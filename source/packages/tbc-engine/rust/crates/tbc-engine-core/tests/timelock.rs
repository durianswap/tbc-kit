use tbc_engine_core::protocols::timelock::{Code,height_code,UNLOCK_SEQUENCE,CODE_BYTES};
const OWNER:[u8;20]=[0x75,0x1e,0x76,0xe8,0x19,0x91,0x96,0xd4,0x54,0x94,0x1c,0x45,0xd1,0xb3,0xa3,0x23,0xf1,0x43,0x3b,0xd6];
fn hex(bytes:&[u8])->String{bytes.iter().map(|b|format!("{b:02x}")).collect()}
#[test]
fn fixed_sdk_timelock_bytes_roundtrip_and_preserve_raw_lock_values(){
    for lock in [0,1,830000,499999999,500000000,2147483647,2147483648,u32::MAX]{
        let code=Code{owner_hash:OWNER,raw_lock_time:lock};let raw=code.encode();assert_eq!(raw.len(),CODE_BYTES);
        assert_eq!(Code::decode(&raw).unwrap(),code);
        if std::env::var("TIMELOCK_DUMP_WIRE").as_deref()==Ok("1"){
            println!("TIMELOCK_WIRE:{}",serde_json::json!({"lock":lock,"script":hex(&raw),"heightSupported":code.height_lock().is_ok()}));
        }
    }
    assert_eq!(hex(&height_code(OWNER,830000).unwrap()),"76a914751e76e8199196d454941c45d1b3a323f1433bd688ad56ba01247f778104ffffffff819e51880430aa0c008152ba81a15187");
}
#[test]
fn timelock_checks_entire_template_not_length_or_owner_alone(){
    let raw=height_code(OWNER,830000).unwrap();
    for i in (0..3).chain(23..42).chain(46..CODE_BYTES){let mut bad=raw.clone();bad[i]^=1;assert!(Code::decode(&bad).is_err(),"offset {i}");}
    assert!(Code::decode(&raw[..52]).is_err());let mut extra=raw.clone();extra.push(0);assert!(Code::decode(&extra).is_err());
    let mut replacement=raw;replacement[3]^=1;assert_ne!(Code::decode(&replacement).unwrap().owner_hash,OWNER);
}
#[test]
fn height_profile_preserves_necessary_sequence_time_and_maturity_boundaries(){
    let code=Code{owner_hash:OWNER,raw_lock_time:830000};
    assert!(code.validate_height_spend(UNLOCK_SEQUENCE,830000,830000).is_ok());
    assert!(code.validate_height_spend(UNLOCK_SEQUENCE,830010,830011).is_ok());
    for (sequence,tx,height) in [(u32::MAX,830000,830000),(UNLOCK_SEQUENCE,829999,830000),
        (UNLOCK_SEQUENCE,830000,829999),(UNLOCK_SEQUENCE,1700000000,830000),(UNLOCK_SEQUENCE,830000,1700000000)]{
        assert!(code.validate_height_spend(sequence,tx,height).is_err());
    }
    for lock in [500000000,2147483647,2147483648,u32::MAX]{assert!(height_code(OWNER,lock).is_err());}
}
