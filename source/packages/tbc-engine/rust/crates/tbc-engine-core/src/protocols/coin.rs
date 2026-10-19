//! Keyless `tbc20-stablecoin` Code/Tape codec and script lock requirements.
//! Pinned tbc-contract 1.7.0 / af77616121db340e15bb8b73c197bc2f8d1ee986,
//! lib/util/coin/coinTbc20Code.ts. Adjacent compiler template is copied verbatim
//! from artifacts/coin_tbc20.json (OpenTBC; redistribution is a release gate).
//! Template recognition is not proof of issuance, ownership or spendability.
//! Lock checks here do not evaluate chain finality or authorize administrator use.

use std::{fmt, sync::OnceLock};
use tbc_sdk::contracts::ft::partial_sha256::calculate_partial_hash;
use super::tbc20::{AMOUNT_SLOTS, MAX_SLOT_AMOUNT};

pub const CODE_SIZE: usize = 2981;
pub const PARTIAL_OFFSET: usize = 2944;
pub const MIN_TAPE_BYTES: usize = 66;
pub const MAX_TAPE_BYTES: usize = 127;
pub const LOCKTIME_THRESHOLD: u32 = 500_000_000;
/// Fixed SDK holder inputs enable CLTV even when the current Tape lock is zero.
pub const HOLDER_INPUT_SEQUENCE: u32 = 0xffff_fffe;
const TEMPLATE: &str = include_str!("coin-lock-template.hex");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeDescriptor {
    pub coin_nft_code_hash: [u8; 32],
    pub admin_pubkey_hash: [u8; 20],
    pub tape_size: u8,
    pub controller: [u8; 21],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TapeDescriptor {
    pub amounts: [u64; AMOUNT_SLOTS],
    pub balance: u128,
    pub lock_time: u32,
    /// Exact push-only bytes, including zero padding. Never decoded as identity.
    pub metadata: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodecError(pub &'static str);
impl fmt::Display for CodecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(self.0) }
}
impl std::error::Error for CodecError {}

struct Template {
    bytes: Vec<u8>, constants: Vec<std::ops::Range<usize>>,
    nft: usize, admin: usize, tapes: Vec<usize>, controller: usize,
}
fn template() -> &'static Template {
    static VALUE: OnceLock<Template> = OnceLock::new();
    VALUE.get_or_init(|| {
        let mut rest = TEMPLATE.trim();
        let mut bytes = Vec::new(); let mut constants = Vec::new();
        let mut nft = None; let mut admin = None; let mut controller = None; let mut tapes = Vec::new();
        while !rest.is_empty() {
            let end = rest.find('<').unwrap_or(rest.len());
            let start = bytes.len();
            assert_eq!(end % 2, 0, "pinned Coin template hex");
            for i in (0..end).step_by(2) { bytes.push(u8::from_str_radix(&rest[i..i+2], 16).expect("pinned Coin hex")); }
            rest = &rest[end..];
            if rest.is_empty() { constants.push(start..bytes.len()); break; }
            let end = rest.find('>').expect("pinned Coin field") + 1;
            let width = match &rest[..end] {
                "<self.CoinNftCodeHash32>" => 32,
                "<self.AdminPubKeyHash20>" => 20,
                "<self.ConstTapeSize1>" => 1,
                "<self.Controller21>" => 21,
                _ => panic!("unknown pinned Coin field"),
            };
            bytes.push(width as u8); constants.push(start..bytes.len());
            match width {
                32 => assert!(nft.replace(bytes.len()).is_none()),
                20 => assert!(admin.replace(bytes.len()).is_none()),
                21 => assert!(controller.replace(bytes.len()).is_none()),
                _ => tapes.push(bytes.len()),
            }
            bytes.resize(bytes.len() + width, 0); rest = &rest[end..];
        }
        assert_eq!(bytes.len(), CODE_SIZE); assert_eq!(tapes.len(), 25);
        let controller = controller.expect("pinned Coin controller");
        assert_eq!(controller - 1, PARTIAL_OFFSET);
        Template { bytes, constants, nft: nft.unwrap(), admin: admin.unwrap(), tapes, controller }
    })
}
fn tape_size(size: usize) -> Result<(), CodecError> {
    if !(MIN_TAPE_BYTES..=MAX_TAPE_BYTES).contains(&size) { return Err(CodecError("Coin Tape size must be 66-127")); }
    Ok(())
}
fn descriptor(value: &CodeDescriptor) -> Result<(), CodecError> {
    tape_size(value.tape_size as usize)?;
    if value.controller[20] > 1 { return Err(CodecError("Coin controller must be address or contract")); }
    Ok(())
}

pub fn instantiate_code(value: &CodeDescriptor) -> Result<Vec<u8>, CodecError> {
    descriptor(value)?; let t = template(); let mut code = t.bytes.clone();
    code[t.nft..t.nft+32].copy_from_slice(&value.coin_nft_code_hash);
    code[t.admin..t.admin+20].copy_from_slice(&value.admin_pubkey_hash);
    code[t.controller..t.controller+21].copy_from_slice(&value.controller);
    for &offset in &t.tapes { code[offset] = value.tape_size; }
    Ok(code)
}
pub fn parse_code(code: &[u8]) -> Result<CodeDescriptor, CodecError> {
    let t = template();
    if code.len() != CODE_SIZE || t.constants.iter().any(|r| code.get(r.clone()) != Some(&t.bytes[r.clone()])) {
        return Err(CodecError("Coin Code differs from the pinned template"));
    }
    let size = code[t.tapes[0]];
    if t.tapes.iter().any(|&i| code[i] != size) { return Err(CodecError("Coin Tape size pushes disagree")); }
    let result = CodeDescriptor { coin_nft_code_hash: code[t.nft..t.nft+32].try_into().unwrap(),
        admin_pubkey_hash: code[t.admin..t.admin+20].try_into().unwrap(), tape_size: size,
        controller: code[t.controller..t.controller+21].try_into().unwrap() };
    descriptor(&result)?; Ok(result)
}
pub fn code_identity(code: &[u8]) -> Result<Vec<u8>, CodecError> {
    parse_code(code)?;
    let mut result = calculate_partial_hash(&code[..PARTIAL_OFFSET]).to_vec();
    // Minimal positive ScriptNum for pinned CODE_SIZE (0x0ba5).
    result.extend_from_slice(&[0xa5, 0x0b]); Ok(result)
}
pub fn replace_controller(code: &[u8], controller: [u8; 21]) -> Result<Vec<u8>, CodecError> {
    let mut value = parse_code(code)?; value.controller = controller;
    instantiate_code(&value)
}

fn metadata_valid(bytes: &[u8]) -> bool {
    let mut i = 0;
    while i < bytes.len() {
        let op = bytes[i]; i += 1;
        let count = match op {
            1..=75 => u32::from(op),
            76..=78 => {
                let width = 1usize << (op - 76);
                if bytes.len() - i < width { return false; }
                let mut data = [0; 4]; data[..width].copy_from_slice(&bytes[i..i+width]); i += width;
                u32::from_le_bytes(data)
            }
            0 | 79 | 81..=96 => 0,
            _ => return false, // OP_RESERVED is explicitly forbidden by Coin.
        };
        if u64::from(count) > (bytes.len() - i) as u64 { return false; }
        i += count as usize;
    }
    true
}
pub fn build_tape(amounts: [u64; 6], size: usize, lock_time: u32, metadata: &[u8]) -> Result<Vec<u8>, CodecError> {
    tape_size(size)?;
    if amounts.iter().any(|&a| a > MAX_SLOT_AMOUNT) { return Err(CodecError("Coin amount slot exceeds signed-63-bit range")); }
    if metadata.len() > size - MIN_TAPE_BYTES || !metadata_valid(metadata) { return Err(CodecError("Coin metadata is not a bounded complete push-only fragment")); }
    let mut tape = vec![0; size]; tape[..3].copy_from_slice(&[0, 0x6a, 0x30]);
    for (i, amount) in amounts.iter().enumerate() { tape[3+i*8..11+i*8].copy_from_slice(&amount.to_le_bytes()); }
    tape[51..51+metadata.len()].copy_from_slice(metadata);
    tape[size-15] = 4; tape[size-14..size-10].copy_from_slice(&lock_time.to_le_bytes());
    tape[size-10] = 9; tape[size-9..].copy_from_slice(b"TBC20TAPE"); Ok(tape)
}
pub fn parse_tape(tape: &[u8], expected_size: Option<usize>) -> Result<TapeDescriptor, CodecError> {
    tape_size(tape.len())?; let size = tape.len();
    if expected_size.is_some_and(|n| n != size) || !tape.starts_with(&[0, 0x6a, 0x30]) ||
        tape[size-15] != 4 || tape[size-10] != 9 || !tape.ends_with(b"TBC20TAPE") {
        return Err(CodecError("Coin Tape envelope or expected size differs"));
    }
    let metadata = &tape[51..size-15];
    if !metadata_valid(metadata) { return Err(CodecError("Coin metadata contains an incomplete or forbidden push")); }
    let mut amounts = [0; 6];
    for (i, amount) in amounts.iter_mut().enumerate() { *amount = u64::from_le_bytes(tape[3+i*8..11+i*8].try_into().unwrap()); }
    if amounts.iter().any(|&a| a > MAX_SLOT_AMOUNT) { return Err(CodecError("Coin amount slot exceeds signed-63-bit range")); }
    Ok(TapeDescriptor { amounts, balance: amounts.iter().map(|&a| a as u128).sum(),
        lock_time: u32::from_le_bytes(tape[size-14..size-10].try_into().unwrap()), metadata: metadata.to_vec() })
}
pub fn replace_tape_amounts(tape: &[u8], amounts: [u64; 6]) -> Result<Vec<u8>, CodecError> {
    let prior = parse_tape(tape, None)?; build_tape(amounts, tape.len(), prior.lock_time, &prior.metadata)
}
pub fn set_lock_time(tape: &[u8], lock_time: u32) -> Result<Vec<u8>, CodecError> {
    let prior = parse_tape(tape, None)?; build_tape(prior.amounts, tape.len(), lock_time, &prior.metadata)
}
pub fn required_lock_time(locks: &[u32]) -> Result<u32, CodecError> {
    let mut domain = None; let mut maximum = 0;
    for &lock in locks {
        if lock != 0 {
            let timestamp = lock >= LOCKTIME_THRESHOLD;
            if domain.is_some_and(|prior| prior != timestamp) { return Err(CodecError("Coin locks mix height and timestamp domains")); }
            domain = Some(timestamp);
        }
        maximum = maximum.max(lock);
    }
    Ok(maximum)
}
/// Only the script's lock predicate. `administrator` must come from an already
/// verified role; this function neither grants that role nor checks chain tip.
pub fn verify_input_lock(sequence: u32, transaction_lock_time: u32, tape: &[u8], expected_size: Option<usize>, administrator: bool) -> Result<(), CodecError> {
    let parsed = parse_tape(tape, expected_size)?;
    if sequence == u32::MAX { return Err(CodecError("Coin input requires nonfinal sequence")); }
    if administrator { return Ok(()); }
    if parsed.lock_time != 0 && (parsed.lock_time < LOCKTIME_THRESHOLD) != (transaction_lock_time < LOCKTIME_THRESHOLD) {
        return Err(CodecError("Coin parent lock and transaction lock use different domains"));
    }
    if parsed.lock_time > transaction_lock_time { return Err(CodecError("Coin parent lock exceeds transaction lock")); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i+2], 16).unwrap()).collect()
    }
    fn vectors() -> Vec<serde_json::Value> {
        serde_json::from_str::<serde_json::Value>(include_str!("../../../../fixtures/coin-codec.json")).unwrap()["vectors"].as_array().unwrap().clone()
    }
    #[test]
    fn pinned_upstream_code_tape_identity_and_replacements() {
        for value in vectors() {
            let code = hex(value["codeHex"].as_str().unwrap());
            let tape = hex(value["tapeHex"].as_str().unwrap());
            let descriptor = CodeDescriptor {
                coin_nft_code_hash: hex(value["coinNftCodeHashHex"].as_str().unwrap()).try_into().unwrap(),
                admin_pubkey_hash: hex(value["adminPubKeyHashHex"].as_str().unwrap()).try_into().unwrap(),
                tape_size: value["tapeSize"].as_u64().unwrap() as u8,
                controller: hex(value["controllerHex"].as_str().unwrap()).try_into().unwrap(),
            };
            assert_eq!(parse_code(&code).unwrap(), descriptor);
            assert_eq!(instantiate_code(&descriptor).unwrap(), code);
            let identity = code_identity(&code).unwrap();
            assert_eq!(identity, hex(value["identityHex"].as_str().unwrap()));
            let mut receiver = [0x44; 21]; receiver[20] = 0;
            assert_eq!(code_identity(&replace_controller(&code, receiver).unwrap()).unwrap(), identity);
            let mut admin = descriptor.clone(); admin.admin_pubkey_hash[0] ^= 1;
            assert_ne!(code_identity(&instantiate_code(&admin).unwrap()).unwrap(), identity);
            let mut issuer = descriptor.clone(); issuer.coin_nft_code_hash[0] ^= 1;
            assert_ne!(code_identity(&instantiate_code(&issuer).unwrap()).unwrap(), identity);
            let amounts: [u64; 6] = value["amounts"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().parse().unwrap()).collect::<Vec<_>>().try_into().unwrap();
            let lock = value["lockTime"].as_u64().unwrap() as u32;
            let parsed = parse_tape(&tape, Some(descriptor.tape_size as usize)).unwrap();
            assert_eq!(parsed.amounts, amounts); assert_eq!(parsed.lock_time, lock);
            assert_eq!(parsed.balance.to_string(), value["balance"].as_str().unwrap());
            assert_eq!(parsed.metadata, hex(value["paddedMetadataHex"].as_str().unwrap()));
            assert_eq!(build_tape(amounts, tape.len(), lock, &hex(value["metadataHex"].as_str().unwrap())).unwrap(), tape);
            assert_eq!(parse_tape(&replace_tape_amounts(&tape, [7; 6]).unwrap(), None).unwrap().lock_time, lock);
            assert_eq!(parse_tape(&set_lock_time(&tape, 1).unwrap(), None).unwrap().amounts, amounts);
            assert!(super::super::tbc20::parse_code(&code).is_err());
        }
    }
    #[test]
    fn exact_template_repeated_fields_and_strict_tape_bounds() {
        let code = hex(vectors()[0]["codeHex"].as_str().unwrap());
        let t = template();
        for range in &t.constants { for index in range.clone() {
            let mut bad = code.clone(); bad[index] ^= 1; assert!(parse_code(&bad).is_err());
        } }
        for &index in &t.tapes { let mut bad = code.clone(); bad[index] = 67; assert!(parse_code(&bad).is_err()); }
        let mut bad = code.clone(); bad[t.controller+20] = 0x80; assert!(parse_code(&bad).is_err());
        assert!(parse_code(&code[..code.len()-1]).is_err());
        let mut extra = code.clone(); extra.push(0); assert!(parse_code(&extra).is_err());
        for fragment in [vec![0x50], vec![2,1], vec![0x4c,2,0xff], vec![0x4d,0xff,0xff], vec![0x4e,0xff,0xff,0xff,0xff], vec![0xac]] {
            assert!(build_tape([1; 6], 127, 0, &fragment).is_err());
        }
        for size in [0, 65, 128, usize::MAX] { assert!(build_tape([1; 6], size, 0, &[]).is_err()); }
        assert!(build_tape([u64::MAX; 6], 66, 0, &[]).is_err());
        assert!(build_tape([1; 6], 66, 0, &[0]).is_err());
        let tape = build_tape([MAX_SLOT_AMOUNT; 6], 66, u32::MAX, &[]).unwrap();
        assert_eq!(parse_tape(&tape, None).unwrap().balance, MAX_SLOT_AMOUNT as u128 * 6);
        assert!(parse_tape(&tape, Some(67)).is_err());
        for index in [0,1,2,51,56,65] { let mut bad = tape.clone(); bad[index] ^= 1; assert!(parse_tape(&bad, None).is_err()); }
    }
    #[test]
    fn lock_domains_and_nonfinal_sequence_do_not_claim_chain_finality() {
        assert_eq!(required_lock_time(&[]).unwrap(), 0);
        assert_eq!(required_lock_time(&[0, 1, 499_999_999]).unwrap(), 499_999_999);
        assert_eq!(required_lock_time(&[0, 500_000_000, u32::MAX]).unwrap(), u32::MAX);
        assert!(required_lock_time(&[1, 500_000_000]).is_err());
        let height = build_tape([1; 6], 66, 12, &[]).unwrap();
        assert!(verify_input_lock(u32::MAX-1, 11, &height, None, false).is_err());
        assert!(verify_input_lock(u32::MAX-1, 12, &height, None, false).is_ok());
        assert!(verify_input_lock(u32::MAX-1, 500_000_000, &height, None, false).is_err());
        assert!(verify_input_lock(u32::MAX-1, 0, &height, None, true).is_ok());
        assert!(verify_input_lock(u32::MAX, 12, &height, None, true).is_err());
        let unlocked = set_lock_time(&height, 0).unwrap();
        assert!(verify_input_lock(u32::MAX, 0, &unlocked, None, false).is_err());
        assert!(verify_input_lock(u32::MAX-1, 0, &unlocked, None, false).is_ok());
        let time = set_lock_time(&height, u32::MAX).unwrap();
        assert!(verify_input_lock(0, u32::MAX, &time, None, false).is_ok());
        assert!(verify_input_lock(0, u32::MAX-1, &time, None, false).is_err());
    }
}
