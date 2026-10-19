use std::fmt;

use crate::{ADDRESS_P2PKH_PREFIX, Error, Result, hash, script::Script};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Address {
    hash160: [u8; 20],
}

impl Address {
    pub fn from_hash160(hash160: [u8; 20]) -> Self {
        Self { hash160 }
    }

    pub fn from_string(value: &str) -> Result<Self> {
        let decoded = bs58::decode(value)
            .into_vec()
            .map_err(|_| Error::InvalidAddress)?;
        if decoded.len() != 25 {
            return Err(Error::InvalidAddress);
        }
        let (payload, checksum) = decoded.split_at(21);
        let expected = hash::sha256d(payload);
        if checksum != &expected[..4] {
            return Err(Error::InvalidAddress);
        }
        if payload[0] != ADDRESS_P2PKH_PREFIX {
            return Err(Error::UnsupportedAddressType);
        }
        let mut hash160 = [0u8; 20];
        hash160.copy_from_slice(&payload[1..]);
        Ok(Self { hash160 })
    }

    pub fn hash160(&self) -> [u8; 20] {
        self.hash160
    }

    pub fn script_pubkey(&self) -> Script {
        Script::p2pkh(&self.hash160)
    }

    fn base58check_payload(&self) -> Vec<u8> {
        let mut payload = Vec::with_capacity(25);
        payload.push(ADDRESS_P2PKH_PREFIX);
        payload.extend_from_slice(&self.hash160);
        let checksum = hash::sha256d(&payload);
        payload.extend_from_slice(&checksum[..4]);
        payload
    }
}

impl fmt::Display for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&bs58::encode(self.base58check_payload()).into_string())
    }
}
