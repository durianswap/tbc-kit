use crate::{Error, Result, hash};

pub mod opcodes {
    pub const OP_FALSE: u8 = 0x00;
    pub const OP_0: u8 = OP_FALSE;
    pub const OP_PUSHDATA1: u8 = 0x4c;
    pub const OP_PUSHDATA2: u8 = 0x4d;
    pub const OP_PUSHDATA4: u8 = 0x4e;
    pub const OP_1: u8 = 0x51;
    pub const OP_16: u8 = 0x60;
    pub const OP_RETURN: u8 = 0x6a;
    pub const OP_IF: u8 = 0x63;
    pub const OP_NOTIF: u8 = 0x64;
    pub const OP_ELSE: u8 = 0x67;
    pub const OP_ENDIF: u8 = 0x68;
    pub const OP_VERIFY: u8 = 0x69;
    pub const OP_TOALTSTACK: u8 = 0x6b;
    pub const OP_FROMALTSTACK: u8 = 0x6c;
    pub const OP_2DROP: u8 = 0x6d;
    pub const OP_2ROT: u8 = 0x71;
    pub const OP_2SWAP: u8 = 0x72;
    pub const OP_DROP: u8 = 0x75;
    pub const OP_DUP: u8 = 0x76;
    pub const OP_NIP: u8 = 0x77;
    pub const OP_OVER: u8 = 0x78;
    pub const OP_PICK: u8 = 0x79;
    pub const OP_ROLL: u8 = 0x7a;
    pub const OP_ROT: u8 = 0x7b;
    pub const OP_SWAP: u8 = 0x7c;
    pub const OP_CAT: u8 = 0x7e;
    pub const OP_SPLIT: u8 = 0x7f;
    pub const OP_BIN2NUM: u8 = 0x81;
    pub const OP_SIZE: u8 = 0x82;
    pub const OP_EQUAL: u8 = 0x87;
    pub const OP_EQUALVERIFY: u8 = 0x88;
    pub const OP_1ADD: u8 = 0x8b;
    pub const OP_1SUB: u8 = 0x8c;
    pub const OP_NEGATE: u8 = 0x8f;
    pub const OP_ADD: u8 = 0x93;
    pub const OP_SUB: u8 = 0x94;
    pub const OP_MUL: u8 = 0x95;
    pub const OP_DIV: u8 = 0x96;
    pub const OP_NUMNOTEQUAL: u8 = 0x9e;
    pub const OP_LESSTHANOREQUAL: u8 = 0xa1;
    pub const OP_GREATERTHANOREQUAL: u8 = 0xa2;
    pub const OP_SHA256: u8 = 0xa8;
    pub const OP_HASH160: u8 = 0xa9;
    pub const OP_HASH256: u8 = 0xaa;
    pub const OP_CHECKSIG: u8 = 0xac;
    pub const OP_CHECKSIGVERIFY: u8 = 0xad;
    pub const OP_CHECKMULTISIG: u8 = 0xae;
    pub const OP_PUSH_META: u8 = 0xba;
    pub const OP_PARTIAL_HASH: u8 = 0xbb;
    pub const OP_CHECKDATASIG: u8 = 0xbc;
    pub const OP_CHECKDATASIGVERIFY: u8 = 0xbd;
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Script(Vec<u8>);

impl Script {
    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    pub fn empty() -> Self {
        Self(Vec::new())
    }

    pub fn p2pkh(pubkey_hash: &[u8; 20]) -> Self {
        let mut bytes = Vec::with_capacity(25);
        bytes.push(opcodes::OP_DUP);
        bytes.push(opcodes::OP_HASH160);
        bytes.push(0x14);
        bytes.extend_from_slice(pubkey_hash);
        bytes.push(opcodes::OP_EQUALVERIFY);
        bytes.push(opcodes::OP_CHECKSIG);
        Self(bytes)
    }

    pub fn from_asm(asm: &str) -> Result<Self> {
        let tokens = asm.split_whitespace().collect::<Vec<_>>();
        let mut bytes = Vec::new();
        let mut index = 0usize;

        while index < tokens.len() {
            let token = tokens[index];
            if let Some(opcode) = opcode_for_name(token)? {
                bytes.push(opcode);
                index += 1;
                continue;
            }

            if let Some(hex) = token.strip_prefix("0x") {
                if hex.len() == 2
                    && index + 1 < tokens.len()
                    && let Some(next_hex) = tokens[index + 1].strip_prefix("0x")
                {
                    bytes.push(parse_single_byte(hex, token)?);
                    bytes.extend_from_slice(&decode_script_hex(next_hex, tokens[index + 1])?);
                    index += 2;
                    continue;
                }

                bytes.extend_from_slice(&decode_script_hex(hex, token)?);
                index += 1;
                continue;
            }

            let data = decode_script_hex(token, token)?;
            push_data_bytes(&mut bytes, &data);
            index += 1;
        }

        Ok(Self(bytes))
    }

    pub fn op_return(chunks: &[Vec<u8>]) -> Self {
        let mut bytes = vec![opcodes::OP_FALSE, opcodes::OP_RETURN];
        for chunk in chunks {
            push_data_bytes(&mut bytes, chunk);
        }
        Self(bytes)
    }

    pub fn push_data(&mut self, data: &[u8]) {
        push_data_bytes(&mut self.0, data);
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.0
    }

    pub fn is_op_return(&self) -> bool {
        self.0.starts_with(&[opcodes::OP_FALSE, opcodes::OP_RETURN])
            || self.0.first() == Some(&opcodes::OP_RETURN)
    }

    pub fn sha256(&self) -> [u8; 32] {
        hash::sha256(&self.0)
    }
}

fn push_data_bytes(out: &mut Vec<u8>, data: &[u8]) {
    match data.len() {
        0..=75 => out.push(data.len() as u8),
        76..=0xff => {
            out.push(opcodes::OP_PUSHDATA1);
            out.push(data.len() as u8);
        }
        0x100..=0xffff => {
            out.push(opcodes::OP_PUSHDATA2);
            out.extend_from_slice(&(data.len() as u16).to_le_bytes());
        }
        _ => {
            out.push(opcodes::OP_PUSHDATA4);
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        }
    }
    out.extend_from_slice(data);
}

fn opcode_for_name(token: &str) -> Result<Option<u8>> {
    if token == "OP_FALSE" || token == "OP_0" {
        return Ok(Some(opcodes::OP_FALSE));
    }
    if let Some(number) = token.strip_prefix("OP_")
        && let Ok(number) = number.parse::<u8>()
        && (1..=16).contains(&number)
    {
        return Ok(Some(opcodes::OP_1 + number - 1));
    }

    let opcode = match token {
        "OP_RETURN" => opcodes::OP_RETURN,
        "OP_IF" => opcodes::OP_IF,
        "OP_NOTIF" => opcodes::OP_NOTIF,
        "OP_ELSE" => opcodes::OP_ELSE,
        "OP_ENDIF" => opcodes::OP_ENDIF,
        "OP_VERIFY" => opcodes::OP_VERIFY,
        "OP_TOALTSTACK" => opcodes::OP_TOALTSTACK,
        "OP_FROMALTSTACK" => opcodes::OP_FROMALTSTACK,
        "OP_2DROP" => opcodes::OP_2DROP,
        "OP_2ROT" => opcodes::OP_2ROT,
        "OP_2SWAP" => opcodes::OP_2SWAP,
        "OP_DROP" => opcodes::OP_DROP,
        "OP_DUP" => opcodes::OP_DUP,
        "OP_NIP" => opcodes::OP_NIP,
        "OP_OVER" => opcodes::OP_OVER,
        "OP_PICK" => opcodes::OP_PICK,
        "OP_ROLL" => opcodes::OP_ROLL,
        "OP_ROT" => opcodes::OP_ROT,
        "OP_SWAP" => opcodes::OP_SWAP,
        "OP_CAT" => opcodes::OP_CAT,
        "OP_SPLIT" => opcodes::OP_SPLIT,
        "OP_BIN2NUM" => opcodes::OP_BIN2NUM,
        "OP_SIZE" => opcodes::OP_SIZE,
        "OP_EQUAL" => opcodes::OP_EQUAL,
        "OP_EQUALVERIFY" => opcodes::OP_EQUALVERIFY,
        "OP_1ADD" => opcodes::OP_1ADD,
        "OP_1SUB" => opcodes::OP_1SUB,
        "OP_NEGATE" => opcodes::OP_NEGATE,
        "OP_ADD" => opcodes::OP_ADD,
        "OP_SUB" => opcodes::OP_SUB,
        "OP_MUL" => opcodes::OP_MUL,
        "OP_DIV" => opcodes::OP_DIV,
        "OP_NUMNOTEQUAL" => opcodes::OP_NUMNOTEQUAL,
        "OP_LESSTHANOREQUAL" => opcodes::OP_LESSTHANOREQUAL,
        "OP_GREATERTHANOREQUAL" => opcodes::OP_GREATERTHANOREQUAL,
        "OP_SHA256" => opcodes::OP_SHA256,
        "OP_HASH160" => opcodes::OP_HASH160,
        "OP_HASH256" => opcodes::OP_HASH256,
        "OP_CHECKSIG" => opcodes::OP_CHECKSIG,
        "OP_CHECKSIGVERIFY" => opcodes::OP_CHECKSIGVERIFY,
        "OP_CHECKMULTISIG" => opcodes::OP_CHECKMULTISIG,
        "OP_PUSH_META" => opcodes::OP_PUSH_META,
        "OP_PARTIAL_HASH" => opcodes::OP_PARTIAL_HASH,
        "OP_CHECKDATASIG" => opcodes::OP_CHECKDATASIG,
        "OP_CHECKDATASIGVERIFY" => opcodes::OP_CHECKDATASIGVERIFY,
        _ if token.starts_with("OP_") => {
            return Err(Error::InvalidScript(format!("unknown opcode {token}")));
        }
        _ => return Ok(None),
    };
    Ok(Some(opcode))
}

fn decode_script_hex(hex_value: &str, original: &str) -> Result<Vec<u8>> {
    if hex_value.is_empty() || !hex_value.len().is_multiple_of(2) {
        return Err(Error::InvalidScript(format!(
            "invalid hex token {original}"
        )));
    }
    Ok(hex::decode(hex_value)?)
}

fn parse_single_byte(hex_value: &str, original: &str) -> Result<u8> {
    let decoded = decode_script_hex(hex_value, original)?;
    decoded
        .first()
        .copied()
        .ok_or_else(|| Error::InvalidScript(format!("invalid byte token {original}")))
}

#[cfg(test)]
mod script_tests {
    #[test]
    fn script_asm_encodes_checkmultisig() {
        let script = crate::script::Script::from_asm("OP_2 OP_3 OP_CHECKMULTISIG").unwrap();
        assert_eq!(hex::encode(script.as_bytes()), "5253ae");
    }

    #[test]
    fn script_p2pkh_encodes_standard_locking_script() {
        let hash = [7u8; 20];
        let script = crate::script::Script::p2pkh(&hash);
        assert_eq!(
            hex::encode(script.as_bytes()),
            "76a914070707070707070707070707070707070707070788ac"
        );
    }

    #[test]
    fn script_from_asm_encodes_tbc_contract_opcodes_and_explicit_pushes() {
        let script = crate::script::Script::from_asm(
            "OP_1 OP_PUSH_META 0x01 0x20 OP_CHECKDATASIG OP_CHECKDATASIGVERIFY",
        )
        .unwrap();
        assert_eq!(hex::encode(script.as_bytes()), "51ba0120bcbd");
    }

    #[test]
    fn script_from_asm_encodes_raw_hex_pushes_like_tbc_lib_js() {
        let script = crate::script::Script::from_asm("OP_FALSE OP_RETURN 4e54617065").unwrap();
        assert_eq!(hex::encode(script.as_bytes()), "006a054e54617065");
    }

    #[test]
    fn script_op_return_helper_and_hash_work() {
        let script = crate::script::Script::op_return(&[b"abc".to_vec()]);
        assert!(script.is_op_return());
        assert_eq!(hex::encode(script.as_bytes()), "006a03616263");
        assert_eq!(script.sha256().len(), 32);
    }

    #[test]
    fn script_from_asm_encodes_ft_opcodes() {
        let script = crate::script::Script::from_asm(
            "OP_NOTIF OP_2DROP OP_2ROT OP_2SWAP OP_NIP OP_SIZE OP_BIN2NUM OP_1ADD OP_1SUB OP_ADD OP_SUB OP_MUL OP_NEGATE OP_CHECKSIGVERIFY",
        )
        .unwrap();
        assert_eq!(
            hex::encode(script.as_bytes()),
            "646d71727782818b8c9394958fad"
        );
    }
}
