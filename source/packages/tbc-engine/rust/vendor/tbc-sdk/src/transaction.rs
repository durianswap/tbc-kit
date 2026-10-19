use std::{fmt, str::FromStr};

use crate::{
    DEFAULT_LOCK_TIME, DEFAULT_SEQUENCE, Error, Result, TX_VERSION,
    encoding::{read_compact_size, read_exact, write_compact_size},
    hash,
    keys::PublicKey,
    script::Script,
    sighash,
};
#[cfg(feature = "internal-signing")]
use crate::keys::PrivateKey;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Txid([u8; 32]);

impl Txid {
    pub fn from_le_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn as_le_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl FromStr for Txid {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self> {
        let bytes = hex::decode(value)?;
        if bytes.len() != 32 {
            return Err(Error::InvalidTransactionHex);
        }
        let mut le = [0u8; 32];
        for (index, byte) in bytes.iter().rev().enumerate() {
            le[index] = *byte;
        }
        Ok(Self(le))
    }
}

impl fmt::Display for Txid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut be = self.0;
        be.reverse();
        f.write_str(&hex::encode(be))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutPoint {
    pub txid: Txid,
    pub vout: u32,
}

impl OutPoint {
    pub fn serialize(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(self.txid.as_le_bytes());
        out.extend_from_slice(&self.vout.to_le_bytes());
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TxIn {
    pub previous_output: OutPoint,
    pub script_sig: Script,
    pub sequence: u32,
}

impl TxIn {
    pub fn new(previous_output: OutPoint) -> Self {
        Self {
            previous_output,
            script_sig: Script::empty(),
            sequence: DEFAULT_SEQUENCE,
        }
    }

    pub fn serialize(&self, out: &mut Vec<u8>) {
        self.previous_output.serialize(out);
        write_compact_size(self.script_sig.as_bytes().len() as u64, out);
        out.extend_from_slice(self.script_sig.as_bytes());
        out.extend_from_slice(&self.sequence.to_le_bytes());
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TxOut {
    pub satoshis: u64,
    pub script_pubkey: Script,
}

impl TxOut {
    pub fn serialize(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.satoshis.to_le_bytes());
        write_compact_size(self.script_pubkey.as_bytes().len() as u64, out);
        out.extend_from_slice(self.script_pubkey.as_bytes());
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transaction {
    pub version: i32,
    pub inputs: Vec<TxIn>,
    pub outputs: Vec<TxOut>,
    pub lock_time: u32,
}

impl Transaction {
    pub fn new() -> Self {
        Self {
            version: TX_VERSION,
            inputs: Vec::new(),
            outputs: Vec::new(),
            lock_time: DEFAULT_LOCK_TIME,
        }
    }

    pub fn serialize(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&self.version.to_le_bytes());
        write_compact_size(self.inputs.len() as u64, &mut out);
        for input in &self.inputs {
            input.serialize(&mut out);
        }
        write_compact_size(self.outputs.len() as u64, &mut out);
        for output in &self.outputs {
            output.serialize(&mut out);
        }
        out.extend_from_slice(&self.lock_time.to_le_bytes());
        out
    }

    pub fn to_hex(&self) -> String {
        hex::encode(self.serialize())
    }

    pub fn from_hex(hex: &str) -> Result<Self> {
        let bytes = hex::decode(hex)?;
        Self::from_bytes(&bytes)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let mut offset = 0;
        let version = i32::from_le_bytes(read_exact(bytes, &mut offset)?);
        let input_count = bounded_item_count(
            read_compact_size(bytes, &mut offset)?,
            bytes.len().saturating_sub(offset),
            41,
            5,
        )?;
        let mut inputs = Vec::new();
        inputs
            .try_reserve_exact(input_count)
            .map_err(|_| Error::InvalidTransactionHex)?;
        for _ in 0..input_count {
            let txid = Txid::from_le_bytes(read_exact(bytes, &mut offset)?);
            let vout = u32::from_le_bytes(read_exact(bytes, &mut offset)?);
            let script_len = read_compact_size(bytes, &mut offset)? as usize;
            let script_end = offset
                .checked_add(script_len)
                .ok_or(Error::InvalidTransactionHex)?;
            let script = bytes
                .get(offset..script_end)
                .ok_or(Error::InvalidTransactionHex)?
                .to_vec();
            offset = script_end;
            let sequence = u32::from_le_bytes(read_exact(bytes, &mut offset)?);
            inputs.push(TxIn {
                previous_output: OutPoint { txid, vout },
                script_sig: Script::from_bytes(script),
                sequence,
            });
        }

        let output_count = bounded_item_count(
            read_compact_size(bytes, &mut offset)?,
            bytes.len().saturating_sub(offset),
            9,
            4,
        )?;
        let mut outputs = Vec::new();
        outputs
            .try_reserve_exact(output_count)
            .map_err(|_| Error::InvalidTransactionHex)?;
        for _ in 0..output_count {
            let satoshis = u64::from_le_bytes(read_exact(bytes, &mut offset)?);
            let script_len = read_compact_size(bytes, &mut offset)? as usize;
            let script_end = offset
                .checked_add(script_len)
                .ok_or(Error::InvalidTransactionHex)?;
            let script = bytes
                .get(offset..script_end)
                .ok_or(Error::InvalidTransactionHex)?
                .to_vec();
            offset = script_end;
            outputs.push(TxOut {
                satoshis,
                script_pubkey: Script::from_bytes(script),
            });
        }

        let lock_time = u32::from_le_bytes(read_exact(bytes, &mut offset)?);
        if offset != bytes.len() {
            return Err(Error::InvalidTransactionHex);
        }

        Ok(Self {
            version,
            inputs,
            outputs,
            lock_time,
        })
    }

    pub fn txid(&self) -> Txid {
        self.tbc_txid()
    }

    pub fn add_input_from_prev_tx(&mut self, prev_tx: &Transaction, vout: u32) -> Result<()> {
        if prev_tx.outputs.get(vout as usize).is_none() {
            return Err(Error::InvalidUtxo(
                "previous transaction output index out of range".to_string(),
            ));
        }
        self.inputs.push(TxIn::new(OutPoint {
            txid: prev_tx.txid(),
            vout,
        }));
        Ok(())
    }

    fn tbc_txid(&self) -> Txid {
        let mut root = Vec::new();
        root.extend_from_slice(&self.version.to_le_bytes());
        root.extend_from_slice(&self.lock_time.to_le_bytes());
        root.extend_from_slice(&(self.inputs.len() as u32).to_le_bytes());
        root.extend_from_slice(&(self.outputs.len() as u32).to_le_bytes());

        let mut input_base = Vec::new();
        let mut input_unlocks = Vec::new();
        for input in &self.inputs {
            input.previous_output.serialize(&mut input_base);
            input_base.extend_from_slice(&input.sequence.to_le_bytes());
            input_unlocks.extend_from_slice(&hash::sha256(input.script_sig.as_bytes()));
        }
        root.extend_from_slice(&hash::sha256(&input_base));
        root.extend_from_slice(&hash::sha256(&input_unlocks));

        let mut output_data = Vec::new();
        for output in &self.outputs {
            output_data.extend_from_slice(&output.satoshis.to_le_bytes());
            output_data.extend_from_slice(&hash::sha256(output.script_pubkey.as_bytes()));
        }
        root.extend_from_slice(&hash::sha256(&output_data));

        Txid::from_le_bytes(hash::sha256d(&root))
    }

    #[cfg(feature = "internal-signing")]
    pub fn sign_p2pkh_input(
        &mut self,
        input_index: usize,
        private_key: &PrivateKey,
        script_code: &Script,
        input_satoshis: u64,
        sighash_type: u32,
    ) -> Result<()> {
        self.sign_input_with_chunks(
            input_index,
            private_key,
            script_code,
            input_satoshis,
            sighash_type,
            &[],
        )
    }

    #[cfg(feature = "internal-signing")]
    pub fn sign_input_with_chunks(
        &mut self,
        input_index: usize,
        private_key: &PrivateKey,
        script_code: &Script,
        input_satoshis: u64,
        sighash_type: u32,
        extra_chunks: &[Vec<u8>],
    ) -> Result<()> {
        let signature_bytes = self.signature_with_hashtype(
            input_index,
            private_key,
            script_code,
            input_satoshis,
            sighash_type,
        )?;
        let public_key = private_key.public_key().to_bytes();

        let mut script_sig = Script::empty();
        script_sig.push_data(&signature_bytes);
        script_sig.push_data(&public_key);
        for chunk in extra_chunks {
            script_sig.push_data(chunk);
        }
        self.inputs[input_index].script_sig = script_sig;
        Ok(())
    }

    pub fn sighash_digest(
        &self,
        input_index: usize,
        script_code: &Script,
        input_satoshis: u64,
        sighash_type: u32,
    ) -> Result<[u8; 32]> {
        if input_index >= self.inputs.len() {
            return Err(Error::InvalidUtxo("input index out of range".to_string()));
        }
        sighash::forkid_sighash(self, input_index, script_code, input_satoshis, sighash_type)
    }

    pub fn apply_p2pkh_signature(
        &mut self,
        input_index: usize,
        public_key: &PublicKey,
        script_code: &Script,
        input_satoshis: u64,
        sighash_type: u32,
        der_signature: &[u8],
    ) -> Result<()> {
        let digest = self.sighash_digest(input_index, script_code, input_satoshis, sighash_type)?;
        if !sighash::verify_low_s_ecdsa(public_key, &digest, der_signature)? {
            return Err(Error::InvalidUtxo(
                "signature is high-S or does not verify".to_string(),
            ));
        }
        let mut signature_with_hashtype = der_signature.to_vec();
        signature_with_hashtype.push((sighash_type & 0xff) as u8);
        let mut script_sig = Script::empty();
        script_sig.push_data(&signature_with_hashtype);
        script_sig.push_data(&public_key.to_bytes());
        self.inputs[input_index].script_sig = script_sig;
        Ok(())
    }

    #[cfg(feature = "internal-signing")]
    pub(crate) fn signature_with_hashtype(
        &self,
        input_index: usize,
        private_key: &PrivateKey,
        script_code: &Script,
        input_satoshis: u64,
        sighash_type: u32,
    ) -> Result<Vec<u8>> {
        let digest = self.sighash_digest(input_index, script_code, input_satoshis, sighash_type)?;
        let mut signature_bytes = private_key.sign_ecdsa_digest(&digest);
        signature_bytes.push((sighash_type & 0xff) as u8);
        Ok(signature_bytes)
    }
}

fn bounded_item_count(
    count: u64,
    remaining_bytes: usize,
    minimum_item_bytes: usize,
    trailing_bytes: usize,
) -> Result<usize> {
    let available = remaining_bytes
        .checked_sub(trailing_bytes)
        .ok_or(Error::InvalidTransactionHex)?;
    let count = usize::try_from(count).map_err(|_| Error::InvalidTransactionHex)?;
    if count > available / minimum_item_bytes {
        return Err(Error::InvalidTransactionHex);
    }
    Ok(count)
}

impl Default for Transaction {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod transaction_tests {
    #[test]
    fn transaction_new_uses_tbc_defaults_and_serializes_empty_transaction() {
        let tx = crate::Transaction::new();
        assert_eq!(tx.version, crate::TX_VERSION);
        assert_eq!(tx.lock_time, crate::DEFAULT_LOCK_TIME);
        assert_eq!(hex::encode(tx.serialize()), "0a000000000000000000");
    }

    #[test]
    fn transaction_add_input_from_prev_tx_uses_tbc_txid_and_vout() {
        let mut prev = crate::Transaction::new();
        prev.outputs.push(crate::TxOut {
            satoshis: 100,
            script_pubkey: crate::script::Script::from_bytes(vec![0x51]),
        });

        let expected = prev.txid();
        let mut tx = crate::Transaction::new();
        tx.add_input_from_prev_tx(&prev, 0).unwrap();

        assert_eq!(tx.inputs[0].previous_output.txid, expected);
        assert_eq!(tx.inputs[0].previous_output.vout, 0);
    }

    #[test]
    fn transaction_add_input_from_prev_tx_rejects_missing_output() {
        let prev = crate::Transaction::new();
        let mut tx = crate::Transaction::new();
        assert!(tx.add_input_from_prev_tx(&prev, 0).is_err());
    }

    #[test]
    fn transaction_txid_always_uses_tbc_header_hashing() {
        let mut tx = crate::Transaction::new();
        tx.version = 1;
        tx.outputs.push(crate::TxOut {
            satoshis: 100,
            script_pubkey: crate::script::Script::from_bytes(vec![0x51]),
        });

        let legacy_txid = crate::Txid::from_le_bytes(crate::hash::sha256d(&tx.serialize()));

        assert_ne!(tx.txid(), legacy_txid);
    }
}
