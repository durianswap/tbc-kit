//! Pure Code codec for tbc721-standard. Not an ownership or spendability proof.
//!
//! Pinned reference: tbc-contract 1.7.0 / af77616121db340e15bb8b73c197bc2f8d1ee986,
//! lib/util/tbc721/artifacts/tbc721.json (SHA256
//! f71e7708143942e4badb265576e5f72d0713de701a2d4a31d5730b7031338ecd).
//! The adjacent template is copied verbatim. Upstream OpenTBC redistribution
//! terms remain a release gate; this does not relicense that artifact as CC0.
//! Collection metadata/Hold/Tape are shared with older NFT and cannot by
//! themselves identify the new covenant. Coin issuer profiles also use this
//! Code: business identity must be supplied and validated by the planner.

use std::{fmt, sync::OnceLock};
use tbc_sdk::{OutPoint, Txid};

pub const STANDARD_ID: &str = "tbc721-standard";
const TEMPLATE: &str = include_str!("tbc721-lock-template.hex");

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodeDescriptor {
    pub original_outpoint: OutPoint,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CodeTemplateMismatch;

impl fmt::Display for CodeTemplateMismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Code does not match the full pinned TBC721 template")
    }
}
impl std::error::Error for CodeTemplateMismatch {}

fn template() -> &'static (Vec<u8>, Vec<u8>) {
    static PARTS: OnceLock<(Vec<u8>, Vec<u8>)> = OnceLock::new();
    PARTS.get_or_init(|| {
        let (prefix, suffix) = TEMPLATE.trim().split_once("<self.OriginalUTXO36>")
            .expect("pinned TBC721 placeholder");
        let decode = |text: &str| {
            assert_eq!(text.len() % 2, 0, "pinned TBC721 hex width");
            (0..text.len()).step_by(2).map(|i|
                u8::from_str_radix(&text[i..i + 2], 16).expect("pinned TBC721 hex"))
                .collect::<Vec<_>>()
        };
        (decode(prefix), decode(suffix))
    })
}

pub fn instantiate_code(descriptor: &CodeDescriptor) -> Vec<u8> {
    let (prefix, suffix) = template();
    let mut code = Vec::with_capacity(prefix.len() + 37 + suffix.len());
    code.extend_from_slice(prefix);
    code.push(36);
    descriptor.original_outpoint.serialize(&mut code);
    code.extend_from_slice(suffix);
    code
}

pub fn parse_code(code: &[u8]) -> Result<CodeDescriptor, CodeTemplateMismatch> {
    let (prefix, suffix) = template();
    if code.len() != prefix.len() + 37 + suffix.len()
        || !code.starts_with(prefix) || code[prefix.len()] != 36
        || code[prefix.len() + 37..] != suffix[..]
    { return Err(CodeTemplateMismatch); }
    let start = prefix.len() + 1;
    let mut txid = [0; 32];
    txid.copy_from_slice(&code[start..start + 32]);
    let vout = u32::from_le_bytes(code[start + 32..start + 36].try_into().unwrap());
    Ok(CodeDescriptor { original_outpoint: OutPoint { txid: Txid::from_le_bytes(txid), vout } })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_template_and_canonical_outpoint_push_are_required() {
        let descriptor = CodeDescriptor { original_outpoint: OutPoint {
            txid: Txid::from_le_bytes([0x12; 32]), vout: u32::MAX,
        } };
        let code = instantiate_code(&descriptor);
        assert_eq!(parse_code(&code).unwrap(), descriptor);
        let start = template().0.len() + 1;
        for i in 0..code.len() {
            let mut changed = code.clone(); changed[i] ^= 1;
            assert_eq!(parse_code(&changed).is_ok(), (start..start + 36).contains(&i));
        }
        for end in 0..code.len() { assert!(parse_code(&code[..end]).is_err()); }
        let mut trailing = code.clone(); trailing.push(0); assert!(parse_code(&trailing).is_err());
        let mut indirect = code.clone(); indirect.insert(start - 1, 0x4c);
        assert!(parse_code(&indirect).is_err());
        assert!(parse_code(b"TBC721CODE3").is_err());
    }
}
