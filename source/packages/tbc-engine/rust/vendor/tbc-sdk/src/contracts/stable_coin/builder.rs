use crate::{
    Address, DEFAULT_FEE_RATE_SAT_PER_KB, DEFAULT_SIGHASH, Error, PrivateKey, Result, SDK_DUST_SAT,
    Transaction, TxIn, TxOut, Utxo,
    builder::{ChangePolicy, finalize_signed_fee},
    contracts::ft::builder::FtTransferOptions,
    script::Script,
};

use super::{
    AdminSighash, CoinNftData, FinalizedStableCoinCreate, StableCoin, StableCoinCreate,
    StableCoinMint,
    scripts::{
        COIN_FT_CODE_SATOSHIS, COIN_FT_SEQUENCE, COIN_FT_TAPE_SATOSHIS, COIN_NFT_CODE_SATOSHIS,
        COIN_NFT_HOLD_SATOSHIS, COIN_NFT_TAPE_SATOSHIS, StableCoinMintVersion, admin_hash160,
        amount_slot, coin_mint_code_script_with_version, coin_nft_code_script,
        coin_nft_hold_script_from_hash, coin_nft_tape_script, coin_tape_script,
        get_lock_time_from_tape, schnorr_hold_unlock_script, schnorr_nft_unlock_script,
        update_coin_nft_tape_script,
    },
};
use crate::contracts::ft::{BatchFtTx, Ft, FtReceiver, FtUtxo};

const DUMMY_SCHNORR_SIG64: [u8; 64] = [0u8; 64];

impl StableCoin {
    #[allow(clippy::too_many_arguments)]
    pub fn create_coin(
        &mut self,
        agg_pubkey32: [u8; 32],
        fee_private_key: PrivateKey,
        address_to: Address,
        funding_utxo: Utxo,
        funding_prev_tx: Transaction,
        mint_message: Option<String>,
    ) -> Result<StableCoinCreate> {
        self.create_coin_with_version(
            agg_pubkey32,
            fee_private_key,
            address_to,
            funding_utxo,
            funding_prev_tx,
            mint_message,
            StableCoinMintVersion::V4,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_coin_with_version(
        &mut self,
        agg_pubkey32: [u8; 32],
        fee_private_key: PrivateKey,
        address_to: Address,
        funding_utxo: Utxo,
        funding_prev_tx: Transaction,
        mint_message: Option<String>,
        version: StableCoinMintVersion,
    ) -> Result<StableCoinCreate> {
        if self.total_supply_raw == 0 {
            return Err(Error::InvalidUtxo(
                "stableCoin initial mint amount must be greater than zero".to_string(),
            ));
        }

        let amount = amount_slot(self.total_supply_raw)?;
        let tape_script = coin_tape_script(&amount, self.decimal, &self.name, &self.symbol, 0);
        let admin_pub_hash = admin_hash160(&agg_pubkey32);
        let zero_data = self.coin_nft_data(0);
        let coin_nft = build_coin_nft_tx(
            &fee_private_key,
            &admin_pub_hash,
            &funding_utxo,
            &zero_data,
            DEFAULT_FEE_RATE_SAT_PER_KB,
        )?;
        let updated_tape = coin_nft_tape_script(&self.coin_nft_data(self.total_supply_raw))?;
        let origin_code_hash = coin_nft.outputs[0].script_pubkey.sha256();
        let code_script = coin_mint_code_script_with_version(
            &admin_pub_hash,
            &address_to,
            &origin_code_hash,
            tape_script.as_bytes().len(),
            version,
        )?;

        self.code_script = hex::encode(code_script.as_bytes());
        self.tape_script = hex::encode(tape_script.as_bytes());

        let mint = build_coin_mint_tx(
            &agg_pubkey32,
            &fee_private_key,
            CoinMintInputs::Create {
                coin_nft: &coin_nft,
            },
            &funding_prev_tx,
            vec![
                TxOut {
                    satoshis: COIN_NFT_CODE_SATOSHIS,
                    script_pubkey: coin_nft.outputs[0].script_pubkey.clone(),
                },
                TxOut {
                    satoshis: COIN_NFT_HOLD_SATOSHIS,
                    script_pubkey: coin_nft.outputs[1].script_pubkey.clone(),
                },
                TxOut {
                    satoshis: COIN_NFT_TAPE_SATOSHIS,
                    script_pubkey: updated_tape,
                },
                TxOut {
                    satoshis: COIN_FT_CODE_SATOSHIS,
                    script_pubkey: code_script,
                },
                TxOut {
                    satoshis: COIN_FT_TAPE_SATOSHIS,
                    script_pubkey: tape_script,
                },
            ],
            mint_message,
            DEFAULT_FEE_RATE_SAT_PER_KB,
        )?;
        let sighashes = admin_sighashes(&mint, &coin_nft.outputs[0], &coin_nft.outputs[1])?;

        Ok(StableCoinCreate {
            coin_nft,
            mint,
            sighashes,
            agg_pubkey32,
            funding_prev_tx,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn mint_coin(
        &mut self,
        agg_pubkey32: [u8; 32],
        fee_private_key: PrivateKey,
        address_to: Address,
        mint_amount_raw: u128,
        fee_utxo: Utxo,
        nft_pre_tx: Transaction,
        nft_pre_pre_tx: Transaction,
        mint_message: Option<String>,
    ) -> Result<StableCoinMint> {
        self.mint_coin_with_version(
            agg_pubkey32,
            fee_private_key,
            address_to,
            mint_amount_raw,
            fee_utxo,
            nft_pre_tx,
            nft_pre_pre_tx,
            mint_message,
            StableCoinMintVersion::V4,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn mint_coin_with_version(
        &mut self,
        agg_pubkey32: [u8; 32],
        fee_private_key: PrivateKey,
        address_to: Address,
        mint_amount_raw: u128,
        fee_utxo: Utxo,
        nft_pre_tx: Transaction,
        nft_pre_pre_tx: Transaction,
        mint_message: Option<String>,
        version: StableCoinMintVersion,
    ) -> Result<StableCoinMint> {
        if mint_amount_raw == 0 {
            return Err(Error::InvalidUtxo(
                "stableCoin mint amount must be greater than zero".to_string(),
            ));
        }
        let new_total_supply = self
            .total_supply_raw
            .checked_add(mint_amount_raw)
            .ok_or_else(|| Error::InvalidUtxo("stableCoin total supply overflow".to_string()))?;
        if new_total_supply > 10u128.pow(18) {
            return Err(Error::InvalidUtxo(
                "stableCoin total supply cannot exceed 10^18 raw units".to_string(),
            ));
        }

        let amount = amount_slot(mint_amount_raw)?;
        let tape_script = coin_tape_script(&amount, self.decimal, &self.name, &self.symbol, 0);
        let admin_pub_hash = admin_hash160(&agg_pubkey32);
        let updated_tape =
            update_coin_nft_tape_script(&nft_pre_tx.outputs[2].script_pubkey, new_total_supply)?;
        let origin_code_hash = nft_pre_tx.outputs[0].script_pubkey.sha256();
        let code_script = coin_mint_code_script_with_version(
            &admin_pub_hash,
            &address_to,
            &origin_code_hash,
            tape_script.as_bytes().len(),
            version,
        )?;

        self.total_supply_raw = new_total_supply;
        self.code_script = hex::encode(code_script.as_bytes());
        self.tape_script = hex::encode(tape_script.as_bytes());

        let tx = build_coin_mint_tx(
            &agg_pubkey32,
            &fee_private_key,
            CoinMintInputs::Mint {
                nft_pre_tx: &nft_pre_tx,
                fee_utxo: &fee_utxo,
            },
            &nft_pre_pre_tx,
            vec![
                TxOut {
                    satoshis: COIN_NFT_CODE_SATOSHIS,
                    script_pubkey: nft_pre_tx.outputs[0].script_pubkey.clone(),
                },
                TxOut {
                    satoshis: COIN_NFT_HOLD_SATOSHIS,
                    script_pubkey: nft_pre_tx.outputs[1].script_pubkey.clone(),
                },
                TxOut {
                    satoshis: COIN_NFT_TAPE_SATOSHIS,
                    script_pubkey: updated_tape,
                },
                TxOut {
                    satoshis: COIN_FT_CODE_SATOSHIS,
                    script_pubkey: code_script,
                },
                TxOut {
                    satoshis: COIN_FT_TAPE_SATOSHIS,
                    script_pubkey: tape_script,
                },
            ],
            mint_message,
            DEFAULT_FEE_RATE_SAT_PER_KB,
        )?;
        let sighashes = admin_sighashes(&tx, &nft_pre_tx.outputs[0], &nft_pre_tx.outputs[1])?;

        Ok(StableCoinMint {
            tx,
            sighashes,
            agg_pubkey32,
            nft_pre_tx,
            nft_pre_pre_tx,
        })
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
        let options = coin_transfer_options(&pre_txs, &ft_utxos)?;
        self.as_ft().transfer_with_options(
            private_key,
            address_to,
            amount_raw,
            ft_utxos,
            fee_utxo,
            pre_txs.clone(),
            pre_pre_tx_data_set,
            tbc_amount_sat,
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
        let options = coin_transfer_options(&pre_txs, &ft_utxos)?;
        self.as_ft().batch_transfer_with_options(
            private_key,
            receivers,
            ft_utxos,
            fee_utxo,
            pre_txs.clone(),
            pre_pre_tx_data_set,
            options,
        )
    }

    pub fn merge_coin(
        &self,
        private_key: PrivateKey,
        ft_utxos: Vec<FtUtxo>,
        fee_utxo: Utxo,
        pre_txs: Vec<Transaction>,
        pre_pre_tx_data_set: Vec<Vec<u8>>,
    ) -> Result<Vec<Transaction>> {
        let options = coin_transfer_options(&pre_txs, &ft_utxos)?;
        self.as_ft().merge_ft_with_options(
            private_key,
            ft_utxos,
            fee_utxo,
            pre_txs.clone(),
            pre_pre_tx_data_set,
            options,
        )
    }

    fn coin_nft_data(&self, total_supply_raw: u128) -> CoinNftData {
        CoinNftData {
            nft_name: format!("{} NFT", self.name),
            nft_symbol: format!("{} NFT", self.symbol),
            description: "The sole issuance certificate for the stablecoin, dynamically recording cumulative supply and issuance history. Non-transferable, real-time updated, ensuring full transparency and auditability.".to_string(),
            coin_decimal: self.decimal,
            coin_total_supply: total_supply_raw.to_string(),
        }
    }

    fn as_ft(&self) -> Ft {
        Ft {
            name: self.name.clone(),
            symbol: self.symbol.clone(),
            decimal: self.decimal,
            total_supply_raw: self.total_supply_raw,
            code_script: self.code_script.clone(),
            tape_script: self.tape_script.clone(),
            contract_txid: self.contract_txid.clone(),
        }
    }
}

impl StableCoinCreate {
    pub fn finalize_with_admin_key(
        &self,
        admin_key: &PrivateKey,
    ) -> Result<FinalizedStableCoinCreate> {
        if admin_key.x_only_public_key() != self.agg_pubkey32 {
            return Err(Error::InvalidUtxo(
                "admin private key does not match stableCoin aggregate x-only pubkey".to_string(),
            ));
        }
        let signatures = self
            .sighashes
            .iter()
            .map(|item| admin_key.sign_schnorr_digest(&item.sighash))
            .collect::<Vec<_>>();
        self.finalize(&signatures)
    }

    pub fn finalize(&self, schnorr_sigs64: &[[u8; 64]]) -> Result<FinalizedStableCoinCreate> {
        if schnorr_sigs64.len() != 2 {
            return Err(Error::InvalidUtxo(
                "create_coin finalize expected two Schnorr signatures".to_string(),
            ));
        }
        let mut mint = self.mint.clone();
        mint.inputs[0].script_sig = schnorr_nft_unlock_script(
            &schnorr_sigs64[0],
            &self.agg_pubkey32,
            &mint,
            &self.coin_nft,
            &self.funding_prev_tx,
        )?;
        mint.inputs[1].script_sig =
            schnorr_hold_unlock_script(&schnorr_sigs64[1], &self.agg_pubkey32)?;
        Ok(FinalizedStableCoinCreate {
            coin_nft: self.coin_nft.clone(),
            contract_txid: mint.txid().to_string(),
            mint,
        })
    }
}

impl StableCoinMint {
    pub fn finalize_with_admin_key(&self, admin_key: &PrivateKey) -> Result<Transaction> {
        if admin_key.x_only_public_key() != self.agg_pubkey32 {
            return Err(Error::InvalidUtxo(
                "admin private key does not match stableCoin aggregate x-only pubkey".to_string(),
            ));
        }
        let signatures = self
            .sighashes
            .iter()
            .map(|item| admin_key.sign_schnorr_digest(&item.sighash))
            .collect::<Vec<_>>();
        self.finalize(&signatures)
    }

    pub fn finalize(&self, schnorr_sigs64: &[[u8; 64]]) -> Result<Transaction> {
        if schnorr_sigs64.len() != 2 {
            return Err(Error::InvalidUtxo(
                "mint_coin finalize expected two Schnorr signatures".to_string(),
            ));
        }
        let mut tx = self.tx.clone();
        tx.inputs[0].script_sig = schnorr_nft_unlock_script(
            &schnorr_sigs64[0],
            &self.agg_pubkey32,
            &tx,
            &self.nft_pre_tx,
            &self.nft_pre_pre_tx,
        )?;
        tx.inputs[1].script_sig =
            schnorr_hold_unlock_script(&schnorr_sigs64[1], &self.agg_pubkey32)?;
        Ok(tx)
    }
}

enum CoinMintInputs<'a> {
    Create {
        coin_nft: &'a Transaction,
    },
    Mint {
        nft_pre_tx: &'a Transaction,
        fee_utxo: &'a Utxo,
    },
}

fn build_coin_nft_tx(
    fee_private_key: &PrivateKey,
    admin_pub_hash: &[u8; 20],
    funding_utxo: &Utxo,
    data: &CoinNftData,
    fee_rate: u64,
) -> Result<Transaction> {
    let code_script = coin_nft_code_script(
        &funding_utxo.outpoint.txid.to_string(),
        funding_utxo.outpoint.vout,
    )?;
    let hold_script = coin_nft_hold_script_from_hash(admin_pub_hash, &data.nft_name);
    let tape_script = coin_nft_tape_script(data)?;
    let outputs = vec![
        TxOut {
            satoshis: COIN_NFT_CODE_SATOSHIS,
            script_pubkey: code_script,
        },
        TxOut {
            satoshis: COIN_NFT_HOLD_SATOSHIS,
            script_pubkey: hold_script,
        },
        TxOut {
            satoshis: COIN_NFT_TAPE_SATOSHIS,
            script_pubkey: tape_script,
        },
    ];

    let input_sum = funding_utxo.satoshis;
    let output_sum = sum_outputs(&outputs)?;
    finalize_signed_fee(
        input_sum,
        output_sum,
        fee_rate,
        fee_rate,
        ChangePolicy::Required {
            minimum: SDK_DUST_SAT,
        },
        |change| {
            let change = change
                .ok_or_else(|| Error::InvalidUtxo("coinNFT fee change is required".to_string()))?;
            sign_coin_nft_tx(funding_utxo, fee_private_key, &outputs, change)
        },
    )
}

fn sign_coin_nft_tx(
    funding_utxo: &Utxo,
    fee_private_key: &PrivateKey,
    outputs: &[TxOut],
    change: u64,
) -> Result<Transaction> {
    if change < SDK_DUST_SAT {
        return Err(Error::InsufficientFunds {
            input: funding_utxo.satoshis,
            required: funding_utxo.satoshis - change + SDK_DUST_SAT,
        });
    }
    let mut tx = Transaction::new();
    tx.inputs.push(TxIn::new(funding_utxo.outpoint.clone()));
    tx.outputs.extend_from_slice(outputs);
    tx.outputs.push(TxOut {
        satoshis: change,
        script_pubkey: fee_private_key.address().script_pubkey(),
    });
    tx.sign_p2pkh_input(
        0,
        &funding_utxo.private_key,
        &funding_utxo.script_pubkey,
        funding_utxo.satoshis,
        DEFAULT_SIGHASH,
    )?;
    Ok(tx)
}

fn build_coin_mint_tx(
    agg_pubkey32: &[u8; 32],
    fee_private_key: &PrivateKey,
    inputs: CoinMintInputs<'_>,
    nft_pre_pre_tx: &Transaction,
    mut outputs: Vec<TxOut>,
    mint_message: Option<String>,
    fee_rate: u64,
) -> Result<Transaction> {
    if let Some(message) = mint_message.filter(|message| !message.is_empty()) {
        outputs.push(TxOut {
            satoshis: 0,
            script_pubkey: Script::op_return(&[message.into_bytes()]),
        });
    }

    let (input_sum, fee_input_satoshis) = match inputs {
        CoinMintInputs::Create { coin_nft } => {
            let fee_output = coin_nft.outputs.get(3).ok_or_else(|| {
                Error::InvalidUtxo("coinNFT transaction missing fee change output".to_string())
            })?;
            (
                COIN_NFT_CODE_SATOSHIS + COIN_NFT_HOLD_SATOSHIS + fee_output.satoshis,
                fee_output.satoshis,
            )
        }
        CoinMintInputs::Mint { fee_utxo, .. } => (
            COIN_NFT_CODE_SATOSHIS + COIN_NFT_HOLD_SATOSHIS + fee_utxo.satoshis,
            fee_utxo.satoshis,
        ),
    };
    let output_sum = sum_outputs(&outputs)?;
    finalize_signed_fee(
        input_sum,
        output_sum,
        fee_rate,
        fee_rate,
        ChangePolicy::Optional { dust: SDK_DUST_SAT },
        |change| {
            sign_coin_mint_tx(
                agg_pubkey32,
                fee_private_key,
                &inputs,
                nft_pre_pre_tx,
                &outputs,
                change.unwrap_or(0),
                fee_input_satoshis,
            )
        },
    )
}

fn sign_coin_mint_tx(
    agg_pubkey32: &[u8; 32],
    fee_private_key: &PrivateKey,
    inputs: &CoinMintInputs<'_>,
    nft_pre_pre_tx: &Transaction,
    outputs: &[TxOut],
    change: u64,
    fee_input_satoshis: u64,
) -> Result<Transaction> {
    let mut tx = Transaction::new();
    match inputs {
        CoinMintInputs::Create { coin_nft } => {
            tx.add_input_from_prev_tx(coin_nft, 0)?;
            tx.add_input_from_prev_tx(coin_nft, 1)?;
            tx.add_input_from_prev_tx(coin_nft, 3)?;
        }
        CoinMintInputs::Mint {
            nft_pre_tx,
            fee_utxo,
        } => {
            tx.add_input_from_prev_tx(nft_pre_tx, 0)?;
            tx.add_input_from_prev_tx(nft_pre_tx, 1)?;
            tx.inputs.push(TxIn::new(fee_utxo.outpoint.clone()));
        }
    }
    tx.outputs.extend_from_slice(outputs);
    if change >= SDK_DUST_SAT {
        tx.outputs.push(TxOut {
            satoshis: change,
            script_pubkey: fee_private_key.address().script_pubkey(),
        });
    }

    let (pre_tx, fee_script) = match inputs {
        CoinMintInputs::Create { coin_nft } => (
            *coin_nft,
            coin_nft
                .outputs
                .get(3)
                .ok_or_else(|| {
                    Error::InvalidUtxo("coinNFT transaction missing fee change output".to_string())
                })?
                .script_pubkey
                .clone(),
        ),
        CoinMintInputs::Mint {
            nft_pre_tx,
            fee_utxo,
        } => (*nft_pre_tx, fee_utxo.script_pubkey.clone()),
    };

    tx.inputs[0].script_sig = schnorr_nft_unlock_script(
        &DUMMY_SCHNORR_SIG64,
        agg_pubkey32,
        &tx,
        pre_tx,
        nft_pre_pre_tx,
    )?;
    tx.inputs[1].script_sig = schnorr_hold_unlock_script(&DUMMY_SCHNORR_SIG64, agg_pubkey32)?;
    tx.sign_p2pkh_input(
        2,
        fee_private_key,
        &fee_script,
        fee_input_satoshis,
        DEFAULT_SIGHASH,
    )?;
    Ok(tx)
}

fn admin_sighashes(
    tx: &Transaction,
    code_output: &TxOut,
    hold_output: &TxOut,
) -> Result<Vec<AdminSighash>> {
    Ok(vec![
        AdminSighash {
            input_index: 0,
            sighash: tx.sighash_digest(
                0,
                &code_output.script_pubkey,
                code_output.satoshis,
                DEFAULT_SIGHASH,
            )?,
        },
        AdminSighash {
            input_index: 1,
            sighash: tx.sighash_digest(
                1,
                &hold_output.script_pubkey,
                hold_output.satoshis,
                DEFAULT_SIGHASH,
            )?,
        },
    ])
}

fn coin_transfer_options(
    pre_txs: &[Transaction],
    ft_utxos: &[FtUtxo],
) -> Result<FtTransferOptions> {
    if pre_txs.len() != ft_utxos.len() {
        return Err(Error::InvalidUtxo(
            "stableCoin ancestry data length must match FT UTXO length".to_string(),
        ));
    }
    let mut lock_time = 0;
    for (pre_tx, ft_utxo) in pre_txs.iter().zip(ft_utxos) {
        let tape_index = ft_utxo.base.outpoint.vout as usize + 1;
        let tape_output = pre_tx.outputs.get(tape_index).ok_or_else(|| {
            Error::InvalidUtxo("stableCoin FT UTXO missing adjacent tape output".to_string())
        })?;
        lock_time = lock_time.max(get_lock_time_from_tape(&tape_output.script_pubkey)?);
    }
    Ok(FtTransferOptions {
        coin_mode: true,
        lock_time,
        ft_sequence: COIN_FT_SEQUENCE,
    })
}

fn sum_outputs(outputs: &[TxOut]) -> Result<u64> {
    outputs
        .iter()
        .try_fold(0u64, |sum, output| sum.checked_add(output.satoshis))
        .ok_or_else(|| Error::InvalidUtxo("output amount overflow".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{OutPoint, Txid};

    fn assert_target_fee(tx: &Transaction, input_sum: u64) {
        let paid = crate::builder::paid_fee(tx, input_sum).unwrap();
        let target =
            crate::builder::fee_for_size(tx.serialize().len(), crate::DEFAULT_FEE_RATE_SAT_PER_KB);
        assert!(
            paid >= target,
            "bytes={} paid={paid} target={target}",
            tx.serialize().len()
        );
    }

    fn test_utxo(key: &PrivateKey, satoshis: u64, vout: u32) -> Utxo {
        Utxo {
            outpoint: OutPoint {
                txid: Txid::from_le_bytes([vout as u8 + 1; 32]),
                vout,
            },
            satoshis,
            script_pubkey: key.address().script_pubkey(),
            private_key: key.clone(),
        }
    }

    #[test]
    fn create_coin_builds_coin_nft_and_preseeded_mint_tx() {
        let key = PrivateKey::from_slice(&[41u8; 32]).unwrap();
        let mut coin =
            StableCoin::new("USD Coin".to_string(), "USDC".to_string(), 1_000_000, 6).unwrap();
        let funding = test_utxo(&key, 20_000, 0);
        let mut funding_prev_tx = Transaction::new();
        funding_prev_tx.outputs.push(TxOut {
            satoshis: funding.satoshis,
            script_pubkey: funding.script_pubkey.clone(),
        });

        let prepared = coin
            .create_coin(
                [7u8; 32],
                key.clone(),
                key.address(),
                funding,
                funding_prev_tx,
                None,
            )
            .unwrap();

        assert_eq!(
            prepared.coin_nft.outputs[0].satoshis,
            COIN_NFT_CODE_SATOSHIS
        );
        assert_eq!(
            prepared.coin_nft.outputs[1].satoshis,
            COIN_NFT_HOLD_SATOSHIS
        );
        assert_eq!(prepared.mint.inputs.len(), 3);
        assert_eq!(prepared.mint.outputs[3].satoshis, COIN_FT_CODE_SATOSHIS);
        assert_eq!(prepared.sighashes.len(), 2);
        assert!(!prepared.mint.inputs[0].script_sig.as_bytes().is_empty());
        assert!(!coin.code_script.is_empty());
        assert!(!coin.tape_script.is_empty());
        assert_target_fee(&prepared.coin_nft, 20_000);
        assert_target_fee(
            &prepared.mint,
            prepared.coin_nft.outputs[0].satoshis
                + prepared.coin_nft.outputs[1].satoshis
                + prepared.coin_nft.outputs[3].satoshis,
        );
    }

    #[test]
    fn finalize_replaces_dummy_admin_signatures_without_changing_size() {
        let key = PrivateKey::from_slice(&[42u8; 32]).unwrap();
        let mut coin =
            StableCoin::new("USD Coin".to_string(), "USDC".to_string(), 1_000_000, 6).unwrap();
        let funding = test_utxo(&key, 20_000, 0);
        let mut funding_prev_tx = Transaction::new();
        funding_prev_tx.outputs.push(TxOut {
            satoshis: funding.satoshis,
            script_pubkey: funding.script_pubkey.clone(),
        });
        let prepared = coin
            .create_coin(
                [8u8; 32],
                key.clone(),
                key.address(),
                funding,
                funding_prev_tx,
                None,
            )
            .unwrap();
        let prepared_len = prepared.mint.serialize().len();

        let finalized = prepared.finalize(&[[1u8; 64], [2u8; 64]]).unwrap();

        assert_eq!(finalized.mint.serialize().len(), prepared_len);
        assert_eq!(finalized.contract_txid, finalized.mint.txid().to_string());
        assert_ne!(
            finalized.mint.inputs[0].script_sig.as_bytes(),
            prepared.mint.inputs[0].script_sig.as_bytes()
        );
    }

    #[test]
    fn finalize_with_admin_key_signs_prepared_create_sighashes() {
        let key = PrivateKey::from_slice(&[46u8; 32]).unwrap();
        let mut coin =
            StableCoin::new("USD Coin".to_string(), "USDC".to_string(), 1_000_000, 6).unwrap();
        let funding = test_utxo(&key, 20_000, 0);
        let mut funding_prev_tx = Transaction::new();
        funding_prev_tx.outputs.push(TxOut {
            satoshis: funding.satoshis,
            script_pubkey: funding.script_pubkey.clone(),
        });
        let prepared = coin
            .create_coin(
                key.x_only_public_key(),
                key.clone(),
                key.address(),
                funding,
                funding_prev_tx,
                None,
            )
            .unwrap();

        let finalized = prepared.finalize_with_admin_key(&key).unwrap();

        assert_eq!(finalized.contract_txid, finalized.mint.txid().to_string());
        assert_ne!(
            finalized.mint.inputs[0].script_sig.as_bytes(),
            prepared.mint.inputs[0].script_sig.as_bytes()
        );
    }

    #[test]
    fn mint_coin_updates_certificate_supply_and_returns_admin_sighashes() {
        let key = PrivateKey::from_slice(&[43u8; 32]).unwrap();
        let mut coin =
            StableCoin::new("USD Coin".to_string(), "USDC".to_string(), 1_000_000, 6).unwrap();
        let funding = test_utxo(&key, 30_000, 0);
        let mut funding_prev_tx = Transaction::new();
        funding_prev_tx.outputs.push(TxOut {
            satoshis: funding.satoshis,
            script_pubkey: funding.script_pubkey.clone(),
        });
        let prepared = coin
            .create_coin(
                [9u8; 32],
                key.clone(),
                key.address(),
                funding,
                funding_prev_tx.clone(),
                None,
            )
            .unwrap();
        let finalized = prepared.finalize(&[[1u8; 64], [2u8; 64]]).unwrap();
        let fee_utxo = test_utxo(&key, 20_000, 1);

        let mint = coin
            .mint_coin(
                [9u8; 32],
                key.clone(),
                key.address(),
                500_000,
                fee_utxo,
                finalized.mint.clone(),
                prepared.coin_nft.clone(),
                Some("top up".to_string()),
            )
            .unwrap();

        let data = crate::contracts::stable_coin::scripts::decode_coin_nft_tape_script(
            &mint.tx.outputs[2].script_pubkey,
        )
        .unwrap();
        assert_eq!(data.coin_total_supply, "1500000");
        assert_eq!(mint.sighashes.len(), 2);
        assert_eq!(mint.tx.outputs[3].satoshis, COIN_FT_CODE_SATOSHIS);
        assert!(mint.tx.outputs[5].script_pubkey.is_op_return());
        assert_eq!(coin.total_supply_raw, 1_500_000);
        assert_target_fee(
            &mint.tx,
            finalized.mint.outputs[0].satoshis + finalized.mint.outputs[1].satoshis + 20_000,
        );
    }

    #[test]
    fn transfer_uses_coin_sequence_locktime_and_unlock_marker() {
        let key = PrivateKey::from_slice(&[44u8; 32]).unwrap();
        let receiver = PrivateKey::from_slice(&[45u8; 32]).unwrap().address();
        let tape_script = crate::contracts::stable_coin::scripts::coin_tape_script(
            &amount_slot(1_000).unwrap(),
            6,
            "USD Coin",
            "USDC",
            500_000_010,
        );
        let code_script = Script::from_asm(&format!(
            "OP_RETURN 0x15 0x{}00 0x05 0x32436f6465",
            hex::encode(key.address().hash160())
        ))
        .unwrap();
        let mut coin =
            StableCoin::new("USD Coin".to_string(), "USDC".to_string(), 1_000, 6).unwrap();
        coin.code_script = hex::encode(code_script.as_bytes());
        coin.tape_script = hex::encode(tape_script.as_bytes());

        let mut pre_tx = Transaction::new();
        pre_tx.outputs.push(TxOut {
            satoshis: COIN_FT_CODE_SATOSHIS,
            script_pubkey: code_script,
        });
        pre_tx.outputs.push(TxOut {
            satoshis: COIN_FT_TAPE_SATOSHIS,
            script_pubkey: tape_script,
        });
        let ft_utxo = FtUtxo {
            base: Utxo {
                outpoint: OutPoint {
                    txid: pre_tx.txid(),
                    vout: 0,
                },
                satoshis: COIN_FT_CODE_SATOSHIS,
                script_pubkey: pre_tx.outputs[0].script_pubkey.clone(),
                private_key: key.clone(),
            },
            ft_balance_raw: 1_000,
        };

        let tx = coin
            .transfer(
                key.clone(),
                receiver,
                400,
                vec![ft_utxo],
                test_utxo(&key, 20_000, 2),
                vec![pre_tx],
                vec![vec![0x57]],
                None,
            )
            .unwrap();

        assert_eq!(tx.lock_time, 500_000_010);
        assert_eq!(tx.inputs[0].sequence, COIN_FT_SEQUENCE);
        assert!(tx.inputs[0].script_sig.as_bytes().windows(3).any(|w| w
            == [
                0x21,
                key.public_key().to_bytes()[0],
                key.public_key().to_bytes()[1]
            ]));
        assert!(tx.inputs[0].script_sig.as_bytes().contains(&0x00));
    }

    #[test]
    fn merge_coin_signs_every_input_after_all_coin_sequences_are_set() {
        let key = PrivateKey::from_slice(&[47u8; 32]).unwrap();
        let tape_script = coin_tape_script(&amount_slot(1_000).unwrap(), 6, "USD Coin", "USDC", 0);
        let code_script = Script::from_asm(&format!(
            "OP_RETURN 0x15 0x{}00 0x05 0x32436f6465",
            hex::encode(key.address().hash160())
        ))
        .unwrap();
        let mut coin =
            StableCoin::new("USD Coin".to_string(), "USDC".to_string(), 2_000, 6).unwrap();
        coin.code_script = hex::encode(code_script.as_bytes());
        coin.tape_script = hex::encode(tape_script.as_bytes());

        let mut pre_txs = Vec::new();
        let mut ft_utxos = Vec::new();
        for lock_time in [1u32, 2] {
            let mut pre_tx = Transaction::new();
            pre_tx.lock_time = lock_time;
            pre_tx.outputs.push(TxOut {
                satoshis: COIN_FT_CODE_SATOSHIS,
                script_pubkey: code_script.clone(),
            });
            pre_tx.outputs.push(TxOut {
                satoshis: COIN_FT_TAPE_SATOSHIS,
                script_pubkey: tape_script.clone(),
            });
            ft_utxos.push(FtUtxo {
                base: Utxo {
                    outpoint: OutPoint {
                        txid: pre_tx.txid(),
                        vout: 0,
                    },
                    satoshis: COIN_FT_CODE_SATOSHIS,
                    script_pubkey: code_script.clone(),
                    private_key: key.clone(),
                },
                ft_balance_raw: 1_000,
            });
            pre_txs.push(pre_tx);
        }

        let tx = coin
            .merge_coin(
                key.clone(),
                ft_utxos.clone(),
                test_utxo(&key, 20_000, 3),
                pre_txs,
                vec![vec![0x57], vec![0x57]],
            )
            .unwrap()
            .remove(0);

        for (input_index, ft_utxo) in ft_utxos.iter().enumerate() {
            let expected = tx
                .signature_with_hashtype(
                    input_index,
                    &key,
                    &ft_utxo.base.script_pubkey,
                    ft_utxo.base.satoshis,
                    DEFAULT_SIGHASH,
                )
                .unwrap();
            assert!(
                tx.inputs[input_index]
                    .script_sig
                    .as_bytes()
                    .windows(expected.len())
                    .any(|window| window == expected),
                "input {input_index} was signed before the final sequence state"
            );
        }
    }
}
