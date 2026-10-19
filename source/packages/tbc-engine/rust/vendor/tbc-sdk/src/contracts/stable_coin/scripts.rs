use crate::{Address, Error, Result, Txid, hash, script::Script};

use super::CoinNftData;

pub const COIN_NFT_CODE_SATOSHIS: u64 = 200;
pub const COIN_NFT_HOLD_SATOSHIS: u64 = 100;
pub const COIN_NFT_TAPE_SATOSHIS: u64 = 0;
pub const COIN_FT_CODE_SATOSHIS: u64 = 500;
pub const COIN_FT_TAPE_SATOSHIS: u64 = 0;
pub const COIN_FT_SEQUENCE: u32 = 0xffff_fffe;

const FTAPE_MARKER: &[u8] = b"FTape";
const NTAPE_MARKER: &[u8] = b"NTape";
const COIN_NFT_CODE_MARKER: &[u8] = b"3Code";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StableCoinMintVersion {
    V3,
    V4,
}

pub fn coin_tape_script(
    amount: &[u8; 48],
    decimal: u8,
    name: &str,
    symbol: &str,
    lock_time: u32,
) -> Script {
    Script::op_return(&[
        amount.to_vec(),
        vec![decimal],
        name.as_bytes().to_vec(),
        symbol.as_bytes().to_vec(),
        lock_time.to_le_bytes().to_vec(),
        FTAPE_MARKER.to_vec(),
    ])
}

pub fn get_lock_time_from_tape(tape_script: &Script) -> Result<u32> {
    let chunks = script_chunks(tape_script.as_bytes())?;
    if chunks.len() < 8 || chunks.last().map(Vec::as_slice) != Some(FTAPE_MARKER) {
        return Err(Error::InvalidScript(
            "stableCoin tape must include amount, metadata, lockTime, and FTape".to_string(),
        ));
    }
    let lock_time = chunks.get(chunks.len().saturating_sub(2)).ok_or_else(|| {
        Error::InvalidScript("stableCoin tape missing lockTime chunk".to_string())
    })?;
    if lock_time.len() != 4 {
        return Err(Error::InvalidScript(
            "stableCoin tape lockTime chunk must be 4 bytes".to_string(),
        ));
    }
    Ok(u32::from_le_bytes(lock_time.as_slice().try_into().unwrap()))
}

pub fn coin_nft_tape_script(data: &CoinNftData) -> Result<Script> {
    let json = serde_json::to_vec(data)?;
    Ok(Script::op_return(&[json, NTAPE_MARKER.to_vec()]))
}

pub fn decode_coin_nft_tape_script(tape_script: &Script) -> Result<CoinNftData> {
    let chunks = script_chunks(tape_script.as_bytes())?;
    let json = chunks
        .get(chunks.len().saturating_sub(2))
        .ok_or_else(|| Error::InvalidScript("coinNFT tape missing JSON chunk".to_string()))?;
    Ok(serde_json::from_slice(json)?)
}

pub fn update_coin_nft_tape_script(tape_script: &Script, new_total_supply: u128) -> Result<Script> {
    let mut data = decode_coin_nft_tape_script(tape_script)?;
    data.coin_total_supply = new_total_supply.to_string();
    coin_nft_tape_script(&data)
}

pub fn coin_nft_code_script(tx_hash: &str, output_index: u32) -> Result<Script> {
    let txid: Txid = tx_hash.parse()?;
    let txid_vout = format!(
        "{}{}",
        hex::encode(txid.as_le_bytes()),
        hex::encode(output_index.to_le_bytes())
    );
    Script::from_asm(&format!(
        "{} 0x{txid_vout} {} 0x05 0x{}",
        COIN_NFT_CODE_PREFIX,
        COIN_NFT_CODE_SUFFIX,
        hex::encode(COIN_NFT_CODE_MARKER)
    ))
}

pub fn coin_nft_hold_script_from_hash(pubkey_hash: &[u8; 20], flag: &str) -> Script {
    let flag_hex = hex::encode(format!("For Coin {flag} NHold").as_bytes());
    Script::from_asm(&format!(
        "OP_DUP OP_HASH160 {} OP_EQUALVERIFY OP_CHECKSIG OP_RETURN {}",
        hex::encode(pubkey_hash),
        flag_hex
    ))
    .expect("static coinNFT hold script ASM is valid")
}

pub fn coin_mint_code_script(
    admin_pub_hash: &[u8; 20],
    receive_address: &Address,
    origin_code_hash: &[u8; 32],
    tape_size: usize,
) -> Result<Script> {
    coin_mint_code_script_with_version(
        admin_pub_hash,
        receive_address,
        origin_code_hash,
        tape_size,
        StableCoinMintVersion::V4,
    )
}

pub fn coin_mint_code_script_with_version(
    admin_pub_hash: &[u8; 20],
    receive_address: &Address,
    origin_code_hash: &[u8; 32],
    tape_size: usize,
    version: StableCoinMintVersion,
) -> Result<Script> {
    let mut owner = Vec::with_capacity(21);
    owner.extend_from_slice(&receive_address.hash160());
    owner.push(0);
    let template = match version {
        StableCoinMintVersion::V3 => include_str!("coin_mint_code_v3_template.asm"),
        StableCoinMintVersion::V4 => include_str!("coin_mint_code_template.asm"),
    };
    let asm = template
        .replace("${adminPubHash}", &hex::encode(admin_pub_hash))
        .replace("${hash}", &hex::encode(owner))
        .replace("${codeHash}", &hex::encode(origin_code_hash))
        .replace("${tapeSizeHex}", &hex::encode(size_le(tape_size)?));
    if asm.contains("${") {
        return Err(Error::InvalidScript(
            "unreplaced stableCoin mint code placeholder".to_string(),
        ));
    }
    Script::from_asm(&asm)
}

pub fn schnorr_nft_unlock_script(
    sig64: &[u8; 64],
    xonly_pubkey32: &[u8; 32],
    current_tx: &crate::Transaction,
    pre_tx: &crate::Transaction,
    pre_pre_tx: &crate::Transaction,
) -> Result<Script> {
    let mut sig65 = Vec::with_capacity(65);
    sig65.extend_from_slice(sig64);
    sig65.push(crate::DEFAULT_SIGHASH as u8);

    let mut script = Vec::new();
    push_script_data(&mut script, &sig65)?;
    push_script_data(&mut script, xonly_pubkey32)?;
    script.extend_from_slice(&crate::contracts::nft::unlock::current_tx_data(current_tx)?);
    script.extend_from_slice(&crate::contracts::nft::unlock::pre_pre_tx_data(pre_pre_tx)?);
    script.extend_from_slice(&crate::contracts::nft::unlock::pre_tx_data(pre_tx)?);
    Ok(Script::from_bytes(script))
}

pub fn schnorr_hold_unlock_script(sig64: &[u8; 64], xonly_pubkey32: &[u8; 32]) -> Result<Script> {
    let mut sig65 = Vec::with_capacity(65);
    sig65.extend_from_slice(sig64);
    sig65.push(crate::DEFAULT_SIGHASH as u8);

    let mut script = Vec::new();
    push_script_data(&mut script, &sig65)?;
    push_script_data(&mut script, xonly_pubkey32)?;
    Ok(Script::from_bytes(script))
}

pub fn amount_slot(value: u128) -> Result<[u8; 48]> {
    let value = u64::try_from(value)
        .map_err(|_| Error::InvalidUtxo("stableCoin amount exceeds u64 slot".to_string()))?;
    let mut amount = [0u8; 48];
    amount[0..8].copy_from_slice(&value.to_le_bytes());
    Ok(amount)
}

pub fn admin_hash160(agg_pubkey32: &[u8; 32]) -> [u8; 20] {
    hash::hash160(agg_pubkey32)
}

pub fn size_le(length: usize) -> Result<Vec<u8>> {
    match length {
        0..=0xff => Ok(vec![length as u8]),
        0x100..=0xffff => Ok((length as u16).to_le_bytes().to_vec()),
        0x1_0000..=0xffff_ffff => Ok((length as u32).to_le_bytes().to_vec()),
        _ => Err(Error::InvalidScript(
            "length exceeds maximum stableCoin size encoding".to_string(),
        )),
    }
}

fn script_chunks(bytes: &[u8]) -> Result<Vec<Vec<u8>>> {
    let mut chunks = Vec::new();
    let mut offset = 0usize;
    while offset < bytes.len() {
        let opcode = bytes[offset];
        offset += 1;
        let length = match opcode {
            0x01..=0x4b => opcode as usize,
            crate::script::opcodes::OP_PUSHDATA1 => {
                let value = *bytes.get(offset).ok_or(Error::InvalidTransactionHex)? as usize;
                offset += 1;
                value
            }
            crate::script::opcodes::OP_PUSHDATA2 => {
                u16::from_le_bytes(read_push_len(bytes, &mut offset)?) as usize
            }
            crate::script::opcodes::OP_PUSHDATA4 => {
                u32::from_le_bytes(read_push_len(bytes, &mut offset)?) as usize
            }
            _ => {
                chunks.push(Vec::new());
                continue;
            }
        };
        let end = offset
            .checked_add(length)
            .ok_or(Error::InvalidTransactionHex)?;
        let data = bytes
            .get(offset..end)
            .ok_or(Error::InvalidTransactionHex)?
            .to_vec();
        offset = end;
        chunks.push(data);
    }
    Ok(chunks)
}

fn read_push_len<const N: usize>(bytes: &[u8], offset: &mut usize) -> Result<[u8; N]> {
    let end = offset.checked_add(N).ok_or(Error::InvalidTransactionHex)?;
    let data = bytes
        .get(*offset..end)
        .ok_or(Error::InvalidTransactionHex)?
        .try_into()
        .map_err(|_| Error::InvalidTransactionHex)?;
    *offset = end;
    Ok(data)
}

fn push_script_data(out: &mut Vec<u8>, data: &[u8]) -> Result<()> {
    match data.len() {
        0..=75 => out.push(data.len() as u8),
        76..=0xff => {
            out.push(crate::script::opcodes::OP_PUSHDATA1);
            out.push(data.len() as u8);
        }
        _ => {
            return Err(Error::InvalidScript(
                "stableCoin unlock push data exceeds supported length".to_string(),
            ));
        }
    }
    out.extend_from_slice(data);
    Ok(())
}

const COIN_NFT_CODE_PREFIX: &str = "OP_1 OP_PICK OP_3 OP_SPLIT 0x01 0x14 OP_SPLIT OP_DROP OP_TOALTSTACK OP_DROP OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_OVER OP_TOALTSTACK OP_TOALTSTACK OP_CAT OP_FROMALTSTACK OP_CAT OP_SHA256 OP_CAT OP_OVER 0x01 0x24 OP_SPLIT OP_DROP OP_TOALTSTACK OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_HASH256 OP_6 OP_PUSH_META 0x01 0x20 OP_SPLIT OP_DROP OP_EQUALVERIFY OP_OVER OP_TOALTSTACK OP_TOALTSTACK OP_CAT OP_FROMALTSTACK OP_CAT OP_SHA256 OP_CAT OP_CAT OP_CAT OP_HASH256 OP_FROMALTSTACK OP_FROMALTSTACK OP_DUP 0x01 0x20 OP_SPLIT OP_DROP OP_3 OP_ROLL OP_EQUALVERIFY OP_SWAP OP_FROMALTSTACK OP_DUP OP_TOALTSTACK OP_EQUAL OP_IF OP_DROP OP_ELSE 0x24";
const COIN_NFT_CODE_SUFFIX: &str = "OP_EQUALVERIFY OP_ENDIF OP_OVER OP_FROMALTSTACK OP_EQUALVERIFY OP_CAT OP_CAT OP_SHA256 OP_7 OP_PUSH_META OP_EQUALVERIFY OP_DUP OP_HASH160 OP_FROMALTSTACK OP_EQUALVERIFY OP_CHECKSIG OP_RETURN";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_coin_tape_includes_locktime_before_ftape() {
        let script = coin_tape_script(
            &amount_slot(123).unwrap(),
            6,
            "USD Coin",
            "USDC",
            500_000_001,
        );
        let hex = hex::encode(script.as_bytes());

        assert!(hex.ends_with("040165cd1d054654617065"));
        assert_eq!(get_lock_time_from_tape(&script).unwrap(), 500_000_001);
    }

    #[test]
    fn stable_coin_locktime_rejects_regular_ft_tape_with_four_byte_symbol() {
        let script = crate::contracts::ft::scripts::mint_tape_script(
            &amount_slot(123).unwrap(),
            6,
            "Token",
            "ROBL",
        );

        assert!(get_lock_time_from_tape(&script).is_err());
    }

    #[test]
    fn coin_nft_scripts_use_165_markers() {
        let hash = [0x11u8; 20];
        let hold = coin_nft_hold_script_from_hash(&hash, "USD Coin NFT");
        let tape = coin_nft_tape_script(&CoinNftData {
            nft_name: "USD Coin NFT".to_string(),
            nft_symbol: "USDC NFT".to_string(),
            description: "certificate".to_string(),
            coin_decimal: 6,
            coin_total_supply: "0".to_string(),
        })
        .unwrap();
        let code = coin_nft_code_script(
            "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
            513,
        )
        .unwrap();

        assert!(hex::encode(hold.as_bytes()).ends_with("4e486f6c64"));
        assert!(hex::encode(tape.as_bytes()).ends_with("054e54617065"));
        assert!(hex::encode(code.as_bytes()).ends_with("6a0533436f6465"));
    }

    #[test]
    fn coin_mint_code_matches_tbc_contract_166_fixture() {
        let address = crate::Address::from_string("1FMZk84eVEJ1QHas3Gke1U9ZPMKrPk36ex").unwrap();
        let script = coin_mint_code_script(&[0x11; 20], &address, &[0x22; 32], 64).unwrap();

        assert_eq!(script.as_bytes().len(), 2076);
        assert_eq!(
            hex::encode(crate::hash::sha256(script.as_bytes())),
            "e6a7cdecd8710216c5accb5672a34a8a75cb65bf8054b70eea8baf9a5f9af749"
        );
        assert!(
            hex::encode(script.as_bytes())
                .ends_with("6a159d7569c02867fa342031cb7c37ae9cf54a0f41ba000532436f6465")
        );
    }
}
