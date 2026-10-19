//! Historical issuance assessment over one transaction and already resolved
//! material. No fetches, keys, approval, or persistence live here.
//!
//! The caller authenticates node/batch-local output provenance and supplies the
//! exact transaction it will sign. This policy does NOT replace script, fee,
//! ownership, sighash, or consensus checks. Unknown scripts fail the policy;
//! finding no known mint is not sufficient evidence to allow a transaction.

use std::collections::{BTreeMap, BTreeSet};
use tbc_sdk::{OutPoint, Transaction, TxOut, contracts::nft::CollectionData};
use super::{
    fungible_change::{FungiblePair, fungible_changes, inspect_fungible_pair},
    historical_coin::{HistoricalCoinCertificate, inspect_historical_coin_certificate},
    historical_nft::{HistoricalNft, HistoricalNftIdentity, decode_tape,
        inspect_historical_nft, inspect_historical_mint_slot, inspect_historical_collection_slot,
        is_current_regular_nft_group},
    historical_pool::{HistoricalPool, HistoricalFtlp, HistoricalPoolTemplate, HistoricalFtlpTemplate,
        inspect_historical_pool, inspect_historical_ftlp},
};

type OutputKey = ([u8; 32], u32);
fn key(point: &OutPoint) -> OutputKey { (*point.txid.as_le_bytes(), point.vout) }

pub struct ResolvedHistoricalOutput<'a> {
    pub outpoint: OutPoint,
    pub output: &'a TxOut,
}

pub enum HistoricalTemplate {
    Pool(HistoricalPoolTemplate),
    Ftlp(HistoricalFtlpTemplate),
}

/// Hints are only candidates for complete template reconstruction, never an
/// assertion of protocol identity. They may be reused from Kit's local parser.
#[derive(Default)]
pub struct HistoricalPolicyTemplates<'a> {
    pub inputs: &'a [(OutPoint, HistoricalTemplate)],
    pub outputs: &'a [(u32, HistoricalTemplate)],
}

pub struct HistoricalPolicyTransaction<'a> {
    pub transaction: &'a Transaction,
    pub templates: HistoricalPolicyTemplates<'a>,
}

/// Preflights the complete concrete batch before its caller releases any digest.
/// Already authenticated external outputs are indexed once. Only earlier batch
/// transactions supply local prevouts; external material cannot impersonate a
/// local output. The caller must rebind/recheck associated children when signed
/// parent IDs replace provisional IDs. This is not a signature/consensus check.
pub fn require_batch_no_historical_issuance(
    transactions: &[HistoricalPolicyTransaction<'_>],
    resolved: &[ResolvedHistoricalOutput<'_>],
) -> Result<(), String> {
    if transactions.is_empty() { return Err("empty historical policy batch".into()); }
    let mut ids = BTreeSet::new();
    let mut transaction_ids = Vec::with_capacity(transactions.len());
    for item in transactions {
        let txid = item.transaction.txid();
        if !ids.insert(*txid.as_le_bytes()) { return Err("duplicate historical policy transaction".into()); }
        transaction_ids.push(txid);
    }
    let mut material = BTreeMap::new();
    for item in resolved {
        if ids.contains(item.outpoint.txid.as_le_bytes()) {
            return Err("external policy material shadows a batch transaction".into());
        }
        if material.insert(key(&item.outpoint), item.output).is_some() {
            return Err("duplicate resolved policy output".into());
        }
    }
    let mut spent = BTreeSet::new();
    for (index, item) in transactions.iter().enumerate() {
        for input in &item.transaction.inputs {
            if !spent.insert(key(&input.previous_output)) {
                return Err("historical policy batch spends an input twice".into());
            }
        }
        assess_with_material(item.transaction, &material, &item.templates)?
            .require_no_historical_issuance()?;
        let txid = transaction_ids[index];
        for (vout, output) in item.transaction.outputs.iter().enumerate() {
            let vout = u32::try_from(vout).map_err(|_| "policy output index overflow")?;
            material.insert((*txid.as_le_bytes(), vout), output);
        }
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PolicyLocation { Input(usize), Output(u32) }

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoricalIssuanceViolation {
    pub family: &'static str,
    pub output_index: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HistoricalIssuanceAssessment {
    pub violations: Vec<HistoricalIssuanceViolation>,
    pub unclassified: Vec<PolicyLocation>,
}

impl HistoricalIssuanceAssessment {
    pub fn require_no_historical_issuance(&self) -> Result<(), String> {
        if !self.violations.is_empty() { return Err("historical asset issuance is disabled".into()); }
        if !self.unclassified.is_empty() { return Err("historical issuance policy material is unclassified".into()); }
        Ok(())
    }
}

enum Asset {
    Fungible(FungiblePair), Nft(HistoricalNft), Coin(HistoricalCoinCertificate),
    Pool(HistoricalPool), Lp(HistoricalFtlp),
}
enum Classification { Asset(Asset, usize), CurrentNft, CurrentCoinCertificate, CurrentAmm, CurrentLp, CurrentSpecial, Ordinary, Unknown }

fn ordinary(output: &TxOut) -> bool {
    let bytes = output.script_pubkey.as_bytes();
    // Includes ordinary P2PKH-with-data funding/hold outputs. A textual mint
    // marker alone must not make an ordinary native payment an asset issuance.
    let p2pkh = bytes.len() >= 25 && bytes.starts_with(&[0x76, 0xa9, 0x14])
        && bytes[23..25] == [0x88, 0xac]
        && (bytes.len() == 25 || bytes.get(25) == Some(&0x6a));
    p2pkh || bytes.starts_with(&[0, 0x6a]) || bytes.first() == Some(&0x6a)
}

fn classify(
    output: &TxOut, next: Option<&TxOut>, after_next: Option<&TxOut>,
    template: Option<&HistoricalTemplate>,
) -> Result<Classification, String> {
    if let Some(template) = template {
        return match template {
            HistoricalTemplate::Pool(hint) => inspect_historical_pool(output, next, Some(hint))?
                .map(|value| Classification::Asset(Asset::Pool(value), 2))
                .ok_or_else(|| "Pool hint does not match the output".into()),
            HistoricalTemplate::Ftlp(hint) => inspect_historical_ftlp(output, next, Some(hint))?
                .map(|value| Classification::Asset(Asset::Lp(value), 2))
                .ok_or_else(|| "FTLP hint does not match the output".into()),
        };
    }
    if ordinary(output) { return Ok(Classification::Ordinary); }
    // These complete codecs identify only the native covenant output. Any
    // accompanying FT/Coin/LP groups still pass the independent asset policy.
    // Never inspect HTLC unlocking bytes or preimages for issuance detection.
    let script=output.script_pubkey.as_bytes();
    if super::htlc::Code::decode(script).is_ok() || super::timelock::Code::decode(script).is_ok()
        || super::lop::Code::decode(script).is_ok() {
        return Ok(Classification::CurrentSpecial);
    }
    if super::amm_material::inspect_pool_outputs(output,next).map_err(|error|error.message)?.is_some() {
        return Ok(Classification::CurrentAmm);
    }
    if let Ok(code)=super::amm_lp::parse_code(output.script_pubkey.as_bytes()) {
        let tape=next.ok_or("current LP Tape missing")?;
        if output.satoshis!=super::amm_lp::CODE_DUST || tape.satoshis!=0 {
            return Err("current LP Code/Tape values differ".into());
        }
        super::amm_lp::Tape::decode(tape.script_pubkey.as_bytes(),code.timelocked,Some(code.tape_size))
            .map_err(|error|error.to_string())?;
        return Ok(Classification::CurrentLp);
    }
    if super::coin_identity::is_current_certificate_group(output, next, after_next)
        .map_err(|error|error.message)? {
        return Ok(Classification::CurrentCoinCertificate);
    }
    if is_current_regular_nft_group(output, next, after_next)? {
        return Ok(Classification::CurrentNft);
    }
    if let Some(pair) = inspect_fungible_pair(output, next)? {
        return Ok(Classification::Asset(Asset::Fungible(pair), 2));
    }
    if let Some(pool)=super::historical_pool::inspect_historical_pool_auto(output,next)? {
        return Ok(Classification::Asset(Asset::Pool(pool),2));
    }
    if let Some(lp)=super::historical_pool::inspect_historical_ftlp_auto(output,next)? {
        return Ok(Classification::Asset(Asset::Lp(lp),2));
    }
    // Certificate and regular NFT both use historical 3Code markers: complete
    // certificate recognition precedes the old NFT version candidate filter.
    if let Some(coin) = inspect_historical_coin_certificate(output, next, after_next)? {
        return Ok(Classification::Asset(Asset::Coin(coin), 3));
    }
    if let Some(nft) = inspect_historical_nft(output, next, after_next)? {
        return Ok(Classification::Asset(Asset::Nft(nft), 3));
    }
    Ok(Classification::Unknown)
}

pub fn assess_historical_issuance(
    transaction: &Transaction,
    resolved: &[ResolvedHistoricalOutput<'_>],
    templates: HistoricalPolicyTemplates<'_>,
) -> Result<HistoricalIssuanceAssessment, String> {
    let mut material = BTreeMap::new();
    for item in resolved {
        if material.insert(key(&item.outpoint), item.output).is_some() {
            return Err("duplicate resolved policy output".into());
        }
    }
    assess_with_material(transaction, &material, &templates)
}

fn assess_with_material(
    transaction: &Transaction,
    material: &BTreeMap<OutputKey, &TxOut>,
    templates: &HistoricalPolicyTemplates<'_>,
) -> Result<HistoricalIssuanceAssessment, String> {
    let mut input_hints = BTreeMap::new();
    for (point, hint) in templates.inputs {
        if input_hints.insert(key(point), hint).is_some() { return Err("duplicate input template hint".into()); }
    }
    let mut output_hints = BTreeMap::new();
    for (vout, hint) in templates.outputs {
        if output_hints.insert(*vout, hint).is_some() { return Err("duplicate output template hint".into()); }
    }
    let mut spent = BTreeSet::new();
    let mut inputs = Vec::new();
    let mut result = HistoricalIssuanceAssessment::default();
    for (vin, input) in transaction.inputs.iter().enumerate() {
        let point = &input.previous_output;
        if !spent.insert(key(point)) { return Err("duplicate transaction input".into()); }
        let output = material.get(&key(point)).copied().ok_or("policy input material is missing")?;
        let sibling = |distance| point.vout.checked_add(distance)
            .and_then(|vout| material.get(&(*point.txid.as_le_bytes(), vout)).copied());
        match classify(output, sibling(1), sibling(2), input_hints.get(&key(point)).copied())? {
            Classification::Asset(asset, _) => inputs.push((point.clone(), asset)),
            Classification::Unknown => result.unclassified.push(PolicyLocation::Input(vin)),
            Classification::CurrentNft | Classification::CurrentCoinCertificate |
            Classification::CurrentAmm | Classification::CurrentLp | Classification::CurrentSpecial | Classification::Ordinary => (),
        }
    }
    if input_hints.keys().any(|hint| !spent.contains(hint)) {
        return Err("input template hint is not spent by this transaction".into());
    }
    let mut outputs = Vec::new();
    let mut used_output_hints = BTreeSet::new();
    let collection = transaction.outputs.first().and_then(|tape| decode_tape::<CollectionData>(tape).ok());
    let collection_txid = collection.as_ref().map(|_| transaction.txid());
    let mut vout = 0;
    while vout < transaction.outputs.len() {
        let index = u32::try_from(vout).map_err(|_| "policy output index overflow")?;
        let output = &transaction.outputs[vout];
        if collection.is_some() && inspect_historical_mint_slot(output)?.is_some() {
            let point = OutPoint {txid: collection_txid.unwrap(), vout: index};
            inspect_historical_collection_slot(&point, output, transaction.outputs.first())?
                .ok_or("collection slot classification failed")?;
            // Current TBC721 deliberately inherits this exact collection format.
            // Validate the slot, but only the minted Code identifies old issuance.
        }
        let hint = output_hints.get(&index).copied();
        if hint.is_some() { used_output_hints.insert(index); }
        match classify(output, transaction.outputs.get(vout + 1), transaction.outputs.get(vout + 2), hint)? {
            Classification::Asset(asset, width) => { outputs.push((index, asset)); vout += width; }
            Classification::Unknown => { result.unclassified.push(PolicyLocation::Output(index)); vout += 1; }
            Classification::CurrentNft | Classification::CurrentCoinCertificate => vout += 3,
            Classification::CurrentAmm | Classification::CurrentLp => vout += 2,
            Classification::CurrentSpecial | Classification::Ordinary => vout += 1,
        }
    }
    if output_hints.keys().any(|index| !used_output_hints.contains(index)) {
        return Err("output template hint is not a classified Code output".into());
    }
    compare_assets(&inputs, &outputs, &mut result)?;
    Ok(result)
}

fn compare_assets(
    inputs: &[(OutPoint, Asset)], outputs: &[(u32, Asset)], result: &mut HistoricalIssuanceAssessment,
) -> Result<(), String> {
    let fungible_inputs: Vec<_> = inputs.iter().filter_map(|(point, asset)| match asset {
        Asset::Fungible(pair) => Some((point.clone(), pair.clone())), _ => None,
    }).collect();
    let fungible_outputs: Vec<_> = outputs.iter().filter_map(|(vout, asset)| match asset {
        Asset::Fungible(pair) => Some((*vout, pair.clone())), _ => None,
    }).collect();
    let mut fungible_indices = BTreeMap::new();
    for (index, pair) in &fungible_outputs { fungible_indices.entry(&pair.identity).or_insert(*index); }
    for change in fungible_changes(&fungible_inputs, &fungible_outputs)? {
        if change.is_historical_issuance() {
            let index = *fungible_indices.get(&change.identity).unwrap();
            result.violations.push(HistoricalIssuanceViolation {family: "fungible", output_index: index});
        }
    }
    let mut nfts = BTreeMap::<HistoricalNftIdentity, &HistoricalNft>::new();
    let mut coins = BTreeMap::new();
    let mut pools = BTreeMap::new();
    let mut lp_inputs = BTreeMap::<[u8; 32], u128>::new();
    for (_, asset) in inputs {
        match asset {
            Asset::Nft(nft) => if nfts.insert(nft.identity.clone(), nft).is_some() { return Err("duplicate historical NFT identity".into()); },
            Asset::Coin(coin) => if coins.insert(key(&coin.source), coin).is_some() { return Err("duplicate historical certificate identity".into()); },
            Asset::Pool(pool) => if pools.insert(pool.identity.code_hash, pool).is_some() { return Err("duplicate historical Pool identity".into()); },
            Asset::Lp(lp) => add_amount(&mut lp_inputs, lp.identity.owner_independent_code_hash, lp.amount)?,
            _ => (),
        }
    }
    let mut seen_nfts = BTreeSet::new();
    let mut seen_coins = BTreeSet::new();
    let mut seen_pools = BTreeSet::new();
    let mut lp_allowance = BTreeMap::new();
    let mut lp_outputs = BTreeMap::<[u8; 32], u128>::new();
    let mut lp_examples = BTreeMap::new();
    for (vout, asset) in outputs {
        let prohibited = match asset {
            Asset::Nft(nft) => {
                if let Some(old) = nfts.get(&nft.identity) {
                    if old.tape_script != nft.tape_script { return Err("historical NFT metadata changed".into()); }
                }
                (!seen_nfts.insert(nft.identity.clone()) || !nfts.contains_key(&nft.identity)).then_some("nft")
            },
            Asset::Coin(coin) => (!seen_coins.insert(key(&coin.source))
                || coin.creates_or_increases_supply(coins.get(&key(&coin.source)).copied())).then_some("stablecoin-certificate"),
            Asset::Pool(pool) => {
                let old = pools.get(&pool.identity.code_hash).copied();
                let duplicate = !seen_pools.insert(pool.identity.code_hash);
                let creates = old.is_none() || old.is_some_and(|old| old.state.amounts.ft_lp_raw == 0
                    && (pool.state.amounts.ft_lp_raw > 0 || (old.state.amounts.ft_a_raw == 0
                        && old.state.amounts.tbc_sat == 0 && (pool.state.amounts.ft_a_raw > 0
                            || pool.state.amounts.tbc_sat > 0))));
                if !duplicate && !creates {
                    let old = old.unwrap();
                    if let Some(delta) = pool.state.amounts.ft_lp_raw.checked_sub(old.state.amounts.ft_lp_raw).filter(|v| *v > 0) {
                        if old.state.ft_lp_partial_hash != pool.state.ft_lp_partial_hash {
                            return Err("historical Pool LP identity changed".into());
                        }
                        // Explicit existing-pool add-LP exception, not general
                        // permission to mint LP or initialize an empty pool.
                        lp_allowance.insert(pool.identity.code_hash, (u128::from(delta), pool.state.ft_lp_partial_hash.clone()));
                    }
                }
                (duplicate || creates).then_some("pool")
            },
            Asset::Lp(lp) => {
                add_amount(&mut lp_outputs, lp.identity.owner_independent_code_hash, lp.amount)?;
                lp_examples.entry(lp.identity.owner_independent_code_hash).or_insert((*vout, lp));
                None
            },
            _ => None,
        };
        if let Some(family) = prohibited { result.violations.push(HistoricalIssuanceViolation {family, output_index: *vout}); }
    }
    for (identity, amount) in lp_outputs {
        let input = lp_inputs.get(&identity).copied().unwrap_or(0);
        let (vout, lp) = lp_examples[&identity];
        if amount <= input && lp_inputs.contains_key(&identity) { continue; }
        let delta = amount.checked_sub(input).ok_or("historical LP supply comparison failed")?;
        let allowance = lp_allowance.remove(&lp.identity.pool_code_hash);
        if delta == 0 || !allowance.is_some_and(|(expected, partial)| expected == delta
            && partial.as_slice() == lp.identity.partial_hash.as_slice()) {
            result.violations.push(HistoricalIssuanceViolation {family: "lp", output_index: vout});
        }
    }
    if !lp_allowance.is_empty() {
        return Err("historical Pool LP increase has no matching LP outputs".into());
    }
    Ok(())
}

fn add_amount(map: &mut BTreeMap<[u8; 32], u128>, identity: [u8; 32], amount: u128) -> Result<(), String> {
    let balance = map.entry(identity).or_insert(0);
    *balance = balance.checked_add(amount).ok_or("historical LP sum overflow")?;
    Ok(())
}
