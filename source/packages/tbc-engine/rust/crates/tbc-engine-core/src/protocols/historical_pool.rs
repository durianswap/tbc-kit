//! Bounded local classification for historical Pool/FTLP issuance policy.
//!
//! This is NOT an automatic bare-Code router or an authorization API. Template
//! hints may come from existing local parsers/build material; they are candidates
//! only and are accepted solely after complete SDK Code reconstruction. Missing
//! shared-reviewer material must be supplied by Kit's local evidence layer, not
//! new wallet-specific parsing or HTTP. Callers must authenticate adjacency and
//! prevouts and apply the whole transaction policy. `None` is unknown, not allowed.
//! Pool liquidity-increase permission is deliberately not decided here.

use tbc_sdk::{Address, OutPoint, PublicKey, TxOut, hash, script::Script};
use std::sync::OnceLock;
use tbc_sdk::contracts::{ft::{scripts::transfer_tape_script, partial_sha256::calculate_partial_hash}, pool_nft_v2::{
    PoolState, PoolCodeParams, LockedPoolCodeParams, FtScriptVersion, FtlpCodeParams,
    FtlpTapeLayout, FtlpTapeParams, pool_code, locked_pool_code, ftlp_code,
    ftlp_lock_time_code, ftlp_tape, scripts::pool_code_source_outpoint,
}};

#[derive(Clone, Debug)]
pub struct HistoricalPoolLockTemplate {
    pub public_keys: Vec<PublicKey>,
    pub lp_cost_address: Address,
    pub lp_cost_sat: u64,
}

/// Pinned pool_nft_v2/scripts.rs::locked_pool_lp_cost extraction. A candidate
/// only; callers must reconstruct and compare the full Code before trusting it.
pub fn released_locked_pool_lp_cost(script: &Script) -> Result<(Address, u64), String> {
    use tbc_sdk::script::opcodes::{OP_EQUALVERIFY, OP_PARTIAL_HASH, OP_OVER};
    let bytes = script.as_bytes();let sentinel = [OP_EQUALVERIFY, OP_PARTIAL_HASH, OP_OVER, 0x08];
    for index in 0..bytes.len().saturating_sub(34) {
        if bytes[index] != 0x14 || bytes[index + 21..index + 25] != sentinel || bytes[index + 33] != OP_EQUALVERIFY {continue;}
        let hash160 = bytes[index + 1..index + 21].try_into().unwrap();
        let amount = u64::from_le_bytes(bytes[index + 25..index + 33].try_into().unwrap());
        if amount < tbc_sdk::SDK_DUST_SAT {return Err("locked Pool LP cost is below dust".into());}
        return Ok((Address::from_hash160(hash160), amount));
    }
    Err("Pool Code lacks the released locked LP-cost binding".into())
}

#[derive(Clone, Debug)]
pub struct HistoricalPoolTemplate {
    pub ft_version: FtScriptVersion,
    pub is_coin: bool,
    pub tag: Vec<u8>,
    pub lock: Option<HistoricalPoolLockTemplate>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoricalPoolIdentity {
    pub source: OutPoint,
    /// Full immutable Code: includes source, fee/tag/lock and FT-script rules,
    /// excludes the mutable Pool Tape balances.
    pub code_hash: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoricalPool {
    pub identity: HistoricalPoolIdentity,
    pub state: PoolState,
    pub satoshis: u64,
}

pub fn inspect_historical_pool(
    code: &TxOut, tape: Option<&TxOut>, template: Option<&HistoricalPoolTemplate>,
) -> Result<Option<HistoricalPool>, String> {
    if !code.script_pubkey.as_bytes().ends_with(b"\x052Code") { return Ok(None); }
    let tape = tape.ok_or("historical Pool Tape material is missing")?;
    let template = template.ok_or("historical Pool template material is missing")?;
    if tape.satoshis != 0 { return Err("historical Pool Tape value is not zero".into()); }
    if template.tag.len() > 75 || template.lock.as_ref().is_some_and(|lock| lock.public_keys.len() > 10) {
        return Err("historical Pool template material exceeds released bounds".into());
    }
    // The released eight-field Pool Tape is 139/140 bytes (one/two-byte fee).
    // Bound parsing before the SDK allocates pushed fields.
    if !matches!(tape.script_pubkey.as_bytes().len(), 139 | 140) {
        return Err("historical Pool Tape size is not canonical".into());
    }
    let state = PoolState::from_v2_tape(&tape.script_pubkey, String::new()).map_err(|e| e.to_string())?;
    if state.public_key_locked != template.lock.is_some() {
        return Err("historical Pool Tape and Code lock profiles differ".into());
    }
    let source = pool_code_source_outpoint(&code.script_pubkey).map_err(|e| e.to_string())?;
    let params = PoolCodeParams { lp_plan: state.lp_plan, ft_version: template.ft_version, is_coin: template.is_coin };
    let expected = match &template.lock {
        Some(lock) => locked_pool_code(source.clone(), &template.tag, &lock.public_keys, &LockedPoolCodeParams {
            pool: params, lp_cost_address: lock.lp_cost_address.clone(), lp_cost_sat: lock.lp_cost_sat,
        }),
        None => pool_code(source.clone(), &template.tag, &params),
    }.map_err(|e| e.to_string())?;
    if expected != code.script_pubkey { return Err("historical Pool Code does not match the complete released template".into()); }
    Ok(Some(HistoricalPool {
        identity: HistoricalPoolIdentity { source, code_hash: hash::sha256(code.script_pubkey.as_bytes()) },
        state, satoshis: code.satoshis,
    }))
}

#[derive(Clone, Copy, Debug)]
pub struct HistoricalFtlpTemplate {
    pub pool_code_hash: [u8; 32],
    pub ft_version: FtScriptVersion,
    pub is_coin: bool,
    pub lock_time_enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoricalFtlpIdentity {
    pub pool_code_hash: [u8; 32],
    /// Matches PoolState.ft_lp_partial_hash. The released FTLP Code lengths
    /// 1564/1884/2012/2076 minus their 28-byte owner tail give exactly the
    /// existing Pool family's 1536/1856/1984/2048 partial-hash offsets.
    pub partial_hash: [u8; 32],
    /// SDK Code rebuilt with a fixed zero owner. Includes actual contract rules,
    /// but neither the current owner, amount slots nor mutable lock deadline.
    pub owner_independent_code_hash: [u8; 32],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoricalFtlp {
    pub identity: HistoricalFtlpIdentity,
    pub controller: [u8; 21],
    pub amount: u128,
    pub lock_time: Option<u32>,
}

// Compile fixed SDK equivalence classes once. Differential prototypes locate
// only the three explicit SDK parameters, not arbitrary caller-controlled
// wildcards. Full reconstruction below remains authoritative.
struct LpPattern {
    code:Vec<u8>, pool:Vec<usize>, owner:Vec<usize>, tape:Vec<usize>,
    version:FtScriptVersion, coin:bool, locked:bool,
}
fn lp_patterns()-> &'static [LpPattern] {
    static PATTERNS:OnceLock<Vec<LpPattern>>=OnceLock::new();
    PATTERNS.get_or_init(|| {
        let mut patterns=Vec::new();
        for version in [FtScriptVersion::V1,FtScriptVersion::V2,FtScriptVersion::V3,FtScriptVersion::V4] {
            for coin in [false,true] { for locked in [false,true] {
                let build=|pool,owner,tape_size| {
                    let params=FtlpCodeParams{tape_size,ft_version:version,is_coin:coin};
                    let owner=Address::from_hash160(owner);
                    (if locked {ftlp_lock_time_code(pool,&owner,&params)}else{ftlp_code(pool,&owner,&params)})
                        .expect("pinned historical LP prototype").as_bytes().to_vec()
                };
                let code=build([0;32],[0;20],91);
                let changes=|other:Vec<u8>| {
                    assert_eq!(code.len(),other.len(),"pinned LP prototype width");
                    code.iter().zip(other).enumerate().filter_map(|(i,(a,b))|(*a!=b).then_some(i)).collect::<Vec<_>>()
                };
                let pool=changes(build([1;32],[0;20],91));
                let owner=changes(build([0;32],[1;20],91));
                let tape=changes(build([0;32],[0;20],92));
                assert_eq!(pool.len(),32);assert!(pool.windows(2).all(|w|w[1]==w[0]+1));
                assert_eq!(owner.len(),20);assert_eq!(tape.len(),16);
                let mut all=pool.clone();all.extend(&owner);all.extend(&tape);all.sort_unstable();all.dedup();
                assert_eq!(all.len(),68,"LP template parameters cannot overlap");
                patterns.push(LpPattern{code,pool,owner,tape,version,coin,locked});
            }}
        }patterns
    })
}

/// Local exact classification without API version labels or a candidate search
/// over caller data. Pattern matching is bounded by the fixed released variants;
/// only a matching complete Code is passed through existing Tape/identity checks.
pub fn inspect_historical_ftlp_auto(code:&TxOut,tape:Option<&TxOut>)->Result<Option<HistoricalFtlp>,String> {
    let bytes=code.script_pubkey.as_bytes();
    if !bytes.ends_with(b"\x05\x02Code") {return Ok(None);}
    let tape=tape.ok_or("historical FTLP Tape material is missing")?;
    let size=u8::try_from(tape.script_pubkey.as_bytes().len()).map_err(|_|"historical LP Tape exceeds bound")?;
    for pattern in lp_patterns().iter().filter(|p|p.code.len()==bytes.len()) {
        let mut expected=pattern.code.clone();
        for i in pattern.pool.iter().chain(pattern.owner.iter()) {expected[*i]=bytes[*i];}
        for i in &pattern.tape {expected[*i]=size;}
        if expected!=bytes {continue;}
        let hint=HistoricalFtlpTemplate{pool_code_hash:bytes[pattern.pool[0]..pattern.pool[0]+32].try_into().unwrap(),
            ft_version:pattern.version,is_coin:pattern.coin,lock_time_enabled:pattern.locked};
        // Some released classes have byte-identical Code but distinct canonical
        // Tape layouts (ordinary/Coin). Only the complete pair may select one.
        if let Ok(Some(found))=inspect_historical_ftlp(code,Some(tape),Some(&hint)){return Ok(Some(found));}
    }
    Err("historical LP Code/Tape does not match a complete released template".into())
}

pub fn inspect_historical_pool_auto(code:&TxOut,tape:Option<&TxOut>)->Result<Option<HistoricalPool>,String> {
    if !code.script_pubkey.as_bytes().ends_with(b"\x052Code") {return Ok(None);}
    let template=super::pool_origin::historical_template(&code.script_pubkey)?;
    inspect_historical_pool(code,tape,Some(&template))
}

pub fn inspect_historical_ftlp(
    code: &TxOut, tape: Option<&TxOut>, template: Option<&HistoricalFtlpTemplate>,
) -> Result<Option<HistoricalFtlp>, String> {
    let bytes = code.script_pubkey.as_bytes();
    if !bytes.ends_with(b"\x05\x02Code") { return Ok(None); }
    let template = template.ok_or("historical FTLP template material is missing")?;
    let tape = tape.ok_or("historical FTLP Tape material is missing")?;
    if code.satoshis != 500 || tape.satoshis != 0 { return Err("historical FTLP Code/Tape values are not canonical".into()); }
    // Exactly one reconstruction, with the real Tape length: no parameter search.
    let params = FtlpCodeParams::for_tape(&tape.script_pubkey, template.ft_version, template.is_coin)
        .map_err(|e| e.to_string())?;
    let owner_start = bytes.len().checked_sub(27).ok_or("historical FTLP Code is truncated")?;
    let controller: [u8; 21] = bytes.get(owner_start..owner_start + 21)
        .and_then(|value| value.try_into().ok()).ok_or("historical FTLP owner is truncated")?;
    if controller[20] != 0 { return Err("historical FTLP owner is not the released address controller".into()); }
    let owner = Address::from_hash160(controller[..20].try_into().unwrap());
    let build = |owner: &Address| {
        if template.lock_time_enabled { ftlp_lock_time_code(template.pool_code_hash, owner, &params) }
        else { ftlp_code(template.pool_code_hash, owner, &params) }
    };
    if build(&owner).map_err(|e| e.to_string())? != code.script_pubkey {
        return Err("historical FTLP Code does not match the complete released template".into());
    }
    let chunks = tape_chunks(&tape.script_pubkey)?;
    let slots: [u8; 48] = chunks.first().and_then(|chunk| (*chunk).try_into().ok())
        .ok_or("historical FTLP amount slots are malformed")?;
    let (base, lock_time) = if template.lock_time_enabled {
        let raw: [u8; 4] = chunks.get(1).and_then(|chunk| (*chunk).try_into().ok())
            .ok_or("historical FTLP lock deadline is malformed")?;
        let lock_time = u32::from_le_bytes(raw);
        (ftlp_tape(&FtlpTapeParams { amount_raw: 0, layout: FtlpTapeLayout::LockTime {
            lock_time, source_ft_tape_size: tape.script_pubkey.as_bytes().len(),
        }}), Some(lock_time))
    } else {
        let decimal = match chunks.get(1) { Some([value]) => *value, _ => return Err("historical FTLP decimal is malformed".into()) };
        let name = chunks.get(2).and_then(|bytes| std::str::from_utf8(bytes).ok()).ok_or("historical FTLP name is malformed")?;
        let symbol = chunks.get(3).and_then(|bytes| std::str::from_utf8(bytes).ok()).ok_or("historical FTLP symbol is malformed")?;
        (ftlp_tape(&FtlpTapeParams { amount_raw: 0, layout: FtlpTapeLayout::Standard {
            decimal, name, symbol, is_coin: template.is_coin,
        }}), None)
    };
    let expected_tape = transfer_tape_script(&base.map_err(|e| e.to_string())?, &slots).map_err(|e| e.to_string())?;
    if expected_tape != tape.script_pubkey { return Err("historical FTLP Tape is not the released canonical layout".into()); }
    let amount = slots.chunks_exact(8).map(|slot| u128::from(u64::from_le_bytes(slot.try_into().unwrap()))).sum();
    let normalized = build(&Address::from_hash160([0; 20])).map_err(|e| e.to_string())?;
    Ok(Some(HistoricalFtlp {
        identity: HistoricalFtlpIdentity { pool_code_hash: template.pool_code_hash,
            partial_hash: calculate_partial_hash(&bytes[..bytes.len() - 28]),
            owner_independent_code_hash: hash::sha256(normalized.as_bytes()) },
        controller, amount, lock_time,
    }))
}

// FTLP Tape is already bounded by the SDK's one-byte Tape-size field (<=255).
// Borrow slices and reconstruct the canonical SDK Tape after parsing.
fn tape_chunks(script: &Script) -> Result<Vec<&[u8]>, String> {
    let bytes = script.as_bytes();
    if !bytes.starts_with(&[0, 0x6a]) { return Err("historical FTLP Tape framing is invalid".into()); }
    let mut at = 2;
    let mut chunks = Vec::new();
    while at < bytes.len() {
        let opcode = bytes[at]; at += 1;
        let length = match opcode {
            0..=75 => usize::from(opcode),
            0x4c => { let len = usize::from(*bytes.get(at).ok_or("truncated FTLP Tape push")?); at += 1; len },
            0x4d => { let raw = bytes.get(at..at + 2).ok_or("truncated FTLP Tape push")?; at += 2; usize::from(u16::from_le_bytes(raw.try_into().unwrap())) },
            _ => return Err("unsupported FTLP Tape push".into()),
        };
        let end = at.checked_add(length).ok_or("FTLP Tape push overflow")?;
        chunks.push(bytes.get(at..end).ok_or("truncated FTLP Tape field")?); at = end;
    }
    Ok(chunks)
}
