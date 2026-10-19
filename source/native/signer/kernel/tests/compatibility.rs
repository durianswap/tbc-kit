use tbc_signer_kernel::{sign_digest, SignError};
fn decode(s: &str) -> Vec<u8> {
    s.as_bytes().chunks_exact(2).map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap()).collect()
}
#[test]
fn common_vectors_match_current_mobile_and_legacy_rust() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!("../fixtures/common-vectors.json")).unwrap();
    for vector in fixture["vectors"].as_array().unwrap() {
        let digest = decode(vector["digest"].as_str().unwrap());
        let scalar = decode(vector["scalar"].as_str().unwrap());
        for encoding in [64, 65] {
            let result = sign_digest(&digest, &scalar, encoding).unwrap();
            assert_eq!(result, decode(vector[format!("compact{encoding}")].as_str().unwrap()));
            // Exact primitive/header sequence from the read-only old mobile signer.
            let key = secp256k1::SecretKey::from_byte_array(scalar.as_slice().try_into().unwrap()).unwrap();
            let signature = secp256k1::Secp256k1::new().sign_ecdsa_recoverable(
                secp256k1::Message::from_digest(digest.as_slice().try_into().unwrap()), &key);
            let (recovery, compact) = signature.serialize_compact();
            let mut legacy = Vec::new();
            if encoding == 65 { let recovery: i32 = recovery.into(); legacy.push(31 + recovery as u8); }
            legacy.extend_from_slice(&compact);
            assert_eq!(result, legacy);
        }
    }
}
#[test]
fn rejects_invalid_inputs_without_signing() {
    assert_eq!(sign_digest(&[0;31], &[1;32], 64), Err(SignError::InvalidInput));
    assert_eq!(sign_digest(&[0;32], &[1;31], 64), Err(SignError::InvalidInput));
    assert_eq!(sign_digest(&[0;32], &[1;33], 64), Err(SignError::InvalidInput));
    assert_eq!(sign_digest(&[0;32], &[0;32], 64), Err(SignError::InvalidSecret));
    assert_eq!(sign_digest(&[0;32], &[255;32], 64), Err(SignError::InvalidSecret));
    assert_eq!(sign_digest(&[0;32], &[1;32], 66), Err(SignError::InvalidEncoding));
}
#[test]
fn ffi_failure_clears_output_and_borrows_input() {
    let secret = [0u8;32]; let digest = [1u8;32]; let mut output = [255u8;65];
    let status = unsafe { tbc_signer_kernel::tbc_signer_sign_digest(digest.as_ptr(),32,secret.as_ptr(),32,65,output.as_mut_ptr(),65) };
    assert_eq!(status, 2); assert_eq!(output, [0;65]); assert_eq!(secret,[0;32]);
}
#[test]
fn independent_calls_are_deterministic() {
    let first = sign_digest(&[2;32], &[3;32], 65).unwrap();
    for _ in 0..16 { assert_eq!(sign_digest(&[2;32], &[3;32], 65).unwrap(), first); }
    assert_eq!(tbc_signer_kernel::tbc_signer_kernel_version(),1);
}

#[test]
fn schnorr_bip340_vector_zero_and_algorithm_separation() {
    // Public BIP-0340 vector 0, auxiliary randomness = zero; never a wallet secret.
    let mut scalar = [0u8; 32]; scalar[31] = 3;
    let digest = [0u8; 32];
    let signature = sign_digest(&digest, &scalar, 164).unwrap();
    assert_eq!(signature, decode(concat!(
        "e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca8215",
        "25f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0")));
    assert_ne!(signature, sign_digest(&digest, &scalar, 64).unwrap());
    let public = secp256k1::XOnlyPublicKey::from_byte_array(decode(
        "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9").try_into().unwrap()).unwrap();
    let parsed = secp256k1::schnorr::Signature::from_byte_array(signature.try_into().unwrap());
    let context = secp256k1::Secp256k1::verification_only();
    assert!(context.verify_schnorr(&parsed, &digest, &public).is_ok());
    assert!(context.verify_schnorr(&parsed, &[1;32], &public).is_err());
}

#[test]
fn schnorr_ffi_uses_explicit_tag_not_output_length() {
    let mut scalar = [0u8;32]; scalar[31] = 3;
    let digest = [0u8;32]; let mut output = [255u8;65];
    let call = |key: &[u8], len, out: &mut [u8]| unsafe {
        tbc_signer_kernel::tbc_signer_sign_digest(digest.as_ptr(),32,key.as_ptr(),key.len(),164,out.as_mut_ptr(),len)
    };
    assert_eq!(call(&scalar,65,&mut output),1);
    assert_eq!(call(&scalar,64,&mut output),0);
    assert_eq!(&output[..64],sign_digest(&digest,&scalar,164).unwrap());
    assert_eq!(output[64],255, "must not append transaction sighash byte");
    assert_eq!(call(&[0;32],64,&mut output),2);
    assert_eq!(&output[..64],&[0;64]);
    assert_eq!(sign_digest(&digest,&[255;32],164),Err(SignError::InvalidSecret));
    assert_eq!(sign_digest(&digest,&[3;31],164),Err(SignError::InvalidInput));
    assert_eq!(sign_digest(&[0;31],&scalar,164),Err(SignError::InvalidInput));
}
