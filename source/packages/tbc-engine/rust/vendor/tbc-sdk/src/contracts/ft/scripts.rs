use crate::{Address, Error, Result, Txid, script::Script};

use super::unlock::size_le;

pub const FT_CODE_SATOSHIS: u64 = 500;
pub const FT_TAPE_SATOSHIS: u64 = 0;
pub const FT_MINT_SOURCE_SATOSHIS: u64 = 9_900;

const FTAPE_MARKER: &[u8] = b"FTape";
const MINT_SOURCE_MARKER: &[u8] = b"for ft mint";
const FT_CODE_MARKER: &[u8] = b"2Code";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FtMintVersion {
    V3,
    V4,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FtCodeReceiver {
    Address(Address),
    Hash160([u8; 20]),
    ContractHash([u8; 21]),
}

pub fn mint_tape_script(amount: &[u8; 48], decimal: u8, name: &str, symbol: &str) -> Script {
    Script::op_return(&[
        amount.to_vec(),
        vec![decimal],
        name.as_bytes().to_vec(),
        symbol.as_bytes().to_vec(),
        FTAPE_MARKER.to_vec(),
    ])
}

pub fn mint_source_script(address: &Address) -> Script {
    Script::from_asm(&format!(
        "OP_DUP OP_HASH160 {} OP_EQUALVERIFY OP_CHECKSIG OP_RETURN {}",
        hex::encode(address.hash160()),
        hex::encode(MINT_SOURCE_MARKER)
    ))
    .expect("static FT mint source script ASM is valid")
}

pub fn mint_code_script(
    source_txid: &str,
    source_vout: u32,
    address: &Address,
    tape_size: usize,
) -> Result<Script> {
    mint_code_script_with_version(
        source_txid,
        source_vout,
        address,
        tape_size,
        FtMintVersion::V4,
    )
}

pub fn mint_code_script_with_version(
    source_txid: &str,
    source_vout: u32,
    address: &Address,
    tape_size: usize,
    version: FtMintVersion,
) -> Result<Script> {
    let txid: Txid = source_txid.parse()?;
    let mut outpoint = Vec::with_capacity(36);
    outpoint.extend_from_slice(txid.as_le_bytes());
    outpoint.extend_from_slice(&source_vout.to_le_bytes());

    let mut owner = Vec::with_capacity(21);
    owner.extend_from_slice(&address.hash160());
    owner.push(0);

    let template = match version {
        FtMintVersion::V3 => include_str!("mint_code_v3_template.asm"),
        FtMintVersion::V4 => include_str!("mint_code_template.asm"),
    };
    let asm = template
        .replace("${utxoHex}", &hex::encode(outpoint))
        .replace("${hash}", &hex::encode(owner))
        .replace("${tapeSizeHex}", &hex::encode(size_le(tape_size)?));
    Script::from_asm(&asm)
}

pub fn transfer_tape_script(tape_script: &Script, amount: &[u8; 48]) -> Result<Script> {
    let mut bytes = tape_script.as_bytes().to_vec();
    if bytes.len() < 51 || !bytes.ends_with(FTAPE_MARKER) {
        return Err(Error::InvalidScript(
            "FT tape script must contain a 48-byte amount and FTape marker".to_string(),
        ));
    }
    bytes[3..51].copy_from_slice(amount);
    Ok(Script::from_bytes(bytes))
}

pub fn transfer_code_script(code_script: &Script, receiver: FtCodeReceiver) -> Result<Script> {
    let mut bytes = code_script.as_bytes().to_vec();
    let marker_start = bytes
        .len()
        .checked_sub(FT_CODE_MARKER.len())
        .ok_or_else(|| Error::InvalidScript("FT code script is too short".to_string()))?;
    if bytes.get(marker_start..) != Some(FT_CODE_MARKER) {
        return Err(Error::InvalidScript(
            "FT code script must end with 2Code marker".to_string(),
        ));
    }

    let hash_push_start = marker_start.checked_sub(23).ok_or_else(|| {
        Error::InvalidScript("FT code script missing receiver hash chunk".to_string())
    })?;
    if bytes.get(hash_push_start) != Some(&0x15)
        || bytes.get(marker_start - 1) != Some(&(FT_CODE_MARKER.len() as u8))
    {
        return Err(Error::InvalidScript(
            "FT code script receiver chunk must be 21 bytes before 2Code marker".to_string(),
        ));
    }

    let receiver = match receiver {
        FtCodeReceiver::Address(address) => {
            let mut receiver = [0u8; 21];
            receiver[..20].copy_from_slice(&address.hash160());
            receiver
        }
        FtCodeReceiver::Hash160(hash160) => {
            let mut receiver = [0u8; 21];
            receiver[..20].copy_from_slice(&hash160);
            receiver[20] = 0x01;
            receiver
        }
        FtCodeReceiver::ContractHash(receiver) => receiver,
    };
    bytes[hash_push_start + 1..hash_push_start + 22].copy_from_slice(&receiver);
    Ok(Script::from_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::script::Script;

    #[test]
    fn ft_tape_script_has_amount_decimal_name_symbol_and_marker() {
        let mut amount = [0u8; 48];
        amount[0..8].copy_from_slice(&1_000u64.to_le_bytes());
        let script = mint_tape_script(&amount, 6, "Token", "TOK");
        let hex = hex::encode(script.as_bytes());
        assert!(hex.starts_with("006a30"));
        assert!(hex.contains("010605546f6b656e03544f4b"));
        assert!(hex.ends_with("054654617065"));
    }

    #[test]
    fn ft_mint_source_script_has_marker() {
        let key = crate::PrivateKey::from_slice(&[21u8; 32]).unwrap();
        let script = mint_source_script(&key.address());
        assert!(hex::encode(script.as_bytes()).ends_with("6a0b666f72206674206d696e74"));
    }

    #[test]
    fn ft_transfer_tape_replaces_amount_at_offset_three() {
        let base = mint_tape_script(&[0u8; 48], 6, "Token", "TOK");
        let mut amount = [0u8; 48];
        amount[0..8].copy_from_slice(&7u64.to_le_bytes());
        let updated = transfer_tape_script(&base, &amount).unwrap();
        assert_eq!(&updated.as_bytes()[3..11], &7u64.to_le_bytes());
    }

    #[test]
    fn ft_transfer_code_rewrites_receiver_hash() {
        let key = crate::PrivateKey::from_slice(&[22u8; 32]).unwrap();
        let base = Script::from_asm(&format!(
            "OP_RETURN 0x15 0x{}00 0x05 0x32436f6465",
            "11".repeat(20)
        ))
        .unwrap();
        let updated = transfer_code_script(&base, FtCodeReceiver::Address(key.address())).unwrap();
        let hex = hex::encode(updated.as_bytes());
        assert!(hex.ends_with(&format!(
            "15{}000532436f6465",
            hex::encode(key.address().hash160())
        )));
    }

    #[test]
    fn ft_transfer_code_accepts_exact_twenty_one_byte_contract_receiver() {
        let base = Script::from_asm(&format!(
            "OP_RETURN 0x15 0x{}00 0x05 0x32436f6465",
            "11".repeat(20)
        ))
        .unwrap();
        let receiver = [0x42; 21];

        let updated = transfer_code_script(&base, FtCodeReceiver::ContractHash(receiver)).unwrap();

        assert!(
            updated
                .as_bytes()
                .ends_with(&[receiver.as_slice(), &[0x05], b"2Code"].concat())
        );
    }

    #[test]
    fn ft_mint_code_script_matches_js_template_fixture() {
        let address = crate::Address::from_string("1FMZk84eVEJ1QHas3Gke1U9ZPMKrPk36ex").unwrap();
        let script = mint_code_script(
            "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
            513,
            &address,
            64,
        )
        .unwrap();
        let hex = hex::encode(script.as_bytes());
        assert_eq!(script.as_bytes().len(), 2_076);
        assert_eq!(
            hex::encode(crate::hash::sha256(script.as_bytes())),
            "19ff328e04a7a9e1b1974e03045766e9f4ab88f54387a274c37b4d53bb8b2a60"
        );
        assert!(
            hex.contains(
                "ffeeddccbbaa99887766554433221100ffeeddccbbaa9988776655443322110001020000"
            )
        );
        assert!(hex.ends_with("159d7569c02867fa342031cb7c37ae9cf54a0f41ba000532436f6465"));
    }
}
