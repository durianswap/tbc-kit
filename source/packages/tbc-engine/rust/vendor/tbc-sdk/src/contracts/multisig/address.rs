use crate::{Error, PublicKey, Result, hash};

const MULTISIG_PAYLOAD_LEN: usize = 21;
const MULTISIG_ADDRESS_LEN: usize = MULTISIG_PAYLOAD_LEN + 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MultiSigAddressInfo {
    pub required_signatures: u8,
    pub public_key_count: u8,
}

pub struct MultiSig;

pub(crate) struct DecodedMultiSigAddress {
    pub(crate) info: MultiSigAddressInfo,
    pub(crate) public_key_hash: [u8; 20],
}

impl MultiSig {
    /// Import the exact key order committed by the JavaScript SDK. Never
    /// re-sort an existing address. New wallets may still use `address`.
    pub fn address_ordered(public_keys: &[PublicKey], required_signatures: u8) -> Result<String> {
        canonical_public_keys(public_keys, required_signatures)?; // policy + duplicates
        let keys = public_keys.iter().map(PublicKey::to_bytes).collect::<Vec<_>>();
        let mut payload = vec![(required_signatures << 4) | keys.len() as u8];
        payload.extend_from_slice(&public_key_hash(&keys));
        let checksum = hash::sha256d(&payload);
        payload.extend_from_slice(&checksum[..4]);
        Ok(bs58::encode(payload).into_string())
    }
    /// Builds a multi-signature address from canonical compressed public keys.
    ///
    /// Rust sorts a copy of the supplied keys by compressed bytes before hashing, unlike the
    /// low-level JavaScript helper which preserves caller order. The JavaScript parity fixture
    /// generator explicitly applies this canonical order before calling the 1.6.5 helper.
    pub fn address(public_keys: &[PublicKey], required_signatures: u8) -> Result<String> {
        let canonical_keys = canonical_public_keys(public_keys, required_signatures)?;
        let public_key_hash = public_key_hash(&canonical_keys);
        let mut payload = Vec::with_capacity(MULTISIG_ADDRESS_LEN);
        payload.push((required_signatures << 4) | canonical_keys.len() as u8);
        payload.extend_from_slice(&public_key_hash);
        let checksum = hash::sha256d(&payload);
        payload.extend_from_slice(&checksum[..4]);
        Ok(bs58::encode(payload).into_string())
    }

    pub fn address_info(address: &str) -> Result<MultiSigAddressInfo> {
        Ok(decode_address(address)?.info)
    }

    pub fn validate_address(address: &str) -> bool {
        decode_address(address).is_ok()
    }

    /// Verifies that canonical compressed public keys match a multi-signature address.
    ///
    /// Rust sorts a copy of the supplied keys by compressed bytes before hashing, unlike the
    /// low-level JavaScript helper which preserves caller order.
    pub fn verify_address(public_keys: &[PublicKey], address: &str) -> Result<bool> {
        let decoded = decode_address(address)?;
        let canonical_keys = canonical_public_keys(public_keys, decoded.info.required_signatures)?;
        if canonical_keys.len() != decoded.info.public_key_count as usize {
            return Ok(false);
        }
        Ok(public_key_hash(&canonical_keys) == decoded.public_key_hash)
    }
}

pub(crate) fn decode_address(address: &str) -> Result<DecodedMultiSigAddress> {
    if !(33..=34).contains(&address.len()) {
        return Err(Error::InvalidAddress);
    }
    let decoded = bs58::decode(address)
        .into_vec()
        .map_err(|_| Error::InvalidAddress)?;
    if decoded.len() != MULTISIG_ADDRESS_LEN {
        return Err(Error::InvalidAddress);
    }

    let (payload, checksum) = decoded.split_at(MULTISIG_PAYLOAD_LEN);
    let expected_checksum = hash::sha256d(payload);
    if checksum != &expected_checksum[..4] {
        return Err(Error::InvalidAddress);
    }

    let info = MultiSigAddressInfo {
        required_signatures: payload[0] >> 4,
        public_key_count: payload[0] & 0x0f,
    };
    validate_policy(info)?;

    let mut public_key_hash = [0u8; 20];
    public_key_hash.copy_from_slice(&payload[1..]);
    Ok(DecodedMultiSigAddress {
        info,
        public_key_hash,
    })
}

pub(crate) fn canonical_public_keys(
    public_keys: &[PublicKey],
    required_signatures: u8,
) -> Result<Vec<[u8; 33]>> {
    if !(3..=10).contains(&public_keys.len())
        || !(1..=6).contains(&required_signatures)
        || required_signatures as usize > public_keys.len()
    {
        return Err(Error::InvalidAddress);
    }
    let info = MultiSigAddressInfo {
        required_signatures,
        public_key_count: public_keys.len() as u8,
    };
    validate_policy(info)?;

    let mut keys = public_keys
        .iter()
        .map(PublicKey::to_bytes)
        .collect::<Vec<_>>();
    keys.sort_unstable();
    if keys.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(Error::InvalidAddress);
    }
    Ok(keys)
}

pub(crate) fn public_key_hash(public_keys: &[[u8; 33]]) -> [u8; 20] {
    let mut combined = Vec::with_capacity(public_keys.len() * 33);
    for public_key in public_keys {
        combined.extend_from_slice(public_key);
    }
    hash::hash160(&combined)
}

fn validate_policy(info: MultiSigAddressInfo) -> Result<()> {
    if !(1..=6).contains(&info.required_signatures)
        || !(3..=10).contains(&info.public_key_count)
        || info.required_signatures > info.public_key_count
    {
        return Err(Error::InvalidAddress);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::{MultiSig, MultiSigAddressInfo, PrivateKey, PublicKey};

    const JS_2_OF_3_ADDRESS: &str = "F6TyXNS7WVsihUYW8VZkunTp2gFKq6Npq2";
    const JS_LOCK_HEX: &str =
        "527c01217f01217f5279527952797e7ea91406f8c38e32ec7fd0d0ec480067bfcdb6e0fbfdf18853ae";
    const JS_COMBINE_HASH: &str = "bf1b6de4c2001e4ff6020dec9d456b2e0cf77d0301";

    fn fixture_public_keys() -> Vec<PublicKey> {
        let mut keys = [[1u8; 32], [2u8; 32], [3u8; 32]]
            .into_iter()
            .map(|bytes| PrivateKey::from_slice(&bytes).unwrap().public_key())
            .collect::<Vec<_>>();
        keys.sort_by_key(PublicKey::to_bytes);
        keys
    }

    fn boundary_public_keys(count: u8) -> Vec<PublicKey> {
        let mut keys = (1..=count)
            .map(|value| PrivateKey::from_slice(&[value; 32]).unwrap().public_key())
            .collect::<Vec<_>>();
        keys.sort_by_key(PublicKey::to_bytes);
        keys
    }

    #[test]
    fn address_lock_script_and_combine_hash_match_js_1_6_5() {
        let keys = fixture_public_keys();
        let address = MultiSig::address(&keys, 2).unwrap();
        assert_eq!(address, JS_2_OF_3_ADDRESS);
        assert_eq!(
            MultiSig::address_info(&address).unwrap(),
            MultiSigAddressInfo {
                required_signatures: 2,
                public_key_count: 3,
            }
        );
        assert_eq!(
            hex::encode(MultiSig::lock_script(&address).unwrap().as_bytes()),
            JS_LOCK_HEX
        );
        assert_eq!(
            hex::encode(MultiSig::combine_hash(&address).unwrap()),
            JS_COMBINE_HASH
        );
    }

    #[test]
    fn address_canonicalizes_input_and_rejects_invalid_policy_or_duplicates() {
        let keys = fixture_public_keys();
        let mut unsorted = keys.clone();
        unsorted.reverse();

        assert_eq!(MultiSig::address(&unsorted, 2).unwrap(), JS_2_OF_3_ADDRESS);
        assert!(MultiSig::verify_address(&unsorted, JS_2_OF_3_ADDRESS).unwrap());
        assert!(MultiSig::validate_address(JS_2_OF_3_ADDRESS));
        assert!(MultiSig::address(&keys, 0).is_err());
        assert!(MultiSig::address(&keys, 4).is_err());
        assert!(MultiSig::address(&keys[..2], 2).is_err());
        assert!(
            MultiSig::address(&[keys[0].clone(), keys[0].clone(), keys[1].clone()], 2).is_err()
        );
    }

    #[test]
    fn verify_address_returns_false_for_a_valid_key_set_with_a_different_count() {
        assert!(!MultiSig::verify_address(&boundary_public_keys(4), JS_2_OF_3_ADDRESS).unwrap());
    }

    #[test]
    fn address_accepts_policy_boundaries_and_rejects_values_outside_them() {
        let three_keys = boundary_public_keys(3);
        let ten_keys = boundary_public_keys(10);
        let eleven_keys = boundary_public_keys(11);

        let one_of_three = MultiSig::address(&three_keys, 1).unwrap();
        assert_eq!(
            MultiSig::address_info(&one_of_three).unwrap(),
            MultiSigAddressInfo {
                required_signatures: 1,
                public_key_count: 3,
            }
        );
        let six_of_ten = MultiSig::address(&ten_keys, 6).unwrap();
        assert_eq!(
            MultiSig::address_info(&six_of_ten).unwrap(),
            MultiSigAddressInfo {
                required_signatures: 6,
                public_key_count: 10,
            }
        );
        assert!(MultiSig::address(&ten_keys, 7).is_err());
        assert!(MultiSig::address(&eleven_keys, 6).is_err());
    }

    #[test]
    fn address_rejects_bad_checksum_and_noncanonical_lengths() {
        assert!(!MultiSig::validate_address(
            "F6TyXNS7WVsihUYW8VZkunTp2gFKq6Npq1"
        ));
        assert!(!MultiSig::validate_address("not-a-multisig-address"));
        assert!(MultiSig::address_info("F6TyXNS7WVsihUYW8VZkunTp2gFKq6Npq1").is_err());
    }

    #[test]
    fn address_rejects_base58_strings_with_noncanonical_decoded_lengths() {
        let too_short = bs58::encode([0xff; 24]).into_string();
        let mut too_long_payload = vec![0u8; 5];
        too_long_payload.extend([0xff; 21]);
        let too_long = bs58::encode(too_long_payload).into_string();

        assert_eq!(too_short.len(), 33);
        assert_eq!(bs58::decode(&too_short).into_vec().unwrap().len(), 24);
        assert_eq!(too_long.len(), 34);
        assert_eq!(bs58::decode(&too_long).into_vec().unwrap().len(), 26);
        for address in [&too_short, &too_long] {
            assert!(!MultiSig::validate_address(address));
            assert!(MultiSig::address_info(address).is_err());
        }
    }
}
