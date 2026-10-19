//! Fixed upstream ABI/digest/covenant vectors. Public scalar 1, fictitious funds.
use tbc_engine_core::protocols::{tbc721::{CodeDescriptor, instantiate_code, parse_code},
    tbc721_proof::{UnlockOptions, prepare_unlock}};
use tbc_sdk::{OutPoint, PrivateKey, Transaction, script::Script};

fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!("../../../fixtures/tbc721-standard-proof.json")).unwrap()
}
fn bytes(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i|u8::from_str_radix(&text[i..i+2],16).unwrap()).collect()
}
fn unhex(value: &serde_json::Value) -> Vec<u8> { bytes(value.as_str().unwrap()) }
fn tx(value: &serde_json::Value) -> Transaction { Transaction::from_bytes(&unhex(value)).unwrap() }

#[test]
fn tbc721_codec_matches_pinned_upstream_outpoint_vectors() {
    for vector in fixture()["codeVectors"].as_array().unwrap() {
        let code=unhex(&vector["codeHex"]);
        let descriptor=CodeDescriptor {original_outpoint: OutPoint {
            txid: vector["txid"].as_str().unwrap().parse().unwrap(),
            vout: vector["vout"].as_u64().unwrap() as u32,
        }};
        assert_eq!(parse_code(&code).unwrap(),descriptor);
        assert_eq!(instantiate_code(&descriptor),code);
        let mut original=Vec::new();descriptor.original_outpoint.serialize(&mut original);
        assert_eq!(original,unhex(&vector["originalOutpointHex"]));
    }
}

#[test]
fn tbc721_proof_matches_all_twenty_fields_digest_and_signed_upstream_witness() {
    for vector in fixture()["vectors"].as_array().unwrap() {
        let current=tx(&vector["currentRaw"]);let parent=tx(&vector["parentRaw"]);
        let grandparent=tx(&vector["grandparentRaw"]);let public=unhex(&vector["publicKeyHex"]);
        let prepared=prepare_unlock(UnlockOptions {current_tx:&current,parent_tx:&parent,
            grandparent_tx:&grandparent,public_key:&public}).unwrap();
        assert_eq!(prepared.signing_digest().as_slice(),unhex(&vector["digestBytesHex"]));
        let mut expected: Vec<Vec<u8>>=vector["fields"].as_array().unwrap().iter().map(unhex).collect();
        expected[0].clear();assert_eq!(prepared.proof_fields(),expected);
        let witness=prepared.finalize(&unhex(&vector["signatureHex"])).unwrap();
        assert_eq!(witness.as_bytes(),unhex(&vector["unlockHex"]));
        assert!(witness.as_bytes().len()<=prepared.max_unlocking_script_bytes());
        let mut signed=tx(&vector["signedRaw"]);signed.inputs[0].script_sig=witness;
        assert_eq!(signed.serialize(),unhex(&vector["signedRaw"]));
        assert_eq!(signed.txid().to_string(),vector["txid"].as_str().unwrap());
        // Independent native signer, not passed into any Engine constructor.
        let mut scalar=[0;32];scalar[31]=1;let key=PrivateKey::from_slice(&scalar).unwrap();
        let mut signature=key.sign_ecdsa_digest(prepared.signing_digest());signature.push(0x41);
        assert!(prepared.finalize(&signature).is_ok());
        let mut wrong=key.sign_ecdsa_digest(&[0x22;32]);wrong.push(0x41);
        assert!(prepared.finalize(&wrong).is_err());
        signature.pop();signature.push(1);assert!(prepared.finalize(&signature).is_err());
        assert!(prepared.finalize(&[0;72]).is_err());
    }
}

#[test]
fn tbc721_proof_rejects_changed_ancestry_owner_and_code() {
    let f=fixture();let vector=&f["vectors"][0];
    let current=tx(&vector["currentRaw"]);let parent=tx(&vector["parentRaw"]);
    let grandparent=tx(&vector["grandparentRaw"]);let public=unhex(&vector["publicKeyHex"]);
    let check=|c:&Transaction,p:&Transaction,g:&Transaction,k:&[u8]|prepare_unlock(UnlockOptions {
        current_tx:c,parent_tx:p,grandparent_tx:g,public_key:k}).is_err();
    let mut wrong=current.clone();wrong.inputs[0].previous_output.vout=1;
    assert!(check(&wrong,&parent,&grandparent,&public));
    let mut wrong=current.clone();wrong.outputs[0].script_pubkey=Script::from_bytes(vec![0x51]);
    assert!(check(&wrong,&parent,&grandparent,&public));
    let mut wrong=current.clone();wrong.inputs.push(wrong.inputs[1].clone());
    assert!(check(&wrong,&parent,&grandparent,&public));
    let mut wrong=grandparent.clone();wrong.lock_time+=1;
    assert!(check(&current,&parent,&wrong,&public));
    let mut wrong=parent.clone();wrong.outputs[1].satoshis+=1;
    assert!(check(&current,&wrong,&grandparent,&public));
    let mut scalar=[0;32];scalar[31]=2;
    assert!(check(&current,&parent,&grandparent,&PrivateKey::from_slice(&scalar).unwrap().public_key().to_bytes()));
    assert!(check(&current,&parent,&grandparent,&public[1..]));
    let mut wrong=parent.clone();wrong.outputs.truncate(1);
    assert!(check(&current,&wrong,&grandparent,&public));
    let mut wrong=current.clone();wrong.inputs.clear();
    assert!(check(&wrong,&parent,&grandparent,&public));
}

#[test]
fn tbc721_continued_ancestry_cannot_move_code_to_nonzero_vout() {
    let f=fixture();let vector=&f["vectors"][1];
    let mut current=tx(&vector["currentRaw"]);let mut parent=tx(&vector["parentRaw"]);
    let mut grandparent=tx(&vector["grandparentRaw"]);let public=unhex(&vector["publicKeyHex"]);
    grandparent.outputs.push(grandparent.outputs[0].clone());
    parent.inputs[0].previous_output=OutPoint {txid:grandparent.txid(),vout:(grandparent.outputs.len()-1) as u32};
    current.inputs[0].previous_output.txid=parent.txid();
    assert!(prepare_unlock(UnlockOptions {current_tx:&current,parent_tx:&parent,
        grandparent_tx:&grandparent,public_key:&public}).is_err());
}
