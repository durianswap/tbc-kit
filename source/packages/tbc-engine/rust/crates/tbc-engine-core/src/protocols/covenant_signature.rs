//! Shared public-only covenant signer profile. No key derivation or signing.
//! Compressed SEC keys use low-S ECDSA; x-only keys use BIP340 over the already
//! computed 32-byte fork-id digest (no extra message hash).
use tbc_sdk::{PublicKey, sighash::verify_low_s_ecdsa};
use crate::{EngineError, ErrorCode};

#[derive(Clone, Debug)]
pub struct CovenantPublicKey(Vec<u8>);

fn invalid(message: &str) -> EngineError {
    EngineError { code: ErrorCode::InvalidSignature, message: message.into(), path: None }
}

impl CovenantPublicKey {
    pub fn parse(bytes: &[u8]) -> Result<Self, EngineError> {
        let compressed = match bytes.len() {
            32 => { let mut key=vec![2];key.extend_from_slice(bytes);key },
            33 if matches!(bytes[0],2|3) => bytes.to_vec(),
            _ => return Err(invalid("Covenant key must be compressed SEC or BIP340 x-only")),
        };
        PublicKey::from_slice(&compressed).map_err(|_|invalid("Covenant public key is not on secp256k1"))?;
        Ok(Self(bytes.to_vec()))
    }
    pub fn bytes(&self) -> &[u8] { &self.0 }
    pub fn maximum_transaction_signature_bytes(&self) -> usize { if self.0.len()==32 {65}else{72} }
    pub fn verify_transaction_signature(&self,digest:&[u8;32],signature:&[u8])->Result<(),EngineError> {
        if signature.last()!=Some(&0x41) {return Err(invalid("Covenant signature requires SIGHASH_ALL|FORKID"));}
        if self.0.len()==33 {
            if !super::tbc20_proof::canonical_signature(signature) {return Err(invalid("Covenant ECDSA signature must be canonical low-S DER"));}
            let key=PublicKey::from_slice(&self.0).map_err(|_|invalid("Covenant ECDSA public key invalid"))?;
            if !verify_low_s_ecdsa(&key,digest,&signature[..signature.len()-1]).map_err(|_|invalid("Covenant ECDSA verification failed"))? {
                return Err(invalid("Covenant ECDSA signature does not bind its digest and key"));
            }
        } else {
            if signature.len()!=65 {return Err(invalid("Covenant BIP340 signature must be 64 bytes plus 0x41"));}
            #[cfg(not(target_arch="wasm32"))]
            let valid = {
                let key=secp256k1::XOnlyPublicKey::from_byte_array(self.0.as_slice().try_into().unwrap()).map_err(|_|invalid("BIP340 public key invalid"))?;
                let sig=secp256k1::schnorr::Signature::from_byte_array(signature[..64].try_into().unwrap());
                secp256k1::Secp256k1::verification_only().verify_schnorr(&sig,digest,&key).is_ok()
            };
            #[cfg(target_arch="wasm32")]
            let valid = {
                use k256::schnorr::{Signature,VerifyingKey};
                let key=VerifyingKey::from_bytes(&self.0).map_err(|_|invalid("BIP340 public key invalid"))?;
                let sig=Signature::try_from(&signature[..64]).map_err(|_|invalid("BIP340 signature invalid"))?;
                key.verify_raw(digest,&sig).is_ok()
            };
            if !valid {return Err(invalid("Covenant BIP340 signature does not bind its digest and key"));}
        }
        Ok(())
    }
}
