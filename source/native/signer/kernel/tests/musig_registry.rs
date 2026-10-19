#![cfg(feature = "musig")]
use secp256k1::{PublicKey, Secp256k1, SecretKey};
use tbc_signer_kernel::musig::{Error, Group, Round, registry::{Registry, MAX_SESSIONS, MAX_TTL_MS}};
fn scalar(n:u8)->[u8;32]{let mut v=[0;32];v[31]=n;v}
fn group()->Group{
    let keys=[1,2].map(|n|PublicKey::from_secret_key(&Secp256k1::new(),&SecretKey::from_byte_array(scalar(n)).unwrap()).serialize());
    let expected="3b46d262d2f610e9038b44beabdfe97ab5a0feb89870acc2264edfb7f63ec2ec";
    Group::new(&keys,std::array::from_fn(|i|u8::from_str_radix(&expected[i*2..i*2+2],16).unwrap())).unwrap()
}
fn begin(r:&mut Registry,n:u8,entropy:u8)->([u8;32],[u8;66]){
    let mut fresh=[entropy;32];let result=r.begin(group(),[0x37;32],[0x20;32],&scalar(n),&mut fresh,100,200).unwrap();assert_eq!(fresh,[0;32]);result
}
#[test]
fn private_handles_sign_and_disappear(){
    let mut r=Registry::default();let (ha,na)=begin(&mut r,1,1);let (hb,nb)=begin(&mut r,2,2);assert_ne!(ha,hb);
    let nonces=[na,nb];let sa=r.sign_once(ha,[0x20;32],[0x37;32],&scalar(1),&nonces,150).unwrap();
    let sb=r.sign_once(hb,[0x20;32],[0x37;32],&scalar(2),&nonces,150).unwrap();
    assert_eq!(r.active_count(),0);assert!(Round::new(group(),[0x37;32],&nonces).unwrap().combine(&[sa,sb]).is_ok());
    assert_eq!(r.sign_once(ha,[0x20;32],[0x37;32],&scalar(1),&nonces,151),Err(Error::Consumed));
}
#[test]
fn expiry_and_rollback_consume_without_revival(){
    for now in [99,200,201] {
        let mut r=Registry::default();let(h,_)=begin(&mut r,1,1);
        assert_eq!(r.sign_once(h,[0x20;32],[0x37;32],&scalar(1),&[],now),Err(Error::Expired));
        assert_eq!(r.active_count(),0);
        assert_eq!(r.sign_once(h,[0x20;32],[0x37;32],&scalar(1),&[],150),Err(Error::Consumed));
    }
}
#[test]
fn invalid_transcript_cancel_and_restart_cannot_recover_session(){
    let mut r=Registry::default();let(h,_)=begin(&mut r,1,1);
    assert!(r.sign_once(h,[0;32],[0x37;32],&scalar(1),&[],150).is_err());assert_eq!(r.active_count(),0);
    let(h,_)=begin(&mut r,1,2);r.cancel(h);assert_eq!(r.active_count(),0);
    let(h,_)=begin(&mut r,1,3);r.cancel_all();
    assert_eq!(r.sign_once(h,[0x20;32],[0x37;32],&scalar(1),&[],150),Err(Error::Consumed));
    let(h,_)=begin(&mut r,1,4);drop(r);let mut restarted=Registry::default();
    assert_eq!(restarted.sign_once(h,[0x20;32],[0x37;32],&scalar(1),&[],150),Err(Error::Consumed));
}
#[test]
fn capacity_and_ttl_are_bounded_and_failed_entropy_is_erased(){
    let mut r=Registry::default();
    for n in 1..=MAX_SESSIONS {begin(&mut r,1,n as u8);}
    let mut entropy=[99;32];assert!(matches!(r.begin(group(),[0x37;32],[0x20;32],&scalar(1),&mut entropy,100,200),Err(Error::Capacity)));assert_eq!(entropy,[0;32]);
    r.purge(200);assert_eq!(r.active_count(),0);
    for expires in [100,100+MAX_TTL_MS+1] {
        let mut entropy=[1;32];assert!(matches!(r.begin(group(),[0x37;32],[0x20;32],&scalar(1),&mut entropy,100,expires),Err(Error::Expired)));assert_eq!(entropy,[0;32]);
    }
}
