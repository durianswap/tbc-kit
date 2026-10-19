use crate::Transaction;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdminSighash {
    pub input_index: usize,
    pub sighash: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StableCoinCreate {
    pub coin_nft: Transaction,
    pub mint: Transaction,
    pub sighashes: Vec<AdminSighash>,
    pub agg_pubkey32: [u8; 32],
    pub funding_prev_tx: Transaction,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StableCoinMint {
    pub tx: Transaction,
    pub sighashes: Vec<AdminSighash>,
    pub agg_pubkey32: [u8; 32],
    pub nft_pre_tx: Transaction,
    pub nft_pre_pre_tx: Transaction,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FinalizedStableCoinCreate {
    pub coin_nft: Transaction,
    pub mint: Transaction,
    pub contract_txid: String,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
pub struct CoinNftData {
    #[serde(rename = "nftName")]
    pub nft_name: String,
    #[serde(rename = "nftSymbol")]
    pub nft_symbol: String,
    pub description: String,
    #[serde(rename = "coinDecimal")]
    pub coin_decimal: u8,
    #[serde(rename = "coinTotalSupply")]
    pub coin_total_supply: String,
}

impl serde::Serialize for CoinNftData {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;

        let mut state = serializer.serialize_struct("CoinNftData", 5)?;
        state.serialize_field("nftName", &self.nft_name)?;
        state.serialize_field("nftSymbol", &self.nft_symbol)?;
        state.serialize_field("description", &self.description)?;
        state.serialize_field("coinDecimal", &self.coin_decimal)?;
        state.serialize_field("coinTotalSupply", &self.coin_total_supply)?;
        state.end()
    }
}
