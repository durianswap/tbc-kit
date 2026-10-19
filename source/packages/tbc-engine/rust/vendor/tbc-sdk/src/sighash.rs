use crate::{
    Error, PublicKey, Result, SIGHASH_FORKID,
    encoding::write_compact_size,
    hash,
    script::Script,
    transaction::{Transaction, TxOut},
};
#[cfg(target_arch = "wasm32")]
use k256::ecdsa::Signature;
#[cfg(not(target_arch = "wasm32"))]
use secp256k1::ecdsa::Signature;

pub const SIGHASH_NONE: u32 = 0x02;
pub const SIGHASH_SINGLE: u32 = 0x03;
pub const SIGHASH_ANYONECANPAY: u32 = 0x80;

pub fn forkid_sighash(
    tx: &Transaction,
    input_index: usize,
    script_code: &Script,
    input_satoshis: u64,
    sighash_type: u32,
) -> Result<[u8; 32]> {
    if input_index >= tx.inputs.len() {
        return Err(Error::InvalidUtxo("input index out of range".to_string()));
    }
    if sighash_type & SIGHASH_FORKID == 0 {
        return Err(Error::InvalidUtxo(
            "only forkid sighash is supported".to_string(),
        ));
    }

    let base_type = sighash_type & 0x1f;
    let anyone_can_pay = sighash_type & SIGHASH_ANYONECANPAY != 0;

    let hash_prevouts = if anyone_can_pay {
        [0u8; 32]
    } else {
        let mut data = Vec::new();
        for input in &tx.inputs {
            input.previous_output.serialize(&mut data);
        }
        hash::sha256d(&data)
    };

    let hash_sequence =
        if anyone_can_pay || base_type == SIGHASH_SINGLE || base_type == SIGHASH_NONE {
            [0u8; 32]
        } else {
            let mut data = Vec::new();
            for input in &tx.inputs {
                data.extend_from_slice(&input.sequence.to_le_bytes());
            }
            hash::sha256d(&data)
        };

    let hash_outputs = match base_type {
        SIGHASH_NONE => [0u8; 32],
        SIGHASH_SINGLE if input_index < tx.outputs.len() => {
            hash_outputs_for(&[&tx.outputs[input_index]])
        }
        SIGHASH_SINGLE => [0u8; 32],
        _ => hash_outputs_for(&tx.outputs.iter().collect::<Vec<_>>()),
    };

    let input = &tx.inputs[input_index];
    let mut preimage = Vec::new();
    preimage.extend_from_slice(&tx.version.to_le_bytes());
    preimage.extend_from_slice(&hash_prevouts);
    preimage.extend_from_slice(&hash_sequence);
    input.previous_output.serialize(&mut preimage);
    write_compact_size(script_code.as_bytes().len() as u64, &mut preimage);
    preimage.extend_from_slice(script_code.as_bytes());
    preimage.extend_from_slice(&input_satoshis.to_le_bytes());
    preimage.extend_from_slice(&input.sequence.to_le_bytes());
    preimage.extend_from_slice(&hash_outputs);
    preimage.extend_from_slice(&tx.lock_time.to_le_bytes());
    preimage.extend_from_slice(&sighash_type.to_le_bytes());

    Ok(hash::sha256d(&preimage))
}

pub fn verify_low_s_ecdsa(
    public_key: &PublicKey,
    digest: &[u8; 32],
    der_signature: &[u8],
) -> Result<bool> {
    let signature = Signature::from_der(der_signature).map_err(|_| Error::SignatureFailure)?;
    let mut normalized = signature;
    normalized.normalize_s();
    if normalized != signature {
        return Ok(false);
    }
    public_key.verify_ecdsa_digest(digest, der_signature)
}

fn hash_outputs_for(outputs: &[&TxOut]) -> [u8; 32] {
    let mut data = Vec::new();
    for output in outputs {
        output.serialize(&mut data);
    }
    hash::sha256d(&data)
}

#[cfg(test)]
mod sighash_tests {
    #[test]
    fn sighash_forkid_digest_and_p2pkh_signing_populates_script_sig() {
        let key = crate::PrivateKey::from_slice(&[2u8; 32]).unwrap();
        let script = key.address().script_pubkey();
        let mut tx = crate::Transaction::new();
        tx.inputs.push(crate::TxIn::new(crate::OutPoint {
            txid: "0001020304050607080900010203040506070809000102030405060708090001"
                .parse()
                .unwrap(),
            vout: 1,
        }));
        tx.outputs.push(crate::TxOut {
            satoshis: 1_000,
            script_pubkey: key.address().script_pubkey(),
        });

        let digest =
            crate::sighash::forkid_sighash(&tx, 0, &script, 2_000, crate::DEFAULT_SIGHASH).unwrap();
        assert_eq!(digest.len(), 32);

        tx.sign_p2pkh_input(0, &key, &script, 2_000, crate::DEFAULT_SIGHASH)
            .unwrap();
        assert!(!tx.inputs[0].script_sig.as_bytes().is_empty());
    }
}
