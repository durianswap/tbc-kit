use crate::{
    Address, DEFAULT_FEE_RATE_SAT_PER_KB, DEFAULT_SIGHASH, Error, PrivateKey, Result, SDK_DUST_SAT,
    Transaction, TxIn, TxOut, Utxo,
    builder::{ChangePolicy, finalize_signed_fee},
};

use super::{
    BatchNftTx, CollectionData, Nft, NftData,
    scripts::{
        NFT_CODE_SATOSHIS, NFT_HOLD_SATOSHIS, NFT_TAPE_SATOSHIS, NftVersion, code_script,
        code_script_v1, hold_script, mint_script, nft_version, tape_script,
    },
    unlock::{current_tx_data, pre_pre_tx_data, pre_tx_data},
};

impl Nft {
    pub fn create_collection(
        address: Address,
        _private_key: PrivateKey,
        data: CollectionData,
        funding_utxos: Vec<Utxo>,
    ) -> Result<Transaction> {
        let mut outputs = vec![TxOut {
            satoshis: NFT_TAPE_SATOSHIS,
            script_pubkey: tape_script(&data)?,
        }];
        for _ in 0..data.supply {
            outputs.push(TxOut {
                satoshis: NFT_HOLD_SATOSHIS,
                script_pubkey: mint_script(&address),
            });
        }
        build_with_funding(funding_utxos, outputs, address)
    }

    pub fn create_nft(
        collection_id: String,
        address: Address,
        private_key: PrivateKey,
        data: NftData,
        funding_utxos: Vec<Utxo>,
        mint_slot: Utxo,
    ) -> Result<Transaction> {
        Self::create_nft_with_version(
            collection_id,
            address,
            private_key,
            data,
            funding_utxos,
            mint_slot,
            NftVersion::V2,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_nft_with_version(
        collection_id: String,
        address: Address,
        private_key: PrivateKey,
        mut data: NftData,
        funding_utxos: Vec<Utxo>,
        mint_slot: Utxo,
        version: NftVersion,
    ) -> Result<Transaction> {
        if data.file.is_none() {
            data.file = Some(format!(
                "{}{}",
                collection_id,
                hex::encode(mint_slot.outpoint.vout.to_le_bytes())
            ));
        }

        let nft_code = match version {
            NftVersion::V1 => code_script_v1(
                &mint_slot.outpoint.txid.to_string(),
                mint_slot.outpoint.vout,
            )?,
            NftVersion::V2 => code_script(
                &mint_slot.outpoint.txid.to_string(),
                mint_slot.outpoint.vout,
            )?,
            NftVersion::V0 => {
                return Err(Error::InvalidScript(
                    "NFT v0 creation is not supported by this SDK".to_string(),
                ));
            }
        };
        let outputs = vec![
            TxOut {
                satoshis: NFT_CODE_SATOSHIS,
                script_pubkey: nft_code,
            },
            TxOut {
                satoshis: NFT_HOLD_SATOSHIS,
                script_pubkey: hold_script(&address),
            },
            TxOut {
                satoshis: NFT_TAPE_SATOSHIS,
                script_pubkey: tape_script(&data)?,
            },
        ];

        build_with_contract_first_input(mint_slot, private_key, funding_utxos, outputs, address)
    }

    pub fn batch_create_nft(
        collection_id: String,
        address: Address,
        private_key: PrivateKey,
        datas: Vec<NftData>,
        funding_utxos: Vec<Utxo>,
        mint_slots: Vec<Utxo>,
    ) -> Result<Vec<BatchNftTx>> {
        Self::batch_create_nft_with_version(
            collection_id,
            address,
            private_key,
            datas,
            funding_utxos,
            mint_slots,
            NftVersion::V2,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn batch_create_nft_with_version(
        collection_id: String,
        address: Address,
        private_key: PrivateKey,
        datas: Vec<NftData>,
        funding_utxos: Vec<Utxo>,
        mint_slots: Vec<Utxo>,
        version: NftVersion,
    ) -> Result<Vec<BatchNftTx>> {
        if datas.len() != mint_slots.len() {
            return Err(Error::InvalidUtxo(
                "NFT data length must match mint slot length".to_string(),
            ));
        }

        let mut txs = Vec::<Transaction>::new();
        let mut results = Vec::with_capacity(datas.len());
        for (index, (mut data, mint_slot)) in datas.into_iter().zip(mint_slots).enumerate() {
            data.file = Some(format!(
                "{}{}",
                collection_id,
                hex::encode(mint_slot.outpoint.vout.to_le_bytes())
            ));
            let fee_utxos = if index == 0 {
                funding_utxos.clone()
            } else {
                vec![previous_change_utxo(
                    txs.last().ok_or_else(|| {
                        Error::InvalidUtxo("missing previous batch transaction".to_string())
                    })?,
                    &private_key,
                )?]
            };
            let tx = Self::create_nft_with_version(
                collection_id.clone(),
                address.clone(),
                private_key.clone(),
                data,
                fee_utxos,
                mint_slot,
                version,
            )?;
            results.push(BatchNftTx {
                txraw: tx.to_hex(),
                txid: tx.txid().to_string(),
            });
            txs.push(tx);
        }

        Ok(results)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn transfer_nft(
        &self,
        address_from: Address,
        address_to: Address,
        private_key: PrivateKey,
        funding_utxos: Vec<Utxo>,
        pre_tx: Transaction,
        pre_pre_tx: Transaction,
        batch: bool,
    ) -> Result<Transaction> {
        let previous_code = pre_tx
            .outputs
            .first()
            .ok_or_else(|| Error::InvalidUtxo("NFT pre tx missing code output".to_string()))?;
        let next_code = match nft_version(&previous_code.script_pubkey) {
            Some(NftVersion::V2) => code_script(&self.collection_id, self.collection_index)?,
            Some(NftVersion::V1) => code_script_v1(&self.collection_id, self.collection_index)?,
            Some(NftVersion::V0) => {
                return Err(Error::InvalidScript(
                    "NFT v0 transfer is not supported by this SDK".to_string(),
                ));
            }
            None => {
                return Err(Error::InvalidScript(
                    "previous output is not a recognized NFT code script".to_string(),
                ));
            }
        };
        let outputs = vec![
            TxOut {
                satoshis: NFT_CODE_SATOSHIS,
                script_pubkey: next_code,
            },
            TxOut {
                satoshis: NFT_HOLD_SATOSHIS,
                script_pubkey: hold_script(&address_to),
            },
            TxOut {
                satoshis: NFT_TAPE_SATOSHIS,
                script_pubkey: tape_script(&self.nft_data)?,
            },
        ];

        build_transfer_tx(
            &pre_tx,
            &pre_pre_tx,
            &private_key,
            &funding_utxos,
            &outputs,
            &address_from,
            batch,
        )
    }
}

fn previous_change_utxo(prev_tx: &Transaction, private_key: &PrivateKey) -> Result<Utxo> {
    let output = prev_tx
        .outputs
        .get(3)
        .ok_or_else(|| Error::InvalidUtxo("missing previous batch change output".to_string()))?;
    Ok(Utxo {
        outpoint: crate::OutPoint {
            txid: prev_tx.txid(),
            vout: 3,
        },
        satoshis: output.satoshis,
        script_pubkey: output.script_pubkey.clone(),
        private_key: private_key.clone(),
    })
}

fn build_with_funding(
    funding_utxos: Vec<Utxo>,
    outputs: Vec<TxOut>,
    change_address: Address,
) -> Result<Transaction> {
    if funding_utxos.is_empty() {
        return Err(Error::InvalidUtxo(
            "at least one funding UTXO is required".to_string(),
        ));
    }
    let input_sum = sum_utxos(&funding_utxos)?;
    let output_sum = sum_outputs(&outputs)?;
    finalize_signed_fee(
        input_sum,
        output_sum,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        ChangePolicy::Optional { dust: SDK_DUST_SAT },
        |change| sign_funding_tx(&funding_utxos, &outputs, &change_address, change),
    )
}

fn build_with_contract_first_input(
    contract_utxo: Utxo,
    contract_private_key: PrivateKey,
    funding_utxos: Vec<Utxo>,
    outputs: Vec<TxOut>,
    change_address: Address,
) -> Result<Transaction> {
    let input_sum = contract_utxo
        .satoshis
        .checked_add(sum_utxos(&funding_utxos)?)
        .ok_or_else(|| Error::InvalidUtxo("input amount overflow".to_string()))?;
    let output_sum = sum_outputs(&outputs)?;
    finalize_signed_fee(
        input_sum,
        output_sum,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        ChangePolicy::Optional { dust: SDK_DUST_SAT },
        |change| {
            sign_contract_first_tx(
                &contract_utxo,
                &contract_private_key,
                &funding_utxos,
                &outputs,
                &change_address,
                change,
            )
        },
    )
}

fn build_transfer_tx(
    pre_tx: &Transaction,
    pre_pre_tx: &Transaction,
    private_key: &PrivateKey,
    funding_utxos: &[Utxo],
    outputs: &[TxOut],
    change_address: &Address,
    batch: bool,
) -> Result<Transaction> {
    let code_output = pre_tx
        .outputs
        .first()
        .ok_or_else(|| Error::InvalidUtxo("NFT pre tx missing code output".to_string()))?;
    let hold_output = pre_tx
        .outputs
        .get(1)
        .ok_or_else(|| Error::InvalidUtxo("NFT pre tx missing hold output".to_string()))?;
    let input_sum = code_output
        .satoshis
        .checked_add(hold_output.satoshis)
        .and_then(|sum| sum.checked_add(sum_utxos(funding_utxos).ok()?))
        .ok_or_else(|| Error::InvalidUtxo("input amount overflow".to_string()))?;
    let output_sum = sum_outputs(outputs)?;
    let change_policy = if batch {
        ChangePolicy::Forbidden
    } else {
        ChangePolicy::Optional { dust: SDK_DUST_SAT }
    };
    finalize_signed_fee(
        input_sum,
        output_sum,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        change_policy,
        |change| {
            sign_transfer_tx(
                pre_tx,
                pre_pre_tx,
                private_key,
                funding_utxos,
                outputs,
                change_address,
                change,
            )
        },
    )
}

fn sign_transfer_tx(
    pre_tx: &Transaction,
    pre_pre_tx: &Transaction,
    private_key: &PrivateKey,
    funding_utxos: &[Utxo],
    outputs: &[TxOut],
    change_address: &Address,
    change: Option<u64>,
) -> Result<Transaction> {
    let code_output = pre_tx
        .outputs
        .first()
        .ok_or_else(|| Error::InvalidUtxo("NFT pre tx missing code output".to_string()))?;
    let hold_output = pre_tx
        .outputs
        .get(1)
        .ok_or_else(|| Error::InvalidUtxo("NFT pre tx missing hold output".to_string()))?;

    let mut tx = Transaction::new();
    tx.add_input_from_prev_tx(pre_tx, 0)?;
    tx.add_input_from_prev_tx(pre_tx, 1)?;
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

    sign_nft_code_input(&mut tx, 0, private_key, code_output, pre_tx, pre_pre_tx)?;
    tx.sign_input_with_chunks(
        1,
        private_key,
        &hold_output.script_pubkey,
        hold_output.satoshis,
        DEFAULT_SIGHASH,
        &[],
    )?;
    sign_funding_inputs(&mut tx, 2, funding_utxos)?;
    Ok(tx)
}

fn sign_nft_code_input(
    tx: &mut Transaction,
    input_index: usize,
    private_key: &PrivateKey,
    code_output: &TxOut,
    pre_tx: &Transaction,
    pre_pre_tx: &Transaction,
) -> Result<()> {
    let signature = tx.signature_with_hashtype(
        input_index,
        private_key,
        &code_output.script_pubkey,
        code_output.satoshis,
        DEFAULT_SIGHASH,
    )?;
    let public_key = private_key.public_key().to_bytes();
    let mut script = Vec::new();
    push_script_data(&mut script, &signature)?;
    push_script_data(&mut script, &public_key)?;
    script.extend_from_slice(&current_tx_data(tx)?);
    script.extend_from_slice(&pre_pre_tx_data(pre_pre_tx)?);
    script.extend_from_slice(&pre_tx_data(pre_tx)?);
    tx.inputs[input_index].script_sig = crate::script::Script::from_bytes(script);
    Ok(())
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
    sign_funding_inputs(&mut tx, 0, funding_utxos)?;
    Ok(tx)
}

fn sign_contract_first_tx(
    contract_utxo: &Utxo,
    contract_private_key: &PrivateKey,
    funding_utxos: &[Utxo],
    outputs: &[TxOut],
    change_address: &Address,
    change: Option<u64>,
) -> Result<Transaction> {
    let mut tx = Transaction::new();
    tx.inputs.push(TxIn::new(contract_utxo.outpoint.clone()));
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

    tx.sign_input_with_chunks(
        0,
        contract_private_key,
        &contract_utxo.script_pubkey,
        contract_utxo.satoshis,
        DEFAULT_SIGHASH,
        &[],
    )?;
    sign_funding_inputs(&mut tx, 1, funding_utxos)?;
    Ok(tx)
}

fn sign_funding_inputs(
    tx: &mut Transaction,
    start_index: usize,
    funding_utxos: &[Utxo],
) -> Result<()> {
    for (offset, utxo) in funding_utxos.iter().enumerate() {
        tx.sign_p2pkh_input(
            start_index + offset,
            &utxo.private_key,
            &utxo.script_pubkey,
            utxo.satoshis,
            DEFAULT_SIGHASH,
        )?;
    }
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

fn push_script_data(out: &mut Vec<u8>, data: &[u8]) -> Result<()> {
    match data.len() {
        0..=75 => out.push(data.len() as u8),
        76..=0xff => {
            out.push(crate::script::opcodes::OP_PUSHDATA1);
            out.push(data.len() as u8);
        }
        0x100..=0xffff => {
            out.push(crate::script::opcodes::OP_PUSHDATA2);
            out.extend_from_slice(&(data.len() as u16).to_le_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            out.push(crate::script::opcodes::OP_PUSHDATA4);
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        }
        _ => {
            return Err(Error::InvalidScript(
                "script push exceeds maximum supported length".to_string(),
            ));
        }
    }
    out.extend_from_slice(data);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{CollectionData, Nft, NftData, scripts, unlock};

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

    #[test]
    fn nft_create_collection_builds_tape_and_mint_slots() {
        let key = crate::PrivateKey::from_slice(&[11u8; 32]).unwrap();
        let address = key.address();
        let utxo = test_utxo(&key, 50_000, 0);
        let data = CollectionData {
            collection_name: "Rust Collection".to_string(),
            description: "demo".to_string(),
            supply: 2,
            file: "ipfs://collection".to_string(),
        };

        let tx = Nft::create_collection(address, key, data, vec![utxo]).unwrap();

        assert_eq!(tx.outputs[0].satoshis, 0);
        assert!(tx.outputs[0].script_pubkey.is_op_return());
        assert_eq!(tx.outputs[1].satoshis, 100);
        assert_eq!(tx.outputs[2].satoshis, 100);
        assert!(tx.outputs.len() >= 3);
    }

    #[test]
    fn nft_collection_never_underpays_after_signature_size_oscillation() {
        let key = crate::PrivateKey::from_slice(&[1u8; 32]).unwrap();
        let data = CollectionData {
            collection_name: "Parity".to_string(),
            description: "fee-boundary".to_string(),
            supply: 80,
            file: "fixture".to_string(),
        };

        let mut second_utxo = test_utxo(&key, 100_000, 1);
        second_utxo.outpoint.txid = crate::Txid::from_le_bytes([2u8; 32]);
        let tx = Nft::create_collection(
            key.address(),
            key.clone(),
            data,
            vec![test_utxo(&key, 100_000, 0), second_utxo],
        )
        .unwrap();

        assert_target_fee(&tx, 200_000);
    }

    #[test]
    fn nft_create_nft_builds_code_hold_tape_and_sets_default_file() {
        let key = crate::PrivateKey::from_slice(&[12u8; 32]).unwrap();
        let address = key.address();
        let fee_utxo = test_utxo(&key, 50_000, 1);
        let mint_slot = test_utxo(&key, 100, 7);
        let data = NftData {
            nft_name: "One".to_string(),
            symbol: "ONE".to_string(),
            description: "demo".to_string(),
            attributes: "{}".to_string(),
            file: None,
        };

        let tx = Nft::create_nft(
            "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff".to_string(),
            address,
            key,
            data,
            vec![fee_utxo],
            mint_slot,
        )
        .unwrap();

        assert_eq!(tx.inputs.len(), 2);
        assert_eq!(tx.outputs[0].satoshis, 200);
        assert_eq!(tx.outputs[1].satoshis, 100);
        assert_eq!(tx.outputs[2].satoshis, 0);
    }

    #[test]
    fn nft_batch_create_rejects_mismatched_data_and_slots() {
        let key = crate::PrivateKey::from_slice(&[13u8; 32]).unwrap();
        let address = key.address();
        let result = Nft::batch_create_nft(
            "00".repeat(32),
            address,
            key.clone(),
            vec![],
            vec![],
            vec![test_utxo(&key, 100, 0)],
        );
        assert!(result.is_err());
    }

    #[test]
    fn nft_transfer_builds_code_hold_tape_outputs() {
        let key = crate::PrivateKey::from_slice(&[14u8; 32]).unwrap();
        let from = key.address();
        let to = crate::PrivateKey::from_slice(&[15u8; 32])
            .unwrap()
            .address();
        let nft_data = NftData {
            nft_name: "One".to_string(),
            symbol: "ONE".to_string(),
            description: "demo".to_string(),
            attributes: "{}".to_string(),
            file: Some("file".to_string()),
        };

        let mut pre_pre_tx = crate::Transaction::new();
        pre_pre_tx.outputs.push(crate::TxOut {
            satoshis: 100,
            script_pubkey: from.script_pubkey(),
        });

        let mut pre_tx = crate::Transaction::new();
        pre_tx.add_input_from_prev_tx(&pre_pre_tx, 0).unwrap();
        pre_tx.outputs.push(crate::TxOut {
            satoshis: 200,
            script_pubkey: scripts::code_script(&pre_pre_tx.txid().to_string(), 0).unwrap(),
        });
        pre_tx.outputs.push(crate::TxOut {
            satoshis: 100,
            script_pubkey: scripts::hold_script(&from),
        });
        pre_tx.outputs.push(crate::TxOut {
            satoshis: 0,
            script_pubkey: scripts::tape_script(&nft_data).unwrap(),
        });

        let nft = Nft::new("00".repeat(32), 0).with_data(nft_data);
        let tx = nft
            .transfer_nft(
                from,
                to,
                key.clone(),
                vec![test_utxo(&key, 50_000, 2)],
                pre_tx,
                pre_pre_tx,
                false,
            )
            .unwrap();

        assert_eq!(tx.outputs[0].satoshis, 200);
        assert_eq!(tx.outputs[1].satoshis, 100);
        assert_eq!(tx.outputs[2].satoshis, 0);
        assert!(
            tx.inputs[0].script_sig.as_bytes().len() > tx.inputs[1].script_sig.as_bytes().len()
        );
    }

    #[test]
    fn nft_transfer_preserves_legacy_v1_code_automatically() {
        let key = crate::PrivateKey::from_slice(&[18u8; 32]).unwrap();
        let from = key.address();
        let to = crate::PrivateKey::from_slice(&[19u8; 32])
            .unwrap()
            .address();
        let nft_data = NftData {
            nft_name: "Legacy".to_string(),
            symbol: "V1".to_string(),
            description: "demo".to_string(),
            attributes: "{}".to_string(),
            file: Some("file".to_string()),
        };
        let mut pre_pre_tx = crate::Transaction::new();
        pre_pre_tx.outputs.push(crate::TxOut {
            satoshis: 100,
            script_pubkey: from.script_pubkey(),
        });
        let mut pre_tx = crate::Transaction::new();
        pre_tx.add_input_from_prev_tx(&pre_pre_tx, 0).unwrap();
        pre_tx.outputs.push(crate::TxOut {
            satoshis: 200,
            script_pubkey: scripts::code_script_v1(&pre_pre_tx.txid().to_string(), 0).unwrap(),
        });
        pre_tx.outputs.push(crate::TxOut {
            satoshis: 100,
            script_pubkey: scripts::hold_script(&from),
        });
        pre_tx.outputs.push(crate::TxOut {
            satoshis: 0,
            script_pubkey: scripts::tape_script(&nft_data).unwrap(),
        });

        let tx = Nft::new("00".repeat(32), 0)
            .with_data(nft_data)
            .transfer_nft(
                from,
                to,
                key.clone(),
                vec![test_utxo(&key, 50_000, 4)],
                pre_tx,
                pre_pre_tx,
                false,
            )
            .unwrap();

        assert_eq!(
            scripts::nft_version(&tx.outputs[0].script_pubkey),
            Some(scripts::NftVersion::V1)
        );
    }

    #[test]
    fn nft_transfer_code_unlock_appends_contract_data_without_push_wrapping() {
        let key = crate::PrivateKey::from_slice(&[16u8; 32]).unwrap();
        let from = key.address();
        let to = crate::PrivateKey::from_slice(&[17u8; 32])
            .unwrap()
            .address();
        let nft_data = NftData {
            nft_name: "One".to_string(),
            symbol: "ONE".to_string(),
            description: "demo".to_string(),
            attributes: "{}".to_string(),
            file: Some("file".to_string()),
        };

        let mut pre_pre_tx = crate::Transaction::new();
        pre_pre_tx.outputs.push(crate::TxOut {
            satoshis: 100,
            script_pubkey: from.script_pubkey(),
        });

        let mut pre_tx = crate::Transaction::new();
        pre_tx.add_input_from_prev_tx(&pre_pre_tx, 0).unwrap();
        pre_tx.outputs.push(crate::TxOut {
            satoshis: 200,
            script_pubkey: scripts::code_script(&pre_pre_tx.txid().to_string(), 0).unwrap(),
        });
        pre_tx.outputs.push(crate::TxOut {
            satoshis: 100,
            script_pubkey: scripts::hold_script(&from),
        });
        pre_tx.outputs.push(crate::TxOut {
            satoshis: 0,
            script_pubkey: scripts::tape_script(&nft_data).unwrap(),
        });

        let nft = Nft::new("00".repeat(32), 0).with_data(nft_data);
        let tx = nft
            .transfer_nft(
                from,
                to,
                key.clone(),
                vec![test_utxo(&key, 50_000, 3)],
                pre_tx.clone(),
                pre_pre_tx.clone(),
                false,
            )
            .unwrap();

        let script = tx.inputs[0].script_sig.as_bytes();
        let signature_len = script[0] as usize;
        let pubkey_len_index = 1 + signature_len;
        let pubkey_len = script[pubkey_len_index] as usize;
        let contract_data_offset = pubkey_len_index + 1 + pubkey_len;
        let expected_current = unlock::current_tx_data(&tx).unwrap();

        assert_eq!(
            &script[contract_data_offset..contract_data_offset + expected_current.len()],
            expected_current.as_slice()
        );
    }
}
