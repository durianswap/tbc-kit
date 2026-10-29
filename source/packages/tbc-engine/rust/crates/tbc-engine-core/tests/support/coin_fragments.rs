//! Offline scalar-1 fixture ledger; never contains funded wallet material.
use secp256k1::{Message, Secp256k1, SecretKey};
use std::collections::{BTreeMap, BTreeSet};
use tbc_engine_core::{
    protocols::{
        coin_proof::inspect_parent,
        coin_transfer::{build_transfer_plan, CoinInput, FeeInput, Receiver, TransferOptions},
    },
    signing::{
        begin_signing, finalize_signing_stage, ExternalSignature, SignedBundle, StageOutcome,
        UnsignedPlan,
    },
};
use tbc_sdk::{OutPoint, PublicKey, Transaction};

pub fn bytes(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
pub fn hex(b: &[u8]) -> String {
    b.iter().map(|v| format!("{v:02x}")).collect()
}
pub fn controller(key: &PublicKey) -> [u8; 21] {
    let mut c = [0; 21];
    c[..20].copy_from_slice(&key.hash160());
    c
}
pub fn signed(plan: &UnsignedPlan) -> SignedBundle {
    let mut state = begin_signing(plan).unwrap();
    let mut scalar = [0; 32];
    scalar[31] = 1;
    let key = SecretKey::from_byte_array(scalar).unwrap();
    loop {
        let signatures = state
            .signing_requests
            .iter()
            .map(|r| ExternalSignature {
                session_id: r.session_id.clone(),
                stage: r.stage,
                stage_commitment: r.stage_commitment.clone(),
                transaction_id: r.transaction_id.clone(),
                input_index: r.input_index,
                digest: r.digest.clone(),
                public_key: r.public_key.clone(),
                signature: hex(&Secp256k1::new()
                    .sign_ecdsa(
                        Message::from_digest(bytes(&r.digest).try_into().unwrap()),
                        &key,
                    )
                    .serialize_der()),
            })
            .collect::<Vec<_>>();
        match finalize_signing_stage(plan, state, &signatures).unwrap() {
            StageOutcome::Complete(bundle) => return bundle,
            StageOutcome::Pending(next) => state = next,
        }
    }
}
pub struct Material {
    pub known: BTreeMap<String, Transaction>,
    pub points: Vec<OutPoint>,
    pub fee: OutPoint,
    pub contract: String,
}
pub fn fragmented(count: usize) -> Material {
    assert!((1..=128).contains(&count));
    let f: serde_json::Value =
        serde_json::from_str(include_str!("../../../../fixtures/coin-proof.json")).unwrap();
    let issuer =
        Transaction::from_hex(f["vectors"][0]["ancestorsRaw"][0].as_str().unwrap()).unwrap();
    let mint = Transaction::from_hex(f["vectors"][0]["parentRaw"].as_str().unwrap()).unwrap();
    let key =
        PublicKey::from_slice(&bytes(f["vectors"][0]["publicKeyHex"].as_str().unwrap())).unwrap();
    let mut points = vec![OutPoint {
        txid: mint.txid(),
        vout: 3,
    }];
    let mut fee = OutPoint {
        txid: mint.txid(),
        vout: 5,
    };
    let contract = issuer.txid().to_string();
    let mut known = BTreeMap::from([
        (issuer.txid().to_string(), issuer),
        (mint.txid().to_string(), mint),
    ]);
    // Split the remaining large output. Every fragment belongs to one signed
    // dependency tree, rather than inventing double spends of the same mint.
    while points.len() < count {
        let groups = (count - points.len() + 1).min(7);
        let point = points.pop().unwrap();
        let parent =
            inspect_parent(&known[&point.txid.to_string()].serialize(), &point, None).unwrap();
        let ids: BTreeSet<_> = parent
            .dependencies()
            .iter()
            .map(|p| p.txid.to_string())
            .collect();
        let raws: Vec<_> = ids.iter().map(|id| known[id].serialize()).collect();
        let refs: Vec<_> = raws.iter().map(Vec::as_slice).collect();
        let inputs = [CoinInput {
            parent: &parent,
            ancestor_raws: &refs,
            public_key: &key,
        }];
        let funding = &known[&fee.txid.to_string()].outputs[fee.vout as usize];
        let fee_input = FeeInput {
            outpoint: fee.clone(),
            output: funding,
            public_key: &key,
        };
        let mut receivers = vec![
            Receiver {
                controller: controller(&key),
                amount: 1
            };
            groups - 1
        ];
        receivers.push(Receiver {
            controller: controller(&key),
            amount: parent.tape().balance - (groups - 1) as u128,
        });
        let built = build_transfer_plan(TransferOptions {
            inputs: &inputs,
            fee_input: &fee_input,
            receivers: &receivers,
            expected_identity: parent.identity(),
            token_change_controller: controller(&key),
            additional_payment: None,
            additional_info: None,
            max_fee: 10000,
        })
        .unwrap();
        let bundle = signed(&built.unsigned_plan);
        let tx = Transaction::from_hex(&bundle.transactions[0].raw_transaction).unwrap();
        points.extend((0..groups).map(|i| OutPoint {
            txid: tx.txid(),
            vout: (2 * i) as u32,
        }));
        fee = OutPoint {
            txid: tx.txid(),
            vout: (tx.outputs.len() - 1) as u32,
        };
        known.insert(tx.txid().to_string(), tx);
    }
    Material {
        known,
        points,
        fee,
        contract,
    }
}
