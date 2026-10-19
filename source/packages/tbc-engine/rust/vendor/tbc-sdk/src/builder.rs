use crate::{script::Script, transaction::OutPoint};
#[cfg(feature = "internal-signing")]
use crate::{
    Address, DEFAULT_FEE_RATE_SAT_PER_KB, DEFAULT_SIGHASH, Error, PrivateKey, Result,
    SDK_DUST_SAT, Transaction, TxIn, TxOut,
};

#[derive(Clone, Debug)]
pub struct Utxo {
    pub outpoint: OutPoint,
    pub satoshis: u64,
    pub script_pubkey: Script,
    #[cfg(feature = "internal-signing")]
    pub private_key: PrivateKey,
}

#[cfg(feature = "internal-signing")]
#[derive(Clone, Debug)]
struct Payment {
    address: Address,
    satoshis: u64,
}

#[cfg(feature = "internal-signing")]
#[derive(Clone, Debug)]
pub struct TransactionBuilder {
    utxos: Vec<Utxo>,
    payments: Vec<Payment>,
    change_address: Option<Address>,
    fee_rate_sat_per_kb: u64,
}

#[cfg(feature = "internal-signing")]
impl TransactionBuilder {
    pub fn new() -> Self {
        Self {
            utxos: Vec::new(),
            payments: Vec::new(),
            change_address: None,
            fee_rate_sat_per_kb: DEFAULT_FEE_RATE_SAT_PER_KB,
        }
    }

    pub fn add_p2pkh_utxo(mut self, utxo: Utxo) -> Self {
        self.utxos.push(utxo);
        self
    }

    pub fn pay(mut self, address: Address, satoshis: u64) -> Result<Self> {
        if satoshis < SDK_DUST_SAT {
            return Err(Error::DustOutput(satoshis));
        }
        self.payments.push(Payment { address, satoshis });
        Ok(self)
    }

    pub fn change(mut self, address: Address) -> Self {
        self.change_address = Some(address);
        self
    }

    pub fn fee_rate_sat_per_kb(mut self, fee_rate_sat_per_kb: u64) -> Self {
        self.fee_rate_sat_per_kb = fee_rate_sat_per_kb;
        self
    }

    pub fn build_and_sign(self) -> Result<Transaction> {
        if self.utxos.is_empty() {
            return Err(Error::InvalidUtxo(
                "at least one UTXO is required".to_string(),
            ));
        }

        let input_sum = self
            .utxos
            .iter()
            .try_fold(0u64, |sum, utxo| sum.checked_add(utxo.satoshis))
            .ok_or_else(|| Error::InvalidUtxo("input amount overflow".to_string()))?;
        let payment_sum = self
            .payments
            .iter()
            .try_fold(0u64, |sum, payment| sum.checked_add(payment.satoshis))
            .ok_or_else(|| Error::InvalidUtxo("payment amount overflow".to_string()))?;

        let change_policy = if self.change_address.is_some() {
            ChangePolicy::Optional { dust: SDK_DUST_SAT }
        } else {
            ChangePolicy::Forbidden
        };
        finalize_signed_fee(
            input_sum,
            payment_sum,
            self.fee_rate_sat_per_kb,
            self.fee_rate_sat_per_kb,
            change_policy,
            |change| self.build_signed_tx(change),
        )
    }

    fn build_signed_tx(&self, change_satoshis: Option<u64>) -> Result<Transaction> {
        let mut tx = Transaction::new();
        for utxo in &self.utxos {
            tx.inputs.push(TxIn::new(utxo.outpoint.clone()));
        }
        for payment in &self.payments {
            tx.outputs.push(TxOut {
                satoshis: payment.satoshis,
                script_pubkey: payment.address.script_pubkey(),
            });
        }
        if let (Some(address), Some(satoshis)) = (&self.change_address, change_satoshis) {
            tx.outputs.push(TxOut {
                satoshis,
                script_pubkey: address.script_pubkey(),
            });
        }

        for (index, utxo) in self.utxos.iter().enumerate() {
            tx.sign_p2pkh_input(
                index,
                &utxo.private_key,
                &utxo.script_pubkey,
                utxo.satoshis,
                DEFAULT_SIGHASH,
            )?;
        }
        Ok(tx)
    }
}

#[cfg(feature = "internal-signing")]
impl Default for TransactionBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(feature = "internal-signing")]
pub(crate) fn fee_for_size(size_bytes: usize, fee_rate_sat_per_kb: u64) -> u64 {
    let proportional = (size_bytes as u64 * fee_rate_sat_per_kb).div_ceil(1000);
    proportional.max(fee_rate_sat_per_kb)
}

#[cfg(feature = "internal-signing")]
const MAX_FEE_FINALIZE_ATTEMPTS: usize = 8;

#[cfg(feature = "internal-signing")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ChangePolicy {
    Optional { dust: u64 },
    Required { minimum: u64 },
    Forbidden,
}

#[cfg(feature = "internal-signing")]
fn checked_change(input: u64, non_change_output: u64, fee: u64) -> Result<u64> {
    let required = non_change_output
        .checked_add(fee)
        .ok_or_else(|| Error::InvalidUtxo("fee accounting overflow".to_string()))?;
    input
        .checked_sub(required)
        .ok_or(Error::InsufficientFunds { input, required })
}

#[cfg(feature = "internal-signing")]
fn select_change(amount: u64, policy: ChangePolicy) -> Result<Option<u64>> {
    match policy {
        ChangePolicy::Optional { dust } => Ok((amount >= dust).then_some(amount)),
        ChangePolicy::Required { minimum } if amount >= minimum => Ok(Some(amount)),
        ChangePolicy::Required { minimum } => Err(Error::InsufficientFunds {
            input: amount,
            required: minimum,
        }),
        ChangePolicy::Forbidden => Ok(None),
    }
}

#[cfg(feature = "internal-signing")]
pub(crate) fn paid_fee(tx: &Transaction, input_sum: u64) -> Result<u64> {
    let output_sum = tx.outputs.iter().try_fold(0u64, |sum, output| {
        sum.checked_add(output.satoshis)
            .ok_or_else(|| Error::InvalidUtxo("output amount overflow".to_string()))
    })?;
    input_sum
        .checked_sub(output_sum)
        .ok_or_else(|| Error::InvalidUtxo("transaction outputs exceed inputs".to_string()))
}

#[cfg(feature = "internal-signing")]
pub(crate) fn finalize_signed_fee<F>(
    input_sum: u64,
    non_change_output_sum: u64,
    fee_rate_sat_per_kb: u64,
    initial_fee_floor: u64,
    change_policy: ChangePolicy,
    mut sign: F,
) -> Result<Transaction>
where
    F: FnMut(Option<u64>) -> Result<Transaction>,
{
    let mut target_floor = initial_fee_floor;
    for _ in 0..MAX_FEE_FINALIZE_ATTEMPTS {
        let change = select_change(
            checked_change(input_sum, non_change_output_sum, target_floor)?,
            change_policy,
        )?;
        let signed = sign(change)?;
        target_floor =
            target_floor.max(fee_for_size(signed.serialize().len(), fee_rate_sat_per_kb));
        let next_change = select_change(
            checked_change(input_sum, non_change_output_sum, target_floor)?,
            change_policy,
        )?;
        if next_change == change && paid_fee(&signed, input_sum)? >= target_floor {
            return Ok(signed);
        }
    }
    Err(Error::FeeDidNotConverge)
}

#[cfg(all(test, feature = "internal-signing"))]
mod builder_tests {
    fn assert_target_fee(tx: &crate::Transaction, input_sum: u64) {
        let output_sum = tx
            .outputs
            .iter()
            .try_fold(0u64, |sum, output| sum.checked_add(output.satoshis))
            .unwrap();
        let paid = input_sum.checked_sub(output_sum).unwrap();
        let target =
            crate::builder::fee_for_size(tx.serialize().len(), crate::DEFAULT_FEE_RATE_SAT_PER_KB);
        assert!(
            paid >= target,
            "bytes={} paid={paid} target={target}",
            tx.serialize().len()
        );
    }

    #[test]
    fn builder_builds_and_signs_single_input_payment_with_change() {
        let key = crate::PrivateKey::from_slice(&[3u8; 32]).unwrap();
        let recipient = crate::PrivateKey::from_slice(&[4u8; 32]).unwrap().address();
        let utxo = crate::Utxo {
            outpoint: crate::OutPoint {
                txid: "0101010101010101010101010101010101010101010101010101010101010101"
                    .parse()
                    .unwrap(),
                vout: 0,
            },
            satoshis: 10_000,
            script_pubkey: key.address().script_pubkey(),
            private_key: key.clone(),
        };

        let tx = crate::TransactionBuilder::new()
            .add_p2pkh_utxo(utxo)
            .pay(recipient, 1_000)
            .unwrap()
            .change(key.address())
            .fee_rate_sat_per_kb(80)
            .build_and_sign()
            .unwrap();

        assert_eq!(tx.inputs.len(), 1);
        assert!(!tx.outputs.is_empty());
        assert!(!tx.inputs[0].script_sig.as_bytes().is_empty());
    }

    #[test]
    fn builder_never_underpays_after_signature_size_oscillation() {
        let key = crate::PrivateKey::from_slice(&[1u8; 32]).unwrap();
        let recipient = crate::PrivateKey::from_slice(&[98u8; 32])
            .unwrap()
            .address();
        let mut builder = crate::TransactionBuilder::new();
        for index in 0..2u8 {
            let mut txid = [0u8; 32];
            txid[0] = 1;
            txid[1] = 2;
            txid[2] = 29;
            txid[3] = index;
            builder = builder.add_p2pkh_utxo(crate::Utxo {
                outpoint: crate::OutPoint {
                    txid: crate::Txid::from_le_bytes(txid),
                    vout: index as u32,
                },
                satoshis: 100_000,
                script_pubkey: key.address().script_pubkey(),
                private_key: key.clone(),
            });
        }
        for _ in 0..29 {
            builder = builder.pay(recipient.clone(), 100).unwrap();
        }

        let tx = builder.change(key.address()).build_and_sign().unwrap();

        assert_target_fee(&tx, 200_000);
    }

    #[test]
    fn fee_finalizer_returns_typed_error_when_target_never_stabilizes() {
        let mut attempt = 0usize;
        let error = crate::builder::finalize_signed_fee(
            1_000_000,
            0,
            crate::DEFAULT_FEE_RATE_SAT_PER_KB,
            crate::DEFAULT_FEE_RATE_SAT_PER_KB,
            crate::builder::ChangePolicy::Optional { dust: 0 },
            |change| {
                attempt += 1;
                let mut tx = crate::Transaction::new();
                tx.outputs.push(crate::TxOut {
                    satoshis: change.unwrap(),
                    script_pubkey: crate::script::Script::empty(),
                });
                tx.outputs.push(crate::TxOut {
                    satoshis: 0,
                    script_pubkey: crate::script::Script::from_bytes(vec![0x6a; attempt * 2_000]),
                });
                Ok(tx)
            },
        )
        .unwrap_err();

        assert!(matches!(error, crate::Error::FeeDidNotConverge));
        assert_eq!(attempt, 8);
    }
}
