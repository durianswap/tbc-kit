use std::collections::{BTreeMap, BTreeSet};

use tbc_sdk::{
    Address, Transaction,
    contracts::ft::{
        amount::balance_from_tape,
        scripts::{
            FT_CODE_SATOSHIS, FT_MINT_SOURCE_SATOSHIS, FT_TAPE_SATOSHIS, FtCodeReceiver,
            FtMintVersion, mint_code_script_with_version, mint_source_script,
            transfer_code_script,
        },
        unlock::{classify_ft_script, pre_pre_tx_data_from_parents},
    },
    contracts::stable_coin::scripts::{
        StableCoinMintVersion, amount_slot, coin_mint_code_script_with_version, coin_nft_code_script,
        coin_nft_hold_script_from_hash, coin_nft_tape_script, decode_coin_nft_tape_script,
        coin_tape_script,
    },
    script::Script,
};

use crate::model::{ChainSnapshot, ContractRecord, RequestedOutpoint, error};
use crate::normalize::hex;
use crate::signing::{FtProofReference, FtTransactionSource};
use crate::{EngineError, ErrorCode};

const MAX_ASSET_INPUTS: usize = 500;
const MAX_PARENT_RAW_BYTES: usize = 1_048_576;
const MAX_ANCESTRY_RAW_BYTES: usize = 8_388_608;
const MAX_STABLECOIN_SUPPLY_RAW: u128 = 1_000_000_000_000_000_000;
#[cfg(test)]
const MAX_STABLECOIN_HOLDING_NODES: usize = 1_024;
#[cfg(test)]
const MAX_STABLECOIN_HOLDING_WORK: usize = 8_192;
const TAPE_PREFIX: &[u8] = &[0x00, 0x6a, 0x30];
const TAPE_MARKER: &[u8] = b"FTape";

fn fixed_hex(value: &str) -> Vec<u8> {
    value.as_bytes().chunks_exact(2).map(|pair| {
        let digit = |byte: u8| match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            _ => unreachable!("fixed hexadecimal literal"),
        };
        digit(pair[0]) * 16 + digit(pair[1])
    }).collect()
}

#[derive(Clone)]
pub(crate) struct AssetSpend {
    pub txid: String,
    pub vout: u32,
    pub satoshis: u64,
    pub balance_raw: u128,
    pub parent: Transaction,
    pub parent_raw: String,
    pub proof_references: Vec<FtProofReference>,
    pub sequence: u32,
    pub lock_time: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FtMetadata {
    pub decimal: u8,
    pub name: String,
    pub symbol: String,
    pub total_supply_raw: u128,
    pub code_script: String,
    pub tape_script: String,
    pub version: u8,
    pub is_coin: bool,
    pub lock_time: u32,
}

pub(crate) struct AssetAncestry {
    pub spends: Vec<AssetSpend>,
    pub metadata: FtMetadata,
}

#[derive(Clone)]
struct VerifiedParent {
    transaction: Transaction,
    raw: String,
}

#[cfg(test)]
#[derive(Default)]
struct StablecoinHoldingTraversal {
    active: BTreeSet<(String, u32)>,
    completed: BTreeMap<(String, u32), u128>,
    unique: BTreeSet<(String, u32)>,
    work: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TapeData {
    balance_raw: u128,
    slots: [u64; 6],
    decimal: u8,
    name: String,
    symbol: String,
    lock_time: Option<u32>,
}

pub(crate) fn prepare_asset_ancestry(
    snapshot: &ChainSnapshot,
    contract_id: &str,
    owner_hash: &[u8; 20],
    min_confirmations: u64,
) -> Result<AssetAncestry, EngineError> {
    prepare_asset_ancestry_kind(snapshot, contract_id, owner_hash, min_confirmations, false, None)
}

/// Select from the already-bound material before ancestry work. No snapshot
/// clone, extra parent lookup, or change to the ordinary automatic path.
pub(crate) fn prepare_selected_asset_ancestry(
    snapshot: &ChainSnapshot,
    contract_id: &str,
    owner_hash: &[u8; 20],
    min_confirmations: u64,
    points: &[RequestedOutpoint],
) -> Result<AssetAncestry, EngineError> {
    prepare_asset_ancestry_kind(snapshot, contract_id, owner_hash, min_confirmations, false, Some(points))
}

pub(crate) fn prepare_stablecoin_ancestry(
    snapshot: &ChainSnapshot,
    contract_id: &str,
    owner_hash: &[u8; 20],
    min_confirmations: u64,
) -> Result<AssetAncestry, EngineError> {
    prepare_asset_ancestry_kind(snapshot, contract_id, owner_hash, min_confirmations, true, None)
}

fn prepare_asset_ancestry_kind(
    snapshot: &ChainSnapshot,
    contract_id: &str,
    owner_hash: &[u8; 20],
    min_confirmations: u64,
    coin_mode: bool,
    points: Option<&[RequestedOutpoint]>,
) -> Result<AssetAncestry, EngineError> {
    let contract = unique_contract(&snapshot.payload.contracts, contract_id)?;
    let expected_family = if coin_mode { "stablecoin" } else { "ft" };
    let expected_classification = if coin_mode { "stablecoin" } else { "ft" };
    if contract.family != expected_family
        || (!coin_mode && contract.contract_id != contract.creation_txid)
    {
        return Err(invalid_ancestry(
            "FT contract record family or creation identity is inconsistent",
            "snapshot.payload.contracts",
        ));
    }
    let mut candidates = Vec::new();
    for (index, utxo) in snapshot.payload.utxos.iter().enumerate() {
        if points.is_some_and(|points| !points.iter().any(|p| p.txid == utxo.txid && p.vout == utxo.vout)) {
            continue;
        }
        if utxo.classification != expected_classification {
            continue;
        }
        let Some(candidate_contract) = utxo.contract_id.as_deref() else {
            return Err(invalid_ancestry(
                "FT UTXO contract identity is missing",
                &format!("snapshot.payload.utxos[{index}].contractId"),
            ));
        };
        if candidate_contract != contract_id {
            continue;
        }
        if crate::confirmations::meets_minimum(
            utxo.confirmations.as_deref(),
            min_confirmations,
            &format!("snapshot.payload.utxos[{index}].confirmations"),
        )? {
            candidates.push(utxo);
        }
    }
    if candidates.len() > MAX_ASSET_INPUTS {
        return Err(error(
            ErrorCode::InvalidInput,
            "FT input material exceeds the 500 input source limit",
            "snapshot.payload.utxos",
        ));
    }
    if candidates.is_empty() {
        return Err(error(
            ErrorCode::InsufficientFunds,
            "no FT inputs are available for the requested contract",
            "snapshot.payload.utxos",
        ));
    }
    let parents = parse_parent_map(snapshot)?;

    let creation = if contract.indexed_fungible.is_some() { None } else { Some(parents.get(&contract.creation_txid).ok_or_else(|| {
        invalid_ancestry(
            "FT creation transaction is missing",
            "snapshot.payload.parents",
        )
    })?) };
    let (creation_code, creation_tape) = if let Some(indexed) = &contract.indexed_fungible {
        if contract.creation_txid != contract.contract_id {
            return Err(invalid_ancestry("indexed asset record must use the API asset ID", "snapshot.payload.contracts"));
        }
        let decode = |raw: &str| -> Result<Script, EngineError> {
            if raw.len() > 131_072 || raw.is_empty() || raw.len() % 2 != 0
                || !raw.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
                return Err(invalid_ancestry("indexed asset script must be bounded canonical hex", "snapshot.payload.contracts.indexedFungible"));
            }
            Ok(Script::from_bytes(fixed_hex(raw)))
        };
        (decode(&indexed.code_script)?, decode(&indexed.tape_script)?)
    } else if coin_mode {
        authenticate_stablecoin_genesis(creation.unwrap(), &parents)?
    } else {
        authenticate_v4_genesis(creation.unwrap(), &parents)?
    };
    if coin_mode && contract.indexed_fungible.is_none()
        && creation
            .unwrap()
            .transaction
            .inputs
            .first()
            .is_none_or(|input| input.previous_output.txid.to_string() != contract.contract_id)
    {
        return Err(invalid_ancestry(
            "StableCoin contract identity does not match its coin-NFT origin",
            "snapshot.payload.contracts",
        ));
    }
    let creation_info = classify_ft_script(&creation_code).map_err(|_| {
        invalid_ancestry(
            "FT creation code script is not a supported SDK contract",
            "snapshot.payload.parents",
        )
    })?;
    if creation_info.is_coin != coin_mode {
        return Err(invalid_ancestry(
            "StableCoin ancestry cannot satisfy an FT request",
            "snapshot.payload.contracts",
        ));
    }
    let creation_tape_data = parse_tape(&creation_tape)?;
    let stablecoin_mints = if coin_mode && contract.indexed_fungible.is_none() {
        Some(authenticate_stablecoin_mint_lineage(creation.unwrap(), &parents, &creation_tape_data)?)
    } else {
        None
    };
    if coin_mode && creation_tape_data.lock_time.is_none() {
        return Err(invalid_ancestry("StableCoin creation Tape is missing lockTime", "snapshot.payload.parents"));
    }
    if !coin_mode && creation_tape_data.lock_time.is_some() {
        return Err(invalid_ancestry("ordinary FT Tape must not contain StableCoin lockTime", "snapshot.payload.parents"));
    }
    if contract.protocol_version != format!("{}.0", creation_info.version) {
        return Err(invalid_ancestry(
            "FT contract protocol version does not match its code script",
            "snapshot.payload.contracts",
        ));
    }
    let expected_code = hex(creation_code.as_bytes());
    let expected_current_code = transfer_code_script(
        &creation_code,
        FtCodeReceiver::Address(Address::from_hash160(*owner_hash)),
    )
    .map_err(|_| invalid_ancestry("FT genesis template cannot rewrite receiver", "snapshot.payload.parents"))?;

    let mut spends = Vec::with_capacity(candidates.len());
    let mut outpoints = BTreeSet::new();
    let mut effective_supply = if let Some(indexed) = &contract.indexed_fungible {
        let supply = crate::normalize::parse_decimal_u128(&indexed.total_supply, "snapshot.payload.contracts.indexedFungible.totalSupply")?;
        if supply == 0 || (coin_mode && supply > MAX_STABLECOIN_SUPPLY_RAW) {
            return Err(invalid_ancestry("indexed asset supply is out of range", "snapshot.payload.contracts.indexedFungible.totalSupply"));
        }
        supply
    } else { creation_tape_data.balance_raw };
    for (index, utxo) in candidates.into_iter().enumerate() {
        if !outpoints.insert((utxo.txid.clone(), utxo.vout)) {
            return Err(invalid_ancestry(
                "duplicate FT outpoint",
                "snapshot.payload.utxos",
            ));
        }
        let parent = parents.get(&utxo.txid).ok_or_else(|| {
            invalid_ancestry(
                "FT parent transaction is missing",
                &format!("snapshot.payload.utxos[{index}].txid"),
            )
        })?;
        let output = parent
            .transaction
            .outputs
            .get(utxo.vout as usize)
            .ok_or_else(|| {
                invalid_ancestry(
                    "FT parent output is missing",
                    &format!("snapshot.payload.utxos[{index}].vout"),
                )
            })?;
        let supplied_satoshis = parse_u64(&utxo.satoshis, &format!("snapshot.payload.utxos[{index}].satoshis"))?;
        if output.satoshis != supplied_satoshis
            || hex(output.script_pubkey.as_bytes()) != utxo.script_pub_key
            || output.script_pubkey != expected_current_code
        {
            return Err(invalid_ancestry(
                "FT UTXO does not match its authenticated parent output",
                &format!("snapshot.payload.utxos[{index}]"),
            ));
        }
        let info = classify_ft_script(&output.script_pubkey).map_err(|_| {
            invalid_ancestry(
                "FT UTXO code script is unsupported",
                &format!("snapshot.payload.utxos[{index}].scriptPubKey"),
            )
        })?;
        if info.is_coin != coin_mode || info.version != creation_info.version {
            return Err(invalid_ancestry(
                "FT UTXO contract family or version is inconsistent",
                &format!("snapshot.payload.utxos[{index}].scriptPubKey"),
            ));
        }
        validate_owner(&output.script_pubkey, owner_hash)?;
        let tape_output = parent
            .transaction
            .outputs
            .get(utxo.vout as usize + 1)
            .ok_or_else(|| invalid_ancestry("FT Tape output is missing", "snapshot.payload.parents"))?;
        if tape_output.satoshis != 0 {
            return Err(invalid_ancestry(
                "FT Tape output must contain zero satoshis",
                "snapshot.payload.parents",
            ));
        }
        let tape = parse_tape(&tape_output.script_pubkey)?;
        let tape_lock_time = match (coin_mode, tape.lock_time) {
            (true, Some(value)) => value,
            (true, None) => return Err(invalid_ancestry("StableCoin Tape is missing its required lockTime", "snapshot.payload.parents")),
            (false, None) => 0,
            (false, Some(_)) => return Err(invalid_ancestry("ordinary FT Tape contains a StableCoin lockTime", "snapshot.payload.parents")),
        };
        if tape.decimal != creation_tape_data.decimal
            || tape.name != creation_tape_data.name
            || tape.symbol != creation_tape_data.symbol
        {
            return Err(invalid_ancestry(
                "FT Tape metadata does not match the creation transaction",
                "snapshot.payload.parents",
            ));
        }
        let proof_references = proof_references(&parent.transaction, utxo.vout, &tape, &parents)?;
        if let Some(mints) = &stablecoin_mints {
            // Wallet Chain Data supplies current outputs from its configured
            // trusted node. Re-check the local spend and direct covenant proof,
            // not every historical transfer already validated by that node.
            validate_stablecoin_direct_holding(&utxo.txid, utxo.vout, &parents, mints)?;
            effective_supply = effective_supply.max(mints.values().copied().max().unwrap_or(0));
        }
        spends.push(AssetSpend {
            txid: utxo.txid.clone(),
            vout: utxo.vout,
            satoshis: supplied_satoshis,
            balance_raw: tape.balance_raw,
            parent: parent.transaction.clone(),
            parent_raw: parent.raw.clone(),
            proof_references,
            sequence: if coin_mode { tbc_sdk::contracts::stable_coin::scripts::COIN_FT_SEQUENCE } else { tbc_sdk::DEFAULT_SEQUENCE },
            lock_time: tape_lock_time,
        });
    }
    let held = spends.iter().try_fold(0u128, |sum, spend| {
        sum.checked_add(spend.balance_raw).ok_or_else(|| {
            invalid_ancestry("FT balance overflow", "snapshot.payload.utxos")
        })
    })?;
    if held > effective_supply {
        return Err(invalid_ancestry(
            "FT holdings exceed the authenticated creation supply",
            "snapshot.payload.utxos",
        ));
    }
    spends.sort_by(|left, right| {
        left.balance_raw
            .cmp(&right.balance_raw)
            .then_with(|| left.txid.cmp(&right.txid))
            .then_with(|| left.vout.cmp(&right.vout))
    });
    Ok(AssetAncestry {
        spends,
        metadata: FtMetadata {
            decimal: creation_tape_data.decimal,
            name: creation_tape_data.name,
            symbol: creation_tape_data.symbol,
            total_supply_raw: effective_supply,
            code_script: expected_code,
            tape_script: hex(creation_tape.as_bytes()),
            version: creation_info.version,
            is_coin: coin_mode,
            lock_time: creation_tape_data.lock_time.unwrap_or(0),
        },
    })
}

fn authenticate_stablecoin_mint_lineage(
    creation: &VerifiedParent,
    parents: &BTreeMap<String, VerifiedParent>,
    creation_tape: &TapeData,
) -> Result<BTreeMap<String, u128>, EngineError> {
    let coin_nft_txid = creation.transaction.inputs.first().ok_or_else(|| invalid_ancestry("StableCoin creation coin-NFT input is missing", "snapshot.payload.parents"))?.previous_output.txid.to_string();
    let coin_nft = parents.get(&coin_nft_txid).ok_or_else(|| invalid_ancestry("StableCoin original coin-NFT is missing", "snapshot.payload.parents"))?;
    let code = creation.transaction.outputs.first().ok_or_else(|| invalid_ancestry("StableCoin creation coin-NFT code is missing", "snapshot.payload.parents"))?.clone();
    let hold = creation.transaction.outputs.get(1).ok_or_else(|| invalid_ancestry("StableCoin creation coin-NFT hold is missing", "snapshot.payload.parents"))?.clone();
    let initial_script = &creation.transaction.outputs.get(2).ok_or_else(|| invalid_ancestry("StableCoin creation coin-NFT state is missing", "snapshot.payload.parents"))?.script_pubkey;
    let initial = decode_coin_nft_tape_script(initial_script)
        .map_err(|_| invalid_ancestry("StableCoin creation coin-NFT state is malformed", "snapshot.payload.parents"))?;
    if coin_nft_tape_script(&initial).map_err(|_| invalid_ancestry("StableCoin creation coin-NFT state cannot be canonicalized", "snapshot.payload.parents"))? != *initial_script {
        return Err(invalid_ancestry("StableCoin creation coin-NFT state is not canonically encoded", "snapshot.payload.parents"));
    }
    let mut supply = initial.coin_total_supply.parse::<u128>().map_err(|_| invalid_ancestry("StableCoin cumulative supply exceeds uint128", "snapshot.payload.parents"))?;
    if initial.coin_total_supply != supply.to_string() {
        return Err(invalid_ancestry("StableCoin cumulative supply is not a canonical decimal string", "snapshot.payload.parents"));
    }
    if supply > MAX_STABLECOIN_SUPPLY_RAW {
        return Err(invalid_ancestry("StableCoin cumulative supply exceeds 10^18 raw units", "snapshot.payload.parents"));
    }
    let hold_bytes = hold.script_pubkey.as_bytes();
    let admin_hash: [u8; 20] = hold_bytes.get(3..23).ok_or_else(|| invalid_ancestry("StableCoin administrator hash is missing", "snapshot.payload.parents"))?.try_into().map_err(|_| invalid_ancestry("StableCoin administrator hash width is invalid", "snapshot.payload.parents"))?;
    let mut current = creation.transaction.txid().to_string();
    let mut supplies = BTreeMap::from([(current.clone(), supply)]);
    let mut visited = BTreeSet::from([coin_nft_txid.clone(), current.clone()]);
    loop {
        let mut children = parents.iter().filter(|(txid, item)| {
            !visited.contains(*txid)
                && item.transaction.inputs.len() >= 2
                && item.transaction.inputs[0].previous_output.txid.to_string() == current
                && item.transaction.inputs[0].previous_output.vout == 0
                && item.transaction.inputs[1].previous_output.txid.to_string() == current
                && item.transaction.inputs[1].previous_output.vout == 1
        }).collect::<Vec<_>>();
        children.sort_by(|left, right| left.0.cmp(right.0));
        if children.len() > 1 { return Err(invalid_ancestry("StableCoin coin-NFT mint lineage forks", "snapshot.payload.parents")); }
        let Some((txid, child)) = children.first().copied() else { break };
        validate_stablecoin_mint_transition(
            child, parents, &code, &hold, &admin_hash,
            &initial.nft_name, &initial.nft_symbol, &initial.description, initial.coin_decimal,
            &creation_tape.name, &creation_tape.symbol, supply,
        )?;
        let updated_script = &child.transaction.outputs[2].script_pubkey;
        let updated = decode_coin_nft_tape_script(updated_script)
            .map_err(|_| invalid_ancestry("StableCoin updated coin-NFT state is malformed", "snapshot.payload.parents"))?;
        if coin_nft_tape_script(&updated).map_err(|_| invalid_ancestry("StableCoin updated coin-NFT state cannot be canonicalized", "snapshot.payload.parents"))? != *updated_script {
            return Err(invalid_ancestry("StableCoin updated coin-NFT state is not canonically encoded", "snapshot.payload.parents"));
        }
        let next_supply = updated.coin_total_supply.parse::<u128>().map_err(|_| invalid_ancestry("StableCoin cumulative supply exceeds uint128", "snapshot.payload.parents"))?;
        if updated.coin_total_supply != next_supply.to_string() {
            return Err(invalid_ancestry("StableCoin cumulative supply is not a canonical decimal string", "snapshot.payload.parents"));
        }
        supply = next_supply;
        current = txid.clone();
        visited.insert(current.clone());
        supplies.insert(current.clone(), supply);
        if supplies.len() > 1_024 { return Err(invalid_ancestry("StableCoin mint lineage exceeds the ancestry limit", "snapshot.payload.parents")); }
    }
    for (txid, item) in parents {
        if visited.contains(txid) { continue; }
        if item.transaction.outputs.len() >= 3
            && item.transaction.outputs[0] == code
            && item.transaction.outputs[1] == hold
            && decode_coin_nft_tape_script(&item.transaction.outputs[2].script_pubkey).is_ok()
        {
            return Err(invalid_ancestry("StableCoin mint lineage is skipped, forked, or rebased", "snapshot.payload.parents"));
        }
    }
    let _ = coin_nft;
    Ok(supplies)
}

fn validate_stablecoin_mint_transition(
    child: &VerifiedParent,
    parents: &BTreeMap<String, VerifiedParent>,
    coin_nft_code: &tbc_sdk::TxOut,
    coin_nft_hold: &tbc_sdk::TxOut,
    admin_hash: &[u8; 20],
    nft_name: &str,
    nft_symbol: &str,
    description: &str,
    coin_decimal: u8,
    coin_name: &str,
    coin_symbol: &str,
    previous_supply: u128,
) -> Result<(), EngineError> {
    let tx = &child.transaction;
    if tx.inputs.len() != 3 || !(5..=7).contains(&tx.outputs.len()) || tx.lock_time != 0 {
        return Err(invalid_ancestry("StableCoin mint transition topology is invalid", "snapshot.payload.parents"));
    }
    if tx.outputs[0] != *coin_nft_code || tx.outputs[1] != *coin_nft_hold || tx.outputs[2].satoshis != 0 {
        return Err(invalid_ancestry("StableCoin mint transition mutates coin-NFT code or owner", "snapshot.payload.parents"));
    }
    let funding = &tx.inputs[2].previous_output;
    if parents.get(&funding.txid.to_string()).and_then(|item| item.transaction.outputs.get(funding.vout as usize)).is_none() {
        return Err(invalid_ancestry("StableCoin mint funding outpoint is missing", "snapshot.payload.parents"));
    }
    let updated_script = &tx.outputs[2].script_pubkey;
    let updated = decode_coin_nft_tape_script(updated_script).map_err(|_| invalid_ancestry("StableCoin updated coin-NFT Tape is invalid", "snapshot.payload.parents"))?;
    if coin_nft_tape_script(&updated).map_err(|_| invalid_ancestry("StableCoin updated coin-NFT Tape cannot be canonicalized", "snapshot.payload.parents"))? != *updated_script {
        return Err(invalid_ancestry("StableCoin updated coin-NFT Tape is not canonically encoded", "snapshot.payload.parents"));
    }
    if updated.nft_name != nft_name || updated.nft_symbol != nft_symbol || updated.description != description || updated.coin_decimal != coin_decimal {
        return Err(invalid_ancestry("StableCoin mint transition mutates immutable coin-NFT state", "snapshot.payload.parents"));
    }
    let next_supply = updated.coin_total_supply.parse::<u128>().map_err(|_| invalid_ancestry("StableCoin cumulative supply exceeds uint128", "snapshot.payload.parents"))?;
    if next_supply > MAX_STABLECOIN_SUPPLY_RAW {
        return Err(invalid_ancestry("StableCoin cumulative supply exceeds 10^18 raw units", "snapshot.payload.parents"));
    }
    let tranche = next_supply.checked_sub(previous_supply).filter(|value| *value > 0).ok_or_else(|| invalid_ancestry("StableCoin cumulative supply must increase", "snapshot.payload.parents"))?;
    let code = &tx.outputs[3];
    let tape = &tx.outputs[4];
    let tape_data = parse_tape(&tape.script_pubkey)?;
    if tape_data.name != coin_name {
        return Err(invalid_ancestry("StableCoin name changed across mint lineage", "snapshot.payload.parents"));
    }
    if tape_data.symbol != coin_symbol {
        return Err(invalid_ancestry("StableCoin symbol changed across mint lineage", "snapshot.payload.parents"));
    }
    if tape_data.lock_time != Some(0) {
        return Err(invalid_ancestry("StableCoin minted Tape lock time must be zero", "snapshot.payload.parents"));
    }
    let expected_tape = expected_stablecoin_mint_tape(tranche, coin_decimal, coin_name, coin_symbol)?;
    if code.satoshis != FT_CODE_SATOSHIS || tape.satoshis != FT_TAPE_SATOSHIS || tape_data.balance_raw != tranche || tape_data.decimal != coin_decimal || tape.script_pubkey != expected_tape {
        return Err(invalid_ancestry("StableCoin minted tranche does not match cumulative supply", "snapshot.payload.parents"));
    }
    let receiver = Address::from_hash160(receiver_hash(&code.script_pubkey)?);
    let expected = coin_mint_code_script_with_version(admin_hash, &receiver, &coin_nft_code.script_pubkey.sha256(), expected_tape.as_bytes().len(), StableCoinMintVersion::V4)
        .map_err(|_| invalid_ancestry("StableCoin mint code cannot be reconstructed", "snapshot.payload.parents"))?;
    if code.script_pubkey != expected { return Err(invalid_ancestry("StableCoin minted tranche is linked to the wrong issuer or coin-NFT", "snapshot.payload.parents")); }
    validate_stablecoin_mint_suffix(&tx.outputs[5..])?;
    Ok(())
}

fn expected_stablecoin_mint_tape(
    tranche: u128,
    decimal: u8,
    name: &str,
    symbol: &str,
) -> Result<Script, EngineError> {
    let amount = amount_slot(tranche).map_err(|_| invalid_ancestry("StableCoin minted tranche exceeds the pinned amount slot", "snapshot.payload.parents"))?;
    Ok(coin_tape_script(&amount, decimal, name, symbol, 0))
}

fn validate_stablecoin_mint_suffix(outputs: &[tbc_sdk::TxOut]) -> Result<(), EngineError> {
    let is_message = |output: &tbc_sdk::TxOut| output.satoshis == 0 && output.script_pubkey.as_bytes().starts_with(&[0x00, 0x6a]);
    let is_change = |output: &tbc_sdk::TxOut| {
        let bytes = output.script_pubkey.as_bytes();
        output.satoshis > 0 && bytes.len() == 25 && bytes.starts_with(&[0x76, 0xa9, 0x14]) && bytes.ends_with(&[0x88, 0xac])
    };
    let valid = match outputs {
        [] => true,
        [only] => is_message(only) || is_change(only),
        [message, change] => is_message(message) && is_change(change),
        _ => false,
    };
    if !valid {
        return Err(invalid_ancestry("StableCoin mint transition output count or suffix order is invalid", "snapshot.payload.parents"));
    }
    Ok(())
}

fn validate_stablecoin_direct_holding(
    txid: &str,
    vout: u32,
    parents: &BTreeMap<String, VerifiedParent>,
    mint_supplies: &BTreeMap<String, u128>,
) -> Result<(), EngineError> {
    if vout == 3 && mint_supplies.contains_key(txid) { return Ok(()); }
    let fail = |message| invalid_ancestry(message, "snapshot.payload.parents");
    let parent = parents.get(txid).ok_or_else(|| fail("StableCoin holding parent is missing"))?;
    let code = parent.transaction.outputs.get(vout as usize).ok_or_else(|| fail("StableCoin holding code is missing"))?;
    let tape = parent.transaction.outputs.get(vout as usize + 1).ok_or_else(|| fail("StableCoin holding Tape is missing"))?;
    let data = parse_tape(&tape.script_pubkey)?;
    let receiver = Address::from_hash160(receiver_hash(&code.script_pubkey)?);
    let mut expected_lock = 0;
    let mut referenced = false;
    for (index, amount) in data.slots.iter().enumerate() {
        if *amount == 0 { continue; }
        referenced = true;
        let input = parent.transaction.inputs.get(index).ok_or_else(|| fail("StableCoin Tape source is missing"))?;
        if input.sequence != tbc_sdk::contracts::stable_coin::scripts::COIN_FT_SEQUENCE {
            return Err(fail("StableCoin source input sequence is invalid"));
        }
        let source = parents.get(&input.previous_output.txid.to_string()).ok_or_else(|| fail("StableCoin direct source is missing"))?;
        let source_code = source.transaction.outputs.get(input.previous_output.vout as usize).ok_or_else(|| fail("StableCoin direct source output is missing"))?;
        let source_tape = source.transaction.outputs.get(input.previous_output.vout as usize + 1).ok_or_else(|| fail("StableCoin direct source Tape is missing"))?;
        let source_data = parse_tape(&source_tape.script_pubkey)?;
        let normalized = transfer_code_script(&source_code.script_pubkey, FtCodeReceiver::Address(receiver.clone()))
            .map_err(|_| fail("StableCoin direct source code is invalid"))?;
        if normalized != code.script_pubkey || source_code.satoshis != FT_CODE_SATOSHIS || source_tape.satoshis != 0
            || source_data.decimal != data.decimal || source_data.name != data.name || source_data.symbol != data.symbol
            || u128::from(*amount) > source_data.balance_raw {
            return Err(fail("StableCoin direct source identity or amount mismatch"));
        }
        expected_lock = expected_lock.max(source_data.lock_time.ok_or_else(|| fail("StableCoin direct source lockTime is missing"))?);
    }
    if !referenced || parent.transaction.lock_time != expected_lock {
        return Err(fail("StableCoin transaction lockTime does not match selected Tape state"));
    }
    Ok(())
}

#[cfg(test)]
fn authenticate_stablecoin_holding_lineage(
    txid: &str,
    vout: u32,
    parents: &BTreeMap<String, VerifiedParent>,
    mint_supplies: &BTreeMap<String, u128>,
    traversal: &mut StablecoinHoldingTraversal,
) -> Result<u128, EngineError> {
    traversal.work = traversal.work.checked_add(1).ok_or_else(|| {
        invalid_ancestry(
            "StableCoin holding ancestry work counter overflow",
            "snapshot.payload.parents",
        )
    })?;
    if traversal.work > MAX_STABLECOIN_HOLDING_WORK {
        return Err(invalid_ancestry(
            "StableCoin holding ancestry exceeds the work limit",
            "snapshot.payload.parents",
        ));
    }
    let key = (txid.to_owned(), vout);
    if let Some(supply) = traversal.completed.get(&key) {
        return Ok(*supply);
    }
    if traversal.active.contains(&key) {
        return Err(invalid_ancestry(
            "StableCoin holding ancestry is cyclic",
            "snapshot.payload.parents",
        ));
    }
    if traversal.unique.insert(key.clone())
        && traversal.unique.len() > MAX_STABLECOIN_HOLDING_NODES
    {
        return Err(invalid_ancestry(
            "StableCoin holding ancestry exceeds the unique-node limit",
            "snapshot.payload.parents",
        ));
    }
    traversal.active.insert(key.clone());
    let result = (|| {
        if vout == 3 {
            if let Some(supply) = mint_supplies.get(txid) {
                return Ok(*supply);
            }
        }
        let parent = parents.get(txid).ok_or_else(|| invalid_ancestry("StableCoin holding parent is missing", "snapshot.payload.parents"))?;
        let code = parent.transaction.outputs.get(vout as usize).ok_or_else(|| invalid_ancestry("StableCoin holding output is missing", "snapshot.payload.parents"))?;
        let tape = parent.transaction.outputs.get(vout as usize + 1).ok_or_else(|| invalid_ancestry("StableCoin holding Tape is missing", "snapshot.payload.parents"))?;
        let info = classify_ft_script(&code.script_pubkey).map_err(|_| invalid_ancestry("StableCoin holding code is unsupported", "snapshot.payload.parents"))?;
        let tape_data = parse_tape(&tape.script_pubkey)?;
        if !info.is_coin || tape_data.lock_time.is_none() { return Err(invalid_ancestry("StableCoin holding substituted ordinary FT state", "snapshot.payload.parents")); }
        let mut max_supply = 0u128;
        let mut expected_lock_time = 0u32;
        for index in (0..tape_data.slots.len()).rev() {
            if tape_data.slots[index] == 0 { continue; }
            let input = parent.transaction.inputs.get(index).ok_or_else(|| invalid_ancestry("StableCoin Tape references a missing source input", "snapshot.payload.parents"))?;
            if input.sequence != tbc_sdk::contracts::stable_coin::scripts::COIN_FT_SEQUENCE {
                return Err(invalid_ancestry("StableCoin source input sequence is invalid", "snapshot.payload.parents"));
            }
            let source_txid = input.previous_output.txid.to_string();
            let source = parents.get(&source_txid).ok_or_else(|| invalid_ancestry("StableCoin source parent is missing", "snapshot.payload.parents"))?;
            let source_tape = source.transaction.outputs.get(input.previous_output.vout as usize + 1).ok_or_else(|| invalid_ancestry("StableCoin source Tape is missing", "snapshot.payload.parents"))?;
            let source_lock = parse_tape(&source_tape.script_pubkey)?.lock_time.ok_or_else(|| invalid_ancestry("StableCoin source Tape is missing lockTime", "snapshot.payload.parents"))?;
            expected_lock_time = expected_lock_time.max(source_lock);
            max_supply = max_supply.max(authenticate_stablecoin_holding_lineage(&source_txid, input.previous_output.vout, parents, mint_supplies, traversal)?);
        }
        if max_supply == 0 || parent.transaction.lock_time != expected_lock_time {
            return Err(invalid_ancestry("StableCoin transaction lockTime does not match selected Tape state", "snapshot.payload.parents"));
        }
        Ok(max_supply)
    })();
    traversal.active.remove(&key);
    if let Ok(supply) = &result {
        traversal.completed.insert(key, *supply);
    }
    result
}

fn authenticate_stablecoin_genesis(
    creation: &VerifiedParent,
    parents: &BTreeMap<String, VerifiedParent>,
) -> Result<(Script, Script), EngineError> {
    let transaction = &creation.transaction;
    if transaction.inputs.len() != 3 || transaction.outputs.len() < 5 {
        return Err(invalid_ancestry(
            "StableCoin creation transaction has invalid coin-NFT topology",
            "snapshot.payload.parents",
        ));
    }
    let coin_nft_txid = transaction.inputs[0].previous_output.txid;
    for (index, vout) in [0u32, 1, 3].into_iter().enumerate() {
        let input = &transaction.inputs[index];
        if input.previous_output.txid != coin_nft_txid || input.previous_output.vout != vout {
            return Err(invalid_ancestry(
                "StableCoin creation inputs must spend coin-NFT outputs 0, 1, and 3",
                "snapshot.payload.parents",
            ));
        }
    }
    let coin_nft = parents.get(&coin_nft_txid.to_string()).ok_or_else(|| {
        invalid_ancestry("StableCoin coin-NFT parent is missing", "snapshot.payload.parents")
    })?;
    if coin_nft.transaction.inputs.len() != 1 || coin_nft.transaction.outputs.len() != 4 {
        return Err(invalid_ancestry(
            "StableCoin coin-NFT transaction has invalid topology",
            "snapshot.payload.parents",
        ));
    }
    let funding_outpoint = &coin_nft.transaction.inputs[0].previous_output;
    let funding = parents.get(&funding_outpoint.txid.to_string()).ok_or_else(|| {
        invalid_ancestry("StableCoin coin-NFT funding parent is missing", "snapshot.payload.parents")
    })?;
    if funding.transaction.outputs.get(funding_outpoint.vout as usize).is_none() {
        return Err(invalid_ancestry(
            "StableCoin coin-NFT funding outpoint is missing",
            "snapshot.payload.parents",
        ));
    }
    let nft_code = &coin_nft.transaction.outputs[0];
    let nft_hold = &coin_nft.transaction.outputs[1];
    let nft_tape = &coin_nft.transaction.outputs[2];
    let expected_nft_code = coin_nft_code_script(
        &funding_outpoint.txid.to_string(),
        funding_outpoint.vout,
    )
    .map_err(|_| invalid_ancestry("StableCoin coin-NFT origin cannot be reconstructed", "snapshot.payload.parents"))?;
    if nft_code.satoshis != 200 || nft_hold.satoshis != 100 || nft_tape.satoshis != 0 {
        return Err(invalid_ancestry(
            "StableCoin coin-NFT output values are invalid",
            "snapshot.payload.parents",
        ));
    }
    let legacy_prefix = fixed_hex("5179537f01147f756b756ba87e6c7e786b6b7e6c7ea87e7801247f756b6ba87e6c7eaa56ba01207f547f7581008888786b7e7ea87e7e7eaa6c6c7601207f816b537a887c6c6c766b7b87630088756775");
    let legacy_suffix = fixed_hex("8868786c887e7ea857ba8876a96c88ac6a0533436f6465");
    let mut origin = funding_outpoint.txid.as_le_bytes().to_vec();
    origin.extend_from_slice(&funding_outpoint.vout.to_le_bytes());
    let actual_code = nft_code.script_pubkey.as_bytes();
    let legacy_origin_is_bound = actual_code.starts_with(&legacy_prefix)
        && actual_code.ends_with(&legacy_suffix)
        && actual_code.get(legacy_prefix.len()) == Some(&0x24)
        && actual_code.get(legacy_prefix.len() + 1..legacy_prefix.len() + 37)
            == Some(origin.as_slice())
        && actual_code.len() == legacy_prefix.len() + 1 + origin.len() + legacy_suffix.len();
    if nft_code.script_pubkey != expected_nft_code && !legacy_origin_is_bound {
        return Err(invalid_ancestry(
            "StableCoin coin-NFT origin code is invalid",
            "snapshot.payload.parents",
        ));
    }
    if transaction.outputs[0] != *nft_code {
        return Err(invalid_ancestry(
            "StableCoin creation does not preserve the authenticated coin-NFT code",
            "snapshot.payload.parents",
        ));
    }
    if transaction.outputs[1] != *nft_hold {
        return Err(invalid_ancestry(
            "StableCoin creation does not preserve the authenticated coin-NFT hold",
            "snapshot.payload.parents",
        ));
    }
    if transaction.outputs[2].satoshis != 0 {
        return Err(invalid_ancestry(
            "StableCoin creation coin-NFT state value is invalid",
            "snapshot.payload.parents",
        ));
    }
    let hold_bytes = nft_hold.script_pubkey.as_bytes();
    let admin_hash: [u8; 20] = hold_bytes.get(3..23)
        .ok_or_else(|| invalid_ancestry("StableCoin coin-NFT admin hash is missing", "snapshot.payload.parents"))?
        .try_into()
        .map_err(|_| invalid_ancestry("StableCoin coin-NFT admin hash width is invalid", "snapshot.payload.parents"))?;
    let initial_nft = decode_coin_nft_tape_script(&nft_tape.script_pubkey)
        .map_err(|_| invalid_ancestry("StableCoin coin-NFT Tape is invalid", "snapshot.payload.parents"))?;
    if coin_nft_tape_script(&initial_nft).map_err(|_| invalid_ancestry("StableCoin coin-NFT Tape cannot be canonicalized", "snapshot.payload.parents"))? != nft_tape.script_pubkey {
        return Err(invalid_ancestry("StableCoin coin-NFT Tape is not canonically encoded", "snapshot.payload.parents"));
    }
    let updated_nft = decode_coin_nft_tape_script(&transaction.outputs[2].script_pubkey)
        .map_err(|_| invalid_ancestry("StableCoin updated coin-NFT Tape is invalid", "snapshot.payload.parents"))?;
    if coin_nft_tape_script(&updated_nft).map_err(|_| invalid_ancestry("StableCoin updated coin-NFT Tape cannot be canonicalized", "snapshot.payload.parents"))? != transaction.outputs[2].script_pubkey {
        return Err(invalid_ancestry("StableCoin updated coin-NFT Tape is not canonically encoded", "snapshot.payload.parents"));
    }
    if initial_nft.coin_total_supply != "0"
        || initial_nft.nft_name != updated_nft.nft_name
        || initial_nft.nft_symbol != updated_nft.nft_symbol
        || initial_nft.description != updated_nft.description
        || initial_nft.coin_decimal != updated_nft.coin_decimal
        || nft_hold.script_pubkey != coin_nft_hold_script_from_hash(&admin_hash, &initial_nft.nft_name)
    {
        return Err(invalid_ancestry(
            "StableCoin coin-NFT immutable state or administrator is inconsistent",
            "snapshot.payload.parents",
        ));
    }
    let code = &transaction.outputs[3];
    let tape = &transaction.outputs[4];
    if code.satoshis != FT_CODE_SATOSHIS || tape.satoshis != FT_TAPE_SATOSHIS {
        return Err(invalid_ancestry(
            "StableCoin creation code and Tape output roles are inconsistent",
            "snapshot.payload.parents",
        ));
    }
    let tape_data = parse_tape(&tape.script_pubkey)?;
    if tape_data.lock_time.is_none()
        || initial_nft.coin_decimal != tape_data.decimal
        || initial_nft.nft_name != format!("{} NFT", tape_data.name)
        || initial_nft.nft_symbol != format!("{} NFT", tape_data.symbol)
        || updated_nft.coin_total_supply != tape_data.balance_raw.to_string()
    {
        return Err(invalid_ancestry(
            "StableCoin coin-NFT and fungible Tape state are inconsistent",
            "snapshot.payload.parents",
        ));
    }
    let receiver = Address::from_hash160(receiver_hash(&code.script_pubkey)?);
    let expected_code = coin_mint_code_script_with_version(
        &admin_hash,
        &receiver,
        &nft_code.script_pubkey.sha256(),
        tape.script_pubkey.as_bytes().len(),
        StableCoinMintVersion::V4,
    )
    .map_err(|_| invalid_ancestry("StableCoin mint code cannot be reconstructed", "snapshot.payload.parents"))?;
    if code.script_pubkey != expected_code {
        return Err(invalid_ancestry(
            "StableCoin code does not bind the authenticated coin-NFT state",
            "snapshot.payload.parents",
        ));
    }
    Ok((code.script_pubkey.clone(), tape.script_pubkey.clone()))
}

fn unique_contract<'a>(
    contracts: &'a [ContractRecord],
    contract_id: &str,
) -> Result<&'a ContractRecord, EngineError> {
    let matches = contracts
        .iter()
        .filter(|record| record.contract_id == contract_id)
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(invalid_ancestry(
            "snapshot must contain exactly one requested FT contract record",
            "snapshot.payload.contracts",
        ));
    }
    Ok(matches[0])
}

fn parse_parent_map(
    snapshot: &ChainSnapshot,
) -> Result<BTreeMap<String, VerifiedParent>, EngineError> {
    let mut total = 0usize;
    let mut result = BTreeMap::new();
    for (index, item) in snapshot.payload.parents.iter().enumerate() {
        let raw_bytes = item.raw_transaction.len().checked_div(2).ok_or_else(|| {
            invalid_ancestry("parent byte length overflow", "snapshot.payload.parents")
        })?;
        total = total.checked_add(raw_bytes).ok_or_else(|| {
            invalid_ancestry("parent byte budget overflow", "snapshot.payload.parents")
        })?;
        if raw_bytes > MAX_PARENT_RAW_BYTES || total > MAX_ANCESTRY_RAW_BYTES {
            return Err(error(
                ErrorCode::InvalidInput,
                "FT ancestry exceeds the raw transaction byte budget",
                "snapshot.payload.parents",
            ));
        }
        let transaction = Transaction::from_hex(&item.raw_transaction).map_err(|_| {
            invalid_ancestry(
                "parent transaction is malformed",
                &format!("snapshot.payload.parents[{index}].rawTransaction"),
            )
        })?;
        let canonical_txid = transaction.txid().to_string();
        if item.txid != canonical_txid || transaction.to_hex() != item.raw_transaction {
            return Err(invalid_ancestry(
                "parent transaction identifier or encoding is inconsistent",
                &format!("snapshot.payload.parents[{index}]"),
            ));
        }
        if result
            .insert(
                item.txid.clone(),
                VerifiedParent {
                    transaction,
                    raw: item.raw_transaction.clone(),
                },
            )
            .is_some()
        {
            return Err(invalid_ancestry(
                "duplicate parent transaction",
                "snapshot.payload.parents",
            ));
        }
    }
    Ok(result)
}

fn authenticate_v4_genesis(
    creation: &VerifiedParent,
    parents: &BTreeMap<String, VerifiedParent>,
) -> Result<(Script, Script), EngineError> {
    let transaction = &creation.transaction;
    if transaction.inputs.len() != 1 || transaction.outputs.len() < 2 {
        return Err(invalid_ancestry(
            "FT creation transaction has invalid V4 topology",
            "snapshot.payload.parents",
        ));
    }
    let source_outpoint = &transaction.inputs[0].previous_output;
    if source_outpoint.vout != 0 {
        return Err(invalid_ancestry(
            "FT V4 creation must spend source output zero",
            "snapshot.payload.parents",
        ));
    }
    let source = parents
        .get(&source_outpoint.txid.to_string())
        .ok_or_else(|| invalid_ancestry("FT mint source transaction is missing", "snapshot.payload.parents"))?;
    if source.transaction.outputs.len() < 2 {
        return Err(invalid_ancestry(
            "FT mint source transaction has invalid V4 topology",
            "snapshot.payload.parents",
        ));
    }
    let code = &transaction.outputs[0];
    let tape = &transaction.outputs[1];
    let source_code = &source.transaction.outputs[0];
    let source_tape = &source.transaction.outputs[1];
    if code.satoshis != FT_CODE_SATOSHIS
        || tape.satoshis != FT_TAPE_SATOSHIS
        || source_code.satoshis != FT_MINT_SOURCE_SATOSHIS
        || source_tape.satoshis != FT_TAPE_SATOSHIS
        || tape.script_pubkey != source_tape.script_pubkey
    {
        return Err(invalid_ancestry(
            "FT V4 source and creation output roles are inconsistent",
            "snapshot.payload.parents",
        ));
    }
    let receiver_hash = receiver_hash(&code.script_pubkey)?;
    let receiver = Address::from_hash160(receiver_hash);
    if source_code.script_pubkey != mint_source_script(&receiver) {
        return Err(invalid_ancestry(
            "FT V4 mint source script does not match the genesis receiver",
            "snapshot.payload.parents",
        ));
    }
    let expected_code = mint_code_script_with_version(
        &source.transaction.txid().to_string(),
        0,
        &receiver,
        tape.script_pubkey.as_bytes().len(),
        FtMintVersion::V4,
    )
    .map_err(|_| invalid_ancestry("FT V4 mint code reconstruction failed", "snapshot.payload.parents"))?;
    if code.script_pubkey != expected_code {
        return Err(invalid_ancestry(
            "FT V4 mint code does not bind the authenticated source outpoint",
            "snapshot.payload.parents",
        ));
    }
    parse_tape(&tape.script_pubkey)?;
    Ok((code.script_pubkey.clone(), tape.script_pubkey.clone()))
}

fn receiver_hash(script: &Script) -> Result<[u8; 20], EngineError> {
    let bytes = script.as_bytes();
    let marker_start = bytes
        .windows(5)
        .rposition(|window| window == b"2Code")
        .ok_or_else(|| invalid_ancestry("FT code marker is missing", "snapshot.payload.parents"))?;
    let receiver_start = marker_start
        .checked_sub(22)
        .ok_or_else(|| invalid_ancestry("FT receiver chunk is missing", "snapshot.payload.parents"))?;
    let push_start = marker_start
        .checked_sub(23)
        .ok_or_else(|| invalid_ancestry("FT receiver push is missing", "snapshot.payload.parents"))?;
    if bytes.get(push_start) != Some(&21)
        || bytes.get(receiver_start + 20) != Some(&0)
        || bytes.get(marker_start - 1) != Some(&5)
    {
        return Err(invalid_ancestry(
            "FT genesis receiver is not an address receiver",
            "snapshot.payload.parents",
        ));
    }
    bytes[receiver_start..receiver_start + 20]
        .try_into()
        .map_err(|_| invalid_ancestry("FT receiver hash width is invalid", "snapshot.payload.parents"))
}

fn parse_tape(script: &Script) -> Result<TapeData, EngineError> {
    let bytes = script.as_bytes();
    if bytes.len() < 60 || !bytes.starts_with(TAPE_PREFIX) || !bytes.ends_with(TAPE_MARKER) {
        return Err(invalid_ancestry(
            "FT Tape framing is invalid",
            "snapshot.payload.parents",
        ));
    }
    let amount = bytes.get(3..51).ok_or_else(|| {
        invalid_ancestry("FT Tape amount is truncated", "snapshot.payload.parents")
    })?;
    let mut slots = [0u64; 6];
    for (index, chunk) in amount.chunks_exact(8).enumerate() {
        slots[index] = u64::from_le_bytes(chunk.try_into().expect("eight-byte FT slot"));
    }
    let balance_raw = balance_from_tape(script).map_err(|_| {
        invalid_ancestry("FT Tape balance is invalid", "snapshot.payload.parents")
    })?;
    let mut offset = 51usize;
    let decimal = take_push(bytes, &mut offset)?;
    let name = take_push(bytes, &mut offset)?;
    let symbol = take_push(bytes, &mut offset)?;
    let next = take_push(bytes, &mut offset)?;
    let (lock_time, marker) = if next == TAPE_MARKER {
        (None, next)
    } else {
        if next.len() != 4 {
            return Err(invalid_ancestry("StableCoin Tape lockTime width is invalid", "snapshot.payload.parents"));
        }
        (Some(u32::from_le_bytes(next.try_into().expect("four-byte lockTime"))), take_push(bytes, &mut offset)?)
    };
    if decimal.len() != 1 || marker != TAPE_MARKER || offset != bytes.len() {
        return Err(invalid_ancestry(
            "FT Tape metadata layout is invalid",
            "snapshot.payload.parents",
        ));
    }
    let name = std::str::from_utf8(name)
        .map_err(|_| invalid_ancestry("FT name is not UTF-8", "snapshot.payload.parents"))?
        .to_owned();
    let symbol = std::str::from_utf8(symbol)
        .map_err(|_| invalid_ancestry("FT symbol is not UTF-8", "snapshot.payload.parents"))?
        .to_owned();
    Ok(TapeData {
        balance_raw,
        slots,
        decimal: decimal[0],
        name,
        symbol,
        lock_time,
    })
}

fn take_push<'a>(bytes: &'a [u8], offset: &mut usize) -> Result<&'a [u8], EngineError> {
    let opcode = *bytes.get(*offset).ok_or_else(|| {
        invalid_ancestry("FT Tape push is truncated", "snapshot.payload.parents")
    })?;
    *offset += 1;
    let length = match opcode {
        0..=75 => usize::from(opcode),
        0x4c => {
            let length = usize::from(*bytes.get(*offset).ok_or_else(|| {
                invalid_ancestry("FT Tape push is truncated", "snapshot.payload.parents")
            })?);
            *offset += 1;
            if length <= 75 {
                return Err(invalid_ancestry("FT Tape push is noncanonical", "snapshot.payload.parents"));
            }
            length
        }
        0x4d => {
            let end = offset.checked_add(2).ok_or_else(|| {
                invalid_ancestry("FT Tape push length overflow", "snapshot.payload.parents")
            })?;
            let encoded = bytes.get(*offset..end).ok_or_else(|| {
                invalid_ancestry("FT Tape push is truncated", "snapshot.payload.parents")
            })?;
            *offset = end;
            let length = usize::from(u16::from_le_bytes([encoded[0], encoded[1]]));
            if length <= 255 {
                return Err(invalid_ancestry("FT Tape push is noncanonical", "snapshot.payload.parents"));
            }
            length
        }
        _ => return Err(invalid_ancestry("FT Tape push opcode is unsupported", "snapshot.payload.parents")),
    };
    if length > 256 {
        return Err(invalid_ancestry(
            "FT Tape metadata push exceeds the supported source layout",
            "snapshot.payload.parents",
        ));
    }
    let end = offset.checked_add(length).ok_or_else(|| {
        invalid_ancestry("FT Tape push length overflow", "snapshot.payload.parents")
    })?;
    let value = bytes.get(*offset..end).ok_or_else(|| {
        invalid_ancestry("FT Tape push is truncated", "snapshot.payload.parents")
    })?;
    *offset = end;
    Ok(value)
}

#[cfg(test)]
mod metadata_push_tests {
    use super::take_push;

    #[test]
    fn accepts_bounded_canonical_direct_pushdata1_and_pushdata2() {
        for length in [1usize, 48, 75, 76, 255, 256] {
            let mut bytes = match length {
                0..=75 => vec![length as u8],
                76..=255 => vec![0x4c, length as u8],
                _ => vec![0x4d, 0, 1],
            };
            bytes.extend(vec![0x61; length]);
            let expected_end = bytes.len();
            bytes.push(0xaa);
            let mut offset = 0;
            assert_eq!(take_push(&bytes, &mut offset).unwrap(), vec![0x61; length]);
            assert_eq!(offset, expected_end);
        }
    }

    #[test]
    fn rejects_noncanonical_oversize_and_unsupported_pushes() {
        for prefix in [vec![0x4c, 75], vec![0x4d, 255, 0], vec![0x4d, 1, 1], vec![0x4e, 0, 1, 0, 0]] {
            let mut bytes = prefix;
            bytes.extend(vec![0x61; 300]);
            assert!(take_push(&bytes, &mut 0).is_err());
        }
    }

    #[test]
    fn rejects_truncated_push_prefixes_and_payloads() {
        for bytes in [vec![], vec![0x4c], vec![0x4d], vec![0x4d, 0], vec![2, 0x61], vec![0x4c, 76, 0x61], vec![0x4d, 0, 1, 0x61]] {
            assert!(take_push(&bytes, &mut 0).is_err());
        }
    }
}

fn proof_references(
    parent: &Transaction,
    output_index: u32,
    tape: &TapeData,
    parents: &BTreeMap<String, VerifiedParent>,
) -> Result<Vec<FtProofReference>, EngineError> {
    let mut references = Vec::new();
    let mut transactions = Vec::new();
    for input_index in (0..tape.slots.len()).rev() {
        if tape.slots[input_index] == 0 {
            continue;
        }
        let input = parent.inputs.get(input_index).ok_or_else(|| {
            invalid_ancestry(
                "FT Tape references a missing source input",
                "snapshot.payload.parents",
            )
        })?;
        let txid = input.previous_output.txid.to_string();
        let grandparent = parents.get(&txid).ok_or_else(|| {
            invalid_ancestry(
                "FT grandparent transaction is missing",
                "snapshot.payload.parents",
            )
        })?;
        transactions.push(grandparent.transaction.clone());
        references.push(FtProofReference {
            source: FtTransactionSource::Raw(grandparent.raw.clone()),
            output_index: input.previous_output.vout,
        });
    }
    if references.is_empty() {
        return Err(invalid_ancestry(
            "FT Tape does not commit to a source input",
            "snapshot.payload.parents",
        ));
    }
    pre_pre_tx_data_from_parents(parent, output_index as usize, &transactions).map_err(|_| {
        invalid_ancestry(
            "FT grandparent proof does not match the parent Tape",
            "snapshot.payload.parents",
        )
    })?;
    Ok(references)
}

fn validate_owner(script: &Script, owner_hash: &[u8; 20]) -> Result<(), EngineError> {
    let bytes = script.as_bytes();
    let marker_start = bytes
        .windows(5)
        .rposition(|window| window == b"2Code")
        .ok_or_else(|| invalid_ancestry("FT code marker is missing", "snapshot.payload.utxos"))?;
    let hash_start = marker_start.checked_sub(22).ok_or_else(|| {
        invalid_ancestry("FT owner chunk is missing", "snapshot.payload.utxos")
    })?;
    if bytes.get(hash_start..hash_start + 20) != Some(owner_hash.as_slice())
        || bytes.get(hash_start + 20) != Some(&0)
    {
        return Err(invalid_ancestry(
            "FT input is not controlled by the snapshot account",
            "snapshot.payload.utxos",
        ));
    }
    Ok(())
}

fn parse_u64(value: &str, path: &str) -> Result<u64, EngineError> {
    value.parse::<u64>().map_err(|_| {
        error(
            ErrorCode::InvalidInput,
            "amount exceeds uint64",
            path,
        )
    })
}

fn invalid_ancestry(message: &str, path: &str) -> EngineError {
    error(ErrorCode::InvalidAncestry, message, path)
}

#[cfg(test)]
mod task6_round1_tests {
    use super::*;
    use tbc_sdk::contracts::ft::amount::build_tape_amount;
    use tbc_sdk::{OutPoint, PrivateKey, StableCoin, Transaction, TxIn, TxOut, Txid, Utxo};

    fn key(value: u8) -> PrivateKey {
        let mut bytes = [0u8; 32];
        bytes[31] = value;
        PrivateKey::from_slice(&bytes).unwrap()
    }

    fn parent(marker: u8, satoshis: u64, owner: &PrivateKey) -> Transaction {
        Transaction {
            version: tbc_sdk::TX_VERSION,
            inputs: vec![TxIn::new(OutPoint { txid: Txid::from_le_bytes([marker; 32]), vout: marker as u32 })],
            outputs: vec![TxOut { satoshis, script_pubkey: owner.address().script_pubkey() }],
            lock_time: 0,
        }
    }

    fn utxo(transaction: &Transaction, owner: &PrivateKey, vout: u32) -> Utxo {
        let output = &transaction.outputs[vout as usize];
        Utxo { outpoint: OutPoint { txid: transaction.txid(), vout }, satoshis: output.satoshis, script_pubkey: output.script_pubkey.clone(), private_key: owner.clone() }
    }

    fn verified(transaction: Transaction) -> (String, VerifiedParent) {
        (transaction.txid().to_string(), VerifiedParent { raw: transaction.to_hex(), transaction })
    }

    fn coin_input(outpoint: OutPoint) -> TxIn {
        TxIn {
            previous_output: outpoint,
            script_sig: Script::empty(),
            sequence: tbc_sdk::contracts::stable_coin::scripts::COIN_FT_SEQUENCE,
        }
    }

    fn holding_tape(total: u128, balances: &[u128]) -> Script {
        let (slots, _) = build_tape_amount(total, balances).unwrap();
        coin_tape_script(&slots, 0, "Dollar", "USD", 0)
    }

    #[test]
    fn stablecoin_tape_requires_an_explicit_four_byte_lock_time() {
        use tbc_sdk::contracts::stable_coin::scripts::coin_tape_script;
        let mut amount = [0u8; 48];
        amount[..8].copy_from_slice(&1u64.to_le_bytes());
        let valid = coin_tape_script(&amount, 0, "Dollar", "USD", 0);
        assert_eq!(parse_tape(&valid).unwrap().lock_time, Some(0));
        let mut ordinary = valid.as_bytes().to_vec();
        let marker = ordinary.len() - 6;
        ordinary.drain(marker - 5..marker);
        assert_eq!(parse_tape(&Script::from_bytes(ordinary)).unwrap().lock_time, None);
        let mut malformed = valid.as_bytes().to_vec();
        let lock_push = malformed.len() - 11;
        malformed[lock_push] = 3;
        assert!(parse_tape(&Script::from_bytes(malformed)).is_err());
    }

    #[test]
    fn stablecoin_holding_accepts_split_remerge_spend_with_a_shared_ancestor() {
        let owner = key(1);
        let admin = key(3);
        let root = parent(0x71, 2_000_000, &owner);
        let coin_fee = Transaction {
            version: tbc_sdk::TX_VERSION,
            inputs: vec![TxIn::new(OutPoint { txid: root.txid(), vout: 0 })],
            outputs: vec![TxOut { satoshis: 1_000_000, script_pubkey: owner.address().script_pubkey() }],
            lock_time: 0,
        };
        let mut coin = StableCoin::new("Dollar".to_owned(), "USD".to_owned(), 600, 0).unwrap();
        let created = coin
            .create_coin(
                admin.x_only_public_key(),
                owner.clone(),
                owner.address(),
                utxo(&coin_fee, &owner, 0),
                root,
                None,
            )
            .unwrap()
            .finalize_with_admin_key(&admin)
            .unwrap();
        let holding_code = transfer_code_script(
            &created.mint.outputs[3].script_pubkey,
            FtCodeReceiver::Address(owner.address()),
        )
        .unwrap();
        let split = Transaction {
            version: tbc_sdk::TX_VERSION,
            inputs: vec![coin_input(OutPoint { txid: created.mint.txid(), vout: 3 })],
            outputs: vec![
                TxOut { satoshis: FT_CODE_SATOSHIS, script_pubkey: holding_code.clone() },
                TxOut { satoshis: FT_TAPE_SATOSHIS, script_pubkey: holding_tape(200, &[200]) },
                TxOut { satoshis: FT_CODE_SATOSHIS, script_pubkey: holding_code.clone() },
                TxOut { satoshis: FT_TAPE_SATOSHIS, script_pubkey: holding_tape(400, &[400]) },
            ],
            lock_time: 0,
        };
        let merged = Transaction {
            version: tbc_sdk::TX_VERSION,
            inputs: vec![
                coin_input(OutPoint { txid: split.txid(), vout: 0 }),
                coin_input(OutPoint { txid: split.txid(), vout: 2 }),
            ],
            outputs: vec![
                TxOut { satoshis: FT_CODE_SATOSHIS, script_pubkey: holding_code.clone() },
                TxOut { satoshis: FT_TAPE_SATOSHIS, script_pubkey: holding_tape(600, &[200, 400]) },
            ],
            lock_time: 0,
        };
        let spent = Transaction {
            version: tbc_sdk::TX_VERSION,
            inputs: vec![coin_input(OutPoint { txid: merged.txid(), vout: 0 })],
            outputs: vec![
                TxOut { satoshis: FT_CODE_SATOSHIS, script_pubkey: holding_code },
                TxOut { satoshis: FT_TAPE_SATOSHIS, script_pubkey: holding_tape(600, &[600]) },
            ],
            lock_time: 0,
        };
        let mint_txid = created.mint.txid().to_string();
        let parents = BTreeMap::from([
            verified(created.mint),
            verified(split),
            verified(merged),
            verified(spent.clone()),
        ]);
        let supplies = BTreeMap::from([(mint_txid, 600)]);
        let mut traversal = StablecoinHoldingTraversal::default();
        assert_eq!(
            authenticate_stablecoin_holding_lineage(
                &spent.txid().to_string(),
                0,
                &parents,
                &supplies,
                &mut traversal,
            )
            .unwrap(),
            600,
        );
        assert_eq!(traversal.unique.len(), 5);
        assert_eq!(traversal.completed.len(), 5);
        assert_eq!(traversal.work, 6, "the second path must reuse the validated mint node");
    }

    #[test]
    fn stablecoin_holding_rejects_a_real_active_path_cycle() {
        let owner = key(1);
        let admin = key(3);
        let root = parent(0x72, 2_000_000, &owner);
        let coin_fee = Transaction {
            version: tbc_sdk::TX_VERSION,
            inputs: vec![TxIn::new(OutPoint { txid: root.txid(), vout: 0 })],
            outputs: vec![TxOut { satoshis: 1_000_000, script_pubkey: owner.address().script_pubkey() }],
            lock_time: 0,
        };
        let mut coin = StableCoin::new("Dollar".to_owned(), "USD".to_owned(), 600, 0).unwrap();
        let created = coin
            .create_coin(admin.x_only_public_key(), owner.clone(), owner.address(), utxo(&coin_fee, &owner, 0), root, None)
            .unwrap()
            .finalize_with_admin_key(&admin)
            .unwrap();
        let holding_code = transfer_code_script(
            &created.mint.outputs[3].script_pubkey,
            FtCodeReceiver::Address(owner.address()),
        )
        .unwrap();
        let key_a = Txid::from_le_bytes([0xa1; 32]);
        let key_b = Txid::from_le_bytes([0xb2; 32]);
        let cyclic_parent = |source: Txid| Transaction {
            version: tbc_sdk::TX_VERSION,
            inputs: vec![coin_input(OutPoint { txid: source, vout: 0 })],
            outputs: vec![
                TxOut { satoshis: FT_CODE_SATOSHIS, script_pubkey: holding_code.clone() },
                TxOut { satoshis: FT_TAPE_SATOSHIS, script_pubkey: holding_tape(600, &[600]) },
            ],
            lock_time: 0,
        };
        let a = cyclic_parent(key_b);
        let b = cyclic_parent(key_a);
        let parents = BTreeMap::from([
            (key_a.to_string(), VerifiedParent { raw: a.to_hex(), transaction: a }),
            (key_b.to_string(), VerifiedParent { raw: b.to_hex(), transaction: b }),
        ]);
        let error = authenticate_stablecoin_holding_lineage(
            &key_a.to_string(),
            0,
            &parents,
            &BTreeMap::new(),
            &mut StablecoinHoldingTraversal::default(),
        )
        .unwrap_err();
        assert_eq!(error.message, "StableCoin holding ancestry is cyclic");
    }

    #[test]
    fn stablecoin_holding_keeps_a_separate_bounded_work_budget() {
        let mut traversal = StablecoinHoldingTraversal {
            work: MAX_STABLECOIN_HOLDING_WORK,
            ..StablecoinHoldingTraversal::default()
        };
        let error = authenticate_stablecoin_holding_lineage(
            &Txid::from_le_bytes([0xc3; 32]).to_string(),
            0,
            &BTreeMap::new(),
            &BTreeMap::new(),
            &mut traversal,
        )
        .unwrap_err();
        assert_eq!(error.message, "StableCoin holding ancestry exceeds the work limit");

        let mut traversal = StablecoinHoldingTraversal {
            unique: (0..MAX_STABLECOIN_HOLDING_NODES)
                .map(|index| (format!("{index:064x}"), 0))
                .collect(),
            ..StablecoinHoldingTraversal::default()
        };
        let error = authenticate_stablecoin_holding_lineage(
            &"f".repeat(64),
            0,
            &BTreeMap::new(),
            &BTreeMap::new(),
            &mut traversal,
        )
        .unwrap_err();
        assert_eq!(
            error.message,
            "StableCoin holding ancestry exceeds the unique-node limit"
        );
    }

    #[test]
    fn stablecoin_authenticates_multiple_mint_transitions() {
        let owner = key(1);
        let admin = key(3);
        let root = parent(0x31, 2_000_000, &owner);
        let coin_fee = Transaction {
            version: tbc_sdk::TX_VERSION,
            inputs: vec![TxIn::new(OutPoint { txid: root.txid(), vout: 0 })],
            outputs: vec![TxOut { satoshis: 1_000_000, script_pubkey: owner.address().script_pubkey() }],
            lock_time: 0,
        };
        let mut coin = StableCoin::new("Dollar".to_owned(), "USD".to_owned(), 600, 0).unwrap();
        let prepared = coin.create_coin(admin.x_only_public_key(), owner.clone(), owner.address(), utxo(&coin_fee, &owner, 0), root.clone(), None).unwrap();
        let created = prepared.finalize_with_admin_key(&admin).unwrap();
        let later_fee = parent(0x32, 1_000_000, &owner);
        let later = coin.mint_coin(admin.x_only_public_key(), owner.clone(), owner.address(), 200, utxo(&later_fee, &owner, 0), created.mint.clone(), created.coin_nft.clone(), None).unwrap().finalize_with_admin_key(&admin).unwrap();
        let final_fee = parent(0x34, 1_000_000, &owner);
        let final_mint = coin.mint_coin(admin.x_only_public_key(), owner.clone(), owner.address(), 100, utxo(&final_fee, &owner, 0), later.clone(), created.mint.clone(), None).unwrap().finalize_with_admin_key(&admin).unwrap();
        let mut parents = BTreeMap::from([
            verified(root), verified(coin_fee), verified(created.coin_nft.clone()), verified(created.mint.clone()), verified(later_fee), verified(later.clone()), verified(final_fee), verified(final_mint.clone()),
        ]);
        let creation_tape = parse_tape(&created.mint.outputs[4].script_pubkey).unwrap();
        let supplies = authenticate_stablecoin_mint_lineage(parents.get(&created.mint.txid().to_string()).unwrap(), &parents, &creation_tape).unwrap();
        assert_eq!(supplies.get(&created.mint.txid().to_string()), Some(&600));
        assert_eq!(supplies.get(&later.txid().to_string()), Some(&800));
        assert_eq!(supplies.get(&final_mint.txid().to_string()), Some(&900));

        let fork_fee = parent(0x33, 1_000_000, &owner);
        let mut fork_coin = StableCoin::new("Dollar".to_owned(), "USD".to_owned(), 600, 0).unwrap();
        let fork = fork_coin.mint_coin(admin.x_only_public_key(), owner.clone(), owner.address(), 100, utxo(&fork_fee, &owner, 0), created.mint.clone(), created.coin_nft.clone(), None).unwrap().finalize_with_admin_key(&admin).unwrap();
        parents.extend([verified(fork_fee), verified(fork)]);
        assert!(authenticate_stablecoin_mint_lineage(parents.get(&created.mint.txid().to_string()).unwrap(), &parents, &creation_tape).is_err());
    }

    #[test]
    fn stablecoin_mint_supply_limit_is_exact() {
        let owner = key(1);
        let admin = key(3);
        let root = parent(0x41, 2_000_000, &owner);
        let coin_fee = Transaction {
            version: tbc_sdk::TX_VERSION,
            inputs: vec![TxIn::new(OutPoint { txid: root.txid(), vout: 0 })],
            outputs: vec![TxOut { satoshis: 1_000_000, script_pubkey: owner.address().script_pubkey() }],
            lock_time: 0,
        };
        let mut coin = StableCoin::new("Dollar".to_owned(), "USD".to_owned(), MAX_STABLECOIN_SUPPLY_RAW - 1, 0).unwrap();
        let created = coin.create_coin(admin.x_only_public_key(), owner.clone(), owner.address(), utxo(&coin_fee, &owner, 0), root.clone(), None).unwrap().finalize_with_admin_key(&admin).unwrap();
        let limit_fee = parent(0x42, 1_000_000, &owner);
        let at_limit = coin.mint_coin(admin.x_only_public_key(), owner.clone(), owner.address(), 1, utxo(&limit_fee, &owner, 0), created.mint.clone(), created.coin_nft.clone(), None).unwrap().finalize_with_admin_key(&admin).unwrap();
        let creation_tape = parse_tape(&created.mint.outputs[4].script_pubkey).unwrap();
        let mut parents = BTreeMap::from([verified(root), verified(coin_fee), verified(created.coin_nft.clone()), verified(created.mint.clone()), verified(limit_fee), verified(at_limit.clone())]);
        let supplies = authenticate_stablecoin_mint_lineage(parents.get(&created.mint.txid().to_string()).unwrap(), &parents, &creation_tape).unwrap();
        assert_eq!(supplies.get(&at_limit.txid().to_string()), Some(&MAX_STABLECOIN_SUPPLY_RAW));

        let over_fee = parent(0x43, 1_000_000, &owner);
        let mut over = at_limit.clone();
        over.inputs[0].previous_output = OutPoint { txid: at_limit.txid(), vout: 0 };
        over.inputs[1].previous_output = OutPoint { txid: at_limit.txid(), vout: 1 };
        over.inputs[2].previous_output = OutPoint { txid: over_fee.txid(), vout: 0 };
        over.outputs[2].script_pubkey = tbc_sdk::contracts::stable_coin::scripts::update_coin_nft_tape_script(&at_limit.outputs[2].script_pubkey, MAX_STABLECOIN_SUPPLY_RAW + 1).unwrap();
        over.outputs[4].script_pubkey = expected_stablecoin_mint_tape(1, 0, "Dollar", "USD").unwrap();
        parents.extend([verified(over_fee), verified(over)]);
        assert!(authenticate_stablecoin_mint_lineage(parents.get(&created.mint.txid().to_string()).unwrap(), &parents, &creation_tape).is_err());
    }

    #[test]
    fn stablecoin_mint_rejects_exact_tape_and_metadata_mutations() {
        let owner = key(1);
        let admin = key(3);
        let root = parent(0x51, 2_000_000, &owner);
        let coin_fee = Transaction { version: tbc_sdk::TX_VERSION, inputs: vec![TxIn::new(OutPoint { txid: root.txid(), vout: 0 })], outputs: vec![TxOut { satoshis: 1_000_000, script_pubkey: owner.address().script_pubkey() }], lock_time: 0 };
        let mut coin = StableCoin::new("Dollar".to_owned(), "USD".to_owned(), 600, 0).unwrap();
        let created = coin.create_coin(admin.x_only_public_key(), owner.clone(), owner.address(), utxo(&coin_fee, &owner, 0), root.clone(), None).unwrap().finalize_with_admin_key(&admin).unwrap();
        let mint_fee = parent(0x52, 1_000_000, &owner);
        let later = coin.mint_coin(admin.x_only_public_key(), owner.clone(), owner.address(), 200, utxo(&mint_fee, &owner, 0), created.mint.clone(), created.coin_nft.clone(), None).unwrap().finalize_with_admin_key(&admin).unwrap();
        let creation_tape = parse_tape(&created.mint.outputs[4].script_pubkey).unwrap();
        for tape in [
            expected_stablecoin_mint_tape(200, 0, "Eollar", "USD").unwrap(),
            expected_stablecoin_mint_tape(200, 0, "Dollar", "USX").unwrap(),
            coin_tape_script(&amount_slot(200).unwrap(), 0, "Dollar", "USD", 1),
            expected_stablecoin_mint_tape(199, 0, "Dollar", "USD").unwrap(),
        ] {
            let mut mutated = later.clone();
            mutated.outputs[4].script_pubkey = tape;
            let parents = BTreeMap::from([verified(root.clone()), verified(coin_fee.clone()), verified(created.coin_nft.clone()), verified(created.mint.clone()), verified(mint_fee.clone()), verified(mutated)]);
            assert!(authenticate_stablecoin_mint_lineage(parents.get(&created.mint.txid().to_string()).unwrap(), &parents, &creation_tape).is_err());
        }
    }

    #[test]
    fn stablecoin_mint_rejects_noncanonical_coin_nft_state_bytes() {
        let owner = key(1);
        let admin = key(3);
        let root = parent(0x61, 2_000_000, &owner);
        let coin_fee = Transaction { version: tbc_sdk::TX_VERSION, inputs: vec![TxIn::new(OutPoint { txid: root.txid(), vout: 0 })], outputs: vec![TxOut { satoshis: 1_000_000, script_pubkey: owner.address().script_pubkey() }], lock_time: 0 };
        let mut coin = StableCoin::new("Dollar".to_owned(), "USD".to_owned(), 600, 0).unwrap();
        let created = coin.create_coin(admin.x_only_public_key(), owner.clone(), owner.address(), utxo(&coin_fee, &owner, 0), root.clone(), None).unwrap().finalize_with_admin_key(&admin).unwrap();
        let mint_fee = parent(0x62, 1_000_000, &owner);
        let later = coin.mint_coin(admin.x_only_public_key(), owner.clone(), owner.address(), 200, utxo(&mint_fee, &owner, 0), created.mint.clone(), created.coin_nft.clone(), None).unwrap().finalize_with_admin_key(&admin).unwrap();
        let creation_tape = parse_tape(&created.mint.outputs[4].script_pubkey).unwrap();
        let state = decode_coin_nft_tape_script(&later.outputs[2].script_pubkey).unwrap();
        let canonical = String::from_utf8(serde_json::to_vec(&state).unwrap()).unwrap();
        let reordered = format!("{{\"coinTotalSupply\":{},\"coinDecimal\":{},\"description\":{},\"nftSymbol\":{},\"nftName\":{}}}", serde_json::to_string(&state.coin_total_supply).unwrap(), state.coin_decimal, serde_json::to_string(&state.description).unwrap(), serde_json::to_string(&state.nft_symbol).unwrap(), serde_json::to_string(&state.nft_name).unwrap());
        let variants = [
            ("leading-zero", canonical.replace("\"coinTotalSupply\":\"800\"", "\"coinTotalSupply\":\"0800\"")),
            ("reordered-fields", reordered),
            ("unknown-field", canonical.replace('}', ",\"unknown\":true}")),
            ("whitespace", canonical.replacen('{', "{ ", 1)),
            ("escaped", canonical.replace("Dollar NFT", "Dollar\\u0020NFT")),
            ("same-length-substitution", canonical.replace("Dollar NFT", "Eollar NFT")),
        ];
        for (label, json) in variants {
            let mut mutated = later.clone();
            mutated.outputs[2].script_pubkey = Script::op_return(&[json.into_bytes(), b"NTape".to_vec()]);
            let parents = BTreeMap::from([verified(root.clone()), verified(coin_fee.clone()), verified(created.coin_nft.clone()), verified(created.mint.clone()), verified(mint_fee.clone()), verified(mutated)]);
            assert!(authenticate_stablecoin_mint_lineage(parents.get(&created.mint.txid().to_string()).unwrap(), &parents, &creation_tape).is_err(), "{label}");
        }
    }
}
