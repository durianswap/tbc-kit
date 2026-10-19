use std::{fmt, str::FromStr};

use bip32::{ChildNumber, DerivationPath, ExtendedKey, Prefix, XPrv, XPub};
use bip39::Language;

use crate::{Address, Error, PrivateKey, Result};

pub const TBC_DERIVATION_PATH: &str = "m/44'/236'/0'/1/0";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HdNetwork {
    Mainnet,
    Testnet,
}

impl HdNetwork {
    fn private_prefix(self) -> Prefix {
        match self {
            Self::Mainnet => Prefix::XPRV,
            Self::Testnet => Prefix::TPRV,
        }
    }

    fn public_prefix(self) -> Prefix {
        match self {
            Self::Mainnet => Prefix::XPUB,
            Self::Testnet => Prefix::TPUB,
        }
    }

    fn from_private_prefix(prefix: Prefix) -> Result<Self> {
        match prefix {
            Prefix::XPRV => Ok(Self::Mainnet),
            Prefix::TPRV => Ok(Self::Testnet),
            _ => Err(Error::InvalidExtendedKey),
        }
    }

    fn from_public_prefix(prefix: Prefix) -> Result<Self> {
        match prefix {
            Prefix::XPUB => Ok(Self::Mainnet),
            Prefix::TPUB => Ok(Self::Testnet),
            _ => Err(Error::InvalidExtendedKey),
        }
    }
}

#[derive(Clone)]
pub struct HdPrivateKey {
    inner: XPrv,
    network: HdNetwork,
}

impl HdPrivateKey {
    pub fn from_seed(seed: &[u8], network: HdNetwork) -> Result<Self> {
        let inner = XPrv::new(seed).map_err(|_| Error::InvalidExtendedKey)?;
        Ok(Self { inner, network })
    }

    pub fn from_mnemonic(
        mnemonic: &Mnemonic,
        passphrase: &str,
        network: HdNetwork,
    ) -> Result<Self> {
        Self::from_seed(&mnemonic.to_seed(passphrase), network)
    }

    pub fn from_xprv(encoded: &str) -> Result<Self> {
        let extended = ExtendedKey::from_str(encoded).map_err(|_| Error::InvalidExtendedKey)?;
        let network = HdNetwork::from_private_prefix(extended.prefix)?;
        let inner = XPrv::try_from(extended).map_err(|_| Error::InvalidExtendedKey)?;
        Ok(Self { inner, network })
    }

    pub fn from_xprv_for_network(encoded: &str, expected: HdNetwork) -> Result<Self> {
        let key = Self::from_xprv(encoded)?;
        if key.network != expected {
            return Err(Error::ExtendedKeyNetworkMismatch);
        }
        Ok(key)
    }

    pub fn derive_child(&self, index: u32, hardened: bool) -> Result<Self> {
        let child = ChildNumber::new(index, hardened).map_err(|_| Error::InvalidDerivationPath)?;
        let inner = self
            .inner
            .derive_child(child)
            .map_err(|_| Error::InvalidDerivationPath)?;
        Ok(Self {
            inner,
            network: self.network,
        })
    }

    pub fn derive_path(&self, path: &str) -> Result<Self> {
        let path = DerivationPath::from_str(path).map_err(|_| Error::InvalidDerivationPath)?;
        let inner = path.iter().try_fold(self.inner.clone(), |key, child| {
            key.derive_child(child)
                .map_err(|_| Error::InvalidDerivationPath)
        })?;
        Ok(Self {
            inner,
            network: self.network,
        })
    }

    pub fn private_key(&self) -> PrivateKey {
        PrivateKey::from_slice(&self.inner.to_bytes())
            .expect("BIP32 extended private key contains a valid secp256k1 key")
    }

    pub fn address(&self) -> Address {
        self.private_key().address()
    }

    pub fn to_public(&self) -> HdPublicKey {
        HdPublicKey {
            inner: self.inner.public_key(),
            network: self.network,
        }
    }

    pub fn network(&self) -> HdNetwork {
        self.network
    }

    pub fn to_xprv(&self) -> String {
        self.inner
            .to_string(self.network.private_prefix())
            .to_string()
    }
}

impl fmt::Debug for HdPrivateKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HdPrivateKey")
            .field("network", &self.network)
            .field("key", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HdPublicKey {
    inner: XPub,
    network: HdNetwork,
}

impl HdPublicKey {
    pub fn from_xpub(encoded: &str) -> Result<Self> {
        let extended = ExtendedKey::from_str(encoded).map_err(|_| Error::InvalidExtendedKey)?;
        let network = HdNetwork::from_public_prefix(extended.prefix)?;
        let inner = XPub::try_from(extended).map_err(|_| Error::InvalidExtendedKey)?;
        Ok(Self { inner, network })
    }

    pub fn from_xpub_for_network(encoded: &str, expected: HdNetwork) -> Result<Self> {
        let key = Self::from_xpub(encoded)?;
        if key.network != expected {
            return Err(Error::ExtendedKeyNetworkMismatch);
        }
        Ok(key)
    }

    pub fn derive_child(&self, index: u32) -> Result<Self> {
        let child = ChildNumber::new(index, false).map_err(|_| Error::InvalidDerivationPath)?;
        let inner = self
            .inner
            .derive_child(child)
            .map_err(|_| Error::InvalidDerivationPath)?;
        Ok(Self {
            inner,
            network: self.network,
        })
    }

    pub fn derive_path(&self, path: &str) -> Result<Self> {
        let path = DerivationPath::from_str(path).map_err(|_| Error::InvalidDerivationPath)?;
        let mut key = self.inner.clone();
        for child in path.iter() {
            if child.is_hardened() {
                return Err(Error::HardenedPublicDerivation);
            }
            key = key
                .derive_child(child)
                .map_err(|_| Error::InvalidDerivationPath)?;
        }
        Ok(Self {
            inner: key,
            network: self.network,
        })
    }

    pub fn public_key(&self) -> crate::PublicKey {
        crate::PublicKey::from_slice(&self.inner.to_bytes())
            .expect("BIP32 extended public key contains a valid secp256k1 key")
    }

    pub fn address(&self) -> Address {
        self.public_key().address()
    }

    pub fn network(&self) -> HdNetwork {
        self.network
    }

    pub fn to_xpub(&self) -> String {
        self.inner.to_string(self.network.public_prefix())
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct Mnemonic {
    inner: bip39::Mnemonic,
}

impl Mnemonic {
    pub fn generate(word_count: usize) -> Result<Self> {
        if !matches!(word_count, 12 | 15 | 18 | 21 | 24) {
            return Err(Error::InvalidMnemonicWordCount);
        }
        let inner = bip39::Mnemonic::generate_in(Language::English, word_count)
            .map_err(|_| Error::InvalidMnemonic)?;
        Ok(Self { inner })
    }

    pub fn from_phrase(phrase: &str) -> Result<Self> {
        let inner = bip39::Mnemonic::parse_in(Language::English, phrase)
            .map_err(|_| Error::InvalidMnemonic)?;
        Ok(Self { inner })
    }

    pub fn phrase(&self) -> String {
        self.inner.to_string()
    }

    pub fn to_seed(&self, passphrase: &str) -> [u8; 64] {
        self.inner.to_seed(passphrase)
    }
}

impl fmt::Debug for Mnemonic {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Mnemonic([REDACTED])")
    }
}

#[cfg(test)]
mod tests {
    use super::{HdNetwork, HdPrivateKey, HdPublicKey, Mnemonic, TBC_DERIVATION_PATH};

    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const SEED: &str = "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04";
    const ROOT_XPRV: &str = "xprv9s21ZrQH143K3h3fDYiay8mocZ3afhfULfb5GX8kCBdno77K4HiA15Tg23wpbeF1pLfs1c5SPmYHrEpTuuRhxMwvKDwqdKiGJS9XFKzUsAF";
    const ROOT_XPUB: &str = "xpub661MyMwAqRbcGB88KaFbLGiYAat55APKhtWg4uYMkXAmfuSTbq2QYsn9sKJCj1YqZPafsboef4h4YbXXhNhPwMbkHTpkf3zLhx7HvFw1NDy";
    const CHILD_XPRV: &str = "xprvA3suuVEJygaHv1Zy4xBSntgEvdm9vjqnhZeHNjyyoSBYdkfKUKaJr8XGA7J6hGFbtkzFsSL5k6ZBsUCQ8XBBmn63gxBAu8zZnaM7zPvydVu";
    const CHILD_XPUB: &str = "xpub6GsGJzmCp48b8VeSAyiTA2cyUfbeLCZe4nZtB8PbMmiXWYzU1rtZPvqk1Q3d7KN6A3XHqYsc9fGWqp9ZYEUSi299aF4PHM6fe8EnuPZ5iYG";
    const CHILD_WIF: &str = "L2bV2tPrkoFX5tDXq6xz1ToZe1hxytTMeyNvBJPPdd17vWA1jxu2";
    const CHILD_ADDRESS: &str = "184w6rQRWp7Teqirk6cfofNdzDdcZf7Nne";

    #[test]
    fn mnemonic_supports_all_bip39_word_counts() {
        for count in [12, 15, 18, 21, 24] {
            let mnemonic = Mnemonic::generate(count).unwrap();
            assert_eq!(mnemonic.phrase().split_whitespace().count(), count);
            assert_eq!(Mnemonic::from_phrase(&mnemonic.phrase()).unwrap(), mnemonic);
        }
    }

    #[test]
    fn mnemonic_rejects_unsupported_word_count() {
        assert!(matches!(
            Mnemonic::generate(13),
            Err(crate::Error::InvalidMnemonicWordCount)
        ));
    }

    #[test]
    fn mnemonic_matches_bip39_seed_vector() {
        let mnemonic = Mnemonic::from_phrase(PHRASE).unwrap();
        assert_eq!(hex::encode(mnemonic.to_seed("TREZOR")), SEED);
        assert!(!format!("{mnemonic:?}").contains("abandon"));
    }

    #[test]
    fn hd_private_derives_tbc_path_and_round_trips_mainnet() {
        let mnemonic = Mnemonic::from_phrase(PHRASE).unwrap();
        let root = HdPrivateKey::from_mnemonic(&mnemonic, "TREZOR", HdNetwork::Mainnet).unwrap();
        let child = root.derive_path(TBC_DERIVATION_PATH).unwrap();

        assert_eq!(root.to_xprv(), ROOT_XPRV);
        assert_eq!(child.to_xprv(), CHILD_XPRV);
        assert_eq!(child.private_key().to_wif(), CHILD_WIF);
        assert_eq!(
            HdPrivateKey::from_xprv(&child.to_xprv()).unwrap().to_xprv(),
            CHILD_XPRV
        );
        assert!(!format!("{child:?}").contains(CHILD_XPRV));
    }

    #[test]
    fn hd_private_round_trips_testnet_prefixes() {
        let root = HdPrivateKey::from_seed(&[7u8; 64], HdNetwork::Testnet).unwrap();
        assert!(root.to_xprv().starts_with("tprv"));
        assert_eq!(
            HdPrivateKey::from_xprv(&root.to_xprv()).unwrap().network(),
            HdNetwork::Testnet
        );
    }

    #[test]
    fn hd_private_rejects_bad_paths_and_network_mismatches() {
        let root = HdPrivateKey::from_seed(&[7u8; 64], HdNetwork::Testnet).unwrap();
        assert!(matches!(
            root.derive_path("not/a/path"),
            Err(crate::Error::InvalidDerivationPath)
        ));
        assert!(matches!(
            HdPrivateKey::from_xprv_for_network(&root.to_xprv(), HdNetwork::Mainnet),
            Err(crate::Error::ExtendedKeyNetworkMismatch)
        ));
    }

    #[test]
    fn hd_public_non_hardened_derivation_matches_private_derivation() {
        let mnemonic = Mnemonic::from_phrase(PHRASE).unwrap();
        let account = HdPrivateKey::from_mnemonic(&mnemonic, "TREZOR", HdNetwork::Mainnet)
            .unwrap()
            .derive_path("m/44'/236'/0'")
            .unwrap();
        let from_private = account.derive_path("m/1/0").unwrap().to_public();
        let from_public = account.to_public().derive_path("m/1/0").unwrap();
        assert_eq!(from_public.to_xpub(), from_private.to_xpub());
        assert_eq!(from_public.address(), from_private.address());
    }

    #[test]
    fn hd_public_rejects_hardened_derivation() {
        let public = HdPublicKey::from_xpub(ROOT_XPUB).unwrap();
        assert!(matches!(
            public.derive_path("m/0'"),
            Err(crate::Error::HardenedPublicDerivation)
        ));
    }

    #[test]
    fn hd_public_round_trips_testnet_and_checks_expected_network() {
        let private = HdPrivateKey::from_seed(&[9u8; 64], HdNetwork::Testnet).unwrap();
        let encoded = private.to_public().to_xpub();
        assert!(encoded.starts_with("tpub"));
        assert_eq!(
            HdPublicKey::from_xpub(&encoded).unwrap().network(),
            HdNetwork::Testnet
        );
        assert!(matches!(
            HdPublicKey::from_xpub_for_network(&encoded, HdNetwork::Mainnet),
            Err(crate::Error::ExtendedKeyNetworkMismatch)
        ));
    }

    #[test]
    fn tbc_lib_js_fixture_matches_extended_keys_wif_and_address() {
        let mnemonic = Mnemonic::from_phrase(PHRASE).unwrap();
        let root = HdPrivateKey::from_mnemonic(&mnemonic, "TREZOR", HdNetwork::Mainnet).unwrap();
        let child = root.derive_path(TBC_DERIVATION_PATH).unwrap();

        assert_eq!(root.to_xprv(), ROOT_XPRV);
        assert_eq!(root.to_public().to_xpub(), ROOT_XPUB);
        assert_eq!(child.to_xprv(), CHILD_XPRV);
        assert_eq!(child.to_public().to_xpub(), CHILD_XPUB);
        assert_eq!(child.private_key().to_wif(), CHILD_WIF);
        assert_eq!(child.address().to_string(), CHILD_ADDRESS);
    }
}
