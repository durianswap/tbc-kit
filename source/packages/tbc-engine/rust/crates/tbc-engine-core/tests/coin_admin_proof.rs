//! Fixed SDK vectors, public scalar 2 only. Engine sees public key + signature.
use serde_json::Value;
use tbc_engine_core::protocols::{coin_proof,tbc721_proof};
use tbc_sdk::{OutPoint,Transaction};
fn fixture()->Value {serde_json::from_str(include_str!("../../../fixtures/coin-admin-proof.json")).unwrap()}
fn bytes(v:&Value)->Vec<u8> {let s=v.as_str().unwrap();(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
fn tx(v:&Value)->Transaction {Transaction::from_bytes(&bytes(v)).unwrap()}
fn independent_signature(digest:&[u8;32])->Vec<u8> {
    let secp=secp256k1::Secp256k1::new();let mut scalar=[0;32];scalar[31]=2;
    let pair=secp256k1::Keypair::from_secret_key(&secp,&secp256k1::SecretKey::from_byte_array(scalar).unwrap());
    let mut sig=secp.sign_schnorr_no_aux_rand(digest,&pair).as_ref().to_vec();sig.push(0x41);sig
}

#[test]
fn issuance_bip340_matches_pinned_tbc721_proof_without_private_keys() {
    let f=fixture();let v=&f["issuance"];let current=tx(&v["signedRaw"]);let parent=tx(&v["parentRaw"]);let grand=tx(&v["grandparentRaw"]);let key=bytes(&v["publicKeyHex"]);
    let prepared=tbc721_proof::prepare_unlock(tbc721_proof::UnlockOptions{current_tx:&current,parent_tx:&parent,grandparent_tx:&grand,public_key:&key}).unwrap();
    assert_eq!(prepared.signing_digest().as_slice(),bytes(&v["digestHex"]));
    let mut expected:Vec<_>=v["fields"].as_array().unwrap().iter().map(bytes).collect();expected[0].clear();assert_eq!(prepared.proof_fields(),expected);
    assert_eq!(prepared.finalize(&bytes(&v["signatureHex"])).unwrap().as_bytes(),bytes(&v["unlockHex"]));
    let signed=prepared.finalize(&independent_signature(prepared.signing_digest())).unwrap();
    assert_eq!(signed.as_bytes(),bytes(&v["unlockHex"]));assert_eq!(signed.as_bytes().len(),prepared.max_unlocking_script_bytes());
    for mut bad in [bytes(&v["signatureHex"]),independent_signature(&[9;32])] {
        bad[0]^=1;assert!(prepared.finalize(&bad).is_err());
    }
    let mut wrong_key=vec![2];wrong_key.extend_from_slice(&key);
    assert!(tbc721_proof::prepare_unlock(tbc721_proof::UnlockOptions{current_tx:&current,parent_tx:&parent,grandparent_tx:&grand,public_key:&wrong_key}).is_err());
}

#[test]
fn administrator_freeze_unfreeze_use_shared_coin_proof_and_exact_bip340() {
    for v in fixture()["cases"].as_array().unwrap() {
        let current=tx(&v["signedRaw"]);let parent_tx=tx(&v["parentRaw"]);let vin=v["inputIndex"].as_u64().unwrap() as usize;
        let point=OutPoint{txid:parent_tx.txid(),vout:v["parentCodeVout"].as_u64().unwrap() as u32};
        let parent=coin_proof::inspect_parent(&parent_tx.serialize(),&point,None).unwrap();
        let ancestors:Vec<_>=v["ancestorsRaw"].as_array().unwrap().iter().map(bytes).collect();let refs:Vec<_>=ancestors.iter().map(Vec::as_slice).collect();
        let groups:Vec<_>=v["outputGroups"].as_array().unwrap().iter().map(|g|coin_proof::OutputGroup{code_vout:g["codeVout"].as_u64().unwrap() as usize,tape_vout:g["tapeVout"].as_u64().map(|n|n as usize)}).collect();
        let key=bytes(&v["publicKeyHex"]);
        let prepared=coin_proof::prepare_unlock(coin_proof::UnlockOptions{current_tx:&current,input_index:vin,parent:&parent,ancestor_raws:&refs,output_groups:&groups,public_key:&key,contract_controller:None}).unwrap();
        assert_eq!(prepared.signing_digest().as_slice(),bytes(&v["digestHex"]));
        let mut expected:Vec<_>=v["fields"].as_array().unwrap().iter().map(bytes).collect();expected[98].clear();assert_eq!(prepared.proof_fields(),expected);
        let actual=prepared.finalize(&bytes(&v["signatureHex"])).unwrap();assert_eq!(actual.as_bytes(),bytes(&v["unlockHex"]));
        assert_eq!(actual.as_bytes().len(),prepared.max_unlocking_script_bytes());
        assert_eq!(prepared.finalize(&independent_signature(prepared.signing_digest())).unwrap(),actual);
        let mut bad=bytes(&v["signatureHex"]);bad[64]=1;assert!(prepared.finalize(&bad).is_err());
        assert!(prepared.finalize(&bad[..64]).is_err());assert!(prepared.finalize(&[0;65]).is_err());
        assert!(prepared.finalize(&independent_signature(&[9;32])).is_err());
        let mut compressed=vec![2];compressed.extend_from_slice(&key);
        assert!(coin_proof::prepare_unlock(coin_proof::UnlockOptions{current_tx:&current,input_index:vin,parent:&parent,ancestor_raws:&refs,output_groups:&groups,public_key:&compressed,contract_controller:None}).is_err());
    }
}
