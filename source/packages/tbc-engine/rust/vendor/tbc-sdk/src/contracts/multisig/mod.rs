pub mod address;
#[cfg(feature = "internal-signing")]
mod builder;
#[cfg(feature = "internal-signing")]
mod data;
pub mod scripts;

pub use address::{MultiSig, MultiSigAddressInfo};
#[cfg(feature = "internal-signing")]
pub use data::{MultiSigDestination, MultiSigInputSignatures, MultiSigUnsignedTx, MultiSigUtxo};
