pub mod builder;
mod data;
pub mod scripts;

pub use data::{
    BuyOrderParams, CancelBuyOrderParams, MatchOrderParams, OrderData, OrderUtxo, SellOrderParams,
};

pub struct OrderBook;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PrivateKey, Transaction, TxOut, Utxo};

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

    #[test]
    fn order_data_round_trips_from_sell_script() {
        let key = PrivateKey::from_slice(&[71u8; 32]).unwrap();
        let data = OrderData {
            hold_address: key.address(),
            sale_volume: 12_345,
            ft_partial_hash: [1u8; 32],
            fee_rate: 80,
            unit_price: 2_000,
            ft_contract_id: [2u8; 32],
        };

        let script = scripts::sell_order_script(&data, false, &data.hold_address).unwrap();
        let parsed = OrderBook::get_order_data(&script).unwrap();

        assert_eq!(script.as_bytes().len(), scripts::SELL_ORDER_SCRIPT_SIZE);
        assert_eq!(parsed, data);
    }

    #[test]
    fn buy_script_uses_fixed_length_and_can_update_sale_volume() {
        let key = PrivateKey::from_slice(&[72u8; 32]).unwrap();
        let data = OrderData {
            hold_address: key.address(),
            sale_volume: 99,
            ft_partial_hash: [3u8; 32],
            fee_rate: 0,
            unit_price: 7,
            ft_contract_id: [4u8; 32],
        };

        let script = scripts::buy_order_script(&data, false, &data.hold_address).unwrap();
        let updated = OrderBook::update_sale_volume(&script, 55).unwrap();
        let parsed = OrderBook::get_order_data(&updated).unwrap();

        assert_eq!(script.as_bytes().len(), scripts::BUY_ORDER_SCRIPT_SIZE);
        assert_eq!(parsed.sale_volume, 55);
        assert_eq!(parsed.hold_address, data.hold_address);
    }

    #[test]
    fn make_sell_order_builds_fixed_script_output() {
        let key = PrivateKey::from_slice(&[73u8; 32]).unwrap();
        let ft_code_script = hex::encode(
            crate::contracts::ft::scripts::mint_code_script(
                "22".repeat(32).as_str(),
                0,
                &key.address(),
                64,
            )
            .unwrap()
            .as_bytes(),
        );
        let funding = crate::Utxo {
            outpoint: crate::OutPoint {
                txid: "1111111111111111111111111111111111111111111111111111111111111111"
                    .parse()
                    .unwrap(),
                vout: 0,
            },
            satoshis: 50_000,
            script_pubkey: key.address().script_pubkey(),
            private_key: key.clone(),
        };

        let tx = OrderBook::make_sell_order(SellOrderParams {
            hold_address: key.address(),
            tax_address: key.address(),
            sale_volume: 1_000,
            unit_price: 2_000,
            fee_rate: 80,
            ft_code_script,
            ft_contract_id: [9u8; 32],
            funding_utxos: vec![funding],
        })
        .unwrap();

        assert_eq!(tx.outputs[0].satoshis, 1_000);
        assert_eq!(
            tx.outputs[0].script_pubkey.as_bytes().len(),
            scripts::SELL_ORDER_SCRIPT_SIZE
        );
        assert_eq!(
            OrderBook::get_order_data(&tx.outputs[0].script_pubkey)
                .unwrap()
                .unit_price,
            2_000
        );
    }

    #[test]
    fn make_buy_order_supports_standard_ft_inputs() {
        let key = PrivateKey::from_slice(&[74u8; 32]).unwrap();
        let (ft_utxo, pre_tx, code_hex, tape_hex) = ft_fixture(&key, 1_000, false);

        let tx = OrderBook::make_buy_order(BuyOrderParams {
            hold_address: key.address(),
            tax_address: key.address(),
            sale_volume: 400,
            unit_price: 2_000_000,
            fee_rate: 80,
            ft_code_script: code_hex,
            ft_tape_script: tape_hex,
            ft_contract_id: [5u8; 32],
            ft_utxos: vec![ft_utxo],
            fee_utxo: test_utxo(&key, 50_000, 2),
            pre_txs: vec![pre_tx],
            pre_pre_tx_data_set: vec![vec![0x57]],
        })
        .unwrap();

        assert_eq!(tx.lock_time, crate::DEFAULT_LOCK_TIME);
        assert_eq!(tx.inputs[0].sequence, crate::DEFAULT_SEQUENCE);
        assert_eq!(tx.outputs[0].satoshis, scripts::BUY_ORDER_DUST);
        assert_eq!(
            crate::contracts::ft::amount::balance_from_tape(&tx.outputs[2].script_pubkey).unwrap(),
            800
        );
        assert_eq!(
            tx.outputs[0].script_pubkey.as_bytes().len(),
            scripts::BUY_ORDER_SCRIPT_SIZE
        );
    }

    #[test]
    fn orderbook_enforces_javascript_166_input_caps() {
        let key = PrivateKey::from_slice(&[78u8; 32]).unwrap();
        let code = crate::contracts::ft::scripts::mint_code_script(
            &"44".repeat(32),
            0,
            &key.address(),
            64,
        )
        .unwrap();
        let sell = OrderBook::make_sell_order(SellOrderParams {
            hold_address: key.address(),
            tax_address: key.address(),
            sale_volume: 1,
            unit_price: 1,
            fee_rate: 0,
            ft_code_script: hex::encode(code.as_bytes()),
            ft_contract_id: [0; 32],
            funding_utxos: (0..11).map(|vout| test_utxo(&key, 1_000, vout)).collect(),
        });
        assert!(sell.is_err());

        let (ft_utxo, pre_tx, code_hex, tape_hex) = ft_fixture(&key, 1_000, false);
        let buy = OrderBook::make_buy_order(BuyOrderParams {
            hold_address: key.address(),
            tax_address: key.address(),
            sale_volume: 1,
            unit_price: 1,
            fee_rate: 0,
            ft_code_script: code_hex,
            ft_tape_script: tape_hex,
            ft_contract_id: [0; 32],
            ft_utxos: vec![ft_utxo; 6],
            fee_utxo: test_utxo(&key, 50_000, 20),
            pre_txs: vec![pre_tx; 6],
            pre_pre_tx_data_set: vec![vec![0]; 6],
        });
        assert!(buy.is_err());
    }

    #[test]
    fn make_buy_order_supports_stable_coin_inputs() {
        let key = PrivateKey::from_slice(&[75u8; 32]).unwrap();
        let (ft_utxo, pre_tx, code_hex, tape_hex) = ft_fixture(&key, 1_000, true);

        let tx = OrderBook::make_buy_order(BuyOrderParams {
            hold_address: key.address(),
            tax_address: key.address(),
            sale_volume: 400,
            unit_price: 2_000,
            fee_rate: 80,
            ft_code_script: code_hex,
            ft_tape_script: tape_hex,
            ft_contract_id: [6u8; 32],
            ft_utxos: vec![ft_utxo],
            fee_utxo: test_utxo(&key, 50_000, 3),
            pre_txs: vec![pre_tx],
            pre_pre_tx_data_set: vec![vec![0x57]],
        })
        .unwrap();

        assert_eq!(tx.lock_time, 500_000_111);
        assert_eq!(
            tx.inputs[0].sequence,
            crate::contracts::stable_coin::scripts::COIN_FT_SEQUENCE
        );
        let script = tx.inputs[0].script_sig.as_bytes();
        let pubkey = key.public_key().to_bytes();
        let pubkey_pos = script
            .windows(34)
            .position(|window| window[0] == 33 && window[1..34] == pubkey)
            .unwrap();
        assert_eq!(script[pubkey_pos + 34], 0);
    }

    #[test]
    fn cancel_buy_order_spends_locked_ft_and_returns_it_to_holder() {
        let key = PrivateKey::from_slice(&[78u8; 32]).unwrap();
        let (ft_utxo, pre_tx, code_hex, tape_hex) = ft_v3_fixture(&key, 1_000);
        let buy_tx = OrderBook::make_buy_order(BuyOrderParams {
            hold_address: key.address(),
            tax_address: key.address(),
            sale_volume: 400,
            unit_price: 2_000_000,
            fee_rate: 80,
            ft_code_script: code_hex,
            ft_tape_script: tape_hex,
            ft_contract_id: [7u8; 32],
            ft_utxos: vec![ft_utxo],
            fee_utxo: test_utxo(&key, 50_000, 10),
            pre_txs: vec![pre_tx],
            pre_pre_tx_data_set: vec![vec![0x57]],
        })
        .unwrap();
        let buy_order = order_from_tx(&buy_tx, &key, 0);
        let buy_ft_utxo = ft_from_tx(&buy_tx, &key, 1, 800);
        let mut expected_unlock_suffix = vec![crate::script::opcodes::OP_0];
        expected_unlock_suffix
            .extend_from_slice(&crate::contracts::ft::unlock::pre_tx_data(&buy_tx, 1).unwrap());

        let cancel = OrderBook::cancel_buy_order(CancelBuyOrderParams {
            buy_order,
            buy_ft_utxo,
            buy_pre_tx: buy_tx,
            buy_pre_pre_tx_data: vec![0x57],
            fee_utxos: vec![test_utxo(&key, 50_000, 11)],
        })
        .unwrap();

        assert_eq!(cancel.inputs.len(), 3);
        assert_eq!(cancel.inputs[1].previous_output.vout, 1);
        assert_eq!(
            cancel.outputs[0].satoshis,
            crate::contracts::ft::scripts::FT_CODE_SATOSHIS
        );
        assert_eq!(
            crate::contracts::ft::amount::balance_from_tape(&cancel.outputs[1].script_pubkey)
                .unwrap(),
            800
        );
        assert!(
            cancel.inputs[1]
                .script_sig
                .as_bytes()
                .ends_with(&expected_unlock_suffix)
        );
    }

    #[test]
    fn cancel_buy_order_uses_swap_unlock_for_stable_coin_locked_ft() {
        let key = PrivateKey::from_slice(&[79u8; 32]).unwrap();
        let (ft_utxo, pre_tx, code_hex, tape_hex) = ft_fixture(&key, 1_000, true);
        let buy_tx = OrderBook::make_buy_order(BuyOrderParams {
            hold_address: key.address(),
            tax_address: key.address(),
            sale_volume: 400,
            unit_price: 2_000_000,
            fee_rate: 80,
            ft_code_script: code_hex,
            ft_tape_script: tape_hex,
            ft_contract_id: [8u8; 32],
            ft_utxos: vec![ft_utxo],
            fee_utxo: test_utxo(&key, 50_000, 12),
            pre_txs: vec![pre_tx],
            pre_pre_tx_data_set: vec![vec![0x57]],
        })
        .unwrap();
        let buy_order = order_from_tx(&buy_tx, &key, 0);
        let buy_ft_utxo = ft_from_tx(&buy_tx, &key, 1, 800);

        let cancel = OrderBook::cancel_buy_order(CancelBuyOrderParams {
            buy_order,
            buy_ft_utxo,
            buy_pre_tx: buy_tx,
            buy_pre_pre_tx_data: vec![0x57],
            fee_utxos: vec![test_utxo(&key, 50_000, 13)],
        })
        .unwrap();

        assert_eq!(cancel.lock_time, 500_000_111);
        assert_eq!(
            cancel.inputs[1].sequence,
            crate::contracts::stable_coin::scripts::COIN_FT_SEQUENCE
        );
        let script = cancel.inputs[1].script_sig.as_bytes();
        let pubkey = key.public_key().to_bytes();
        let pubkey_pos = script
            .windows(34)
            .position(|window| window[0] == 33 && window[1..34] == pubkey)
            .unwrap();
        assert_ne!(script[pubkey_pos + 34], 0);
    }

    #[test]
    fn match_order_supports_standard_ft_seller_input() {
        let key = PrivateKey::from_slice(&[76u8; 32]).unwrap();
        let (ft_utxo, pre_tx, code_hex, tape_hex) = ft_v3_fixture(&key, 1_000);
        let buy_tx = OrderBook::make_buy_order(BuyOrderParams {
            hold_address: key.address(),
            tax_address: key.address(),
            sale_volume: 400,
            unit_price: 2_000_000,
            fee_rate: 0,
            ft_code_script: code_hex.clone(),
            ft_tape_script: tape_hex,
            ft_contract_id: [5u8; 32],
            ft_utxos: vec![ft_utxo],
            fee_utxo: test_utxo(&key, 50_000, 14),
            pre_txs: vec![pre_tx],
            pre_pre_tx_data_set: vec![vec![0x57]],
        })
        .unwrap();
        let mut expected_unlock_suffix = vec![crate::script::opcodes::OP_0];
        expected_unlock_suffix
            .extend_from_slice(&crate::contracts::ft::unlock::pre_tx_data(&buy_tx, 1).unwrap());
        let sell_tx = OrderBook::make_sell_order(SellOrderParams {
            hold_address: key.address(),
            tax_address: key.address(),
            sale_volume: 400,
            unit_price: 2_000_000,
            fee_rate: 0,
            ft_code_script: code_hex,
            ft_contract_id: [5u8; 32],
            funding_utxos: vec![test_utxo(&key, 50_000, 15)],
        })
        .unwrap();
        let params = MatchOrderParams {
            buy_order: order_from_tx(&buy_tx, &key, 0),
            buy_ft_utxo: ft_from_tx(&buy_tx, &key, 1, 800),
            buy_pre_tx: buy_tx,
            buy_pre_pre_tx_data: vec![0x57],
            sell_order: order_from_tx(&sell_tx, &key, 0),
            sell_pre_tx: sell_tx,
            matcher_private_key: key.clone(),
            ft_fee_address: key.address(),
            tbc_fee_address: key.address(),
            fee_utxo: test_utxo(&key, 50_000, 6),
        };
        let input_sum = match_input_sum(&params);
        let tx = OrderBook::match_order(params).unwrap();

        assert_eq!(tx.lock_time, crate::DEFAULT_LOCK_TIME);
        assert_eq!(tx.inputs[1].sequence, crate::DEFAULT_SEQUENCE);
        assert_eq!(tx.inputs[0].previous_output.vout, 0);
        assert_eq!(tx.inputs[1].previous_output.vout, 1);
        assert_eq!(tx.inputs[2].previous_output.vout, 0);
        assert_eq!(
            tx.outputs[0].satoshis,
            crate::contracts::ft::scripts::FT_CODE_SATOSHIS
        );
        assert_eq!(
            crate::contracts::ft::amount::balance_from_tape(&tx.outputs[1].script_pubkey).unwrap(),
            800
        );
        assert_eq!(tx.outputs[4].satoshis, 400);
        assert!(
            tx.inputs[1]
                .script_sig
                .as_bytes()
                .ends_with(&expected_unlock_suffix)
        );
        assert_target_fee(&tx, input_sum);
    }

    #[test]
    fn match_order_sell_smaller_preserves_buy_continuation_and_target_fee() {
        let key = PrivateKey::from_slice(&[80u8; 32]).unwrap();

        let (tx, input_sum) = standard_match_fixture(&key, 600, 400, 2_000, 30);

        assert_target_fee(&tx, input_sum);
        assert_eq!(tx.outputs.len(), 10);
        assert_eq!(
            OrderBook::get_order_data(&tx.outputs[7].script_pubkey)
                .unwrap()
                .sale_volume,
            200
        );
        assert_eq!(
            crate::contracts::ft::amount::balance_from_tape(&tx.outputs[9].script_pubkey).unwrap(),
            400
        );
    }

    #[test]
    fn match_order_buy_smaller_preserves_sell_continuation_and_target_fee() {
        let key = PrivateKey::from_slice(&[81u8; 32]).unwrap();

        let (tx, input_sum) = standard_match_fixture(&key, 400, 600, 1_000, 40);

        assert_target_fee(&tx, input_sum);
        assert_eq!(tx.outputs.len(), 8);
        assert_eq!(tx.outputs[7].satoshis, 200);
        assert_eq!(
            OrderBook::get_order_data(&tx.outputs[7].script_pubkey)
                .unwrap()
                .sale_volume,
            200
        );
    }

    #[test]
    fn match_order_supports_stable_coin_seller_input() {
        let key = PrivateKey::from_slice(&[77u8; 32]).unwrap();
        let (ft_utxo, pre_tx, code_hex, tape_hex) = ft_fixture(&key, 1_000, true);
        let buy_tx = OrderBook::make_buy_order(BuyOrderParams {
            hold_address: key.address(),
            tax_address: key.address(),
            sale_volume: 400,
            unit_price: 2_000_000,
            fee_rate: 0,
            ft_code_script: code_hex.clone(),
            ft_tape_script: tape_hex,
            ft_contract_id: [6u8; 32],
            ft_utxos: vec![ft_utxo],
            fee_utxo: test_utxo(&key, 50_000, 16),
            pre_txs: vec![pre_tx],
            pre_pre_tx_data_set: vec![vec![0x57]],
        })
        .unwrap();
        let sell_tx = OrderBook::make_sell_order(SellOrderParams {
            hold_address: key.address(),
            tax_address: key.address(),
            sale_volume: 400,
            unit_price: 2_000_000,
            fee_rate: 0,
            ft_code_script: code_hex,
            ft_contract_id: [6u8; 32],
            funding_utxos: vec![test_utxo(&key, 50_000, 17)],
        })
        .unwrap();
        let tx = OrderBook::match_order(MatchOrderParams {
            buy_order: order_from_tx(&buy_tx, &key, 0),
            buy_ft_utxo: ft_from_tx(&buy_tx, &key, 1, 800),
            buy_pre_tx: buy_tx.clone(),
            buy_pre_pre_tx_data: vec![0x57],
            sell_order: order_from_tx(&sell_tx, &key, 0),
            sell_pre_tx: sell_tx,
            matcher_private_key: key.clone(),
            ft_fee_address: key.address(),
            tbc_fee_address: key.address(),
            fee_utxo: test_utxo(&key, 50_000, 9),
        })
        .unwrap();

        let rust_outputs = super::builder::order_current_outputs_data(&tx).unwrap();
        assert_eq!(
            hex::encode(crate::hash::sha256(&rust_outputs)),
            "b23c69c1aed327de186d87f8177af79df94c4cfbe7c5426e557111355f68658d",
            "current-output serialization must remain byte-exact with tbc-contract 1.6.6"
        );

        assert_eq!(tx.lock_time, 500_000_111);
        assert_eq!(
            tx.inputs[1].sequence,
            crate::contracts::stable_coin::scripts::COIN_FT_SEQUENCE
        );
        let script = tx.inputs[1].script_sig.as_bytes();
        let pre_tx_data = crate::contracts::ft::unlock::pre_tx_data(&buy_tx, 1).unwrap();
        let mut marker_start = crate::contracts::ft::unlock::current_tx_data(&tx, 1)
            .unwrap()
            .len()
            + 1;
        marker_start += 1 + script[marker_start] as usize;
        marker_start += 1 + script[marker_start] as usize;
        marker_start += crate::contracts::ft::unlock::current_inputs_data(&tx)
            .unwrap()
            .len();
        marker_start += crate::contracts::ft::unlock::contract_tx_data(&buy_tx, -1)
            .unwrap()
            .len();
        assert_eq!(
            &script[marker_start..marker_start + 2],
            &[crate::script::opcodes::OP_0, crate::script::opcodes::OP_1]
        );
        assert_eq!(&script[marker_start + 2..], pre_tx_data);
        let pubkey = key.public_key().to_bytes();
        let pubkey_pos = script
            .windows(34)
            .position(|window| window[0] == 33 && window[1..34] == pubkey)
            .unwrap();
        assert_ne!(script[pubkey_pos + 34], 0);
    }

    fn ft_fixture(
        key: &PrivateKey,
        amount_raw: u128,
        stable_coin: bool,
    ) -> (crate::FtUtxo, Transaction, String, String) {
        let amount = if stable_coin {
            crate::contracts::stable_coin::scripts::amount_slot(amount_raw).unwrap()
        } else {
            let mut amount = [0u8; 48];
            amount[0..8].copy_from_slice(&(amount_raw as u64).to_le_bytes());
            amount
        };
        let tape = if stable_coin {
            crate::contracts::stable_coin::scripts::coin_tape_script(
                &amount,
                6,
                "USD Coin",
                "USDC",
                500_000_111,
            )
        } else {
            crate::contracts::ft::scripts::mint_tape_script(&amount, 6, "Token", "TOK")
        };
        let code = if stable_coin {
            crate::contracts::stable_coin::scripts::coin_mint_code_script(
                &key.address().hash160(),
                &key.address(),
                &[0u8; 32],
                tape.as_bytes().len(),
            )
            .unwrap()
        } else {
            crate::contracts::ft::scripts::mint_code_script(
                &"00".repeat(32),
                0,
                &key.address(),
                tape.as_bytes().len(),
            )
            .unwrap()
        };
        let mut pre_tx = Transaction::new();
        pre_tx.outputs.push(TxOut {
            satoshis: crate::contracts::ft::scripts::FT_CODE_SATOSHIS,
            script_pubkey: code.clone(),
        });
        pre_tx.outputs.push(TxOut {
            satoshis: crate::contracts::ft::scripts::FT_TAPE_SATOSHIS,
            script_pubkey: tape.clone(),
        });
        let ft_utxo = crate::FtUtxo {
            base: Utxo {
                outpoint: crate::OutPoint {
                    txid: pre_tx.txid(),
                    vout: 0,
                },
                satoshis: crate::contracts::ft::scripts::FT_CODE_SATOSHIS,
                script_pubkey: code.clone(),
                private_key: key.clone(),
            },
            ft_balance_raw: amount_raw,
        };
        (
            ft_utxo,
            pre_tx,
            hex::encode(code.as_bytes()),
            hex::encode(tape.as_bytes()),
        )
    }

    fn ft_v3_fixture(
        key: &PrivateKey,
        amount_raw: u128,
    ) -> (crate::FtUtxo, Transaction, String, String) {
        let mut amount = [0u8; 48];
        amount[0..8].copy_from_slice(&(amount_raw as u64).to_le_bytes());
        let tape = crate::contracts::ft::scripts::mint_tape_script(&amount, 6, "Token", "TOK");
        let code = crate::contracts::ft::scripts::mint_code_script(
            "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
            513,
            &key.address(),
            tape.as_bytes().len(),
        )
        .unwrap();
        let mut pre_tx = Transaction::new();
        pre_tx.outputs.push(TxOut {
            satoshis: crate::contracts::ft::scripts::FT_CODE_SATOSHIS,
            script_pubkey: code.clone(),
        });
        pre_tx.outputs.push(TxOut {
            satoshis: crate::contracts::ft::scripts::FT_TAPE_SATOSHIS,
            script_pubkey: tape.clone(),
        });
        let ft_utxo = crate::FtUtxo {
            base: Utxo {
                outpoint: crate::OutPoint {
                    txid: pre_tx.txid(),
                    vout: 0,
                },
                satoshis: crate::contracts::ft::scripts::FT_CODE_SATOSHIS,
                script_pubkey: code.clone(),
                private_key: key.clone(),
            },
            ft_balance_raw: amount_raw,
        };
        (
            ft_utxo,
            pre_tx,
            hex::encode(code.as_bytes()),
            hex::encode(tape.as_bytes()),
        )
    }

    fn standard_match_fixture(
        key: &PrivateKey,
        buy_sale_volume: u64,
        sell_sale_volume: u64,
        source_ft_balance: u128,
        seed_vout: u32,
    ) -> (Transaction, u64) {
        let (ft_utxo, pre_tx, code_hex, tape_hex) = ft_v3_fixture(key, source_ft_balance);
        let buy_tx = OrderBook::make_buy_order(BuyOrderParams {
            hold_address: key.address(),
            tax_address: key.address(),
            sale_volume: buy_sale_volume,
            unit_price: 2_000_000,
            fee_rate: 0,
            ft_code_script: code_hex.clone(),
            ft_tape_script: tape_hex,
            ft_contract_id: [11u8; 32],
            ft_utxos: vec![ft_utxo],
            fee_utxo: test_utxo(key, 50_000, seed_vout),
            pre_txs: vec![pre_tx],
            pre_pre_tx_data_set: vec![vec![0x57]],
        })
        .unwrap();
        let sell_tx = OrderBook::make_sell_order(SellOrderParams {
            hold_address: key.address(),
            tax_address: key.address(),
            sale_volume: sell_sale_volume,
            unit_price: 2_000_000,
            fee_rate: 0,
            ft_code_script: code_hex,
            ft_contract_id: [11u8; 32],
            funding_utxos: vec![test_utxo(key, 50_000, seed_vout + 1)],
        })
        .unwrap();
        let locked_ft_balance = (buy_sale_volume as u128) * 2;
        let params = MatchOrderParams {
            buy_order: order_from_tx(&buy_tx, key, 0),
            buy_ft_utxo: ft_from_tx(&buy_tx, key, 1, locked_ft_balance),
            buy_pre_tx: buy_tx,
            buy_pre_pre_tx_data: vec![0x57],
            sell_order: order_from_tx(&sell_tx, key, 0),
            sell_pre_tx: sell_tx,
            matcher_private_key: key.clone(),
            ft_fee_address: key.address(),
            tbc_fee_address: key.address(),
            fee_utxo: test_utxo(key, 50_000, seed_vout + 2),
        };
        let input_sum = match_input_sum(&params);
        (OrderBook::match_order(params).unwrap(), input_sum)
    }

    fn match_input_sum(params: &MatchOrderParams) -> u64 {
        params.buy_order.base.satoshis
            + params.buy_ft_utxo.base.satoshis
            + params.sell_order.base.satoshis
            + params.fee_utxo.satoshis
    }

    fn test_utxo(key: &PrivateKey, satoshis: u64, vout: u32) -> Utxo {
        Utxo {
            outpoint: crate::OutPoint {
                txid: crate::Txid::from_le_bytes([vout as u8 + 1; 32]),
                vout,
            },
            satoshis,
            script_pubkey: key.address().script_pubkey(),
            private_key: key.clone(),
        }
    }

    fn order_from_tx(tx: &Transaction, key: &PrivateKey, vout: u32) -> OrderUtxo {
        let output = tx.outputs.get(vout as usize).unwrap();
        OrderUtxo {
            base: Utxo {
                outpoint: crate::OutPoint {
                    txid: tx.txid(),
                    vout,
                },
                satoshis: output.satoshis,
                script_pubkey: output.script_pubkey.clone(),
                private_key: key.clone(),
            },
        }
    }

    fn ft_from_tx(
        tx: &Transaction,
        key: &PrivateKey,
        vout: u32,
        amount_raw: u128,
    ) -> crate::FtUtxo {
        let output = tx.outputs.get(vout as usize).unwrap();
        crate::FtUtxo {
            base: Utxo {
                outpoint: crate::OutPoint {
                    txid: tx.txid(),
                    vout,
                },
                satoshis: output.satoshis,
                script_pubkey: output.script_pubkey.clone(),
                private_key: key.clone(),
            },
            ft_balance_raw: amount_raw,
        }
    }
}
