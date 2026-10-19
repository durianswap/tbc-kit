#[cfg(target_arch = "wasm32")]
use k256::{
    PublicKey as K256PublicKey,
    ecdsa::{Signature as K256EcdsaSignature, VerifyingKey},
    elliptic_curve::sec1::ToEncodedPoint,
};
#[cfg(all(target_arch = "wasm32", feature = "internal-signing"))]
use k256::{
    SecretKey as K256SecretKey,
    ecdsa::SigningKey as K256EcdsaSigningKey,
    elliptic_curve::rand_core::OsRng,
    schnorr::{Signature as K256SchnorrSignature, SigningKey as K256SchnorrSigningKey},
};
#[cfg(target_arch = "wasm32")]
use k256::ecdsa::signature::hazmat::PrehashVerifier;
#[cfg(all(target_arch = "wasm32", feature = "internal-signing"))]
use k256::ecdsa::signature::hazmat::PrehashSigner;
#[cfg(not(target_arch = "wasm32"))]
use secp256k1::{Message, PublicKey as SecpPublicKey, Secp256k1};
#[cfg(all(feature = "internal-signing", not(target_arch = "wasm32")))]
use secp256k1::{Keypair, SecretKey};

use crate::{Address, Result, hash};
#[cfg(feature = "internal-signing")]
use crate::{Error, WIF_PREFIX};

#[cfg(feature = "internal-signing")]
#[derive(Clone, Debug)]
pub struct PrivateKey {
    #[cfg(not(target_arch = "wasm32"))]
    secret_key: SecretKey,
    #[cfg(target_arch = "wasm32")]
    secret_key: K256SecretKey,
    compressed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicKey {
    #[cfg(not(target_arch = "wasm32"))]
    public_key: SecpPublicKey,
    #[cfg(target_arch = "wasm32")]
    public_key: K256PublicKey,
}

#[cfg(feature = "internal-signing")]
impl PrivateKey {
    pub fn generate() -> Self {
        #[cfg(not(target_arch = "wasm32"))]
        let mut rng = secp256k1::rand::rng();
        #[cfg(not(target_arch = "wasm32"))]
        let secret_key = SecretKey::new(&mut rng);
        #[cfg(target_arch = "wasm32")]
        let secret_key = K256SecretKey::random(&mut OsRng);
        Self {
            secret_key,
            compressed: true,
        }
    }

    pub fn from_slice(bytes: &[u8]) -> Result<Self> {
        let bytes: [u8; 32] = bytes.try_into().map_err(|_| Error::InvalidWif)?;
        #[cfg(not(target_arch = "wasm32"))]
        let secret_key = SecretKey::from_byte_array(bytes)?;
        #[cfg(target_arch = "wasm32")]
        let secret_key = K256SecretKey::from_slice(&bytes).map_err(|_| Error::InvalidWif)?;
        Ok(Self { secret_key, compressed: true })
    }

    pub fn from_wif(wif: &str) -> Result<Self> {
        let decoded = bs58::decode(wif)
            .into_vec()
            .map_err(|_| Error::InvalidWif)?;
        if decoded.len() != 37 && decoded.len() != 38 {
            return Err(Error::InvalidWif);
        }
        let (payload, checksum) = decoded.split_at(decoded.len() - 4);
        let expected = hash::sha256d(payload);
        if checksum != &expected[..4] {
            return Err(Error::InvalidWif);
        }
        if payload[0] != WIF_PREFIX {
            return Err(Error::InvalidWif);
        }

        let compressed = match payload.len() {
            33 => false,
            34 if payload[33] == 0x01 => true,
            _ => return Err(Error::InvalidWif),
        };
        let mut raw = [0u8; 32];
        raw.copy_from_slice(&payload[1..33]);

        #[cfg(not(target_arch = "wasm32"))]
        let secret_key = SecretKey::from_byte_array(raw)?;
        #[cfg(target_arch = "wasm32")]
        let secret_key = K256SecretKey::from_slice(&raw).map_err(|_| Error::InvalidWif)?;
        Ok(Self { secret_key, compressed })
    }

    pub fn to_wif(&self) -> String {
        let mut payload = Vec::with_capacity(38);
        payload.push(WIF_PREFIX);
        payload.extend_from_slice(&self.to_bytes());
        if self.compressed {
            payload.push(0x01);
        }
        let checksum = hash::sha256d(&payload);
        payload.extend_from_slice(&checksum[..4]);
        bs58::encode(payload).into_string()
    }

    pub fn to_bytes(&self) -> [u8; 32] {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.secret_key.secret_bytes()
        }
        #[cfg(target_arch = "wasm32")]
        {
            self.secret_key.to_bytes().into()
        }
    }

    pub fn compressed(&self) -> bool {
        self.compressed
    }

    pub fn public_key(&self) -> PublicKey {
        #[cfg(not(target_arch = "wasm32"))]
        {
        let secp = Secp256k1::new();
        PublicKey {
            public_key: SecpPublicKey::from_secret_key(&secp, &self.secret_key),
        }
        }
        #[cfg(target_arch = "wasm32")]
        {
            PublicKey { public_key: self.secret_key.public_key() }
        }
    }

    pub fn address(&self) -> Address {
        self.public_key().address()
    }

    pub fn x_only_public_key(&self) -> [u8; 32] {
        #[cfg(not(target_arch = "wasm32"))]
        {
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &self.secret_key);
        keypair.x_only_public_key().0.serialize()
        }
        #[cfg(target_arch = "wasm32")]
        {
            let encoded = self.secret_key.public_key().to_encoded_point(true);
            encoded.as_bytes()[1..].try_into().expect("compressed public key has x coordinate")
        }
    }

    pub fn sign_schnorr_digest(&self, digest: &[u8; 32]) -> [u8; 64] {
        #[cfg(not(target_arch = "wasm32"))]
        {
        let secp = Secp256k1::new();
        let keypair = Keypair::from_secret_key(&secp, &self.secret_key);
        secp.sign_schnorr_no_aux_rand(digest, &keypair)
            .to_byte_array()
        }
        #[cfg(target_arch = "wasm32")]
        {
            let signing = K256SchnorrSigningKey::from(self.secret_key.clone());
            let signature: K256SchnorrSignature = signing
                .sign_prehash(digest)
                .expect("32-byte Schnorr prehash is valid");
            signature.to_bytes()
        }
    }

    pub fn sign_ecdsa_digest(&self, digest: &[u8; 32]) -> Vec<u8> {
        #[cfg(not(target_arch = "wasm32"))]
        {
        let secp = Secp256k1::new();
        let mut signature = secp.sign_ecdsa(Message::from_digest(*digest), &self.secret_key);
        signature.normalize_s();
        signature.serialize_der().to_vec()
        }
        #[cfg(target_arch = "wasm32")]
        {
            let signing = K256EcdsaSigningKey::from(self.secret_key.clone());
            let signature: K256EcdsaSignature = signing
                .sign_prehash(digest)
                .expect("32-byte ECDSA prehash is valid");
            signature.normalize_s().unwrap_or(signature).to_der().as_bytes().to_vec()
        }
    }
}

impl PublicKey {
    pub fn from_slice(bytes: &[u8]) -> Result<Self> {
        #[cfg(not(target_arch = "wasm32"))]
        {
        Ok(Self {
            public_key: SecpPublicKey::from_slice(bytes)?,
        })
        }
        #[cfg(target_arch = "wasm32")]
        {
            Ok(Self {
                public_key: K256PublicKey::from_sec1_bytes(bytes)
                    .map_err(|_| crate::Error::SignatureFailure)?,
            })
        }
    }

    #[cfg(feature = "internal-signing")]
    pub fn from_secret_key(private_key: &PrivateKey) -> Self {
        private_key.public_key()
    }

    pub fn to_bytes(&self) -> [u8; 33] {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.public_key.serialize()
        }
        #[cfg(target_arch = "wasm32")]
        {
            self.public_key
                .to_encoded_point(true)
                .as_bytes()
                .try_into()
                .expect("compressed public key is 33 bytes")
        }
    }

    pub fn hash160(&self) -> [u8; 20] {
        hash::hash160(&self.to_bytes())
    }

    pub fn address(&self) -> Address {
        Address::from_hash160(self.hash160())
    }

    pub fn verify_ecdsa_digest(&self, digest: &[u8; 32], der: &[u8]) -> Result<bool> {
        #[cfg(not(target_arch = "wasm32"))]
        {
        let signature = secp256k1::ecdsa::Signature::from_der(der)?;
        Ok(Secp256k1::verification_only()
            .verify_ecdsa(Message::from_digest(*digest), &signature, &self.public_key)
            .is_ok())
        }
        #[cfg(target_arch = "wasm32")]
        {
            let signature = K256EcdsaSignature::from_der(der)
                .map_err(|_| crate::Error::SignatureFailure)?;
            let verifying = VerifyingKey::from(&self.public_key);
            Ok(verifying.verify_prehash(digest, &signature).is_ok())
        }
    }
}

#[cfg(all(test, feature = "internal-signing"))]
mod primitive_tests {
    #[test]
    fn public_key_verifies_forkid_der_signature() {
        let key = crate::PrivateKey::from_slice(&[9u8; 32]).unwrap();
        let digest = [7u8; 32];
        let signature = key.sign_ecdsa_digest(&digest);
        assert!(
            key.public_key()
                .verify_ecdsa_digest(&digest, &signature)
                .unwrap()
        );
    }

    #[test]
    fn primitive_private_key_generate_returns_valid_distinct_compressed_keys() {
        let first = crate::PrivateKey::generate();
        let second = crate::PrivateKey::generate();

        assert_ne!(first.to_bytes(), second.to_bytes());
        assert!(first.compressed());
        assert_eq!(
            crate::PrivateKey::from_wif(&first.to_wif())
                .unwrap()
                .to_bytes(),
            first.to_bytes()
        );
    }

    #[test]
    fn primitive_private_key_round_trips_wif_and_derives_legacy_address() {
        let key = crate::PrivateKey::from_slice(&[1u8; 32]).unwrap();
        let wif = key.to_wif();
        let parsed = crate::PrivateKey::from_wif(&wif).unwrap();
        assert_eq!(parsed.to_bytes(), [1u8; 32]);
        assert!(parsed.compressed());

        let address = key.address();
        assert!(address.to_string().starts_with('1'));
        let parsed_address = crate::Address::from_string(&address.to_string()).unwrap();
        assert_eq!(parsed_address.hash160(), address.hash160());
        assert_eq!(
            hex::encode(address.script_pubkey().as_bytes())[0..6].to_string(),
            "76a914"
        );
    }

    #[test]
    fn primitive_private_key_signs_schnorr_digest_for_xonly_public_key() {
        let key = crate::PrivateKey::from_slice(&[2u8; 32]).unwrap();
        let digest = [7u8; 32];

        let xonly = key.x_only_public_key();
        let sig = key.sign_schnorr_digest(&digest);

        let secp = secp256k1::Secp256k1::verification_only();
        let pk = secp256k1::XOnlyPublicKey::from_byte_array(xonly).unwrap();
        let sig = secp256k1::schnorr::Signature::from_byte_array(sig);
        secp.verify_schnorr(&sig, &digest, &pk).unwrap();
    }
}
