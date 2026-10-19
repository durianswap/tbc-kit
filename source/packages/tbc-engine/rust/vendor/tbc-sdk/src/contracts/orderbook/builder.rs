use crate::{
    DEFAULT_FEE_RATE_SAT_PER_KB, DEFAULT_SIGHASH, Error, FtUtxo, Result, SDK_DUST_SAT, Transaction,
    TxIn, TxOut, Utxo,
    builder::{ChangePolicy, fee_for_size, finalize_signed_fee, paid_fee},
    contracts::{
        ft::{
            amount::{build_tape_amount, build_tape_amount_with_offset},
            builder::{push_script_data, sign_ft_input, sign_ft_swap_input},
            partial_sha256::calculate_partial_hash,
            scripts::{
                FT_CODE_SATOSHIS, FT_TAPE_SATOSHIS, FtCodeReceiver, transfer_code_script,
                transfer_tape_script,
            },
            unlock::classify_ft_script,
        },
        stable_coin::scripts::{
            COIN_FT_SEQUENCE, get_lock_time_from_tape as get_coin_lock_time_from_tape,
        },
    },
    hash,
    script::Script,
};

use super::{
    BuyOrderParams, CancelBuyOrderParams, MatchOrderParams, OrderBook, OrderData, OrderUtxo,
    SellOrderParams, scripts,
};

const ORDERBOOK_PRICE_PRECISION: u128 = 1_000_000;

impl OrderBook {
    pub fn make_sell_order(params: SellOrderParams) -> Result<Transaction> {
        if params.funding_utxos.len() > 10 {
            return Err(Error::InvalidUtxo(
                "at most ten OrderBook inputs are supported".to_string(),
            ));
        }
        let order_data = OrderData {
            hold_address: params.hold_address.clone(),
            sale_volume: params.sale_volume,
            ft_partial_hash: ft_partial_hash_from_hex(&params.ft_code_script)?,
            fee_rate: params.fee_rate,
            unit_price: params.unit_price,
            ft_contract_id: params.ft_contract_id,
        };
        let code = Script::from_bytes(hex::decode(&params.ft_code_script)?);
        classify_ft_script(&code)?;
        let outputs = vec![TxOut {
            satoshis: params.sale_volume,
            script_pubkey: scripts::sell_order_script_with_ft_size(
                &order_data,
                code.as_bytes().len(),
                &params.tax_address,
            )?,
        }];
        build_p2pkh_funded_tx(&params.funding_utxos, &outputs, &params.hold_address)
    }

    pub fn make_buy_order(params: BuyOrderParams) -> Result<Transaction> {
        if params.ft_utxos.is_empty() {
            return Err(Error::InvalidUtxo(
                "at least one FT UTXO is required".to_string(),
            ));
        }
        if params.ft_utxos.len() > 5 {
            return Err(Error::InvalidUtxo(
                "at most five FT inputs are supported".to_string(),
            ));
        }
        if params.pre_txs.len() != params.ft_utxos.len()
            || params.pre_pre_tx_data_set.len() != params.ft_utxos.len()
        {
            return Err(Error::InvalidUtxo(
                "FT ancestry data length must match FT UTXO length".to_string(),
            ));
        }

        let input_balances = params
            .ft_utxos
            .iter()
            .map(|utxo| utxo.ft_balance_raw)
            .collect::<Vec<_>>();
        let total_ft = checked_sum_u128(&input_balances, "FT amount overflow")?;
        let required_ft = required_ft_amount(params.sale_volume, params.unit_price)?;
        let (order_tape, change_tape) = build_tape_amount(required_ft, &input_balances)?;
        let code_script = Script::from_bytes(hex::decode(&params.ft_code_script)?);
        let tape_script = Script::from_bytes(hex::decode(&params.ft_tape_script)?);
        let order_data = OrderData {
            hold_address: params.hold_address.clone(),
            sale_volume: params.sale_volume,
            ft_partial_hash: ft_partial_hash_from_hex(&params.ft_code_script)?,
            fee_rate: params.fee_rate,
            unit_price: params.unit_price,
            ft_contract_id: params.ft_contract_id,
        };
        classify_ft_script(&code_script)?;
        let order_script = scripts::buy_order_script_with_ft_size(
            &order_data,
            code_script.as_bytes().len(),
            &params.tax_address,
        )?;
        let mut outputs = vec![
            TxOut {
                satoshis: scripts::BUY_ORDER_DUST,
                script_pubkey: order_script.clone(),
            },
            TxOut {
                satoshis: FT_CODE_SATOSHIS,
                script_pubkey: transfer_code_script(
                    &code_script,
                    FtCodeReceiver::Hash160(scripts::order_hash160(&order_script)),
                )?,
            },
            TxOut {
                satoshis: FT_TAPE_SATOSHIS,
                script_pubkey: transfer_tape_script(&tape_script, &order_tape)?,
            },
        ];
        if total_ft > required_ft {
            outputs.push(TxOut {
                satoshis: FT_CODE_SATOSHIS,
                script_pubkey: transfer_code_script(
                    &code_script,
                    FtCodeReceiver::Address(params.hold_address.clone()),
                )?,
            });
            outputs.push(TxOut {
                satoshis: FT_TAPE_SATOSHIS,
                script_pubkey: transfer_tape_script(&tape_script, &change_tape)?,
            });
        }

        let spend_options = ft_spend_options(&params.ft_utxos, &params.pre_txs)?;
        build_ft_order_tx(
            &params.ft_utxos,
            &params.fee_utxo,
            &params.pre_txs,
            &params.pre_pre_tx_data_set,
            &outputs,
            &params.hold_address,
            &spend_options,
        )
    }

    pub fn cancel_sell_order(order: OrderUtxo, fee_utxos: Vec<Utxo>) -> Result<Transaction> {
        let data = Self::get_order_data(&order.base.script_pubkey)?;
        let outputs = vec![TxOut {
            satoshis: order.base.satoshis,
            script_pubkey: data.hold_address.script_pubkey(),
        }];
        build_order_spend_tx(order, &fee_utxos, &outputs, &data.hold_address)
    }

    pub fn cancel_buy_order(params: CancelBuyOrderParams) -> Result<Transaction> {
        let data = Self::get_order_data(&params.buy_order.base.script_pubkey)?;
        let tape_output = params
            .buy_pre_tx
            .outputs
            .get(params.buy_ft_utxo.base.outpoint.vout as usize + 1)
            .ok_or_else(|| Error::InvalidUtxo("buy FT pre tx missing tape output".to_string()))?;
        let (return_tape, _) = build_tape_amount_with_offset(
            params.buy_ft_utxo.ft_balance_raw,
            &[params.buy_ft_utxo.ft_balance_raw],
            1,
        )?;
        let outputs = vec![
            TxOut {
                satoshis: FT_CODE_SATOSHIS,
                script_pubkey: transfer_code_script(
                    &params.buy_ft_utxo.base.script_pubkey,
                    FtCodeReceiver::Address(data.hold_address.clone()),
                )?,
            },
            TxOut {
                satoshis: FT_TAPE_SATOSHIS,
                script_pubkey: transfer_tape_script(&tape_output.script_pubkey, &return_tape)?,
            },
        ];
        let spend_options = ft_spend_options(
            std::slice::from_ref(&params.buy_ft_utxo),
            std::slice::from_ref(&params.buy_pre_tx),
        )?;
        build_cancel_buy_order_tx(params, &outputs, &data.hold_address, &spend_options)
    }

    pub fn match_order(params: MatchOrderParams) -> Result<Transaction> {
        let buy_data = Self::get_order_data(&params.buy_order.base.script_pubkey)?;
        let sell_data = Self::get_order_data(&params.sell_order.base.script_pubkey)?;
        let matched_tbc = buy_data.sale_volume.min(sell_data.sale_volume);
        let tbc_tax = apply_order_rate(matched_tbc as u128, buy_data.fee_rate)?;
        let tbc_buyer = matched_tbc
            .checked_sub(tbc_tax as u64)
            .ok_or_else(|| Error::InvalidUtxo("matched TBC tax exceeds amount".to_string()))?;
        let ft_pay = required_ft_amount(matched_tbc, sell_data.unit_price)?;
        let ft_tax = apply_order_rate(ft_pay, sell_data.fee_rate)?;
        let ft_seller = ft_pay
            .checked_sub(ft_tax)
            .ok_or_else(|| Error::InvalidUtxo("matched FT tax exceeds amount".to_string()))?;
        let (seller_tape, _) =
            build_tape_amount_with_offset(ft_seller, &[params.buy_ft_utxo.ft_balance_raw], 1)?;
        let (_, ft_change_tape) = build_tape_amount_with_offset(
            ft_tax,
            &[params.buy_ft_utxo.ft_balance_raw - ft_seller],
            1,
        )?;
        let (tax_tape, _) = build_tape_amount_with_offset(
            ft_tax,
            &[params.buy_ft_utxo.ft_balance_raw - ft_seller],
            1,
        )?;
        let code_script = params.buy_ft_utxo.base.script_pubkey.clone();
        let tape_script = params
            .buy_pre_tx
            .outputs
            .get(params.buy_ft_utxo.base.outpoint.vout as usize + 1)
            .ok_or_else(|| Error::InvalidUtxo("buy FT pre tx missing tape output".to_string()))?
            .script_pubkey
            .clone();
        let mut outputs = vec![
            TxOut {
                satoshis: FT_CODE_SATOSHIS,
                script_pubkey: transfer_code_script(
                    &code_script,
                    FtCodeReceiver::Address(sell_data.hold_address.clone()),
                )?,
            },
            TxOut {
                satoshis: FT_TAPE_SATOSHIS,
                script_pubkey: transfer_tape_script(&tape_script, &seller_tape)?,
            },
            TxOut {
                satoshis: FT_CODE_SATOSHIS,
                script_pubkey: transfer_code_script(
                    &code_script,
                    FtCodeReceiver::Address(params.ft_fee_address.clone()),
                )?,
            },
            TxOut {
                satoshis: FT_TAPE_SATOSHIS,
                script_pubkey: transfer_tape_script(&tape_script, &tax_tape)?,
            },
            TxOut {
                satoshis: tbc_buyer,
                script_pubkey: buy_data.hold_address.script_pubkey(),
            },
        ];
        if buy_data.fee_rate == 0 && tbc_tax == 0 {
            outputs.push(TxOut {
                satoshis: 0,
                script_pubkey: Script::op_return(&[vec![0xff; 22]]),
            });
        } else if tbc_tax < 10 {
            return Err(Error::InvalidUtxo(
                "TBC tax amount is less than dust limit".to_string(),
            ));
        } else {
            outputs.push(TxOut {
                satoshis: tbc_tax as u64,
                script_pubkey: params.tbc_fee_address.script_pubkey(),
            });
        }

        let new_sell_tbc = sell_data.sale_volume - matched_tbc;
        let new_buy_tbc = buy_data.sale_volume - matched_tbc;
        if new_sell_tbc > 0 {
            outputs.push(TxOut {
                satoshis: new_sell_tbc,
                script_pubkey: Self::update_sale_volume(
                    &params.sell_order.base.script_pubkey,
                    new_sell_tbc,
                )?,
            });
        } else if new_buy_tbc > 0 && params.buy_ft_utxo.ft_balance_raw > ft_pay {
            let new_buy_script =
                Self::update_sale_volume(&params.buy_order.base.script_pubkey, new_buy_tbc)?;
            outputs.push(TxOut {
                satoshis: scripts::BUY_ORDER_DUST,
                script_pubkey: new_buy_script.clone(),
            });
            outputs.push(TxOut {
                satoshis: params.buy_ft_utxo.base.satoshis,
                script_pubkey: transfer_code_script(
                    &code_script,
                    FtCodeReceiver::Hash160(scripts::order_hash160(&new_buy_script)),
                )?,
            });
            outputs.push(TxOut {
                satoshis: FT_TAPE_SATOSHIS,
                script_pubkey: transfer_tape_script(&tape_script, &ft_change_tape)?,
            });
        }

        let spend_options = ft_spend_options(
            std::slice::from_ref(&params.buy_ft_utxo),
            std::slice::from_ref(&params.buy_pre_tx),
        )?;
        build_match_tx(params, &outputs, &spend_options)
    }

    pub fn get_order_data(script: &Script) -> Result<OrderData> {
        scripts::decode_order_data(script)
    }

    pub fn update_sale_volume(script: &Script, sale_volume: u64) -> Result<Script> {
        scripts::update_sale_volume(script, sale_volume)
    }
}

fn build_p2pkh_funded_tx(
    funding_utxos: &[Utxo],
    outputs: &[TxOut],
    change_address: &crate::Address,
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
        DEFAULT_FEE_RATE_SAT_PER_KB,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        ChangePolicy::Optional { dust: SDK_DUST_SAT },
        |change| sign_p2pkh_funded_tx(funding_utxos, outputs, change_address, change),
    )
}

fn sign_p2pkh_funded_tx(
    funding_utxos: &[Utxo],
    outputs: &[TxOut],
    change_address: &crate::Address,
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

fn build_ft_order_tx(
    ft_utxos: &[FtUtxo],
    fee_utxo: &Utxo,
    pre_txs: &[Transaction],
    pre_pre_tx_data_set: &[Vec<u8>],
    outputs: &[TxOut],
    change_address: &crate::Address,
    spend_options: &FtSpendOptions,
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
            sign_ft_order_tx(
                ft_utxos,
                fee_utxo,
                pre_txs,
                pre_pre_tx_data_set,
                outputs,
                change_address,
                change,
                spend_options,
            )
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn sign_ft_order_tx(
    ft_utxos: &[FtUtxo],
    fee_utxo: &Utxo,
    pre_txs: &[Transaction],
    pre_pre_tx_data_set: &[Vec<u8>],
    outputs: &[TxOut],
    change_address: &crate::Address,
    change: Option<u64>,
    spend_options: &FtSpendOptions,
) -> Result<Transaction> {
    let mut tx = Transaction::new();
    tx.lock_time = spend_options.lock_time;
    for ft_utxo in ft_utxos {
        tx.inputs.push(TxIn::new(ft_utxo.base.outpoint.clone()));
    }
    tx.inputs.push(TxIn::new(fee_utxo.outpoint.clone()));
    tx.outputs.extend_from_slice(outputs);
    if let Some(change) = change {
        tx.outputs.push(TxOut {
            satoshis: change,
            script_pubkey: change_address.script_pubkey(),
        });
    }
    for (index, ft_utxo) in ft_utxos.iter().enumerate() {
        if spend_options.coin_modes[index] {
            tx.inputs[index].sequence = COIN_FT_SEQUENCE;
        }
        sign_ft_input(
            &mut tx,
            index,
            &ft_utxo.base.private_key,
            ft_utxo,
            &pre_txs[index],
            &pre_pre_tx_data_set[index],
            spend_options.coin_modes[index],
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

fn build_order_spend_tx(
    order: OrderUtxo,
    fee_utxos: &[Utxo],
    outputs: &[TxOut],
    change_address: &crate::Address,
) -> Result<Transaction> {
    let mut all_inputs = Vec::with_capacity(fee_utxos.len() + 1);
    all_inputs.push(order.base.clone());
    all_inputs.extend_from_slice(fee_utxos);
    let input_sum = sum_utxos(&all_inputs)?;
    let output_sum = sum_outputs(outputs)?;
    finalize_signed_fee(
        input_sum,
        output_sum,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        ChangePolicy::Optional { dust: SDK_DUST_SAT },
        |change| sign_order_spend_tx(order.clone(), fee_utxos, outputs, change_address, change),
    )
}

fn sign_order_spend_tx(
    order: OrderUtxo,
    fee_utxos: &[Utxo],
    outputs: &[TxOut],
    change_address: &crate::Address,
    change: Option<u64>,
) -> Result<Transaction> {
    let mut tx = Transaction::new();
    tx.inputs.push(TxIn::new(order.base.outpoint.clone()));
    for utxo in fee_utxos {
        tx.inputs.push(TxIn::new(utxo.outpoint.clone()));
    }
    tx.outputs.extend_from_slice(outputs);
    if let Some(change) = change {
        tx.outputs.push(TxOut {
            satoshis: change,
            script_pubkey: change_address.script_pubkey(),
        });
    }
    tx.inputs[0].script_sig = order_cancel_script(&tx, 0, &order.base)?;
    for (offset, utxo) in fee_utxos.iter().enumerate() {
        tx.sign_p2pkh_input(
            offset + 1,
            &utxo.private_key,
            &utxo.script_pubkey,
            utxo.satoshis,
            DEFAULT_SIGHASH,
        )?;
    }
    Ok(tx)
}

fn build_cancel_buy_order_tx(
    params: CancelBuyOrderParams,
    outputs: &[TxOut],
    change_address: &crate::Address,
    spend_options: &FtSpendOptions,
) -> Result<Transaction> {
    let input_sum = params
        .buy_order
        .base
        .satoshis
        .checked_add(params.buy_ft_utxo.base.satoshis)
        .and_then(|sum| {
            params
                .fee_utxos
                .iter()
                .try_fold(sum, |acc, utxo| acc.checked_add(utxo.satoshis))
        })
        .ok_or_else(|| Error::InvalidUtxo("input amount overflow".to_string()))?;
    let output_sum = sum_outputs(outputs)?;
    finalize_signed_fee(
        input_sum,
        output_sum,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        ChangePolicy::Optional { dust: SDK_DUST_SAT },
        |change| sign_cancel_buy_order_tx(&params, outputs, change_address, change, spend_options),
    )
}

fn sign_cancel_buy_order_tx(
    params: &CancelBuyOrderParams,
    outputs: &[TxOut],
    change_address: &crate::Address,
    change: Option<u64>,
    spend_options: &FtSpendOptions,
) -> Result<Transaction> {
    let mut tx = Transaction::new();
    tx.lock_time = spend_options.lock_time;
    tx.inputs
        .push(TxIn::new(params.buy_order.base.outpoint.clone()));
    tx.inputs
        .push(TxIn::new(params.buy_ft_utxo.base.outpoint.clone()));
    for utxo in &params.fee_utxos {
        tx.inputs.push(TxIn::new(utxo.outpoint.clone()));
    }
    tx.outputs.extend_from_slice(outputs);
    if let Some(change) = change {
        tx.outputs.push(TxOut {
            satoshis: change,
            script_pubkey: change_address.script_pubkey(),
        });
    }

    if spend_options.coin_modes[0] {
        tx.inputs[1].sequence = COIN_FT_SEQUENCE;
    }
    tx.inputs[0].script_sig = order_cancel_script(&tx, 0, &params.buy_order.base)?;
    sign_ft_swap_input(
        &mut tx,
        1,
        &params.buy_ft_utxo.base.private_key,
        &params.buy_ft_utxo,
        &params.buy_pre_tx,
        &params.buy_pre_pre_tx_data,
        &params.buy_pre_tx,
        classify_ft_script(&params.buy_ft_utxo.base.script_pubkey)?.version,
        spend_options.coin_modes[0],
    )?;
    for (offset, utxo) in params.fee_utxos.iter().enumerate() {
        tx.sign_p2pkh_input(
            offset + 2,
            &utxo.private_key,
            &utxo.script_pubkey,
            utxo.satoshis,
            DEFAULT_SIGHASH,
        )?;
    }
    Ok(tx)
}

fn order_cancel_script(tx: &Transaction, input_index: usize, order: &Utxo) -> Result<Script> {
    let signature = tx.signature_with_hashtype(
        input_index,
        &order.private_key,
        &order.script_pubkey,
        order.satoshis,
        DEFAULT_SIGHASH,
    )?;
    let public_key = order.private_key.public_key().to_bytes();
    let mut script = Vec::new();
    push_script_data(&mut script, &signature)?;
    push_script_data(&mut script, &public_key)?;
    script.push(crate::script::opcodes::OP_1 + 1);
    Ok(Script::from_bytes(script))
}

fn build_match_tx(
    params: MatchOrderParams,
    outputs: &[TxOut],
    spend_options: &FtSpendOptions,
) -> Result<Transaction> {
    let fee = js_match_fee_estimate(&params, outputs)?;
    let change = match_fee_change(params.fee_utxo.satoshis, fee)?;
    let input_sum = params
        .buy_order
        .base
        .satoshis
        .checked_add(params.buy_ft_utxo.base.satoshis)
        .and_then(|sum| sum.checked_add(params.sell_order.base.satoshis))
        .and_then(|sum| sum.checked_add(params.fee_utxo.satoshis))
        .ok_or_else(|| Error::InvalidUtxo("match input amount overflow".to_string()))?;
    let signed = sign_match_tx(&params, outputs, change, spend_options)?;
    let target = fee_for_size(signed.serialize().len(), DEFAULT_FEE_RATE_SAT_PER_KB);
    if paid_fee(&signed, input_sum)? < target {
        return Err(Error::FeeDidNotConverge);
    }
    Ok(signed)
}

fn js_match_fee_estimate(params: &MatchOrderParams, outputs: &[TxOut]) -> Result<u64> {
    let unsigned = unsigned_match_tx(params, outputs, 0);
    let p2pkh_input_estimate_delta = 107usize;
    Ok(fee_for_size(
        unsigned.serialize().len() + p2pkh_input_estimate_delta + 4_000,
        DEFAULT_FEE_RATE_SAT_PER_KB,
    ))
}

fn unsigned_match_tx(params: &MatchOrderParams, outputs: &[TxOut], change: u64) -> Transaction {
    let mut tx = Transaction::new();
    tx.inputs
        .push(TxIn::new(params.buy_order.base.outpoint.clone()));
    tx.inputs
        .push(TxIn::new(params.buy_ft_utxo.base.outpoint.clone()));
    tx.inputs
        .push(TxIn::new(params.sell_order.base.outpoint.clone()));
    tx.inputs.push(TxIn::new(params.fee_utxo.outpoint.clone()));

    let continuation_start = 6usize.min(outputs.len());
    tx.outputs.extend_from_slice(&outputs[..continuation_start]);
    tx.outputs.push(TxOut {
        satoshis: change,
        script_pubkey: params.fee_utxo.private_key.address().script_pubkey(),
    });
    if outputs.len() > continuation_start {
        tx.outputs.extend_from_slice(&outputs[continuation_start..]);
    }
    tx
}

fn sign_match_tx(
    params: &MatchOrderParams,
    outputs: &[TxOut],
    change: u64,
    spend_options: &FtSpendOptions,
) -> Result<Transaction> {
    let mut tx = unsigned_match_tx(params, outputs, change);
    tx.lock_time = spend_options.lock_time;

    if spend_options.coin_modes[0] {
        tx.inputs[1].sequence = COIN_FT_SEQUENCE;
    }
    tx.inputs[0].script_sig = order_match_script(&tx, &params.buy_pre_tx, 0)?;
    sign_ft_swap_input(
        &mut tx,
        1,
        &params.matcher_private_key,
        &params.buy_ft_utxo,
        &params.buy_pre_tx,
        &params.buy_pre_pre_tx_data,
        &params.buy_pre_tx,
        classify_ft_script(&params.buy_ft_utxo.base.script_pubkey)?.version,
        spend_options.coin_modes[0],
    )?;
    tx.inputs[2].script_sig = order_match_script(&tx, &params.sell_pre_tx, 0)?;
    tx.sign_p2pkh_input(
        3,
        &params.fee_utxo.private_key,
        &params.fee_utxo.script_pubkey,
        params.fee_utxo.satoshis,
        DEFAULT_SIGHASH,
    )?;
    Ok(tx)
}

fn match_fee_change(fee_input_satoshis: u64, fee: u64) -> Result<u64> {
    let required = fee
        .checked_add(1_300)
        .ok_or_else(|| Error::InvalidUtxo("match fee overflow".to_string()))?;
    fee_input_satoshis
        .checked_sub(required)
        .ok_or(Error::InsufficientFunds {
            input: fee_input_satoshis,
            required,
        })
}

fn order_match_script(
    tx: &Transaction,
    pre_tx: &Transaction,
    pre_tx_vout: usize,
) -> Result<Script> {
    let mut script = order_current_outputs_data(tx)?;
    script.extend_from_slice(&order_pre_tx_data(pre_tx, pre_tx_vout, 1)?);
    script.push(crate::script::opcodes::OP_1);
    Ok(Script::from_bytes(script))
}

pub(super) fn order_current_outputs_data(tx: &Transaction) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut index = 0usize;
    while index < tx.outputs.len() {
        let output = &tx.outputs[index];
        let script_len = output.script_pubkey.as_bytes().len();
        write_order_output(output, order_partial_offset(script_len), &mut out)?;
        if matches!(script_len, 1_884 | 2_012 | 2_076) {
            let tape = tx.outputs.get(index + 1).ok_or_else(|| {
                Error::InvalidUtxo("current FT code output missing tape".to_string())
            })?;
            write_order_full_output(tape, &mut out)?;
            index += 2;
        } else {
            index += 1;
        }
    }
    let padding_count = order_padding_count(tx.outputs.len());
    out.extend(std::iter::repeat_n(0, padding_count));
    Ok(out)
}

fn order_padding_count(output_count: usize) -> usize {
    10usize
        .saturating_sub(output_count)
        .saturating_mul(4)
        .saturating_sub(2)
}

fn order_pre_tx_data(
    tx: &Transaction,
    vout: usize,
    contract_output_number: usize,
) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    out.push(0x10);
    out.extend_from_slice(&(crate::TX_VERSION as u32).to_le_bytes());
    out.extend_from_slice(&tx.lock_time.to_le_bytes());
    out.extend_from_slice(&(tx.inputs.len() as i32).to_le_bytes());
    out.extend_from_slice(&(tx.outputs.len() as i32).to_le_bytes());

    let mut input_base = Vec::new();
    let mut input_unlock_hashes = Vec::new();
    for input in &tx.inputs {
        input_base.push(0x28);
        input.previous_output.serialize(&mut input_base);
        input_base.extend_from_slice(&input.sequence.to_le_bytes());
        input_unlock_hashes.extend_from_slice(&input.script_sig.sha256());
    }
    input_base.extend(std::iter::repeat_n(
        0,
        10usize.saturating_sub(tx.inputs.len()),
    ));
    out.extend_from_slice(&input_base);
    out.push(0x20);
    out.extend_from_slice(&hash::sha256(&input_unlock_hashes));

    let mut index = 0usize;
    while index < tx.outputs.len() {
        let output = &tx.outputs[index];
        let script_len = output.script_pubkey.as_bytes().len();
        let is_current = index == vout;
        let partial_offset = if is_current {
            order_partial_offset(script_len)
        } else {
            generic_partial_offset(script_len)
        };
        write_order_output(output, partial_offset, &mut out)?;
        if is_current {
            for extra in 1..contract_output_number {
                let next = tx.outputs.get(index + extra).ok_or_else(|| {
                    Error::InvalidUtxo("order pre tx missing contract companion output".to_string())
                })?;
                write_order_full_output(next, &mut out)?;
                let size =
                    crate::contracts::ft::unlock::size_le(next.script_pubkey.as_bytes().len())?;
                out.push(0);
                out.extend_from_slice(&crate::contracts::ft::unlock::length_hex(size.len())?);
                out.extend_from_slice(&size);
            }
            index += contract_output_number;
        } else {
            index += 1;
        }
    }
    for _ in tx.outputs.len()..10 {
        out.extend_from_slice(&[0, 0, 0, 0]);
    }
    Ok(out)
}

fn write_order_output(
    output: &TxOut,
    partial_offset: Option<usize>,
    out: &mut Vec<u8>,
) -> Result<()> {
    let script = output.script_pubkey.as_bytes();
    let size = crate::contracts::ft::unlock::size_le(script.len())?;
    let (partial_hash, suffix) = if let Some(offset) = partial_offset {
        let offset = offset.min(script.len());
        (
            Some(calculate_partial_hash(&script[..offset])),
            &script[offset..],
        )
    } else if script.len() < 64 {
        (None, script)
    } else {
        let offset = (script.len() / 64) * 64;
        (
            Some(calculate_partial_hash(&script[..offset])),
            &script[offset..],
        )
    };
    out.push(0x08);
    out.extend_from_slice(&output.satoshis.to_le_bytes());
    out.extend_from_slice(&crate::contracts::ft::unlock::length_hex(suffix.len())?);
    out.extend_from_slice(suffix);
    if let Some(partial_hash) = partial_hash {
        out.push(0x20);
        out.extend_from_slice(&partial_hash);
    } else {
        out.push(0);
    }
    out.extend_from_slice(&crate::contracts::ft::unlock::length_hex(size.len())?);
    out.extend_from_slice(&size);
    Ok(())
}

fn write_order_full_output(output: &TxOut, out: &mut Vec<u8>) -> Result<()> {
    let script = output.script_pubkey.as_bytes();
    out.push(0x08);
    out.extend_from_slice(&output.satoshis.to_le_bytes());
    out.extend_from_slice(&crate::contracts::ft::unlock::length_hex(script.len())?);
    out.extend_from_slice(script);
    Ok(())
}

fn order_partial_offset(script_len: usize) -> Option<usize> {
    match script_len {
        scripts::BUY_ORDER_SCRIPT_SIZE => Some(960),
        scripts::SELL_ORDER_SCRIPT_SIZE => Some(832),
        1_884 => Some(1_856),
        2_012 => Some(1_984),
        _ => generic_partial_offset(script_len),
    }
}

fn generic_partial_offset(script_len: usize) -> Option<usize> {
    (script_len >= 64).then_some((script_len / 64) * 64)
}

fn ft_partial_hash_from_hex(code_script_hex: &str) -> Result<[u8; 32]> {
    let bytes = hex::decode(code_script_hex)?;
    let offset = match bytes.len() {
        1_564 => 1_536,
        1_884 => 1_856,
        2_012 => 1_984,
        2_076 => 2_048,
        len if len >= 32 => len - 32,
        _ => {
            return Err(Error::InvalidScript(
                "FT code script is too short for partial hash".to_string(),
            ));
        }
    };
    Ok(calculate_partial_hash(&bytes[..offset]))
}

fn required_ft_amount(sale_volume: u64, unit_price: u64) -> Result<u128> {
    (sale_volume as u128)
        .checked_mul(unit_price as u128)
        .map(|value| value / ORDERBOOK_PRICE_PRECISION)
        .ok_or_else(|| Error::InvalidUtxo("order FT amount overflow".to_string()))
}

fn apply_order_rate(amount: u128, rate: u64) -> Result<u128> {
    amount
        .checked_mul(rate as u128)
        .map(|value| value / ORDERBOOK_PRICE_PRECISION)
        .ok_or_else(|| Error::InvalidUtxo("order rate amount overflow".to_string()))
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FtSpendOptions {
    lock_time: u32,
    coin_modes: Vec<bool>,
}

fn ft_spend_options(ft_utxos: &[FtUtxo], pre_txs: &[Transaction]) -> Result<FtSpendOptions> {
    if ft_utxos.len() != pre_txs.len() {
        return Err(Error::InvalidUtxo(
            "FT ancestry data length must match FT UTXO length".to_string(),
        ));
    }
    let mut lock_time = 0u32;
    let mut coin_modes = Vec::with_capacity(ft_utxos.len());
    for (ft_utxo, pre_tx) in ft_utxos.iter().zip(pre_txs) {
        let tape_index = ft_utxo.base.outpoint.vout as usize + 1;
        let tape_output = pre_tx.outputs.get(tape_index).ok_or_else(|| {
            Error::InvalidUtxo("FT UTXO missing adjacent tape output".to_string())
        })?;
        match get_coin_lock_time_from_tape(&tape_output.script_pubkey) {
            Ok(coin_lock_time) => {
                coin_modes.push(true);
                lock_time = lock_time.max(coin_lock_time);
            }
            Err(_) => coin_modes.push(false),
        }
    }
    Ok(FtSpendOptions {
        lock_time,
        coin_modes,
    })
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

fn checked_sum_u128(values: &[u128], message: &str) -> Result<u128> {
    values
        .iter()
        .try_fold(0u128, |sum, value| sum.checked_add(*value))
        .ok_or_else(|| Error::InvalidUtxo(message.to_string()))
}

#[cfg(test)]
mod compatibility_tests {
    use super::*;
    use crate::PrivateKey;

    #[test]
    fn ft_version_detects_tbc_contract_166_v4_marker() {
        let key = PrivateKey::from_slice(&[91u8; 32]).unwrap();
        let code = crate::contracts::ft::scripts::mint_code_script(
            "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
            513,
            &key.address(),
            64,
        )
        .unwrap();

        assert_eq!(classify_ft_script(&code).unwrap().version, 4);
    }

    #[test]
    fn ft_version_accepts_v3_direct_push_marker() {
        let mut bytes = vec![crate::script::opcodes::OP_0; 1_872];
        bytes.extend_from_slice(&[0x02, 0xaa, 0xbb]);
        bytes.extend_from_slice(&[crate::script::opcodes::OP_0; 3]);
        bytes.extend_from_slice(b"\x052Code");

        assert_eq!(
            classify_ft_script(&Script::from_bytes(bytes))
                .unwrap()
                .version,
            3
        );
    }

    #[test]
    fn ft_version_checks_the_v4_marker_inside_stable_coin_code() {
        let key = PrivateKey::from_slice(&[92u8; 32]).unwrap();
        let code = crate::contracts::stable_coin::scripts::coin_mint_code_script(
            &key.address().hash160(),
            &key.address(),
            &[0x22; 32],
            64,
        )
        .unwrap();

        assert_eq!(code.as_bytes().len(), 2_076);
        let info = classify_ft_script(&code).unwrap();
        assert_eq!(info.version, 4);
        assert!(info.is_coin);
    }

    #[test]
    fn ft_version_rejects_malformed_v2_length_script() {
        let mut bytes = vec![crate::script::opcodes::OP_PUSHDATA4, 0xff, 0xff, 0xff, 0xff];
        bytes.resize(1_884, 0);

        assert!(classify_ft_script(&Script::from_bytes(bytes)).is_err());
    }

    #[test]
    fn order_padding_matches_tbc_contract_165_output_formula() {
        assert_eq!(order_padding_count(7), 10);
        assert_eq!(order_padding_count(8), 6);
        assert_eq!(order_padding_count(10), 0);
    }
}
