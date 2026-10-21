use std::collections::BTreeSet;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tbc_sdk::Address;
use unicode_normalization::UnicodeNormalization;

use crate::model::{
    CanonicalRequest, NormalizeRequestParams, NormalizeRequestResult, WIRE_VERSION, error,
    parse_input, to_value,
};
use crate::{EngineError, ErrorCode};

pub(crate) const TBC721_INTENTS: [&str;4] = ["tbc721-standard-create-collection", "tbc721-standard-mint", "tbc721-standard-batch-mint", "tbc721-standard-transfer"];
pub(crate) const COIN_INTENTS: [&str;6] = ["tbc20-stablecoin-create", "tbc20-stablecoin-transfer", "tbc20-stablecoin-merge",
    "tbc20-stablecoin-mint", "tbc20-stablecoin-freeze", "tbc20-stablecoin-unfreeze"];
pub(crate) const LP_INTENTS:[&str;4]=["tbc20-lp-transfer","tbc20-lp-merge","tbc20-lp-lock","tbc20-lp-unlock"];
pub(crate) const AMM_INTENTS:[&str;4]=["tbc-amm-create","tbc-amm-add-liquidity","tbc-amm-remove-liquidity","tbc-amm-swap"];
pub(crate) const TIMELOCK_INTENTS: [&str; 2] = ["tbc-timelock-lock", "tbc-timelock-unlock"];
pub(crate) const HTLC_INTENTS: [&str; 3] = ["tbc-htlc-lock", "tbc-htlc-claim", "tbc-htlc-refund"];
pub(crate) const LOP_INTENTS: [&str; 3] = ["tbc-lop-create", "tbc-lop-cancel", "tbc-lop-match"];

const POOL_INTENTS: [&str; 9] = [
    "tbc.pool.create",
    "tbc.pool.liquidity.add",
    "tbc.pool.liquidity.remove",
    "tbc.pool.liquidity.close",
    "tbc.pool.swap.exactTbcForToken",
    "tbc.pool.swap.exactTokenForTbc",
    "tbc.pool.ft.merge",
    "tbc.pool.ftlp.merge",
    "tbc.pool.ftlp.burn",
];

pub(crate) fn normalize_request(input: Value) -> Result<Value, EngineError> {
    reject_unsupported_intent(&input)?;
    let params: NormalizeRequestParams = parse_input(input)?;
    validate_version(&params.version, "version")?;
    validate_request(&params.request)?;
    let request_hash = canonical_hash(&params.request)?;
    to_value(NormalizeRequestResult {
        request: params.request,
        request_hash,
    })
}

pub(crate) fn validate_request(request: &CanonicalRequest) -> Result<(), EngineError> {
    if crate::business::is_unified(&request.intent.intent_type) {
        return crate::business::validate(request);
    }
    validate_version(&request.version, "request.version")?;
    validate_version(&request.intent.version, "request.intent.version")?;
    crate::signing_wire::validate_requested_roles(request)?;
    if !matches!(
        request.intent.intent_type.as_str(),
        "tbc.transfer" | "tbc.maintenance.merge" | "tbc.collection.create" | "tbc.nft.mint" | "tbc.nft.transfer"
            | "tbc.ft.create" | "tbc.ft.transfer" | "tbc.ft.merge" | "tbc.stablecoin.transfer" | "tbc.stablecoin.merge"
            | "tbc.pool.create" | "tbc.pool.liquidity.add" | "tbc.pool.liquidity.remove"
            | "tbc.pool.liquidity.close" | "tbc.pool.swap.exactTbcForToken"
            | "tbc.pool.swap.exactTokenForTbc" | "tbc.pool.ft.merge" | "tbc.pool.ftlp.merge" | "tbc.pool.ftlp.burn"
            | "tbc20-standard-create" | "tbc20-standard-transfer" | "tbc20-standard-merge"
    ) && !TBC721_INTENTS.contains(&request.intent.intent_type.as_str()) && !COIN_INTENTS.contains(&request.intent.intent_type.as_str()) && !LP_INTENTS.contains(&request.intent.intent_type.as_str()) && !AMM_INTENTS.contains(&request.intent.intent_type.as_str()) && !TIMELOCK_INTENTS.contains(&request.intent.intent_type.as_str()) && !HTLC_INTENTS.contains(&request.intent.intent_type.as_str()) && !LOP_INTENTS.contains(&request.intent.intent_type.as_str()) {
        return Err(error(
            ErrorCode::UnsupportedIntent,
            format!("unsupported transaction intent: {}", request.intent.intent_type),
            "request.intent.type",
        ));
    }
    if request.chain_id.is_empty() {
        return Err(error(
            ErrorCode::InvalidInput,
            "chainId must not be empty",
            "request.chainId",
        ));
    }
    Address::from_string(&request.from).map_err(|_| {
        error(
            ErrorCode::InvalidInput,
            "sender address is not a canonical TBC P2PKH address",
            "request.from",
        )
    })?;
    validate_intent_field_isolation(request)?;
    match request.intent.intent_type.as_str() {
        kind if LOP_INTENTS.contains(&kind)=>{}, // checked by field isolation
        kind if TIMELOCK_INTENTS.contains(&kind)=>{}, // checked by field isolation above
        kind if HTLC_INTENTS.contains(&kind)=>{}, // checked by field isolation above
        "tbc-amm-create"=>crate::families::amm::validate_create_request(request)?,
        kind if AMM_INTENTS.contains(&kind)=>crate::families::amm_actions::validate_request_fields(request)?,
        kind if LP_INTENTS.contains(&kind)=>crate::families::lp::validate_lp_request(request)?,
        kind if COIN_INTENTS.contains(&kind) && kind!="tbc20-stablecoin-create" => {
            forbid_fields(request, &["name", "description", "supply", "media", "symbol", "decimals", "initialSupply", "collectionId", "attributes", "attachedTbcAmount"])?;
            validate_contract_id(required(&request.intent.contract_id, "request.intent.contractId")?, "request.intent.contractId")?;
            if kind=="tbc20-stablecoin-transfer" {
                if tbc20_transfer_recipients(request)?.len()>7 {return Err(error(ErrorCode::InvalidInput,"Coin recipients must leave room for native change","request.intent.receivers"));}
                if let Some(payment)=&request.intent.payment {
                    Address::from_string(&payment.to).map_err(|_|error(ErrorCode::InvalidInput,"invalid Coin payment address","request.intent.payment.to"))?;
                    let amount=parse_decimal_u64(&payment.amount,"request.intent.payment.amount")?;
                    if !(24..=9_007_199_254_740_991).contains(&amount) {return Err(error(ErrorCode::InvalidInput,"Coin payment must be 24 or more safe atomic units","request.intent.payment.amount"));}
                }
            }else if kind=="tbc20-stablecoin-mint" {
                let amount=parse_decimal_u64(required(&request.intent.amount,"request.intent.amount")?,"request.intent.amount")?;
                if amount==0 || amount>crate::protocols::tbc20::MAX_SLOT_AMOUNT {return Err(error(ErrorCode::InvalidInput,"Coin mint amount must fit a positive signed-64 slot","request.intent.amount"));}
                Address::from_string(required(&request.intent.to,"request.intent.to")?).map_err(|_|error(ErrorCode::InvalidInput,"Coin mint recipient invalid","request.intent.to"))?;
                if let Some(point)=request.intent.certificate_outpoint.as_ref() {
                    validate_contract_id(&point.txid,"request.intent.certificateOutpoint.txid")?;
                    if point.vout!=0 {return Err(error(ErrorCode::InvalidInput,"Coin certificate must select Code output zero","request.intent.certificateOutpoint.vout"));}
                }
            }else {
                forbid_fields(request,&["to","amount"])?;
                if request.intent.receivers.is_some() || request.intent.payment.is_some() {return Err(error(ErrorCode::InvalidInput,"Coin merge has no recipients or additional payment","request.intent"));}
                if matches!(kind,"tbc20-stablecoin-freeze"|"tbc20-stablecoin-unfreeze") {
                    let points=request.intent.target_outpoints.as_ref().ok_or_else(||error(ErrorCode::InvalidInput,"Coin lock changes require exact target outpoints","request.intent.targetOutpoints"))?;
                    let mut unique=BTreeSet::new();
                    if points.is_empty() || points.len()>5 {return Err(error(ErrorCode::InvalidInput,"Coin lock changes support one to five exact inputs per transaction","request.intent.targetOutpoints"));}
                    for point in points {
                        validate_contract_id(&point.txid,"request.intent.targetOutpoints.txid")?;
                        if !unique.insert((&point.txid,point.vout)) {return Err(error(ErrorCode::InvalidInput,"Coin targets must be unique","request.intent.targetOutpoints"));}
                    }
                    if kind=="tbc20-stablecoin-freeze" {
                        let lock=parse_decimal_u64(required(&request.intent.lock_time,"request.intent.lockTime")?,"request.intent.lockTime")?;
                        if lock==0 || lock>u32::MAX as u64 {return Err(error(ErrorCode::InvalidInput,"Coin freeze lock must be positive uint32","request.intent.lockTime"));}
                    }
                }
            }
        }
        kind if TBC721_INTENTS.contains(&kind) => validate_tbc721_request(request)?,
        "tbc20-standard-create" | "tbc20-stablecoin-create" => {
            forbid_fields(request, &["amount", "description", "supply", "media", "contractId", "collectionId", "attributes", "attachedTbcAmount"])?;
            let name = required(&request.intent.name, "request.intent.name")?;
            let symbol = required(&request.intent.symbol, "request.intent.symbol")?;
            if name.is_empty() || name.nfc().ne(name.chars()) || symbol.is_empty()
                || !symbol.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
                || (request.intent.intent_type=="tbc20-standard-create" && name.len() + symbol.len() > 53)
                || name.len()>61 || symbol.len()>61
            {
                return Err(error(ErrorCode::InvalidInput,
                    "new token name must be NFC and symbol printable ASCII within the protocol metadata byte limit",
                    "request.intent"));
            }
            if request.intent.decimals.is_none_or(|value| value > 18) {
                return Err(error(ErrorCode::InvalidInput, "TBC20 decimals must be 0 through 18", "request.intent.decimals"));
            }
            if request.intent.intent_type=="tbc20-stablecoin-create" {
                let mut metadata=tbc_sdk::script::Script::empty();
                metadata.push_data(&[request.intent.decimals.unwrap()]);metadata.push_data(name.as_bytes());metadata.push_data(symbol.as_bytes());
                if metadata.as_bytes().len()>crate::protocols::coin::MAX_TAPE_BYTES-crate::protocols::coin::MIN_TAPE_BYTES {
                    return Err(error(ErrorCode::InvalidInput,"Coin metadata exceeds its 61-byte Tape extension","request.intent"));
                }
            }
            let supply = parse_decimal_u64(required(&request.intent.initial_supply, "request.intent.initialSupply")?, "request.intent.initialSupply")?;
            if supply == 0 || supply > crate::protocols::tbc20::MAX_SLOT_AMOUNT {
                return Err(error(ErrorCode::InvalidInput, "TBC20 initial supply must fit one positive signed-64 Tape slot", "request.intent.initialSupply"));
            }
            if let Some(to) = &request.intent.to {
                Address::from_string(to).map_err(|_| error(ErrorCode::InvalidInput, "invalid TBC20 recipient", "request.intent.to"))?;
            }
        }
        "tbc20-standard-transfer" => {
            forbid_fields(request, &["name", "description", "supply", "media", "symbol", "decimals", "initialSupply", "collectionId", "attributes", "attachedTbcAmount"])?;
            validate_contract_id(required(&request.intent.contract_id, "request.intent.contractId")?, "request.intent.contractId")?;
            tbc20_transfer_recipients(request)?;
            if let Some(payment) = &request.intent.payment {
                Address::from_string(&payment.to).map_err(|_| error(ErrorCode::InvalidInput,
                    "invalid native payment address", "request.intent.payment.to"))?;
                let amount = parse_decimal_u64(&payment.amount, "request.intent.payment.amount")?;
                if !(42..=9_007_199_254_740_991).contains(&amount) {
                    return Err(error(ErrorCode::InvalidInput, "TBC20 payment must be 42 or more safe atomic units", "request.intent.payment.amount"));
                }
            }
        }
        "tbc20-standard-merge" => {
            forbid_fields(request, &["to", "amount", "name", "description", "supply", "media", "symbol", "decimals", "initialSupply", "collectionId", "attributes", "attachedTbcAmount"])?;
            validate_contract_id(required(&request.intent.contract_id, "request.intent.contractId")?, "request.intent.contractId")?;
        }
        "tbc.transfer" => {
            let to = required(&request.intent.to, "request.intent.to")?;
            Address::from_string(to).map_err(|_| {
                error(
                    ErrorCode::InvalidInput,
                    "recipient address is not a canonical TBC P2PKH address",
                    "request.intent.to",
                )
            })?;
            let amount = parse_decimal_u64(
                required(&request.intent.amount, "request.intent.amount")?,
                "request.intent.amount",
            )?;
            if amount < tbc_sdk::SDK_DUST_SAT {
                return Err(error(
                    ErrorCode::InvalidInput,
                    format!(
                        "recipient output must be at least {} satoshis",
                        tbc_sdk::SDK_DUST_SAT
                    ),
                    "request.intent.amount",
                ));
            }
            forbid_ft_create_fields(request)?;
            if request.intent.contract_id.is_some() || request.intent.attached_tbc_amount.is_some() {
                return Err(error(
                    ErrorCode::InvalidInput,
                    "native transfer contains FT-only fields",
                    "request.intent",
                ));
            }
        }
        "tbc.maintenance.merge" => {
            forbid_fields(request, &["to", "amount", "name", "description", "supply", "media", "symbol", "decimals", "initialSupply", "contractId", "collectionId", "attributes", "attachedTbcAmount"])?;
        }
        "tbc.ft.create" => {
            if request.intent.to.is_some()
                || request.intent.amount.is_some()
                || request.intent.contract_id.is_some()
                || request.intent.attached_tbc_amount.is_some()
            {
                return Err(error(
                    ErrorCode::InvalidInput,
                    "FT create contains transfer-only fields",
                    "request.intent",
                ));
            }
            let name = required(&request.intent.name, "request.intent.name")?;
            if !valid_ft_metadata_text(name) {
                return Err(error(
                    ErrorCode::InvalidInput,
                    "FT name must contain 1 to 256 UTF-8 bytes",
                    "request.intent.name",
                ));
            }
            let symbol = required(&request.intent.symbol, "request.intent.symbol")?;
            if !valid_ft_metadata_text(symbol) {
                return Err(error(
                    ErrorCode::InvalidInput,
                    "FT symbol must contain 1 to 256 UTF-8 bytes",
                    "request.intent.symbol",
                ));
            }
            // The supported V4 template embeds a one-byte Tape size. Reject
            // larger metadata before creating a token this engine cannot spend.
            if tbc_sdk::contracts::ft::scripts::mint_tape_script(&[0u8; 48], 0, name, symbol)
                .as_bytes().len() > 255
            {
                return Err(error(
                    ErrorCode::InvalidInput,
                    "FT V4 encoded metadata Tape must not exceed 255 bytes",
                    "request.intent",
                ));
            }
            if request.intent.decimals.is_none_or(|value| value > 18) {
                return Err(error(
                    ErrorCode::InvalidInput,
                    "FT decimals must be in the range 0 through 18",
                    "request.intent.decimals",
                ));
            }
            let supply = parse_decimal_u128(
                required(&request.intent.initial_supply, "request.intent.initialSupply")?,
                "request.intent.initialSupply",
            )?;
            if supply == 0 || supply > 10u128.pow(18) || supply > u64::MAX as u128 {
                return Err(error(
                    ErrorCode::InvalidInput,
                    "FT supply must be between 1 and 10^18 raw units and fit a V4 tape slot",
                    "request.intent.initialSupply",
                ));
            }
        }
        "tbc.ft.transfer" => {
            forbid_ft_create_fields(request)?;
            let contract = required(&request.intent.contract_id, "request.intent.contractId")?;
            if contract.len() != 64
                || !contract.bytes().all(|byte| byte.is_ascii_hexdigit())
                || contract.bytes().any(|byte| byte.is_ascii_uppercase())
            {
                return Err(error(
                    ErrorCode::InvalidInput,
                    "FT contractId must be 32-byte lowercase hexadecimal",
                    "request.intent.contractId",
                ));
            }
            let recipients = tbc20_transfer_recipients(request)?;
            let amount: u128 = recipients.iter().map(|recipient| recipient.amount).sum();
            if recipients.len() > 5 || amount > 10u128.pow(18) {
                return Err(error(
                    ErrorCode::InvalidInput,
                    "FT transfer requires at most five receivers and a total of at most 10^18 raw units",
                    "request.intent.receivers",
                ));
            }
            if request.intent.receivers.is_some() && request.intent.attached_tbc_amount.is_some() {
                return Err(error(ErrorCode::InvalidInput, "historical attached TBC requires the single to/amount form", "request.intent.attachedTbcAmount"));
            }
            if let Some(attached) = request.intent.attached_tbc_amount.as_deref() {
                parse_decimal_u64(attached, "request.intent.attachedTbcAmount")?;
            }
        }
        "tbc.ft.merge" | "tbc.stablecoin.merge" => {
            forbid_fields(request, &["to", "amount", "name", "description", "supply", "media", "symbol", "decimals", "initialSupply", "collectionId", "attributes", "attachedTbcAmount"])?;
            validate_contract_id(required(&request.intent.contract_id, "request.intent.contractId")?, "request.intent.contractId")?;
        }
        "tbc.collection.create" => {
            forbid_fields(request, &["to", "amount", "symbol", "decimals", "initialSupply", "contractId", "collectionId", "attributes", "attachedTbcAmount"])?;
            validate_name(required(&request.intent.name, "request.intent.name")?, "request.intent.name")?;
            validate_description(required(&request.intent.description, "request.intent.description")?, "request.intent.description")?;
            let supply = parse_decimal_u64(required(&request.intent.supply, "request.intent.supply")?, "request.intent.supply")?;
            if !(1..=2_000).contains(&supply) {
                return Err(error(ErrorCode::InvalidInput, "collection supply must be between 1 and 2000", "request.intent.supply"));
            }
            validate_media(request.intent.media.as_ref().ok_or_else(|| error(ErrorCode::InvalidInput, "collection media is required", "request.intent.media"))?, "request.intent.media")?;
        }
        "tbc.nft.mint" => {
            forbid_fields(request, &["to", "amount", "supply", "decimals", "initialSupply", "contractId", "attachedTbcAmount"])?;
            validate_contract_id(required(&request.intent.collection_id, "request.intent.collectionId")?, "request.intent.collectionId")?;
            validate_name(required(&request.intent.name, "request.intent.name")?, "request.intent.name")?;
            validate_description(required(&request.intent.description, "request.intent.description")?, "request.intent.description")?;
            let symbol = required(&request.intent.symbol, "request.intent.symbol")?;
            if symbol.is_empty() || symbol.len() > 16 || !symbol.bytes().all(|byte| (b'!'..=b'~').contains(&byte)) {
                return Err(error(ErrorCode::InvalidInput, "NFT symbol must contain 1 to 16 printable ASCII characters", "request.intent.symbol"));
            }
            if request.intent.attributes.as_ref().is_none_or(|items| items.len() > 64) {
                return Err(error(ErrorCode::InvalidInput, "NFT attributes are required and limited to 64 entries", "request.intent.attributes"));
            }
            if let Some(media) = request.intent.media.as_ref() { validate_media(media, "request.intent.media")?; }
        }
        "tbc.nft.transfer" => {
            forbid_fields(request, &["amount", "name", "description", "supply", "media", "symbol", "decimals", "initialSupply", "collectionId", "attributes", "attachedTbcAmount"])?;
            validate_contract_id(required(&request.intent.contract_id, "request.intent.contractId")?, "request.intent.contractId")?;
            Address::from_string(required(&request.intent.to, "request.intent.to")?).map_err(|_| error(ErrorCode::InvalidInput, "invalid NFT recipient address", "request.intent.to"))?;
        }
        "tbc.stablecoin.transfer" => {
            forbid_fields(request, &["name", "description", "supply", "media", "symbol", "decimals", "initialSupply", "collectionId", "attributes"])?;
            validate_contract_id(required(&request.intent.contract_id, "request.intent.contractId")?, "request.intent.contractId")?;
            Address::from_string(required(&request.intent.to, "request.intent.to")?).map_err(|_| error(ErrorCode::InvalidInput, "invalid StableCoin recipient address", "request.intent.to"))?;
            let amount = parse_decimal_u128(required(&request.intent.amount, "request.intent.amount")?, "request.intent.amount")?;
            if amount == 0 || amount > 10u128.pow(18) { return Err(error(ErrorCode::InvalidInput, "StableCoin amount must be between 1 and 10^18 raw units", "request.intent.amount")); }
            if let Some(attached) = request.intent.attached_tbc_amount.as_deref() { parse_decimal_u64(attached, "request.intent.attachedTbcAmount")?; }
        }
        intent if POOL_INTENTS.contains(&intent) => crate::families::pool::validate_pool_request(request)?,
        _ => unreachable!("unsupported intents were rejected above"),
    }
    if let Some(max_fee) = request
        .constraints
        .as_ref()
        .and_then(|constraints| constraints.max_fee.as_ref())
    {
        parse_decimal_u64(max_fee, "request.constraints.maxFee")?;
    }
    if let Some(outpoints) = request
        .constraints
        .as_ref()
        .and_then(|constraints| constraints.input_outpoints.as_ref())
    {
        if !matches!(request.intent.intent_type.as_str(), "tbc.transfer" | "tbc.maintenance.merge"
            | "tbc20-standard-create" | "tbc20-standard-transfer" | "tbc20-standard-merge")
            && !TBC721_INTENTS.contains(&request.intent.intent_type.as_str()) && !COIN_INTENTS.contains(&request.intent.intent_type.as_str()) && !LP_INTENTS.contains(&request.intent.intent_type.as_str()) && !AMM_INTENTS.contains(&request.intent.intent_type.as_str()) && !TIMELOCK_INTENTS.contains(&request.intent.intent_type.as_str()) && !HTLC_INTENTS.contains(&request.intent.intent_type.as_str()) && !LOP_INTENTS.contains(&request.intent.intent_type.as_str()) {
            return Err(error(
                ErrorCode::InvalidInput,
                "explicit input outpoints are not supported for this intent",
                "request.constraints.inputOutpoints",
            ));
        }
        if outpoints.is_empty() || outpoints.len() > 128 {
            return Err(error(
                ErrorCode::InvalidInput,
                "explicit input outpoints require between 1 and 128 entries",
                "request.constraints.inputOutpoints",
            ));
        }
        let mut unique = BTreeSet::new();
        for (index, outpoint) in outpoints.iter().enumerate() {
            validate_contract_id(
                &outpoint.txid,
                &format!("request.constraints.inputOutpoints[{index}].txid"),
            )?;
            if !unique.insert((outpoint.txid.as_str(), outpoint.vout)) {
                return Err(error(
                    ErrorCode::InvalidInput,
                    "explicit input outpoints must be unique",
                    "request.constraints.inputOutpoints",
                ));
            }
        }
    }
    Ok(())
}

fn validate_intent_field_isolation(request: &CanonicalRequest) -> Result<(), EngineError> {
    if LOP_INTENTS.contains(&request.intent.intent_type.as_str()){return crate::families::lop::validate_request_fields(request);}
    if request.intent.order.is_some(){return Err(error(ErrorCode::InvalidInput,"order requires tbc-lop-create","request.intent.order"));}
    if HTLC_INTENTS.contains(&request.intent.intent_type.as_str()){return crate::families::htlc::validate_htlc_request(request);}
    if request.intent.hashlock.is_some() || request.intent.preimage.is_some() || request.intent.asset_standard.is_some() {
        return Err(error(ErrorCode::InvalidInput,"HTLC proof fields require their exact operation","request.intent"));
    }
    if TIMELOCK_INTENTS.contains(&request.intent.intent_type.as_str()){return crate::families::timelock::validate_timelock_request(request);}
    if request.intent.intent_type=="tbc-amm-create"{return crate::families::amm::validate_create_request(request);}
    if AMM_INTENTS.contains(&request.intent.intent_type.as_str()){return crate::families::amm_actions::validate_request_fields(request);}
    if LP_INTENTS.contains(&request.intent.intent_type.as_str()){return crate::families::lp::validate_lp_request(request);}
    let intent = &request.intent;
    if intent.controllers.is_some()||intent.lp_timelock.is_some()||intent.service_fee_rate.is_some()
        ||intent.direction.is_some()||intent.budget_asset.is_some()||intent.initial_ft_amount.is_some()
        ||intent.maximum_tbc_amount.is_some()||intent.maximum_ft_amount.is_some()||intent.minimum_output.is_some()||intent.pool_state_hash.is_some(){
        return Err(error(ErrorCode::InvalidInput,"new AMM fields require their exact operation","request.intent"));
    }
    if (intent.target_outpoints.is_some() && !matches!(intent.intent_type.as_str(),"tbc20-stablecoin-freeze"|"tbc20-stablecoin-unfreeze"))
        || (intent.lock_time.is_some() && intent.intent_type!="tbc20-stablecoin-freeze")
        || (intent.certificate_outpoint.is_some() && intent.intent_type!="tbc20-stablecoin-mint") {
        return Err(error(ErrorCode::InvalidInput,"Coin administrator fields are isolated to their exact operation","request.intent"));
    }
    if (intent.slot.is_some() || intent.items.is_some() || (intent.payment.is_some() && !matches!(intent.intent_type.as_str(), "tbc20-stablecoin-transfer" | "tbc20-standard-transfer")))
        && !TBC721_INTENTS.contains(&intent.intent_type.as_str()) {
        return Err(error(ErrorCode::InvalidInput,"new NFT fields are not supported for this intent","request.intent"));
    }
    if intent.receivers.is_some() && !matches!(intent.intent_type.as_str(),"tbc20-standard-transfer"|"tbc20-stablecoin-transfer"|"tbc.ft.transfer") {
        return Err(error(ErrorCode::InvalidInput, "receivers is only supported for tbc20-standard-transfer", "request.intent.receivers"));
    }
    let is_pool = POOL_INTENTS.contains(&intent.intent_type.as_str());
    let legacy_present = intent.to.is_some()
        || intent.amount.is_some()
        || intent.name.is_some()
        || intent.description.is_some()
        || intent.supply.is_some()
        || intent.media.is_some()
        || intent.symbol.is_some()
        || intent.decimals.is_some()
        || intent.initial_supply.is_some()
        || intent.contract_id.is_some()
        || intent.collection_id.is_some()
        || intent.attributes.is_some()
        || intent.attached_tbc_amount.is_some();
    let pool_present = intent.ft_contract_id.is_some()
        || intent.pool_contract_id.is_some()
        || intent.stage.is_some()
        || intent.lp_plan.is_some()
        || intent.service_provider_tag.is_some()
        || intent.initial_liquidity.is_some()
        || intent.receiver.is_some()
        || intent.tbc_amount.is_some()
        || intent.ft_amount.is_some()
        || intent.lp_amount.is_some()
        || intent.minimum_lp_amount.is_some()
        || intent.minimum_tbc_amount.is_some()
        || intent.minimum_ft_amount.is_some()
        || intent.lock.is_some()
        || intent.lock_until_height.is_some();
    if (is_pool && legacy_present) || (!is_pool && pool_present) {
        return Err(error(
            ErrorCode::InvalidInput,
            "intent contains fields from another public family",
            "request.intent",
        ));
    }
    Ok(())
}

pub(crate) fn parse_decimal_u128(value: &str, path: &str) -> Result<u128, EngineError> {
    if value.is_empty()
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err(error(
            ErrorCode::InvalidInput,
            "value must be a canonical unsigned decimal integer",
            path,
        ));
    }
    value.parse().map_err(|_| {
        error(
            ErrorCode::InvalidInput,
            "unsigned decimal integer exceeds uint128",
            path,
        )
    })
}

/// The public convenience shape and list shape share one ordered recipient
/// model. Keep the original single-recipient request bytes/hash unchanged.
/// Eight entries is only a material bound: the builder also counts change and
/// any amount-slot split against the real physical output budget.
pub(crate) struct Tbc20Recipient<'a> {
    pub to: &'a str,
    pub amount: u128,
    pub controller: [u8; 21],
}

pub(crate) fn tbc20_transfer_recipients(request: &CanonicalRequest) -> Result<Vec<Tbc20Recipient<'_>>, EngineError> {
    let intent = &request.intent;
    let entries: Vec<(&str, &str)> = if let Some(receivers) = &intent.receivers {
        if intent.to.is_some() || intent.amount.is_some() || receivers.is_empty() || receivers.len() > 8 {
            return Err(error(ErrorCode::InvalidInput, "TBC20 receivers requires 1..8 entries and cannot accompany to/amount", "request.intent.receivers"));
        }
        receivers.iter().map(|entry| (entry.to.as_str(), entry.amount.as_str())).collect()
    } else {
        vec![(required(&intent.to, "request.intent.to")?, required(&intent.amount, "request.intent.amount")?)]
    };
    let mut total = 0u128;
    let mut result = Vec::with_capacity(entries.len());
    for (index, (to, amount)) in entries.into_iter().enumerate() {
        let path = if intent.receivers.is_some() { format!("request.intent.receivers[{index}]") } else { "request.intent".to_owned() };
        let address=Address::from_string(to).map_err(|_| error(ErrorCode::InvalidInput, "invalid TBC20 recipient", &format!("{path}.to")))?;
        let amount = parse_decimal_u128(amount, &format!("{path}.amount"))?;
        total = total.checked_add(amount).ok_or_else(|| error(ErrorCode::InvalidInput, "TBC20 recipient sum exceeds uint128", "request.intent.receivers"))?;
        if amount == 0 || total > 36 * u128::from(crate::protocols::tbc20::MAX_SLOT_AMOUNT) {
            return Err(error(ErrorCode::InvalidInput, "TBC20 transfer amount exceeds the six-input Tape capacity", &format!("{path}.amount")));
        }
        let mut controller=[0;21];controller[..20].copy_from_slice(&address.hash160());
        result.push(Tbc20Recipient{to,amount,controller});
    }
    Ok(result)
}

fn required<'a>(value: &'a Option<String>, path: &str) -> Result<&'a str, EngineError> {
    value.as_deref().ok_or_else(|| {
        error(
            ErrorCode::InvalidInput,
            "required intent field is missing",
            path,
        )
    })
}

fn forbid_ft_create_fields(request: &CanonicalRequest) -> Result<(), EngineError> {
    if request.intent.name.is_some()
        || request.intent.symbol.is_some()
        || request.intent.decimals.is_some()
        || request.intent.initial_supply.is_some()
    {
        return Err(error(
            ErrorCode::InvalidInput,
            "transfer intent contains FT-create fields",
            "request.intent",
        ));
    }
    Ok(())
}

// Preserve the same UTF-8 bytes accepted for existing FT transfer metadata.
fn valid_ft_metadata_text(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256
}

fn validate_name(value: &str, path: &str) -> Result<(), EngineError> {
    if value.is_empty() || value.chars().count() > 64 || value.len() > 256 {
        return Err(error(ErrorCode::InvalidInput, "name must contain 1 to 64 characters and at most 256 UTF-8 bytes", path));
    }
    Ok(())
}

fn validate_description(value: &str, path: &str) -> Result<(), EngineError> {
    if value.chars().count() > 2_048 { return Err(error(ErrorCode::InvalidInput, "description exceeds 2048 characters", path)); }
    Ok(())
}

fn validate_contract_id(value: &str, path: &str) -> Result<(), EngineError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) {
        return Err(error(ErrorCode::InvalidInput, "contract identifier must be 32-byte lowercase hexadecimal", path));
    }
    Ok(())
}

fn validate_media(value: &Value, path: &str) -> Result<(), EngineError> {
    let object = value.as_object().ok_or_else(|| error(ErrorCode::InvalidInput, "media must be an object", path))?;
    let kind = object.get("kind").and_then(Value::as_str);
    let valid_hash = |value: &Value| value.as_str().is_some_and(|value| {
        value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    });
    let valid = match kind {
        Some("uri") => {
            object.keys().all(|key| matches!(key.as_str(), "kind" | "uri" | "mediaType" | "sha256"))
                && object.get("uri").and_then(Value::as_str).is_some_and(|value| !value.is_empty() && value.len() <= 8_192)
                && object.get("mediaType").is_none_or(|value| value.as_str().is_some_and(|value| !value.is_empty() && value.len() <= 255))
                && object.get("sha256").is_none_or(valid_hash)
        }
        Some("base64") => {
            object.keys().all(|key| matches!(key.as_str(), "kind" | "mediaType" | "data" | "sha256"))
                && object.get("mediaType").and_then(Value::as_str).is_some_and(|value| !value.is_empty() && value.len() <= 255)
                && object.get("data").and_then(Value::as_str).is_some_and(|value| !value.is_empty() && value.len() <= 1_398_104)
                && object.get("sha256").is_some_and(valid_hash)
        }
        _ => false,
    };
    if !valid { return Err(error(ErrorCode::InvalidInput, "media kind, payload, or sha256 is invalid", path)); }
    Ok(())
}

fn forbid_fields(request: &CanonicalRequest, fields: &[&str]) -> Result<(), EngineError> {
    let present = |field: &str| match field {
        "to" => request.intent.to.is_some(), "amount" => request.intent.amount.is_some(),
        "name" => request.intent.name.is_some(), "description" => request.intent.description.is_some(),
        "supply" => request.intent.supply.is_some(), "media" => request.intent.media.is_some(),
        "symbol" => request.intent.symbol.is_some(), "decimals" => request.intent.decimals.is_some(),
        "initialSupply" => request.intent.initial_supply.is_some(), "contractId" => request.intent.contract_id.is_some(),
        "collectionId" => request.intent.collection_id.is_some(), "attributes" => request.intent.attributes.is_some(),
        "attachedTbcAmount" => request.intent.attached_tbc_amount.is_some(), _ => false,
    };
    if fields.iter().any(|field| present(field)) { return Err(error(ErrorCode::InvalidInput, "intent contains fields from another operation", "request.intent")); }
    Ok(())
}

pub(crate) fn canonical_hash<T: Serialize>(value: &T) -> Result<String, EngineError> {
    let value = serde_json::to_value(value).map_err(|_| {
        error(
            ErrorCode::InternalInvariant,
            "failed to canonicalize value",
            "input",
        )
    })?;
    let bytes = serde_json::to_vec(&value).map_err(|_| {
        error(
            ErrorCode::InternalInvariant,
            "failed to serialize canonical value",
            "input",
        )
    })?;
    Ok(hex(&Sha256::digest(bytes)))
}

pub(crate) fn parse_decimal_u64(value: &str, path: &str) -> Result<u64, EngineError> {
    if value.is_empty()
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err(error(
            ErrorCode::InvalidInput,
            "value must be a canonical unsigned decimal integer",
            path,
        ));
    }
    value.parse().map_err(|_| {
        error(
            ErrorCode::InvalidInput,
            "unsigned decimal integer exceeds uint64",
            path,
        )
    })
}

pub(crate) fn validate_version(version: &str, path: &str) -> Result<(), EngineError> {
    if version == WIRE_VERSION {
        Ok(())
    } else {
        Err(error(
            ErrorCode::InvalidInput,
            "unsupported wire version",
            path,
        ))
    }
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

fn reject_unsupported_intent(input: &Value) -> Result<(), EngineError> {
    if input.get("request").and_then(|r| r.get("intent")).and_then(|i| i.get("type"))
        .and_then(Value::as_str).is_some_and(crate::business::is_unified) { return Ok(()); }
    if let Some(intent) = input
        .get("request")
        .and_then(|request| request.get("intent"))
        .and_then(|intent| intent.get("type"))
        .and_then(Value::as_str)
        && !matches!(
            intent,
            "tbc.transfer"
                | "tbc.ft.create"
                | "tbc.ft.transfer"
                | "tbc.ft.merge"
                | "tbc20-standard-create"
                | "tbc20-standard-transfer"
                | "tbc20-standard-merge"
                | "tbc.maintenance.merge"
                | "tbc.collection.create"
                | "tbc.nft.mint"
                | "tbc.nft.transfer"
                | "tbc.stablecoin.transfer"
                | "tbc.stablecoin.merge"
                | "tbc.pool.create"
                | "tbc.pool.liquidity.add"
                | "tbc.pool.liquidity.remove"
                | "tbc.pool.liquidity.close"
                | "tbc.pool.swap.exactTbcForToken"
                | "tbc.pool.swap.exactTokenForTbc"
                | "tbc.pool.ft.merge"
                | "tbc.pool.ftlp.merge"
                | "tbc.pool.ftlp.burn"
        ) && !TBC721_INTENTS.contains(&intent) && !COIN_INTENTS.contains(&intent) && !LP_INTENTS.contains(&intent) && !AMM_INTENTS.contains(&intent) && !TIMELOCK_INTENTS.contains(&intent) && !HTLC_INTENTS.contains(&intent) && !LOP_INTENTS.contains(&intent)
    {
        return Err(error(
            ErrorCode::UnsupportedIntent,
            format!("unsupported transaction intent: {intent}"),
            "request.intent.type",
        ));
    }
    Ok(())
}

// New-profile wire validation matches transaction-request media definitions.
// Keep historical validation unchanged; this is not an old-issuance policy.
fn validate_tbc721_media(value:&Value)->Result<(),EngineError> {
    let path="request.intent.media";
    let o=value.as_object().ok_or_else(||error(ErrorCode::InvalidInput,"NFT media must be an object",path))?;
    let hash=|v:&Value|v.as_str().is_some_and(|s|validate_contract_id(s,path).is_ok());
    let valid=match o.get("kind").and_then(Value::as_str) {
        Some("uri")=>o.keys().all(|k|matches!(k.as_str(),"kind"|"uri"|"sha256"))
            &&o.get("uri").and_then(Value::as_str).is_some_and(|s|s.chars().count()<=2048
                &&["https://","ipfs://","ar://"].iter().any(|prefix|s.starts_with(prefix)))
            &&o.get("sha256").is_none_or(hash),
        Some("base64")=>{
            let mime=o.get("mediaType").and_then(Value::as_str).is_some_and(|s|{
                let parts:Vec<_>=s.split('/').collect();parts.len()==2&&parts.iter().all(|p|{
                    let b=p.as_bytes();!b.is_empty()&&b.len()<=64&&(b[0].is_ascii_lowercase()||b[0].is_ascii_digit())
                        &&b.iter().all(|c|c.is_ascii_lowercase()||c.is_ascii_digit()||b"!#$&^_.+-".contains(c))
                })
            });
            let data=o.get("data").and_then(Value::as_str).is_some_and(|s|{
                if s.len()>2_796_204||s.len()%4!=0{return false;}
                let body=s.trim_end_matches('=');let padding=s.len()-body.len();
                padding<=2&&body.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'+'||b==b'/')
            });
            o.keys().all(|k|matches!(k.as_str(),"kind"|"mediaType"|"data"|"sha256"))&&mime&&data&&o.get("sha256").is_some_and(hash)
        },
        _=>false,
    };
    if valid {Ok(())}else{Err(error(ErrorCode::InvalidInput,"NFT media shape or encoding is invalid",path))}
}

fn validate_tbc721_request(request:&CanonicalRequest)->Result<(),EngineError> {
    let intent=&request.intent;let kind=intent.intent_type.as_str();
    let allowed:&[&str]=match kind {
        "tbc721-standard-create-collection"=>&["type","version","name","description","supply","media","to"],
        "tbc721-standard-mint"=>&["type","version","collectionId","slot","name","symbol","description","attributes","media","to"],
        "tbc721-standard-batch-mint"=>&["type","version","collectionId","items"],
        _=>&["type","version","contractId","to","payment"],
    };
    let encoded=serde_json::to_value(intent).map_err(|_|error(ErrorCode::InvalidInput,"NFT intent cannot be encoded","request.intent"))?;
    if encoded.as_object().is_none_or(|o|o.keys().any(|k|!allowed.contains(&k.as_str()))) {
        return Err(error(ErrorCode::InvalidInput,"NFT intent contains fields from another operation","request.intent"));
    }
    let address=|s:&str|Address::from_string(s).map(|_|()).map_err(|_|error(ErrorCode::InvalidInput,"invalid NFT recipient","request.intent.to"));
    if let Some(to)=&intent.to {address(to)?;}
    let metadata=|name:&str,symbol:&str,description:&str,attributes:&[Value],media:Option<&Value>|->Result<(),EngineError>{
        validate_name(name,"request.intent.name")?;validate_description(description,"request.intent.description")?;
        if symbol.is_empty()||symbol.len()>16||!symbol.bytes().all(|b|(0x21..=0x7e).contains(&b))||attributes.len()>64 {
            return Err(error(ErrorCode::InvalidInput,"NFT symbol or attribute count is invalid","request.intent"));
        }
        for attribute in attributes {
            let o=attribute.as_object().ok_or_else(||error(ErrorCode::InvalidInput,"NFT attribute must be an object","request.intent.attributes"))?;
            if o.keys().any(|k|!matches!(k.as_str(),"traitType"|"value"))
                ||o.get("traitType").and_then(Value::as_str).is_none_or(|v|v.is_empty()||v.chars().count()>64)
                ||!o.get("value").is_some_and(|v|v.as_str().is_some_and(|s|s.chars().count()<=256)
                    ||v.is_boolean()||v.as_i64().is_some_and(|n|(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&n))) {
                return Err(error(ErrorCode::InvalidInput,"NFT attribute shape is invalid","request.intent.attributes"));
            }
        }
        if let Some(media)=media {validate_tbc721_media(media)?;} Ok(())
    };
    match kind {
        "tbc721-standard-create-collection"=>{
            validate_name(required(&intent.name,"request.intent.name")?,"request.intent.name")?;
            validate_description(required(&intent.description,"request.intent.description")?,"request.intent.description")?;
            let supply=parse_decimal_u64(required(&intent.supply,"request.intent.supply")?,"request.intent.supply")?;
            if !(1..=2000).contains(&supply) {return Err(error(ErrorCode::InvalidInput,"collection supply must be between 1 and 2000","request.intent.supply"));}
            validate_tbc721_media(intent.media.as_ref().ok_or_else(||error(ErrorCode::InvalidInput,"collection media required","request.intent.media"))?)?;
        }
        "tbc721-standard-mint"=>{
            validate_contract_id(required(&intent.collection_id,"request.intent.collectionId")?,"request.intent.collectionId")?;
            if intent.slot.is_none_or(|s|s==0) {return Err(error(ErrorCode::InvalidInput,"mint slot must be positive","request.intent.slot"));}
            metadata(required(&intent.name,"request.intent.name")?,required(&intent.symbol,"request.intent.symbol")?,required(&intent.description,"request.intent.description")?,
                intent.attributes.as_deref().ok_or_else(||error(ErrorCode::InvalidInput,"NFT attributes required","request.intent.attributes"))?,intent.media.as_ref())?;
        }
        "tbc721-standard-batch-mint"=>{
            validate_contract_id(required(&intent.collection_id,"request.intent.collectionId")?,"request.intent.collectionId")?;
            let items=intent.items.as_deref().filter(|v|!v.is_empty()&&v.len()<=32)
                .ok_or_else(||error(ErrorCode::InvalidInput,"NFT mint batch must contain 1 to 32 items","request.intent.items"))?;
            let mut slots=BTreeSet::new();
            for item in items {
                if item.slot==0||!slots.insert(item.slot) {return Err(error(ErrorCode::InvalidInput,"mint slots must be positive and unique","request.intent.items"));}
                if let Some(to)=&item.to {address(to)?;}
                metadata(&item.name,&item.symbol,&item.description,&item.attributes,item.media.as_ref())?;
            }
        }
        _=>{
            validate_contract_id(required(&intent.contract_id,"request.intent.contractId")?,"request.intent.contractId")?;
            address(required(&intent.to,"request.intent.to")?)?;
            if let Some(payment)=&intent.payment {
                address(&payment.to)?;let value=parse_decimal_u64(&payment.amount,"request.intent.payment.amount")?;
                if !(24..=9_007_199_254_740_991).contains(&value) {return Err(error(ErrorCode::InvalidInput,"NFT attached TBC payment is outside the atomic range","request.intent.payment.amount"));}
            }
        }
    }
    Ok(())
}
