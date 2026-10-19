//! Pure, keyless codec for the `tbc20-standard` profile.
//!
//! Reference: TuringBitChain/tbc-contract 1.7.0, commit
//! af77616121db340e15bb8b73c197bc2f8d1ee986, lib/contract/tbc20.ts
//! and lib/util/tbc20/tbc20unlock.ts. The adjacent template is copied verbatim
//! from that source's TBC20_LOCK_HEX_TEMPLATE (compiler artifact SHA256
//! 0f5db33bb46e4517963cbd383518f74283b5c2c4efb0a733522a1fbc0d4a9f84).
//! Upstream declares OpenTBC; its redistribution terms remain a release gate.
//! This attribution does not relicense the copied artifact as workspace CC0.
//!
//! Recognition is not proof of ancestry, ownership, maturity, or spendability.
//! No transaction builder, signing, I/O, or automatic protocol routing lives here.

use std::{fmt, sync::OnceLock};
use tbc_sdk::contracts::ft::partial_sha256::calculate_partial_hash;

pub const MIN_TAPE_BYTES: usize = 61;
pub const MAX_TAPE_BYTES: usize = 127;
pub const MAX_SLOT_AMOUNT: u64 = i64::MAX as u64;
pub const AMOUNT_SLOTS: usize = 6;
const TAPE_PREFIX: &[u8; 3] = b"\x00\x6a\x30";
const TAPE_MARKER: &[u8; 9] = b"TBC20TAPE";
const TAPE_ENVELOPE_BYTES: usize = 60;
const TEMPLATE: &str = include_str!("tbc20-lock-template.hex");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeDescriptor {
    /// Serialized outpoint: reversed display txid followed by uint32-LE vout.
    pub original_outpoint: [u8; 36],
    pub tape_size: u8,
    /// Hash160 followed by ScriptNum control option: zero is address control.
    /// All nonzero options except negative zero (0x80) match upstream semantics.
    pub controller: [u8; 21],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TapeDescriptor {
    pub amounts: [u64; AMOUNT_SLOTS],
    /// The sum is deliberately not restricted to the per-slot signed-63-bit cap.
    pub balance: u128,
    /// Script bytes between the six amounts and the terminal marker, not decoded metadata.
    pub extension: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodecError {
    CodeLength,
    CodeTemplate,
    InconsistentTapeSize,
    TapeSize,
    ControllerNegativeZero,
    TapeEnvelope,
    TapePushEncoding,
    AmountOverflow { slot: usize },
}

impl fmt::Display for CodecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CodeLength => f.write_str("TBC20 Code length differs from the pinned template"),
            Self::CodeTemplate => f.write_str("TBC20 Code differs from the pinned template"),
            Self::InconsistentTapeSize => f.write_str("TBC20 Code has inconsistent Tape sizes"),
            Self::TapeSize => f.write_str("TBC20 Tape size must be 61 through 127 bytes"),
            Self::ControllerNegativeZero => f.write_str("TBC20 controller cannot use ScriptNum negative zero"),
            Self::TapeEnvelope => f.write_str("TBC20 Tape prefix or marker is invalid"),
            Self::TapePushEncoding => f.write_str("TBC20 Tape must be a complete push-only script after OP_FALSE OP_RETURN"),
            Self::AmountOverflow { slot } => write!(f, "TBC20 amount slot {slot} exceeds the signed-63-bit range"),
        }
    }
}

impl std::error::Error for CodecError {}

struct CompiledTemplate {
    bytes: Vec<u8>,
    /// Immutable ranges include every opcode and each direct-push prefix.
    constants: Vec<std::ops::Range<usize>>,
    original: usize,
    tapes: [usize; 17],
    controller: usize,
}

fn template() -> &'static CompiledTemplate {
    static COMPILED: OnceLock<CompiledTemplate> = OnceLock::new();
    COMPILED.get_or_init(|| {
        let mut remaining = TEMPLATE.trim();
        let mut bytes = Vec::new();
        let mut constants = Vec::new();
        let mut original = None;
        let mut tapes = Vec::new();
        let mut controller = None;
        while !remaining.is_empty() {
            let literal_end = remaining.find('<').unwrap_or(remaining.len());
            let literal = &remaining[..literal_end];
            assert_eq!(literal.len() % 2, 0, "pinned TBC20 template hex width");
            let constant_start = bytes.len();
            for index in (0..literal.len()).step_by(2) {
                bytes.push(u8::from_str_radix(&literal[index..index + 2], 16)
                    .expect("pinned TBC20 template hex"));
            }
            remaining = &remaining[literal_end..];
            if remaining.is_empty() {
                constants.push(constant_start..bytes.len());
                break;
            }
            let end = remaining.find('>').expect("pinned TBC20 placeholder end") + 1;
            let (width, target) = match &remaining[..end] {
                "<self.OriginalUTXO36>" => (36, 0),
                "<self.ConstTapeSize1>" => (1, 1),
                "<self.Controller21>" => (21, 2),
                _ => panic!("unknown pinned TBC20 placeholder"),
            };
            bytes.push(width as u8);
            constants.push(constant_start..bytes.len());
            match target {
                0 => { assert!(original.replace(bytes.len()).is_none()); }
                1 => tapes.push(bytes.len()),
                2 => { assert!(controller.replace(bytes.len()).is_none()); }
                _ => unreachable!(),
            }
            bytes.resize(bytes.len() + width, 0);
            remaining = &remaining[end..];
        }
        let controller = controller.expect("pinned TBC20 controller");
        // The controller starts immediately after the partial-hash boundary.
        assert_eq!(controller - 1, bytes.len() / 64 * 64);
        CompiledTemplate {
            bytes,
            constants,
            original: original.expect("pinned TBC20 original outpoint"),
            tapes: tapes.try_into().expect("pinned TBC20 has exactly 17 Tape sizes"),
            controller,
        }
    })
}

fn check_tape_size(size: usize) -> Result<(), CodecError> {
    if !(MIN_TAPE_BYTES..=MAX_TAPE_BYTES).contains(&size) {
        return Err(CodecError::TapeSize);
    }
    Ok(())
}

fn check_controller(controller: &[u8; 21]) -> Result<(), CodecError> {
    if controller[20] == 0x80 {
        return Err(CodecError::ControllerNegativeZero);
    }
    Ok(())
}

/// Recognize the full pinned Code, including all 17 identical Tape-size pushes.
pub fn parse_code(code: &[u8]) -> Result<CodeDescriptor, CodecError> {
    let template = template();
    if code.len() != template.bytes.len() {
        return Err(CodecError::CodeLength);
    }
    for range in &template.constants {
        if code[range.clone()] != template.bytes[range.clone()] {
            return Err(CodecError::CodeTemplate);
        }
    }
    let tape_size = code[template.tapes[0]];
    if template.tapes.iter().any(|&offset| code[offset] != tape_size) {
        return Err(CodecError::InconsistentTapeSize);
    }
    check_tape_size(tape_size as usize)?;
    let mut original_outpoint = [0; 36];
    original_outpoint.copy_from_slice(&code[template.original..template.original + 36]);
    let mut controller = [0; 21];
    controller.copy_from_slice(&code[template.controller..template.controller + 21]);
    check_controller(&controller)?;
    Ok(CodeDescriptor { original_outpoint, tape_size, controller })
}

pub fn instantiate_code(descriptor: &CodeDescriptor) -> Result<Vec<u8>, CodecError> {
    check_tape_size(descriptor.tape_size as usize)?;
    check_controller(&descriptor.controller)?;
    let template = template();
    let mut code = template.bytes.clone();
    code[template.original..template.original + 36].copy_from_slice(&descriptor.original_outpoint);
    for &offset in &template.tapes {
        code[offset] = descriptor.tape_size;
    }
    code[template.controller..template.controller + 21].copy_from_slice(&descriptor.controller);
    Ok(code)
}

/// SHA-256 midstate of the full 64-byte blocks followed by minimal positive
/// ScriptNum Code length. This is NOT SHA256(Code), nor an outpoint identifier.
pub fn code_identity(code: &[u8]) -> Result<Vec<u8>, CodecError> {
    parse_code(code)?;
    let partial_offset = code.len() / 64 * 64;
    let mut identity = calculate_partial_hash(&code[..partial_offset]).to_vec();
    let mut size = code.len();
    while size > 0 {
        identity.push((size & 0xff) as u8);
        size >>= 8;
    }
    if identity.last().is_some_and(|byte| byte & 0x80 != 0) {
        identity.push(0);
    }
    Ok(identity)
}

pub fn replace_controller(code: &[u8], controller: [u8; 21]) -> Result<Vec<u8>, CodecError> {
    parse_code(code)?;
    check_controller(&controller)?;
    let offset = template().controller;
    let mut updated = code.to_vec();
    updated[offset..offset + 21].copy_from_slice(&controller);
    Ok(updated)
}

/// Matches upstream's complete push-only check. Small-number opcodes and even
/// OP_RESERVED (0x50) are accepted by its policy classifier; it is not a
/// minimal-push validator or a script evaluator. Bounds are checked before reads.
fn strict_push_only(script: &[u8], mut offset: usize) -> bool {
    while offset < script.len() {
        let opcode = script[offset];
        offset += 1;
        let length = match opcode {
            1..=75 => u32::from(opcode),
            76..=78 => {
                let width = 1usize << (opcode - 76);
                if script.len() - offset < width { return false; }
                let mut data = [0; 4];
                data[..width].copy_from_slice(&script[offset..offset + width]);
                offset += width;
                u32::from_le_bytes(data)
            }
            0 | 79..=96 => 0,
            _ => return false,
        };
        // u64 comparison keeps even PUSHDATA4 safe on 32-bit WASM targets.
        if u64::from(length) > (script.len() - offset) as u64 { return false; }
        offset += length as usize;
    }
    true
}

pub fn parse_tape(tape: &[u8]) -> Result<TapeDescriptor, CodecError> {
    check_tape_size(tape.len())?;
    if !tape.starts_with(TAPE_PREFIX) || !tape.ends_with(TAPE_MARKER) {
        return Err(CodecError::TapeEnvelope);
    }
    if !strict_push_only(tape, 2) {
        return Err(CodecError::TapePushEncoding);
    }
    let mut amounts = [0; AMOUNT_SLOTS];
    for (slot, amount) in amounts.iter_mut().enumerate() {
        let mut bytes = [0; 8];
        bytes.copy_from_slice(&tape[3 + slot * 8..3 + (slot + 1) * 8]);
        *amount = u64::from_le_bytes(bytes);
        if *amount > MAX_SLOT_AMOUNT { return Err(CodecError::AmountOverflow { slot }); }
    }
    Ok(TapeDescriptor {
        balance: amounts.iter().map(|&amount| u128::from(amount)).sum(),
        amounts,
        extension: tape[51..tape.len() - TAPE_MARKER.len()].to_vec(),
    })
}

pub fn build_tape(amounts: [u64; AMOUNT_SLOTS], extension: &[u8]) -> Result<Vec<u8>, CodecError> {
    // Test the extension bound before arithmetic/allocation for untrusted input.
    if !(1..=MAX_TAPE_BYTES - TAPE_ENVELOPE_BYTES).contains(&extension.len()) {
        return Err(CodecError::TapeSize);
    }
    let mut tape = Vec::with_capacity(TAPE_ENVELOPE_BYTES + extension.len());
    tape.extend_from_slice(TAPE_PREFIX);
    for (slot, amount) in amounts.iter().enumerate() {
        if *amount > MAX_SLOT_AMOUNT { return Err(CodecError::AmountOverflow { slot }); }
        tape.extend_from_slice(&amount.to_le_bytes());
    }
    tape.extend_from_slice(extension);
    tape.extend_from_slice(TAPE_MARKER);
    if !strict_push_only(&tape, 2) { return Err(CodecError::TapePushEncoding); }
    Ok(tape)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_hex(value: &serde_json::Value) -> Vec<u8> {
        let hex = value.as_str().unwrap();
        assert_eq!(hex.len() % 2, 0);
        (0..hex.len()).step_by(2)
            .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn matches_pinned_upstream_code_tape_and_identity_vectors() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../fixtures/tbc20-standard-codec.json"
        )).unwrap();
        let vectors = fixture["vectors"].as_array().unwrap();
        assert_eq!(vectors.len(), 9, "review changed fixture coverage explicitly");
        for vector in vectors {
            let id = vector["id"].as_str().unwrap();
            let expected = CodeDescriptor {
                original_outpoint: fixture_hex(&vector["originalOutpointHex"]).try_into().unwrap(),
                tape_size: u8::try_from(vector["tapeSize"].as_u64().unwrap()).unwrap(),
                controller: fixture_hex(&vector["controllerHex"]).try_into().unwrap(),
            };
            let code = fixture_hex(&vector["codeHex"]);
            assert_eq!(parse_code(&code).unwrap(), expected, "{id}");
            assert_eq!(instantiate_code(&expected).unwrap(), code, "{id}");
            assert_eq!(code_identity(&code).unwrap(), fixture_hex(&vector["identityHex"]), "{id}");
            let amounts: [u64; 6] = vector["amounts"].as_array().unwrap().iter()
                .map(|amount| amount.as_str().unwrap().parse().unwrap())
                .collect::<Vec<_>>().try_into().unwrap();
            let extension = fixture_hex(&vector["extensionHex"]);
            let tape = fixture_hex(&vector["tapeHex"]);
            assert_eq!(build_tape(amounts, &extension).unwrap(), tape, "{id}");
            assert_eq!(parse_tape(&tape).unwrap(), TapeDescriptor {
                amounts, extension,
                balance: vector["balance"].as_str().unwrap().parse().unwrap(),
            }, "{id}");
        }
        for rejection in fixture["rejections"].as_array().unwrap() {
            match rejection["kind"].as_str().unwrap() {
                "controller" => {
                    let mut desc = descriptor();
                    desc.controller = fixture_hex(&rejection["controllerHex"]).try_into().unwrap();
                    assert_eq!(instantiate_code(&desc), Err(CodecError::ControllerNegativeZero));
                }
                "slot-amount" => {
                    let amounts = rejection["amounts"].as_array().unwrap().iter()
                        .map(|amount| amount.as_str().unwrap().parse::<u64>().unwrap())
                        .collect::<Vec<_>>().try_into().unwrap();
                    assert_eq!(build_tape(amounts, &[9]), Err(CodecError::AmountOverflow { slot: 0 }));
                }
                "tape-size" => {
                    let mut desc = descriptor();
                    desc.tape_size = u8::try_from(rejection["tapeSize"].as_u64().unwrap()).unwrap();
                    assert_eq!(instantiate_code(&desc), Err(CodecError::TapeSize));
                }
                kind => panic!("unhandled upstream rejection: {kind}"),
            }
        }
    }

    fn descriptor() -> CodeDescriptor {
        CodeDescriptor { original_outpoint: [0x23; 36], tape_size: 61, controller: [0; 21] }
    }

    #[test]
    fn code_roundtrip_and_all_constant_bytes_are_checked() {
        let expected = descriptor();
        let code = instantiate_code(&expected).unwrap();
        assert_eq!(parse_code(&code).unwrap(), expected);
        for range in &template().constants {
            for offset in range.clone() {
                let mut changed = code.clone();
                changed[offset] ^= 1;
                assert_eq!(parse_code(&changed), Err(CodecError::CodeTemplate), "offset {offset}");
            }
        }
        for end in 0..code.len() {
            assert_eq!(parse_code(&code[..end]), Err(CodecError::CodeLength));
        }
        let mut trailing = code.clone(); trailing.push(0);
        assert_eq!(parse_code(&trailing), Err(CodecError::CodeLength));
    }

    #[test]
    fn seventeen_tape_fields_and_supported_range_are_enforced() {
        let code = instantiate_code(&descriptor()).unwrap();
        for &offset in &template().tapes {
            let mut changed = code.clone(); changed[offset] = 62;
            assert_eq!(parse_code(&changed), Err(CodecError::InconsistentTapeSize));
        }
        for size in [0, 60, 128, 255] {
            let mut changed = code.clone();
            for &offset in &template().tapes { changed[offset] = size; }
            assert_eq!(parse_code(&changed), Err(CodecError::TapeSize));
            let mut invalid = descriptor(); invalid.tape_size = size;
            assert_eq!(instantiate_code(&invalid), Err(CodecError::TapeSize));
        }
    }

    #[test]
    fn controller_replacement_preserves_identity_but_origin_and_size_do_not() {
        let code = instantiate_code(&descriptor()).unwrap();
        let identity = code_identity(&code).unwrap();
        for option in 0..=255u8 {
            let mut controller = [0x65; 21]; controller[20] = option;
            let result = replace_controller(&code, controller);
            if option == 0x80 {
                assert_eq!(result, Err(CodecError::ControllerNegativeZero));
            } else {
                let changed = result.unwrap();
                assert_eq!(parse_code(&changed).unwrap().controller, controller);
                assert_eq!(code_identity(&changed).unwrap(), identity);
            }
        }
        let mut bad_code = code.clone(); bad_code[template().controller + 20] = 0x80;
        assert_eq!(parse_code(&bad_code), Err(CodecError::ControllerNegativeZero));
        let mut origin = descriptor(); origin.original_outpoint[0] ^= 1;
        assert_ne!(code_identity(&instantiate_code(&origin).unwrap()).unwrap(), identity);
        let mut size = descriptor(); size.tape_size = 127;
        assert_ne!(code_identity(&instantiate_code(&size).unwrap()).unwrap(), identity);
    }

    #[test]
    fn tape_roundtrip_bounds_and_total_greater_than_single_slot_cap() {
        let amounts = [MAX_SLOT_AMOUNT, MAX_SLOT_AMOUNT, 0, 1, 2, 3];
        let tape = build_tape(amounts, &[9]).unwrap();
        assert_eq!(tape.len(), MIN_TAPE_BYTES);
        let parsed = parse_tape(&tape).unwrap();
        assert_eq!(parsed.amounts, amounts);
        assert_eq!(parsed.balance, 2 * u128::from(MAX_SLOT_AMOUNT) + 6);
        assert_eq!(parsed.extension, vec![9]);
        let mut extension = vec![65]; extension.extend_from_slice(&[0; 65]); extension.push(9);
        let max = build_tape([0; 6], &extension).unwrap();
        assert_eq!(max.len(), MAX_TAPE_BYTES);
        assert_eq!(parse_tape(&max).unwrap().extension, extension);
        for extension in [vec![], vec![0; 68]] {
            assert_eq!(build_tape([0; 6], &extension), Err(CodecError::TapeSize));
        }
        let mut overflowing = amounts; overflowing[5] = 1u64 << 63;
        assert_eq!(build_tape(overflowing, &[9]), Err(CodecError::AmountOverflow { slot: 5 }));
        let mut bad_tape = tape.clone(); bad_tape[50] = 0x80;
        assert_eq!(parse_tape(&bad_tape), Err(CodecError::AmountOverflow { slot: 5 }));
    }

    #[test]
    fn tape_envelope_and_incomplete_pushes_are_rejected_without_panics() {
        let tape = build_tape([0; 6], &[9]).unwrap();
        for end in 0..tape.len() { assert!(parse_tape(&tape[..end]).is_err()); }
        for offset in [0, 1, 2, tape.len() - 1] {
            let mut invalid = tape.clone(); invalid[offset] ^= 1;
            assert_eq!(parse_tape(&invalid), Err(CodecError::TapeEnvelope));
        }
        for extension in [&[0x61][..], &[0x4c, 0xff], &[0x4d, 0xff, 0xff], &[0x4e, 0xff, 0xff, 0xff, 0xff]] {
            assert_eq!(build_tape([0; 6], extension), Err(CodecError::TapePushEncoding));
        }
        for bytes in [&[0x4c][..], &[0x4d, 1], &[0x4e, 1, 2, 3]] { assert!(!strict_push_only(bytes, 0)); }
        // Match upstream's classifier exactly; do not silently enforce minimal pushes.
        for extension in [&[0x4c, 9][..], &[0x4d, 9, 0], &[0x4e, 9, 0, 0, 0], &[0x50, 9], &[0x60, 9]] {
            let tape = build_tape([0; 6], extension).unwrap();
            assert!(parse_tape(&tape).is_ok());
        }
    }
}
