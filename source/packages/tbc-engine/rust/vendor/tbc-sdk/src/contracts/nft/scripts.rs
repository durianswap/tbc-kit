use crate::{Address, Result, Txid, script::Script};

pub const NFT_CODE_SATOSHIS: u64 = 200;
pub const NFT_HOLD_SATOSHIS: u64 = 100;
pub const NFT_TAPE_SATOSHIS: u64 = 0;

const NTAPE_MARKER: &[u8] = b"NTape";
const MINT_MARKER_HEX: &str = "5630204d696e74204e486f6c64";
const HOLD_MARKER_HEX: &str = "56302043757272204e486f6c64";
const NFT_CODE_V2_TEMPLATE: &str = include_str!("templates/nft_code_v2.asm");
const NFT_CODE_V1_TEMPLATE: &str = include_str!("templates/nft_code_v1.asm");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NftVersion {
    V0,
    V1,
    V2,
}

pub fn tape_script<T: serde::Serialize>(data: &T) -> Result<Script> {
    let json = serde_json::to_vec(data)?;
    Ok(Script::op_return(&[json, NTAPE_MARKER.to_vec()]))
}

pub fn mint_script(address: &Address) -> Script {
    p2pkh_marker_script(address, MINT_MARKER_HEX)
}

pub fn hold_script(address: &Address) -> Script {
    p2pkh_marker_script(address, HOLD_MARKER_HEX)
}

pub fn code_script(tx_hash: &str, output_index: u32) -> Result<Script> {
    code_script_from_template(NFT_CODE_V2_TEMPLATE, tx_hash, output_index)
}

pub fn code_script_v1(tx_hash: &str, output_index: u32) -> Result<Script> {
    code_script_from_template(NFT_CODE_V1_TEMPLATE, tx_hash, output_index)
}

pub fn nft_version(script: &Script) -> Option<NftVersion> {
    let code = script.as_bytes();
    let marker = b"\x053Code";
    match code.len() {
        140 if code.ends_with(marker) => Some(NftVersion::V2),
        125 if code.ends_with(&[
            crate::script::opcodes::OP_CHECKSIG,
            crate::script::opcodes::OP_RETURN,
        ]) =>
        {
            Some(NftVersion::V1)
        }
        142 if code.ends_with(marker) => Some(NftVersion::V0),
        _ => None,
    }
}

fn code_script_from_template(template: &str, tx_hash: &str, output_index: u32) -> Result<Script> {
    let txid: Txid = tx_hash.parse()?;
    let txid_vout = format!(
        "{}{}",
        hex::encode(txid.as_le_bytes()),
        hex::encode(output_index.to_le_bytes())
    );
    Script::from_asm(&template.replace("${utxoHex}", &txid_vout))
}

fn p2pkh_marker_script(address: &Address, marker_hex: &str) -> Script {
    let pubkey_hash = hex::encode(address.hash160());
    Script::from_asm(&format!(
        "OP_DUP OP_HASH160 0x14 0x{pubkey_hash} OP_EQUALVERIFY OP_CHECKSIG OP_RETURN 0x0d 0x{marker_hex}"
    ))
    .expect("static NFT marker script ASM is valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nft_mint_hold_and_tape_scripts_match_js_markers() {
        let key = crate::PrivateKey::from_slice(&[9u8; 32]).unwrap();
        let address = key.address();

        assert!(
            hex::encode(mint_script(&address).as_bytes())
                .ends_with("6a0d5630204d696e74204e486f6c64")
        );
        assert!(
            hex::encode(hold_script(&address).as_bytes())
                .ends_with("6a0d56302043757272204e486f6c64")
        );

        let data = crate::contracts::nft::CollectionData {
            collection_name: "Rust Collection".to_string(),
            description: "demo".to_string(),
            supply: 2,
            file: "ipfs://collection".to_string(),
        };
        let tape = tape_script(&data).unwrap();
        assert_eq!(tape.as_bytes()[0], crate::script::opcodes::OP_FALSE);
        assert_eq!(tape.as_bytes()[1], crate::script::opcodes::OP_RETURN);
        assert!(hex::encode(tape.as_bytes()).ends_with("054e54617065"));
    }

    #[test]
    fn nft_code_script_embeds_reversed_txid_and_little_endian_vout() {
        let script = code_script(
            "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
            513,
        )
        .unwrap();
        let hex = hex::encode(script.as_bytes());
        assert!(hex.contains(
            "24ffeeddccbbaa99887766554433221100ffeeddccbbaa9988776655443322110001020000"
        ));
        assert_eq!(script.as_bytes().len(), 140);
        assert!(hex.ends_with("0533436f6465"));
        assert_eq!(nft_version(&script), Some(NftVersion::V2));
    }

    #[test]
    fn nft_v1_and_v2_match_javascript_166_and_reject_malformed_scripts() {
        let txid = "11".repeat(32);
        let v1 = code_script_v1(&txid, 0).unwrap();
        let v2 = code_script(&txid, 0).unwrap();

        assert_eq!(v1.as_bytes().len(), 125);
        assert_eq!(
            hex::encode(v1.sha256()),
            "ae25e943e5faed4a22a4f669479ecec5d0da6f10f75bee64c52c926a21dd5dd1"
        );
        assert_eq!(nft_version(&v1), Some(NftVersion::V1));
        assert_eq!(v2.as_bytes().len(), 140);
        assert_eq!(
            hex::encode(v2.sha256()),
            "9a67fc909512916f62ac4dd395d6d1b7c9b52a60e1a249eb60e48564d44ab8b9"
        );
        assert_eq!(nft_version(&v2), Some(NftVersion::V2));

        assert_eq!(nft_version(&Script::from_bytes(vec![0; 125])), None);
        let mut wrong_length = vec![0; 135];
        wrong_length.extend_from_slice(b"\x053Code");
        assert_eq!(nft_version(&Script::from_bytes(wrong_length)), None);
    }
}
