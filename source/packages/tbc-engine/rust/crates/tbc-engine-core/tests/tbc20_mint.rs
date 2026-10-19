use tbc_engine_core::{ErrorCode, protocols::{tbc20::parse_code, tbc20_mint::{build_mint_plan, fee_for_size}},
    signing::{ExternalSignature, SigningStage, StageOutcome, begin_signing, finalize_signing_stage}};
use tbc_sdk::{OutPoint, PrivateKey, Transaction, TxOut, Txid, script::Script};

fn key() -> PrivateKey {
    // Public synthetic scalar 1. Never used to fund, query, or broadcast.
    let mut scalar = [0; 32];
    scalar[31] = 1;
    PrivateKey::from_slice(&scalar).unwrap()
}

fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }
fn decode(text: &str) -> Vec<u8> {
    text.as_bytes().chunks_exact(2).map(|pair|
        u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap()).collect()
}

fn fixture(satoshis: u64, max_fee: u64) -> Result<tbc_engine_core::protocols::tbc20_mint::MintPlan, tbc_engine_core::EngineError> {
    let public = key().public_key();
    let mut recipient = [0; 21];
    recipient[..20].copy_from_slice(&public.hash160());
    build_mint_plan(OutPoint { txid: Txid::from_le_bytes([0x11; 32]), vout: 0 },
        &TxOut { satoshis, script_pubkey: Script::p2pkh(&public.hash160()) },
        &public, recipient, 123456, &[9], max_fee)
}

fn signatures(stage: &SigningStage) -> Vec<ExternalSignature> {
    stage.signing_requests.iter().map(|request| {
        let digest: [u8; 32] = decode(&request.digest).try_into().unwrap();
        ExternalSignature { session_id: request.session_id.clone(), stage: request.stage,
            stage_commitment: request.stage_commitment.clone(), transaction_id: request.transaction_id.clone(),
            input_index: request.input_index, digest: request.digest.clone(), public_key: request.public_key.clone(),
            signature: hex(&key().sign_ecdsa_digest(&digest)) }
    }).collect()
}

#[test]
fn tbc20_mint_keyless_plan_uses_shared_external_signing_and_real_parent_txid() {
    let built = fixture(100000, 1000).unwrap();
    let stage = begin_signing(&built.unsigned_plan).unwrap();
    assert_eq!(stage.signing_requests.len(), 1);
    assert_eq!(stage.stage, 0);
    let sigs = signatures(&stage);
    let StageOutcome::Pending(stage) = finalize_signing_stage(&built.unsigned_plan, stage, &sigs).unwrap()
        else { panic!("Genesis must wait for Source finalization") };
    assert_eq!(stage.stage, 1);
    let sigs = signatures(&stage);
    let StageOutcome::Complete(bundle) = finalize_signing_stage(&built.unsigned_plan, stage, &sigs).unwrap()
        else { panic!("mint must finish after the two dependencies") };
    let source = Transaction::from_hex(&bundle.transactions[0].raw_transaction).unwrap();
    let genesis = Transaction::from_hex(&bundle.transactions[1].raw_transaction).unwrap();
    assert_eq!(genesis.inputs[0].previous_output.txid, source.txid());
    let code = parse_code(genesis.outputs[0].script_pubkey.as_bytes()).unwrap();
    assert_eq!(&code.original_outpoint[..32], source.txid().as_le_bytes());
    assert_eq!(genesis.outputs[0].satoshis, 500);
    assert_eq!(genesis.outputs[1].satoshis, 0);
    assert_eq!(source.outputs[0].satoshis, 100000 - built.source_fee);
    assert_eq!(genesis.outputs.iter().map(|o| o.satoshis).sum::<u64>(), source.outputs[0].satoshis - built.genesis_fee);
    for (index, tx) in [source, genesis].iter().enumerate() {
        assert!(tx.serialize().len() <= built.maximum_signed_bytes[index]);
        assert!(fee_for_size(tx.serialize().len()).unwrap() <= [built.source_fee, built.genesis_fee][index]);
    }
}

#[test]
fn tbc20_mint_fee_units_dust_boundary_and_cap_match_pinned_policy() {
    assert_eq!(fee_for_size(1).unwrap(), 80);
    assert_eq!(fee_for_size(1000).unwrap(), 80);
    assert_eq!(fee_for_size(1001).unwrap(), 81);
    let regular = fixture(100000, 1000).unwrap();
    let boundary = 80 + 500 + regular.genesis_fee + 42;
    assert_eq!(fixture(boundary, 1000).unwrap().unsigned_plan.transactions[1].outputs.len(), 3);
    let dust = fixture(boundary - 1, 1000).unwrap();
    assert_eq!(dust.unsigned_plan.transactions[1].outputs.len(), 2);
    assert_eq!(dust.genesis_fee, boundary - 1 - 80 - 500);
    assert_eq!(fixture(1, 1000).unwrap_err().code, ErrorCode::InsufficientFunds);
    assert_eq!(fixture(100000, 1).unwrap_err().code, ErrorCode::FeeCapExceeded);
}

#[test]
fn tbc20_mint_rejects_wrong_funding_owner_and_invalid_tape_or_amount() {
    let public = key().public_key();
    let funding = OutPoint { txid: Txid::from_le_bytes([0x11; 32]), vout: 0 };
    let bad = TxOut { satoshis: 100000, script_pubkey: Script::p2pkh(&[7; 20]) };
    assert!(build_mint_plan(funding.clone(), &bad, &public, [0;21], 1, &[9], 1000).is_err());
    let good = TxOut { satoshis: 100000, script_pubkey: Script::p2pkh(&public.hash160()) };
    assert!(build_mint_plan(funding.clone(), &good, &public, [0;21], 0, &[9], 1000).is_err());
    assert!(build_mint_plan(funding.clone(), &good, &public, [0;21], u64::MAX, &[9], 1000).is_err());
    assert!(build_mint_plan(funding, &good, &public, [0;21], 1, &[8], 1000).is_err());
}

#[test]
fn tbc20_mint_rejects_retargeted_source_descriptor_and_post_approval_mutation() {
    let mut built = fixture(100000, 1000).unwrap();
    let stage = begin_signing(&built.unsigned_plan).unwrap();
    let sigs = signatures(&stage);
    built.unsigned_plan.transactions[1].outputs[1].satoshis = 1;
    assert!(finalize_signing_stage(&built.unsigned_plan, stage, &sigs).is_err());
    let mut built = fixture(100000, 1000).unwrap();
    built.unsigned_plan.transactions[1].outputs[0].locking_script = built.unsigned_plan.transactions[1].outputs[0]
        .locking_script.replace("\"sourceVout\":0", "\"sourceVout\":1");
    assert!(begin_signing(&built.unsigned_plan).is_err());
}

#[test]
fn tbc20_mint_matches_pinned_upstream_raw_fees_and_external_signature_digests() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/tbc20-standard-transaction.json")).unwrap();
    let oracle = &fixture["mint"];
    let built = self::fixture(100000, 1000).unwrap();
    assert_eq!(built.source_fee.to_string(), oracle["source"]["fee"].as_str().unwrap());
    assert_eq!(built.genesis_fee.to_string(), oracle["genesis"]["fee"].as_str().unwrap());
    let mut stage = begin_signing(&built.unsigned_plan).unwrap();
    for (index, label) in ["source", "genesis"].into_iter().enumerate() {
        let request = &stage.signing_requests[0];
        // JS exposes the Sighash object in display order; native forkid digest
        // is the actual 32 bytes consumed by ECDSA. Compare after explicit reversal.
        let mut expected_digest = decode(oracle[label]["digestHex"].as_str().unwrap());
        expected_digest.reverse();
        assert_eq!(request.digest, hex(&expected_digest), "{label} digest");
        let supplied = ExternalSignature {
            session_id: request.session_id.clone(), stage: request.stage,
            stage_commitment: request.stage_commitment.clone(), transaction_id: request.transaction_id.clone(),
            input_index: request.input_index, digest: request.digest.clone(), public_key: request.public_key.clone(),
            // The upstream signature includes the final 0x41; shared signer wire
            // expects DER only and appends the committed sighash itself.
            signature: {
                let mut bytes = decode(oracle[label]["signatureHex"].as_str().unwrap());
                assert_eq!(bytes.pop(), Some(0x41));
                hex(&bytes)
            },
        };
        match finalize_signing_stage(&built.unsigned_plan, stage, &[supplied]).unwrap() {
            StageOutcome::Pending(next) => {
                assert_eq!(index, 0);
                assert_eq!(next.continuation.finalized_transactions[0].as_ref().unwrap().raw_transaction,
                    oracle["source"]["signedRaw"].as_str().unwrap());
                stage = next;
            }
            StageOutcome::Complete(bundle) => {
                assert_eq!(index, 1);
                for (tx, label) in bundle.transactions.iter().zip(["source", "genesis"]) {
                    assert_eq!(tx.txid, oracle[label]["txid"].as_str().unwrap());
                    assert_eq!(tx.raw_transaction, oracle[label]["signedRaw"].as_str().unwrap());
                }
                return;
            }
        }
    }
    panic!("missing complete mint bundle");
}
