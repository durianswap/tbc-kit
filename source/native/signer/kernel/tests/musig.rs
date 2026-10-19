#![cfg(feature="musig")]
use tbc_signer_kernel::musig::{Error,Group,Round,SignerSession};
use secp256k1::{PublicKey,Secp256k1,SecretKey};
fn hex<const N:usize>(s:&str)->[u8;N]{assert_eq!(s.len(),N*2);std::array::from_fn(|i|u8::from_str_radix(&s[i*2..i*2+2],16).unwrap())}
fn scalar(n:u8)->[u8;32]{let mut k=[0;32];k[31]=n;k}
fn keys()->[[u8;33];2]{[1,2].map(|n|PublicKey::from_secret_key(&Secp256k1::new(),&SecretKey::from_byte_array(scalar(n)).unwrap()).serialize())}
fn aggregate()->[u8;32]{hex("3b46d262d2f610e9038b44beabdfe97ab5a0feb89870acc2264edfb7f63ec2ec")}
fn group()->Group{Group::new(&keys(),aggregate()).unwrap()}
fn start(n:u8)->SignerSession{let mut entropy=[0x50+n;32];let s=SignerSession::begin(group(),[0x37;32],[0x20;32],&scalar(n),&mut entropy).unwrap();assert_eq!(entropy,[0;32]);s}

#[test]
fn public_group_derivation_needs_no_expected_key_or_secret(){
    assert_eq!(Group::from_public_keys(&keys()).unwrap().aggregate_key(),aggregate());
    for invalid in [vec![],vec![keys()[0]],vec![keys()[0];2],vec![keys()[1],keys()[0]],vec![[0;33];2],vec![keys()[0];33]] {
        assert!(matches!(Group::from_public_keys(&invalid),Err(Error::InvalidGroup)));
    }
    // Derivation never relaxes execution's expected on-chain group binding.
    assert!(matches!(Group::new(&keys(),[0;32]),Err(Error::BindingMismatch)));
}

#[test]
fn fixed_sdk_public_transcript_combines_exactly(){
    // From 4HF independently compiled C, cross-verified by tbc-lib-js 1.0.31.
    let nonces=[hex("033da6c727aab155e4209440ed6f304d9297b33df74583cd659cfe6c2f59992b180355386fd4455d681989141573c5aabdc21e423beb8793b70d5f510f192d857374"),hex("02b743f435ba70d51934f7ef76a343cb1ed90ecf74e3bdfe12ad96ddc16b8351ca02130ac9140773ab66a5bcb7c6f2893768d5fa93f9cdedf51c8c930d7a8c674bc0")];
    let shares=[hex("92f5ba377d5664886a116973986ce1a3c7012d624355cc9656116040982d0490"),hex("d4ac1d533b7942a25aafd2c6e2c426c598f8a86c2453bc03421d4d09cfef90d4")];
    let round=Round::new(group(),[0x37;32],&nonces).unwrap();
    assert_eq!(round.combine(&shares).unwrap(),hex("e9e2423bbb17a4755f9487e82ac3491d7d4470009272f4947ad804298f469bfe67a1d78ab8cfa72ac4c13c3a7b31086aa54af8e7b860e85dd85c4ebd97e65423"));
    assert_eq!(round.combine(&shares[..1]),Err(Error::InvalidSignature));
    let mut tampered=shares;tampered[1][31]^=1;assert_eq!(round.combine(&tampered),Err(Error::InvalidSignature));
    assert_eq!(Round::new(group(),[0x38;32],&nonces).unwrap().combine(&shares),Err(Error::InvalidSignature));
}

#[test]
fn two_sessions_sign_once_and_aggregate_without_retaining_keys(){
    let mut a=start(1);let mut b=start(2);let nonces=[a.public_nonce(),b.public_nonce()];
    let shares=[a.sign_once([0x20;32],[0x37;32],&scalar(1),&nonces).unwrap(),b.sign_once([0x20;32],[0x37;32],&scalar(2),&nonces).unwrap()];
    assert!(a.is_consumed()&&b.is_consumed());assert!(Round::new(group(),[0x37;32],&nonces).unwrap().combine(&shares).is_ok());
    assert_eq!(a.sign_once([0x20;32],[0x37;32],&scalar(1),&nonces),Err(Error::Consumed));
}

#[test]
fn binding_message_secret_and_external_nonce_failure_all_burn_session(){
    for case in 0..5{
        let mut a=start(1);let b=start(2);let mut nonces=[a.public_nonce(),b.public_nonce()];
        let mut binding=[0x20;32];let mut digest=[0x37;32];let mut key=scalar(1);
        match case{0=>binding[0]^=1,1=>digest[0]^=1,2=>key=scalar(2),3=>nonces.swap(0,1),_=>nonces[1]=[0;66]}
        assert!(a.sign_once(binding,digest,&key,&nonces).is_err());assert!(a.is_consumed());
        assert_eq!(a.sign_once([0x20;32],[0x37;32],&scalar(1),&nonces),Err(Error::Consumed));
    }
}

#[test]
fn cancellation_and_incomplete_or_duplicate_round_fail_closed(){
    let mut a=start(1);a.cancel();a.cancel();assert!(a.is_consumed());
    assert_eq!(a.sign_once([0x20;32],[0x37;32],&scalar(1),&[]),Err(Error::Consumed));
    assert!(matches!(Round::new(group(),[0x37;32],&[a.public_nonce()]),Err(Error::InvalidNonce)));
    assert!(matches!(Round::new(group(),[0x37;32],&[a.public_nonce();2]),Err(Error::InvalidNonce)));
}

#[test]
fn group_and_entropy_boundaries(){
    assert!(matches!(Group::new(&[keys()[0];2],aggregate()),Err(Error::InvalidGroup)));
    let mut reversed=keys();reversed.reverse();assert!(matches!(Group::new(&reversed,aggregate()),Err(Error::InvalidGroup)));
    assert!(matches!(Group::new(&keys(),[0;32]),Err(Error::BindingMismatch)));
    assert!(matches!(SignerSession::begin(group(),[0;32],[1;32],&scalar(1),&mut[0;32]),Err(Error::InvalidNonce)));
    let mut entropy=[5;32];assert!(matches!(SignerSession::begin(group(),[0;32],[1;32],&scalar(3),&mut entropy),Err(Error::InvalidSecret)));assert_eq!(entropy,[0;32]);
}
