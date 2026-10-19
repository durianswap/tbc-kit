//! Wallet-private digest signing, deliberately independent of the transaction Engine.
//! Reuses the old mobile wallet's libsecp256k1 recoverable-signature calculation.
use secp256k1::{Keypair, Message, Secp256k1, SecretKey, SignOnly};
use std::sync::OnceLock;
use zeroize::{Zeroize, Zeroizing};
pub mod crypto;
#[cfg(feature = "musig")]
pub mod musig;

static CONTEXT: OnceLock<Secp256k1<SignOnly>> = OnceLock::new();
const BUFFER_LEN: usize = 32 + 32 + 65;
/// ABI tags are algorithms/encodings, not output lengths.
pub const SCHNORR64: u32 = 164;
fn signature_len(encoding: u32) -> Result<usize, SignError> {
    match encoding { 64 | SCHNORR64 => Ok(64), 65 => Ok(65), _ => Err(SignError::InvalidEncoding) }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(i32)]
pub enum SignError {
    InvalidInput = 1,
    InvalidSecret = 2,
    InvalidEncoding = 3,
}

/// Signs an already-hashed 32-byte digest; never hashes it again.
/// Input scalar ownership remains with wallet custody. No key is retained in CONTEXT.
pub fn sign_digest(digest: &[u8], scalar: &[u8], encoding: u32) -> Result<Vec<u8>, SignError> {
    let output_len = signature_len(encoding)?;
    let digest: [u8; 32] = digest.try_into().map_err(|_| SignError::InvalidInput)?;
    let mut secret = Zeroizing::new([0u8; 32]);
    if scalar.len() != secret.len() {
        return Err(SignError::InvalidInput);
    }
    secret.copy_from_slice(scalar);
    let mut key = SecretKey::from_byte_array(*secret).map_err(|_| SignError::InvalidSecret)?;
    let context = CONTEXT.get_or_init(Secp256k1::signing_only);
    if encoding == SCHNORR64 {
        let mut pair = Keypair::from_secret_key(context, &key);
        key.non_secure_erase();
        // Standard BIP340 deterministic nonce (zero auxiliary input), not ECDSA
        // nonce reuse. No hashing, transaction suffix or custody in this primitive.
        let signature = context.sign_schnorr_no_aux_rand(&digest, &pair);
        pair.non_secure_erase();
        return Ok(signature.as_ref().to_vec());
    }
    let signature = context.sign_ecdsa_recoverable(Message::from_digest(digest), &key);
    key.non_secure_erase();
    let (recovery, compact) = signature.serialize_compact();
    let mut output = Vec::with_capacity(output_len);
    if encoding == 65 {
        let recovery: i32 = recovery.into();
        output.push(31 + recovery as u8);
    }
    output.extend_from_slice(&compact);
    Ok(output)
}

#[unsafe(no_mangle)]
pub extern "C" fn tbc_signer_kernel_version() -> u32 { 1 }

/// # Safety
/// Buffers must be live, valid for the supplied exact lengths and non-overlapping.
/// This is a wallet-private ABI, not an untrusted DApp interface.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tbc_signer_sign_digest(
    digest: *const u8, digest_len: usize,
    scalar: *const u8, scalar_len: usize,
    encoding: u32, output: *mut u8, output_len: usize,
) -> i32 {
    let expected_len = match signature_len(encoding) { Ok(size) => size, Err(error) => return error as i32 };
    if output.is_null() || output_len != expected_len { return SignError::InvalidInput as i32; }
    let output = unsafe { std::slice::from_raw_parts_mut(output, output_len) };
    output.fill(0);
    if digest.is_null() || scalar.is_null() || digest_len != 32 || scalar_len != 32 {
        return SignError::InvalidInput as i32;
    }
    let result = sign_digest(
        unsafe { std::slice::from_raw_parts(digest, digest_len) },
        unsafe { std::slice::from_raw_parts(scalar, scalar_len) }, encoding,
    );
    match result {
        Ok(signature) => { output.copy_from_slice(&signature); 0 }
        Err(error) => error as i32,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn tbc_signer_buffer_new() -> *mut u8 {
    Box::into_raw(Box::new([0u8; BUFFER_LEN])).cast()
}

/// # Safety
/// Pointer must be a live allocation from tbc_signer_buffer_new, freed exactly once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tbc_signer_buffer_free(pointer: *mut u8) {
    if !pointer.is_null() {
        let mut bytes = unsafe { Box::from_raw(pointer.cast::<[u8; BUFFER_LEN]>()) };
        bytes.as_mut().zeroize();
    }
}
