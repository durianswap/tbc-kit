use std::collections::HashSet;

use crate::{
    Address, Error, OutPoint, PublicKey, Result, SDK_DUST_SAT, Txid,
    contracts::{
        ft::scripts::{FtCodeReceiver, transfer_code_script},
        pool_nft_v2::PoolState,
    },
    script::Script,
};

pub const POOL_CODE_SATOSHIS: u64 = 1_000;
pub const FTLP_CODE_SATOSHIS: u64 = 500;
pub const POOL_TAPE_SATOSHIS: u64 = 0;
pub const FTLP_TAPE_SATOSHIS: u64 = 0;

const POOL_CODE_MARKER: &[u8] = b"2Code";
const CANONICAL_POOL_CODE_MARKER: &[u8] = b"\x052Code";
const FTLP_CODE_MARKER: &[u8] = b"\x02Code";
const NTAPE_MARKER: &[u8] = b"NTape";
const FTAPE_MARKER: &[u8] = b"FTape";
const MAX_DIRECT_TAG_BYTES: usize = 75;
const LOCK_TIME_TAPE_FIXED_BYTES: usize = 62;
const SERIALIZED_OUTPOINT_BYTES: usize = 36;

// Released verbatim ASM sources:
// /home/ubuntu/projects/tbc-contract-go/lib/contract/asm at fea64e67eedec31f014292e39ebbbee368d7edb3.
const POOL_CODE_TEMPLATE: &str = include_str!("templates/pool_code.asm");
const LOCKED_POOL_PRE_TEMPLATE: &str = include_str!("templates/pool_code_locked_pre.asm");
const LOCKED_POOL_LAST_TEMPLATE: &str = include_str!("templates/pool_code_locked_last.asm");
const FTLP_CODE_TEMPLATE: &str = include_str!("templates/ftlp_code.asm");
const FTLP_LOCK_TIME_CODE_TEMPLATE: &str = include_str!("templates/ftlp_code_lock_time.asm");
const FTLP_V3_CODE_TEMPLATE: &str = include_str!("templates/ftlp_code_v3.asm");
const FTLP_V3_LOCK_TIME_CODE_TEMPLATE: &str = include_str!("templates/ftlp_code_v3_lock_time.asm");

const SERVICE_FEE_ADDRESSES: [&str; 6] = [
    "13oCEJaqyyiC8iRrfup6PDL2GKZ3xQrsZL",
    "1Fa6Uy64Ub4qNdB896zX2pNMx4a8zMhtCy",
    "125fTLNsraQxTYqT4EeQNF2ggzcqicveKL",
    "19DetoaaohQkjFVJ6oGXd83xhZYQSbpE1g",
    "15EKrhuD8Yf3SfhjAgbizYqfnBbKh9ZMZ7",
    "1N7rf2AuAHB2aCrVgnbQhSWhaUVk3rGhjm",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FtScriptVersion {
    V1,
    V2,
    V3,
    V4,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolCodeParams {
    pub lp_plan: u8,
    pub ft_version: FtScriptVersion,
    pub is_coin: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LockedPoolCodeParams {
    pub pool: PoolCodeParams,
    pub lp_cost_address: Address,
    pub lp_cost_sat: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FtlpCodeParams {
    pub tape_size: usize,
    pub ft_version: FtScriptVersion,
    pub is_coin: bool,
}

impl FtlpCodeParams {
    pub fn for_tape(tape: &Script, ft_version: FtScriptVersion, is_coin: bool) -> Result<Self> {
        validate_tape_size(tape.as_bytes().len())?;
        Ok(Self {
            tape_size: tape.as_bytes().len(),
            ft_version,
            is_coin,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FtlpTapeLayout<'a> {
    Standard {
        decimal: u8,
        name: &'a str,
        symbol: &'a str,
        is_coin: bool,
    },
    LockTime {
        lock_time: u32,
        source_ft_tape_size: usize,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FtlpTapeParams<'a> {
    pub amount_raw: u64,
    pub layout: FtlpTapeLayout<'a>,
}

pub fn pool_code(source: OutPoint, tag: &[u8], params: &PoolCodeParams) -> Result<Script> {
    let common = common_pool_substitutions(&source, tag, params)?;
    let asm = substitute_template(
        POOL_CODE_TEMPLATE,
        &[
            ("${utxoHex}", &common.outpoint_hex, 1),
            ("${ftCodeSize}", common.ft_code_size, 27),
            ("${pumpPublicKeyHash}", &common.pump_hash_hex, 2),
            ("${tagLengthHex}", &common.tag_length_hex, 1),
            ("${tagHex}", &common.tag_hex, 1),
        ],
    )?;
    let script = script_from_released_asm(&asm)?;
    validate_code_marker(&script, POOL_CODE_MARKER, "Pool")?;
    Ok(script)
}

pub fn locked_pool_code(
    source: OutPoint,
    tag: &[u8],
    public_keys: &[PublicKey],
    params: &LockedPoolCodeParams,
) -> Result<Script> {
    if !(1..=10).contains(&public_keys.len()) {
        return Err(script_error(
            "locked Pool requires between one and ten public keys",
        ));
    }
    if params.lp_cost_sat < SDK_DUST_SAT {
        return Err(script_error(format!(
            "locked Pool LP cost must be at least {SDK_DUST_SAT} satoshis"
        )));
    }

    let mut keys = public_keys
        .iter()
        .map(PublicKey::to_bytes)
        .collect::<Vec<_>>();
    keys.sort_unstable();
    if keys.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(script_error("locked Pool public keys must be distinct"));
    }

    let common = common_pool_substitutions(&source, tag, &params.pool)?;
    let lp_cost_hash = hex::encode(params.lp_cost_address.hash160());
    let lp_cost_amount = hex::encode(params.lp_cost_sat.to_le_bytes());
    let pre = substitute_template(
        LOCKED_POOL_PRE_TEMPLATE,
        &[
            ("${utxoHex}", &common.outpoint_hex, 1),
            ("${ftCodeSize}", common.ft_code_size, 21),
            ("${pumpPublicKeyHash}", &common.pump_hash_hex, 2),
            ("${lpCostAddressHex}", &lp_cost_hash, 1),
            ("${lpCostAmountHex}", &lp_cost_amount, 1),
        ],
    )?;
    let last = substitute_template(
        LOCKED_POOL_LAST_TEMPLATE,
        &[
            ("${ftCodeSize}", common.ft_code_size, 6),
            ("${tagLengthHex}", &common.tag_length_hex, 1),
            ("${tagHex}", &common.tag_hex, 1),
        ],
    )?;

    let mut key_check = String::new();
    if keys.len() == 1 {
        key_check.push_str(&hex::encode(keys[0]));
        key_check.push_str(" OP_EQUALVERIFY OP_CHECKSIGVERIFY");
    } else {
        for key in &keys[..keys.len() - 1] {
            key_check.push_str("OP_DUP ");
            key_check.push_str(&hex::encode(key));
            key_check.push_str(" OP_EQUAL OP_IF OP_DROP OP_ELSE ");
        }
        key_check.push_str(&hex::encode(keys[keys.len() - 1]));
        key_check.push_str(" OP_EQUALVERIFY");
        for _ in 0..keys.len() - 1 {
            key_check.push_str(" OP_ENDIF");
        }
        key_check.push_str(" OP_CHECKSIGVERIFY");
    }

    // getOpCode(33) in the released JS returns bare hex "21". In ASM that
    // pushes the one-byte script number 33 consumed by OP_SPLIT.
    let asm = format!("{pre} OP_DUP 21 OP_SPLIT OP_DROP {key_check} {last}");
    let script = script_from_released_asm(&asm)?;
    validate_code_marker(&script, POOL_CODE_MARKER, "locked Pool")?;
    Ok(script)
}

/// Decodes the fixed LP-cost P2PKH recipient and amount from the one released
/// locked-Pool template location.  The surrounding opcode sequence prevents a
/// caller-supplied context value from selecting a different cost output.
#[cfg(feature = "internal-signing")]
pub(crate) fn locked_pool_lp_cost(script: &Script) -> Result<(Address, u64)> {
    let bytes = script.as_bytes();
    let sentinel = [
        crate::script::opcodes::OP_EQUALVERIFY,
        crate::script::opcodes::OP_PARTIAL_HASH,
        crate::script::opcodes::OP_OVER,
        0x08,
    ];
    for index in 0..bytes.len().saturating_sub(34) {
        if bytes[index] != 0x14
            || bytes[index + 21..index + 25] != sentinel
            || bytes[index + 33] != crate::script::opcodes::OP_EQUALVERIFY
        {
            continue;
        }
        let hash160: [u8; 20] = bytes[index + 1..index + 21]
            .try_into()
            .expect("fixed 20-byte slice");
        let satoshis = u64::from_le_bytes(
            bytes[index + 25..index + 33]
                .try_into()
                .expect("fixed 8-byte slice"),
        );
        if satoshis < SDK_DUST_SAT {
            return Err(script_error("locked Pool LP cost is below dust"));
        }
        return Ok((Address::from_hash160(hash160), satoshis));
    }
    Err(script_error(
        "Pool Code lacks the released locked LP-cost binding",
    ))
}

pub fn pool_code_source_outpoint(script: &Script) -> Result<OutPoint> {
    if !script.as_bytes().ends_with(CANONICAL_POOL_CODE_MARKER) {
        return Err(script_error("Pool script marker is not canonical"));
    }

    let bytes = script.as_bytes();
    let candidates = (0..bytes.len().saturating_sub(SERIALIZED_OUTPOINT_BYTES + 1))
        .filter(|index| {
            bytes.get(*index) == Some(&(SERIALIZED_OUTPOINT_BYTES as u8))
                && bytes.get(*index + 1 + SERIALIZED_OUTPOINT_BYTES)
                    == Some(&crate::script::opcodes::OP_EQUALVERIFY)
        })
        .collect::<Vec<_>>();
    let source_push = match candidates.as_slice() {
        [index] => *index,
        _ => {
            return Err(script_error(
                "Pool source outpoint does not have one canonical released binding",
            ));
        }
    };
    let source_start = source_push + 1;
    let source_end = source_start + SERIALIZED_OUTPOINT_BYTES;
    let source = bytes
        .get(source_start..source_end)
        .ok_or_else(|| script_error("Pool source outpoint is truncated"))?;
    let txid = Txid::from_le_bytes(
        source[..32]
            .try_into()
            .map_err(|_| script_error("Pool source txid is truncated"))?,
    );
    let vout = u32::from_le_bytes(
        source[32..]
            .try_into()
            .map_err(|_| script_error("Pool source vout is truncated"))?,
    );
    Ok(OutPoint { txid, vout })
}

pub fn pool_tape(state: &PoolState) -> Result<Script> {
    if state.ft_lp_partial_hash.len() != 32 || state.ft_a_partial_hash.len() != 32 {
        return Err(script_error(
            "Pool partial hashes must each contain exactly 32 bytes",
        ));
    }
    validate_lp_plan(state.lp_plan)?;

    let mut partial_hashes = Vec::with_capacity(64);
    partial_hashes.extend_from_slice(&state.ft_lp_partial_hash);
    partial_hashes.extend_from_slice(&state.ft_a_partial_hash);

    let mut amounts = Vec::with_capacity(24);
    amounts.extend_from_slice(&state.amounts.ft_lp_raw.to_le_bytes());
    amounts.extend_from_slice(&state.amounts.ft_a_raw.to_le_bytes());
    amounts.extend_from_slice(&state.amounts.tbc_sat.to_le_bytes());

    // JS inserts the displayed FT contract txid directly into NTape; unlike
    // an OutPoint, this field is not byte-reversed.
    let contract_id = hex::decode(state.ft_a_contract_id.to_string())?;
    let script = Script::op_return(&[
        partial_hashes,
        amounts,
        contract_id,
        fee_rate_bytes(state.service_fee_rate),
        vec![state.lp_plan],
        vec![u8::from(state.public_key_locked)],
        vec![u8::from(state.ftlp_lock_time_enabled)],
        NTAPE_MARKER.to_vec(),
    ]);
    validate_code_marker(&script, NTAPE_MARKER, "Pool NTape")?;
    Ok(script)
}

fn fee_rate_bytes(rate: u16) -> Vec<u8> {
    if rate <= u16::from(u8::MAX) {
        vec![rate as u8]
    } else {
        rate.to_be_bytes().to_vec()
    }
}

pub fn pool_held_ft_code(ft_code: &Script, pool_code_hash160: [u8; 20]) -> Result<Script> {
    transfer_code_script(ft_code, FtCodeReceiver::Hash160(pool_code_hash160))
}

pub fn ftlp_code(
    pool_code_hash: [u8; 32],
    owner: &Address,
    params: &FtlpCodeParams,
) -> Result<Script> {
    let template = if params.ft_version == FtScriptVersion::V4 {
        FTLP_CODE_TEMPLATE
    } else {
        FTLP_V3_CODE_TEMPLATE
    };
    build_ftlp_code(template, pool_code_hash, owner, params, false)
}

pub fn ftlp_lock_time_code(
    pool_code_hash: [u8; 32],
    owner: &Address,
    params: &FtlpCodeParams,
) -> Result<Script> {
    let template = if params.ft_version == FtScriptVersion::V4 {
        FTLP_LOCK_TIME_CODE_TEMPLATE
    } else {
        FTLP_V3_LOCK_TIME_CODE_TEMPLATE
    };
    build_ftlp_code(template, pool_code_hash, owner, params, true)
}

/// Replaces the owner encoded in a released FTLP Code script.
///
/// FTLP carries the same 21-byte receiver payload as FT Code, but uses its
/// own `\x02Code` marker.  It cannot therefore use the generic FT transfer
/// helper, which deliberately accepts only scripts ending in `2Code`.
pub fn transfer_ftlp_code_script(code_script: &Script, receiver: &Address) -> Result<Script> {
    let mut bytes = code_script.as_bytes().to_vec();
    let marker_start = bytes
        .len()
        .checked_sub(FTLP_CODE_MARKER.len())
        .ok_or_else(|| Error::InvalidScript("FTLP code script is too short".to_string()))?;
    if bytes.get(marker_start..) != Some(FTLP_CODE_MARKER) {
        return Err(Error::InvalidScript(
            "FTLP code script must end with \\x02Code marker".to_string(),
        ));
    }
    let hash_push_start = marker_start.checked_sub(23).ok_or_else(|| {
        Error::InvalidScript("FTLP code script missing receiver hash chunk".to_string())
    })?;
    if bytes.get(hash_push_start) != Some(&0x15)
        || bytes.get(marker_start - 1) != Some(&(FTLP_CODE_MARKER.len() as u8))
    {
        return Err(Error::InvalidScript(
            "FTLP code script receiver chunk must be 21 bytes before \\x02Code marker".to_string(),
        ));
    }
    let mut receiver_bytes = [0u8; 21];
    receiver_bytes[..20].copy_from_slice(&receiver.hash160());
    bytes[hash_push_start + 1..hash_push_start + 22].copy_from_slice(&receiver_bytes);
    Ok(Script::from_bytes(bytes))
}

pub fn ftlp_tape(params: &FtlpTapeParams<'_>) -> Result<Script> {
    let mut amount = Vec::with_capacity(48);
    amount.extend_from_slice(&params.amount_raw.to_le_bytes());
    amount.resize(48, 0);

    let script = match params.layout {
        FtlpTapeLayout::Standard {
            decimal,
            name,
            symbol,
            is_coin,
        } => {
            if decimal > 18 {
                return Err(script_error("FTLP decimal cannot exceed 18"));
            }
            let mut chunks = vec![
                amount,
                vec![decimal],
                name.as_bytes().to_vec(),
                symbol.as_bytes().to_vec(),
            ];
            if is_coin {
                chunks.push(vec![0; 4]);
            }
            chunks.push(FTAPE_MARKER.to_vec());
            Script::op_return(&chunks)
        }
        FtlpTapeLayout::LockTime {
            lock_time,
            source_ft_tape_size,
        } => {
            if source_ft_tape_size < LOCK_TIME_TAPE_FIXED_BYTES {
                return Err(script_error(format!(
                    "source FT tape must be at least {LOCK_TIME_TAPE_FIXED_BYTES} bytes"
                )));
            }
            let zero_chunks = source_ft_tape_size - LOCK_TIME_TAPE_FIXED_BYTES;
            let mut chunks = Vec::with_capacity(zero_chunks + 3);
            chunks.push(amount);
            chunks.push(lock_time.to_le_bytes().to_vec());
            chunks.resize_with(zero_chunks + 2, Vec::new);
            chunks.push(FTAPE_MARKER.to_vec());
            let script = Script::op_return(&chunks);
            if script.as_bytes().len() != source_ft_tape_size {
                return Err(script_error(format!(
                    "lock-time FTLP tape is {} bytes, expected source FT tape size {source_ft_tape_size}",
                    script.as_bytes().len()
                )));
            }
            script
        }
    };
    validate_code_marker(&script, FTAPE_MARKER, "FTLP Tape")?;
    Ok(script)
}

struct CommonPoolSubstitutions {
    outpoint_hex: String,
    ft_code_size: &'static str,
    pump_hash_hex: String,
    tag_length_hex: String,
    tag_hex: String,
}

fn common_pool_substitutions(
    source: &OutPoint,
    tag: &[u8],
    params: &PoolCodeParams,
) -> Result<CommonPoolSubstitutions> {
    validate_lp_plan(params.lp_plan)?;
    if !tag.is_ascii() {
        return Err(script_error(
            "Pool service-provider tag must be ASCII: released JS 1.6.5 counts UTF-16 code units but serializes UTF-8 bytes, making non-ASCII tag lengths ambiguous",
        ));
    }
    let tag = if tag.is_empty() {
        b"NULL".as_slice()
    } else {
        tag
    };
    if tag.len() > MAX_DIRECT_TAG_BYTES {
        return Err(script_error(format!(
            "Pool tag exceeds the released direct-push limit of {MAX_DIRECT_TAG_BYTES} bytes"
        )));
    }

    let mut outpoint = Vec::with_capacity(36);
    source.serialize(&mut outpoint);
    let service_address =
        Address::from_string(SERVICE_FEE_ADDRESSES[usize::from(params.lp_plan - 1)])?;
    Ok(CommonPoolSubstitutions {
        outpoint_hex: hex::encode(outpoint),
        ft_code_size: ft_code_size(params),
        pump_hash_hex: hex::encode(service_address.hash160()),
        tag_length_hex: format!("{:02x}", tag.len()),
        tag_hex: hex::encode(tag),
    })
}

fn validate_lp_plan(lp_plan: u8) -> Result<()> {
    if !(1..=6).contains(&lp_plan) {
        return Err(script_error("Pool LP plan must be in 1..=6"));
    }
    Ok(())
}

fn ft_code_size(params: &PoolCodeParams) -> &'static str {
    if params.ft_version == FtScriptVersion::V4 {
        "1c08"
    } else if params.is_coin {
        "dc07"
    } else if params.ft_version == FtScriptVersion::V1 {
        "1c06"
    } else {
        "5c07"
    }
}

fn validate_tape_size(tape_size: usize) -> Result<()> {
    if tape_size == 0 || tape_size > u8::MAX as usize {
        return Err(script_error(
            "FTLP tape size must fit the released one-byte getSize encoding",
        ));
    }
    Ok(())
}

fn build_ftlp_code(
    template: &str,
    pool_code_hash: [u8; 32],
    owner: &Address,
    params: &FtlpCodeParams,
    _with_lock_time: bool,
) -> Result<Script> {
    validate_tape_size(params.tape_size)?;
    let tape_size_hex = format!("{:02x}", params.tape_size);
    let code_hash = hex::encode(pool_code_hash);
    let replacements = vec![
        ("${codeHash}", code_hash.as_str(), 1usize),
        ("${tapeSizeHex}", tape_size_hex.as_str(), 16usize),
    ];
    let mut pre = substitute_template(template, &replacements)?;
    if !matches!(params.ft_version, FtScriptVersion::V3 | FtScriptVersion::V4) {
        pre = to_legacy_ftlp_code_pre(pre)?;
    }
    let pre_script = script_from_released_asm(&pre)?;
    let target_length: usize = if params.ft_version == FtScriptVersion::V4 {
        2_076
    } else if params.is_coin {
        2_012
    } else if params.ft_version == FtScriptVersion::V1 {
        1_564
    } else {
        1_884
    };
    let use_pushdata2 = params.is_coin || params.ft_version != FtScriptVersion::V1;
    let overhead = if use_pushdata2 { 33 } else { 32 };
    let padding_size = target_length
        .checked_sub(pre_script.as_bytes().len() + overhead)
        .ok_or_else(|| script_error("FTLP template exceeds target FT code length"))?;
    let push_prefix = if use_pushdata2 {
        let size =
            u16::try_from(padding_size).map_err(|_| script_error("FTLP padding exceeds uint16"))?;
        let [low, high] = size.to_le_bytes();
        vec![crate::script::opcodes::OP_PUSHDATA2, low, high]
    } else {
        let size = u8::try_from(padding_size)
            .map_err(|_| script_error("FTLP v1 padding exceeds uint8"))?;
        vec![crate::script::opcodes::OP_PUSHDATA1, size]
    };
    let mut bytes = pre_script.into_bytes();
    bytes.extend_from_slice(&push_prefix);
    bytes.resize(bytes.len() + padding_size, 0xff);
    bytes.push(crate::script::opcodes::OP_DROP);
    bytes.push(crate::script::opcodes::OP_RETURN);
    bytes.push(0x15);
    bytes.extend_from_slice(owner.hash160().as_slice());
    bytes.push(0x00);
    bytes.push(FTLP_CODE_MARKER.len() as u8);
    bytes.extend_from_slice(FTLP_CODE_MARKER);
    let script = Script::from_bytes(bytes);
    validate_code_marker(&script, FTLP_CODE_MARKER, "FTLP")?;
    Ok(script)
}

fn to_legacy_ftlp_code_pre(mut source: String) -> Result<String> {
    source = replace_fragment(
        source,
        "OP_0 OP_TOALTSTACK OP_DUP OP_0 OP_EQUAL",
        "OP_DUP OP_0 OP_EQUAL",
        1,
    )?;
    for slot in ["5", "4", "3", "2", "1", "0"] {
        source = replace_fragment(
            source,
            &format!(
                "OP_FROMALTSTACK OP_1ADD OP_FROMALTSTACK OP_DUP OP_{slot} 0x01 0x28 OP_MUL OP_SPLIT 0x01 0x20 OP_SPLIT OP_DROP OP_TOALTSTACK OP_DROP OP_TOALTSTACK OP_TOALTSTACK OP_ENDIF"
            ),
            &format!(
                "OP_FROMALTSTACK OP_DUP OP_{slot} 0x01 0x28 OP_MUL OP_SPLIT 0x01 0x20 OP_SPLIT OP_DROP OP_TOALTSTACK OP_DROP OP_TOALTSTACK OP_ENDIF"
            ),
            1,
        )?;
    }
    source = replace_fragment(
        source,
        "OP_ADD OP_FROMALTSTACK OP_FROMALTSTACK OP_DROP OP_TOALTSTACK OP_TOALTSTACK OP_DROP OP_TOALTSTACK",
        "OP_ADD OP_FROMALTSTACK OP_DROP OP_TOALTSTACK OP_DROP OP_TOALTSTACK",
        1,
    )?;
    source = replace_fragment(
        source,
        "OP_HASH256 OP_FROMALTSTACK OP_FROMALTSTACK OP_FROMALTSTACK OP_FROMALTSTACK OP_SWAP OP_1SUB OP_TOALTSTACK OP_SWAP OP_TOALTSTACK OP_SWAP OP_TOALTSTACK OP_EQUALVERIFY",
        "OP_HASH256 OP_FROMALTSTACK OP_FROMALTSTACK OP_FROMALTSTACK OP_SWAP OP_TOALTSTACK OP_SWAP OP_TOALTSTACK OP_EQUALVERIFY",
        6,
    )?;
    replace_fragment(
        source,
        "OP_7 OP_EQUALVERIFY OP_FROMALTSTACK OP_FROMALTSTACK OP_FROMALTSTACK OP_0 OP_EQUALVERIFY OP_SWAP OP_TOALTSTACK",
        "OP_7 OP_EQUALVERIFY OP_FROMALTSTACK OP_FROMALTSTACK OP_SWAP OP_TOALTSTACK",
        1,
    )
}

fn replace_fragment(
    source: String,
    old: &str,
    replacement: &str,
    expected: usize,
) -> Result<String> {
    let actual = source.matches(old).count();
    if actual != expected {
        return Err(script_error(format!(
            "expected {expected} occurrences of released FTLP fragment, found {actual}"
        )));
    }
    Ok(source.replace(old, replacement))
}

fn substitute_template(template: &str, substitutions: &[(&str, &str, usize)]) -> Result<String> {
    let mut seen = HashSet::new();
    let mut output = template.to_string();
    for &(token, value, expected) in substitutions {
        if token.is_empty() || !seen.insert(token) {
            return Err(script_error(format!(
                "template substitution token {token:?} is missing or duplicated"
            )));
        }
        if value.contains("${") {
            return Err(script_error(format!(
                "template value for {token} contains an unresolved token"
            )));
        }
        let actual = output.matches(token).count();
        if actual != expected {
            return Err(script_error(format!(
                "template token {token} expected {expected} occurrences, found {actual}"
            )));
        }
        output = output.replace(token, value);
    }
    if let Some(start) = output.find("${") {
        let tail = &output[start..output.len().min(start + 64)];
        return Err(script_error(format!(
            "template contains an unreplaced token near {tail:?}"
        )));
    }
    Ok(output)
}

fn script_from_released_asm(asm: &str) -> Result<Script> {
    let normalized = asm
        .split_whitespace()
        .map(|token| match token {
            // These opcodes are present in released Pool assets but the
            // crate-wide generic ASM helper intentionally has a smaller set.
            "OP_2DUP" => "0x6e",
            "OP_GREATERTHAN" => "0xa0",
            "OP_GREATERTHANOREQUAL" => "0xa2",
            "OP_TRUE" => "OP_1",
            _ => token,
        })
        .collect::<Vec<_>>()
        .join(" ");
    Script::from_asm(&normalized)
}

fn validate_code_marker(script: &Script, marker: &[u8], name: &str) -> Result<()> {
    if !script.as_bytes().ends_with(marker) {
        return Err(script_error(format!("{name} script marker is missing")));
    }
    Ok(())
}

fn script_error(message: impl Into<String>) -> Error {
    Error::InvalidScript(format!("Pool NFT v2: {}", message.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_template_substitution_rejects_missing_duplicate_and_unreplaced_tokens() {
        assert!(substitute_template("prefix", &[("${token}", "aa", 1)]).is_err());
        assert!(
            substitute_template("${token}", &[("${token}", "aa", 1), ("${token}", "bb", 1)],)
                .is_err()
        );
        assert!(substitute_template("${token} ${unknown}", &[("${token}", "aa", 1)]).is_err());
        assert!(substitute_template("${token} ${token}", &[("${token}", "aa", 1)]).is_err());
        assert_eq!(
            substitute_template("${token} ${token}", &[("${token}", "aa", 2)]).unwrap(),
            "aa aa"
        );
    }

    #[test]
    fn ftlp_transfer_updates_its_distinct_receiver_marker() {
        let first = crate::PrivateKey::from_slice(&[31; 32]).unwrap();
        let second = crate::PrivateKey::from_slice(&[32; 32]).unwrap();
        let params = FtlpCodeParams {
            tape_size: 81,
            ft_version: FtScriptVersion::V2,
            is_coin: false,
        };
        let code = ftlp_code([0x55; 32], &first.address(), &params).unwrap();
        let updated = transfer_ftlp_code_script(&code, &second.address()).unwrap();
        assert_eq!(
            updated,
            ftlp_code([0x55; 32], &second.address(), &params).unwrap()
        );
    }
}

#[cfg(test)]
mod fixture_tests {
    use serde::Deserialize;
    use sha2::{Digest, Sha256};

    use crate::{Address, OutPoint, PrivateKey, PublicKey, Txid};

    use crate::contracts::pool_nft_v2::{PoolAmounts, PoolState};

    use super::{
        FtScriptVersion, FtlpCodeParams, FtlpTapeLayout, FtlpTapeParams, LockedPoolCodeParams,
        PoolCodeParams, ftlp_code, ftlp_lock_time_code, ftlp_tape, locked_pool_code, pool_code,
        pool_code_source_outpoint, pool_held_ft_code, pool_tape,
    };

    const JS_165_FIXTURE: &str = include_str!("../../../tests/fixtures/pool-v2-js-165.json");

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct JsFixture {
        contract_name: String,
        contract_version: String,
        contract_commit: String,
        tbc_lib_version: String,
        source_fingerprints: Vec<SourceFingerprint>,
        source_txid: String,
        source_vout: u32,
        tag_hex: String,
        owner_hash160: String,
        lp_cost_hash160: String,
        lp_cost_sat: u64,
        ft_tape_size: usize,
        ft_name: String,
        ft_symbol: String,
        public_keys: Vec<String>,
        ft_code_hex: String,
        pool_code_hash: String,
        state: StateFixture,
        scripts: ScriptsFixture,
    }

    #[derive(Clone, Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SourceFingerprint {
        component: String,
        path: String,
        sha256: String,
    }

    const EXPECTED_SOURCE_FINGERPRINTS: &[(&str, &str, &str)] = &[
        (
            "tbc-contract",
            "package.json",
            "f73d7e15985eff6a3ad052f151e9880113a0935caf6ef7b3e056c9d85f4a4182",
        ),
        (
            "tbc-contract",
            "package-lock.json",
            "76f8d1d2643341329d6f70c5a2daa5d7a3148fe53482f219db8f655ecd6ba941",
        ),
        (
            "tbc-contract",
            "lib/contract/ft.js",
            "e8187c94694becaae85788eab0c529838e3e10119782ade4eb5599ed9622b100",
        ),
        (
            "tbc-contract",
            "lib/contract/poolNFT2.0.js",
            "ee05cab9f90e99203e3c893fa2729cb840cf22da11a4ea76157a88a7cf9c18db",
        ),
        (
            "tbc-contract",
            "lib/util/ftunlock.js",
            "731bd16b7ca8d657c897365d514c027bdc3c189dad8e4892c54de028ecc8633d",
        ),
        (
            "tbc-contract",
            "lib/util/poolnftunlock.js",
            "85ae94ec9dfeb22616b69caccbeabce248f7954990ed9501e4f0e64f2da4109b",
        ),
        (
            "tbc-contract",
            "lib/util/util.js",
            "dce905f646f7e2f99a54fb7518b5e18ca414487040ae0aec2c981560441696b2",
        ),
        (
            "tbc-lib-js",
            "package.json",
            "4a193a2bdb50f00f8617d18257ac25aa3bf69e2b7fc29a307c5055af6aadca6e",
        ),
        (
            "tbc-lib-js",
            "lib/address.js",
            "263ab3d2e8968d2b6af365a2b0ba008f85e27194652745a829d791bd4d1c16fc",
        ),
        (
            "tbc-lib-js",
            "lib/bn.js",
            "81f2a08a2921161d755f4f04cab0e1cbfe727f59988391bb6d71c16a0c3c5a39",
        ),
        (
            "tbc-lib-js",
            "lib/crypto/bn.js",
            "df858647b82e9fd68be1614ed1d4b816610f94ce6e55782593d8e58e9083734e",
        ),
        (
            "tbc-lib-js",
            "lib/crypto/ecdsa.js",
            "a9910c9b149be402d4f59e2f699251e0b62ef18e2da460f9d1e44a21fe9a6ce7",
        ),
        (
            "tbc-lib-js",
            "lib/crypto/hash.js",
            "d22d2e725e3a0a305d1c3e5e5b9c5bd9d19a668b7632b27e7b12fe74cdd2e6af",
        ),
        (
            "tbc-lib-js",
            "lib/crypto/hash.node.js",
            "92a9b829ecb8142141040b6bbb9aad02597eef2c61d6d09f4be56756cfe45c5d",
        ),
        (
            "tbc-lib-js",
            "lib/crypto/point.js",
            "a262d25b4a46273a7c21a5282b714d611f1ce89686c75383fe6a883f321cae52",
        ),
        (
            "tbc-lib-js",
            "lib/crypto/random.js",
            "d72536fff55522e9138a18a3f09a0b011d8addabd3258990d865f3d4ec29fe4c",
        ),
        (
            "tbc-lib-js",
            "lib/crypto/schnorr.js",
            "e98c28344450ce1b41253a24293d2fed3dde929accc8cc3c8f12f03f9c9ea42c",
        ),
        (
            "tbc-lib-js",
            "lib/crypto/signature.js",
            "c125df5eb3643a8fba245c6c62759b107dee2168580b8ee75417bfbd2725b345",
        ),
        (
            "tbc-lib-js",
            "lib/encoding/base58.js",
            "ffff06c89f6d0f30b9428552013860dba538d970969cba9be5acafd34681c4b6",
        ),
        (
            "tbc-lib-js",
            "lib/encoding/base58check.js",
            "0db4aae7784a2c3494852ee2cb0f2d938dd594259fe6efcfe334b50b9f0d7c52",
        ),
        (
            "tbc-lib-js",
            "lib/encoding/bufferreader.js",
            "90243797831dcaf8ea81bd782fcdefd2d0d87c787c2453a734615d1632a762d6",
        ),
        (
            "tbc-lib-js",
            "lib/encoding/bufferwriter.js",
            "55fb2e907df2c965315e0a78c528b0653e6f13acaa588d0a71096050237f0292",
        ),
        (
            "tbc-lib-js",
            "lib/encoding/decode-asm.js",
            "1c75727ac9b3436abced3a753ae863749c4cf61721afdade82b0051f422a92ac",
        ),
        (
            "tbc-lib-js",
            "lib/encoding/decode-hex.js",
            "54d4544432761883bb25748e302b42eadeb9e834cf0ce65cd7e20e0ea04328e6",
        ),
        (
            "tbc-lib-js",
            "lib/encoding/decode-script-chunks.js",
            "b6cf9813da32890103ecd08ba4c565b3d536285600e4b8157ff045fcdad1fff2",
        ),
        (
            "tbc-lib-js",
            "lib/encoding/encode-hex.js",
            "97594bfbfac7c8810ecc8c00ce2c7d30a85d0e81f7c5b2ff9041f09498f37c81",
        ),
        (
            "tbc-lib-js",
            "lib/encoding/is-hex.js",
            "bdbb989e83d54541470439e8baa933441bcc0a6582ef575d2afdace9049f6e28",
        ),
        (
            "tbc-lib-js",
            "lib/encoding/varint.js",
            "372a131017ca0f191cf8e1a2f8a1997b32c289b299b71f93c2e09a06ce72940f",
        ),
        (
            "tbc-lib-js",
            "lib/errors/index.js",
            "7c86c3564fb41a6515746ebb0d5e118d3b2f0a69018c1d7853c8245c1776022e",
        ),
        (
            "tbc-lib-js",
            "lib/errors/spec.js",
            "a0bbadbe22eb2d49d36efa91e493c10f0680a662785148185e3cd831c5e6cc62",
        ),
        (
            "tbc-lib-js",
            "lib/hash-cache.js",
            "0790d3bacc2079094edf9631774bdd7791e617fa76558c3e710d2fef8f051be9",
        ),
        (
            "tbc-lib-js",
            "lib/networks.js",
            "f828f6b818d3030b56929bde34b38b389a15576aaaa48e5a25a44d43b0db37a3",
        ),
        (
            "tbc-lib-js",
            "lib/opcode.js",
            "fa28081bd76a3064cc19dbc7e7820568e1dab0e8a604e55ba75bdba8596063b1",
        ),
        (
            "tbc-lib-js",
            "lib/privatekey.js",
            "400a438f18f6626e1138d0cf42f3f0a3874bf49162f4f941580afc335fc45f96",
        ),
        (
            "tbc-lib-js",
            "lib/publickey.js",
            "f40e9b80af5acff0c4ef4b9a15cacf88d182c54226c1c0b7be36e0d5b8abbdd6",
        ),
        (
            "tbc-lib-js",
            "lib/script/index.js",
            "b0762233b6c2f5449f310df35861c70df5d18456a19bf4a4a146db2c7e73b638",
        ),
        (
            "tbc-lib-js",
            "lib/script/interpreter.js",
            "38d172b13946b1c30de034a852616f732f80b91dad029aa232f654e6874092eb",
        ),
        (
            "tbc-lib-js",
            "lib/script/script.js",
            "1af78ec395c8a06b85c9ba1aba32441bfa710a2f016639a97230cc6a298d6552",
        ),
        (
            "tbc-lib-js",
            "lib/script/stack.js",
            "0308ff54a8cc50a78bde49359a6f613f44f8baec3097eb20f0f04ebfb8e5278d",
        ),
        (
            "tbc-lib-js",
            "lib/script/write-i32-le.js",
            "f0c06cda81fa67a2847b66349d9aa751b84e8ec9e31a48f22fc0b8c6d969e23a",
        ),
        (
            "tbc-lib-js",
            "lib/script/write-push-data.js",
            "daad2018d6d6d30a2181ee059629fe269ba7c4a18b387c302ef58fcc77fc4c3b",
        ),
        (
            "tbc-lib-js",
            "lib/script/write-u8-le.js",
            "c83b0a1a8acbfc5afd1a38ba4838a852ee4957cc3aaa99a022fc6424a9ad16df",
        ),
        (
            "tbc-lib-js",
            "lib/script/write-varint.js",
            "383e5ac95553e56de158a108f39f47c7b242f49d212ac058b0571e214de2358c",
        ),
        (
            "tbc-lib-js",
            "lib/script/write-u16-le.js",
            "3ce5f7b433f67e9ef1928d4dc9d1db021f7864f1675ca2b2880e2af6a02a335e",
        ),
        (
            "tbc-lib-js",
            "lib/script/write-u32-le.js",
            "b7f41683195fce115d0fa13e0b0fe79b783e242b529d96536e6e52725c7c5a35",
        ),
        (
            "tbc-lib-js",
            "lib/transaction/index.js",
            "3ff97c4861890b7eb6e7336448be88badd19b155742366bc9ed6deeb12fef6da",
        ),
        (
            "tbc-lib-js",
            "lib/transaction/input/index.js",
            "9ff44034ee13a5ba57f19e8f297cc2cde6620bae039a16e1fb5ebdd7e5a3603f",
        ),
        (
            "tbc-lib-js",
            "lib/transaction/input/input.js",
            "7a9b94e59d4dd7fdb8d57bfae24cc93f13879ea7bee5924cc98b0ff82831a153",
        ),
        (
            "tbc-lib-js",
            "lib/transaction/input/multisig.js",
            "fa2def4de1bc688609745793601c59cdac27341094e1e36eced7380348ef324a",
        ),
        (
            "tbc-lib-js",
            "lib/transaction/input/multisigscripthash.js",
            "08accc4a1f4e9161c8a7e56385b5378c617a17f34b0602a246f7263980c8f36e",
        ),
        (
            "tbc-lib-js",
            "lib/transaction/input/publickey.js",
            "fd7abaa3a542f77e912a92f294296d8843970c57bb54ce519bfabe5c2251f3ca",
        ),
        (
            "tbc-lib-js",
            "lib/transaction/input/publickeyhash.js",
            "24699915502250c8f73cc80d68e2d31198c197b1fb9895dc88b9b84359be9616",
        ),
        (
            "tbc-lib-js",
            "lib/transaction/output.js",
            "116afcad202d474fee41ae35a4f9aea77302c8a9cf34ce568ffe2918cde42929",
        ),
        (
            "tbc-lib-js",
            "lib/transaction/sighash.js",
            "d75ca238130044017a187742e5ebc0830985bed945a027ffdb11afec6df18181",
        ),
        (
            "tbc-lib-js",
            "lib/transaction/signature.js",
            "61ff00ace715175f785028f0f48032e4dddf4cfcedf44cef5f62c1797826a2e9",
        ),
        (
            "tbc-lib-js",
            "lib/transaction/transaction.js",
            "3e0d282d9ba80d7424edec33126b645ff9fcd6387c0d3baddb469465632a9325",
        ),
        (
            "tbc-lib-js",
            "lib/transaction/unspentoutput.js",
            "db9672d88d2e92b138ff8dc055c13b3f1d928ada6066338626a9043966818d71",
        ),
        (
            "tbc-lib-js",
            "lib/util/_.js",
            "92b83046cd3d75fc0330cd8ef4a953ccbb1e92534d263ffe4fb5124e839620f5",
        ),
        (
            "tbc-lib-js",
            "lib/util/js.js",
            "7a7859e69947f064d786bb72bb3406c8d7d01862d03a02d350106ba93131dfbf",
        ),
        (
            "tbc-lib-js",
            "lib/util/partial-sha256.js",
            "484f8dff255eb1799895ef40fa95ef2d48434e94e192265a31ad969eafe7855b",
        ),
        (
            "tbc-lib-js",
            "lib/util/preconditions.js",
            "89b03f2af08656ee47b6ef59ebfe091e5b93a083b9952e2c8f353fadb196e373",
        ),
        (
            "elliptic",
            "lib/elliptic/utils.js",
            "3eb8452d1321ec02862fe00a6afa69b12e6ef7d6633108919f1d4f3b069be90b",
        ),
        (
            "elliptic",
            "lib/elliptic/curve/base.js",
            "14aeb577b6509519d50c2c3f6c17faeef3e29d4fe126c8b60435f547fa76a2f5",
        ),
        (
            "elliptic",
            "lib/elliptic/curve/short.js",
            "ff57ccea34340311c170dbfc2d249a261590deda75f8c586e5f3d7d679b79890",
        ),
        (
            "elliptic",
            "lib/elliptic/curves.js",
            "7b2955d3137649d603d890e25e96d199148a93255e98ea9a495bdb4f1f0ffdf1",
        ),
        (
            "elliptic",
            "lib/elliptic/ec/index.js",
            "668741c0c921bf5174439104e8fd20636578373cbbd28736ccbcd8e59a5aeafc",
        ),
        (
            "elliptic",
            "lib/elliptic/ec/key.js",
            "08183de5864bcf40879a9f4fb3f0b3d3b30b557352457c98de8aab2de29396df",
        ),
        (
            "elliptic",
            "lib/elliptic/ec/signature.js",
            "e22eb27aa99f94f09f07446779a63ddddcc0023a248ce8040e8acd17ae748e72",
        ),
        (
            "elliptic",
            "lib/elliptic/precomputed/secp256k1.js",
            "9e383365793650467605de197cdb71e09c22ebcdc02c5336873412c14c81bac7",
        ),
        (
            "elliptic-inherits",
            "inherits.js",
            "bb380f32bef5feb18678f0f45f88073fed5d7a0069a309132cb2080cd553d5c7",
        ),
        (
            "bn.js",
            "lib/bn.js",
            "e89de863ba8e6708beba85ad616bd4f067481d485ae2334e6d4b574671886dfc",
        ),
        (
            "brorand",
            "index.js",
            "3deb9a82f06f1add80673ea960f409fb3d456bf9e74192ecfde453f0b56d9ee4",
        ),
        (
            "hash.js",
            "lib/hash.js",
            "2c2b7f9979522553acf1722b8d046f280a6364a6ceab10323ababf79247830ef",
        ),
        (
            "hash.js",
            "lib/hash/common.js",
            "e7f0b5c30a4fd0630cef07f95c54c96375c11a4666c77e5552251d6fa1409ef3",
        ),
        (
            "hash.js",
            "lib/hash/hmac.js",
            "88f1981433aa7bd1d53628ecec6dcb0dcaf72fba02b839398902dfea14e346ad",
        ),
        (
            "hash.js",
            "lib/hash/ripemd.js",
            "3f4884df0b5b47b4ba3d8170de1b61b1a0411da3cec3769f6c6eda523ef7e5d4",
        ),
        (
            "hash.js",
            "lib/hash/sha.js",
            "304f42a7945c5721bae922599e5a6e83fc47fdac08d540a15ad01fffa37ed161",
        ),
        (
            "hash.js",
            "lib/hash/sha/1.js",
            "122290d248cdb95b0d8e272a7bc0d273cae6cd647a69cd5bca44aa29f1030da4",
        ),
        (
            "hash.js",
            "lib/hash/sha/224.js",
            "b9479b26609538edca7a0a8631413fc15ceaf72777c4c2c0048489bd794f9aec",
        ),
        (
            "hash.js",
            "lib/hash/sha/256.js",
            "1a7ad8ed3c9f3ffa9c40097dcac66eae788c34a1210cbb70c7efbee7c1c07635",
        ),
        (
            "hash.js",
            "lib/hash/sha/384.js",
            "9e3230ff7f6dfce3f490156dc71bf99b3fa32a3d4c94b0166d13b5f0e2d769ca",
        ),
        (
            "hash.js",
            "lib/hash/sha/512.js",
            "bccd07a74dae7a719c9da801da393970bdb7ad999a0a61bf306cad5f400ca63a",
        ),
        (
            "hash.js",
            "lib/hash/sha/common.js",
            "28c0b8add8bc208930f5f9ca6e30844bc6d7eba06700e4fa04adc79d26807185",
        ),
        (
            "hash.js",
            "lib/hash/utils.js",
            "a4ca67e804ab52b5459c9c3e5e966043d53fc519213738d00c1de9e4d4d6a6e1",
        ),
        (
            "hmac-drbg",
            "lib/hmac-drbg.js",
            "5b89c7d8147fbba4c89d686d8ea08cd350d77eb994bf9a41e3904a3ffe7e6161",
        ),
        (
            "inherits",
            "inherits.js",
            "7af9a5f76c00f72bed44b83824a8acd67febcfd3d34fd293c20c35aa7e6657f6",
        ),
        (
            "minimalistic-assert",
            "index.js",
            "c62009724a28986193befd6b7746ea8f8a96fef1ac64df78fe3e4b05a8ffeeb2",
        ),
        (
            "minimalistic-crypto-utils",
            "lib/utils.js",
            "fb5bcdfa3631a0ac40a83911d696ddc4e615f38a2cca560600fc0101479af727",
        ),
        (
            "bs58",
            "index.js",
            "0cfcec7b298a0c33588b432fad41e2fba216336d34ffd8c13422d21d3134ab57",
        ),
        (
            "base-x",
            "src/index.js",
            "eaf1b7363a6a3144f0297786c8dc8ae6b84c2b43e096c0b009ab31d8d599a274",
        ),
        (
            "safe-buffer",
            "index.js",
            "184d5c4a83512e3f49d4d5b52f7073f601f933bad11f1fbb3ad364ca5e6478e1",
        ),
        (
            "tbc-sdk",
            "scripts/pool-v2-js-165-dependencies.js",
            "1db57011bd469e7384cdde1bcdd632ff598982c1edb5e5521957a0d397a2d374",
        ),
    ];

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct StateFixture {
        ft_lp_raw: u64,
        ft_a_raw: u64,
        tbc_sat: u64,
        ft_lp_partial_hash: String,
        ft_a_partial_hash: String,
        ft_a_contract_id: String,
        service_fee_rate: u16,
        lp_plan: u8,
        public_key_locked: bool,
        ftlp_lock_time_enabled: bool,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ScriptsFixture {
        standard_pool: ScriptFixture,
        locked_pool_one_key: ScriptFixture,
        locked_pool_two_keys: ScriptFixture,
        locked_pool_three_keys: ScriptFixture,
        locked_pool_ten_keys: ScriptFixture,
        current_ftlp: ScriptFixture,
        lock_time_ftlp: ScriptFixture,
        legacy_v2_ftlp: ScriptFixture,
        legacy_v2_lock_time_ftlp: ScriptFixture,
        pool_tape: ScriptFixture,
        pool_held_ft: ScriptFixture,
        ftlp_tape: ScriptFixture,
        ftlp_lock_time_tape: ScriptFixture,
    }

    #[derive(Debug, Deserialize)]
    struct ScriptFixture {
        hex: String,
        length: usize,
        sha256: String,
    }

    fn fixture() -> JsFixture {
        serde_json::from_str(JS_165_FIXTURE).unwrap()
    }

    fn source_fingerprints_match_expected(actual: &[SourceFingerprint]) -> bool {
        actual
            .iter()
            .map(|source| {
                (
                    source.component.as_str(),
                    source.path.as_str(),
                    source.sha256.as_str(),
                )
            })
            .eq(EXPECTED_SOURCE_FINGERPRINTS.iter().copied())
    }

    fn source(fixture: &JsFixture) -> OutPoint {
        OutPoint {
            txid: fixture.source_txid.parse::<Txid>().unwrap(),
            vout: fixture.source_vout,
        }
    }

    fn public_keys(fixture: &JsFixture) -> Vec<PublicKey> {
        fixture
            .public_keys
            .iter()
            .map(|key| PublicKey::from_slice(&hex::decode(key).unwrap()).unwrap())
            .collect()
    }

    fn assert_script(actual: &crate::script::Script, expected: &ScriptFixture) {
        assert_eq!(hex::encode(actual.as_bytes()), expected.hex);
        assert_eq!(actual.as_bytes().len(), expected.length);
        assert_eq!(
            hex::encode(Sha256::digest(actual.as_bytes())),
            expected.sha256
        );
    }

    fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }

    #[test]
    fn pool_v2_js_165_assets_remain_parseable_and_non_pool_outputs_match() {
        let fixture = fixture();
        assert_eq!(fixture.contract_name, "tbc-contract");
        assert_eq!(fixture.contract_version, "1.6.5");
        assert_eq!(
            fixture.contract_commit,
            "19acaa0e279c39741c9957e1236b3eac9ff4154a"
        );
        assert_eq!(fixture.tbc_lib_version, "1.0.31");
        assert!(
            source_fingerprints_match_expected(&fixture.source_fingerprints),
            "fixture source authority must equal the complete fixed (component, path, sha256) table"
        );

        let tag = hex::decode(&fixture.tag_hex).unwrap();
        let keys = public_keys(&fixture);
        let pool_params = PoolCodeParams {
            lp_plan: 1,
            ft_version: FtScriptVersion::V3,
            is_coin: false,
        };
        let standard_pool = pool_code(source(&fixture), &tag, &pool_params).unwrap();
        assert_eq!(
            pool_code_source_outpoint(&standard_pool).unwrap(),
            source(&fixture)
        );
        let legacy_standard = crate::script::Script::from_bytes(
            hex::decode(&fixture.scripts.standard_pool.hex).unwrap(),
        );
        assert_eq!(
            pool_code_source_outpoint(&legacy_standard).unwrap(),
            source(&fixture)
        );
        let mut serialized_source = Vec::new();
        source(&fixture).serialize(&mut serialized_source);
        assert!(contains_bytes(standard_pool.as_bytes(), &serialized_source));
        assert!(
            standard_pool.as_bytes().ends_with(
                &[
                    vec![0x51, 0x6a, tag.len() as u8],
                    tag.clone(),
                    vec![0x05],
                    b"2Code".to_vec()
                ]
                .concat()
            )
        );
        let locked_params = LockedPoolCodeParams {
            pool: pool_params,
            lp_cost_address: Address::from_hash160(
                hex::decode(&fixture.lp_cost_hash160)
                    .unwrap()
                    .try_into()
                    .unwrap(),
            ),
            lp_cost_sat: fixture.lp_cost_sat,
        };
        assert!(locked_pool_code(source(&fixture), &tag, &keys[..1], &locked_params).is_ok());
        assert!(locked_pool_code(source(&fixture), &tag, &keys[..2], &locked_params).is_ok());
        let locked_three =
            locked_pool_code(source(&fixture), &tag, &keys[..3], &locked_params).unwrap();
        assert!(locked_pool_code(source(&fixture), &tag, &keys[..10], &locked_params).is_ok());
        assert!(contains_bytes(
            locked_three.as_bytes(),
            &fixture.lp_cost_sat.to_le_bytes()
        ));
        assert!(contains_bytes(
            locked_three.as_bytes(),
            &hex::decode(&fixture.lp_cost_hash160).unwrap()
        ));
        for key in &keys[..3] {
            assert!(contains_bytes(locked_three.as_bytes(), &key.to_bytes()));
        }

        let pool_hash: [u8; 32] = hex::decode(&fixture.pool_code_hash)
            .unwrap()
            .try_into()
            .unwrap();
        let owner = Address::from_hash160(
            hex::decode(&fixture.owner_hash160)
                .unwrap()
                .try_into()
                .unwrap(),
        );
        let ftlp_params = FtlpCodeParams {
            tape_size: fixture.ft_tape_size,
            ft_version: FtScriptVersion::V3,
            is_coin: false,
        };
        let current_ftlp = ftlp_code(pool_hash, &owner, &ftlp_params).unwrap();
        assert_script(&current_ftlp, &fixture.scripts.current_ftlp);
        assert!(contains_bytes(current_ftlp.as_bytes(), &pool_hash));
        assert!(
            current_ftlp
                .as_bytes()
                .ends_with(&[owner.hash160().to_vec(), vec![0, 5], b"\x02Code".to_vec()].concat())
        );
        assert_script(
            &ftlp_lock_time_code(pool_hash, &owner, &ftlp_params).unwrap(),
            &fixture.scripts.lock_time_ftlp,
        );
        let legacy_v2_params = FtlpCodeParams {
            ft_version: FtScriptVersion::V2,
            ..ftlp_params
        };
        assert_script(
            &ftlp_code(pool_hash, &owner, &legacy_v2_params).unwrap(),
            &fixture.scripts.legacy_v2_ftlp,
        );
        assert_script(
            &ftlp_lock_time_code(pool_hash, &owner, &legacy_v2_params).unwrap(),
            &fixture.scripts.legacy_v2_lock_time_ftlp,
        );

        let state = PoolState {
            amounts: PoolAmounts {
                ft_lp_raw: fixture.state.ft_lp_raw,
                ft_a_raw: fixture.state.ft_a_raw,
                tbc_sat: fixture.state.tbc_sat,
            },
            ft_lp_partial_hash: hex::decode(&fixture.state.ft_lp_partial_hash).unwrap(),
            ft_a_partial_hash: hex::decode(&fixture.state.ft_a_partial_hash).unwrap(),
            ft_a_contract_id: fixture.state.ft_a_contract_id.parse().unwrap(),
            service_fee_rate: fixture.state.service_fee_rate,
            service_provider: "fixture-provider-is-not-serialized".to_string(),
            lp_plan: fixture.state.lp_plan,
            public_key_locked: fixture.state.public_key_locked,
            ftlp_lock_time_enabled: fixture.state.ftlp_lock_time_enabled,
        };
        assert_script(&pool_tape(&state).unwrap(), &fixture.scripts.pool_tape);

        let ft_code = crate::script::Script::from_bytes(hex::decode(&fixture.ft_code_hex).unwrap());
        let pool_held_ft = pool_held_ft_code(&ft_code, [0x55; 20]).unwrap();
        assert_script(&pool_held_ft, &fixture.scripts.pool_held_ft);
        assert!(
            pool_held_ft
                .as_bytes()
                .ends_with(&[vec![0x15], vec![0x55; 20], vec![1, 5], b"2Code".to_vec()].concat())
        );
        assert_script(
            &ftlp_tape(&FtlpTapeParams {
                amount_raw: 42_000_000,
                layout: FtlpTapeLayout::Standard {
                    decimal: 6,
                    name: &fixture.ft_name,
                    symbol: &fixture.ft_symbol,
                    is_coin: false,
                },
            })
            .unwrap(),
            &fixture.scripts.ftlp_tape,
        );
        assert_script(
            &ftlp_tape(&FtlpTapeParams {
                amount_raw: 42_000_000,
                layout: FtlpTapeLayout::LockTime {
                    lock_time: 1_750_000_000,
                    source_ft_tape_size: fixture.ft_tape_size,
                },
            })
            .unwrap(),
            &fixture.scripts.ftlp_lock_time_tape,
        );

        assert!(pool_tape(&state).unwrap().as_bytes().ends_with(b"NTape"));
        assert!(
            ftlp_tape(&FtlpTapeParams {
                amount_raw: 42_000_000,
                layout: FtlpTapeLayout::Standard {
                    decimal: 6,
                    name: &fixture.ft_name,
                    symbol: &fixture.ft_symbol,
                    is_coin: false,
                },
            })
            .unwrap()
            .as_bytes()
            .ends_with(b"FTape")
        );
        assert_eq!(
            ftlp_tape(&FtlpTapeParams {
                amount_raw: 42_000_000,
                layout: FtlpTapeLayout::LockTime {
                    lock_time: 1_750_000_000,
                    source_ft_tape_size: fixture.ft_tape_size,
                },
            })
            .unwrap()
            .as_bytes()
            .len(),
            fixture.ft_tape_size
        );

        // Deterministic keys only: no WIF, network call, or broadcast enters the fixture.
        assert_eq!(
            keys,
            (1u8..=10)
                .map(|scalar| PrivateKey::from_slice(&[scalar; 32]).unwrap().public_key())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn pool_source_outpoint_parser_matches_released_scripts_and_requires_boundaries() {
        let fixture = fixture();
        let expected = source(&fixture);
        for released in [
            &fixture.scripts.standard_pool,
            &fixture.scripts.locked_pool_one_key,
            &fixture.scripts.locked_pool_two_keys,
            &fixture.scripts.locked_pool_three_keys,
            &fixture.scripts.locked_pool_ten_keys,
        ] {
            let script = crate::script::Script::from_bytes(hex::decode(&released.hex).unwrap());
            assert_eq!(pool_code_source_outpoint(&script).unwrap(), expected);
        }

        let mut wrong_push = hex::decode(&fixture.scripts.standard_pool.hex).unwrap();
        let source_push = wrong_push
            .windows(super::SERIALIZED_OUTPOINT_BYTES + 2)
            .position(|window| {
                window[0] == super::SERIALIZED_OUTPOINT_BYTES as u8
                    && window[super::SERIALIZED_OUTPOINT_BYTES + 1]
                        == crate::script::opcodes::OP_EQUALVERIFY
            })
            .unwrap();
        wrong_push[source_push] = 0x4c;
        assert!(
            pool_code_source_outpoint(&crate::script::Script::from_bytes(wrong_push)).is_err(),
            "the released source must use the canonical direct 36-byte push"
        );

        let mut wrong_boundary = hex::decode(&fixture.scripts.standard_pool.hex).unwrap();
        wrong_boundary[source_push + 1 + super::SERIALIZED_OUTPOINT_BYTES] = 0x87;
        assert!(
            pool_code_source_outpoint(&crate::script::Script::from_bytes(wrong_boundary)).is_err(),
            "the source field must end at the released OP_EQUALVERIFY boundary"
        );

        let mut wrong_marker_push = hex::decode(&fixture.scripts.standard_pool.hex).unwrap();
        let marker_push = wrong_marker_push.len() - super::POOL_CODE_MARKER.len() - 1;
        wrong_marker_push[marker_push] = 0x4c;
        assert!(
            pool_code_source_outpoint(&crate::script::Script::from_bytes(wrong_marker_push))
                .is_err(),
            "the released marker must use the canonical direct five-byte push"
        );
    }

    #[test]
    fn every_source_fingerprint_digest_mutation_is_rejected() {
        let fixture = fixture();
        assert!(source_fingerprints_match_expected(
            &fixture.source_fingerprints
        ));
        for index in 0..fixture.source_fingerprints.len() {
            let mut mutated = fixture.source_fingerprints.clone();
            let replacement = if mutated[index].sha256.starts_with('0') {
                '1'
            } else {
                '0'
            };
            mutated[index]
                .sha256
                .replace_range(..1, &replacement.to_string());
            assert!(
                !source_fingerprints_match_expected(&mutated),
                "digest mutation at authority row {index} was accepted"
            );
        }
    }

    #[test]
    fn pool_script_parameters_and_released_locked_key_boundaries_are_enforced() {
        let source = || OutPoint {
            txid: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
                .parse()
                .unwrap(),
            vout: 7,
        };
        let tag = b"parity";
        let keys = (1u8..=11)
            .map(|scalar| PrivateKey::from_slice(&[scalar; 32]).unwrap().public_key())
            .collect::<Vec<_>>();
        let v3_plan_one = PoolCodeParams {
            lp_plan: 1,
            ft_version: FtScriptVersion::V3,
            is_coin: false,
        };
        let v3_plan_two = PoolCodeParams {
            lp_plan: 2,
            ..v3_plan_one
        };
        let v1_plan_one = PoolCodeParams {
            ft_version: FtScriptVersion::V1,
            ..v3_plan_one
        };
        assert_ne!(
            pool_code(source(), tag, &v3_plan_one).unwrap().as_bytes(),
            pool_code(source(), tag, &v3_plan_two).unwrap().as_bytes()
        );
        assert_ne!(
            pool_code(source(), tag, &v3_plan_one).unwrap().as_bytes(),
            pool_code(source(), tag, &v1_plan_one).unwrap().as_bytes()
        );

        let locked = LockedPoolCodeParams {
            pool: v3_plan_one,
            lp_cost_address: Address::from_hash160([7; 20]),
            lp_cost_sat: 24,
        };
        assert!(locked_pool_code(source(), tag, &[], &locked).is_err());
        for accepted_count in [1, 2, 3, 10] {
            assert!(
                locked_pool_code(source(), tag, &keys[..accepted_count], &locked).is_ok(),
                "released locked Pool must accept {accepted_count} compressed keys"
            );
        }
        assert!(locked_pool_code(source(), tag, &keys[..11], &locked).is_err());
        assert!(
            keys[..10]
                .iter()
                .all(|key| matches!(key.to_bytes()[0], 0x02 | 0x03))
        );
        let duplicate = [keys[0].clone(), keys[0].clone(), keys[1].clone()];
        assert!(locked_pool_code(source(), tag, &duplicate, &locked).is_err());
    }

    #[test]
    fn pool_tags_reject_non_ascii_utf8_for_standard_and_locked_scripts() {
        let fixture = fixture();
        let pool = PoolCodeParams {
            lp_plan: 1,
            ft_version: FtScriptVersion::V3,
            is_coin: false,
        };
        let locked = LockedPoolCodeParams {
            pool,
            lp_cost_address: Address::from_hash160([7; 20]),
            lp_cost_sat: crate::SDK_DUST_SAT,
        };
        let key = PrivateKey::from_slice(&[1; 32]).unwrap().public_key();

        for tag in ["é", "中文", "😀"] {
            for error in [
                pool_code(source(&fixture), tag.as_bytes(), &pool).unwrap_err(),
                locked_pool_code(
                    source(&fixture),
                    tag.as_bytes(),
                    std::slice::from_ref(&key),
                    &locked,
                )
                .unwrap_err(),
            ] {
                let message = error.to_string();
                assert!(message.contains("ASCII"), "unexpected error: {message}");
                assert!(
                    message.contains("UTF-16"),
                    "error must explain the JS 1.6.5 ambiguity: {message}"
                );
            }
        }
    }

    #[test]
    fn pool_and_tape_boundaries_reject_ambiguous_protocol_encodings() {
        let fixture = fixture();
        let params = PoolCodeParams {
            lp_plan: 1,
            ft_version: FtScriptVersion::V3,
            is_coin: false,
        };
        for invalid_plan in [0, 7] {
            assert!(
                pool_code(
                    source(&fixture),
                    b"tag",
                    &PoolCodeParams {
                        lp_plan: invalid_plan,
                        ..params
                    }
                )
                .is_err()
            );
        }
        assert!(pool_code(source(&fixture), &[0xff], &params).is_err());
        assert!(pool_code(source(&fixture), &[b'a'; 76], &params).is_err());
        assert!(pool_code(source(&fixture), &[b'a'; 75], &params).is_ok());

        let key = PrivateKey::from_slice(&[1; 32]).unwrap().public_key();
        assert!(
            locked_pool_code(
                source(&fixture),
                b"tag",
                &[key],
                &LockedPoolCodeParams {
                    pool: params,
                    lp_cost_address: Address::from_hash160([7; 20]),
                    lp_cost_sat: crate::SDK_DUST_SAT - 1,
                }
            )
            .is_err()
        );

        let mut state = PoolState {
            amounts: PoolAmounts {
                ft_lp_raw: 1,
                ft_a_raw: 2,
                tbc_sat: 3,
            },
            ft_lp_partial_hash: vec![0x11; 31],
            ft_a_partial_hash: vec![0x22; 32],
            ft_a_contract_id: fixture.state.ft_a_contract_id.parse().unwrap(),
            service_fee_rate: 35,
            service_provider: String::new(),
            lp_plan: 1,
            public_key_locked: false,
            ftlp_lock_time_enabled: false,
        };
        assert!(pool_tape(&state).is_err());
        state.ft_lp_partial_hash.push(0x11);
        state.lp_plan = 0;
        assert!(pool_tape(&state).is_err());

        assert!(
            ftlp_tape(&FtlpTapeParams {
                amount_raw: 1,
                layout: FtlpTapeLayout::Standard {
                    decimal: 19,
                    name: "Token",
                    symbol: "TOK",
                    is_coin: false,
                },
            })
            .is_err()
        );
        assert!(
            ftlp_tape(&FtlpTapeParams {
                amount_raw: 1,
                layout: FtlpTapeLayout::LockTime {
                    lock_time: 1,
                    source_ft_tape_size: 61,
                },
            })
            .is_err()
        );
        assert!(pool_held_ft_code(&crate::script::Script::empty(), [0; 20]).is_err());
    }

    #[test]
    fn ftlp_versions_and_coin_modes_have_released_sizes_and_distinct_bytes() {
        let owner = Address::from_hash160([0x44; 20]);
        for is_coin in [false, true] {
            let mut regular = Vec::new();
            let mut locked = Vec::new();
            for version in [
                FtScriptVersion::V1,
                FtScriptVersion::V2,
                FtScriptVersion::V3,
            ] {
                let params = FtlpCodeParams {
                    tape_size: 69,
                    ft_version: version,
                    is_coin,
                };
                let code = ftlp_code([0x33; 32], &owner, &params).unwrap();
                let lock_code = ftlp_lock_time_code([0x33; 32], &owner, &params).unwrap();
                let expected_size = if is_coin {
                    2_012
                } else if version == FtScriptVersion::V1 {
                    1_564
                } else {
                    1_884
                };
                assert_eq!(code.as_bytes().len(), expected_size);
                assert_eq!(lock_code.as_bytes().len(), expected_size);
                assert!(code.as_bytes().ends_with(b"\x02Code"));
                assert!(lock_code.as_bytes().ends_with(b"\x02Code"));
                regular.push(code.into_bytes());
                locked.push(lock_code.into_bytes());
            }
            if is_coin {
                assert_eq!(regular[0], regular[1]);
                assert_eq!(locked[0], locked[1]);
            } else {
                assert_ne!(regular[0], regular[1]);
                assert_ne!(locked[0], locked[1]);
            }
            assert_ne!(regular[1], regular[2]);
            assert_ne!(locked[1], locked[2]);
        }

        for tape_size in [0, 256] {
            let params = FtlpCodeParams {
                tape_size,
                ft_version: FtScriptVersion::V3,
                is_coin: false,
            };
            assert!(ftlp_code([0; 32], &owner, &params).is_err());
            assert!(ftlp_lock_time_code([0; 32], &owner, &params).is_err());
        }
    }

    #[test]
    fn pool_plan_six_and_ftlp_v4_match_javascript_166() {
        let source = OutPoint {
            txid: "11".repeat(32).parse().unwrap(),
            vout: 0,
        };
        let pool_params = PoolCodeParams {
            lp_plan: 6,
            ft_version: FtScriptVersion::V4,
            is_coin: false,
        };
        let pool = pool_code(source.clone(), b"parity", &pool_params).unwrap();
        assert_eq!(pool.as_bytes().len(), 3_753);
        assert_eq!(
            hex::encode(pool.sha256()),
            "f6095435a6949e1c665859c9af32ba1413216188ca9a483ff402fba2eeae8425"
        );

        let public_key = PublicKey::from_slice(
            &hex::decode("024444444444444444444444444444444444444444444444444444444444444444")
                .unwrap(),
        )
        .unwrap();
        let locked = locked_pool_code(
            source,
            b"parity",
            &[public_key],
            &LockedPoolCodeParams {
                pool: pool_params,
                lp_cost_address: Address::from_string("1BitcoinEaterAddressDontSendf59kuE")
                    .unwrap(),
                lp_cost_sat: 1_000,
            },
        )
        .unwrap();
        assert_eq!(locked.as_bytes().len(), 3_845);
        assert_eq!(
            hex::encode(locked.sha256()),
            "984912199a81943000e0be768c7489f9be842b13582e42eacc0982daa7305d3d"
        );

        let owner = Address::from_string("1BitcoinEaterAddressDontSendf59kuE").unwrap();
        let ftlp_params = FtlpCodeParams {
            tape_size: 80,
            ft_version: FtScriptVersion::V4,
            is_coin: false,
        };
        let regular = ftlp_code([0x22; 32], &owner, &ftlp_params).unwrap();
        let lock_time = ftlp_lock_time_code([0x22; 32], &owner, &ftlp_params).unwrap();
        assert_eq!(regular.as_bytes().len(), 2_076);
        assert_eq!(
            hex::encode(regular.sha256()),
            "17a08d5424fa4a31cdef42c510b616afd35b3d26d91e6ae8c8390672c2a374a0"
        );
        assert_eq!(lock_time.as_bytes().len(), 2_076);
        assert_eq!(
            hex::encode(lock_time.sha256()),
            "32f18671ab373f35ea9085764569690092713ae40db4d6b30c06cf6e7e2292ad"
        );
    }
}
