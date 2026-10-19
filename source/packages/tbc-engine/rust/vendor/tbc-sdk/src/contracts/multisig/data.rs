use crate::contracts::ft::unlock::{classify_ft_script, ft_pre_pre_source_indexes};
use crate::contracts::stable_coin::scripts::{COIN_FT_SEQUENCE, get_lock_time_from_tape};
use crate::{Address, Error, OutPoint, Result, TX_VERSION, Transaction, script::Script};

use super::address::MultiSig;

pub(super) const MAX_MONEY_SAT: u64 = 21_000_000 * 100_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum MultiSigUnsignedKind {
    Tbc,
    Ft,
}

#[derive(Clone, Debug)]
pub struct MultiSigUtxo {
    pub outpoint: OutPoint,
    pub satoshis: u64,
    pub locking_script: Script,
}

#[derive(Clone, Debug)]
pub struct MultiSigUnsignedTx {
    pub transaction: Transaction,
    pub input_satoshis: Vec<u64>,
    pub source_address: String,
    pub(super) source_locking_script: Script,
    pub(super) source_input_satoshis: Vec<u64>,
    pub(super) source_transaction: Vec<u8>,
    pub(super) kind: MultiSigUnsignedKind,
    pub(super) total_input_satoshis: u64,
}

impl MultiSigUnsignedTx {
    pub fn from_parts(
        transaction: Transaction,
        input_satoshis: Vec<u64>,
        source_address: String,
    ) -> Result<Self> {
        validate_unsigned_transaction(&transaction, &input_satoshis)?;
        let source_locking_script = MultiSig::lock_script(&source_address)?;
        let source_transaction = transaction.serialize();
        Ok(Self {
            transaction,
            source_input_satoshis: input_satoshis.clone(),
            total_input_satoshis: validate_money_range(&input_satoshis, "MultiSig input")?,
            input_satoshis,
            source_address,
            source_locking_script,
            source_transaction,
            kind: MultiSigUnsignedKind::Tbc,
        })
    }

    pub fn from_ft_parts(
        transaction: Transaction,
        input_parents: Vec<Transaction>,
        source_address: String,
    ) -> Result<Self> {
        if input_parents.len() != transaction.inputs.len() {
            return Err(Error::InvalidUtxo(
                "MultiSig FT parent count must match transaction input count".to_string(),
            ));
        }
        let source_locking_script = MultiSig::lock_script(&source_address)?;
        let mut input_satoshis = Vec::with_capacity(transaction.inputs.len());
        let mut coin_mode = None;
        let mut required_lock_time = 0u32;
        for (index, (input, parent)) in transaction.inputs.iter().zip(&input_parents).enumerate() {
            if parent.txid() != input.previous_output.txid {
                return Err(Error::InvalidUtxo(format!(
                    "MultiSig FT input {index} parent transaction id does not match its outpoint"
                )));
            }
            let vout = input.previous_output.vout as usize;
            let parent_output = parent.outputs.get(vout).ok_or_else(|| {
                Error::InvalidUtxo(format!(
                    "MultiSig FT input {index} parent vout is out of range"
                ))
            })?;
            if index == 0 {
                if parent_output.script_pubkey != source_locking_script {
                    return Err(Error::InvalidUtxo(
                        "MultiSig FT funding parent script does not match source address"
                            .to_string(),
                    ));
                }
            } else {
                let script_info = classify_ft_script(&parent_output.script_pubkey)?;
                if coin_mode.is_some_and(|mode| mode != script_info.is_coin) {
                    return Err(Error::InvalidUtxo(
                        "Mixed FT and StableCoin inputs are not supported".to_string(),
                    ));
                }
                coin_mode = Some(script_info.is_coin);
                if script_info.is_coin {
                    if transaction.inputs[index].sequence != COIN_FT_SEQUENCE {
                        return Err(Error::InvalidUtxo(format!(
                            "StableCoin input {index} must use the released sequence"
                        )));
                    }
                    let tape = parent.outputs.get(vout + 1).ok_or_else(|| {
                        Error::InvalidUtxo(format!(
                            "StableCoin input {index} is missing its adjacent Tape"
                        ))
                    })?;
                    required_lock_time =
                        required_lock_time.max(get_lock_time_from_tape(&tape.script_pubkey)?);
                }
                ft_pre_pre_source_indexes(parent, vout)?;
            }
            input_satoshis.push(parent_output.satoshis);
        }
        if coin_mode == Some(true) && transaction.lock_time != required_lock_time {
            return Err(Error::InvalidUtxo(
                "MultiSig StableCoin transaction lock time does not match its inputs".to_string(),
            ));
        }
        let total_input_satoshis = validate_money_range(&input_satoshis, "MultiSig FT input")?;
        validate_unsigned_ft_transaction(&transaction, &input_satoshis, total_input_satoshis)?;
        let source_transaction = transaction.serialize();
        Ok(Self {
            transaction,
            source_input_satoshis: input_satoshis.clone(),
            input_satoshis,
            source_address,
            source_locking_script,
            source_transaction,
            kind: MultiSigUnsignedKind::Ft,
            total_input_satoshis,
        })
    }
}

pub(super) fn validate_money_range(amounts: &[u64], description: &str) -> Result<u64> {
    let mut total = 0u64;
    for (index, amount) in amounts.iter().copied().enumerate() {
        if amount > MAX_MONEY_SAT {
            return Err(Error::InvalidUtxo(format!(
                "{description} {index} exceeds consensus MoneyRange"
            )));
        }
        total = total.checked_add(amount).ok_or_else(|| {
            Error::InvalidUtxo(format!("{description} total exceeds consensus MoneyRange"))
        })?;
        if total > MAX_MONEY_SAT {
            return Err(Error::InvalidUtxo(format!(
                "{description} total exceeds consensus MoneyRange"
            )));
        }
    }
    Ok(total)
}

pub(super) fn validate_unsigned_transaction(
    transaction: &Transaction,
    input_satoshis: &[u64],
) -> Result<()> {
    validate_transaction_structure(transaction)?;
    if transaction.inputs.len() != input_satoshis.len() {
        return Err(Error::InvalidUtxo(
            "input amount count does not match transaction input count".to_string(),
        ));
    }
    if input_satoshis.contains(&0) {
        return Err(Error::InvalidUtxo(
            "MultiSig input amount must be greater than zero".to_string(),
        ));
    }
    validate_money_range(input_satoshis, "MultiSig input")?;
    if transaction
        .inputs
        .iter()
        .any(|input| !input.script_sig.as_bytes().is_empty())
    {
        return Err(Error::InvalidUtxo(
            "MultiSig transaction is not unsigned".to_string(),
        ));
    }
    Ok(())
}

pub(super) fn validate_unsigned_ft_transaction(
    transaction: &Transaction,
    input_satoshis: &[u64],
    total_input_satoshis: u64,
) -> Result<()> {
    validate_transaction_structure(transaction)?;
    if !(2..=6).contains(&transaction.inputs.len()) {
        return Err(Error::InvalidUtxo(
            "MultiSig FT transaction requires one funding input and one to five FT inputs"
                .to_string(),
        ));
    }
    if input_satoshis.len() != transaction.inputs.len() {
        return Err(Error::InvalidUtxo(
            "MultiSig FT amount count must match transaction input count".to_string(),
        ));
    }
    if input_satoshis.contains(&0) {
        return Err(Error::InvalidUtxo(
            "MultiSig FT input amounts must be greater than zero".to_string(),
        ));
    }
    let validated_total = validate_money_range(input_satoshis, "MultiSig FT input")?;
    if validated_total != total_input_satoshis {
        return Err(Error::InvalidUtxo(
            "MultiSig FT total input does not match its amount vector".to_string(),
        ));
    }
    if !transaction.inputs[0].script_sig.as_bytes().is_empty() {
        return Err(Error::InvalidUtxo(
            "MultiSig FT funding input must be unsigned".to_string(),
        ));
    }
    if transaction.inputs[1..]
        .iter()
        .any(|input| input.script_sig.as_bytes().is_empty())
    {
        return Err(Error::InvalidUtxo(
            "MultiSig FT contract inputs must already be signed".to_string(),
        ));
    }
    let output_total = validate_money_range(
        &transaction
            .outputs
            .iter()
            .map(|output| output.satoshis)
            .collect::<Vec<_>>(),
        "transaction output",
    )?;
    if output_total > total_input_satoshis {
        return Err(Error::InvalidUtxo(
            "MultiSig FT outputs exceed total inputs".to_string(),
        ));
    }
    Ok(())
}

fn validate_transaction_structure(transaction: &Transaction) -> Result<()> {
    if transaction.version != TX_VERSION {
        return Err(Error::InvalidUtxo(format!(
            "unsigned MultiSig transaction version must be {TX_VERSION}"
        )));
    }
    if transaction.inputs.is_empty() {
        return Err(Error::InvalidUtxo(
            "unsigned MultiSig transaction has no inputs".to_string(),
        ));
    }
    if transaction.outputs.is_empty() {
        return Err(Error::InvalidUtxo(
            "unsigned MultiSig transaction has no outputs".to_string(),
        ));
    }
    validate_money_range(
        &transaction
            .outputs
            .iter()
            .map(|output| output.satoshis)
            .collect::<Vec<_>>(),
        "transaction output",
    )?;
    if transaction.inputs.iter().any(|input| {
        input.previous_output.vout == u32::MAX
            && input
                .previous_output
                .txid
                .as_le_bytes()
                .iter()
                .all(|byte| *byte == 0)
    }) {
        return Err(Error::InvalidUtxo(
            "unsigned MultiSig transaction contains a null previous output".to_string(),
        ));
    }
    let mut outpoints = Vec::new();
    if transaction.inputs.iter().any(|input| {
        if outpoints.contains(&input.previous_output) {
            true
        } else {
            outpoints.push(input.previous_output.clone());
            false
        }
    }) {
        return Err(Error::InvalidUtxo(
            "unsigned MultiSig transaction contains a duplicate outpoint".to_string(),
        ));
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub enum MultiSigDestination {
    P2pkh(Address),
    MultiSig(String),
}

pub type MultiSigInputSignatures = Vec<Vec<Vec<u8>>>;
