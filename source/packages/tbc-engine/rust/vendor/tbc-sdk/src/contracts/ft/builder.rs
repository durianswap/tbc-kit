use crate::{
    Address, DEFAULT_FEE_RATE_SAT_PER_KB, DEFAULT_SIGHASH, Error, PrivateKey, Result, SDK_DUST_SAT,
    Transaction, TxIn, TxOut, Utxo,
    builder::{ChangePolicy, finalize_signed_fee},
    script::Script,
};

use super::{
    BatchFtTx, Ft, FtReceiver, FtUtxo, MintFtTx,
    amount::{build_multi_tape_amounts, build_tape_amount},
    scripts::{
        FT_CODE_SATOSHIS, FT_MINT_SOURCE_SATOSHIS, FT_TAPE_SATOSHIS, FtCodeReceiver, FtMintVersion,
        mint_code_script_with_version, mint_source_script, mint_tape_script, transfer_code_script,
        transfer_tape_script,
    },
    unlock::{
        contract_tx_data, current_inputs_data, current_tx_data, pre_pre_tx_data, pre_tx_data,
    },
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FtTransferOptions {
    pub coin_mode: bool,
    pub lock_time: u32,
    pub ft_sequence: u32,
}

impl FtTransferOptions {
    pub(crate) fn standard() -> Self {
        Self {
            coin_mode: false,
            lock_time: crate::DEFAULT_LOCK_TIME,
            ft_sequence: crate::DEFAULT_SEQUENCE,
        }
    }
}

#[derive(Clone, Debug)]
struct FtSpendContext {
    ft_utxo: FtUtxo,
    pre_tx: Transaction,
    pre_pre_tx_data: Vec<u8>,
}

impl Ft {
    pub fn mint_ft(
        &mut self,
        private_key: PrivateKey,
        address_to: Address,
        funding_utxo: Utxo,
    ) -> Result<MintFtTx> {
        self.mint_ft_with_version(private_key, address_to, funding_utxo, FtMintVersion::V4)
    }

    pub fn mint_ft_with_version(
        &mut self,
        private_key: PrivateKey,
        address_to: Address,
        funding_utxo: Utxo,
        version: FtMintVersion,
    ) -> Result<MintFtTx> {
        let mut amount = [0u8; 48];
        amount[0..8].copy_from_slice(&u64_slot(self.total_supply_raw)?.to_le_bytes());
        let tape_script = mint_tape_script(&amount, self.decimal, &self.name, &self.symbol);
        let source_outputs = vec![
            TxOut {
                satoshis: FT_MINT_SOURCE_SATOSHIS,
                script_pubkey: mint_source_script(&private_key.address()),
            },
            TxOut {
                satoshis: FT_TAPE_SATOSHIS,
                script_pubkey: tape_script.clone(),
            },
        ];
        let source = build_funding_tx(
            &[funding_utxo],
            &source_outputs,
            &private_key.address(),
            DEFAULT_FEE_RATE_SAT_PER_KB,
        )?;
        let code_script = mint_code_script_with_version(
            &source.txid().to_string(),
            0,
            &address_to,
            tape_script.as_bytes().len(),
            version,
        )?;
        let mint_outputs = vec![
            TxOut {
                satoshis: FT_CODE_SATOSHIS,
                script_pubkey: code_script.clone(),
            },
            TxOut {
                satoshis: FT_TAPE_SATOSHIS,
                script_pubkey: tape_script.clone(),
            },
        ];
        let mint = build_contract_first_tx(
            &source,
            0,
            &private_key,
            &mint_outputs,
            &private_key.address(),
            DEFAULT_FEE_RATE_SAT_PER_KB,
        )?;

        self.code_script = hex::encode(code_script.as_bytes());
        self.tape_script = hex::encode(tape_script.as_bytes());
        self.contract_txid = mint.txid().to_string();
        Ok(MintFtTx { source, mint })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn transfer(
        &self,
        private_key: PrivateKey,
        address_to: Address,
        amount_raw: u128,
        ft_utxos: Vec<FtUtxo>,
        fee_utxo: Utxo,
        pre_txs: Vec<Transaction>,
        pre_pre_tx_data_set: Vec<Vec<u8>>,
        tbc_amount_sat: Option<u64>,
    ) -> Result<Transaction> {
        self.transfer_with_options(
            private_key,
            address_to,
            amount_raw,
            ft_utxos,
            fee_utxo,
            pre_txs,
            pre_pre_tx_data_set,
            tbc_amount_sat,
            FtTransferOptions::standard(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn transfer_with_options(
        &self,
        private_key: PrivateKey,
        address_to: Address,
        amount_raw: u128,
        ft_utxos: Vec<FtUtxo>,
        fee_utxo: Utxo,
        pre_txs: Vec<Transaction>,
        pre_pre_tx_data_set: Vec<Vec<u8>>,
        tbc_amount_sat: Option<u64>,
        options: FtTransferOptions,
    ) -> Result<Transaction> {
        if ft_utxos.is_empty() {
            return Err(Error::InvalidUtxo(
                "at least one FT UTXO is required".to_string(),
            ));
        }
        if ft_utxos.len() > 5 {
            return Err(Error::InvalidUtxo(
                "at most five FT inputs are supported".to_string(),
            ));
        }
        if pre_txs.len() != ft_utxos.len() || pre_pre_tx_data_set.len() != ft_utxos.len() {
            return Err(Error::InvalidUtxo(
                "FT ancestry data length must match FT UTXO length".to_string(),
            ));
        }

        let input_balances = ft_utxos
            .iter()
            .map(|utxo| utxo.ft_balance_raw)
            .collect::<Vec<_>>();
        let total_ft = input_balances.iter().try_fold(0u128, |sum, amount| {
            sum.checked_add(*amount)
                .ok_or_else(|| Error::InvalidUtxo("FT amount overflow".to_string()))
        })?;
        let (amount_tape, change_tape) = build_tape_amount(amount_raw, &input_balances)?;
        let code_script = Script::from_bytes(hex::decode(&self.code_script)?);
        let tape_script = Script::from_bytes(hex::decode(&self.tape_script)?);

        let mut outputs = vec![
            TxOut {
                satoshis: FT_CODE_SATOSHIS,
                script_pubkey: transfer_code_script(
                    &code_script,
                    FtCodeReceiver::Address(address_to.clone()),
                )?,
            },
            TxOut {
                satoshis: FT_TAPE_SATOSHIS,
                script_pubkey: transfer_tape_script(&tape_script, &amount_tape)?,
            },
        ];
        if let Some(tbc_amount_sat) = tbc_amount_sat {
            if tbc_amount_sat < SDK_DUST_SAT {
                return Err(Error::DustOutput(tbc_amount_sat));
            }
            outputs.push(TxOut {
                satoshis: tbc_amount_sat,
                script_pubkey: address_to.script_pubkey(),
            });
        }
        if amount_raw < total_ft {
            outputs.push(TxOut {
                satoshis: FT_CODE_SATOSHIS,
                script_pubkey: transfer_code_script(
                    &code_script,
                    FtCodeReceiver::Address(private_key.address()),
                )?,
            });
            outputs.push(TxOut {
                satoshis: FT_TAPE_SATOSHIS,
                script_pubkey: transfer_tape_script(&tape_script, &change_tape)?,
            });
        }

        build_ft_transfer_tx(
            &private_key,
            &ft_utxos,
            &fee_utxo,
            &pre_txs,
            &pre_pre_tx_data_set,
            &outputs,
            options,
        )
    }

    pub fn batch_transfer(
        &self,
        private_key: PrivateKey,
        receivers: Vec<FtReceiver>,
        ft_utxos: Vec<FtUtxo>,
        fee_utxo: Utxo,
        pre_txs: Vec<Transaction>,
        pre_pre_tx_data_set: Vec<Vec<u8>>,
    ) -> Result<Vec<BatchFtTx>> {
        self.batch_transfer_with_options(
            private_key,
            receivers,
            ft_utxos,
            fee_utxo,
            pre_txs,
            pre_pre_tx_data_set,
            FtTransferOptions::standard(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn batch_transfer_with_options(
        &self,
        private_key: PrivateKey,
        receivers: Vec<FtReceiver>,
        ft_utxos: Vec<FtUtxo>,
        fee_utxo: Utxo,
        pre_txs: Vec<Transaction>,
        pre_pre_tx_data_set: Vec<Vec<u8>>,
        options: FtTransferOptions,
    ) -> Result<Vec<BatchFtTx>> {
        if receivers.is_empty() {
            return Err(Error::InvalidUtxo(
                "at least one FT receiver is required".to_string(),
            ));
        }
        if ft_utxos.is_empty() {
            return Err(Error::InvalidUtxo(
                "at least one FT UTXO is required".to_string(),
            ));
        }
        if ft_utxos.len() > 5 {
            return Err(Error::InvalidUtxo(
                "at most five FT inputs are supported".to_string(),
            ));
        }
        if pre_txs.len() != ft_utxos.len() || pre_pre_tx_data_set.len() != ft_utxos.len() {
            return Err(Error::InvalidUtxo(
                "FT ancestry data length must match FT UTXO length".to_string(),
            ));
        }

        let mut current_ft_utxos = ft_utxos;
        let mut current_fee_utxo = fee_utxo;
        let mut current_pre_txs = pre_txs;
        let mut current_pre_pre_tx_data_set = pre_pre_tx_data_set;
        let mut remaining_raw = checked_sum_u128(
            &current_ft_utxos
                .iter()
                .map(|utxo| utxo.ft_balance_raw)
                .collect::<Vec<_>>(),
            "FT amount overflow",
        )?;
        let total_send_raw = checked_sum_u128(
            &receivers
                .iter()
                .map(|receiver| receiver.amount_raw)
                .collect::<Vec<_>>(),
            "FT amount overflow",
        )?;
        if total_send_raw > remaining_raw {
            return Err(Error::InsufficientFunds {
                input: remaining_raw.min(u64::MAX as u128) as u64,
                required: u64_slot(total_send_raw)?,
            });
        }

        let mut results = Vec::new();
        for batch in receivers.chunks(5) {
            let input_balances = current_ft_utxos
                .iter()
                .map(|utxo| utxo.ft_balance_raw)
                .collect::<Vec<_>>();
            let outputs =
                build_batch_outputs(self, &private_key, batch, &input_balances, remaining_raw)?;
            let tx = build_ft_transfer_tx(
                &private_key,
                &current_ft_utxos,
                &current_fee_utxo,
                &current_pre_txs,
                &current_pre_pre_tx_data_set,
                &outputs,
                options,
            )?;
            let txid = tx.txid().to_string();
            results.push(BatchFtTx {
                txraw: tx.to_hex(),
                txid,
            });

            let batch_sent_raw = checked_sum_u128(
                &batch
                    .iter()
                    .map(|receiver| receiver.amount_raw)
                    .collect::<Vec<_>>(),
                "FT amount overflow",
            )?;
            remaining_raw = remaining_raw.checked_sub(batch_sent_raw).ok_or_else(|| {
                Error::InvalidUtxo("FT batch remaining amount underflow".to_string())
            })?;
            if remaining_raw == 0 {
                continue;
            }

            let ft_change_index = batch.len() * 2;
            let tbc_change_index = ft_change_index + 2;
            let next_pre_pre_tx_data = chained_pre_pre_data(&current_pre_txs, &current_ft_utxos)?;
            let ft_change_output = tx.outputs.get(ft_change_index).ok_or_else(|| {
                Error::InvalidUtxo("missing chained FT batch change output".to_string())
            })?;
            let tbc_change_output = tx.outputs.get(tbc_change_index).ok_or_else(|| {
                Error::InvalidUtxo("missing chained FT batch TBC change output".to_string())
            })?;
            current_ft_utxos = vec![FtUtxo {
                base: Utxo {
                    outpoint: crate::OutPoint {
                        txid: tx.txid(),
                        vout: ft_change_index as u32,
                    },
                    satoshis: ft_change_output.satoshis,
                    script_pubkey: ft_change_output.script_pubkey.clone(),
                    private_key: private_key.clone(),
                },
                ft_balance_raw: remaining_raw,
            }];
            current_fee_utxo = Utxo {
                outpoint: crate::OutPoint {
                    txid: tx.txid(),
                    vout: tbc_change_index as u32,
                },
                satoshis: tbc_change_output.satoshis,
                script_pubkey: tbc_change_output.script_pubkey.clone(),
                private_key: private_key.clone(),
            };
            current_pre_txs = vec![tx];
            current_pre_pre_tx_data_set = vec![next_pre_pre_tx_data];
        }

        Ok(results)
    }

    pub fn merge_ft(
        &self,
        private_key: PrivateKey,
        ft_utxos: Vec<FtUtxo>,
        fee_utxo: Utxo,
        pre_txs: Vec<Transaction>,
        pre_pre_tx_data_set: Vec<Vec<u8>>,
    ) -> Result<Vec<Transaction>> {
        self.merge_ft_with_options(
            private_key,
            ft_utxos,
            fee_utxo,
            pre_txs,
            pre_pre_tx_data_set,
            FtTransferOptions::standard(),
        )
    }

    pub(crate) fn merge_ft_with_options(
        &self,
        private_key: PrivateKey,
        ft_utxos: Vec<FtUtxo>,
        fee_utxo: Utxo,
        pre_txs: Vec<Transaction>,
        pre_pre_tx_data_set: Vec<Vec<u8>>,
        options: FtTransferOptions,
    ) -> Result<Vec<Transaction>> {
        if ft_utxos.len() <= 1 {
            return Ok(Vec::new());
        }
        if pre_txs.len() != ft_utxos.len() || pre_pre_tx_data_set.len() != ft_utxos.len() {
            return Err(Error::InvalidUtxo(
                "FT ancestry data length must match FT UTXO length".to_string(),
            ));
        }

        let mut candidates = ft_utxos
            .into_iter()
            .zip(pre_txs)
            .zip(pre_pre_tx_data_set)
            .map(|((ft_utxo, pre_tx), pre_pre_tx_data)| FtSpendContext {
                ft_utxo,
                pre_tx,
                pre_pre_tx_data,
            })
            .collect::<Vec<_>>();
        let mut current_fee_utxo = fee_utxo;
        let mut txs = Vec::new();

        while candidates.len() > 1 {
            let mut next_candidates = Vec::new();
            for chunk in candidates.chunks(5) {
                if chunk.len() == 1 {
                    next_candidates.push(chunk[0].clone());
                    continue;
                }

                let ft_utxos = chunk
                    .iter()
                    .map(|context| context.ft_utxo.clone())
                    .collect::<Vec<_>>();
                let pre_txs = chunk
                    .iter()
                    .map(|context| context.pre_tx.clone())
                    .collect::<Vec<_>>();
                let pre_pre_tx_data_set = chunk
                    .iter()
                    .map(|context| context.pre_pre_tx_data.clone())
                    .collect::<Vec<_>>();
                let merged_raw = checked_sum_u128(
                    &ft_utxos
                        .iter()
                        .map(|utxo| utxo.ft_balance_raw)
                        .collect::<Vec<_>>(),
                    "FT amount overflow",
                )?;
                let outputs = build_merge_outputs(self, &private_key, &ft_utxos)?;
                let tx = build_ft_transfer_tx(
                    &private_key,
                    &ft_utxos,
                    &current_fee_utxo,
                    &pre_txs,
                    &pre_pre_tx_data_set,
                    &outputs,
                    options,
                )?;
                let next_pre_pre_tx_data = chained_pre_pre_data(&pre_txs, &ft_utxos)?;
                let merged_output = tx.outputs.first().ok_or_else(|| {
                    Error::InvalidUtxo("missing chained FT merge output".to_string())
                })?;
                let fee_output = tx.outputs.get(2).ok_or_else(|| {
                    Error::InvalidUtxo("missing chained FT merge TBC change output".to_string())
                })?;

                current_fee_utxo = Utxo {
                    outpoint: crate::OutPoint {
                        txid: tx.txid(),
                        vout: 2,
                    },
                    satoshis: fee_output.satoshis,
                    script_pubkey: fee_output.script_pubkey.clone(),
                    private_key: private_key.clone(),
                };
                next_candidates.push(FtSpendContext {
                    ft_utxo: FtUtxo {
                        base: Utxo {
                            outpoint: crate::OutPoint {
                                txid: tx.txid(),
                                vout: 0,
                            },
                            satoshis: merged_output.satoshis,
                            script_pubkey: merged_output.script_pubkey.clone(),
                            private_key: private_key.clone(),
                        },
                        ft_balance_raw: merged_raw,
                    },
                    pre_tx: tx.clone(),
                    pre_pre_tx_data: next_pre_pre_tx_data,
                });
                txs.push(tx);
            }
            candidates = next_candidates;
        }

        Ok(txs)
    }
}

fn build_batch_outputs(
    ft: &Ft,
    private_key: &PrivateKey,
    receivers: &[FtReceiver],
    input_balances: &[u128],
    total_input_raw: u128,
) -> Result<Vec<TxOut>> {
    let receiver_amounts = receivers
        .iter()
        .map(|receiver| receiver.amount_raw)
        .collect::<Vec<_>>();
    let total_out = checked_sum_u128(&receiver_amounts, "FT amount overflow")?;
    let tapes = build_multi_tape_amounts(&receiver_amounts, input_balances)?;
    let code_script = Script::from_bytes(hex::decode(&ft.code_script)?);
    let tape_script = Script::from_bytes(hex::decode(&ft.tape_script)?);

    let mut outputs = Vec::new();
    for (index, receiver) in receivers.iter().enumerate() {
        outputs.push(TxOut {
            satoshis: FT_CODE_SATOSHIS,
            script_pubkey: transfer_code_script(
                &code_script,
                FtCodeReceiver::Address(receiver.address.clone()),
            )?,
        });
        outputs.push(TxOut {
            satoshis: FT_TAPE_SATOSHIS,
            script_pubkey: transfer_tape_script(&tape_script, &tapes[index])?,
        });
    }
    if total_out < total_input_raw {
        outputs.push(TxOut {
            satoshis: FT_CODE_SATOSHIS,
            script_pubkey: transfer_code_script(
                &code_script,
                FtCodeReceiver::Address(private_key.address()),
            )?,
        });
        outputs.push(TxOut {
            satoshis: FT_TAPE_SATOSHIS,
            script_pubkey: transfer_tape_script(
                &tape_script,
                tapes.last().ok_or_else(|| {
                    Error::InvalidUtxo("missing FT batch change tape".to_string())
                })?,
            )?,
        });
    }
    Ok(outputs)
}

fn build_merge_outputs(
    ft: &Ft,
    private_key: &PrivateKey,
    ft_utxos: &[FtUtxo],
) -> Result<Vec<TxOut>> {
    let input_balances = ft_utxos
        .iter()
        .map(|utxo| utxo.ft_balance_raw)
        .collect::<Vec<_>>();
    let total = checked_sum_u128(&input_balances, "FT amount overflow")?;
    let (merged_tape, _) = build_tape_amount(total, &input_balances)?;
    let code_script = Script::from_bytes(hex::decode(&ft.code_script)?);
    let tape_script = Script::from_bytes(hex::decode(&ft.tape_script)?);
    Ok(vec![
        TxOut {
            satoshis: FT_CODE_SATOSHIS,
            script_pubkey: transfer_code_script(
                &code_script,
                FtCodeReceiver::Address(private_key.address()),
            )?,
        },
        TxOut {
            satoshis: FT_TAPE_SATOSHIS,
            script_pubkey: transfer_tape_script(&tape_script, &merged_tape)?,
        },
    ])
}

fn chained_pre_pre_data(pre_txs: &[Transaction], ft_utxos: &[FtUtxo]) -> Result<Vec<u8>> {
    if pre_txs.len() != ft_utxos.len() {
        return Err(Error::InvalidUtxo(
            "FT chained ancestry length mismatch".to_string(),
        ));
    }
    let mut data = vec![0x57];
    let mut chunks = Vec::new();
    for (pre_tx, ft_utxo) in pre_txs.iter().zip(ft_utxos) {
        chunks.push(pre_pre_tx_data(
            pre_tx,
            ft_utxo.base.outpoint.vout as usize,
        )?);
    }
    for chunk in chunks.into_iter().rev() {
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}

fn build_ft_transfer_tx(
    private_key: &PrivateKey,
    ft_utxos: &[FtUtxo],
    fee_utxo: &Utxo,
    pre_txs: &[Transaction],
    pre_pre_tx_data_set: &[Vec<u8>],
    outputs: &[TxOut],
    options: FtTransferOptions,
) -> Result<Transaction> {
    let input_sum = ft_utxos
        .iter()
        .try_fold(0u64, |sum, utxo| sum.checked_add(utxo.base.satoshis))
        .and_then(|sum| sum.checked_add(fee_utxo.satoshis))
        .ok_or_else(|| Error::InvalidUtxo("input amount overflow".to_string()))?;
    let output_sum = sum_outputs(outputs)?;
    finalize_signed_fee(
        input_sum,
        output_sum,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        ChangePolicy::Optional { dust: SDK_DUST_SAT },
        |change| {
            sign_ft_transfer_tx(
                private_key,
                ft_utxos,
                fee_utxo,
                pre_txs,
                pre_pre_tx_data_set,
                outputs,
                change,
                options,
            )
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn sign_ft_transfer_tx(
    private_key: &PrivateKey,
    ft_utxos: &[FtUtxo],
    fee_utxo: &Utxo,
    pre_txs: &[Transaction],
    pre_pre_tx_data_set: &[Vec<u8>],
    outputs: &[TxOut],
    change: Option<u64>,
    options: FtTransferOptions,
) -> Result<Transaction> {
    let mut tx = Transaction::new();
    tx.lock_time = options.lock_time;
    for utxo in ft_utxos {
        tx.inputs.push(TxIn::new(utxo.base.outpoint.clone()));
    }
    tx.inputs.push(TxIn::new(fee_utxo.outpoint.clone()));
    tx.outputs.extend_from_slice(outputs);
    if let Some(change) = change {
        tx.outputs.push(TxOut {
            satoshis: change,
            script_pubkey: private_key.address().script_pubkey(),
        });
    }

    for input in tx.inputs.iter_mut().take(ft_utxos.len()) {
        input.sequence = options.ft_sequence;
    }
    for (index, ft_utxo) in ft_utxos.iter().enumerate() {
        sign_ft_input(
            &mut tx,
            index,
            private_key,
            ft_utxo,
            &pre_txs[index],
            &pre_pre_tx_data_set[index],
            options.coin_mode,
        )?;
    }
    tx.sign_p2pkh_input(
        ft_utxos.len(),
        &fee_utxo.private_key,
        &fee_utxo.script_pubkey,
        fee_utxo.satoshis,
        DEFAULT_SIGHASH,
    )?;
    Ok(tx)
}

pub(crate) fn sign_ft_input(
    tx: &mut Transaction,
    input_index: usize,
    private_key: &PrivateKey,
    ft_utxo: &FtUtxo,
    pre_tx: &Transaction,
    pre_pre_tx_data_bytes: &[u8],
    coin_mode: bool,
) -> Result<()> {
    let signature = tx.signature_with_hashtype(
        input_index,
        private_key,
        &ft_utxo.base.script_pubkey,
        ft_utxo.base.satoshis,
        DEFAULT_SIGHASH,
    )?;
    let public_key = private_key.public_key().to_bytes();
    let mut script = current_tx_data(tx, input_index)?;
    script.extend_from_slice(pre_pre_tx_data_bytes);
    push_script_data(&mut script, &signature)?;
    push_script_data(&mut script, &public_key)?;
    if coin_mode {
        script.push(crate::script::opcodes::OP_0);
    }
    script.extend_from_slice(&pre_tx_data(pre_tx, ft_utxo.base.outpoint.vout as usize)?);
    tx.inputs[input_index].script_sig = Script::from_bytes(script);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn sign_ft_swap_input(
    tx: &mut Transaction,
    input_index: usize,
    private_key: &PrivateKey,
    ft_utxo: &FtUtxo,
    pre_tx: &Transaction,
    pre_pre_tx_data_bytes: &[u8],
    contract_tx: &Transaction,
    ft_version: u8,
    coin_mode: bool,
) -> Result<()> {
    let signature = tx.signature_with_hashtype(
        input_index,
        private_key,
        &ft_utxo.base.script_pubkey,
        ft_utxo.base.satoshis,
        DEFAULT_SIGHASH,
    )?;
    let public_key = private_key.public_key().to_bytes();
    let contract_vout = if ft_version > 1 {
        -1
    } else {
        tx.inputs
            .first()
            .map(|input| input.previous_output.vout as i32)
            .unwrap_or_default()
    };
    let mut script = current_tx_data(tx, input_index)?;
    script.extend_from_slice(pre_pre_tx_data_bytes);
    push_script_data(&mut script, &signature)?;
    push_script_data(&mut script, &public_key)?;
    script.extend_from_slice(&current_inputs_data(tx)?);
    script.extend_from_slice(&contract_tx_data(contract_tx, contract_vout)?);
    if ft_version > 2 {
        script.push(ft_swap_input_index_tag(0)?);
    }
    if coin_mode {
        script.push(crate::script::opcodes::OP_1);
    }
    script.extend_from_slice(&pre_tx_data(pre_tx, ft_utxo.base.outpoint.vout as usize)?);
    tx.inputs[input_index].script_sig = Script::from_bytes(script);
    Ok(())
}

fn ft_swap_input_index_tag(input_index: usize) -> Result<u8> {
    match input_index {
        0 => Ok(0x00),
        1..=5 => Ok(0x50 + input_index as u8),
        _ => Err(Error::InvalidUtxo(
            "FT swap input index must be in the range 0..=5".to_string(),
        )),
    }
}

fn build_funding_tx(
    funding_utxos: &[Utxo],
    outputs: &[TxOut],
    change_address: &Address,
    fee_rate: u64,
) -> Result<Transaction> {
    if funding_utxos.is_empty() {
        return Err(Error::InvalidUtxo(
            "at least one funding UTXO is required".to_string(),
        ));
    }
    let input_sum = sum_utxos(funding_utxos)?;
    let output_sum = sum_outputs(outputs)?;
    finalize_signed_fee(
        input_sum,
        output_sum,
        fee_rate,
        fee_rate,
        ChangePolicy::Optional { dust: SDK_DUST_SAT },
        |change| sign_funding_tx(funding_utxos, outputs, change_address, change),
    )
}

fn build_contract_first_tx(
    source_tx: &Transaction,
    source_vout: u32,
    private_key: &PrivateKey,
    outputs: &[TxOut],
    change_address: &Address,
    fee_rate: u64,
) -> Result<Transaction> {
    let source_output = source_tx
        .outputs
        .get(source_vout as usize)
        .ok_or_else(|| Error::InvalidUtxo("source output index out of range".to_string()))?;
    let input_sum = source_output.satoshis;
    let output_sum = sum_outputs(outputs)?;
    finalize_signed_fee(
        input_sum,
        output_sum,
        fee_rate,
        fee_rate,
        ChangePolicy::Optional { dust: SDK_DUST_SAT },
        |change| {
            sign_contract_first_tx(
                source_tx,
                source_vout,
                private_key,
                outputs,
                change_address,
                change,
            )
        },
    )
}

fn sign_funding_tx(
    funding_utxos: &[Utxo],
    outputs: &[TxOut],
    change_address: &Address,
    change: Option<u64>,
) -> Result<Transaction> {
    let mut tx = Transaction::new();
    for utxo in funding_utxos {
        tx.inputs.push(TxIn::new(utxo.outpoint.clone()));
    }
    tx.outputs.extend_from_slice(outputs);
    if let Some(change) = change {
        tx.outputs.push(TxOut {
            satoshis: change,
            script_pubkey: change_address.script_pubkey(),
        });
    }
    for (index, utxo) in funding_utxos.iter().enumerate() {
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

fn sign_contract_first_tx(
    source_tx: &Transaction,
    source_vout: u32,
    private_key: &PrivateKey,
    outputs: &[TxOut],
    change_address: &Address,
    change: Option<u64>,
) -> Result<Transaction> {
    let source_output = source_tx
        .outputs
        .get(source_vout as usize)
        .ok_or_else(|| Error::InvalidUtxo("source output index out of range".to_string()))?;
    let mut tx = Transaction::new();
    tx.add_input_from_prev_tx(source_tx, source_vout)?;
    tx.outputs.extend_from_slice(outputs);
    if let Some(change) = change {
        tx.outputs.push(TxOut {
            satoshis: change,
            script_pubkey: change_address.script_pubkey(),
        });
    }
    tx.sign_p2pkh_input(
        0,
        private_key,
        &source_output.script_pubkey,
        source_output.satoshis,
        DEFAULT_SIGHASH,
    )?;
    Ok(tx)
}

pub(crate) fn push_script_data(out: &mut Vec<u8>, data: &[u8]) -> Result<()> {
    match data.len() {
        0..=75 => out.push(data.len() as u8),
        76..=0xff => {
            out.push(crate::script::opcodes::OP_PUSHDATA1);
            out.push(data.len() as u8);
        }
        _ => {
            return Err(Error::InvalidScript(
                "FT unlock push data exceeds supported length".to_string(),
            ));
        }
    }
    out.extend_from_slice(data);
    Ok(())
}

fn sum_utxos(utxos: &[Utxo]) -> Result<u64> {
    utxos
        .iter()
        .try_fold(0u64, |sum, utxo| sum.checked_add(utxo.satoshis))
        .ok_or_else(|| Error::InvalidUtxo("input amount overflow".to_string()))
}

fn sum_outputs(outputs: &[TxOut]) -> Result<u64> {
    outputs
        .iter()
        .try_fold(0u64, |sum, output| sum.checked_add(output.satoshis))
        .ok_or_else(|| Error::InvalidUtxo("output amount overflow".to_string()))
}

fn u64_slot(value: u128) -> Result<u64> {
    u64::try_from(value).map_err(|_| Error::InvalidUtxo("FT amount exceeds u64 slot".to_string()))
}

fn checked_sum_u128(values: &[u128], message: &str) -> Result<u128> {
    values.iter().try_fold(0u128, |sum, value| {
        sum.checked_add(*value)
            .ok_or_else(|| Error::InvalidUtxo(message.to_string()))
    })
}

#[cfg(test)]
mod tests {
    use super::super::{
        Ft, FtReceiver, FtUtxo,
        scripts::{self, FT_CODE_SATOSHIS, FT_MINT_SOURCE_SATOSHIS, FT_TAPE_SATOSHIS},
    };

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

    fn test_utxo(key: &crate::PrivateKey, satoshis: u64, vout: u32) -> crate::Utxo {
        crate::Utxo {
            outpoint: crate::OutPoint {
                txid: "0101010101010101010101010101010101010101010101010101010101010101"
                    .parse()
                    .unwrap(),
                vout,
            },
            satoshis,
            script_pubkey: key.address().script_pubkey(),
            private_key: key.clone(),
        }
    }

    fn fixture_ft(key: &crate::PrivateKey) -> Ft {
        let tape = scripts::mint_tape_script(&[0u8; 48], 6, "Token", "TOK");
        let code = crate::script::Script::from_asm(&format!(
            "OP_RETURN 0x15 0x{}00 0x05 0x32436f6465",
            hex::encode(key.address().hash160())
        ))
        .unwrap();
        let mut ft = Ft::new("Token".to_string(), "TOK".to_string(), 1_000, 6).unwrap();
        ft.code_script = hex::encode(code.as_bytes());
        ft.tape_script = hex::encode(tape.as_bytes());
        ft
    }

    #[test]
    fn ft_mint_builds_source_and_mint_transactions() {
        let key = crate::PrivateKey::from_slice(&[31u8; 32]).unwrap();
        let mut ft = Ft::new("Token".to_string(), "TOK".to_string(), 1_000_000, 6).unwrap();

        let minted = ft
            .mint_ft(key.clone(), key.address(), test_utxo(&key, 100_000, 0))
            .unwrap();

        assert_eq!(minted.source.outputs[0].satoshis, FT_MINT_SOURCE_SATOSHIS);
        assert_eq!(minted.source.outputs[1].satoshis, FT_TAPE_SATOSHIS);
        assert_eq!(minted.mint.outputs[0].satoshis, FT_CODE_SATOSHIS);
        assert_eq!(minted.mint.outputs[1].satoshis, FT_TAPE_SATOSHIS);
        assert!(!ft.code_script.is_empty());
        assert!(!ft.tape_script.is_empty());
        assert_eq!(ft.contract_txid, minted.mint.txid().to_string());
    }

    #[test]
    fn ft_mint_never_underpays_after_signature_size_oscillation() {
        let key = crate::PrivateKey::from_slice(&[1u8; 32]).unwrap();
        let mut ft = Ft::new("N".repeat(17), "FT".to_string(), 1_000_000, 6).unwrap();
        let mut funding_utxo = test_utxo(&key, 100_000, 0);
        let mut txid = [0u8; 32];
        txid[0] = 1;
        txid[1] = 17;
        funding_utxo.outpoint.txid = crate::Txid::from_le_bytes(txid);

        let minted = ft
            .mint_ft(key.clone(), key.address(), funding_utxo)
            .unwrap();

        assert_target_fee(&minted.source, 100_000);
        assert_target_fee(&minted.mint, minted.source.outputs[0].satoshis);
    }

    #[test]
    fn ft_transfer_builds_code_tape_and_change_outputs() {
        let key = crate::PrivateKey::from_slice(&[32u8; 32]).unwrap();
        let receiver = crate::PrivateKey::from_slice(&[33u8; 32])
            .unwrap()
            .address();
        let ft = fixture_ft(&key);
        let code_script = crate::script::Script::from_bytes(hex::decode(&ft.code_script).unwrap());
        let tape_script = crate::script::Script::from_bytes(hex::decode(&ft.tape_script).unwrap());

        let mut pre_tx = crate::Transaction::new();
        pre_tx.outputs.push(crate::TxOut {
            satoshis: FT_CODE_SATOSHIS,
            script_pubkey: code_script.clone(),
        });
        pre_tx.outputs.push(crate::TxOut {
            satoshis: FT_TAPE_SATOSHIS,
            script_pubkey: tape_script,
        });

        let ft_utxo = FtUtxo {
            base: crate::Utxo {
                outpoint: crate::OutPoint {
                    txid: pre_tx.txid(),
                    vout: 0,
                },
                satoshis: FT_CODE_SATOSHIS,
                script_pubkey: code_script,
                private_key: key.clone(),
            },
            ft_balance_raw: 1_000,
        };

        let tx = ft
            .transfer(
                key.clone(),
                receiver,
                400,
                vec![ft_utxo],
                test_utxo(&key, 100_000, 1),
                vec![pre_tx],
                vec![vec![0x52]],
                None,
            )
            .unwrap();

        assert_eq!(tx.outputs[0].satoshis, FT_CODE_SATOSHIS);
        assert_eq!(tx.outputs[1].satoshis, FT_TAPE_SATOSHIS);
        assert_eq!(tx.outputs[2].satoshis, FT_CODE_SATOSHIS);
        assert_eq!(tx.outputs[3].satoshis, FT_TAPE_SATOSHIS);
        assert_eq!(tx.inputs[0].script_sig.as_bytes()[0], 0x51);
    }

    #[test]
    fn ft_transfer_options_support_coin_sequence_locktime_and_unlock_marker() {
        let key = crate::PrivateKey::from_slice(&[41u8; 32]).unwrap();
        let receiver = crate::PrivateKey::from_slice(&[42u8; 32])
            .unwrap()
            .address();
        let ft = fixture_ft(&key);
        let (ft_utxo, pre_tx) = fixture_ft_utxo_and_pre_tx(&ft, &key, 1_000);

        let tx = ft
            .transfer_with_options(
                key.clone(),
                receiver,
                400,
                vec![ft_utxo],
                test_utxo(&key, 100_000, 9),
                vec![pre_tx],
                vec![vec![0x52]],
                None,
                super::FtTransferOptions {
                    coin_mode: true,
                    lock_time: 1_700_000_000,
                    ft_sequence: 0xffff_fffe,
                },
            )
            .unwrap();

        assert_eq!(tx.lock_time, 1_700_000_000);
        assert_eq!(tx.inputs[0].sequence, 0xffff_fffe);
        let script = tx.inputs[0].script_sig.as_bytes();
        let pubkey_pos = script
            .windows(34)
            .position(|window| window[0] == 33 && matches!(window[1], 0x02 | 0x03))
            .unwrap();
        assert_eq!(script[pubkey_pos + 34], 0);
    }

    #[test]
    fn ft_batch_transfer_builds_code_tape_pair_per_receiver_and_change() {
        let key = crate::PrivateKey::from_slice(&[34u8; 32]).unwrap();
        let receiver1 = crate::PrivateKey::from_slice(&[35u8; 32])
            .unwrap()
            .address();
        let receiver2 = crate::PrivateKey::from_slice(&[36u8; 32])
            .unwrap()
            .address();
        let ft = fixture_ft(&key);
        let (ft_utxo, pre_tx) = fixture_ft_utxo_and_pre_tx(&ft, &key, 1_000);

        let txs = ft
            .batch_transfer(
                key.clone(),
                vec![
                    FtReceiver {
                        address: receiver1,
                        amount_raw: 200,
                    },
                    FtReceiver {
                        address: receiver2,
                        amount_raw: 300,
                    },
                ],
                vec![ft_utxo],
                test_utxo(&key, 100_000, 2),
                vec![pre_tx],
                vec![vec![0x52]],
            )
            .unwrap();

        assert_eq!(txs.len(), 1);
        let tx = crate::Transaction::from_hex(&txs[0].txraw).unwrap();
        assert_eq!(tx.outputs[0].satoshis, FT_CODE_SATOSHIS);
        assert_eq!(tx.outputs[1].satoshis, FT_TAPE_SATOSHIS);
        assert_eq!(tx.outputs[2].satoshis, FT_CODE_SATOSHIS);
        assert_eq!(tx.outputs[3].satoshis, FT_TAPE_SATOSHIS);
        assert_eq!(tx.outputs[4].satoshis, FT_CODE_SATOSHIS);
        assert_eq!(tx.outputs[5].satoshis, FT_TAPE_SATOSHIS);
    }

    #[test]
    fn ft_batch_transfer_chains_more_than_five_receivers() {
        let key = crate::PrivateKey::from_slice(&[38u8; 32]).unwrap();
        let ft = fixture_ft(&key);
        let (ft_utxo, pre_tx) = fixture_ft_utxo_and_pre_tx(&ft, &key, 1_000);
        let receivers = (0u8..7)
            .map(|index| FtReceiver {
                address: crate::PrivateKey::from_slice(&[50 + index; 32])
                    .unwrap()
                    .address(),
                amount_raw: 100,
            })
            .collect::<Vec<_>>();

        let txs = ft
            .batch_transfer(
                key.clone(),
                receivers,
                vec![ft_utxo],
                test_utxo(&key, 200_000, 4),
                vec![pre_tx],
                vec![vec![0x52]],
            )
            .unwrap();

        assert_eq!(txs.len(), 2);
        let first = crate::Transaction::from_hex(&txs[0].txraw).unwrap();
        let second = crate::Transaction::from_hex(&txs[1].txraw).unwrap();
        assert_eq!(first.outputs[10].satoshis, FT_CODE_SATOSHIS);
        assert_eq!(first.outputs[11].satoshis, FT_TAPE_SATOSHIS);
        assert_eq!(second.inputs[0].previous_output.txid, first.txid());
        assert_eq!(second.inputs[0].previous_output.vout, 10);
        assert_eq!(second.inputs[1].previous_output.txid, first.txid());
        assert_eq!(second.inputs[1].previous_output.vout, 12);
        assert_eq!(second.outputs[0].satoshis, FT_CODE_SATOSHIS);
        assert_eq!(second.outputs[2].satoshis, FT_CODE_SATOSHIS);
        assert_eq!(second.outputs[4].satoshis, FT_CODE_SATOSHIS);
    }

    #[test]
    fn ft_merge_combines_multiple_ft_inputs_into_one_pair() {
        let key = crate::PrivateKey::from_slice(&[37u8; 32]).unwrap();
        let ft = fixture_ft(&key);
        let (ft_utxo1, pre_tx1) = fixture_ft_utxo_and_pre_tx(&ft, &key, 400);
        let (mut ft_utxo2, mut pre_tx2) = fixture_ft_utxo_and_pre_tx(&ft, &key, 600);
        ft_utxo2.base.outpoint.vout = 0;
        pre_tx2.inputs.clear();

        let txs = ft
            .merge_ft(
                key.clone(),
                vec![ft_utxo1, ft_utxo2],
                test_utxo(&key, 100_000, 3),
                vec![pre_tx1, pre_tx2],
                vec![vec![0x52], vec![0x52]],
            )
            .unwrap();

        assert_eq!(txs.len(), 1);
        assert_eq!(txs[0].outputs[0].satoshis, FT_CODE_SATOSHIS);
        assert_eq!(txs[0].outputs[1].satoshis, FT_TAPE_SATOSHIS);
    }

    #[test]
    fn ft_merge_chains_more_than_five_inputs() {
        let key = crate::PrivateKey::from_slice(&[39u8; 32]).unwrap();
        let ft = fixture_ft(&key);
        let mut ft_utxos = Vec::new();
        let mut pre_txs = Vec::new();
        for index in 0..7 {
            let (ft_utxo, pre_tx) = fixture_ft_utxo_and_pre_tx(&ft, &key, 100 + index);
            ft_utxos.push(ft_utxo);
            pre_txs.push(pre_tx);
        }

        let txs = ft
            .merge_ft(
                key.clone(),
                ft_utxos,
                test_utxo(&key, 300_000, 5),
                pre_txs,
                vec![vec![0x52]; 7],
            )
            .unwrap();

        assert_eq!(txs.len(), 3);
        assert_eq!(txs[0].inputs.len(), 6);
        assert_eq!(txs[1].inputs.len(), 3);
        assert_eq!(txs[1].inputs[2].previous_output.txid, txs[0].txid());
        assert_eq!(txs[1].inputs[2].previous_output.vout, 2);
        assert_eq!(txs[2].inputs[0].previous_output.txid, txs[0].txid());
        assert_eq!(txs[2].inputs[0].previous_output.vout, 0);
        assert_eq!(txs[2].inputs[1].previous_output.txid, txs[1].txid());
        assert_eq!(txs[2].inputs[1].previous_output.vout, 0);
        assert_eq!(txs[2].inputs[2].previous_output.txid, txs[1].txid());
        assert_eq!(txs[2].inputs[2].previous_output.vout, 2);
    }

    fn fixture_ft_utxo_and_pre_tx(
        ft: &Ft,
        key: &crate::PrivateKey,
        balance: u128,
    ) -> (FtUtxo, crate::Transaction) {
        let code_script = crate::script::Script::from_bytes(hex::decode(&ft.code_script).unwrap());
        let mut amount = [0u8; 48];
        amount[0..8].copy_from_slice(&(balance as u64).to_le_bytes());
        let tape_script = scripts::mint_tape_script(&amount, 6, "Token", "TOK");
        let mut pre_tx = crate::Transaction::new();
        pre_tx.outputs.push(crate::TxOut {
            satoshis: FT_CODE_SATOSHIS,
            script_pubkey: code_script.clone(),
        });
        pre_tx.outputs.push(crate::TxOut {
            satoshis: FT_TAPE_SATOSHIS,
            script_pubkey: tape_script,
        });
        let ft_utxo = FtUtxo {
            base: crate::Utxo {
                outpoint: crate::OutPoint {
                    txid: pre_tx.txid(),
                    vout: 0,
                },
                satoshis: FT_CODE_SATOSHIS,
                script_pubkey: code_script,
                private_key: key.clone(),
            },
            ft_balance_raw: balance,
        };
        (ft_utxo, pre_tx)
    }
}
