use crate::{
    Address, DEFAULT_FEE_RATE_SAT_PER_KB, DEFAULT_SIGHASH, Error, PrivateKey, PublicKey, Result,
    SDK_DUST_SAT, Transaction, TxIn, TxOut, Utxo,
    builder::{ChangePolicy, fee_for_size, finalize_signed_fee, paid_fee},
    script::Script,
};

use crate::contracts::ft::{
    Ft, FtUtxo,
    amount::{balance_from_tape, build_tape_amount, build_tape_amount_with_offset},
    builder::{sign_ft_input, sign_ft_swap_input},
    scripts::{FT_TAPE_SATOSHIS, FtCodeReceiver, transfer_code_script, transfer_tape_script},
    unlock::{classify_ft_script, pre_pre_tx_data_from_parents},
};
use crate::contracts::stable_coin::scripts::{COIN_FT_SEQUENCE, get_lock_time_from_tape};

use super::{
    MultiSigDestination, MultiSigInputSignatures, MultiSigUnsignedTx, MultiSigUtxo,
    address::{MultiSig, canonical_public_keys, decode_address},
    data::{
        MAX_MONEY_SAT, MultiSigUnsignedKind, validate_money_range,
        validate_unsigned_ft_transaction, validate_unsigned_transaction,
    },
    scripts::{hold_script, tape_script},
};

const MULTISIG_FT_CODE_SATOSHIS: u64 = 2_000;
const MULTISIG_MINER_FEE_FLOOR_SAT: u64 = 1_000;
const MAX_MULTISIG_SIGNATURE_WITH_HASHTYPE_BYTES: usize = 73;
const MAX_MULTISIG_TBC_INPUTS: usize = 1_000;

impl MultiSig {
    pub fn create_wallet(
        address_from: &Address,
        public_keys: &[PublicKey],
        required_signatures: u8,
        amount_sat: u64,
        utxos: Vec<Utxo>,
    ) -> Result<Transaction> {
        require_ordinary_output(amount_sat)?;
        validate_p2pkh_utxos(address_from, &utxos)?;

        let address = Self::address(public_keys, required_signatures)?;
        let mut canonical_keys = public_keys.to_vec();
        canonical_keys.sort_by_key(PublicKey::to_bytes);
        let input_sum = sum_p2pkh_inputs(&utxos)?;
        let hold_sum = (canonical_keys.len() as u64)
            .checked_mul(200)
            .ok_or_else(|| Error::InvalidUtxo("wallet output amount overflow".to_string()))?;
        let non_change_sum = amount_sat
            .checked_add(hold_sum)
            .ok_or_else(|| Error::InvalidUtxo("wallet output amount overflow".to_string()))?;

        let mut outputs = Vec::with_capacity(canonical_keys.len() + 2);
        outputs.push(TxOut {
            satoshis: amount_sat,
            script_pubkey: Self::lock_script(&address)?,
        });
        outputs.extend(canonical_keys.iter().map(|public_key| TxOut {
            satoshis: 200,
            script_pubkey: hold_script(public_key),
        }));
        outputs.push(TxOut {
            satoshis: 0,
            script_pubkey: tape_script(&address, &canonical_keys)?,
        });

        finalize_p2pkh_transaction(address_from, &utxos, outputs, input_sum, non_change_sum)
    }

    pub fn p2pkh_to_multisig_tbc(
        address_from: &Address,
        address_to: &str,
        amount_sat: u64,
        utxos: Vec<Utxo>,
    ) -> Result<Transaction> {
        require_ordinary_output(amount_sat)?;
        validate_p2pkh_utxos(address_from, &utxos)?;
        let input_sum = sum_p2pkh_inputs(&utxos)?;
        let outputs = vec![TxOut {
            satoshis: amount_sat,
            script_pubkey: Self::lock_script(address_to)?,
        }];
        finalize_p2pkh_transaction(address_from, &utxos, outputs, input_sum, amount_sat)
    }

    pub fn build_tbc_transaction(
        address_from: &str,
        destination: MultiSigDestination,
        amount_sat: u64,
        utxos: Vec<MultiSigUtxo>,
    ) -> Result<MultiSigUnsignedTx> {
        require_ordinary_output(amount_sat)?;
        if utxos.is_empty() {
            return Err(Error::InvalidUtxo(
                "at least one MultiSig UTXO is required".to_string(),
            ));
        }
        if utxos.len() > MAX_MULTISIG_TBC_INPUTS {
            return Err(Error::InvalidUtxo(format!(
                "MultiSig TBC transactions support at most {MAX_MULTISIG_TBC_INPUTS} inputs"
            )));
        }

        let source_locking_script = Self::lock_script(address_from)?;
        let mut outpoints = Vec::new();
        for (index, utxo) in utxos.iter().enumerate() {
            if utxo.satoshis == 0 {
                return Err(Error::InvalidUtxo(format!(
                    "MultiSig input {index} has zero satoshis"
                )));
            }
            if utxo.locking_script != source_locking_script {
                return Err(Error::InvalidUtxo(format!(
                    "MultiSig input {index} locking script does not match source address"
                )));
            }
            if outpoints.contains(&utxo.outpoint) {
                return Err(Error::InvalidUtxo(format!(
                    "MultiSig input {index} duplicates an earlier outpoint"
                )));
            }
            outpoints.push(utxo.outpoint.clone());
        }

        let input_satoshis = utxos.iter().map(|utxo| utxo.satoshis).collect::<Vec<_>>();
        let input_sum = sum_amounts(&input_satoshis, "MultiSig input amount overflow")?;

        let destination_script = match destination {
            MultiSigDestination::P2pkh(address) => address.script_pubkey(),
            MultiSigDestination::MultiSig(address) => Self::lock_script(&address)?,
        };
        let mut transaction = Transaction::new();
        transaction
            .inputs
            .extend(utxos.into_iter().map(|utxo| TxIn::new(utxo.outpoint)));
        transaction.outputs.push(TxOut {
            satoshis: SDK_DUST_SAT,
            script_pubkey: source_locking_script.clone(),
        });
        transaction.outputs.push(TxOut {
            satoshis: amount_sat,
            script_pubkey: destination_script,
        });

        let fee = multisig_fee_for_unsigned(
            address_from,
            &transaction,
            &(0..transaction.inputs.len()).collect::<Vec<_>>(),
            0,
        )?;
        let required = amount_sat
            .checked_add(fee)
            .ok_or_else(|| Error::InvalidUtxo("MultiSig amount overflow".to_string()))?;
        let change = input_sum
            .checked_sub(required)
            .ok_or(Error::InsufficientFunds {
                input: input_sum,
                required,
            })?;
        if change >= SDK_DUST_SAT {
            transaction.outputs[0].satoshis = change;
        } else {
            transaction.outputs.remove(0);
        }

        MultiSigUnsignedTx::from_parts(transaction, input_satoshis, address_from.to_string())
    }

    pub fn sign_tbc_transaction(
        address_from: &str,
        unsigned: &MultiSigUnsignedTx,
        private_key: &PrivateKey,
    ) -> Result<Vec<Vec<u8>>> {
        validate_unsigned(unsigned)?;
        if address_from != unsigned.source_address {
            return Err(Error::InvalidUtxo(
                "source address does not match unsigned transaction".to_string(),
            ));
        }
        if Self::lock_script(address_from)? != unsigned.source_locking_script {
            return Err(Error::InvalidUtxo(
                "source locking script does not match unsigned transaction".to_string(),
            ));
        }

        unsigned
            .input_satoshis
            .iter()
            .enumerate()
            .map(|(input_index, satoshis)| {
                unsigned.transaction.signature_with_hashtype(
                    input_index,
                    private_key,
                    &unsigned.source_locking_script,
                    *satoshis,
                    DEFAULT_SIGHASH,
                )
            })
            .collect()
    }

    pub fn batch_sign_tbc_transactions(
        address_from: &str,
        transactions: &[MultiSigUnsignedTx],
        private_key: &PrivateKey,
    ) -> Result<Vec<Vec<Vec<u8>>>> {
        transactions
            .iter()
            .map(|transaction| Self::sign_tbc_transaction(address_from, transaction, private_key))
            .collect()
    }

    pub fn finish_tbc_transaction(
        unsigned: &MultiSigUnsignedTx,
        signatures: &MultiSigInputSignatures,
        public_keys: &[PublicKey],
    ) -> Result<Transaction> {
        validate_unsigned(unsigned)?;
        let input_indexes = (0..unsigned.transaction.inputs.len()).collect::<Vec<_>>();
        let transaction =
            finish_multisig_inputs(unsigned, signatures, public_keys, &input_indexes)?;

        let input_sum = sum_amounts(&unsigned.input_satoshis, "MultiSig input amount overflow")?;
        let target = fee_for_size(transaction.serialize().len(), DEFAULT_FEE_RATE_SAT_PER_KB);
        let paid = paid_fee(&transaction, input_sum)?;
        if paid < target {
            return Err(Error::InvalidUtxo(format!(
                "final MultiSig fee {paid} is below signed-size target {target}"
            )));
        }
        Ok(transaction)
    }

    pub fn batch_finish_tbc_transactions(
        transactions: &[MultiSigUnsignedTx],
        signatures: &[MultiSigInputSignatures],
        public_keys: &[PublicKey],
    ) -> Result<Vec<Transaction>> {
        if transactions.len() != signatures.len() {
            return Err(Error::InvalidUtxo(
                "MultiSig transaction and signature batch lengths do not match".to_string(),
            ));
        }
        transactions
            .iter()
            .zip(signatures)
            .map(|(transaction, signatures)| {
                Self::finish_tbc_transaction(transaction, signatures, public_keys)
            })
            .collect()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn p2pkh_to_multisig_ft(
        address_from: &Address,
        address_to: &str,
        ft: &Ft,
        amount_raw: u128,
        ft_utxos: Vec<FtUtxo>,
        fee_utxo: Utxo,
        pre_txs: Vec<Transaction>,
        pre_pre_txs_set: Vec<Vec<Transaction>>,
        private_key: &PrivateKey,
        tbc_amount_sat: Option<u64>,
    ) -> Result<Transaction> {
        if amount_raw == 0 {
            return Err(Error::InvalidUtxo(
                "MultiSig FT transfer amount must be greater than zero".to_string(),
            ));
        }
        if private_key.address() != *address_from {
            return Err(Error::InvalidUtxo(
                "FT owner key does not match source address".to_string(),
            ));
        }
        validate_p2pkh_utxos(address_from, std::slice::from_ref(&fee_utxo))?;
        Self::lock_script(address_to)?;
        let pre_pre_tx_data_set = derive_ft_pre_pre_data(&ft_utxos, &pre_txs, &pre_pre_txs_set)?;
        let context = validate_ft_spend_context(
            ft,
            &ft_utxos,
            &pre_txs,
            &pre_pre_tx_data_set,
            FtCodeReceiver::Address(address_from.clone()),
            private_key,
        )?;
        reject_duplicate_ft_outpoints(&ft_utxos, &fee_utxo.outpoint)?;
        let (amount_tape, change_tape) = build_tape_amount(amount_raw, &context.input_balances)?;

        let mut outputs = Vec::new();
        if let Some(satoshis) = tbc_amount_sat {
            require_ordinary_output(satoshis)?;
            outputs.push(TxOut {
                satoshis,
                script_pubkey: Self::lock_script(address_to)?,
            });
        }
        outputs.push(TxOut {
            satoshis: MULTISIG_FT_CODE_SATOSHIS,
            script_pubkey: transfer_code_script(
                &context.code_script,
                FtCodeReceiver::ContractHash(Self::combine_hash(address_to)?),
            )?,
        });
        outputs.push(TxOut {
            satoshis: FT_TAPE_SATOSHIS,
            script_pubkey: transfer_tape_script(&context.tape_script, &amount_tape)?,
        });
        if amount_raw < context.total_ft {
            outputs.push(TxOut {
                satoshis: MULTISIG_FT_CODE_SATOSHIS,
                script_pubkey: transfer_code_script(
                    &context.code_script,
                    FtCodeReceiver::Address(address_from.clone()),
                )?,
            });
            outputs.push(TxOut {
                satoshis: FT_TAPE_SATOSHIS,
                script_pubkey: transfer_tape_script(&context.tape_script, &change_tape)?,
            });
        }
        validate_output_money_range(&outputs)?;
        let input_satoshis = ft_utxos
            .iter()
            .map(|utxo| utxo.base.satoshis)
            .chain(std::iter::once(fee_utxo.satoshis))
            .collect::<Vec<_>>();
        let input_sum = validate_money_range(&input_satoshis, "MultiSig FT deposit input")?;
        let output_sum = validate_money_range(
            &outputs
                .iter()
                .map(|output| output.satoshis)
                .collect::<Vec<_>>(),
            "MultiSig FT deposit output",
        )?;

        finalize_signed_fee(
            input_sum,
            output_sum,
            DEFAULT_FEE_RATE_SAT_PER_KB,
            DEFAULT_FEE_RATE_SAT_PER_KB,
            ChangePolicy::Optional { dust: SDK_DUST_SAT },
            |change| {
                let mut transaction = Transaction::new();
                transaction.inputs.extend(
                    ft_utxos
                        .iter()
                        .map(|utxo| TxIn::new(utxo.base.outpoint.clone())),
                );
                transaction
                    .inputs
                    .push(TxIn::new(fee_utxo.outpoint.clone()));
                apply_stable_coin_lock_times(
                    &mut transaction,
                    &ft_utxos,
                    &pre_txs,
                    0,
                    context.is_coin,
                )?;
                transaction.outputs.extend(outputs.iter().cloned());
                if let Some(satoshis) = change {
                    transaction.outputs.push(TxOut {
                        satoshis,
                        script_pubkey: address_from.script_pubkey(),
                    });
                }
                for (input_index, ft_utxo) in ft_utxos.iter().enumerate() {
                    sign_ft_input(
                        &mut transaction,
                        input_index,
                        private_key,
                        ft_utxo,
                        &pre_txs[input_index],
                        &pre_pre_tx_data_set[input_index],
                        context.is_coin,
                    )?;
                }
                transaction.sign_p2pkh_input(
                    ft_utxos.len(),
                    &fee_utxo.private_key,
                    &fee_utxo.script_pubkey,
                    fee_utxo.satoshis,
                    DEFAULT_SIGHASH,
                )?;
                Ok(transaction)
            },
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn build_ft_transaction(
        address_from: &str,
        destination: MultiSigDestination,
        ft: &Ft,
        amount_raw: u128,
        funding_utxo: MultiSigUtxo,
        ft_utxos: Vec<FtUtxo>,
        pre_txs: Vec<Transaction>,
        pre_pre_txs_set: Vec<Vec<Transaction>>,
        funding_parent: &Transaction,
        private_key: &PrivateKey,
    ) -> Result<MultiSigUnsignedTx> {
        if amount_raw == 0 {
            return Err(Error::InvalidUtxo(
                "MultiSig FT transfer amount must be greater than zero".to_string(),
            ));
        }
        let source_locking_script = Self::lock_script(address_from)?;
        if funding_utxo.locking_script != source_locking_script {
            return Err(Error::InvalidUtxo(
                "MultiSig FT funding script does not match source address".to_string(),
            ));
        }
        if funding_utxo.satoshis == 0 || funding_utxo.satoshis > MAX_MONEY_SAT {
            return Err(Error::InvalidUtxo(
                "MultiSig FT funding amount is outside consensus MoneyRange".to_string(),
            ));
        }
        let pre_pre_tx_data_set = derive_ft_pre_pre_data(&ft_utxos, &pre_txs, &pre_pre_txs_set)?;
        let context = validate_ft_spend_context(
            ft,
            &ft_utxos,
            &pre_txs,
            &pre_pre_tx_data_set,
            FtCodeReceiver::ContractHash(Self::combine_hash(address_from)?),
            private_key,
        )?;
        validate_multisig_funding_parent(&funding_utxo, funding_parent)?;
        if ft_utxos
            .iter()
            .any(|utxo| utxo.base.outpoint == funding_utxo.outpoint)
        {
            return Err(Error::InvalidUtxo(
                "MultiSig FT funding input duplicates an FT outpoint".to_string(),
            ));
        }
        let (amount_tape, change_tape) =
            build_tape_amount_with_offset(amount_raw, &context.input_balances, 1)?;
        let destination_receiver = match destination {
            MultiSigDestination::P2pkh(address) => FtCodeReceiver::Address(address),
            MultiSigDestination::MultiSig(address) => {
                FtCodeReceiver::ContractHash(Self::combine_hash(&address)?)
            }
        };
        let mut transaction = Transaction::new();
        transaction
            .inputs
            .push(TxIn::new(funding_utxo.outpoint.clone()));
        transaction.inputs.extend(
            ft_utxos
                .iter()
                .map(|utxo| TxIn::new(utxo.base.outpoint.clone())),
        );
        apply_stable_coin_lock_times(&mut transaction, &ft_utxos, &pre_txs, 1, context.is_coin)?;
        transaction.outputs.push(TxOut {
            satoshis: SDK_DUST_SAT,
            script_pubkey: source_locking_script,
        });
        transaction.outputs.push(TxOut {
            satoshis: MULTISIG_FT_CODE_SATOSHIS,
            script_pubkey: transfer_code_script(&context.code_script, destination_receiver)?,
        });
        transaction.outputs.push(TxOut {
            satoshis: FT_TAPE_SATOSHIS,
            script_pubkey: transfer_tape_script(&context.tape_script, &amount_tape)?,
        });
        if amount_raw < context.total_ft {
            transaction.outputs.push(TxOut {
                satoshis: MULTISIG_FT_CODE_SATOSHIS,
                script_pubkey: transfer_code_script(
                    &context.code_script,
                    FtCodeReceiver::ContractHash(Self::combine_hash(address_from)?),
                )?,
            });
            transaction.outputs.push(TxOut {
                satoshis: FT_TAPE_SATOSHIS,
                script_pubkey: transfer_tape_script(&context.tape_script, &change_tape)?,
            });
        }
        validate_output_money_range(&transaction.outputs)?;
        for (offset, ft_utxo) in ft_utxos.iter().enumerate() {
            sign_ft_swap_input(
                &mut transaction,
                offset + 1,
                private_key,
                ft_utxo,
                &pre_txs[offset],
                &pre_pre_tx_data_set[offset],
                funding_parent,
                context.version,
                context.is_coin,
            )?;
        }
        let signature_headroom = ft_utxos
            .len()
            .checked_mul(2)
            .ok_or_else(|| Error::InvalidUtxo("MultiSig FT signed size overflow".to_string()))?;
        let fee = multisig_fee_for_unsigned(address_from, &transaction, &[0], signature_headroom)?;
        let asset_input_sum = ft_utxos.iter().try_fold(0u64, |total, utxo| {
            total
                .checked_add(utxo.base.satoshis)
                .ok_or_else(|| Error::InvalidUtxo("MultiSig FT input amount overflow".to_string()))
        })?;
        let non_change_output_sum =
            transaction.outputs[1..]
                .iter()
                .try_fold(0u64, |total, output| {
                    total.checked_add(output.satoshis).ok_or_else(|| {
                        Error::InvalidUtxo("MultiSig FT output amount overflow".to_string())
                    })
                })?;
        let funding_change = funding_utxo
            .satoshis
            .checked_add(asset_input_sum)
            .and_then(|total| total.checked_sub(non_change_output_sum))
            .and_then(|total| total.checked_sub(fee))
            .ok_or(Error::InsufficientFunds {
                input: funding_utxo.satoshis,
                required: non_change_output_sum.saturating_add(fee),
            })?;
        require_ordinary_output(funding_change)?;
        transaction.outputs[0].satoshis = funding_change;
        for (offset, ft_utxo) in ft_utxos.iter().enumerate() {
            sign_ft_swap_input(
                &mut transaction,
                offset + 1,
                private_key,
                ft_utxo,
                &pre_txs[offset],
                &pre_pre_tx_data_set[offset],
                funding_parent,
                context.version,
                false,
            )?;
        }
        let mut input_amounts = vec![funding_utxo.satoshis];
        input_amounts.extend(ft_utxos.iter().map(|utxo| utxo.base.satoshis));
        validate_money_range(&input_amounts, "MultiSig FT input")?;
        let mut input_parents = Vec::with_capacity(1 + pre_txs.len());
        input_parents.push(funding_parent.clone());
        input_parents.extend(pre_txs);
        MultiSigUnsignedTx::from_ft_parts(transaction, input_parents, address_from.to_string())
    }

    pub fn sign_ft_transaction(
        address_from: &str,
        unsigned: &MultiSigUnsignedTx,
        private_key: &PrivateKey,
    ) -> Result<Vec<Vec<u8>>> {
        validate_unsigned_ft(unsigned)?;
        if address_from != unsigned.source_address
            || Self::lock_script(address_from)? != unsigned.source_locking_script
        {
            return Err(Error::InvalidUtxo(
                "source address does not match unsigned MultiSig FT transaction".to_string(),
            ));
        }
        Ok(vec![unsigned.transaction.signature_with_hashtype(
            0,
            private_key,
            &unsigned.source_locking_script,
            unsigned.input_satoshis[0],
            DEFAULT_SIGHASH,
        )?])
    }

    pub fn batch_sign_ft_transactions(
        address_from: &str,
        transactions: &[MultiSigUnsignedTx],
        private_key: &PrivateKey,
    ) -> Result<Vec<Vec<Vec<u8>>>> {
        transactions
            .iter()
            .map(|transaction| Self::sign_ft_transaction(address_from, transaction, private_key))
            .collect()
    }

    pub fn finish_ft_transaction(
        unsigned: &MultiSigUnsignedTx,
        signatures: &MultiSigInputSignatures,
        public_keys: &[PublicKey],
    ) -> Result<Transaction> {
        validate_unsigned_ft(unsigned)?;
        let transaction = finish_multisig_inputs(unsigned, signatures, public_keys, &[0])?;
        let target = fee_for_size(transaction.serialize().len(), DEFAULT_FEE_RATE_SAT_PER_KB);
        let paid = paid_fee(&transaction, unsigned.total_input_satoshis)?;
        if paid < target {
            return Err(Error::InvalidUtxo(format!(
                "final MultiSig FT fee {paid} is below signed-size target {target}"
            )));
        }
        Ok(transaction)
    }

    pub fn batch_finish_ft_transactions(
        transactions: &[MultiSigUnsignedTx],
        signatures: &[MultiSigInputSignatures],
        public_keys: &[PublicKey],
    ) -> Result<Vec<Transaction>> {
        if transactions.len() != signatures.len() {
            return Err(Error::InvalidUtxo(
                "MultiSig FT transaction and signature batch lengths do not match".to_string(),
            ));
        }
        transactions
            .iter()
            .zip(signatures)
            .map(|(transaction, signatures)| {
                Self::finish_ft_transaction(transaction, signatures, public_keys)
            })
            .collect()
    }
}

fn multisig_fee_for_unsigned(
    address: &str,
    transaction: &Transaction,
    input_indexes: &[usize],
    additional_size: usize,
) -> Result<u64> {
    let info = MultiSig::address_info(address)?;
    let signature_pushes = usize::from(info.required_signatures)
        .checked_mul(1 + MAX_MULTISIG_SIGNATURE_WITH_HASHTYPE_BYTES)
        .ok_or_else(|| Error::InvalidUtxo("MultiSig signed size overflow".to_string()))?;
    let public_key_bytes = usize::from(info.public_key_count)
        .checked_mul(33)
        .ok_or_else(|| Error::InvalidUtxo("MultiSig signed size overflow".to_string()))?;
    let public_key_push_prefix = match public_key_bytes {
        0..=75 => 1,
        76..=255 => 2,
        256..=65_535 => 3,
        _ => 5,
    };
    let script_len = 1usize
        .checked_add(signature_pushes)
        .and_then(|size| size.checked_add(public_key_push_prefix))
        .and_then(|size| size.checked_add(public_key_bytes))
        .ok_or_else(|| Error::InvalidUtxo("MultiSig signed size overflow".to_string()))?;
    let encoded_script_len = compact_size_len(script_len);
    let replacement_size = encoded_script_len
        .checked_add(script_len)
        .ok_or_else(|| Error::InvalidUtxo("MultiSig signed size overflow".to_string()))?;
    let mut final_size = transaction.serialize().len();
    for &input_index in input_indexes {
        let input = transaction.inputs.get(input_index).ok_or_else(|| {
            Error::InvalidUtxo("MultiSig input index is outside transaction".to_string())
        })?;
        let current_script_len = input.script_sig.as_bytes().len();
        let current_encoded_len = compact_size_len(current_script_len);
        final_size = final_size
            .checked_sub(current_encoded_len + current_script_len)
            .and_then(|size| size.checked_add(replacement_size))
            .ok_or_else(|| Error::InvalidUtxo("MultiSig signed size overflow".to_string()))?;
    }
    final_size = final_size
        .checked_add(additional_size)
        .ok_or_else(|| Error::InvalidUtxo("MultiSig signed size overflow".to_string()))?;
    Ok(fee_for_size(final_size, DEFAULT_FEE_RATE_SAT_PER_KB).max(MULTISIG_MINER_FEE_FLOOR_SAT))
}

fn compact_size_len(value: usize) -> usize {
    if value <= 252 {
        1
    } else if value <= 65_535 {
        3
    } else if value <= u32::MAX as usize {
        5
    } else {
        9
    }
}

fn require_ordinary_output(satoshis: u64) -> Result<()> {
    if satoshis < SDK_DUST_SAT {
        return Err(Error::DustOutput(satoshis));
    }
    if satoshis > MAX_MONEY_SAT {
        return Err(Error::InvalidUtxo(
            "output amount exceeds consensus MoneyRange".to_string(),
        ));
    }
    Ok(())
}

struct ValidatedFtSpend {
    input_balances: Vec<u128>,
    total_ft: u128,
    code_script: Script,
    tape_script: Script,
    version: u8,
    is_coin: bool,
}

fn derive_ft_pre_pre_data(
    ft_utxos: &[FtUtxo],
    pre_txs: &[Transaction],
    pre_pre_txs_set: &[Vec<Transaction>],
) -> Result<Vec<Vec<u8>>> {
    if pre_txs.len() != ft_utxos.len() || pre_pre_txs_set.len() != ft_utxos.len() {
        return Err(Error::InvalidUtxo(
            "FT ancestry transaction counts must match FT UTXO length".to_string(),
        ));
    }
    ft_utxos
        .iter()
        .zip(pre_txs)
        .zip(pre_pre_txs_set)
        .enumerate()
        .map(|(index, ((utxo, pre_tx), parents))| {
            pre_pre_tx_data_from_parents(pre_tx, utxo.base.outpoint.vout as usize, parents).map_err(
                |error| {
                    Error::InvalidUtxo(format!(
                        "FT input {index} has invalid grandparent ancestry: {error}"
                    ))
                },
            )
        })
        .collect()
}

fn validate_ft_spend_context(
    ft: &Ft,
    ft_utxos: &[FtUtxo],
    pre_txs: &[Transaction],
    pre_pre_tx_data_set: &[Vec<u8>],
    expected_receiver: FtCodeReceiver,
    private_key: &PrivateKey,
) -> Result<ValidatedFtSpend> {
    if ft_utxos.is_empty() || ft_utxos.len() > 5 {
        return Err(Error::InvalidUtxo(
            "MultiSig FT transactions require between one and five FT inputs".to_string(),
        ));
    }
    if pre_txs.len() != ft_utxos.len() || pre_pre_tx_data_set.len() != ft_utxos.len() {
        return Err(Error::InvalidUtxo(
            "FT ancestry data length must match FT UTXO length".to_string(),
        ));
    }
    if pre_pre_tx_data_set.iter().any(Vec::is_empty) {
        return Err(Error::InvalidUtxo(
            "FT pre-pre transaction data must not be empty".to_string(),
        ));
    }
    let code_script = Script::from_bytes(hex::decode(&ft.code_script)?);
    let tape_script = Script::from_bytes(hex::decode(&ft.tape_script)?);
    let script_info = classify_ft_script(&code_script)?;
    let expected_script = transfer_code_script(&code_script, expected_receiver)?;
    let mut outpoints = Vec::with_capacity(ft_utxos.len());
    let mut input_satoshis = Vec::with_capacity(ft_utxos.len());
    let mut input_balances = Vec::with_capacity(ft_utxos.len());
    for (index, ((utxo, pre_tx), pre_pre_data)) in ft_utxos
        .iter()
        .zip(pre_txs)
        .zip(pre_pre_tx_data_set)
        .enumerate()
    {
        if utxo.ft_balance_raw == 0 {
            return Err(Error::InvalidUtxo(format!(
                "FT input {index} has zero token balance"
            )));
        }
        if utxo.base.satoshis == 0 {
            return Err(Error::InvalidUtxo(format!(
                "FT input {index} has zero satoshis"
            )));
        }
        if utxo.base.private_key.public_key() != private_key.public_key() {
            return Err(Error::InvalidUtxo(format!(
                "FT input {index} signing key does not match the supplied owner key"
            )));
        }
        if utxo.base.script_pubkey != expected_script {
            return Err(Error::InvalidUtxo(format!(
                "FT input {index} code script does not match its expected owner or contract"
            )));
        }
        let input_info = classify_ft_script(&utxo.base.script_pubkey)?;
        if input_info != script_info {
            return Err(Error::InvalidUtxo(format!(
                "FT input {index} code version does not match FT metadata"
            )));
        }
        if outpoints.contains(&utxo.base.outpoint) {
            return Err(Error::InvalidUtxo(format!(
                "FT input {index} duplicates an earlier outpoint"
            )));
        }
        outpoints.push(utxo.base.outpoint.clone());
        if pre_tx.txid() != utxo.base.outpoint.txid {
            return Err(Error::InvalidUtxo(format!(
                "FT input {index} parent transaction id does not match its outpoint"
            )));
        }
        let vout = utxo.base.outpoint.vout as usize;
        let parent_output = pre_tx.outputs.get(vout).ok_or_else(|| {
            Error::InvalidUtxo(format!("FT input {index} parent vout is out of range"))
        })?;
        if parent_output.satoshis != utxo.base.satoshis
            || parent_output.script_pubkey != utxo.base.script_pubkey
        {
            return Err(Error::InvalidUtxo(format!(
                "FT input {index} does not match its parent output"
            )));
        }
        let parent_tape = pre_tx.outputs.get(vout + 1).ok_or_else(|| {
            Error::InvalidUtxo(format!("FT input {index} parent is missing adjacent tape"))
        })?;
        if balance_from_tape(&parent_tape.script_pubkey)? != utxo.ft_balance_raw {
            return Err(Error::InvalidUtxo(format!(
                "FT input {index} balance does not match its parent tape"
            )));
        }
        if pre_pre_data.is_empty() {
            return Err(Error::InvalidUtxo(format!(
                "FT input {index} pre-pre transaction data is empty"
            )));
        }
        input_satoshis.push(utxo.base.satoshis);
        input_balances.push(utxo.ft_balance_raw);
    }
    validate_money_range(&input_satoshis, "FT input")?;
    let total_ft = input_balances.iter().try_fold(0u128, |sum, amount| {
        sum.checked_add(*amount)
            .ok_or_else(|| Error::InvalidUtxo("FT amount overflow".to_string()))
    })?;
    Ok(ValidatedFtSpend {
        input_balances,
        total_ft,
        code_script,
        tape_script,
        version: script_info.version,
        is_coin: script_info.is_coin,
    })
}

fn apply_stable_coin_lock_times(
    transaction: &mut Transaction,
    ft_utxos: &[FtUtxo],
    pre_txs: &[Transaction],
    input_offset: usize,
    is_coin: bool,
) -> Result<()> {
    if !is_coin {
        return Ok(());
    }
    let mut lock_time = transaction.lock_time;
    for (index, (utxo, pre_tx)) in ft_utxos.iter().zip(pre_txs).enumerate() {
        let tape = pre_tx
            .outputs
            .get(utxo.base.outpoint.vout as usize + 1)
            .ok_or_else(|| {
                Error::InvalidUtxo(format!(
                    "StableCoin input {index} is missing its adjacent Tape"
                ))
            })?;
        transaction.inputs[input_offset + index].sequence = COIN_FT_SEQUENCE;
        lock_time = lock_time.max(get_lock_time_from_tape(&tape.script_pubkey)?);
    }
    transaction.lock_time = lock_time;
    Ok(())
}

fn reject_duplicate_ft_outpoints(ft_utxos: &[FtUtxo], funding: &crate::OutPoint) -> Result<()> {
    if ft_utxos.iter().any(|utxo| &utxo.base.outpoint == funding) {
        return Err(Error::InvalidUtxo(
            "funding input duplicates an FT outpoint".to_string(),
        ));
    }
    Ok(())
}

fn validate_multisig_funding_parent(
    funding_utxo: &MultiSigUtxo,
    funding_parent: &Transaction,
) -> Result<()> {
    if funding_parent.txid() != funding_utxo.outpoint.txid {
        return Err(Error::InvalidUtxo(
            "MultiSig funding parent transaction id does not match its outpoint".to_string(),
        ));
    }
    let parent_output = funding_parent
        .outputs
        .get(funding_utxo.outpoint.vout as usize)
        .ok_or_else(|| {
            Error::InvalidUtxo("MultiSig funding parent vout is out of range".to_string())
        })?;
    if parent_output.satoshis != funding_utxo.satoshis
        || parent_output.script_pubkey != funding_utxo.locking_script
    {
        return Err(Error::InvalidUtxo(
            "MultiSig funding UTXO does not match its parent output".to_string(),
        ));
    }
    Ok(())
}

fn finish_multisig_inputs(
    unsigned: &MultiSigUnsignedTx,
    signatures: &MultiSigInputSignatures,
    public_keys: &[PublicKey],
    input_indexes: &[usize],
) -> Result<Transaction> {
    if signatures.len() != input_indexes.len() {
        return Err(Error::InvalidUtxo(format!(
            "signature input count {} does not match required count {}",
            signatures.len(),
            input_indexes.len()
        )));
    }
    let source = decode_address(&unsigned.source_address)?;
    let required = source.info.required_signatures;
    let canonical_bytes = canonical_public_keys(public_keys, required)?;
    if canonical_bytes.len() != source.info.public_key_count as usize
        || !MultiSig::verify_address(public_keys, &unsigned.source_address)?
    {
        return Err(Error::InvalidUtxo(
            "public keys do not match source address".to_string(),
        ));
    }
    let canonical_keys = canonical_bytes
        .iter()
        .map(|bytes| PublicKey::from_slice(bytes))
        .collect::<Result<Vec<_>>>()?;
    let mut transaction = unsigned.transaction.clone();
    for (signature_index, input_index) in input_indexes.iter().copied().enumerate() {
        let input_signatures = &signatures[signature_index];
        if input_signatures.len() != required as usize {
            return Err(Error::InvalidUtxo(format!(
                "input {input_index} requires exactly {required} signatures"
            )));
        }
        let satoshis = match unsigned.kind {
            MultiSigUnsignedKind::Tbc => unsigned.input_satoshis[input_index],
            MultiSigUnsignedKind::Ft if input_index == 0 => unsigned.input_satoshis[0],
            MultiSigUnsignedKind::Ft => {
                return Err(Error::InvalidUtxo(
                    "only input 0 is a MultiSig input in an FT transaction".to_string(),
                ));
            }
        };
        let digest = unsigned.transaction.sighash_digest(
            input_index,
            &unsigned.source_locking_script,
            satoshis,
            DEFAULT_SIGHASH,
        )?;
        let mut matched = Vec::with_capacity(required as usize);
        let mut used_keys = vec![false; canonical_keys.len()];
        for (signer_index, signature) in input_signatures.iter().enumerate() {
            let (&hash_type, der) = signature.split_last().ok_or_else(|| {
                Error::InvalidUtxo(format!(
                    "input {input_index} signer {signer_index} has an empty signature"
                ))
            })?;
            if hash_type != DEFAULT_SIGHASH as u8 || der.is_empty() {
                return Err(Error::InvalidUtxo(format!(
                    "input {input_index} signer {signer_index} has invalid sighash type"
                )));
            }
            let mut matching_key = None;
            for (key_index, public_key) in canonical_keys.iter().enumerate() {
                let verifies = public_key.verify_ecdsa_digest(&digest, der).map_err(|_| {
                    Error::InvalidUtxo(format!(
                        "input {input_index} signer {signer_index} has malformed DER"
                    ))
                })?;
                if verifies {
                    if matching_key.is_some() {
                        return Err(Error::InvalidUtxo(format!(
                            "input {input_index} signer {signer_index} matches multiple keys"
                        )));
                    }
                    matching_key = Some(key_index);
                }
            }
            let key_index = matching_key.ok_or_else(|| {
                Error::InvalidUtxo(format!(
                    "input {input_index} signer {signer_index} does not match a public key"
                ))
            })?;
            if used_keys[key_index] {
                return Err(Error::InvalidUtxo(format!(
                    "input {input_index} contains a duplicate signer"
                )));
            }
            used_keys[key_index] = true;
            matched.push((key_index, signature.clone()));
        }
        matched.sort_by_key(|(key_index, _)| *key_index);
        let mut unlocking_script = Script::empty();
        unlocking_script.push_data(&[]);
        for (_, signature) in matched {
            unlocking_script.push_data(&signature);
        }
        let concatenated_keys = canonical_bytes
            .iter()
            .flat_map(|public_key| public_key.iter().copied())
            .collect::<Vec<_>>();
        unlocking_script.push_data(&concatenated_keys);
        transaction.inputs[input_index].script_sig = unlocking_script;
    }
    Ok(transaction)
}

fn validate_p2pkh_utxos(address_from: &Address, utxos: &[Utxo]) -> Result<()> {
    if utxos.is_empty() {
        return Err(Error::InvalidUtxo(
            "at least one P2PKH UTXO is required".to_string(),
        ));
    }
    let expected_script = address_from.script_pubkey();
    let mut outpoints = Vec::new();
    for (index, utxo) in utxos.iter().enumerate() {
        if utxo.satoshis == 0 {
            return Err(Error::InvalidUtxo(format!(
                "P2PKH input {index} has zero satoshis"
            )));
        }
        if utxo.satoshis > MAX_MONEY_SAT {
            return Err(Error::InvalidUtxo(format!(
                "P2PKH input {index} exceeds consensus MoneyRange"
            )));
        }
        if utxo.outpoint.vout == u32::MAX
            && utxo
                .outpoint
                .txid
                .as_le_bytes()
                .iter()
                .all(|byte| *byte == 0)
        {
            return Err(Error::InvalidUtxo(format!(
                "P2PKH input {index} contains a null previous output"
            )));
        }
        if utxo.script_pubkey != expected_script || utxo.private_key.address() != *address_from {
            return Err(Error::InvalidUtxo(format!(
                "P2PKH input {index} does not match source address"
            )));
        }
        if outpoints.contains(&utxo.outpoint) {
            return Err(Error::InvalidUtxo(format!(
                "P2PKH input {index} duplicates an earlier outpoint"
            )));
        }
        outpoints.push(utxo.outpoint.clone());
    }
    Ok(())
}

fn sum_p2pkh_inputs(utxos: &[Utxo]) -> Result<u64> {
    sum_amounts(
        &utxos.iter().map(|utxo| utxo.satoshis).collect::<Vec<_>>(),
        "P2PKH input amount overflow",
    )
}

fn sum_amounts(amounts: &[u64], message: &str) -> Result<u64> {
    validate_money_range(amounts, message)
}

fn finalize_p2pkh_transaction(
    address_from: &Address,
    utxos: &[Utxo],
    outputs: Vec<TxOut>,
    input_sum: u64,
    non_change_sum: u64,
) -> Result<Transaction> {
    validate_output_money_range(&outputs)?;
    let transaction = finalize_signed_fee(
        input_sum,
        non_change_sum,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        ChangePolicy::Optional { dust: SDK_DUST_SAT },
        |change| {
            let mut transaction = Transaction::new();
            transaction
                .inputs
                .extend(utxos.iter().map(|utxo| TxIn::new(utxo.outpoint.clone())));
            transaction.outputs.extend(outputs.iter().cloned());
            if let Some(satoshis) = change {
                transaction.outputs.push(TxOut {
                    satoshis,
                    script_pubkey: address_from.script_pubkey(),
                });
            }
            for (input_index, utxo) in utxos.iter().enumerate() {
                transaction.sign_p2pkh_input(
                    input_index,
                    &utxo.private_key,
                    &utxo.script_pubkey,
                    utxo.satoshis,
                    DEFAULT_SIGHASH,
                )?;
            }
            Ok(transaction)
        },
    )?;
    validate_output_money_range(&transaction.outputs)?;
    Ok(transaction)
}

fn validate_unsigned(unsigned: &MultiSigUnsignedTx) -> Result<()> {
    if unsigned.kind != MultiSigUnsignedKind::Tbc {
        return Err(Error::InvalidUtxo(
            "MultiSig FT transaction cannot be used with TBC signing APIs".to_string(),
        ));
    }
    validate_unsigned_transaction(&unsigned.transaction, &unsigned.input_satoshis)?;
    if unsigned.input_satoshis != unsigned.source_input_satoshis {
        return Err(Error::InvalidUtxo(
            "input amount vector does not match unsigned transaction".to_string(),
        ));
    }
    if unsigned.transaction.serialize() != unsigned.source_transaction {
        return Err(Error::InvalidUtxo(
            "unsigned MultiSig transaction changed after construction".to_string(),
        ));
    }
    if MultiSig::lock_script(&unsigned.source_address)? != unsigned.source_locking_script {
        return Err(Error::InvalidUtxo(
            "source locking script does not match source address".to_string(),
        ));
    }
    if unsigned.total_input_satoshis
        != validate_money_range(&unsigned.input_satoshis, "MultiSig input")?
    {
        return Err(Error::InvalidUtxo(
            "total input amount does not match unsigned transaction".to_string(),
        ));
    }
    Ok(())
}

fn validate_unsigned_ft(unsigned: &MultiSigUnsignedTx) -> Result<()> {
    if unsigned.kind != MultiSigUnsignedKind::Ft {
        return Err(Error::InvalidUtxo(
            "MultiSig TBC transaction cannot be used with FT signing APIs".to_string(),
        ));
    }
    validate_unsigned_ft_transaction(
        &unsigned.transaction,
        &unsigned.input_satoshis,
        unsigned.total_input_satoshis,
    )?;
    if unsigned.input_satoshis != unsigned.source_input_satoshis {
        return Err(Error::InvalidUtxo(
            "FT funding amount does not match unsigned transaction".to_string(),
        ));
    }
    if unsigned.transaction.serialize() != unsigned.source_transaction {
        return Err(Error::InvalidUtxo(
            "unsigned MultiSig FT transaction changed after construction".to_string(),
        ));
    }
    if MultiSig::lock_script(&unsigned.source_address)? != unsigned.source_locking_script {
        return Err(Error::InvalidUtxo(
            "source locking script does not match source address".to_string(),
        ));
    }
    Ok(())
}

fn validate_output_money_range(outputs: &[TxOut]) -> Result<()> {
    validate_money_range(
        &outputs
            .iter()
            .map(|output| output.satoshis)
            .collect::<Vec<_>>(),
        "transaction output",
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::{
        Address, DEFAULT_FEE_RATE_SAT_PER_KB, DEFAULT_SIGHASH, OutPoint, PrivateKey, PublicKey,
        SDK_DUST_SAT, TX_VERSION, Transaction, TxIn, TxOut, Txid, Utxo,
        builder::fee_for_size,
        contracts::{
            ft::{
                Ft, FtUtxo,
                scripts::{
                    FT_TAPE_SATOSHIS, FtCodeReceiver, mint_tape_script, transfer_code_script,
                },
                unlock::pre_pre_tx_data_from_parents,
            },
            multisig::{
                MultiSig, MultiSigDestination, MultiSigInputSignatures, MultiSigUnsignedTx,
                MultiSigUtxo,
            },
            stable_coin::scripts::{
                COIN_FT_SEQUENCE, amount_slot, coin_mint_code_script, coin_tape_script,
            },
        },
        script::Script,
    };

    const MAX_MONEY_SAT: u64 = 21_000_000 * 100_000_000;

    struct Fixture {
        owner: PrivateKey,
        private_keys: Vec<PrivateKey>,
        public_keys: Vec<PublicKey>,
        address: String,
    }

    impl Fixture {
        fn two_of_three() -> Self {
            let owner = PrivateKey::from_slice(&[9u8; 32]).unwrap();
            let mut pairs = [[1u8; 32], [2u8; 32], [3u8; 32]]
                .into_iter()
                .map(|bytes| {
                    let private_key = PrivateKey::from_slice(&bytes).unwrap();
                    (private_key.public_key().to_bytes(), private_key)
                })
                .collect::<Vec<_>>();
            pairs.sort_by_key(|(public_key, _)| *public_key);
            let private_keys = pairs
                .iter()
                .map(|(_, private_key)| private_key.clone())
                .collect::<Vec<_>>();
            let public_keys = private_keys
                .iter()
                .map(PrivateKey::public_key)
                .collect::<Vec<_>>();
            let address = MultiSig::address(&public_keys, 2).unwrap();
            Self {
                owner,
                private_keys,
                public_keys,
                address,
            }
        }

        fn p2pkh_utxo(&self, seed: u8, satoshis: u64) -> Utxo {
            Utxo {
                outpoint: outpoint(seed),
                satoshis,
                script_pubkey: self.owner.address().script_pubkey(),
                private_key: self.owner.clone(),
            }
        }

        fn multisig_utxo(&self, seed: u8, satoshis: u64) -> MultiSigUtxo {
            MultiSigUtxo {
                outpoint: outpoint(seed),
                satoshis,
                locking_script: MultiSig::lock_script(&self.address).unwrap(),
            }
        }

        fn sign_tbc(
            &self,
            unsigned: &MultiSigUnsignedTx,
            signer_indexes: &[usize],
        ) -> MultiSigInputSignatures {
            let by_signer = signer_indexes
                .iter()
                .map(|index| {
                    MultiSig::sign_tbc_transaction(
                        &self.address,
                        unsigned,
                        &self.private_keys[*index],
                    )
                    .unwrap()
                })
                .collect::<Vec<_>>();
            (0..unsigned.transaction.inputs.len())
                .map(|input_index| {
                    by_signer
                        .iter()
                        .map(|signatures| signatures[input_index].clone())
                        .collect()
                })
                .collect()
        }

        fn concat_public_keys(&self) -> Vec<u8> {
            self.public_keys
                .iter()
                .flat_map(PublicKey::to_bytes)
                .collect()
        }

        fn sign_ft(
            &self,
            unsigned: &MultiSigUnsignedTx,
            signer_indexes: &[usize],
        ) -> MultiSigInputSignatures {
            vec![
                signer_indexes
                    .iter()
                    .map(|index| {
                        MultiSig::sign_ft_transaction(
                            &self.address,
                            unsigned,
                            &self.private_keys[*index],
                        )
                        .unwrap()[0]
                            .clone()
                    })
                    .collect(),
            ]
        }
    }

    fn outpoint(seed: u8) -> OutPoint {
        OutPoint {
            txid: Txid::from_le_bytes([seed; 32]),
            vout: seed as u32,
        }
    }

    fn portable_transaction(output_satoshis: u64) -> Transaction {
        let mut transaction = Transaction::new();
        transaction.inputs.push(TxIn::new(outpoint(30)));
        transaction.outputs.push(TxOut {
            satoshis: output_satoshis,
            script_pubkey: Script::empty(),
        });
        transaction
    }

    fn paid_fee(tx: &Transaction, input_sum: u64) -> u64 {
        input_sum - tx.outputs.iter().map(|output| output.satoshis).sum::<u64>()
    }

    fn assert_target_fee(tx: &Transaction, input_sum: u64) {
        let target = fee_for_size(tx.serialize().len(), DEFAULT_FEE_RATE_SAT_PER_KB);
        assert!(
            paid_fee(tx, input_sum) >= target,
            "bytes={} paid={} target={target}",
            tx.serialize().len(),
            paid_fee(tx, input_sum)
        );
    }

    fn expected_unlock(signatures: &[Vec<u8>], public_keys: &[PublicKey]) -> Script {
        let mut script = Script::empty();
        script.push_data(&[]);
        for signature in signatures {
            script.push_data(signature);
        }
        let concatenated = public_keys
            .iter()
            .flat_map(PublicKey::to_bytes)
            .collect::<Vec<_>>();
        script.push_data(&concatenated);
        script
    }

    fn synthetic_ft_code(version: u8, receiver: FtCodeReceiver) -> Script {
        let (length, fill_opcode) = match version {
            1 => (1_564, 0x60),
            2 => (1_884, 0x60),
            3 => (1_884, 0x5f),
            _ => panic!("unsupported test FT version"),
        };
        let mut suffix = vec![fill_opcode, 0x61, 0x61, 0x15];
        suffix.extend_from_slice(&[0x22; 21]);
        suffix.push(0x05);
        suffix.extend_from_slice(b"2Code");
        let mut bytes = vec![0x61; length - suffix.len()];
        bytes.extend_from_slice(&suffix);
        transfer_code_script(&Script::from_bytes(bytes), receiver).unwrap()
    }

    fn ft_context(
        version: u8,
        private_key: &PrivateKey,
        receiver: FtCodeReceiver,
        balance: u64,
        code_satoshis: u64,
    ) -> (Ft, FtUtxo, Transaction, Vec<Transaction>, Transaction) {
        let code = synthetic_ft_code(version, receiver);
        let mut amount = [0u8; 48];
        amount[..8].copy_from_slice(&balance.to_le_bytes());
        let tape = mint_tape_script(&amount, 0, "MultiSig", "MS");
        let mut grandparent = Transaction::new();
        grandparent.outputs.push(TxOut {
            satoshis: 1,
            script_pubkey: Script::from_bytes(vec![0x51]),
        });
        let mut pre_tx = Transaction::new();
        pre_tx.inputs.push(TxIn::new(OutPoint {
            txid: grandparent.txid(),
            vout: 0,
        }));
        pre_tx.outputs.push(TxOut {
            satoshis: code_satoshis,
            script_pubkey: code.clone(),
        });
        pre_tx.outputs.push(TxOut {
            satoshis: FT_TAPE_SATOSHIS,
            script_pubkey: tape.clone(),
        });
        let mut contract_tx = Transaction::new();
        contract_tx.outputs.push(TxOut {
            satoshis: code_satoshis,
            script_pubkey: code.clone(),
        });
        contract_tx.outputs.push(TxOut {
            satoshis: 0,
            script_pubkey: tape.clone(),
        });
        let ft = Ft {
            name: "MultiSig".to_string(),
            symbol: "MS".to_string(),
            decimal: 0,
            total_supply_raw: balance as u128,
            code_script: hex::encode(code.as_bytes()),
            tape_script: hex::encode(tape.as_bytes()),
            contract_txid: contract_tx.txid().to_string(),
        };
        let ft_utxo = FtUtxo {
            base: Utxo {
                outpoint: OutPoint {
                    txid: pre_tx.txid(),
                    vout: 0,
                },
                satoshis: code_satoshis,
                script_pubkey: code,
                private_key: private_key.clone(),
            },
            ft_balance_raw: balance as u128,
        };
        (ft, ft_utxo, pre_tx, vec![grandparent], contract_tx)
    }

    fn stable_coin_context(
        private_key: &PrivateKey,
        balance: u64,
        lock_time: u32,
    ) -> (Ft, FtUtxo, Transaction, Vec<Transaction>) {
        let amount = amount_slot(balance as u128).unwrap();
        let tape = coin_tape_script(&amount, 6, "MultiSig Coin", "MSC", lock_time);
        let code = coin_mint_code_script(
            &private_key.address().hash160(),
            &private_key.address(),
            &[0x44; 32],
            tape.as_bytes().len(),
        )
        .unwrap();
        let mut grandparent = Transaction::new();
        grandparent.outputs.push(TxOut {
            satoshis: 1,
            script_pubkey: Script::from_bytes(vec![0x51]),
        });
        let mut pre_tx = Transaction::new();
        pre_tx.inputs.push(TxIn::new(OutPoint {
            txid: grandparent.txid(),
            vout: 0,
        }));
        pre_tx.outputs.push(TxOut {
            satoshis: 2_000,
            script_pubkey: code.clone(),
        });
        pre_tx.outputs.push(TxOut {
            satoshis: 0,
            script_pubkey: tape.clone(),
        });
        let ft = Ft {
            name: "MultiSig Coin".to_string(),
            symbol: "MSC".to_string(),
            decimal: 6,
            total_supply_raw: balance as u128,
            code_script: hex::encode(code.as_bytes()),
            tape_script: hex::encode(tape.as_bytes()),
            contract_txid: "55".repeat(32),
        };
        let ft_utxo = FtUtxo {
            base: Utxo {
                outpoint: OutPoint {
                    txid: pre_tx.txid(),
                    vout: 0,
                },
                satoshis: 2_000,
                script_pubkey: code,
                private_key: private_key.clone(),
            },
            ft_balance_raw: balance as u128,
        };
        (ft, ft_utxo, pre_tx, vec![grandparent])
    }

    #[test]
    fn multisig_stable_coin_deposit_applies_lock_time_and_sequence() {
        let fixture = Fixture::two_of_three();
        let (coin, coin_utxo, pre_tx, grandparents) =
            stable_coin_context(&fixture.owner, 1_000, 500_000_321);
        let tx = MultiSig::p2pkh_to_multisig_ft(
            &fixture.owner.address(),
            &fixture.address,
            &coin,
            400,
            vec![coin_utxo],
            fixture.p2pkh_utxo(99, 50_000),
            vec![pre_tx],
            vec![grandparents],
            &fixture.owner,
            None,
        )
        .unwrap();

        assert_eq!(tx.lock_time, 500_000_321);
        assert_eq!(tx.inputs[0].sequence, COIN_FT_SEQUENCE);
        assert_eq!(tx.inputs[1].sequence, crate::DEFAULT_SEQUENCE);
    }

    #[test]
    fn multisig_stable_coin_spend_applies_lock_time_after_funding_input() {
        let fixture = Fixture::two_of_three();
        let (coin, mut coin_utxo, mut pre_tx, grandparents) =
            stable_coin_context(&fixture.owner, 1_000, 500_000_654);
        let held = transfer_code_script(
            &Script::from_bytes(hex::decode(&coin.code_script).unwrap()),
            FtCodeReceiver::ContractHash(MultiSig::combine_hash(&fixture.address).unwrap()),
        )
        .unwrap();
        pre_tx.outputs[0].script_pubkey = held.clone();
        coin_utxo.base.script_pubkey = held;
        coin_utxo.base.outpoint.txid = pre_tx.txid();
        let (funding, funding_parent) = multisig_funding_context(&fixture, 98, 20_000);

        let unsigned = MultiSig::build_ft_transaction(
            &fixture.address,
            MultiSigDestination::P2pkh(fixture.owner.address()),
            &coin,
            400,
            funding,
            vec![coin_utxo],
            vec![pre_tx],
            vec![grandparents],
            &funding_parent,
            &fixture.owner,
        )
        .unwrap();

        assert_eq!(unsigned.transaction.lock_time, 500_000_654);
        assert_eq!(
            unsigned.transaction.inputs[0].sequence,
            crate::DEFAULT_SEQUENCE
        );
        assert_eq!(unsigned.transaction.inputs[1].sequence, COIN_FT_SEQUENCE);
    }

    fn multisig_funding(fixture: &Fixture, seed: u8, satoshis: u64) -> MultiSigUtxo {
        multisig_funding_context(fixture, seed, satoshis).0
    }

    fn multisig_funding_context(
        fixture: &Fixture,
        seed: u8,
        satoshis: u64,
    ) -> (MultiSigUtxo, Transaction) {
        let locking_script = MultiSig::lock_script(&fixture.address).unwrap();
        let mut parent = Transaction::new();
        parent.lock_time = seed as u32;
        parent.outputs.push(TxOut {
            satoshis,
            script_pubkey: locking_script.clone(),
        });
        (
            MultiSigUtxo {
                outpoint: OutPoint {
                    txid: parent.txid(),
                    vout: 0,
                },
                satoshis,
                locking_script,
            },
            parent,
        )
    }

    #[test]
    fn tbc_create_wallet_builds_js_outputs_and_converged_signed_fee() {
        let fixture = Fixture::two_of_three();
        let tx = MultiSig::create_wallet(
            &fixture.owner.address(),
            &fixture.public_keys,
            2,
            20_000,
            vec![fixture.p2pkh_utxo(1, 50_000)],
        )
        .unwrap();

        assert_eq!(tx.outputs.len(), 6);
        assert_eq!(tx.outputs[0].satoshis, 20_000);
        assert_eq!(
            tx.outputs[0].script_pubkey,
            MultiSig::lock_script(&fixture.address).unwrap()
        );
        for (output, public_key) in tx.outputs[1..4].iter().zip(&fixture.public_keys) {
            assert_eq!(output.satoshis, 200);
            assert!(output.script_pubkey.as_bytes().ends_with(b"multisig"));
            assert_eq!(
                &output.script_pubkey.as_bytes()[3..23],
                public_key.hash160().as_slice()
            );
        }
        assert_eq!(tx.outputs[4].satoshis, 0);
        assert!(tx.outputs[4].script_pubkey.as_bytes().ends_with(b"MTape"));
        assert_eq!(
            tx.outputs[5].script_pubkey,
            fixture.owner.address().script_pubkey()
        );
        assert_target_fee(&tx, 50_000);
    }

    #[test]
    fn tbc_p2pkh_deposit_builds_multisig_output_and_converged_signed_fee() {
        let fixture = Fixture::two_of_three();
        let tx = MultiSig::p2pkh_to_multisig_tbc(
            &fixture.owner.address(),
            &fixture.address,
            10_000,
            vec![fixture.p2pkh_utxo(2, 30_000)],
        )
        .unwrap();

        assert_eq!(tx.outputs[0].satoshis, 10_000);
        assert_eq!(
            tx.outputs[0].script_pubkey,
            MultiSig::lock_script(&fixture.address).unwrap()
        );
        assert_eq!(
            tx.outputs[1].script_pubkey,
            fixture.owner.address().script_pubkey()
        );
        assert_target_fee(&tx, 30_000);
    }

    #[test]
    fn tbc_build_sign_finish_supports_p2pkh_and_multisig_destinations() {
        let fixture = Fixture::two_of_three();
        let recipient = PrivateKey::from_slice(&[8u8; 32]).unwrap().address();
        let unsigned = MultiSig::build_tbc_transaction(
            &fixture.address,
            MultiSigDestination::P2pkh(recipient.clone()),
            10_000,
            vec![fixture.multisig_utxo(3, 30_000)],
        )
        .unwrap();
        assert_eq!(unsigned.input_satoshis, vec![30_000]);
        assert_eq!(unsigned.transaction.outputs[0].satoshis, 19_000);
        assert_eq!(unsigned.transaction.outputs[1].satoshis, 10_000);
        assert_eq!(
            unsigned.transaction.outputs[1].script_pubkey,
            recipient.script_pubkey()
        );

        let collected = fixture.sign_tbc(&unsigned, &[1, 0]);
        let finished =
            MultiSig::finish_tbc_transaction(&unsigned, &collected, &fixture.public_keys).unwrap();
        let canonical_signatures = fixture.sign_tbc(&unsigned, &[0, 1]);
        assert_eq!(
            finished.inputs[0].script_sig,
            expected_unlock(&canonical_signatures[0], &fixture.public_keys)
        );
        assert!(
            finished.inputs[0]
                .script_sig
                .as_bytes()
                .ends_with(&fixture.concat_public_keys())
        );
        assert_target_fee(&finished, 30_000);

        let second = Fixture::two_of_three();
        let destination_keys = [[4u8; 32], [5u8; 32], [6u8; 32]]
            .into_iter()
            .map(|bytes| PrivateKey::from_slice(&bytes).unwrap().public_key())
            .collect::<Vec<_>>();
        let destination = MultiSig::address(&destination_keys, 2).unwrap();
        let unsigned_to_multisig = MultiSig::build_tbc_transaction(
            &second.address,
            MultiSigDestination::MultiSig(destination.clone()),
            10_000,
            vec![second.multisig_utxo(4, 30_000)],
        )
        .unwrap();
        assert_eq!(
            unsigned_to_multisig.transaction.outputs[1].script_pubkey,
            MultiSig::lock_script(&destination).unwrap()
        );
        let signatures = second.sign_tbc(&unsigned_to_multisig, &[0, 2]);
        MultiSig::finish_tbc_transaction(&unsigned_to_multisig, &signatures, &second.public_keys)
            .unwrap();

        let transported = MultiSigUnsignedTx::from_parts(
            Transaction::from_hex(&unsigned.transaction.to_hex()).unwrap(),
            unsigned.input_satoshis.clone(),
            unsigned.source_address.clone(),
        )
        .unwrap();
        let transported_signatures = fixture.sign_tbc(&transported, &[0, 2]);
        MultiSig::finish_tbc_transaction(
            &transported,
            &transported_signatures,
            &fixture.public_keys,
        )
        .unwrap();
    }

    #[test]
    fn tbc_finish_rejects_bad_signature_sets_and_amount_metadata() {
        let fixture = Fixture::two_of_three();
        let unsigned = MultiSig::build_tbc_transaction(
            &fixture.address,
            MultiSigDestination::P2pkh(fixture.owner.address()),
            10_000,
            vec![fixture.multisig_utxo(5, 30_000)],
        )
        .unwrap();
        let valid = fixture.sign_tbc(&unsigned, &[0, 1]);

        let one_signature = vec![vec![valid[0][0].clone()]];
        assert!(
            MultiSig::finish_tbc_transaction(&unsigned, &one_signature, &fixture.public_keys)
                .is_err()
        );

        let duplicate = vec![vec![valid[0][0].clone(), valid[0][0].clone()]];
        assert!(
            MultiSig::finish_tbc_transaction(&unsigned, &duplicate, &fixture.public_keys).is_err()
        );

        let outsider = PrivateKey::from_slice(&[7u8; 32]).unwrap();
        let outsider_signatures =
            MultiSig::sign_tbc_transaction(&fixture.address, &unsigned, &outsider).unwrap();
        let unknown = vec![vec![valid[0][0].clone(), outsider_signatures[0].clone()]];
        assert!(
            MultiSig::finish_tbc_transaction(&unsigned, &unknown, &fixture.public_keys).is_err()
        );

        let malformed = vec![vec![valid[0][0].clone(), vec![0x30, 0x01, 0x00, 0x41]]];
        assert!(
            MultiSig::finish_tbc_transaction(&unsigned, &malformed, &fixture.public_keys).is_err()
        );

        let mut bad_hashtype = valid.clone();
        *bad_hashtype[0][1].last_mut().unwrap() = 0x01;
        assert!(
            MultiSig::finish_tbc_transaction(&unsigned, &bad_hashtype, &fixture.public_keys)
                .is_err()
        );

        let surplus = fixture.sign_tbc(&unsigned, &[0, 1, 2]);
        assert!(
            MultiSig::finish_tbc_transaction(&unsigned, &surplus, &fixture.public_keys).is_err()
        );

        let mut bad_amounts = unsigned.clone();
        bad_amounts.input_satoshis.clear();
        assert!(
            MultiSig::sign_tbc_transaction(
                &fixture.address,
                &bad_amounts,
                &fixture.private_keys[0]
            )
            .is_err()
        );
        assert!(
            MultiSig::finish_tbc_transaction(&bad_amounts, &valid, &fixture.public_keys).is_err()
        );
    }

    #[test]
    fn tbc_build_and_sign_reject_wrong_source_or_locking_script() {
        let fixture = Fixture::two_of_three();
        let wrong_lock = MultiSigUtxo {
            outpoint: outpoint(6),
            satoshis: 30_000,
            locking_script: fixture.owner.address().script_pubkey(),
        };
        assert!(
            MultiSig::build_tbc_transaction(
                &fixture.address,
                MultiSigDestination::P2pkh(fixture.owner.address()),
                10_000,
                vec![wrong_lock],
            )
            .is_err()
        );

        let unsigned = MultiSig::build_tbc_transaction(
            &fixture.address,
            MultiSigDestination::P2pkh(fixture.owner.address()),
            10_000,
            vec![fixture.multisig_utxo(7, 30_000)],
        )
        .unwrap();
        let other_keys = [[4u8; 32], [5u8; 32], [6u8; 32]]
            .into_iter()
            .map(|bytes| PrivateKey::from_slice(&bytes).unwrap().public_key())
            .collect::<Vec<_>>();
        let other_address = MultiSig::address(&other_keys, 2).unwrap();
        assert!(
            MultiSig::sign_tbc_transaction(&other_address, &unsigned, &fixture.private_keys[0])
                .is_err()
        );
    }

    #[test]
    fn tbc_build_omits_zero_or_dust_change_and_rejects_invalid_amounts() {
        let fixture = Fixture::two_of_three();
        for extra in [0, SDK_DUST_SAT - 1] {
            let unsigned = MultiSig::build_tbc_transaction(
                &fixture.address,
                MultiSigDestination::P2pkh(fixture.owner.address()),
                10_000,
                vec![fixture.multisig_utxo(8 + extra as u8, 11_000 + extra)],
            )
            .unwrap();
            assert_eq!(unsigned.transaction.outputs.len(), 1);
            assert_eq!(unsigned.transaction.outputs[0].satoshis, 10_000);
        }

        assert!(
            MultiSig::build_tbc_transaction(
                &fixture.address,
                MultiSigDestination::P2pkh(fixture.owner.address()),
                SDK_DUST_SAT - 1,
                vec![fixture.multisig_utxo(10, 30_000)],
            )
            .is_err()
        );
        assert!(
            MultiSig::build_tbc_transaction(
                &fixture.address,
                MultiSigDestination::MultiSig("not-an-address".to_string()),
                10_000,
                vec![fixture.multisig_utxo(11, 30_000)],
            )
            .is_err()
        );
        assert!(
            MultiSig::build_tbc_transaction(
                &fixture.address,
                MultiSigDestination::P2pkh(fixture.owner.address()),
                30_000,
                vec![fixture.multisig_utxo(12, 30_000)],
            )
            .is_err()
        );
    }

    #[test]
    fn tbc_wallet_and_deposit_reject_wrong_source_and_dust() {
        let fixture = Fixture::two_of_three();
        let wrong_source = PrivateKey::from_slice(&[10u8; 32]).unwrap().address();
        assert!(
            MultiSig::create_wallet(
                &wrong_source,
                &fixture.public_keys,
                2,
                10_000,
                vec![fixture.p2pkh_utxo(13, 30_000)],
            )
            .is_err()
        );
        assert!(
            MultiSig::p2pkh_to_multisig_tbc(
                &fixture.owner.address(),
                &fixture.address,
                SDK_DUST_SAT - 1,
                vec![fixture.p2pkh_utxo(14, 30_000)],
            )
            .is_err()
        );
    }

    #[test]
    fn tbc_builders_reject_duplicate_outpoints() {
        let fixture = Fixture::two_of_three();
        let p2pkh = fixture.p2pkh_utxo(20, 30_000);
        assert!(
            MultiSig::create_wallet(
                &fixture.owner.address(),
                &fixture.public_keys,
                2,
                10_000,
                vec![p2pkh.clone(), p2pkh.clone()],
            )
            .is_err()
        );
        assert!(
            MultiSig::p2pkh_to_multisig_tbc(
                &fixture.owner.address(),
                &fixture.address,
                10_000,
                vec![p2pkh.clone(), p2pkh],
            )
            .is_err()
        );
        let multisig = fixture.multisig_utxo(21, 30_000);
        assert!(
            MultiSig::build_tbc_transaction(
                &fixture.address,
                MultiSigDestination::P2pkh(fixture.owner.address()),
                10_000,
                vec![multisig.clone(), multisig],
            )
            .is_err()
        );
    }

    #[test]
    fn tbc_signatures_commit_to_each_input_amount() {
        let fixture = Fixture::two_of_three();
        let unsigned = MultiSig::build_tbc_transaction(
            &fixture.address,
            MultiSigDestination::P2pkh(fixture.owner.address()),
            10_000,
            vec![
                fixture.multisig_utxo(15, 20_000),
                fixture.multisig_utxo(16, 20_000),
            ],
        )
        .unwrap();
        let signatures = fixture.sign_tbc(&unsigned, &[0, 1]);
        let mut wrong_amount = unsigned.clone();
        wrong_amount.input_satoshis[0] += 1;

        assert!(
            MultiSig::sign_tbc_transaction(
                &fixture.address,
                &wrong_amount,
                &fixture.private_keys[0],
            )
            .is_err()
        );
        assert!(
            MultiSig::finish_tbc_transaction(&wrong_amount, &signatures, &fixture.public_keys)
                .is_err()
        );
    }

    #[test]
    fn tbc_finish_rejects_public_keys_that_do_not_match_source_address() {
        let fixture = Fixture::two_of_three();
        let unsigned = MultiSig::build_tbc_transaction(
            &fixture.address,
            MultiSigDestination::P2pkh(fixture.owner.address()),
            10_000,
            vec![fixture.multisig_utxo(17, 30_000)],
        )
        .unwrap();
        let signatures = fixture.sign_tbc(&unsigned, &[0, 1]);
        let mut wrong_keys = fixture.public_keys.clone();
        wrong_keys[2] = PrivateKey::from_slice(&[11u8; 32]).unwrap().public_key();

        assert!(MultiSig::finish_tbc_transaction(&unsigned, &signatures, &wrong_keys).is_err());
    }

    #[test]
    fn tbc_signatures_use_default_forkid_hashtype() {
        let fixture = Fixture::two_of_three();
        let unsigned = MultiSig::build_tbc_transaction(
            &fixture.address,
            MultiSigDestination::P2pkh(fixture.owner.address()),
            10_000,
            vec![fixture.multisig_utxo(18, 30_000)],
        )
        .unwrap();
        let signatures =
            MultiSig::sign_tbc_transaction(&fixture.address, &unsigned, &fixture.private_keys[0])
                .unwrap();

        assert_eq!(signatures[0].last(), Some(&(DEFAULT_SIGHASH as u8)));
    }

    #[test]
    fn tbc_direct_builders_do_not_emit_nonpositive_change() {
        let fixture = Fixture::two_of_three();
        let exact = MultiSig::p2pkh_to_multisig_tbc(
            &fixture.owner.address(),
            &fixture.address,
            9_920,
            vec![fixture.p2pkh_utxo(19, 10_000)],
        )
        .unwrap();
        assert_eq!(exact.outputs.len(), 1);
        assert_eq!(paid_fee(&exact, 10_000), 80);
    }

    #[test]
    fn tbc_address_destination_type_is_explicit() {
        let address: Address = PrivateKey::from_slice(&[12u8; 32]).unwrap().address();
        assert!(matches!(
            MultiSigDestination::P2pkh(address),
            MultiSigDestination::P2pkh(_)
        ));
    }

    #[test]
    fn tbc_builders_enforce_consensus_input_money_range() {
        let fixture = Fixture::two_of_three();

        assert!(
            MultiSig::p2pkh_to_multisig_tbc(
                &fixture.owner.address(),
                &fixture.address,
                10_000,
                vec![fixture.p2pkh_utxo(31, MAX_MONEY_SAT)],
            )
            .is_ok()
        );
        assert!(
            MultiSig::p2pkh_to_multisig_tbc(
                &fixture.owner.address(),
                &fixture.address,
                10_000,
                vec![fixture.p2pkh_utxo(32, MAX_MONEY_SAT + 1)],
            )
            .is_err()
        );
        assert!(
            MultiSig::create_wallet(
                &fixture.owner.address(),
                &fixture.public_keys,
                2,
                10_000,
                vec![
                    fixture.p2pkh_utxo(33, MAX_MONEY_SAT),
                    fixture.p2pkh_utxo(34, 1),
                ],
            )
            .is_err()
        );

        assert!(
            MultiSig::build_tbc_transaction(
                &fixture.address,
                MultiSigDestination::P2pkh(fixture.owner.address()),
                10_000,
                vec![fixture.multisig_utxo(35, MAX_MONEY_SAT)],
            )
            .is_ok()
        );
        assert!(
            MultiSig::build_tbc_transaction(
                &fixture.address,
                MultiSigDestination::P2pkh(fixture.owner.address()),
                10_000,
                vec![fixture.multisig_utxo(36, MAX_MONEY_SAT + 1)],
            )
            .is_err()
        );
        assert!(
            MultiSig::build_tbc_transaction(
                &fixture.address,
                MultiSigDestination::P2pkh(fixture.owner.address()),
                10_000,
                vec![
                    fixture.multisig_utxo(37, MAX_MONEY_SAT),
                    fixture.multisig_utxo(38, 1),
                ],
            )
            .is_err()
        );
    }

    #[test]
    fn tbc_portable_unsigned_enforces_transaction_money_range_and_nonempty_outputs() {
        let fixture = Fixture::two_of_three();

        assert!(
            MultiSigUnsignedTx::from_parts(
                portable_transaction(MAX_MONEY_SAT),
                vec![MAX_MONEY_SAT],
                fixture.address.clone(),
            )
            .is_ok()
        );
        assert!(
            MultiSigUnsignedTx::from_parts(
                portable_transaction(10_000),
                vec![MAX_MONEY_SAT + 1],
                fixture.address.clone(),
            )
            .is_err()
        );

        let mut aggregate_inputs = portable_transaction(10_000);
        aggregate_inputs.inputs.push(TxIn::new(outpoint(39)));
        assert!(
            MultiSigUnsignedTx::from_parts(
                aggregate_inputs,
                vec![MAX_MONEY_SAT, 1],
                fixture.address.clone(),
            )
            .is_err()
        );
        assert!(
            MultiSigUnsignedTx::from_parts(
                portable_transaction(MAX_MONEY_SAT + 1),
                vec![MAX_MONEY_SAT],
                fixture.address.clone(),
            )
            .is_err()
        );

        let mut aggregate_outputs = portable_transaction(MAX_MONEY_SAT);
        aggregate_outputs.outputs.push(TxOut {
            satoshis: 1,
            script_pubkey: Script::empty(),
        });
        assert!(
            MultiSigUnsignedTx::from_parts(
                aggregate_outputs,
                vec![MAX_MONEY_SAT],
                fixture.address.clone(),
            )
            .is_err()
        );

        let mut no_outputs = portable_transaction(10_000);
        no_outputs.outputs.clear();
        assert!(MultiSigUnsignedTx::from_parts(no_outputs, vec![30_000], fixture.address).is_err());
    }

    #[test]
    fn tbc_sign_and_finish_reject_transaction_mutation_after_construction() {
        let fixture = Fixture::two_of_three();
        let unsigned = MultiSig::build_tbc_transaction(
            &fixture.address,
            MultiSigDestination::P2pkh(fixture.owner.address()),
            10_000,
            vec![
                fixture.multisig_utxo(40, 20_000),
                fixture.multisig_utxo(41, 20_000),
            ],
        )
        .unwrap();
        let valid = fixture.sign_tbc(&unsigned, &[0, 1]);

        let assert_rejected = |mutated: &MultiSigUnsignedTx| {
            assert!(
                MultiSig::sign_tbc_transaction(
                    &fixture.address,
                    mutated,
                    &fixture.private_keys[0],
                )
                .is_err()
            );
            assert!(
                MultiSig::finish_tbc_transaction(mutated, &valid, &fixture.public_keys).is_err()
            );
        };

        let mut duplicate_input = unsigned.clone();
        duplicate_input.transaction.inputs[1].previous_output = duplicate_input.transaction.inputs
            [0]
        .previous_output
        .clone();
        assert_rejected(&duplicate_input);

        let mut no_outputs = unsigned.clone();
        no_outputs.transaction.outputs.clear();
        assert_rejected(&no_outputs);

        let mut changed_lock_time = unsigned.clone();
        changed_lock_time.transaction.lock_time += 1;
        assert_rejected(&changed_lock_time);
    }

    #[test]
    fn tbc_finish_empty_signature_error_identifies_input_and_signer() {
        let fixture = Fixture::two_of_three();
        let unsigned = MultiSig::build_tbc_transaction(
            &fixture.address,
            MultiSigDestination::P2pkh(fixture.owner.address()),
            10_000,
            vec![fixture.multisig_utxo(42, 30_000)],
        )
        .unwrap();
        let valid = fixture.sign_tbc(&unsigned, &[0, 1]);
        let signatures = vec![vec![valid[0][0].clone(), Vec::new()]];

        let error = MultiSig::finish_tbc_transaction(&unsigned, &signatures, &fixture.public_keys)
            .unwrap_err();
        match error {
            crate::Error::InvalidUtxo(message) => {
                assert!(message.contains("input 0 signer 1"), "{message}");
            }
            other => panic!("unexpected error: {other}"),
        }
    }

    #[test]
    fn tbc_portable_unsigned_rejects_non_tbc_transaction_version() {
        let fixture = Fixture::two_of_three();
        let normal = portable_transaction(10_000);
        assert_eq!(normal.version, TX_VERSION);
        assert!(
            MultiSigUnsignedTx::from_parts(normal.clone(), vec![30_000], fixture.address.clone(),)
                .is_ok()
        );

        let mut legacy_version = normal;
        legacy_version.version = 1;
        assert!(
            MultiSigUnsignedTx::from_parts(legacy_version, vec![30_000], fixture.address,).is_err()
        );
    }

    #[test]
    fn tbc_portable_unsigned_rejects_null_previous_output() {
        let fixture = Fixture::two_of_three();
        let normal = portable_transaction(10_000);
        assert!(
            MultiSigUnsignedTx::from_parts(normal.clone(), vec![30_000], fixture.address.clone(),)
                .is_ok()
        );

        let mut null_prevout = normal;
        null_prevout.inputs[0].previous_output = OutPoint {
            txid: Txid::from_le_bytes([0; 32]),
            vout: u32::MAX,
        };
        assert!(
            MultiSigUnsignedTx::from_parts(null_prevout, vec![30_000], fixture.address).is_err()
        );
    }

    #[test]
    fn batch_tbc_and_ft_signing_matches_scalar_results() {
        let fixture = Fixture::two_of_three();
        let tbc_a = MultiSig::build_tbc_transaction(
            &fixture.address,
            MultiSigDestination::P2pkh(fixture.owner.address()),
            10_000,
            vec![fixture.multisig_utxo(43, 30_000)],
        )
        .unwrap();
        let tbc_b = MultiSig::build_tbc_transaction(
            &fixture.address,
            MultiSigDestination::P2pkh(fixture.owner.address()),
            11_000,
            vec![fixture.multisig_utxo(44, 31_000)],
        )
        .unwrap();
        let tbc_batch = [tbc_a.clone(), tbc_b.clone()];
        let signer_a = MultiSig::batch_sign_tbc_transactions(
            &fixture.address,
            &tbc_batch,
            &fixture.private_keys[0],
        )
        .unwrap();
        assert_eq!(
            signer_a,
            vec![
                MultiSig::sign_tbc_transaction(&fixture.address, &tbc_a, &fixture.private_keys[0],)
                    .unwrap(),
                MultiSig::sign_tbc_transaction(&fixture.address, &tbc_b, &fixture.private_keys[0],)
                    .unwrap(),
            ]
        );
        let tbc_signatures = tbc_batch
            .iter()
            .map(|transaction| fixture.sign_tbc(transaction, &[0, 1]))
            .collect::<Vec<_>>();
        let finished_tbc = MultiSig::batch_finish_tbc_transactions(
            &tbc_batch,
            &tbc_signatures,
            &fixture.public_keys,
        )
        .unwrap();
        assert_eq!(
            finished_tbc,
            tbc_batch
                .iter()
                .zip(&tbc_signatures)
                .map(
                    |(transaction, signatures)| MultiSig::finish_tbc_transaction(
                        transaction,
                        signatures,
                        &fixture.public_keys,
                    )
                    .unwrap()
                )
                .collect::<Vec<_>>()
        );

        let source_receiver =
            FtCodeReceiver::ContractHash(MultiSig::combine_hash(&fixture.address).unwrap());
        let (ft, ft_utxo, pre_tx, pre_pre, _) =
            ft_context(3, &fixture.owner, source_receiver, 100, 2_000);
        let (funding, funding_parent) = multisig_funding_context(&fixture, 45, 20_000);
        let ft_unsigned = MultiSig::build_ft_transaction(
            &fixture.address,
            MultiSigDestination::P2pkh(fixture.owner.address()),
            &ft,
            60,
            funding,
            vec![ft_utxo],
            vec![pre_tx],
            vec![pre_pre],
            &funding_parent,
            &fixture.owner,
        )
        .unwrap();
        let ft_batch = [ft_unsigned.clone(), ft_unsigned.clone()];
        let ft_signed = MultiSig::batch_sign_ft_transactions(
            &fixture.address,
            &ft_batch,
            &fixture.private_keys[0],
        )
        .unwrap();
        assert_eq!(
            ft_signed,
            ft_batch
                .iter()
                .map(|transaction| MultiSig::sign_ft_transaction(
                    &fixture.address,
                    transaction,
                    &fixture.private_keys[0],
                )
                .unwrap())
                .collect::<Vec<_>>()
        );
        let ft_signatures = ft_batch
            .iter()
            .map(|transaction| fixture.sign_ft(transaction, &[0, 1]))
            .collect::<Vec<_>>();
        let finished_ft =
            MultiSig::batch_finish_ft_transactions(&ft_batch, &ft_signatures, &fixture.public_keys)
                .unwrap();
        assert_eq!(
            finished_ft,
            ft_batch
                .iter()
                .zip(&ft_signatures)
                .map(|(transaction, signatures)| MultiSig::finish_ft_transaction(
                    transaction,
                    signatures,
                    &fixture.public_keys,
                )
                .unwrap())
                .collect::<Vec<_>>()
        );

        assert!(
            MultiSig::batch_finish_tbc_transactions(
                &tbc_batch,
                &tbc_signatures[..1],
                &fixture.public_keys,
            )
            .is_err()
        );
        assert!(
            MultiSig::batch_finish_ft_transactions(
                &ft_batch,
                &ft_signatures[..1],
                &fixture.public_keys,
            )
            .is_err()
        );
        assert!(
            MultiSig::batch_sign_tbc_transactions(&fixture.address, &[], &fixture.private_keys[0],)
                .unwrap()
                .is_empty()
        );
        assert!(
            MultiSig::batch_finish_ft_transactions(&[], &[], &fixture.public_keys)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn ft_p2pkh_deposit_uses_released_layout_receiver_and_exact_fee() {
        let fixture = Fixture::two_of_three();
        let (ft, ft_utxo, pre_tx, pre_pre, _) = ft_context(
            3,
            &fixture.owner,
            FtCodeReceiver::Address(fixture.owner.address()),
            100,
            500,
        );
        let fee_utxo = fixture.p2pkh_utxo(50, 100_000);
        let tx = MultiSig::p2pkh_to_multisig_ft(
            &fixture.owner.address(),
            &fixture.address,
            &ft,
            60,
            vec![ft_utxo.clone()],
            fee_utxo.clone(),
            vec![pre_tx.clone()],
            vec![pre_pre.clone()],
            &fixture.owner,
            Some(5_000),
        )
        .unwrap();

        assert_eq!(tx.inputs[0].previous_output, ft_utxo.base.outpoint);
        assert_eq!(tx.inputs[1].previous_output, fee_utxo.outpoint);
        assert_eq!(tx.outputs[0].satoshis, 5_000);
        assert_eq!(
            tx.outputs[0].script_pubkey,
            MultiSig::lock_script(&fixture.address).unwrap()
        );
        let receiver = MultiSig::combine_hash(&fixture.address).unwrap();
        assert!(
            tx.outputs[1]
                .script_pubkey
                .as_bytes()
                .ends_with(&[receiver.as_slice(), &[0x05], b"2Code"].concat())
        );
        assert_eq!(tx.outputs[1].satoshis, 2_000);
        assert_eq!(tx.outputs[2].satoshis, 0);
        assert_eq!(tx.outputs[3].satoshis, 2_000);
        assert_eq!(tx.outputs[4].satoshis, 0);
        let ancestry = pre_pre_tx_data_from_parents(&pre_tx, 0, &pre_pre).unwrap();
        assert!(
            tx.inputs[0]
                .script_sig
                .as_bytes()
                .windows(ancestry.len())
                .any(|window| window == ancestry)
        );
        let parent_data = crate::contracts::ft::unlock::pre_tx_data(&pre_tx, 0).unwrap();
        assert!(tx.inputs[0].script_sig.as_bytes().ends_with(&parent_data));
        assert_target_fee(&tx, ft_utxo.base.satoshis + fee_utxo.satoshis);
    }

    #[test]
    fn ft_distributed_spend_supports_both_destination_types_and_canonical_finish() {
        let fixture = Fixture::two_of_three();
        let source_receiver =
            FtCodeReceiver::ContractHash(MultiSig::combine_hash(&fixture.address).unwrap());
        let (ft, ft_utxo, pre_tx, pre_pre, _ft_contract_tx) =
            ft_context(3, &fixture.owner, source_receiver, 100, 2_000);
        let recipient = PrivateKey::from_slice(&[81u8; 32]).unwrap().address();
        let (funding, funding_parent) = multisig_funding_context(&fixture, 51, 20_000);
        let unsigned = MultiSig::build_ft_transaction(
            &fixture.address,
            MultiSigDestination::P2pkh(recipient.clone()),
            &ft,
            60,
            funding.clone(),
            vec![ft_utxo.clone()],
            vec![pre_tx.clone()],
            vec![pre_pre.clone()],
            &funding_parent,
            &fixture.owner,
        )
        .unwrap();

        assert_eq!(unsigned.input_satoshis, vec![20_000, 2_000]);
        assert_eq!(
            unsigned.transaction.inputs[0].previous_output,
            funding.outpoint
        );
        assert_eq!(
            unsigned.transaction.inputs[1].previous_output,
            ft_utxo.base.outpoint
        );
        assert!(
            unsigned.transaction.inputs[0]
                .script_sig
                .as_bytes()
                .is_empty()
        );
        assert!(
            !unsigned.transaction.inputs[1]
                .script_sig
                .as_bytes()
                .is_empty()
        );
        assert_eq!(unsigned.transaction.outputs[0].satoshis, 17_000);
        assert_eq!(
            unsigned.transaction.outputs[0].script_pubkey,
            MultiSig::lock_script(&fixture.address).unwrap()
        );
        assert!(
            unsigned.transaction.outputs[1]
                .script_pubkey
                .as_bytes()
                .ends_with(&[recipient.hash160().as_slice(), &[0x00, 0x05], b"2Code",].concat())
        );
        assert_eq!(unsigned.transaction.outputs[2].satoshis, 0);
        assert_eq!(unsigned.transaction.outputs[3].satoshis, 2_000);
        assert_eq!(unsigned.transaction.outputs[4].satoshis, 0);
        let ancestry = pre_pre_tx_data_from_parents(&pre_tx, 0, &pre_pre).unwrap();
        assert!(
            unsigned.transaction.inputs[1]
                .script_sig
                .as_bytes()
                .windows(ancestry.len())
                .any(|window| window == ancestry)
        );
        // The v3 swap tag for isContractTXs=false is OP_0 immediately before
        // the exact parent-transaction payload.
        let parent_data = crate::contracts::ft::unlock::pre_tx_data(&pre_tx, 0).unwrap();
        let unlock = unsigned.transaction.inputs[1].script_sig.as_bytes();
        assert!(unlock.ends_with(&parent_data));
        assert_eq!(unlock[unlock.len() - parent_data.len() - 1], 0x00);

        let collected = fixture.sign_ft(&unsigned, &[1, 0]);
        let finished =
            MultiSig::finish_ft_transaction(&unsigned, &collected, &fixture.public_keys).unwrap();
        let canonical = fixture.sign_ft(&unsigned, &[0, 1]);
        assert_eq!(
            finished.inputs[0].script_sig,
            expected_unlock(&canonical[0], &fixture.public_keys)
        );
        assert_target_fee(&finished, funding.satoshis + ft_utxo.base.satoshis);

        let input_parents = vec![funding_parent.clone(), pre_tx.clone()];
        let transported_parents = input_parents
            .iter()
            .map(|parent| Transaction::from_hex(&parent.to_hex()).unwrap())
            .collect();
        let transported = MultiSigUnsignedTx::from_ft_parts(
            Transaction::from_hex(&unsigned.transaction.to_hex()).unwrap(),
            transported_parents,
            unsigned.source_address.clone(),
        )
        .unwrap();
        let transported_signatures = fixture.sign_ft(&transported, &[0, 1]);
        let transported_finished = MultiSig::finish_ft_transaction(
            &transported,
            &transported_signatures,
            &fixture.public_keys,
        )
        .unwrap();
        assert_eq!(transported_finished, finished);
        assert!(
            MultiSigUnsignedTx::from_ft_parts(
                Transaction::from_hex(&unsigned.transaction.to_hex()).unwrap(),
                Vec::new(),
                unsigned.source_address.clone(),
            )
            .is_err()
        );
        assert!(
            MultiSigUnsignedTx::from_ft_parts(
                Transaction::from_hex(&unsigned.transaction.to_hex()).unwrap(),
                vec![funding_parent.clone()],
                unsigned.source_address.clone(),
            )
            .is_err()
        );
        let mut wrong_txid_parent = funding_parent.clone();
        wrong_txid_parent.lock_time += 1;
        assert!(
            MultiSigUnsignedTx::from_ft_parts(
                Transaction::from_hex(&unsigned.transaction.to_hex()).unwrap(),
                vec![wrong_txid_parent, pre_tx.clone()],
                unsigned.source_address.clone(),
            )
            .is_err()
        );
        let mut wrong_vout_tx = Transaction::from_hex(&unsigned.transaction.to_hex()).unwrap();
        wrong_vout_tx.inputs[1].previous_output.vout = u32::MAX;
        assert!(
            MultiSigUnsignedTx::from_ft_parts(
                wrong_vout_tx,
                input_parents.clone(),
                unsigned.source_address.clone(),
            )
            .is_err()
        );
        let mut wrong_script_parent = funding_parent.clone();
        wrong_script_parent.outputs[funding.outpoint.vout as usize].script_pubkey =
            Script::from_bytes(vec![0x51]);
        let mut wrong_script_tx = Transaction::from_hex(&unsigned.transaction.to_hex()).unwrap();
        wrong_script_tx.inputs[0].previous_output.txid = wrong_script_parent.txid();
        assert!(
            MultiSigUnsignedTx::from_ft_parts(
                wrong_script_tx,
                vec![wrong_script_parent, pre_tx.clone()],
                unsigned.source_address.clone(),
            )
            .is_err()
        );
        let mut inflated_ft_parent = pre_tx.clone();
        inflated_ft_parent.outputs[ft_utxo.base.outpoint.vout as usize].satoshis += 1_000_000;
        assert!(
            MultiSigUnsignedTx::from_ft_parts(
                Transaction::from_hex(&unsigned.transaction.to_hex()).unwrap(),
                vec![funding_parent.clone(), inflated_ft_parent],
                unsigned.source_address.clone(),
            )
            .is_err()
        );
        let mut tampered_amounts = transported.clone();
        tampered_amounts.input_satoshis[1] += 1;
        assert!(
            MultiSig::sign_ft_transaction(
                &fixture.address,
                &tampered_amounts,
                &fixture.private_keys[0],
            )
            .is_err()
        );
        assert!(
            MultiSig::finish_ft_transaction(
                &tampered_amounts,
                &transported_signatures,
                &fixture.public_keys,
            )
            .is_err()
        );
        assert!(
            MultiSigUnsignedTx::from_parts(
                Transaction::from_hex(&unsigned.transaction.to_hex()).unwrap(),
                unsigned.input_satoshis.clone(),
                unsigned.source_address.clone(),
            )
            .is_err()
        );

        let destination_keys = [[82u8; 32], [83u8; 32], [84u8; 32]]
            .into_iter()
            .map(|bytes| PrivateKey::from_slice(&bytes).unwrap().public_key())
            .collect::<Vec<_>>();
        let destination = MultiSig::address(&destination_keys, 2).unwrap();
        let (second_funding, second_funding_parent) =
            multisig_funding_context(&fixture, 52, 20_000);
        let to_multisig = MultiSig::build_ft_transaction(
            &fixture.address,
            MultiSigDestination::MultiSig(destination.clone()),
            &ft,
            100,
            second_funding,
            vec![ft_utxo],
            vec![pre_tx],
            vec![pre_pre],
            &second_funding_parent,
            &fixture.owner,
        )
        .unwrap();
        let receiver = MultiSig::combine_hash(&destination).unwrap();
        assert!(
            to_multisig.transaction.outputs[1]
                .script_pubkey
                .as_bytes()
                .ends_with(&[receiver.as_slice(), &[0x05], b"2Code"].concat())
        );
        assert_eq!(to_multisig.transaction.outputs.len(), 3);
    }

    #[test]
    fn ft_distributed_builder_selects_v1_v2_and_v3_once_in_ft_module() {
        let fixture = Fixture::two_of_three();
        let mut contract_payloads = Vec::new();
        for version in [1, 2, 3] {
            let (ft, ft_utxo, pre_tx, pre_pre, _ft_contract_tx) = ft_context(
                version,
                &fixture.owner,
                FtCodeReceiver::ContractHash(MultiSig::combine_hash(&fixture.address).unwrap()),
                100,
                2_000,
            );
            let (funding, funding_parent) =
                multisig_funding_context(&fixture, 52 + version, 20_000);
            let unsigned = MultiSig::build_ft_transaction(
                &fixture.address,
                MultiSigDestination::P2pkh(fixture.owner.address()),
                &ft,
                100,
                funding.clone(),
                vec![ft_utxo],
                vec![pre_tx],
                vec![pre_pre],
                &funding_parent,
                &fixture.owner,
            )
            .unwrap();
            assert!(
                !unsigned.transaction.inputs[1]
                    .script_sig
                    .as_bytes()
                    .is_empty()
            );
            let contract_vout = if version == 1 {
                funding.outpoint.vout as i32
            } else {
                -1
            };
            let contract_data =
                crate::contracts::ft::unlock::contract_tx_data(&funding_parent, contract_vout)
                    .unwrap();
            let unlock = unsigned.transaction.inputs[1].script_sig.as_bytes();
            let contract_offset = unlock
                .windows(contract_data.len())
                .rposition(|window| window == contract_data)
                .unwrap();
            let after_contract = contract_offset + contract_data.len();
            assert_eq!(
                unlock[after_contract],
                if version == 3 { 0x00 } else { 0x10 }
            );
            contract_payloads.push(contract_data);
        }
        assert_ne!(contract_payloads[0], contract_payloads[1]);
        assert_ne!(contract_payloads[1], contract_payloads[2]);
    }

    #[test]
    fn ft_builders_accept_the_five_input_boundary_with_exact_slot_offset() {
        let fixture = Fixture::two_of_three();
        let deposit_contexts = (10..=14)
            .map(|balance| {
                ft_context(
                    3,
                    &fixture.owner,
                    FtCodeReceiver::Address(fixture.owner.address()),
                    balance,
                    2_000,
                )
            })
            .collect::<Vec<_>>();
        let deposit_ft = deposit_contexts[0].0.clone();
        let deposit_inputs = deposit_contexts
            .iter()
            .map(|context| context.1.clone())
            .collect::<Vec<_>>();
        let deposit_parents = deposit_contexts
            .iter()
            .map(|context| context.2.clone())
            .collect::<Vec<_>>();
        let deposit_pre_pre = deposit_contexts
            .iter()
            .map(|context| context.3.clone())
            .collect::<Vec<_>>();
        let deposit = MultiSig::p2pkh_to_multisig_ft(
            &fixture.owner.address(),
            &fixture.address,
            &deposit_ft,
            60,
            deposit_inputs.clone(),
            fixture.p2pkh_utxo(57, 100_000),
            deposit_parents,
            deposit_pre_pre,
            &fixture.owner,
            None,
        )
        .unwrap();
        assert_eq!(deposit.inputs.len(), 6);
        assert_eq!(deposit.outputs[0].satoshis, 2_000);
        assert_eq!(deposit.outputs[1].satoshis, 0);
        assert_eq!(deposit.outputs.len(), 3);

        let source_receiver =
            FtCodeReceiver::ContractHash(MultiSig::combine_hash(&fixture.address).unwrap());
        let spend_contexts = (10..=14)
            .map(|balance| ft_context(3, &fixture.owner, source_receiver.clone(), balance, 2_000))
            .collect::<Vec<_>>();
        let spend_ft = spend_contexts[0].0.clone();
        let spend_inputs = spend_contexts
            .iter()
            .map(|context| context.1.clone())
            .collect::<Vec<_>>();
        let spend_parents = spend_contexts
            .iter()
            .map(|context| context.2.clone())
            .collect::<Vec<_>>();
        let spend_pre_pre = spend_contexts
            .iter()
            .map(|context| context.3.clone())
            .collect::<Vec<_>>();
        let (funding, funding_parent) = multisig_funding_context(&fixture, 58, 30_000);
        let unsigned = MultiSig::build_ft_transaction(
            &fixture.address,
            MultiSigDestination::P2pkh(fixture.owner.address()),
            &spend_ft,
            60,
            funding.clone(),
            spend_inputs.clone(),
            spend_parents.clone(),
            spend_pre_pre,
            &funding_parent,
            &fixture.owner,
        )
        .unwrap();
        assert_eq!(unsigned.transaction.inputs.len(), 6);
        assert_eq!(unsigned.transaction.outputs[0].satoshis, 37_000);
        assert_eq!(unsigned.transaction.outputs.len(), 3);
        assert!(
            MultiSigUnsignedTx::from_ft_parts(
                Transaction::from_hex(&unsigned.transaction.to_hex()).unwrap(),
                std::iter::once(funding_parent.clone())
                    .chain(spend_parents.iter().cloned())
                    .collect(),
                unsigned.source_address.clone(),
            )
            .is_ok()
        );
        let mut six_ft_inputs = unsigned.transaction.clone();
        let mut extra_parent = spend_parents[0].clone();
        extra_parent.lock_time += 1;
        let mut extra_input = TxIn::new(OutPoint {
            txid: extra_parent.txid(),
            vout: 0,
        });
        extra_input.script_sig = Script::from_bytes(vec![0x51]);
        six_ft_inputs.inputs.push(extra_input);
        let six_ft_parents = std::iter::once(funding_parent.clone())
            .chain(spend_parents.iter().cloned())
            .chain(std::iter::once(extra_parent))
            .collect();
        assert!(
            MultiSigUnsignedTx::from_ft_parts(
                six_ft_inputs,
                six_ft_parents,
                unsigned.source_address.clone(),
            )
            .is_err()
        );
        let signatures = fixture.sign_ft(&unsigned, &[0, 2]);
        let finished =
            MultiSig::finish_ft_transaction(&unsigned, &signatures, &fixture.public_keys).unwrap();
        let input_sum = funding.satoshis
            + spend_inputs
                .iter()
                .map(|utxo| utxo.base.satoshis)
                .sum::<u64>();
        assert_target_fee(&finished, input_sum);
    }

    #[test]
    fn ft_builders_reject_bad_counts_ancestry_owners_duplicates_and_money_range() {
        let fixture = Fixture::two_of_three();
        let (ft, ft_utxo, pre_tx, pre_pre, _contract_tx) = ft_context(
            3,
            &fixture.owner,
            FtCodeReceiver::Address(fixture.owner.address()),
            100,
            2_000,
        );
        let call_deposit = |ft_utxos, pre_txs, pre_pre_set, fee_utxo| {
            MultiSig::p2pkh_to_multisig_ft(
                &fixture.owner.address(),
                &fixture.address,
                &ft,
                50,
                ft_utxos,
                fee_utxo,
                pre_txs,
                pre_pre_set,
                &fixture.owner,
                None,
            )
        };
        assert!(
            call_deposit(
                Vec::new(),
                Vec::new(),
                Vec::new(),
                fixture.p2pkh_utxo(60, 30_000)
            )
            .is_err()
        );
        assert!(
            call_deposit(
                vec![ft_utxo.clone()],
                vec![pre_tx.clone()],
                Vec::new(),
                fixture.p2pkh_utxo(71, 30_000)
            )
            .is_err()
        );
        assert!(
            call_deposit(
                vec![ft_utxo.clone(), ft_utxo.clone()],
                vec![pre_tx.clone(), pre_tx.clone()],
                vec![pre_pre.clone(), pre_pre.clone()],
                fixture.p2pkh_utxo(72, 30_000)
            )
            .is_err()
        );
        assert!(
            call_deposit(
                vec![ft_utxo.clone()],
                Vec::new(),
                vec![pre_pre.clone()],
                fixture.p2pkh_utxo(61, 30_000)
            )
            .is_err()
        );
        assert!(
            call_deposit(
                vec![ft_utxo.clone(); 6],
                vec![pre_tx.clone(); 6],
                vec![pre_pre.clone(); 6],
                fixture.p2pkh_utxo(62, 100_000)
            )
            .is_err()
        );

        let duplicate_fee = Utxo {
            outpoint: ft_utxo.base.outpoint.clone(),
            ..fixture.p2pkh_utxo(63, 30_000)
        };
        assert!(
            call_deposit(
                vec![ft_utxo.clone()],
                vec![pre_tx.clone()],
                vec![pre_pre.clone()],
                duplicate_fee
            )
            .is_err()
        );
        let outsider = PrivateKey::from_slice(&[85u8; 32]).unwrap();
        assert!(
            MultiSig::p2pkh_to_multisig_ft(
                &fixture.owner.address(),
                &fixture.address,
                &ft,
                50,
                vec![ft_utxo.clone()],
                fixture.p2pkh_utxo(64, 30_000),
                vec![pre_tx.clone()],
                vec![pre_pre.clone()],
                &outsider,
                None,
            )
            .is_err()
        );
        let too_large_fee = fixture.p2pkh_utxo(65, MAX_MONEY_SAT + 1);
        assert!(
            call_deposit(
                vec![ft_utxo.clone()],
                vec![pre_tx.clone()],
                vec![pre_pre.clone()],
                too_large_fee
            )
            .is_err()
        );
        let mut null_fee = fixture.p2pkh_utxo(93, 30_000);
        null_fee.outpoint = OutPoint {
            txid: Txid::from_le_bytes([0; 32]),
            vout: u32::MAX,
        };
        assert!(
            call_deposit(
                vec![ft_utxo.clone()],
                vec![pre_tx.clone()],
                vec![pre_pre.clone()],
                null_fee,
            )
            .is_err()
        );
        assert!(
            call_deposit(
                vec![ft_utxo.clone()],
                vec![pre_tx.clone()],
                vec![pre_pre.clone()],
                fixture.p2pkh_utxo(73, MAX_MONEY_SAT)
            )
            .is_err()
        );
        assert!(
            call_deposit(
                vec![ft_utxo.clone()],
                vec![pre_tx.clone()],
                vec![pre_pre.clone()],
                fixture.p2pkh_utxo(74, 100)
            )
            .is_err()
        );
        assert!(
            MultiSig::p2pkh_to_multisig_ft(
                &fixture.owner.address(),
                &fixture.address,
                &ft,
                0,
                vec![ft_utxo.clone()],
                fixture.p2pkh_utxo(75, 30_000),
                vec![pre_tx.clone()],
                vec![pre_pre.clone()],
                &fixture.owner,
                None,
            )
            .is_err()
        );
        assert!(
            MultiSig::p2pkh_to_multisig_ft(
                &fixture.owner.address(),
                &fixture.address,
                &ft,
                101,
                vec![ft_utxo.clone()],
                fixture.p2pkh_utxo(76, 30_000),
                vec![pre_tx.clone()],
                vec![pre_pre.clone()],
                &fixture.owner,
                None,
            )
            .is_err()
        );
        let mut wrong_parent = pre_tx.clone();
        wrong_parent.lock_time = 1;
        assert!(
            call_deposit(
                vec![ft_utxo.clone()],
                vec![wrong_parent],
                vec![pre_pre.clone()],
                fixture.p2pkh_utxo(77, 30_000)
            )
            .is_err()
        );
        let outsider_receiver = PrivateKey::from_slice(&[86u8; 32]).unwrap();
        let (wrong_ft, wrong_owner_utxo, wrong_owner_parent, wrong_owner_pre_pre, _) = ft_context(
            3,
            &fixture.owner,
            FtCodeReceiver::Address(outsider_receiver.address()),
            100,
            2_000,
        );
        assert!(
            MultiSig::p2pkh_to_multisig_ft(
                &fixture.owner.address(),
                &fixture.address,
                &wrong_ft,
                50,
                vec![wrong_owner_utxo],
                fixture.p2pkh_utxo(78, 30_000),
                vec![wrong_owner_parent],
                vec![wrong_owner_pre_pre],
                &fixture.owner,
                None,
            )
            .is_err()
        );

        let source_receiver =
            FtCodeReceiver::ContractHash(MultiSig::combine_hash(&fixture.address).unwrap());
        let (ms_ft, ms_utxo, ms_pre, ms_pre_pre, _ms_ft_contract) =
            ft_context(3, &fixture.owner, source_receiver, 100, 2_000);
        let (legacy_ms_ft, legacy_ms_utxo, legacy_ms_pre, legacy_ms_pre_pre, _) = ft_context(
            3,
            &fixture.owner,
            FtCodeReceiver::ContractHash(MultiSig::combine_hash(&fixture.address).unwrap()),
            100,
            500,
        );
        let (legacy_funding, legacy_funding_parent) =
            multisig_funding_context(&fixture, 94, 20_000);
        let legacy_input_sum = legacy_funding.satoshis + legacy_ms_utxo.base.satoshis;
        let legacy_unsigned = MultiSig::build_ft_transaction(
            &fixture.address,
            MultiSigDestination::P2pkh(fixture.owner.address()),
            &legacy_ms_ft,
            50,
            legacy_funding,
            vec![legacy_ms_utxo],
            vec![legacy_ms_pre],
            vec![legacy_ms_pre_pre],
            &legacy_funding_parent,
            &fixture.owner,
        )
        .unwrap();
        assert_eq!(legacy_unsigned.input_satoshis, vec![20_000, 500]);
        assert_eq!(legacy_unsigned.transaction.outputs[1].satoshis, 2_000);
        let legacy_signatures = fixture.sign_ft(&legacy_unsigned, &[0, 1]);
        let legacy_finished = MultiSig::finish_ft_transaction(
            &legacy_unsigned,
            &legacy_signatures,
            &fixture.public_keys,
        )
        .unwrap();
        assert_target_fee(&legacy_finished, legacy_input_sum);
        let (underfunded, underfunded_parent) = multisig_funding_context(&fixture, 66, 3_023);
        assert!(
            MultiSig::build_ft_transaction(
                &fixture.address,
                MultiSigDestination::P2pkh(fixture.owner.address()),
                &ms_ft,
                50,
                underfunded,
                vec![ms_utxo.clone()],
                vec![ms_pre.clone()],
                vec![ms_pre_pre.clone()],
                &underfunded_parent,
                &fixture.owner,
            )
            .is_err()
        );
        let (aggregate_funding, aggregate_parent) =
            multisig_funding_context(&fixture, 79, MAX_MONEY_SAT);
        assert!(
            MultiSig::build_ft_transaction(
                &fixture.address,
                MultiSigDestination::P2pkh(fixture.owner.address()),
                &ms_ft,
                50,
                aggregate_funding,
                vec![ms_utxo.clone()],
                vec![ms_pre.clone()],
                vec![ms_pre_pre.clone()],
                &aggregate_parent,
                &fixture.owner,
            )
            .is_err()
        );
        let duplicate_funding = MultiSigUtxo {
            outpoint: ms_utxo.base.outpoint.clone(),
            satoshis: 20_000,
            locking_script: MultiSig::lock_script(&fixture.address).unwrap(),
        };
        assert!(
            MultiSig::build_ft_transaction(
                &fixture.address,
                MultiSigDestination::P2pkh(fixture.owner.address()),
                &ms_ft,
                50,
                duplicate_funding,
                vec![ms_utxo.clone()],
                vec![ms_pre.clone()],
                vec![ms_pre_pre.clone()],
                &ms_pre,
                &fixture.owner,
            )
            .is_err()
        );
        let (valid_funding, valid_parent) = multisig_funding_context(&fixture, 92, 20_000);
        let mut wrong_parent_txid = valid_parent.clone();
        wrong_parent_txid.lock_time += 1;
        assert!(
            MultiSig::build_ft_transaction(
                &fixture.address,
                MultiSigDestination::P2pkh(fixture.owner.address()),
                &ms_ft,
                50,
                valid_funding.clone(),
                vec![ms_utxo.clone()],
                vec![ms_pre.clone()],
                vec![ms_pre_pre.clone()],
                &wrong_parent_txid,
                &fixture.owner,
            )
            .is_err()
        );
        let mut out_of_range = valid_funding.clone();
        out_of_range.outpoint.vout = 1;
        assert!(
            MultiSig::build_ft_transaction(
                &fixture.address,
                MultiSigDestination::P2pkh(fixture.owner.address()),
                &ms_ft,
                50,
                out_of_range,
                vec![ms_utxo.clone()],
                vec![ms_pre.clone()],
                vec![ms_pre_pre.clone()],
                &valid_parent,
                &fixture.owner,
            )
            .is_err()
        );
        let mut amount_mismatch = valid_funding.clone();
        amount_mismatch.satoshis -= 1;
        assert!(
            MultiSig::build_ft_transaction(
                &fixture.address,
                MultiSigDestination::P2pkh(fixture.owner.address()),
                &ms_ft,
                50,
                amount_mismatch,
                vec![ms_utxo.clone()],
                vec![ms_pre.clone()],
                vec![ms_pre_pre.clone()],
                &valid_parent,
                &fixture.owner,
            )
            .is_err()
        );
        let mut wrong_script_parent = Transaction::new();
        wrong_script_parent.outputs.push(TxOut {
            satoshis: 20_000,
            script_pubkey: fixture.owner.address().script_pubkey(),
        });
        let wrong_script_funding = MultiSigUtxo {
            outpoint: OutPoint {
                txid: wrong_script_parent.txid(),
                vout: 0,
            },
            satoshis: 20_000,
            locking_script: MultiSig::lock_script(&fixture.address).unwrap(),
        };
        assert!(
            MultiSig::build_ft_transaction(
                &fixture.address,
                MultiSigDestination::P2pkh(fixture.owner.address()),
                &ms_ft,
                50,
                wrong_script_funding,
                vec![ms_utxo.clone()],
                vec![ms_pre.clone()],
                vec![ms_pre_pre.clone()],
                &wrong_script_parent,
                &fixture.owner,
            )
            .is_err()
        );
        assert!(
            MultiSig::build_ft_transaction(
                &fixture.address,
                MultiSigDestination::P2pkh(fixture.owner.address()),
                &ms_ft,
                50,
                multisig_funding(&fixture, 67, MAX_MONEY_SAT + 1),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                &valid_parent,
                &fixture.owner,
            )
            .is_err()
        );
    }

    #[test]
    fn ft_unsigned_kind_snapshot_and_final_fee_are_enforced() {
        let fixture = Fixture::two_of_three();
        let (ft, mut ft_utxo, mut pre_tx, mut pre_pre, _ft_contract_tx) = ft_context(
            3,
            &fixture.owner,
            FtCodeReceiver::ContractHash(MultiSig::combine_hash(&fixture.address).unwrap()),
            100,
            2_000,
        );
        let tbc = MultiSig::build_tbc_transaction(
            &fixture.address,
            MultiSigDestination::P2pkh(fixture.owner.address()),
            10_000,
            vec![fixture.multisig_utxo(68, 30_000)],
        )
        .unwrap();
        assert!(
            MultiSig::sign_ft_transaction(&fixture.address, &tbc, &fixture.private_keys[0])
                .is_err()
        );
        let tbc_signatures = fixture.sign_tbc(&tbc, &[0, 1]);
        assert!(
            MultiSig::finish_ft_transaction(&tbc, &tbc_signatures, &fixture.public_keys).is_err()
        );

        let (funding, funding_parent) = multisig_funding_context(&fixture, 69, 20_000);
        let unsigned = MultiSig::build_ft_transaction(
            &fixture.address,
            MultiSigDestination::P2pkh(fixture.owner.address()),
            &ft,
            100,
            funding,
            vec![ft_utxo.clone()],
            vec![pre_tx.clone()],
            vec![pre_pre.clone()],
            &funding_parent,
            &fixture.owner,
        )
        .unwrap();
        assert!(
            MultiSig::sign_tbc_transaction(&fixture.address, &unsigned, &fixture.private_keys[0])
                .is_err()
        );
        let signatures = fixture.sign_ft(&unsigned, &[0, 1]);
        assert!(
            MultiSig::finish_tbc_transaction(&unsigned, &signatures, &fixture.public_keys).is_err()
        );
        let mut mutated = unsigned.clone();
        mutated.transaction.outputs[0].satoshis -= 1;
        assert!(
            MultiSig::sign_ft_transaction(&fixture.address, &mutated, &fixture.private_keys[0])
                .is_err()
        );
        assert!(
            MultiSig::finish_ft_transaction(&mutated, &signatures, &fixture.public_keys).is_err()
        );
        let mut duplicate_input = unsigned.clone();
        duplicate_input.transaction.inputs[1].previous_output = duplicate_input.transaction.inputs
            [0]
        .previous_output
        .clone();
        assert!(
            MultiSig::sign_ft_transaction(
                &fixture.address,
                &duplicate_input,
                &fixture.private_keys[0],
            )
            .is_err()
        );
        let mut unsigned_contract_input = unsigned.clone();
        unsigned_contract_input.transaction.inputs[1].script_sig = Script::empty();
        assert!(
            MultiSig::finish_ft_transaction(
                &unsigned_contract_input,
                &signatures,
                &fixture.public_keys,
            )
            .is_err()
        );

        let mut large_grandparent = pre_pre.remove(0);
        large_grandparent.outputs.extend((0..1_250).map(|_| TxOut {
            satoshis: 1,
            script_pubkey: Script::from_bytes(vec![0x51]),
        }));
        pre_tx.inputs[0].previous_output.txid = large_grandparent.txid();
        ft_utxo.base.outpoint.txid = pre_tx.txid();
        pre_pre.push(large_grandparent);
        let (underpaid_funding, underpaid_parent) = multisig_funding_context(&fixture, 70, 20_000);
        let underpaid = MultiSig::build_ft_transaction(
            &fixture.address,
            MultiSigDestination::P2pkh(fixture.owner.address()),
            &ft,
            100,
            underpaid_funding,
            vec![ft_utxo],
            vec![pre_tx],
            vec![pre_pre],
            &underpaid_parent,
            &fixture.owner,
        )
        .unwrap();
        let underpaid_sigs = fixture.sign_ft(&underpaid, &[0, 1]);
        let finished =
            MultiSig::finish_ft_transaction(&underpaid, &underpaid_sigs, &fixture.public_keys)
                .unwrap();
        assert_target_fee(&finished, 22_000);
    }

    #[test]
    fn ft_finish_rejects_noncanonical_signature_sets_and_wrong_keys() {
        let fixture = Fixture::two_of_three();
        let (ft, ft_utxo, pre_tx, pre_pre, _ft_contract_tx) = ft_context(
            3,
            &fixture.owner,
            FtCodeReceiver::ContractHash(MultiSig::combine_hash(&fixture.address).unwrap()),
            100,
            2_000,
        );
        let (funding, funding_parent) = multisig_funding_context(&fixture, 80, 20_000);
        let unsigned = MultiSig::build_ft_transaction(
            &fixture.address,
            MultiSigDestination::P2pkh(fixture.owner.address()),
            &ft,
            100,
            funding,
            vec![ft_utxo],
            vec![pre_tx],
            vec![pre_pre],
            &funding_parent,
            &fixture.owner,
        )
        .unwrap();
        let valid = fixture.sign_ft(&unsigned, &[0, 1]);
        assert_eq!(
            MultiSig::sign_ft_transaction(&fixture.address, &unsigned, &fixture.private_keys[0],)
                .unwrap()
                .len(),
            1
        );

        let one_signature = vec![vec![valid[0][0].clone()]];
        assert!(
            MultiSig::finish_ft_transaction(&unsigned, &one_signature, &fixture.public_keys)
                .is_err()
        );
        let duplicate = vec![vec![valid[0][0].clone(), valid[0][0].clone()]];
        assert!(
            MultiSig::finish_ft_transaction(&unsigned, &duplicate, &fixture.public_keys).is_err()
        );
        let malformed = vec![vec![valid[0][0].clone(), vec![0x30, 0x01, 0x00, 0x41]]];
        assert!(
            MultiSig::finish_ft_transaction(&unsigned, &malformed, &fixture.public_keys).is_err()
        );
        let mut bad_hashtype = valid.clone();
        *bad_hashtype[0][1].last_mut().unwrap() = 0x01;
        assert!(
            MultiSig::finish_ft_transaction(&unsigned, &bad_hashtype, &fixture.public_keys)
                .is_err()
        );
        let outsider = PrivateKey::from_slice(&[87u8; 32]).unwrap();
        let outsider_signature =
            MultiSig::sign_ft_transaction(&fixture.address, &unsigned, &outsider).unwrap();
        let unknown = vec![vec![valid[0][0].clone(), outsider_signature[0].clone()]];
        assert!(
            MultiSig::finish_ft_transaction(&unsigned, &unknown, &fixture.public_keys).is_err()
        );
        let surplus = fixture.sign_ft(&unsigned, &[0, 1, 2]);
        assert!(
            MultiSig::finish_ft_transaction(&unsigned, &surplus, &fixture.public_keys).is_err()
        );
        let mut wrong_keys = fixture.public_keys.clone();
        wrong_keys[2] = PrivateKey::from_slice(&[88u8; 32]).unwrap().public_key();
        assert!(MultiSig::finish_ft_transaction(&unsigned, &valid, &wrong_keys).is_err());

        let other_keys = [[89u8; 32], [90u8; 32], [91u8; 32]]
            .into_iter()
            .map(|bytes| PrivateKey::from_slice(&bytes).unwrap().public_key())
            .collect::<Vec<_>>();
        let other_address = MultiSig::address(&other_keys, 2).unwrap();
        assert!(
            MultiSig::sign_ft_transaction(&other_address, &unsigned, &fixture.private_keys[0])
                .is_err()
        );
    }
}
