use std::str::FromStr;

use serde::{Deserialize, Serialize};
use tbc_sdk::{
    Address, FtInfo, FtScriptVersion, FtlpCodeParams, FtlpTapeLayout, FtlpTapeParams,
    LockedLpCost, PoolAmounts, PoolState, Transaction, Txid,
    contracts::{
        ft::{scripts::{FT_CODE_SATOSHIS, FtCodeReceiver, transfer_code_script}, unlock::classify_ft_script},
        pool_nft_v2::{
            consume_lp as calculate_consume_lp, format_decimal_raw,
            increase_lp as calculate_increase_lp, parse_decimal_raw,
            swap_tbc_to_ft as calculate_swap_tbc_to_ft,
        },
    },
    ftlp_code, ftlp_lock_time_code, ftlp_tape, hash, pool_held_ft_code,
    script::Script,
};

const MAX_POOL_AUTO_MERGE_UTXOS: usize = 100;
const MAX_POOL_CONSUME_FT_INPUTS: usize = 3;
const MAX_POOL_SWAP_FT_INPUTS: usize = 4;
const MAX_LOCKED_CONSUME_FTLP_INPUTS: usize = 6;
const LOCK_TIME_THRESHOLD: u32 = 500_000_000;


#[derive(Clone, Debug)]
struct CombinedFtCandidate {
    indexed_balance: u128,
    txid_text: String,
    output_index: u32,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PoolPreparedCandidateDto {
    txid: String,
    output_index: u32,
    satoshis: u64,
    balance: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    lock_time: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    script: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_txraw: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PoolSelectionStateDto {
    ft_lp_raw: String,
    ft_a_raw: String,
    tbc_sat: String,
    pool_value_sat: String,
    service_fee_rate: u16,
    lp_plan: u8,
    ftlp_lock_time_enabled: bool,
    #[serde(default)]
    public_key_locked: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreparedPoolInfoDto {
    ft_a_partial_hash: String,
    ft_contract_id: String,
    ft_lp_partial_hash: String,
    lp_balance: String,
    pool_code_script: String,
    service_fee_rate: u16,
    service_provider: String,
    tbc_balance: String,
    token_balance: String,
    txid: String,
    value: String,
    version: u32,
    vout: u32,
}

#[derive(Deserialize)]
#[serde(
    tag = "phase",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum PoolPrepareRequest {
    Select {
        operation: String,
        ft_contract_id: String,
        ft_decimal: u8,
        pool: PoolSelectionStateDto,
        amount: String,
        #[serde(default)]
        locked_lp_cost_satoshis: Option<u64>,
        #[serde(default)]
        current_lock_time: Option<u32>,
        #[serde(default)]
        current_block_height: Option<u32>,
        #[serde(default)]
        owner_ft_candidates: Vec<PoolPreparedCandidateDto>,
        #[serde(default)]
        pool_ft_candidates: Vec<PoolPreparedCandidateDto>,
        #[serde(default)]
        ftlp_candidates: Vec<PoolPreparedCandidateDto>,
    },
    Describe {
        contract_id: String,
        owner_address: String,
        info: PreparedPoolInfoDto,
        pool_pre_txraw: String,
        #[serde(default)]
        ft_contract_txraw: Option<String>,
        #[serde(default)]
        indexed_ft: Option<IndexedFtDto>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IndexedFtDto {
    code_script: String,
    tape_script: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PoolSelectionResponse {
    owner_ft_candidates: Vec<PoolPreparedCandidateDto>,
    pool_ft_candidates: Vec<PoolPreparedCandidateDto>,
    ftlp_candidates: Vec<PoolPreparedCandidateDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolved_current_lock_time: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PoolDescribeResponse {
    ft_contract_id: String,
    ft_decimal: u8,
    ftlp_script: String,
    ftlp_script_hash: String,
    owner_combine_script: String,
    owner_ft_script: String,
    pool: PoolSelectionStateResponse,
    pool_combine_script: String,
    pool_ft_script: String,
    stablecoin: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PoolSelectionStateResponse {
    ft_lp_raw: String,
    ft_a_raw: String,
    tbc_sat: String,
    pool_value_sat: String,
    service_fee_rate: u16,
    lp_plan: u8,
    ftlp_lock_time_enabled: bool,
    public_key_locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    locked_lp_cost_satoshis: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyPoolPreviewRequest {
    operation: String,
    ft_contract_id: String,
    ft_decimal: u8,
    amount: String,
    #[serde(default)]
    lock_time: u32,
    pool: LegacyPoolPreviewState,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyPoolPreviewState {
    ft_lp_raw: String,
    ft_a_raw: String,
    tbc_sat: String,
    pool_value_sat: String,
    public_key_locked: bool,
    #[serde(default)]
    locked_lp_cost_satoshis: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPoolPreviewResponse {
    ft_contract_id: String,
    tbc_amount_sat: String,
    ft_required_raw: String,
    ftlp_minted_raw: String,
    lock_time: u32,
    before: LegacyPoolPreviewAmounts,
    after: LegacyPoolPreviewAmounts,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPoolPreviewAmounts {
    ft_lp_raw: String,
    ft_a_raw: String,
    tbc_sat: String,
    pool_value_sat: String,
}

fn pool_increase_increment(requested: u64, locked: bool, cost: Option<u64>) -> Result<u64, String> {
    let cost = if locked {
        cost.filter(|value| *value > 0).ok_or_else(|| {
            "locked Pool increase requires its explicit LP-cost output".to_owned()
        })?
    } else {
        0
    };
    requested.checked_sub(cost).filter(|value| *value > 0).ok_or_else(|| {
        "Pool increase TBC amount must exceed the locked LP cost".to_owned()
    })
}

pub fn legacy_pool_preview_json(request_json: &str) -> Result<String, String> {
    let request: LegacyPoolPreviewRequest = serde_json::from_str(request_json)
        .map_err(|error| format!("invalid Legacy Pool preview request: {error}"))?;
    if request.operation != "increaseLp" {
        return Err("unsupported Legacy Pool preview operation".to_owned());
    }
    if request.ft_decimal > 18 {
        return Err("invalid Legacy Pool FT decimal".to_owned());
    }
    validate_wallet_ftlp_lock_time(request.lock_time)?;
    let ft_contract_id = parse_txid(&request.ft_contract_id, "ftContractId")?.to_string();
    let before = PoolAmounts {
        ft_lp_raw: parse_u64_text(&request.pool.ft_lp_raw, "Pool FT-LP amount")?,
        ft_a_raw: parse_u64_text(&request.pool.ft_a_raw, "Pool FT-A amount")?,
        tbc_sat: parse_u64_text(&request.pool.tbc_sat, "Pool TBC amount")?,
    };
    let pool_value_sat =
        parse_u64_text(&request.pool.pool_value_sat, "Pool current value")?;
    let tbc_amount_sat =
        parse_decimal_raw(&request.amount, 6).map_err(|error| error.to_string())?;
    let increment = pool_increase_increment(tbc_amount_sat, request.pool.public_key_locked,
        request.pool.locked_lp_cost_satoshis)?;
    let difference = calculate_increase_lp(&before, pool_value_sat, increment)
        .map_err(|error| error.to_string())?;
    let ft_required_raw = u64::try_from(difference.ft_a_delta)
        .map_err(|_| "Pool increase calculated an invalid FT-A amount".to_owned())?;
    let ftlp_minted_raw = u64::try_from(difference.ft_lp_delta)
        .map_err(|_| "Pool increase calculated an invalid FT-LP amount".to_owned())?;
    // Validate that the trusted raw FT delta is representable at the indexed
    // contract precision even though the Legacy boundary displays raw units.
    format_decimal_raw(ft_required_raw, request.ft_decimal)
        .map_err(|error| error.to_string())?;
    let after = LegacyPoolPreviewAmounts {
        ft_lp_raw: before
            .ft_lp_raw
            .checked_add(ftlp_minted_raw)
            .ok_or_else(|| "Pool FT-LP reserve overflow".to_owned())?
            .to_string(),
        ft_a_raw: before
            .ft_a_raw
            .checked_add(ft_required_raw)
            .ok_or_else(|| "Pool FT-A reserve overflow".to_owned())?
            .to_string(),
        tbc_sat: before
            .tbc_sat
            .checked_add(increment)
            .ok_or_else(|| "Pool TBC reserve overflow".to_owned())?
            .to_string(),
        pool_value_sat: pool_value_sat
            .checked_add(increment)
            .ok_or_else(|| "Pool value overflow".to_owned())?
            .to_string(),
    };
    serde_json::to_string(&LegacyPoolPreviewResponse {
        ft_contract_id,
        tbc_amount_sat: tbc_amount_sat.to_string(),
        ft_required_raw: ft_required_raw.to_string(),
        ftlp_minted_raw: ftlp_minted_raw.to_string(),
        lock_time: request.lock_time,
        before: LegacyPoolPreviewAmounts {
            ft_lp_raw: before.ft_lp_raw.to_string(),
            ft_a_raw: before.ft_a_raw.to_string(),
            tbc_sat: before.tbc_sat.to_string(),
            pool_value_sat: pool_value_sat.to_string(),
        },
        after,
    })
    .map_err(|error| error.to_string())
}

pub fn prepare_pool_nft_json(request_json: &str) -> Result<String, String> {
    let request: PoolPrepareRequest = serde_json::from_str(request_json)
        .map_err(|error| format!("invalid PoolNFT preparation request: {error}"))?;
    match request {
        PoolPrepareRequest::Select {
            operation,
            ft_contract_id,
            ft_decimal,
            pool,
            amount,
            locked_lp_cost_satoshis,
            current_lock_time,
            current_block_height,
            owner_ft_candidates,
            pool_ft_candidates,
            ftlp_candidates,
        } => {
            let contract_id = parse_txid(&ft_contract_id, "ftContractId")?;
            let amounts = PoolAmounts {
                ft_lp_raw: parse_u64_text(&pool.ft_lp_raw, "Pool FT-LP amount")?,
                ft_a_raw: parse_u64_text(&pool.ft_a_raw, "Pool FT-A amount")?,
                tbc_sat: parse_u64_text(&pool.tbc_sat, "Pool TBC amount")?,
            };
            let pool_value = parse_u64_text(&pool.pool_value_sat, "Pool current value")?;
            let mut selected_owner = Vec::new();
            let mut selected_pool = Vec::new();
            let mut selected_ftlp = Vec::new();
            let mut resolved_current_lock_time = None;
            match operation.as_str() {
                "init" | "swapToTbc" => {
                    let required_raw = u128::from(
                        parse_decimal_raw(&amount, ft_decimal)
                            .map_err(|error| error.to_string())?,
                    );
                    selected_owner = select_prepared_owner_candidate(
                        owner_ft_candidates,
                        required_raw,
                        &amount,
                        contract_id,
                    )?;
                }
                "increaseLp" => {
                    let requested =
                        parse_decimal_raw(&amount, 6).map_err(|error| error.to_string())?;
                    let increment = pool_increase_increment(requested, pool.public_key_locked,
                        locked_lp_cost_satoshis)?;
                    let difference = calculate_increase_lp(&amounts, pool_value, increment)
                        .map_err(|error| error.to_string())?;
                    let required_raw = u128::try_from(difference.ft_a_delta).map_err(|_| {
                        "Pool increase calculated an invalid FT-A amount".to_owned()
                    })?;
                    let required_human = format_decimal_raw(
                        u64::try_from(required_raw)
                            .map_err(|_| "Pool increase FT-A amount overflow".to_owned())?,
                        ft_decimal,
                    )
                    .map_err(|error| error.to_string())?;
                    selected_owner = select_prepared_owner_candidate(
                        owner_ft_candidates,
                        required_raw,
                        &required_human,
                        contract_id,
                    )?;
                }
                "swapToToken" => {
                    let input_sat =
                        parse_decimal_raw(&amount, 6).map_err(|error| error.to_string())?;
                    let difference = calculate_swap_tbc_to_ft(
                        &amounts,
                        input_sat,
                        pool.service_fee_rate,
                        pool.lp_plan,
                    )
                    .map_err(|error| error.to_string())?;
                    selected_pool = select_prepared_pool_candidates(
                        pool_ft_candidates,
                        difference.ft_a_delta.unsigned_abs(),
                        MAX_POOL_SWAP_FT_INPUTS,
                    )?;
                }
                "consumeLp" => {
                    let ftlp_limit = if pool.ftlp_lock_time_enabled {
                        MAX_LOCKED_CONSUME_FTLP_INPUTS
                    } else {
                        1
                    };
                    let lp_raw =
                        parse_decimal_raw(&amount, 6).map_err(|error| error.to_string())?;
                    let difference = calculate_consume_lp(&amounts, pool_value, lp_raw)
                        .map_err(|error| error.to_string())?;
                    selected_pool = select_prepared_pool_candidates(
                        pool_ft_candidates,
                        difference.ft_a_delta.unsigned_abs(),
                        MAX_POOL_CONSUME_FT_INPUTS,
                    )?;
                    let timestamp_ftlp_candidates = if pool.ftlp_lock_time_enabled {
                        ftlp_candidates
                            .iter()
                            .filter(|candidate| {
                                candidate
                                    .lock_time
                                    .is_some_and(|lock| lock >= LOCK_TIME_THRESHOLD)
                            })
                            .cloned()
                            .collect::<Vec<_>>()
                    } else {
                        Vec::new()
                    };
                    let spendable_ftlp = filter_spendable_ftlp_candidates(
                        ftlp_candidates,
                        pool.ftlp_lock_time_enabled,
                        current_lock_time,
                        current_block_height,
                        false,
                        false,
                    )?;
                    let spendable_ftlp_balance = prepared_balance_total(spendable_ftlp.iter())?;
                    let requested_ftlp_balance = u128::from(lp_raw);
                    if spendable_ftlp_balance < requested_ftlp_balance {
                        let missing_ftlp_balance = requested_ftlp_balance - spendable_ftlp_balance;
                        let timestamp_ftlp_balance =
                            prepared_balance_total(timestamp_ftlp_candidates.iter())?;
                        if timestamp_ftlp_balance >= missing_ftlp_balance {
                            return Err("Wallet supports block-height FTLP locks only".to_owned());
                        }
                    }
                    selected_ftlp = select_prepared_ftlp_candidates(
                        spendable_ftlp,
                        requested_ftlp_balance,
                        ftlp_limit,
                    )?;
                    resolved_current_lock_time = resolve_selected_lock_time(
                        &selected_ftlp,
                        current_lock_time,
                        current_block_height,
                    );
                }
                "mergePoolFt" => {
                    selected_pool = smallest_prepared_candidates(
                        pool_ft_candidates,
                        MAX_POOL_AUTO_MERGE_UTXOS,
                    )?;
                }
                "mergeFtlp" => {
                    let spendable_ftlp = filter_spendable_ftlp_candidates(
                        ftlp_candidates,
                        pool.ftlp_lock_time_enabled,
                        current_lock_time,
                        current_block_height,
                        false,
                        true,
                    )?;
                    selected_ftlp =
                        smallest_prepared_candidates(spendable_ftlp, MAX_POOL_AUTO_MERGE_UTXOS)?;
                    resolved_current_lock_time = resolve_selected_lock_time(
                        &selected_ftlp,
                        current_lock_time,
                        current_block_height,
                    );
                }
                "burnFtlp" => {
                    let unlocked_ftlp = filter_spendable_ftlp_candidates(
                        ftlp_candidates,
                        pool.ftlp_lock_time_enabled,
                        None,
                        None,
                        true,
                        false,
                    )?;
                    selected_ftlp = sorted_prepared_candidates(unlocked_ftlp, 5)?;
                }
                _ => {
                    return Err(format!(
                        "unsupported PoolNFT preparation operation {operation}"
                    ));
                }
            }
            serde_json::to_string(&PoolSelectionResponse {
                owner_ft_candidates: selected_owner,
                pool_ft_candidates: selected_pool,
                ftlp_candidates: selected_ftlp,
                resolved_current_lock_time,
            })
            .map_err(|error| error.to_string())
        }
        PoolPrepareRequest::Describe {
            contract_id,
            owner_address,
            info,
            pool_pre_txraw,
            ft_contract_txraw,
            indexed_ft,
        } => {
            let response = describe_prepared_pool(
                &contract_id,
                &owner_address,
                info,
                &pool_pre_txraw,
                ft_contract_txraw.as_deref(),
                indexed_ft,
            )?;
            serde_json::to_string(&response).map_err(|error| error.to_string())
        }
    }
}

fn describe_prepared_pool(
    contract_id: &str,
    owner_address: &str,
    info: PreparedPoolInfoDto,
    pool_pre_txraw: &str,
    ft_contract_txraw: Option<&str>,
    indexed_ft: Option<IndexedFtDto>,
) -> Result<PoolDescribeResponse, String> {
    parse_txid(contract_id, "contractId")?;
    if info.version != 2 {
        return Err(format!(
            "unsupported Pool version {}; only Pool NFT v2 is supported",
            info.version
        ));
    }
    if info.vout != 0 {
        return Err("Pool NFT v2 current output must be vout 0".to_owned());
    }
    let owner = parse_address(owner_address, "ownerAddress")?;
    let ft_contract_id = parse_txid(&info.ft_contract_id, "Pool FT contract id")?;
    let authority = match (ft_contract_txraw, indexed_ft) {
        (Some(raw), None) => {
            let tx = Transaction::from_hex(raw).map_err(|error| format!("invalid ftContractTxraw: {error}"))?;
            authority_from_transaction(ft_contract_id, tx)?
        },
        (None, Some(index)) => {
            let code=Script::from_bytes(hex::decode(&index.code_script).map_err(|_| "invalid indexed FT Code")?);
            let tape=Script::from_bytes(hex::decode(&index.tape_script).map_err(|_| "invalid indexed FT Tape")?);
            let (_, coin)=classify_ft_code_family(&code)?;
            require_ordinary_pool_ft(coin)?;
            let meta=parse_ft_tape(&tape)?;
            if meta.decimal > 18 {return Err("invalid FT decimals".to_owned());}
            PreparedAuthority {info:FtInfo {
                contract_txid:Some(ft_contract_id.to_string()),code_script:hex::encode(code.as_bytes()),
                tape_script:hex::encode(tape.as_bytes()),total_supply_raw:meta.total_supply_raw,
                decimal:meta.decimal,name:meta.name,symbol:meta.symbol,
            }}
        },
        _ => return Err("provide exactly one FT authority source".to_owned()),
    };
    let current_txid = parse_txid(&info.txid, "Pool current txid")?;
    let pool_pre_tx = Transaction::from_hex(pool_pre_txraw)
        .map_err(|error| format!("invalid poolPreTxraw: {error}"))?;
    ensure_transaction_id(&pool_pre_tx, current_txid, "current Pool")
        .map_err(|error| error.to_string())?;
    let pool_code = Script::from_bytes(
        hex::decode(&info.pool_code_script)
            .map_err(|error| format!("invalid Pool code script: {error}"))?,
    );
    let current_output = pool_pre_tx
        .outputs
        .first()
        .ok_or_else(|| "current Pool transaction has no output 0".to_owned())?;
    let pool_value = info
        .value
        .parse::<u64>()
        .map_err(|_| "Pool current value is not a valid unsigned integer".to_owned())?;
    if current_output.satoshis != pool_value || current_output.script_pubkey != pool_code {
        return Err("Pool current output does not match the indexer response".to_owned());
    }
    let current_tape = pool_pre_tx
        .outputs
        .get(1)
        .ok_or_else(|| "current Pool transaction has no NTape output".to_owned())?;
    if current_tape.satoshis != 0 {
        return Err("current Pool NTape output must contain zero satoshis".to_owned());
    }
    let state = pool_state_from_tape(&current_tape.script_pubkey, info.service_provider.clone())
        .map_err(|error| error.to_string())?;
    validate_prepared_pool_state(&info, &state)?;

    let base_code = Script::from_bytes(
        hex::decode(&authority.info.code_script)
            .map_err(|error| format!("invalid FT authority code: {error}"))?,
    );
    let (ft_version, stablecoin) = classify_ft_code_family(&base_code)?;
    let owner_ft_script = transfer_code_script(&base_code, FtCodeReceiver::Address(owner.clone()))
        .map_err(|error| error.to_string())?;
    let pool_hash = hash::sha256(pool_code.as_bytes());
    let pool_receiver = hash::hash160(&pool_hash);
    let pool_ft_script =
        pool_held_ft_code(&base_code, pool_receiver).map_err(|error| error.to_string())?;
    let authority_tape = Script::from_bytes(
        hex::decode(&authority.info.tape_script)
            .map_err(|error| format!("invalid FT authority tape: {error}"))?,
    );
    let ftlp_tape_script = if state.ftlp_lock_time_enabled {
        ftlp_tape(&FtlpTapeParams {
            amount_raw: 0,
            layout: FtlpTapeLayout::LockTime {
                lock_time: 0,
                source_ft_tape_size: authority_tape.as_bytes().len(),
            },
        })
    } else {
        ftlp_tape(&FtlpTapeParams {
            amount_raw: 0,
            layout: FtlpTapeLayout::Standard {
                decimal: 6,
                name: &authority.info.name,
                symbol: &authority.info.symbol,
                is_coin: stablecoin,
            },
        })
    }
    .map_err(|error| error.to_string())?;
    let ftlp_params = FtlpCodeParams::for_tape(&ftlp_tape_script, ft_version, stablecoin)
        .map_err(|error| error.to_string())?;
    let ftlp_script = if state.ftlp_lock_time_enabled {
        ftlp_lock_time_code(pool_hash, &owner, &ftlp_params)
    } else {
        ftlp_code(pool_hash, &owner, &ftlp_params)
    }
    .map_err(|error| error.to_string())?;
    let mut ftlp_script_hash = hash::sha256(ftlp_script.as_bytes());
    ftlp_script_hash.reverse();

    Ok(PoolDescribeResponse {
        ft_contract_id: ft_contract_id.to_string(),
        ft_decimal: authority.info.decimal,
        ftlp_script: hex::encode(ftlp_script.as_bytes()),
        ftlp_script_hash: hex::encode(ftlp_script_hash),
        owner_combine_script: format!("{}00", hex::encode(owner.hash160())),
        owner_ft_script: hex::encode(owner_ft_script.as_bytes()),
        pool: PoolSelectionStateResponse {
            ft_lp_raw: state.amounts.ft_lp_raw.to_string(),
            ft_a_raw: state.amounts.ft_a_raw.to_string(),
            tbc_sat: state.amounts.tbc_sat.to_string(),
            pool_value_sat: pool_value.to_string(),
            service_fee_rate: state.service_fee_rate,
            lp_plan: state.lp_plan,
            ftlp_lock_time_enabled: state.ftlp_lock_time_enabled,
            public_key_locked: state.public_key_locked,
            locked_lp_cost_satoshis: state
                .public_key_locked
                .then(|| pool_locked_lp_cost(&pool_code).map(|cost| cost.satoshis))
                .transpose()?,
        },
        pool_combine_script: format!("{}01", hex::encode(pool_receiver)),
        pool_ft_script: hex::encode(pool_ft_script.as_bytes()),
        stablecoin,
    })
}

fn classify_ft_code_family(script: &Script) -> Result<(FtScriptVersion, bool), String> {
    let classified = classify_ft_script(script).map_err(|error| error.to_string())?;
    let version = match classified.version {
        1 => FtScriptVersion::V1,
        2 => FtScriptVersion::V2,
        3 => FtScriptVersion::V3,
        4 => FtScriptVersion::V4,
        version => return Err(format!("unsupported FT code version {version}")),
    };
    Ok((version, classified.is_coin))
}

fn prepared_candidates(
    values: &[PoolPreparedCandidateDto],
) -> Result<Vec<CombinedFtCandidate>, String> {
    values
        .iter()
        .map(|value| {
            let txid = parse_txid(&value.txid, "prepared candidate txid")?;
            Ok(CombinedFtCandidate {
                indexed_balance: value.balance.parse::<u128>().map_err(|_| {
                    "prepared candidate balance is not an unsigned integer".to_owned()
                })?,
                txid_text: txid.to_string(),
                output_index: value.output_index,
            })
        })
        .collect()
}

fn prepared_balance_total<'a>(
    values: impl IntoIterator<Item = &'a PoolPreparedCandidateDto>,
) -> Result<u128, String> {
    values.into_iter().try_fold(0_u128, |total, candidate| {
        let balance = candidate
            .balance
            .parse::<u128>()
            .map_err(|_| "prepared candidate balance is not an unsigned integer".to_owned())?;
        total
            .checked_add(balance)
            .ok_or_else(|| "prepared candidate balance overflow".to_owned())
    })
}

fn parse_u64_text(value: &str, field: &str) -> Result<u64, String> {
    value
        .parse::<u64>()
        .map_err(|_| format!("{field} is not a valid unsigned integer"))
}

fn select_prepared_owner_candidate(
    values: Vec<PoolPreparedCandidateDto>,
    required_raw: u128,
    required_human: &str,
    contract_id: Txid,
) -> Result<Vec<PoolPreparedCandidateDto>, String> {
    let selected = select_owner_ft_candidate(
        prepared_candidates(&values)?,
        required_raw,
        required_human,
        contract_id,
    )
    .map_err(|error| error.to_string())?;
    selected
        .iter()
        .map(|candidate| find_prepared_candidate(values.clone(), candidate))
        .collect()
}

fn select_prepared_pool_candidates(
    values: Vec<PoolPreparedCandidateDto>,
    required_raw: u128,
    limit: usize,
) -> Result<Vec<PoolPreparedCandidateDto>, String> {
    let selected = select_pool_ft_candidates(prepared_candidates(&values)?, required_raw, limit)
        .map_err(|error| error.to_string())?;
    selected
        .iter()
        .map(|candidate| find_prepared_candidate(values.clone(), candidate))
        .collect()
}

fn select_prepared_ftlp_candidates(
    values: Vec<PoolPreparedCandidateDto>,
    required_raw: u128,
    direct_limit: usize,
) -> Result<Vec<PoolPreparedCandidateDto>, String> {
    let selected =
        select_ftlp_candidates(prepared_candidates(&values)?, required_raw, direct_limit)
            .map_err(|error| error.to_string())?;
    selected
        .iter()
        .map(|candidate| find_prepared_candidate(values.clone(), candidate))
        .collect()
}

fn filter_spendable_ftlp_candidates(
    values: Vec<PoolPreparedCandidateDto>,
    lock_time_enabled: bool,
    current_lock_time: Option<u32>,
    current_block_height: Option<u32>,
    unlocked_only: bool,
    report_timestamp_only: bool,
) -> Result<Vec<PoolPreparedCandidateDto>, String> {
    if !lock_time_enabled {
        return Ok(values);
    }
    if current_lock_time == Some(0) && !unlocked_only {
        return Err("lock-time FT-LP selection requires a current block height".to_owned());
    }
    if !unlocked_only && current_lock_time.is_none() && current_block_height.is_none() {
        return Err("lock-time FT-LP selection requires current block height".to_owned());
    }

    if let Some(current) = current_lock_time {
        validate_wallet_ftlp_lock_time(current)?;
    }
    let timestamp_only = !values.is_empty()
        && values.iter().all(|candidate| {
            candidate
                .lock_time
                .is_some_and(|lock| lock >= LOCK_TIME_THRESHOLD)
        });

    let spendable = values
        .into_iter()
        .filter_map(|candidate| {
            let lock_time = match candidate.lock_time {
                Some(lock_time) => lock_time,
                None => {
                    return Some(Err(
                        "locked Pool FT-LP candidate is missing lockTime".to_owned()
                    ));
                }
            };
            let spendable = if lock_time == 0 {
                true
            } else if unlocked_only {
                false
            } else if let Some(current) = current_lock_time {
                let same_domain =
                    (lock_time < LOCK_TIME_THRESHOLD) == (current < LOCK_TIME_THRESHOLD);
                same_domain && lock_time <= current
            } else if lock_time < LOCK_TIME_THRESHOLD {
                current_block_height.is_some_and(|current| lock_time <= current)
            } else {
                false
            };
            spendable.then_some(Ok(candidate))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if spendable.is_empty() && timestamp_only && report_timestamp_only && !unlocked_only {
        return Err("Wallet supports block-height FTLP locks only".to_owned());
    }
    Ok(spendable)
}

fn validate_wallet_ftlp_lock_time(lock_time: u32) -> Result<(), String> {
    if lock_time >= LOCK_TIME_THRESHOLD {
        Err("Wallet supports block-height FTLP locks only".to_owned())
    } else {
        Ok(())
    }
}

fn resolve_selected_lock_time(
    _selected: &[PoolPreparedCandidateDto],
    explicit: Option<u32>,
    current_block_height: Option<u32>,
) -> Option<u32> {
    explicit.or(current_block_height)
}

fn find_prepared_candidate(
    values: Vec<PoolPreparedCandidateDto>,
    selected: &CombinedFtCandidate,
) -> Result<PoolPreparedCandidateDto, String> {
    values
        .into_iter()
        .find(|candidate| {
            candidate.txid.eq_ignore_ascii_case(&selected.txid_text)
                && candidate.output_index == selected.output_index
        })
        .ok_or_else(|| "selected PoolNFT candidate is unavailable".to_owned())
}

fn sorted_prepared_candidates(
    values: Vec<PoolPreparedCandidateDto>,
    limit: usize,
) -> Result<Vec<PoolPreparedCandidateDto>, String> {
    let selected = prepared_candidates(&values)?;
    let mut ordered = selected;
    ordered.sort_by(|left, right| {
        right
            .indexed_balance
            .cmp(&left.indexed_balance)
            .then_with(|| left.txid_text.cmp(&right.txid_text))
            .then_with(|| left.output_index.cmp(&right.output_index))
    });
    ordered
        .iter()
        .take(limit)
        .map(|candidate| find_prepared_candidate(values.clone(), candidate))
        .collect()
}

fn smallest_prepared_candidates(
    values: Vec<PoolPreparedCandidateDto>,
    limit: usize,
) -> Result<Vec<PoolPreparedCandidateDto>, String> {
    let mut ordered = prepared_candidates(&values)?;
    ordered.sort_by(|left, right| {
        left.indexed_balance
            .cmp(&right.indexed_balance)
            .then_with(|| left.txid_text.cmp(&right.txid_text))
            .then_with(|| left.output_index.cmp(&right.output_index))
    });
    ordered
        .iter()
        .take(limit)
        .map(|candidate| find_prepared_candidate(values.clone(), candidate))
        .collect()
}

fn authority_from_transaction(
    contract_id: Txid,
    contract_tx: Transaction,
) -> Result<PreparedAuthority, String> {
    if contract_tx.txid() != contract_id {
        return Err("FT authority transaction id does not match ftContractId".to_owned());
    }
    if contract_tx.inputs.is_empty() {
        return Err("FT authority transaction must contain a real mint input".to_owned());
    }
    let mut authorities = Vec::new();
    for (code_vout, tape_vout) in [(0_usize, 1_usize), (3_usize, 4_usize)] {
        let (Some(code), Some(tape)) = (
            contract_tx.outputs.get(code_vout),
            contract_tx.outputs.get(tape_vout),
        ) else {
            continue;
        };
        let Ok(metadata) = parse_ft_tape(&tape.script_pubkey) else {
            continue;
        };
        let info = FtInfo {
            contract_txid: Some(contract_id.to_string()),
            code_script: hex::encode(code.script_pubkey.as_bytes()),
            tape_script: hex::encode(tape.script_pubkey.as_bytes()),
            total_supply_raw: metadata.total_supply_raw,
            decimal: metadata.decimal,
            name: metadata.name,
            symbol: metadata.symbol,
        };
        let Ok(classified) = classify_ft_script(&code.script_pubkey) else {
            continue;
        };
        let Ok(chunks) = op_return_pushes(tape.script_pubkey.as_bytes()) else {
            continue;
        };
        let expected_vouts = if classified.is_coin { (3, 4) } else { (0, 1) };
        if (code_vout, tape_vout) != expected_vouts
            || chunks.len() != if classified.is_coin { 6 } else { 5 }
            || code.satoshis != FT_CODE_SATOSHIS
            || tape.satoshis != 0
            || info.decimal > 18
        {
            continue;
        }
        let authority = PreparedAuthority {
            info,
        };
        authorities.push(authority);
    }
    let authority = match authorities.len() {
        1 => authorities.pop().expect("length checked"),
        0 => return Err("FT authority has no canonical released Code/Tape pair".to_owned()),
        _ => {
            return Err("FT authority has multiple canonical released Code/Tape pairs".to_owned());
        }
    };
    let code = Script::from_bytes(
        hex::decode(&authority.info.code_script)
            .map_err(|error| format!("invalid FT authority code: {error}"))?,
    );
    let (_, stablecoin) = classify_ft_code_family(&code)?;
    require_ordinary_pool_ft(stablecoin)?;
    Ok(authority)
}

fn require_ordinary_pool_ft(stablecoin: bool) -> Result<(), String> {
    if stablecoin {
        Err("PoolNFT supports ordinary FT only; StableCoin is unsupported".to_owned())
    } else {
        Ok(())
    }
}

struct FtMetadata {
    total_supply_raw: u128,
    decimal: u8,
    name: String,
    symbol: String,
}

struct PreparedAuthority {
    info: FtInfo,
}

fn parse_ft_tape(script: &Script) -> Result<FtMetadata, String> {
    let chunks = op_return_pushes(script.as_bytes())?;
    if !matches!(chunks.len(), 5 | 6)
        || chunks.first().is_none_or(|amount| amount.len() != 48)
        || chunks.get(1).is_none_or(|decimal| decimal.len() != 1)
        || chunks.last().map(Vec::as_slice) != Some(b"FTape")
    {
        return Err("non-canonical FT Tape".to_owned());
    }
    if chunks.len() == 6 && chunks.get(4).is_none_or(|suffix| suffix.len() != 4) {
        return Err("non-canonical Coin Tape".to_owned());
    }
    let total_supply_raw = chunks[0].chunks_exact(8).try_fold(0_u128, |sum, raw| {
        let amount = u64::from_le_bytes(raw.try_into().expect("chunk length checked"));
        sum.checked_add(u128::from(amount))
            .ok_or_else(|| "FT Tape amount overflow".to_owned())
    })?;
    Ok(FtMetadata {
        total_supply_raw,
        decimal: chunks[1][0],
        name: String::from_utf8(chunks[2].clone())
            .map_err(|_| "FT Tape name is not UTF-8".to_owned())?,
        symbol: String::from_utf8(chunks[3].clone())
            .map_err(|_| "FT Tape symbol is not UTF-8".to_owned())?,
    })
}

fn op_return_pushes(bytes: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    if !bytes.starts_with(&[0x00, 0x6a]) {
        return Err("FT Tape must start with OP_FALSE OP_RETURN".to_owned());
    }
    let mut offset = 2_usize;
    let mut chunks = Vec::new();
    while offset < bytes.len() {
        let opcode = bytes[offset];
        offset += 1;
        let length = match opcode {
            0x00 => 0,
            0x01..=0x4b => usize::from(opcode),
            0x4c => usize::from(read_length::<1>(bytes, &mut offset)?[0]),
            0x4d => usize::from(u16::from_le_bytes(read_length(bytes, &mut offset)?)),
            0x4e => usize::try_from(u32::from_le_bytes(read_length(bytes, &mut offset)?))
                .map_err(|_| "FT Tape push length overflow".to_owned())?,
            _ => return Err("FT Tape contains a non-push opcode".to_owned()),
        };
        let end = offset
            .checked_add(length)
            .ok_or_else(|| "FT Tape push length overflow".to_owned())?;
        let chunk = bytes
            .get(offset..end)
            .ok_or_else(|| "FT Tape contains a truncated push".to_owned())?;
        chunks.push(chunk.to_vec());
        offset = end;
    }
    Ok(chunks)
}

fn read_length<const N: usize>(bytes: &[u8], offset: &mut usize) -> Result<[u8; N], String> {
    let end = offset
        .checked_add(N)
        .ok_or_else(|| "FT Tape push length overflow".to_owned())?;
    let raw = bytes
        .get(*offset..end)
        .ok_or_else(|| "FT Tape contains a truncated length".to_owned())?;
    *offset = end;
    raw.try_into()
        .map_err(|_| "FT Tape contains an invalid length".to_owned())
}

fn parse_txid(value: &str, field: &str) -> Result<Txid, String> {
    Txid::from_str(value).map_err(|error| format!("invalid {field}: {error}"))
}

fn parse_address(value: &str, field: &str) -> Result<Address, String> {
    Address::from_string(value).map_err(|error| format!("invalid {field}: {error}"))
}

fn pool_locked_lp_cost(script: &Script) -> Result<LockedLpCost, String> {
    let bytes = script.as_bytes();
    const SENTINEL: [u8; 4] = [0x88, 0xbb, 0x78, 0x08];
    for index in 0..bytes.len().saturating_sub(34) {
        if bytes[index] != 0x14
            || bytes[index + 21..index + 25] != SENTINEL
            || bytes[index + 33] != 0x88
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
        return Ok(LockedLpCost {
            address: Address::from_hash160(hash160),
            satoshis,
        });
    }
    Err("Pool Code lacks the released locked LP-cost binding".to_owned())
}

fn ensure_transaction_id(
    transaction: &Transaction,
    expected: Txid,
    label: &str,
) -> tbc_sdk::Result<()> {
    if transaction.txid() != expected {
        return Err(tbc_sdk::Error::Api(format!(
            "{label} response transaction id mismatch"
        )));
    }
    Ok(())
}

fn pool_state_from_tape(tape: &Script, service_provider: String) -> tbc_sdk::Result<PoolState> {
    PoolState::from_v2_tape(tape, service_provider)
}

fn validate_prepared_pool_state(
    indexed: &PreparedPoolInfoDto,
    state: &PoolState,
) -> Result<(), String> {
    let lp_hash = hex::decode(&indexed.ft_lp_partial_hash)
        .map_err(|error| format!("Pool LP partial hash: {error}"))?;
    let ft_hash = hex::decode(&indexed.ft_a_partial_hash)
        .map_err(|error| format!("Pool FT partial hash: {error}"))?;
    if lp_hash.len() != 32
        || ft_hash.len() != 32
        || state.amounts.ft_lp_raw != parse_u64_text(&indexed.lp_balance, "Pool LP balance")?
        || state.amounts.ft_a_raw != parse_u64_text(&indexed.token_balance, "Pool token balance")?
        || state.amounts.tbc_sat != parse_u64_text(&indexed.tbc_balance, "Pool TBC balance")?
        || state.service_fee_rate != indexed.service_fee_rate
        || state.ft_lp_partial_hash != lp_hash
        || state.ft_a_partial_hash != ft_hash
        || state.ft_a_contract_id
            != parse_txid(&indexed.ft_contract_id, "Pool FT contract id")
                .map_err(|error| error.to_string())?
    {
        return Err("Pool endpoint state does not match the current NTape".to_owned());
    }
    Ok(())
}

fn select_owner_ft_candidate(
    inputs: Vec<CombinedFtCandidate>,
    required_raw: u128,
    _required_human: &str,
    _contract_id: Txid,
) -> tbc_sdk::Result<Vec<CombinedFtCandidate>> {
    if inputs.is_empty() {
        return Err(tbc_sdk::Error::InvalidUtxo(
            "wallet has no FT-A UTXO for Pool operation".to_owned(),
        ));
    }
    select_fixed_pool_window(inputs, required_raw, "owner FT balance overflow", |count| {
        if count >= MAX_POOL_AUTO_MERGE_UTXOS {
            "PoolNFT automatic merge limit reached: 100 owner FT UTXOs are still insufficient"
                .to_owned()
        } else {
            "Pool operation has insufficient owner FT balance".to_owned()
        }
    })
}

fn select_pool_ft_candidates(
    inputs: Vec<CombinedFtCandidate>,
    required_raw: u128,
    _direct_limit: usize,
) -> tbc_sdk::Result<Vec<CombinedFtCandidate>> {
    select_fixed_pool_window(inputs, required_raw, "Pool FT balance overflow", |count| {
        if count >= MAX_POOL_AUTO_MERGE_UTXOS {
            "PoolNFT automatic merge limit reached: 100 pool FT UTXOs are still insufficient"
                .to_owned()
        } else {
            "Pool operation has insufficient pool FT balance".to_owned()
        }
    })
}

fn select_ftlp_candidates(
    inputs: Vec<CombinedFtCandidate>,
    required_raw: u128,
    _direct_limit: usize,
) -> tbc_sdk::Result<Vec<CombinedFtCandidate>> {
    if inputs.is_empty() {
        return Err(tbc_sdk::Error::InvalidUtxo(
            "wallet has no FT-LP UTXO for Pool consume".to_owned(),
        ));
    }
    select_fixed_pool_window(inputs, required_raw, "FT-LP balance overflow", |count| {
        if count >= MAX_POOL_AUTO_MERGE_UTXOS {
            "PoolNFT automatic merge limit reached: 100 FT-LP UTXOs are still insufficient"
                .to_owned()
        } else {
            "Pool operation has insufficient FT-LP balance".to_owned()
        }
    })
}

fn select_fixed_pool_window(
    mut inputs: Vec<CombinedFtCandidate>,
    required_raw: u128,
    overflow_message: &str,
    insufficient_message: impl FnOnce(usize) -> String,
) -> tbc_sdk::Result<Vec<CombinedFtCandidate>> {
    inputs.sort_by(|left, right| {
        left.indexed_balance
            .cmp(&right.indexed_balance)
            .then_with(|| left.txid_text.cmp(&right.txid_text))
            .then_with(|| left.output_index.cmp(&right.output_index))
    });
    let input_count = inputs.len().min(MAX_POOL_AUTO_MERGE_UTXOS);
    let mut prefix = Vec::with_capacity(inputs.len() + 1);
    prefix.push(0_u128);
    for input in &inputs {
        prefix.push(
            prefix
                .last()
                .copied()
                .unwrap_or_default()
                .checked_add(input.indexed_balance)
                .ok_or_else(|| tbc_sdk::Error::InvalidUtxo(overflow_message.to_owned()))?,
        );
    }
    let window_sum = |start: usize| prefix[start + input_count] - prefix[start];
    let max_start = inputs.len().saturating_sub(input_count);
    if input_count == 0 || window_sum(max_start) < required_raw {
        return Err(tbc_sdk::Error::InvalidUtxo(insufficient_message(
            inputs.len(),
        )));
    }
    let mut left = 0;
    let mut right = max_start;
    while left < right {
        let middle = (left + right) / 2;
        if window_sum(middle) >= required_raw {
            right = middle;
        } else {
            left = middle + 1;
        }
    }
    Ok(inputs[left..left + input_count].to_vec())
}
