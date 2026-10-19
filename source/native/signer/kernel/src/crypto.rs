//! Existing TBC BIE1 self-encryption format, isolated from transaction construction.
//! This preserves compatibility (including deterministic self-encryption); it is
//! not a new encryption protocol. No key or plaintext is retained after a call.
use aes::Aes128;
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use hmac::{Hmac, Mac};
use secp256k1::{PublicKey, Scalar, Secp256k1, SecretKey};
use sha2::{Digest, Sha256, Sha512};
use zeroize::{Zeroize, Zeroizing};

pub const MAX_MESSAGE: usize = 1024 * 1024;

pub fn crypt(input: &[u8], scalar: &[u8], decrypt: bool) -> Result<Vec<u8>, u32> {
    if input.len() > MAX_MESSAGE + 85 || scalar.len() != 32 { return Err(1); }
    let secret_bytes = Zeroizing::new(<[u8; 32]>::try_from(scalar).map_err(|_| 1u32)?);
    let mut key = SecretKey::from_byte_array(*secret_bytes).map_err(|_| 2u32)?;
    let own_public = PublicKey::from_secret_key(&Secp256k1::new(), &key);
    key.non_secure_erase();
    let peer = if decrypt {
        if input.len() < 85 || &input[..4] != b"BIE1" || (input.len() - 69) % 16 != 0 { key.non_secure_erase(); return Err(1); }
        PublicKey::from_slice(&input[4..37]).map_err(|_| 1u32)?
    } else { own_public };
    let mut tweak = Scalar::from_be_bytes(*secret_bytes).map_err(|_| 2u32)?;
    let shared = peer.mul_tweak(&Secp256k1::new(), &tweak);
    tweak.non_secure_erase();
    let shared = shared.map_err(|_| 2u32)?;
    let mut compressed_shared = shared.serialize();
    let material = Zeroizing::new(<[u8; 64]>::from(Sha512::digest(compressed_shared)));
    compressed_shared.zeroize();
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&material[32..]).map_err(|_| 1u32)?;
    if decrypt {
        let end = input.len() - 32;
        mac.update(&input[..end]);
        mac.verify_slice(&input[end..]).map_err(|_| 4u32)?;
        cbc::Decryptor::<Aes128>::new_from_slices(&material[16..32], &material[..16]).map_err(|_| 1u32)?
            .decrypt_padded_vec_mut::<Pkcs7>(&input[37..end]).map_err(|_| 4u32)
    } else {
        if input.len() > MAX_MESSAGE { return Err(1); }
        let ciphertext = cbc::Encryptor::<Aes128>::new_from_slices(&material[16..32], &material[..16]).map_err(|_| 1u32)?
            .encrypt_padded_vec_mut::<Pkcs7>(input);
        let mut result = Vec::with_capacity(69 + ciphertext.len());
        result.extend_from_slice(b"BIE1"); result.extend_from_slice(&own_public.serialize()); result.extend_from_slice(&ciphertext);
        mac.update(&result); result.extend_from_slice(&mac.finalize().into_bytes()); Ok(result)
    }
}

/// Wallet-private borrowed buffers. Caller must supply disjoint live buffers.
/// No plaintext is copied out on authentication failure. Returns byte count or a
/// negative generic error (no parser details or secrets across the ABI).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tbc_signer_bie1(input: *const u8, input_len: usize, scalar: *const u8,
    scalar_len: usize, decrypt: u32, output: *mut u8, output_len: usize) -> i32 {
    if input.is_null() || scalar.is_null() || output.is_null() || scalar_len != 32 || decrypt > 1 ||
        input_len > MAX_MESSAGE + 85 || output_len > MAX_MESSAGE + 85 { return -1; }
    let output = unsafe { std::slice::from_raw_parts_mut(output, output_len) }; output.fill(0);
    match crypt(unsafe { std::slice::from_raw_parts(input, input_len) }, unsafe { std::slice::from_raw_parts(scalar, scalar_len) }, decrypt == 1) {
        Ok(mut result) => {
            if result.len() > output.len() { result.zeroize(); return -1; }
            output[..result.len()].copy_from_slice(&result); let len = result.len(); result.zeroize(); len as i32
        }, Err(code) => -(code as i32)
    }
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn roundtrip_and_authentication() {
        let mut key = [0u8; 32]; key[31] = 1;
        for bytes in [b"".as_slice(), b"native Kit crypto", &[0u8; 32]] {
            let encrypted = crypt(bytes, &key, false).unwrap();
            assert_eq!(crypt(&encrypted, &key, true).unwrap(), bytes);
            for index in [4, 37, encrypted.len()-1] {
                let mut corrupted = encrypted.clone(); corrupted[index] ^= 1;
                assert!(crypt(&corrupted, &key, true).is_err());
            }
            let mut wrong = key; wrong[31] = 2; assert!(crypt(&encrypted, &wrong, true).is_err());
        }
    }
}
