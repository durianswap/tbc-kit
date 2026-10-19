use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionData {
    pub collection_name: String,
    pub description: String,
    pub supply: u32,
    pub file: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NftData {
    pub nft_name: String,
    pub symbol: String,
    pub description: String,
    pub attributes: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NftInfo {
    pub collection_id: String,
    pub collection_index: u32,
    pub collection_name: String,
    pub nft_name: String,
    pub nft_symbol: String,
    #[serde(rename = "nft_attributes")]
    pub nft_attributes: String,
    pub nft_description: String,
    pub nft_transfer_time_count: u32,
    pub nft_icon: String,
}

pub type NftUtxo = crate::Utxo;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BatchNftTx {
    pub txraw: String,
    pub txid: String,
}
