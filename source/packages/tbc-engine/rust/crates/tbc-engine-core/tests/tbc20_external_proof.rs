//! Positive external ECDSA finalization over fixed synthetic proof material.
//! This is not a full covenant VM test or a valid/authorized live-chain spend.
use tbc_engine_core::protocols::{
    tbc20_material::{inspect_parent, link_ancestors},
    tbc20_proof::{OutputGroup, UnlockOptions, prepare_unlock},
};
use tbc_sdk::{OutPoint, PrivateKey, Transaction};

fn bytes(value: &serde_json::Value) -> Vec<u8> {
    let text = value.as_str().unwrap();
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
}

#[test]
fn tbc20_external_proof_signature_is_verified_against_frozen_digest() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/tbc20-standard-transaction.json")).unwrap();
    let vector = &fixture["vectors"][0];
    let current = Transaction::from_bytes(&bytes(&vector["currentRaw"])).unwrap();
    let raw = bytes(&vector["parentRaw"]);
    let parent_tx = Transaction::from_bytes(&raw).unwrap();
    let parent = inspect_parent(&raw, &OutPoint {
        txid: parent_tx.txid(), vout: vector["parentCodeVout"].as_u64().unwrap() as u32,
    }, None).unwrap();
    let ancestor_raws: Vec<_> = vector["ancestorsRaw"].as_array().unwrap().iter().map(bytes).collect();
    let linked = link_ancestors(&parent, &ancestor_raws.iter().map(Vec::as_slice).collect::<Vec<_>>()).unwrap();
    let groups: Vec<_> = vector["outputGroups"].as_array().unwrap().iter().map(|group| OutputGroup {
        code_vout: group["codeVout"].as_u64().unwrap() as usize,
        tape_vout: group["tapeVout"].as_u64().map(|n| n as usize),
    }).collect();
    let public = bytes(&vector["pubkeyHex"]);
    let prepared = prepare_unlock(UnlockOptions { current_tx: &current, input_index: 0,
        parent: &parent, ancestors: &linked, output_groups: &groups, public_key: &public,
        contract_controller: None }).unwrap();
    // Explicitly public scalar 1, only in this offline integration test.
    let mut scalar = [0; 32]; scalar[31] = 1;
    let key = PrivateKey::from_slice(&scalar).unwrap();
    assert_eq!(key.public_key().to_bytes().as_slice(), public);
    let mut signature = key.sign_ecdsa_digest(prepared.signing_digest());
    signature.push(0x41);
    let script = prepared.finalize(&signature).unwrap();
    assert!(!script.as_bytes().is_empty());
    assert!(script.as_bytes().len() <= prepared.max_unlocking_script_bytes());
    let mut wrong = key.sign_ecdsa_digest(&[0x22; 32]); wrong.push(0x41);
    assert!(prepared.finalize(&wrong).is_err());
    *signature.last_mut().unwrap() = 0x01;
    assert!(prepared.finalize(&signature).is_err());
}
