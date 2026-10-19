//! Shared historical/new NFT Tape decoding. Metadata alone does not identify
//! a contract standard. Moved unchanged from the historical NFT family so new
//! protocol builders do not depend on that business implementation.
use tbc_sdk::TxOut;
use crate::{EngineError,ErrorCode,model::error};

fn invalid_ancestry(message:&str)->EngineError {
    error(ErrorCode::InvalidAncestry,message,"snapshot.payload")
}

pub(crate) fn decode_tape<T: serde::de::DeserializeOwned>(output: &TxOut) -> Result<T, EngineError> {
    if output.satoshis != 0 { return Err(invalid_ancestry("NFT Tape output must contain zero satoshis")); }
    let bytes = output.script_pubkey.as_bytes();
    if !bytes.starts_with(&[0, 0x6a]) { return Err(invalid_ancestry("NFT Tape framing is invalid")); }
    let mut offset = 2usize;
    let json = take_push(bytes, &mut offset)?;
    let marker = take_push(bytes, &mut offset)?;
    if marker != b"NTape" || offset != bytes.len() { return Err(invalid_ancestry("NFT Tape marker is invalid")); }
    serde_json::from_slice(json).map_err(|_| invalid_ancestry("NFT Tape JSON is invalid"))
}

fn take_push<'a>(bytes: &'a [u8], offset: &mut usize) -> Result<&'a [u8], EngineError> {
    let opcode = *bytes.get(*offset).ok_or_else(|| invalid_ancestry("NFT Tape push is truncated"))?;
    *offset += 1;
    let length = match opcode {
        0..=75 => opcode as usize,
        0x4c => { let value = *bytes.get(*offset).ok_or_else(|| invalid_ancestry("NFT Tape push is truncated"))? as usize; *offset += 1; value }
        0x4d => { let end = *offset + 2; let raw: [u8; 2] = bytes.get(*offset..end).ok_or_else(|| invalid_ancestry("NFT Tape push is truncated"))?.try_into().unwrap(); *offset = end; u16::from_le_bytes(raw) as usize }
        _ => return Err(invalid_ancestry("NFT Tape push width is unsupported")),
    };
    let end = offset.checked_add(length).ok_or_else(|| invalid_ancestry("NFT Tape length overflow"))?;
    let value = bytes.get(*offset..end).ok_or_else(|| invalid_ancestry("NFT Tape push is truncated"))?;
    *offset = end;
    Ok(value)
}
