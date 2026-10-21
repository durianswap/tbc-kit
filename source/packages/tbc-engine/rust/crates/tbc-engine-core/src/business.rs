//! Unified operation resolution inside the bound public Engine. No I/O, keys,
//! labels-as-authority or failed-builder fallback. The outer request is immutable.
use tbc_sdk::Transaction;
use crate::{EngineError, ErrorCode, model::{CanonicalRequest, WalletMaterial, error},
    normalize::{validate_request, hex}, families::ft::decode_hex,
    protocols::fungible_change::{inspect_fungible_pair, FungibleProtocol}};

pub(crate) const INTENTS: [&str; 14] = [
    "tbc20.transfer", "tbc20.merge", "tbc20Stablecoin.transfer", "tbc20Stablecoin.merge",
    "tbc721.transfer",
    "amm.swap", "amm.addLiquidity", "amm.removeLiquidity",
    "amm.mergeToken", "tbc20Lp.transfer", "tbc20Lp.lock", "tbc20Lp.unlock", "tbc20Lp.merge", "tbc20Lp.burn",
];
pub(crate) fn is_unified(kind: &str) -> bool { INTENTS.contains(&kind) }
fn invalid(message: &str) -> EngineError { error(ErrorCode::InvalidInput, message, "request.intent") }
fn material_error(message: &str) -> EngineError { error(ErrorCode::InvalidAncestry, message, "snapshot.payload.contracts") }

/// Reuse supported parameter validation without claiming a template before
/// material exists. Concrete validation is repeated AFTER exact resolution.
pub(crate) fn validate(request: &CanonicalRequest) -> Result<(), EngineError> {
    if request.intent.intent_type.starts_with("tbc20Lp.") || request.intent.intent_type=="amm.mergeToken" {
        // Validate the actual operation shape without choosing a template.
        let current=request.intent.intent_type!="tbc20Lp.burn" && request.intent.intent_type!="amm.mergeToken";
        return validate_request(&maintenance_project(request,current)?);
    }
    if request.intent.intent_type.starts_with("amm.") {
        return pool_validate(request);
    }
    if request.intent.intent_type == "tbc721.transfer" {
        let mut shape = request.clone();
        shape.intent.intent_type = "tbc721-standard-transfer".into();
        return validate_request(&shape);
    }
    let value = serde_json::to_value(&request.intent).map_err(|_| invalid("invalid unified intent"))?;
    let merge = request.intent.intent_type.ends_with(".merge");
    let allowed = if merge { & ["type", "version", "contractId"][..] }
        else { &["type", "version", "contractId", "to", "amount", "receivers", "payment"][..] };
    if value.as_object().unwrap().keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid("field is not supported by the unified fungible operation"));
    }
    let mut shape = request.clone();
    let coin = request.intent.intent_type.starts_with("tbc20Stablecoin.") || request.intent.payment.is_some();
    shape.intent.intent_type = match (coin, merge) {
        (false, false) => "tbc20-standard-transfer", (false, true) => "tbc20-standard-merge",
        (true, false) => "tbc20-stablecoin-transfer", (true, true) => "tbc20-stablecoin-merge",
    }.into();
    validate_request(&shape)
}

pub(crate) fn resolve(request: &CanonicalRequest, material: &WalletMaterial<'_>) -> Result<CanonicalRequest, EngineError> {
    let pool = request.intent.intent_type.starts_with("amm.") || request.intent.intent_type.starts_with("tbc20Lp.");
    let contract_id = (if pool {&request.intent.pool_contract_id} else {&request.intent.contract_id})
        .as_deref().ok_or_else(|| invalid("target contract ID is required"))?;
    let mut records = material.snapshot.payload.contracts.iter().filter(|record| record.contract_id == contract_id);
    let record = records.next().ok_or_else(|| material_error("unified target contract material is absent"))?;
    if records.next().is_some() { return Err(material_error("unified target contract is ambiguous")); }
    // LP holder operations bind immutable Pool genesis, not mutable reserves.
    // Do not make an irrelevant current-Pool read a prerequisite for signing.
    let lp = request.intent.intent_type.starts_with("tbc20Lp.");
    let target = if lp && record.indexed_pool.is_none() {contract_id} else {record.current_outpoint.txid.as_str()};
    let mut parents = material.snapshot.payload.parents.iter().filter(|parent| parent.txid == target);
    let parent = parents.next().ok_or_else(|| material_error("unified target parent material is absent"))?;
    if parents.next().is_some() { return Err(material_error("unified target parent is ambiguous")); }
    if parent.raw_transaction.len() > 2 * 1_048_576 { return Err(material_error("unified target parent exceeds bound")); }
    let bytes = decode_hex(&parent.raw_transaction, "snapshot.payload.parents")?;
    if bytes.len() > 1_048_576 || hex(&bytes) != parent.raw_transaction { return Err(material_error("unified target parent encoding is invalid")); }
    let tx = Transaction::from_bytes(&bytes).map_err(|_| material_error("unified target parent cannot be decoded"))?;
    if tx.txid().to_string() != parent.txid { return Err(material_error("unified target parent txid mismatch")); }
    let index = if lp {0} else {record.current_outpoint.vout as usize};
    let code = tx.outputs.get(index).ok_or_else(|| material_error("unified target Code is absent"))?;
    if pool {
        if record.family != "pool" || index != 0 {return Err(material_error("unified Pool family or Code outpoint conflicts"));}
        let current = crate::protocols::pool_origin::inspect_pool_profile(&tx)
            .map_err(|_| material_error("unified Pool template does not match"))?
            == crate::protocols::pool_origin::PoolProfile::Current;
        let resolved = if request.intent.intent_type.starts_with("tbc20Lp.") || request.intent.intent_type=="amm.mergeToken" {
            maintenance_project(request,current)?
        } else { pool_project(request, current)? };
        validate_request(&resolved)?;
        // The selected builder independently binds Tape, underlying FT/LP,
        // genesis, controller, policy and reserve state. No execution fallback.
        return Ok(resolved);
    }
    if request.intent.intent_type == "tbc721.transfer" {
        if record.family != "nft" || index != 0 {
            return Err(material_error("unified NFT family or Code outpoint conflicts"));
        }
        let (profile, _) = crate::protocols::nft_origin::inspect_nft_code(&code.script_pubkey)
            .map_err(|_| material_error("unified NFT template does not match"))?;
        let current = profile == crate::protocols::nft_origin::NftOriginProfile::Current;
        let mut resolved = request.clone();
        resolved.intent.intent_type = if current {"tbc721-standard-transfer"} else {"tbc.nft.transfer"}.into();
        if !current && resolved.intent.payment.is_some() {
            return Err(invalid("historical NFT transfer does not support an attached payment"));
        }
        validate_request(&resolved)?;
        // Existing planners validate Hold/Tape, lineage, ownership, actual
        // template metadata and all selected inputs. Code classification alone
        // cannot authorize an NFT or disguise a Coin issuer as a spendable NFT.
        return Ok(resolved);
    }
    let pair = inspect_fungible_pair(code, tx.outputs.get(index + 1))
        .map_err(|_| material_error("unified target Code/Tape is invalid"))?
        .ok_or_else(|| material_error("unified target template is unrecognized"))?;
    let coin = request.intent.intent_type.starts_with("tbc20Stablecoin.");
    let merge = request.intent.intent_type.ends_with(".merge");
    let (current, expected_family) = match pair.identity.protocol {
        FungibleProtocol::Tbc20Standard if !coin => (true, "ft"),
        FungibleProtocol::Coin if coin => (true, "stablecoin"),
        FungibleProtocol::HistoricalFt(4) if !coin => (false, "ft"),
        FungibleProtocol::HistoricalStableCoin(4) if coin => (false, "stablecoin"),
        _ => return Err(material_error("unified target family or template version is not supported")),
    };
    if record.family != expected_family { return Err(material_error("unified target family conflicts with script")); }
    let mut resolved = request.clone();
    resolved.intent.intent_type = match (current, coin, merge) {
        (true, false, false) => "tbc20-standard-transfer", (true, false, true) => "tbc20-standard-merge",
        (true, true, false) => "tbc20-stablecoin-transfer", (true, true, true) => "tbc20-stablecoin-merge",
        (false, false, false) => "tbc.ft.transfer", (false, false, true) => "tbc.ft.merge",
        (false, true, false) => "tbc.stablecoin.transfer", (false, true, true) => "tbc.stablecoin.merge",
    }.into();
    if !current {
        if let Some(receivers) = &resolved.intent.receivers {
            if receivers.len() == 1 {
                resolved.intent.to = Some(receivers[0].to.clone());
                resolved.intent.amount = Some(receivers[0].amount.clone());
                resolved.intent.receivers = None;
            } else if coin || receivers.len() > 5 {
                return Err(invalid("historical FT supports at most five receivers; historical Coin requires one"));
            }
        }
        if let Some(payment) = resolved.intent.payment.take() {
            if Some(&payment.to) != resolved.intent.to.as_ref() {
                return Err(invalid("historical native payment must use the token receiver"));
            }
            resolved.intent.attached_tbc_amount = Some(payment.amount);
        }
    }
    validate_request(&resolved)?;
    // Actual builders still authenticate Genesis/ancestry, all selected inputs,
    // ownership, policy, and output semantics. Classification is NOT approval.
    Ok(resolved)
}

fn maintenance_project(request: &CanonicalRequest, current: bool) -> Result<CanonicalRequest, EngineError> {
    let mut resolved=request.clone();
    resolved.intent.intent_type=match (current,request.intent.intent_type.as_str()) {
        (true,"tbc20Lp.transfer")=>"tbc20-lp-transfer",
        (true,"tbc20Lp.lock")=>"tbc20-lp-lock",
        (true,"tbc20Lp.unlock")=>"tbc20-lp-unlock",
        (true,"tbc20Lp.merge")=>"tbc20-lp-merge",
        (false,"tbc20Lp.merge")=>"tbc.pool.ftlp.merge",
        (false,"tbc20Lp.burn")=>"tbc.pool.ftlp.burn",
        (false,"amm.mergeToken")=>"tbc.pool.ft.merge",
        _=>return Err(error(ErrorCode::UnsupportedIntent,"operation is not supported for the authenticated Pool template","request.intent.type")),
    }.into();
    Ok(resolved)
}

fn pool_project(request: &CanonicalRequest, current: bool) -> Result<CanonicalRequest, EngineError> {
    let mut resolved = request.clone();let i = &mut resolved.intent;
    if current {
        i.intent_type = match i.intent_type.as_str() {
            "amm.swap" => "tbc-amm-swap", "amm.addLiquidity" => "tbc-amm-add-liquidity",
            "amm.removeLiquidity" => "tbc-amm-remove-liquidity", _ => return Err(invalid("unsupported unified Pool operation")),
        }.into();return Ok(resolved);
    }
    if i.pool_state_hash.is_some() || resolved.signing_roles.is_some() {
        return Err(invalid("historical Pool does not support the requested state commitment or independent signing role"));
    }
    i.receiver.get_or_insert_with(|| request.from.clone());
    i.intent_type = match i.intent_type.as_str() {
        "amm.swap" => {
            let buy = i.direction.take().as_deref() == Some("tbc-to-ft");
            if buy {i.tbc_amount = i.amount.take();i.minimum_ft_amount = i.minimum_output.take();"tbc.pool.swap.exactTbcForToken"}
            else {i.ft_amount = i.amount.take();i.minimum_tbc_amount = i.minimum_output.take();"tbc.pool.swap.exactTokenForTbc"}
        },
        "amm.removeLiquidity" => "tbc.pool.liquidity.remove",
        "amm.addLiquidity" => {
            if i.budget_asset.as_deref() != Some("tbc") || i.initial_ft_amount.is_some()
                || i.maximum_tbc_amount.is_some() || i.maximum_ft_amount.is_some() {
                return Err(invalid("historical Pool add supports only a TBC budget without new-template bounds"));
            }
            i.budget_asset = None;i.tbc_amount = i.amount.take();i.lock_until_height = i.lock_time.take();
            "tbc.pool.liquidity.add"
        },
        _ => return Err(invalid("unsupported unified Pool operation")),
    }.into();Ok(resolved)
}

fn pool_validate(request: &CanonicalRequest) -> Result<(), EngineError> {
    let mut shape = pool_project(request, true)?;
    // The request has no authenticated template yet. Preserve the historical
    // uint64 range rather than applying the current template's smaller ceiling.
    // Real amounts are validated again by the selected concrete implementation.
    for (name, field, positive) in [
        ("amount", &mut shape.intent.amount, true),
        ("minimumOutput", &mut shape.intent.minimum_output, false),
        ("lpAmount", &mut shape.intent.lp_amount, true),
        ("minimumLpAmount", &mut shape.intent.minimum_lp_amount, false),
        ("minimumTbcAmount", &mut shape.intent.minimum_tbc_amount, false),
        ("minimumFtAmount", &mut shape.intent.minimum_ft_amount, false),
        ("initialFtAmount", &mut shape.intent.initial_ft_amount, true),
        ("maximumTbcAmount", &mut shape.intent.maximum_tbc_amount, true),
        ("maximumFtAmount", &mut shape.intent.maximum_ft_amount, true),
    ] {
        if let Some(value) = field {
            let n = crate::normalize::parse_decimal_u64(value, name)?;
            if positive && n == 0 {return Err(invalid("unified Pool amount must be positive"));}
            *value = if n == 0 {"0"} else {"1"}.into();
        }
    }
    validate_request(&shape)
}
