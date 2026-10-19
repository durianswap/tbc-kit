use ripemd::Ripemd160;
use sha2::{Digest, Sha256};

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

pub fn sha256d(data: &[u8]) -> [u8; 32] {
    sha256(&sha256(data))
}

pub fn hash160(data: &[u8]) -> [u8; 20] {
    let sha = sha256(data);
    Ripemd160::digest(sha).into()
}

#[cfg(test)]
mod primitive_tests {
    #[test]
    fn primitive_hash160_returns_twenty_bytes() {
        assert_eq!(crate::hash::hash160(&[1, 2, 3]).len(), 20);
    }
}
