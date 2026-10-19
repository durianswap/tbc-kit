#[cfg(feature = "internal-signing")]
mod builder;
mod data;
pub mod scripts;
pub mod unlock;

pub use data::{BatchNftTx, CollectionData, NftData, NftInfo, NftUtxo};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Nft {
    pub collection_id: String,
    pub collection_index: u32,
    pub collection_name: String,
    pub transfer_count: u32,
    pub contract_id: String,
    pub nft_data: NftData,
}

impl Nft {
    pub fn new(collection_id: String, collection_index: u32) -> Self {
        Self {
            contract_id: collection_id.clone(),
            collection_id,
            collection_index,
            collection_name: String::new(),
            transfer_count: 0,
            nft_data: NftData {
                nft_name: String::new(),
                symbol: String::new(),
                description: String::new(),
                attributes: String::new(),
                file: None,
            },
        }
    }

    pub fn with_data(mut self, data: NftData) -> Self {
        self.nft_data = data;
        self
    }

    pub fn initialize(&mut self, nft_info: NftInfo) {
        self.nft_data = NftData {
            nft_name: nft_info.nft_name,
            symbol: nft_info.nft_symbol,
            description: nft_info.nft_description,
            attributes: nft_info.nft_attributes,
            file: Some(format!("{}00000000", self.contract_id)),
        };
        self.collection_id = nft_info.collection_id;
        self.collection_index = nft_info.collection_index;
        self.collection_name = nft_info.collection_name;
        self.transfer_count = nft_info.nft_transfer_time_count;
    }
}
