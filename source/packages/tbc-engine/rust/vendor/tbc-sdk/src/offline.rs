use crate::{OutPoint, script::Script};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UtxoInfo {
    pub outpoint: OutPoint,
    pub satoshis: u64,
    pub script_pubkey: Script,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FtlpUtxo {
    pub base: UtxoInfo,
    pub ft_balance_raw: u128,
}
