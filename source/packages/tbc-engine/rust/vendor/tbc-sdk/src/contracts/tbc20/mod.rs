use unicode_normalization::UnicodeNormalization;

use crate::contracts::ft::partial_sha256::calculate_partial_hash;
use crate::{Address, Error, OutPoint, Result, Transaction, Txid, hash, script::Script};

pub const TBC20_MAX_INPUTS: usize = 6;
pub const TBC20_MAX_OUTPUT_GROUPS: usize = 8;
pub const TBC20_MAX_OUTPUTS: usize = 16;
pub const TBC20_CODE_SATOSHIS: u64 = 500;
pub const TBC20_TAPE_SATOSHIS: u64 = 0;
pub const TBC20_AMOUNT_SLOTS: usize = 6;
pub const TBC20_MIN_TAPE_BYTES: usize = 61;
pub const TBC20_MAX_TAPE_BYTES: usize = 127;
pub const TBC20_MAX_SLOT_AMOUNT: u64 = i64::MAX as u64;
pub const TBC20_CODE_BYTES: usize = 2_396;
pub const TBC20_CODE_PARTIAL_OFFSET: usize = 2_368;
pub const TBC20_ARTIFACT_SHA256: &str =
    "e06235404815def601948893adab791e0ddf7b3ffc08ed1b4961e46477dabeb1";
pub const TBC20_METADATA_VERSION: u8 = 1;
pub const TBC20_MAX_DECIMAL: u8 = 18;

const TBC20_TEMPLATE: &str = include_str!("tbc20_lock.hex");
const TBC20_BASE_TAPE_BYTES: usize = 60;
const TAPE_PREFIX: &[u8] = &[0x00, 0x6a, 0x30];
const TAPE_MARKER: &[u8] = b"TBC20TAPE";
const TERMINAL_MARKER: &[u8] = &[0x05, 0x32, 0x43, 0x6f, 0x64, 0x65];

#[cfg(feature = "internal-signing")]
mod builder;
#[cfg(feature = "internal-signing")]
mod unlock;
#[cfg(feature = "internal-signing")]
pub use builder::{Tbc20BuildResult, Tbc20MintResult, Tbc20Spend, Tbc20TokenOutput};
#[cfg(feature = "internal-signing")]
pub use unlock::{
    Tbc20AncestorResolver, Tbc20ContractControllerWitness, Tbc20OutputGroup, Tbc20UnlockOptions,
    build_tbc20_unlock_script, build_tbc20_unlock_script_with_signature,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tbc20Definition {
    pub name: String,
    pub symbol: String,
    pub supply: String,
    pub decimal: u8,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Tbc20Config {
    pub definition: Option<Tbc20Definition>,
    pub code_script: Option<Script>,
    pub tape_script: Option<Script>,
    pub contract_txid: Option<Txid>,
    pub tape_size: Option<usize>,
    pub extension_data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tbc20 {
    pub definition: Option<Tbc20Definition>,
    pub code_script: Option<Script>,
    pub tape_script: Option<Script>,
    pub contract_txid: Option<Txid>,
    pub tape_size: usize,
    pub extension_data: Vec<u8>,
    pub declared_supply_raw: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tbc20Outpoint {
    pub txid: Txid,
    pub output_index: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tbc20ParsedTape {
    pub amounts: [u64; TBC20_AMOUNT_SLOTS],
    pub balance: u128,
    pub extension_data: Vec<u8>,
    pub size: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tbc20Utxo {
    pub outpoint: OutPoint,
    pub satoshis: u64,
    pub script_pubkey: Script,
    pub balance: u128,
}

impl Tbc20 {
    pub fn new(config: Tbc20Config) -> Result<Self> {
        let mut extension = config.extension_data.clone();
        let mut declared_supply_raw = None;
        if let Some(definition) = &config.definition {
            let (metadata, supply) = build_tbc20_metadata_extension(definition)?;
            if !extension.is_empty() && extension != metadata {
                return Err(invalid("extension data differs from canonical metadata"));
            }
            extension = metadata;
            declared_supply_raw = Some(supply);
        }

        let mut tape_size = config.tape_size.unwrap_or_default();
        if let Some(tape) = &config.tape_script {
            let parsed = parse_tbc20_tape(tape)?;
            if !extension.is_empty() && extension != parsed.extension_data {
                return Err(invalid("extension data differs from tape script"));
            }
            extension = parsed.extension_data;
            tape_size = parsed.size;
        }
        if extension.is_empty() {
            extension.push(TAPE_MARKER.len() as u8);
        }
        if tape_size == 0 {
            tape_size = TBC20_BASE_TAPE_BYTES + extension.len();
        }
        validate_tape_size(tape_size)?;
        if tape_size != TBC20_BASE_TAPE_BYTES + extension.len() {
            return Err(invalid("tape size does not match extension length"));
        }
        if let Some(code) = &config.code_script {
            validate_tbc20_code(code, Some(tape_size))?;
        }
        Ok(Self {
            definition: config.definition,
            code_script: config.code_script,
            tape_script: config.tape_script,
            contract_txid: config.contract_txid,
            tape_size,
            extension_data: extension,
            declared_supply_raw,
        })
    }
}

pub fn tbc20_human_to_raw(value: &str, decimal: u8) -> Result<u64> {
    if decimal > TBC20_MAX_DECIMAL {
        return Err(invalid("decimal must be in [0, 18]"));
    }
    let (whole, fraction) = match value.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (value, None),
    };
    if whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || (whole.len() > 1 && whole.starts_with('0'))
        || fraction.is_some_and(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(invalid(
            "amount must be a canonical unsigned decimal string",
        ));
    }
    let fraction = fraction.unwrap_or_default();
    if fraction.len() > decimal as usize {
        return Err(invalid(format!(
            "amount has more than {decimal} fractional digits"
        )));
    }
    let scale = 10u128.pow(decimal.into());
    let whole: u128 = whole
        .parse()
        .map_err(|_| invalid("amount exceeds maximum slot amount"))?;
    let mut raw = whole
        .checked_mul(scale)
        .ok_or_else(|| invalid("amount exceeds maximum slot amount"))?;
    if !fraction.is_empty() {
        let fraction_value: u128 = fraction
            .parse()
            .map_err(|_| invalid("amount exceeds maximum slot amount"))?;
        raw = raw
            .checked_add(fraction_value * 10u128.pow(decimal as u32 - fraction.len() as u32))
            .ok_or_else(|| invalid("amount exceeds maximum slot amount"))?;
    }
    if raw > u128::from(TBC20_MAX_SLOT_AMOUNT) {
        return Err(invalid("amount exceeds maximum slot amount"));
    }
    Ok(raw as u64)
}

pub fn tbc20_raw_to_human(value: u64, decimal: u8) -> Result<String> {
    if value > TBC20_MAX_SLOT_AMOUNT {
        return Err(invalid("raw amount is out of range"));
    }
    if decimal > TBC20_MAX_DECIMAL {
        return Err(invalid("decimal must be in [0, 18]"));
    }
    if decimal == 0 {
        return Ok(value.to_string());
    }
    let scale = 10u64.pow(decimal.into());
    let whole = value / scale;
    let mut fraction = format!("{:0width$}", value % scale, width = decimal as usize);
    while fraction.ends_with('0') {
        fraction.pop();
    }
    Ok(if fraction.is_empty() {
        whole.to_string()
    } else {
        format!("{whole}.{fraction}")
    })
}

pub fn encode_tbc20_original_utxo(outpoint: &Tbc20Outpoint) -> [u8; 36] {
    let mut encoded = [0u8; 36];
    encoded[..32].copy_from_slice(outpoint.txid.as_le_bytes());
    encoded[32..].copy_from_slice(&outpoint.output_index.to_le_bytes());
    encoded
}

pub fn instantiate_tbc20_code(
    original: &Tbc20Outpoint,
    controller: [u8; 21],
    tape_size: usize,
) -> Result<Script> {
    validate_tape_size(tape_size)?;
    validate_controller(controller)?;
    let template = TBC20_TEMPLATE.trim();
    if template.matches("<self.OriginalUTXO36>").count() != 1
        || template.matches("<self.ConstTapeSize1>").count() != 17
        || template.matches("<self.Controller21>").count() != 1
    {
        return Err(invalid(
            "embedded artifact placeholders changed unexpectedly",
        ));
    }
    let code_hex = template
        .replace(
            "<self.OriginalUTXO36>",
            &format!("24{}", hex::encode(encode_tbc20_original_utxo(original))),
        )
        .replace("<self.ConstTapeSize1>", &format!("01{tape_size:02x}"))
        .replace(
            "<self.Controller21>",
            &format!("15{}", hex::encode(controller)),
        );
    let code = Script::from_bytes(hex::decode(code_hex)?);
    validate_tbc20_code(&code, Some(tape_size))?;
    Ok(code)
}

pub fn validate_tbc20_code(code_script: &Script, expected_tape_size: Option<usize>) -> Result<()> {
    let code = code_script.as_bytes();
    if code.len() != TBC20_CODE_BYTES {
        return Err(invalid(format!(
            "code script must be {TBC20_CODE_BYTES} bytes"
        )));
    }
    let mut template = TBC20_TEMPLATE.trim();
    let mut offset = 0usize;
    let mut embedded_tape_size = None;
    while !template.is_empty() {
        let placeholder_at = template.find('<').unwrap_or(template.len());
        if placeholder_at > 0 {
            let constant = hex::decode(&template[..placeholder_at])?;
            if code.get(offset..offset + constant.len()) != Some(constant.as_slice()) {
                return Err(invalid(format!(
                    "code script differs from compiler artifact at byte {offset}"
                )));
            }
            offset += constant.len();
            template = &template[placeholder_at..];
            continue;
        }
        if template.is_empty() {
            break;
        }
        let end = template
            .find('>')
            .ok_or_else(|| invalid("embedded artifact has an unterminated placeholder"))?;
        let placeholder = &template[..=end];
        template = &template[end + 1..];
        match placeholder {
            "<self.OriginalUTXO36>" => {
                if code.get(offset) != Some(&36) {
                    return Err(invalid("OriginalUTXO must use a direct 36-byte push"));
                }
                offset += 37;
            }
            "<self.ConstTapeSize1>" => {
                if code.get(offset) != Some(&1) {
                    return Err(invalid("ConstTapeSize must use a direct one-byte push"));
                }
                let size = usize::from(code[offset + 1]);
                if embedded_tape_size.is_some_and(|old| old != size) {
                    return Err(invalid("code script contains inconsistent tape sizes"));
                }
                embedded_tape_size = Some(size);
                offset += 2;
            }
            "<self.Controller21>" => {
                if code.get(offset) != Some(&21) || code.get(offset + 21) == Some(&0x80) {
                    return Err(invalid(
                        "Controller must use a canonical direct 21-byte push",
                    ));
                }
                offset += 22;
            }
            _ => return Err(invalid("unknown embedded artifact placeholder")),
        }
    }
    if offset != code.len() {
        return Err(invalid(
            "code script does not exactly match compiler artifact",
        ));
    }
    let tape_size = embedded_tape_size.ok_or_else(|| invalid("artifact has no tape size"))?;
    validate_tape_size(tape_size)?;
    if expected_tape_size.is_some_and(|expected| expected != tape_size) {
        return Err(invalid(format!(
            "embedded tape size {tape_size} differs from expected {}",
            expected_tape_size.unwrap()
        )));
    }
    Ok(())
}

pub fn is_tbc20_artifact_candidate(code_script: &Script) -> bool {
    let code = code_script.as_bytes();
    if code.len() != TBC20_CODE_BYTES {
        return false;
    }
    let mut template = TBC20_TEMPLATE.trim();
    let mut offset = 0usize;
    let mut mismatches = 0usize;
    while !template.is_empty() && offset < TBC20_CODE_PARTIAL_OFFSET {
        let placeholder_at = template.find('<').unwrap_or(template.len());
        if placeholder_at > 0 {
            let Ok(constant) = hex::decode(&template[..placeholder_at]) else {
                return false;
            };
            let limit = constant
                .len()
                .min(TBC20_CODE_PARTIAL_OFFSET.saturating_sub(offset));
            mismatches += code[offset..offset + limit]
                .iter()
                .zip(&constant[..limit])
                .filter(|(left, right)| left != right)
                .count();
            if mismatches > 8 {
                return false;
            }
            offset += constant.len();
            template = &template[placeholder_at..];
            continue;
        }
        let Some(end) = template.find('>') else {
            return false;
        };
        let placeholder = &template[..=end];
        template = &template[end + 1..];
        offset += match placeholder {
            "<self.OriginalUTXO36>" => 37,
            "<self.ConstTapeSize1>" => 2,
            "<self.Controller21>" => 22,
            _ => return false,
        };
    }
    mismatches <= 8
}

pub fn tbc20_controller(code_script: &Script) -> Result<[u8; 21]> {
    let code = code_script.as_bytes();
    if code.len() < 28 || !code.ends_with(TERMINAL_MARKER) {
        return Err(invalid("code script is missing the terminal 2Code marker"));
    }
    let offset = code.len() - 28;
    if code[offset] != 21 {
        return Err(invalid("terminal controller must be a direct 21-byte push"));
    }
    let mut controller = [0u8; 21];
    controller.copy_from_slice(&code[offset + 1..offset + 22]);
    Ok(controller)
}

pub fn tbc20_code_identity(code_script: &Script) -> Result<Vec<u8>> {
    if code_script.as_bytes().is_empty() {
        return Err(invalid("locking script must be non-empty"));
    }
    let bytes = code_script.as_bytes();
    let partial_offset = bytes.len() / 64 * 64;
    let mut identity = if partial_offset == 0 {
        Vec::new()
    } else {
        calculate_partial_hash(&bytes[..partial_offset]).to_vec()
    };
    identity.extend_from_slice(&encode_unsigned_script_num(bytes.len() as u64));
    Ok(identity)
}

pub fn replace_tbc20_controller(code_script: &Script, controller: [u8; 21]) -> Result<Script> {
    validate_controller(controller)?;
    validate_tbc20_code(code_script, None)?;
    let identity = tbc20_code_identity(code_script)?;
    let mut code = code_script.as_bytes().to_vec();
    let offset = code.len() - 28;
    code[offset + 1..offset + 22].copy_from_slice(&controller);
    let updated = Script::from_bytes(code);
    if tbc20_code_identity(&updated)? != identity {
        return Err(invalid("controller replacement changed code identity"));
    }
    Ok(updated)
}

pub fn build_tbc20_tape(
    amounts: [u64; TBC20_AMOUNT_SLOTS],
    tape_size: usize,
    extension: &[u8],
) -> Result<Script> {
    validate_tape_size(tape_size)?;
    if extension.len() != tape_size - TBC20_BASE_TAPE_BYTES {
        return Err(invalid(format!(
            "tape size {tape_size} requires exactly {} extension bytes",
            tape_size - TBC20_BASE_TAPE_BYTES
        )));
    }
    let mut result = Vec::with_capacity(tape_size);
    result.extend_from_slice(TAPE_PREFIX);
    for (index, amount) in amounts.into_iter().enumerate() {
        if amount > TBC20_MAX_SLOT_AMOUNT {
            return Err(invalid(format!(
                "amounts[{index}] exceeds maximum slot amount"
            )));
        }
        result.extend_from_slice(&amount.to_le_bytes());
    }
    result.extend_from_slice(extension);
    result.extend_from_slice(TAPE_MARKER);
    if !strict_push_only(&result[2..]) {
        return Err(invalid(
            "tape after OP_RETURN must use strict canonical pushes",
        ));
    }
    Ok(Script::from_bytes(result))
}

pub fn parse_tbc20_tape(script: &Script) -> Result<Tbc20ParsedTape> {
    let bytes = script.as_bytes();
    if !(TBC20_MIN_TAPE_BYTES..=TBC20_MAX_TAPE_BYTES).contains(&bytes.len())
        || !bytes.starts_with(TAPE_PREFIX)
        || !bytes.ends_with(TAPE_MARKER)
        || !strict_push_only(&bytes[2..])
    {
        return Err(invalid("tape is not relay-safe canonical push-only data"));
    }
    let mut amounts = [0u64; TBC20_AMOUNT_SLOTS];
    let mut balance = 0u128;
    for (index, amount) in amounts.iter_mut().enumerate() {
        let start = TAPE_PREFIX.len() + index * 8;
        *amount = u64::from_le_bytes(bytes[start..start + 8].try_into().unwrap());
        if *amount > TBC20_MAX_SLOT_AMOUNT {
            return Err(invalid(format!("tape amount slot {index} exceeds maximum")));
        }
        balance = balance
            .checked_add(u128::from(*amount))
            .ok_or_else(|| invalid("tape balance overflows u64"))?;
    }
    let extension_start = TAPE_PREFIX.len() + TBC20_AMOUNT_SLOTS * 8;
    Ok(Tbc20ParsedTape {
        amounts,
        balance,
        extension_data: bytes[extension_start..bytes.len() - TAPE_MARKER.len()].to_vec(),
        size: bytes.len(),
    })
}

pub fn replace_tbc20_tape_amounts(
    script: &Script,
    amounts: [u64; TBC20_AMOUNT_SLOTS],
) -> Result<Script> {
    parse_tbc20_tape(script)?;
    let mut result = script.as_bytes().to_vec();
    for (index, amount) in amounts.into_iter().enumerate() {
        if amount > TBC20_MAX_SLOT_AMOUNT {
            return Err(invalid(format!("amount slot {index} exceeds maximum")));
        }
        let start = TAPE_PREFIX.len() + index * 8;
        result[start..start + 8].copy_from_slice(&amount.to_le_bytes());
    }
    Ok(Script::from_bytes(result))
}

pub fn build_tbc20_metadata_extension(definition: &Tbc20Definition) -> Result<(Vec<u8>, u64)> {
    if definition.name.is_empty() {
        return Err(invalid("metadata name must be non-empty valid UTF-8"));
    }
    if definition.name.nfc().collect::<String>() != definition.name {
        return Err(invalid(
            "metadata name must use canonical NFC normalization",
        ));
    }
    if definition.symbol.is_empty()
        || !definition
            .symbol
            .bytes()
            .all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err(invalid(
            "metadata symbol must be printable ASCII without whitespace",
        ));
    }
    let supply = tbc20_human_to_raw(&definition.supply, definition.decimal)?;
    if supply == 0 {
        return Err(invalid("metadata supply must be positive"));
    }
    let name = definition.name.as_bytes();
    let symbol = definition.symbol.as_bytes();
    let payload_length = 12 + name.len() + symbol.len();
    if payload_length > 75 || payload_length + 2 > TBC20_MAX_TAPE_BYTES - TBC20_BASE_TAPE_BYTES {
        return Err(invalid("metadata name and symbol are too long"));
    }
    let mut payload = Vec::with_capacity(payload_length);
    payload.push(TBC20_METADATA_VERSION);
    payload.push(definition.decimal);
    payload.extend_from_slice(&supply.to_le_bytes());
    payload.push(name.len() as u8);
    payload.push(symbol.len() as u8);
    payload.extend_from_slice(name);
    payload.extend_from_slice(symbol);
    let mut extension = Vec::with_capacity(payload.len() + 2);
    extension.push(payload.len() as u8);
    extension.extend_from_slice(&payload);
    extension.push(TAPE_MARKER.len() as u8);
    Ok((extension, supply))
}

pub fn tbc20_address_controller(address: &Address) -> [u8; 21] {
    let mut controller = [0u8; 21];
    controller[..20].copy_from_slice(&address.hash160());
    controller
}

pub fn tbc20_contract_controller(locking_script: &Script) -> Result<[u8; 21]> {
    if locking_script.as_bytes().is_empty() {
        return Err(invalid("contract locking script cannot be empty"));
    }
    let mut controller = [0u8; 21];
    controller[..20].copy_from_slice(&hash::hash160(&hash::sha256(locking_script.as_bytes())));
    controller[20] = 1;
    Ok(controller)
}

pub fn build_tbc20_utxo(transaction: &Transaction, code_vout: usize) -> Result<Tbc20Utxo> {
    let code = transaction
        .outputs
        .get(code_vout)
        .ok_or_else(|| invalid("code output must be immediately followed by tape"))?;
    let tape = transaction
        .outputs
        .get(code_vout + 1)
        .ok_or_else(|| invalid("code output must be immediately followed by tape"))?;
    if code.satoshis != TBC20_CODE_SATOSHIS || tape.satoshis != TBC20_TAPE_SATOSHIS {
        return Err(invalid("code/tape values must be exactly 500/0 satoshis"));
    }
    let parsed = parse_tbc20_tape(&tape.script_pubkey)?;
    validate_tbc20_code(&code.script_pubkey, Some(parsed.size))?;
    Ok(Tbc20Utxo {
        outpoint: OutPoint {
            txid: transaction.txid(),
            vout: code_vout as u32,
        },
        satoshis: code.satoshis,
        script_pubkey: code.script_pubkey.clone(),
        balance: parsed.balance,
    })
}

pub(crate) fn encode_unsigned_script_num(mut value: u64) -> Vec<u8> {
    if value == 0 {
        return Vec::new();
    }
    let mut result = Vec::with_capacity(9);
    while value > 0 {
        result.push(value as u8);
        value >>= 8;
    }
    if result.last().is_some_and(|byte| byte & 0x80 != 0) {
        result.push(0);
    }
    result
}

fn strict_push_only(bytes: &[u8]) -> bool {
    let mut offset = 0usize;
    while offset < bytes.len() {
        let opcode = bytes[offset];
        offset += 1;
        let length = match opcode {
            0 | 0x51..=0x60 => continue,
            1..=75 => usize::from(opcode),
            0x4c => {
                let Some(value) = bytes.get(offset) else {
                    return false;
                };
                offset += 1;
                usize::from(*value)
            }
            0x4d => {
                let Some(raw) = bytes.get(offset..offset + 2) else {
                    return false;
                };
                offset += 2;
                usize::from(u16::from_le_bytes(raw.try_into().unwrap()))
            }
            _ => return false,
        };
        let Some(end) = offset.checked_add(length) else {
            return false;
        };
        if end > bytes.len() {
            return false;
        }
        offset = end;
    }
    true
}

fn validate_tape_size(size: usize) -> Result<()> {
    if !(TBC20_MIN_TAPE_BYTES..=TBC20_MAX_TAPE_BYTES).contains(&size) {
        return Err(invalid(format!(
            "tape size must be in [{TBC20_MIN_TAPE_BYTES}, {TBC20_MAX_TAPE_BYTES}]"
        )));
    }
    Ok(())
}

fn validate_controller(controller: [u8; 21]) -> Result<()> {
    if controller[20] == 0x80 {
        return Err(invalid(
            "controller option 80 is non-canonical negative zero",
        ));
    }
    Ok(())
}

fn invalid(message: impl Into<String>) -> Error {
    Error::InvalidScript(format!("TBC20: {}", message.into()))
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        artifact_sha256: String,
        code_bytes: usize,
        partial_offset: usize,
        code_hex: String,
        #[serde(rename = "originalUTXOHex")]
        original_utxo_hex: String,
        controller_hex: String,
        code_identity_hex: String,
        tape_hex: String,
        tape_amounts: Vec<String>,
        tape_balance: String,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(include_str!("../../../tests/fixtures/js-166/tbc20.json")).unwrap()
    }

    #[test]
    fn artifact_code_and_identity_match_javascript_166() {
        let fixture = fixture();
        let original = Tbc20Outpoint {
            txid: Txid::from_str(&"11".repeat(32)).unwrap(),
            output_index: 3,
        };
        let controller: [u8; 21] = hex::decode(&fixture.controller_hex)
            .unwrap()
            .try_into()
            .unwrap();
        let code = instantiate_tbc20_code(&original, controller, 61).unwrap();
        assert_eq!(hex::encode(code.as_bytes()), fixture.code_hex);
        assert_eq!(code.as_bytes().len(), fixture.code_bytes);
        assert_eq!(TBC20_CODE_PARTIAL_OFFSET, fixture.partial_offset);
        assert_eq!(fixture.artifact_sha256, TBC20_ARTIFACT_SHA256);
        assert_eq!(
            hex::encode(encode_tbc20_original_utxo(&original)),
            fixture.original_utxo_hex
        );
        assert_eq!(
            hex::encode(tbc20_code_identity(&code).unwrap()),
            fixture.code_identity_hex
        );
        assert_eq!(tbc20_controller(&code).unwrap(), controller);
        assert!(is_tbc20_artifact_candidate(&code));
    }

    #[test]
    fn tape_and_amount_conversion_match_javascript_166() {
        let fixture = fixture();
        let amounts: [u64; 6] = fixture
            .tape_amounts
            .iter()
            .map(|value| value.parse().unwrap())
            .collect::<Vec<_>>()
            .try_into()
            .unwrap();
        let tape = build_tbc20_tape(amounts, 61, &[9]).unwrap();
        assert_eq!(hex::encode(tape.as_bytes()), fixture.tape_hex);
        let parsed = parse_tbc20_tape(&tape).unwrap();
        assert_eq!(parsed.amounts, amounts);
        assert_eq!(parsed.balance.to_string(), fixture.tape_balance);
        assert_eq!(tbc20_human_to_raw("1.2300", 4).unwrap(), 12_300);
        assert_eq!(tbc20_raw_to_human(12_300, 4).unwrap(), "1.23");
    }

    #[test]
    fn metadata_and_controllers_are_canonical() {
        let definition = Tbc20Definition {
            name: "Parity Token".to_string(),
            symbol: "PTY".to_string(),
            supply: "1000".to_string(),
            decimal: 8,
        };
        let (extension, supply) = build_tbc20_metadata_extension(&definition).unwrap();
        assert_eq!(supply, 100_000_000_000);
        let tbc20 = Tbc20::new(Tbc20Config {
            definition: Some(definition),
            ..Tbc20Config::default()
        })
        .unwrap();
        assert_eq!(tbc20.extension_data, extension);
        assert_eq!(tbc20.tape_size, 89);

        let address = Address::from_string("1N7rf2AuAHB2aCrVgnbQhSWhaUVk3rGhjm").unwrap();
        assert_eq!(tbc20_address_controller(&address)[20], 0);
        assert_eq!(
            tbc20_contract_controller(&address.script_pubkey()).unwrap()[20],
            1
        );
    }
}
