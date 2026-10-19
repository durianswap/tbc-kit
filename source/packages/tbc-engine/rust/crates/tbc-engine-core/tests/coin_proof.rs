//! Pinned SDK's real issuance→split→merge→respend, fictitious funds only.
use tbc_engine_core::{EngineError, protocols::{coin, coin_proof::{self, ParentMaterial, UnlockOptions, OutputGroup, PreparedUnlock}}};
use tbc_sdk::{OutPoint, Transaction, script::Script};

fn fixture() -> serde_json::Value { serde_json::from_str(include_str!("../../../fixtures/coin-proof.json")).unwrap() }
fn hex(text: &str) -> Vec<u8> { (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i+2], 16).unwrap()).collect() }
fn bytes(value: &serde_json::Value) -> Vec<u8> { hex(value.as_str().unwrap()) }
fn tx(value: &serde_json::Value) -> Transaction { Transaction::from_bytes(&bytes(value)).unwrap() }
struct Case { current: Transaction, parent: ParentMaterial, ancestors: Vec<Vec<u8>>, groups: Vec<OutputGroup>, key: Vec<u8>, vin: usize }
impl Case {
    fn load(vector: &serde_json::Value) -> Self {
        let parent_tx = tx(&vector["parentRaw"]);
        let selected = OutPoint { txid: parent_tx.txid(), vout: vector["parentCodeVout"].as_u64().unwrap() as u32 };
        Self { current: tx(&vector["currentRaw"]), parent: coin_proof::inspect_parent(&parent_tx.serialize(), &selected, None).unwrap(),
            ancestors: vector["ancestorsRaw"].as_array().unwrap().iter().map(bytes).collect(),
            groups: vector["outputGroups"].as_array().unwrap().iter().map(|g| OutputGroup {
                code_vout: g["codeVout"].as_u64().unwrap() as usize, tape_vout: g["tapeVout"].as_u64().map(|n| n as usize) }).collect(),
            key: bytes(&vector["publicKeyHex"]), vin: vector["inputIndex"].as_u64().unwrap() as usize }
    }
    fn prepare(&self) -> Result<PreparedUnlock, EngineError> {
        coin_proof::prepare_unlock(UnlockOptions { current_tx: &self.current, input_index: self.vin, parent: &self.parent,
            ancestor_raws: &self.ancestors.iter().map(Vec::as_slice).collect::<Vec<_>>(), output_groups: &self.groups,
            public_key: &self.key, contract_controller: None })
    }
    fn replace_parent(&mut self, parent: Transaction) {
        let point = OutPoint { txid: parent.txid(), vout: self.parent.selected().vout };
        self.current.inputs[self.vin].previous_output = point.clone();
        self.parent = coin_proof::inspect_parent(&parent.serialize(), &point, None).unwrap();
    }
}

#[test]
fn coin_matches_pinned_123_fields_digest_and_external_signature() {
    let fixtures = fixture(); let vectors = fixtures["vectors"].as_array().unwrap(); assert_eq!(vectors.len(), 4);
    for vector in vectors {
        let case = Case::load(vector); let prepared = case.prepare().unwrap();
        assert_eq!(prepared.signing_digest().as_slice(), bytes(&vector["digestHex"]));
        let mut fields: Vec<_> = vector["fields"].as_array().unwrap().iter().map(bytes).collect(); fields[98].clear();
        assert_eq!(prepared.proof_fields(), fields, "{}", vector["id"]);
        let signed = prepared.finalize(&bytes(&vector["signatureHex"])).unwrap();
        assert_eq!(signed.as_bytes(), bytes(&vector["unlockHex"]));
        assert!(signed.as_bytes().len() <= prepared.max_unlocking_script_bytes());
        let mut completed = tx(&vector["signedRaw"]); completed.inputs[case.vin].script_sig = signed;
        assert_eq!(completed.serialize(), bytes(&vector["signedRaw"]));
        assert_eq!(completed.txid().to_string(), vector["txid"].as_str().unwrap());
        let mut wrong = bytes(&vector["signatureHex"]); wrong[10] ^= 1; assert!(prepared.finalize(&wrong).is_err());
        let mut wrong = bytes(&vector["signatureHex"]); *wrong.last_mut().unwrap() = 1; assert!(prepared.finalize(&wrong).is_err());
        let mut changed = Case::load(vector); changed.current.outputs.last_mut().unwrap().satoshis -= 1;
        assert!(changed.prepare().unwrap().finalize(&bytes(&vector["signatureHex"])).is_err());
    }
}

#[test]
fn coin_rejects_wrong_owner_lock_allocation_identity_and_duplicate_inputs() {
    let fixture = fixture(); let vector = &fixture["vectors"][0];
    let mut case = Case::load(vector); case.key[0] ^= 1; assert!(case.prepare().is_err());
    let mut case = Case::load(vector); case.key.remove(0); assert!(case.prepare().is_err());
    let mut case = Case::load(vector); case.current.inputs[case.vin].sequence = u32::MAX; assert!(case.prepare().is_err());
    let mut case = Case::load(vector); case.current.inputs[1].previous_output = case.current.inputs[0].previous_output.clone(); assert!(case.prepare().is_err());
    let mut case = Case::load(vector); case.groups.reverse(); assert!(case.prepare().is_err());
    let mut case = Case::load(vector); case.current.outputs[0].script_pubkey = case.current.outputs[1].script_pubkey.clone(); assert!(case.prepare().is_err());
    let mut case = Case::load(vector);
    let tape = &case.current.outputs[1].script_pubkey;
    let mut amounts = coin::parse_tape(tape.as_bytes(), None).unwrap().amounts; amounts[0] += 1;
    case.current.outputs[1].script_pubkey = Script::from_bytes(coin::replace_tape_amounts(tape.as_bytes(), amounts).unwrap());
    assert!(case.prepare().is_err());
    let mut case = Case::load(vector);
    let mut recipient = coin::parse_code(case.current.outputs[0].script_pubkey.as_bytes()).unwrap(); recipient.admin_pubkey_hash[0] ^= 1;
    case.current.outputs[0].script_pubkey = Script::from_bytes(coin::instantiate_code(&recipient).unwrap()); assert!(case.prepare().is_err());
    let mut case = Case::load(vector); let mut parent = case.parent.transaction().clone(); let vout = case.parent.selected().vout as usize;
    parent.outputs[vout+1].script_pubkey = Script::from_bytes(coin::set_lock_time(parent.outputs[vout+1].script_pubkey.as_bytes(), 12).unwrap());
    case.replace_parent(parent); assert!(case.prepare().is_err()); case.current.lock_time = 12; assert!(case.prepare().is_ok());
    case.current.lock_time = 500_000_000; assert!(case.prepare().is_err());
}

#[test]
fn coin_ancestors_are_exact_deduplicated_and_bound_to_issuer_or_same_identity() {
    let fixture = fixture();
    for vector in fixture["vectors"].as_array().unwrap() {
        let mut missing = Case::load(vector); missing.ancestors.clear(); assert!(missing.prepare().is_err());
        let mut duplicate = Case::load(vector); duplicate.ancestors.push(duplicate.ancestors[0].clone()); assert!(duplicate.prepare().is_err());
        let mut case = Case::load(vector);
        let mut wrong = Transaction::from_bytes(&case.ancestors[0]).unwrap();
        // Break both eligible branches, then rebind txids to avoid a merely
        // missing-txid failure hiding a skipped issuer/identity check.
        let old = wrong.txid();
        for output in &mut wrong.outputs {
            if let Ok(mut code) = coin::parse_code(output.script_pubkey.as_bytes()) {
                code.admin_pubkey_hash[0] ^= 1; output.script_pubkey = Script::from_bytes(coin::instantiate_code(&code).unwrap());
            } else { output.script_pubkey = Script::from_bytes(vec![0x51]); }
        }
        let new = wrong.txid(); case.ancestors[0] = wrong.serialize();
        let mut parent = case.parent.transaction().clone();
        for input in &mut parent.inputs { if input.previous_output.txid == old { input.previous_output.txid = new; } }
        case.replace_parent(parent);
        assert!(case.prepare().unwrap_err().message.contains("neither this identity"));
    }
}

#[test]
fn coin_admin_and_contract_roles_do_not_inherit_address_authority() {
    let fixture = fixture(); let vector = &fixture["vectors"][0];
    let mut case = Case::load(vector); let mut parent = case.parent.transaction().clone();
    let vout = case.parent.selected().vout as usize;
    parent.outputs[vout+1].script_pubkey = Script::from_bytes(coin::set_lock_time(
        parent.outputs[vout+1].script_pubkey.as_bytes(), u32::MAX).unwrap());
    case.replace_parent(parent); assert!(case.prepare().is_err());
    // The SDK fixture's administrator is x-only. This compressed-ECDSA slice
    // must not treat that different public-key hash as equivalent authority.
    case.key = bytes(&serde_json::json!("02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"));
    assert!(case.prepare().is_err());
    let admin_hash = tbc_sdk::hash::hash160(&case.key);
    let mut parent = case.parent.transaction().clone();
    for output in parent.outputs.iter_mut().chain(case.current.outputs.iter_mut()) {
        if let Ok(mut code) = coin::parse_code(output.script_pubkey.as_bytes()) {
            code.admin_pubkey_hash = admin_hash;
            output.script_pubkey = Script::from_bytes(coin::instantiate_code(&code).unwrap());
        }
    }
    case.replace_parent(parent);
    assert!(case.prepare().is_ok()); // Administrator bypasses the holder lock only.
    case.current.inputs[0].sequence = u32::MAX; assert!(case.prepare().is_err());

    let mut case = Case::load(vector); let mut parent = case.parent.transaction().clone();
    let old = parent.txid(); let fee_vout = case.current.inputs[1].previous_output.vout as usize;
    let code_hash = tbc_sdk::hash::sha256(parent.outputs[fee_vout].script_pubkey.as_bytes());
    let mut code = coin::parse_code(parent.outputs[vout].script_pubkey.as_bytes()).unwrap();
    code.controller[..20].copy_from_slice(&tbc_sdk::hash::hash160(&code_hash)); code.controller[20] = 1;
    parent.outputs[vout].script_pubkey = Script::from_bytes(coin::instantiate_code(&code).unwrap());
    let new = parent.txid(); case.replace_parent(parent.clone());
    for input in &mut case.current.inputs { if input.previous_output.txid == old { input.previous_output.txid = new; } }
    assert!(case.prepare().is_err()); // Key ownership alone cannot control a contract.
    let ancestors: Vec<_> = case.ancestors.iter().map(Vec::as_slice).collect();
    let with_witness = |witness: &Transaction, vin| coin_proof::prepare_unlock(UnlockOptions {
        current_tx: &case.current, input_index: case.vin, parent: &case.parent, ancestor_raws: &ancestors,
        output_groups: &case.groups, public_key: &case.key,
        contract_controller: Some(coin_proof::ContractControllerWitness {transaction: witness, current_input_index: vin}),
    });
    assert!(with_witness(&parent, 1).is_ok());
    assert!(with_witness(&parent, 0).is_err());
    let mut wrong = parent.clone(); wrong.lock_time = 1;
    assert!(with_witness(&wrong, 1).is_err());
}
