use crate::{Address, Transaction, Utxo};

use super::scripts::BUY_ORDER_DUST;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderData {
    pub hold_address: Address,
    pub sale_volume: u64,
    pub ft_partial_hash: [u8; 32],
    pub fee_rate: u64,
    pub unit_price: u64,
    pub ft_contract_id: [u8; 32],
}

#[derive(Clone, Debug)]
pub struct OrderUtxo {
    pub base: Utxo,
}

impl OrderUtxo {
    pub fn new(base: Utxo) -> Self {
        Self { base }
    }
}

#[derive(Clone, Debug)]
pub struct SellOrderParams {
    pub hold_address: Address,
    pub tax_address: Address,
    pub sale_volume: u64,
    pub unit_price: u64,
    pub fee_rate: u64,
    pub ft_code_script: String,
    pub ft_contract_id: [u8; 32],
    pub funding_utxos: Vec<Utxo>,
}

#[derive(Clone, Debug)]
pub struct BuyOrderParams {
    pub hold_address: Address,
    pub tax_address: Address,
    pub sale_volume: u64,
    pub unit_price: u64,
    pub fee_rate: u64,
    pub ft_code_script: String,
    pub ft_tape_script: String,
    pub ft_contract_id: [u8; 32],
    pub ft_utxos: Vec<crate::FtUtxo>,
    pub fee_utxo: Utxo,
    pub pre_txs: Vec<Transaction>,
    pub pre_pre_tx_data_set: Vec<Vec<u8>>,
}

impl BuyOrderParams {
    pub fn buy_order_dust() -> u64 {
        BUY_ORDER_DUST
    }
}

#[derive(Clone, Debug)]
pub struct CancelBuyOrderParams {
    pub buy_order: OrderUtxo,
    pub buy_ft_utxo: crate::FtUtxo,
    pub buy_pre_tx: Transaction,
    pub buy_pre_pre_tx_data: Vec<u8>,
    pub fee_utxos: Vec<Utxo>,
}

#[derive(Clone, Debug)]
pub struct MatchOrderParams {
    pub buy_order: OrderUtxo,
    pub buy_ft_utxo: crate::FtUtxo,
    pub buy_pre_tx: Transaction,
    pub buy_pre_pre_tx_data: Vec<u8>,
    pub sell_order: OrderUtxo,
    pub sell_pre_tx: Transaction,
    pub matcher_private_key: crate::PrivateKey,
    pub ft_fee_address: Address,
    pub tbc_fee_address: Address,
    pub fee_utxo: Utxo,
}
