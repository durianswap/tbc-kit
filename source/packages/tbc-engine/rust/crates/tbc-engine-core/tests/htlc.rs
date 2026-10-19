use sha2::{Digest,Sha256};
use tbc_engine_core::protocols::htlc::{Code,CODE_BYTES,REFUND_SEQUENCE};
const SENDER:[u8;20]=[0x11;20];
const RECEIVER:[u8;20]=[0x22;20];
fn code(lock:u32)->Code { Code{sender_hash:SENDER,receiver_hash:RECEIVER,
    hashlock:Sha256::digest([0x33;32]).into(),raw_lock_time:lock} }
fn hex(b:&[u8])->String { b.iter().map(|v|format!("{v:02x}")).collect() }
#[test]
fn fixed_sdk_htlc_code_roundtrip_and_token_controller(){
    for lock in [0,1,834801,499999999,500000000,1774427165,2147483647,2147483648,u32::MAX] {
        let code=code(lock);let bytes=code.encode();assert_eq!(bytes.len(),CODE_BYTES);
        assert_eq!(Code::decode(&bytes).unwrap(),code);
        if std::env::var("HTLC_DUMP_WIRE").as_deref()==Ok("1") {
            println!("HTLC_WIRE:{}",serde_json::json!({"lock":lock,"sender":hex(&SENDER),"receiver":hex(&RECEIVER),
                "hashlock":hex(&code.hashlock),"script":hex(&bytes),"tokenController":hex(&code.token_controller()),
                "supported":code.supported_lock_time().is_ok()}));
        }
    }
}
#[test]
fn exact_template_and_branch_proofs_are_not_interchangeable(){
    let code=code(834801);let raw=code.encode();
    for i in (0..3).chain(35..39).chain(59..61).chain(65..114).chain(134..137) {
        let mut bad=raw.clone();bad[i]^=1;assert!(Code::decode(&bad).is_err(),"offset {i}");
    }
    assert!(Code::decode(&raw[..136]).is_err());let mut extra=raw.clone();extra.push(0);assert!(Code::decode(&extra).is_err());
    for i in [3,39,61,114] { let mut changed=raw.clone();changed[i]^=1;assert_ne!(Code::decode(&changed).unwrap(),code); }
    assert!(code.verify_claim(&RECEIVER,&[0x33;32]).is_ok());
    assert!(code.verify_claim(&SENDER,&[0x33;32]).is_err());
    let error=code.verify_claim(&RECEIVER,b"not-a-secret-to-log").unwrap_err();assert!(!error.to_string().contains("not-a-secret"));
    assert!(code.verify_refund(&RECEIVER,REFUND_SEQUENCE,834801).is_err());
    assert!(code.verify_refund(&SENDER,REFUND_SEQUENCE,834801).is_ok());
}
#[test]
fn height_and_timestamp_refunds_require_role_sequence_domain_and_chain_maturity(){
    let height=code(834801);
    assert!(height.verify_refund_context(&SENDER,REFUND_SEQUENCE,834801,834801,None).is_ok());
    for (sequence,tx,tip) in [(u32::MAX,834801,834801),(REFUND_SEQUENCE,834800,834801),
        (REFUND_SEQUENCE,834801,834800),(REFUND_SEQUENCE,1774427165,834801)] {
        assert!(height.verify_refund_context(&SENDER,sequence,tx,tip,None).is_err());
    }
    let timestamp=code(1774427165);
    assert!(timestamp.verify_refund_context(&SENDER,REFUND_SEQUENCE,1774427165,834801,Some(1774427166)).is_ok());
    for mtp in [None,Some(1774427164),Some(1774427165)] {
        assert!(timestamp.verify_refund_context(&SENDER,REFUND_SEQUENCE,1774427165,834801,mtp).is_err());
    }
    assert!(timestamp.verify_refund(&SENDER,REFUND_SEQUENCE,834801).is_err());
    for lock in [0,2147483648,u32::MAX] { assert!(code(lock).supported_lock_time().is_err()); }
    // Refund maturity must not close the independent claim branch.
    assert!(height.verify_refund_context(&SENDER,REFUND_SEQUENCE,834801,834900,None).is_ok());
    assert!(height.verify_claim(&RECEIVER,&[0x33;32]).is_ok());
}
