use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::contracts::tbc20::{
    TBC20_AMOUNT_SLOTS, TBC20_CODE_BYTES, TBC20_CODE_SATOSHIS, TBC20_MAX_INPUTS, TBC20_MAX_OUTPUTS,
    TBC20_TAPE_SATOSHIS, is_tbc20_artifact_candidate, parse_tbc20_tape, tbc20_code_identity,
    validate_tbc20_code,
};
use crate::{Error, Result, Transaction, Txid, hash};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenProtocolDescriptor {
    pub family: String,
    pub version: u8,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TokenValidationPolicy {
    pub preset: Option<String>,
    pub require_exact_tape_envelope: Option<bool>,
}

pub trait TokenTransactionFetcher {
    fn fetch_token_transaction(&self, txid: &Txid, network: &str) -> Result<Transaction>;
}

#[derive(Clone, Debug, Default)]
pub struct InMemoryTokenTransactionFetcher {
    transactions: HashMap<Txid, Transaction>,
}

impl InMemoryTokenTransactionFetcher {
    pub fn new(transactions: impl IntoIterator<Item = Transaction>) -> Self {
        Self {
            transactions: transactions
                .into_iter()
                .map(|transaction| (transaction.txid(), transaction))
                .collect(),
        }
    }
}

impl TokenTransactionFetcher for InMemoryTokenTransactionFetcher {
    fn fetch_token_transaction(&self, txid: &Txid, _network: &str) -> Result<Transaction> {
        self.transactions
            .get(txid)
            .cloned()
            .ok_or_else(|| Error::Api(format!("transaction {txid} is unavailable")))
    }
}

pub struct TokenValidationOptions<'a> {
    pub transaction: Option<Transaction>,
    pub raw_hex: Option<String>,
    pub network: String,
    pub policy: TokenValidationPolicy,
    pub fetcher: Option<&'a dyn TokenTransactionFetcher>,
}

impl Default for TokenValidationOptions<'_> {
    fn default() -> Self {
        Self {
            transaction: None,
            raw_hex: None,
            network: "testnet".to_string(),
            policy: TokenValidationPolicy::default(),
            fetcher: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenValidationIssue {
    pub code: String,
    pub severity: String,
    pub stage: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vin: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vout: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub txid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenInputEvidence {
    pub vin: usize,
    pub prev_txid: String,
    pub prev_vout: u32,
    pub kind: String,
    pub resolution: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_txid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_vout: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tape_vout: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slots: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance_raw: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<TokenProtocolDescriptor>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenOutputGroup {
    pub logical_index: usize,
    pub kind: String,
    pub first_vout: usize,
    pub physical_vout_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_vout: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tape_vout: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<TokenProtocolDescriptor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recognized_contract: Option<TokenProtocolDescriptor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slots: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance_raw: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenAssetEvidence {
    pub identity: String,
    pub protocol: TokenProtocolDescriptor,
    pub input_vins: Vec<usize>,
    pub output_groups: Vec<usize>,
    pub input_raw: String,
    pub output_raw: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub envelope_hash: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenAncestorEdge {
    pub current_vin: usize,
    pub parent_txid: String,
    pub parent_code_vout: usize,
    pub parent_slot: usize,
    pub parent_vin: usize,
    #[serde(rename = "abiPrepreIndex")]
    pub abi_prepre_index: usize,
    pub ancestor_txid: String,
    pub ancestor_vout: u32,
    pub parent_identity: String,
    pub ancestor_identity: String,
    pub resolution: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenValidationSource {
    pub network: String,
    pub api: String,
    pub trust_model: String,
    pub root_trust_model: String,
    pub queried_txids: Vec<String>,
    pub resolved_txids: Vec<String>,
    pub required_source_txids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenValidationResult {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub txid: Option<String>,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<TokenProtocolDescriptor>,
    pub assurances: Vec<String>,
    pub issues: Vec<TokenValidationIssue>,
    pub inputs: Vec<TokenInputEvidence>,
    pub output_groups: Vec<TokenOutputGroup>,
    pub assets: Vec<TokenAssetEvidence>,
    pub matrix: Vec<Vec<String>>,
    pub ancestor_edges: Vec<TokenAncestorEdge>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<TokenValidationSource>,
    pub resolved_transactions: usize,
    pub parents_checked: usize,
    pub ancestors_checked: usize,
    #[serde(rename = "originalUTXOBoundaries")]
    pub original_utxo_boundaries: usize,
}

impl TokenValidationResult {
    fn empty() -> Self {
        Self {
            status: String::new(),
            txid: None,
            kind: "UNDETERMINED".to_string(),
            protocol: None,
            assurances: Vec::new(),
            issues: Vec::new(),
            inputs: Vec::new(),
            output_groups: Vec::new(),
            assets: Vec::new(),
            matrix: Vec::new(),
            ancestor_edges: Vec::new(),
            source: None,
            resolved_transactions: 0,
            parents_checked: 0,
            ancestors_checked: 0,
            original_utxo_boundaries: 0,
        }
    }
}

#[derive(Clone)]
struct DecodedCode {
    kind: String,
    identity: String,
    protocol: TokenProtocolDescriptor,
    original_wire: Vec<u8>,
}

#[derive(Clone)]
struct DecodedTape {
    slots: [u64; TBC20_AMOUNT_SLOTS],
    balance: u128,
    envelope: Vec<u8>,
    envelope_hash: String,
}

#[derive(Clone)]
struct DecodedPair {
    code_vout: usize,
    tape_vout: usize,
    code: DecodedCode,
    tape: DecodedTape,
}

/// Pure inspection of a published fungible Code/Tape pair. No transaction
/// fetches or ancestry validation are performed. `None` means unrecognized,
/// never "ordinary/safe"; callers must classify other contract families.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublishedTokenPair {
    pub protocol: TokenProtocolDescriptor,
    pub identity: String,
    pub balance: u128,
    pub envelope_hash: String,
}

pub fn inspect_published_token_pair(
    code: &crate::TxOut,
    tape: Option<&crate::TxOut>,
) -> Result<Option<PublishedTokenPair>> {
    decode_pair_outputs(code, tape, 0, true).map(|pair| {
        pair.map(|pair| PublishedTokenPair {
            protocol: pair.code.protocol,
            identity: pair.code.identity,
            balance: pair.tape.balance,
            envelope_hash: pair.tape.envelope_hash,
        })
    })
}

/// Explicit released MultiSig profile: ordinary incoming FT Code may carry
/// 500 satoshis, while MultiSig deposits/changes carry 2000. This does not
/// relax the default 500/0 validator or accept arbitrary contract templates.
pub fn inspect_multisig_token_pair(
    code: &crate::TxOut,
    tape: Option<&crate::TxOut>,
) -> Result<Option<PublishedTokenPair>> {
    if !matches!(code.satoshis, 500 | 2000) {
        return Err(Error::InvalidScript("MultiSig FT Code value must be 500 or 2000".into()));
    }
    decode_pair_outputs_with_value(code, tape, 0, true, code.satoshis).and_then(|pair| {
        match pair {
            Some(pair) if matches!(pair.code.protocol.family.as_str(), "FT" | "STABLE_COIN") =>
                Ok(Some(PublishedTokenPair { protocol: pair.code.protocol, identity: pair.code.identity,
                    balance: pair.tape.balance, envelope_hash: pair.tape.envelope_hash })),
            Some(_) => Err(Error::InvalidScript("Token family is outside released MultiSig".into())),
            None => Ok(None),
        }
    })
}

struct ResolvedInput {
    vin: usize,
    pair: DecodedPair,
    parent: Transaction,
}

struct ValidationContext<'a> {
    result: TokenValidationResult,
    invalid: Vec<TokenValidationIssue>,
    unknown: Vec<TokenValidationIssue>,
    warnings: Vec<TokenValidationIssue>,
    fetcher: Option<&'a dyn TokenTransactionFetcher>,
    network: String,
    exact_tape: bool,
    cache: HashMap<Txid, Transaction>,
    failed: HashSet<Txid>,
    required: HashSet<Txid>,
    lineage_want: usize,
    lineage_got: usize,
}

/// Validates a token transition and, when no custom fetcher is supplied,
/// resolves its parent/ancestor graph through the selected network API.
#[cfg(feature = "network-api")]
pub async fn validate_on_chain_transaction(
    options: TokenValidationOptions<'_>,
) -> TokenValidationResult {
    if options.fetcher.is_some() {
        return validate_on_chain_transaction_with_fetcher(options);
    }

    let transactions = preload_on_chain_transactions(&options).await;
    let fetcher = InMemoryTokenTransactionFetcher::new(transactions);
    validate_on_chain_transaction_with_fetcher(TokenValidationOptions {
        transaction: options.transaction,
        raw_hex: options.raw_hex,
        network: options.network,
        policy: options.policy,
        fetcher: Some(&fetcher),
    })
}

/// Synchronous validation entry point for callers that provide their own
/// transaction source (for example an indexed database or an offline cache).
pub fn validate_on_chain_transaction_with_fetcher(
    options: TokenValidationOptions<'_>,
) -> TokenValidationResult {
    let (root, network, exact_tape, fetcher, invalid) = normalize_options(options);
    if let Some(invalid) = invalid {
        return invalid;
    }
    let mut ctx = ValidationContext {
        result: TokenValidationResult::empty(),
        invalid: Vec::new(),
        unknown: Vec::new(),
        warnings: Vec::new(),
        fetcher,
        network: network.clone(),
        exact_tape,
        cache: HashMap::new(),
        failed: HashSet::new(),
        required: HashSet::new(),
        lineage_want: 0,
        lineage_got: 0,
    };
    ctx.result.source = Some(TokenValidationSource {
        network,
        api: "API.fetchTXraw".to_string(),
        trust_model: "API_FETCH_TXRAW_FULLY_TRUSTED".to_string(),
        root_trust_model: "CALLER_ASSERTED_ON_CHAIN_AND_INPUT_SCRIPTS_VALID".to_string(),
        queried_txids: Vec::new(),
        resolved_txids: Vec::new(),
        required_source_txids: Vec::new(),
    });
    let Some(root) = root else {
        add_unknown(
            &mut ctx,
            "ROOT_RAW_INVALID",
            "ROOT",
            None,
            None,
            None,
            None,
            None,
        );
        return finalize(ctx);
    };
    ctx.result.txid = Some(root.txid().to_string());
    ctx.result.inputs = root
        .inputs
        .iter()
        .enumerate()
        .map(|(vin, input)| TokenInputEvidence {
            vin,
            prev_txid: input.previous_output.txid.to_string(),
            prev_vout: input.previous_output.vout,
            kind: "UNRESOLVED".to_string(),
            resolution: "NOT_REQUESTED".to_string(),
            source_role: None,
            parent_txid: None,
            code_vout: None,
            tape_vout: None,
            identity: None,
            slots: None,
            balance_raw: None,
            protocol: None,
        })
        .collect();
    if root.version != 10 {
        add_invalid_message(
            &mut ctx,
            "INVALID_TRANSACTION_VERSION",
            "ROOT",
            "root transaction version must be 10",
        );
    }
    if root.inputs.is_empty() || root.inputs.len() > TBC20_MAX_INPUTS {
        add_invalid_message(
            &mut ctx,
            "INPUT_LIMIT_EXCEEDED",
            "ROOT",
            format!("root transaction must contain 1-{TBC20_MAX_INPUTS} inputs"),
        );
    }
    let mut seen = HashSet::new();
    for (vin, input) in root.inputs.iter().enumerate() {
        if !seen.insert((input.previous_output.txid, input.previous_output.vout)) {
            add_invalid(
                &mut ctx,
                "DUPLICATE_INPUT_OUTPOINT",
                "ROOT",
                Some(vin),
                Some(input.previous_output.vout as usize),
                None,
                Some(input.previous_output.txid.to_string()),
                None,
            );
        }
    }
    if !ctx.invalid.is_empty() {
        return finalize(ctx);
    }
    let pairs = scan_outputs(&root, &mut ctx);
    if !ctx.invalid.is_empty() {
        return finalize(ctx);
    }
    ctx.result.assurances.push("STRUCTURE".to_string());
    if pairs.is_empty() {
        ctx.result.kind = "NON_TOKEN".to_string();
        ctx.result
            .assurances
            .push("OUTPUT_SOURCE_GRAPH_RESOLVED".to_string());
        add_invalid(
            &mut ctx,
            "NO_TOKEN_OUTPUT",
            "OUTPUT_SCAN",
            None,
            None,
            None,
            None,
            None,
        );
        return finalize(ctx);
    }
    ctx.result.kind = "TRANSITION".to_string();

    let mut positive_vins = BTreeSet::new();
    let mut envelopes = HashMap::<String, Vec<u8>>::new();
    for (logical, pair) in &pairs {
        let mut row = Vec::with_capacity(TBC20_AMOUNT_SLOTS);
        for (vin, amount) in pair.tape.slots.iter().enumerate() {
            row.push(amount.to_string());
            if *amount > 0 {
                positive_vins.insert(vin);
                if vin >= root.inputs.len() {
                    add_invalid(
                        &mut ctx,
                        "AMOUNT_SLOT_WITHOUT_INPUT",
                        "MATRIX",
                        Some(vin),
                        None,
                        None,
                        None,
                        None,
                    );
                }
            }
        }
        debug_assert_eq!(*logical, ctx.result.matrix.len());
        ctx.result.matrix.push(row);
        if let Some(existing) = envelopes.get(&pair.code.identity) {
            if existing != &pair.tape.envelope {
                if ctx.exact_tape {
                    add_invalid(
                        &mut ctx,
                        "TAPE_ENVELOPE_MISMATCH",
                        "MATRIX",
                        None,
                        None,
                        None,
                        None,
                        Some(pair.code.identity.clone()),
                    );
                } else {
                    add_warning_identity(&mut ctx, &pair.code.identity);
                }
            }
        } else {
            envelopes.insert(pair.code.identity.clone(), pair.tape.envelope.clone());
        }
    }
    if !ctx.invalid.is_empty() {
        return finalize(ctx);
    }

    let mut sources = Vec::new();
    let mut complete = true;
    for vin in positive_vins.iter().copied() {
        let Some(source) = resolve_source(&root, vin, &mut ctx) else {
            complete = false;
            continue;
        };
        if ctx.result.protocol.as_ref() != Some(&source.pair.code.protocol) {
            add_invalid(
                &mut ctx,
                "MIXED_TOKEN_PROTOCOLS",
                "PARENT",
                Some(vin),
                None,
                None,
                Some(source.parent.txid().to_string()),
                None,
            );
            continue;
        }
        let mut column = 0u128;
        let mut identities = BTreeSet::new();
        for pair in pairs.values() {
            if pair.tape.slots[vin] > 0 {
                column += u128::from(pair.tape.slots[vin]);
                identities.insert(pair.code.identity.clone());
            }
        }
        if identities.len() != 1 || !identities.contains(&source.pair.code.identity) {
            add_invalid(
                &mut ctx,
                "OUTPUT_INPUT_IDENTITY_MISMATCH",
                "MATRIX",
                Some(vin),
                None,
                None,
                None,
                Some(source.pair.code.identity.clone()),
            );
        }
        if column != source.pair.tape.balance {
            let message = format!(
                "vin {vin} contributes {column} raw but parent balance is {}",
                source.pair.tape.balance
            );
            add_invalid_full(
                &mut ctx,
                issue(
                    "VIN_AMOUNT_NOT_CONSERVED",
                    "MATRIX",
                    message,
                    Some(vin),
                    None,
                    None,
                    None,
                    Some(source.pair.code.identity.clone()),
                ),
            );
        }
        if envelopes.get(&source.pair.code.identity) != Some(&source.pair.tape.envelope) {
            if ctx.exact_tape {
                add_invalid(
                    &mut ctx,
                    "TAPE_ENVELOPE_MISMATCH",
                    "MATRIX",
                    Some(vin),
                    None,
                    None,
                    None,
                    Some(source.pair.code.identity.clone()),
                );
            } else {
                add_warning_identity(&mut ctx, &source.pair.code.identity);
            }
        }
        sources.push(source);
    }
    if !ctx.invalid.is_empty() {
        return finalize(ctx);
    }

    let positive_output_identities = pairs
        .values()
        .filter(|pair| pair.tape.balance > 0)
        .map(|pair| pair.code.identity.clone())
        .collect::<HashSet<_>>();
    let mut zero_targets = pairs
        .values()
        .filter(|pair| {
            pair.tape.balance == 0 && !positive_output_identities.contains(&pair.code.identity)
        })
        .map(|pair| pair.code.identity.clone())
        .collect::<HashSet<_>>();
    let mut failed_zero_candidates = 0usize;
    for vin in 0..root.inputs.len() {
        if zero_targets.is_empty() {
            break;
        }
        if positive_vins.contains(&vin) {
            continue;
        }
        let prev_txid = root.inputs[vin].previous_output.txid;
        let prev_vout = root.inputs[vin].previous_output.vout as usize;
        let Some(parent) = fetch(&mut ctx, prev_txid) else {
            failed_zero_candidates += 1;
            continue;
        };
        if prev_vout >= parent.outputs.len() {
            ctx.result.inputs[vin].resolution = "INVALID".to_string();
            add_invalid(
                &mut ctx,
                "PARENT_VOUT_OUT_OF_RANGE",
                "PARENT",
                Some(vin),
                Some(prev_vout),
                None,
                Some(prev_txid.to_string()),
                None,
            );
            continue;
        }
        ctx.result.parents_checked += 1;
        let pair = match decode_pair(&parent, prev_vout) {
            Ok(Some(pair)) => pair,
            Ok(None) => {
                let evidence = &mut ctx.result.inputs[vin];
                evidence.kind = "ORDINARY".to_string();
                evidence.resolution = "RESOLVED".to_string();
                evidence.parent_txid = Some(prev_txid.to_string());
                continue;
            }
            Err(_) => {
                ctx.result.inputs[vin].resolution = "INVALID".to_string();
                continue;
            }
        };
        {
            let evidence = &mut ctx.result.inputs[vin];
            evidence.kind = pair.code.kind.clone();
            evidence.resolution = "RESOLVED".to_string();
            evidence.parent_txid = Some(prev_txid.to_string());
        }
        if ctx.result.protocol.as_ref() != Some(&pair.code.protocol)
            || !zero_targets.contains(&pair.code.identity)
        {
            continue;
        }
        if pair.tape.balance > 0 {
            add_invalid(
                &mut ctx,
                "VIN_AMOUNT_NOT_CONSERVED",
                "MATRIX",
                Some(vin),
                None,
                None,
                None,
                Some(pair.code.identity.clone()),
            );
            continue;
        }
        if envelopes.get(&pair.code.identity) != Some(&pair.tape.envelope) {
            if ctx.exact_tape {
                continue;
            }
            add_warning_identity(&mut ctx, &pair.code.identity);
        }
        {
            let evidence = &mut ctx.result.inputs[vin];
            evidence.source_role = Some("ZERO_IDENTITY_WITNESS".to_string());
            evidence.code_vout = Some(pair.code_vout);
            evidence.tape_vout = Some(pair.tape_vout);
            evidence.identity = Some(pair.code.identity.clone());
            evidence.slots = Some(pair.tape.slots.iter().map(u64::to_string).collect());
            evidence.balance_raw = Some(pair.tape.balance.to_string());
            evidence.protocol = Some(pair.code.protocol.clone());
        }
        require_txid(&mut ctx, prev_txid);
        zero_targets.remove(&pair.code.identity);
        sources.push(ResolvedInput { vin, pair, parent });
    }
    if !zero_targets.is_empty() {
        complete = false;
        if failed_zero_candidates >= zero_targets.len() {
            add_unknown(
                &mut ctx,
                "ZERO_IDENTITY_WITNESS_UNRESOLVED",
                "MATRIX",
                None,
                None,
                None,
                None,
                None,
            );
        } else {
            for identity in zero_targets {
                add_invalid(
                    &mut ctx,
                    "OUTPUT_IDENTITY_WITHOUT_INPUT",
                    "MATRIX",
                    None,
                    None,
                    None,
                    None,
                    Some(identity),
                );
            }
        }
    }
    if !ctx.invalid.is_empty() {
        return finalize(ctx);
    }

    if complete {
        let mut assets = BTreeMap::<String, TokenAssetEvidence>::new();
        for source in &sources {
            let asset = assets
                .entry(source.pair.code.identity.clone())
                .or_insert_with(|| TokenAssetEvidence {
                    identity: source.pair.code.identity.clone(),
                    protocol: source.pair.code.protocol.clone(),
                    input_vins: Vec::new(),
                    output_groups: Vec::new(),
                    input_raw: "0".to_string(),
                    output_raw: "0".to_string(),
                    envelope_hash: None,
                });
            asset.input_vins.push(source.vin);
            asset.input_raw =
                (asset.input_raw.parse::<u128>().unwrap() + source.pair.tape.balance).to_string();
        }
        for (logical, pair) in &pairs {
            let Some(asset) = assets.get_mut(&pair.code.identity) else {
                add_invalid(
                    &mut ctx,
                    "OUTPUT_IDENTITY_WITHOUT_INPUT",
                    "MATRIX",
                    None,
                    None,
                    None,
                    None,
                    Some(pair.code.identity.clone()),
                );
                continue;
            };
            asset.output_groups.push(*logical);
            asset.output_raw =
                (asset.output_raw.parse::<u128>().unwrap() + pair.tape.balance).to_string();
            asset.envelope_hash = Some(pair.tape.envelope_hash.clone());
        }
        for asset in assets.values() {
            if asset.input_raw != asset.output_raw {
                add_invalid(
                    &mut ctx,
                    "IDENTITY_AMOUNT_NOT_CONSERVED",
                    "MATRIX",
                    None,
                    None,
                    None,
                    None,
                    Some(asset.identity.clone()),
                );
            }
        }
        ctx.result.assets = assets.into_values().collect();
        if ctx.invalid.is_empty() {
            ctx.result.assurances.push("TRANSITION".to_string());
        }
    }

    for source in &sources {
        for (slot, amount) in source.pair.tape.slots.iter().enumerate() {
            if *amount == 0 {
                continue;
            }
            ctx.lineage_want += 1;
            let Some(parent_input) = source.parent.inputs.get(slot) else {
                add_invalid(
                    &mut ctx,
                    "PARENT_SLOT_WITHOUT_VIN",
                    "PARENT",
                    Some(source.vin),
                    None,
                    Some(slot),
                    Some(source.parent.txid().to_string()),
                    None,
                );
                continue;
            };
            let ancestor_txid = parent_input.previous_output.txid;
            require_txid(&mut ctx, ancestor_txid);
            let Some(ancestor) = fetch(&mut ctx, ancestor_txid) else {
                add_unknown(
                    &mut ctx,
                    "ANCESTOR_FETCH_FAILED",
                    "ANCESTOR",
                    Some(source.vin),
                    None,
                    Some(slot),
                    Some(ancestor_txid.to_string()),
                    None,
                );
                continue;
            };
            let ancestor_vout = parent_input.previous_output.vout as usize;
            let Some(ancestor_output) = ancestor.outputs.get(ancestor_vout) else {
                add_invalid(
                    &mut ctx,
                    "ANCESTOR_VOUT_OUT_OF_RANGE",
                    "ANCESTOR",
                    Some(source.vin),
                    Some(ancestor_vout),
                    Some(slot),
                    Some(ancestor_txid.to_string()),
                    None,
                );
                continue;
            };
            ctx.result.ancestors_checked += 1;
            let Ok(identity) = tbc20_code_identity(&ancestor_output.script_pubkey) else {
                add_invalid(
                    &mut ctx,
                    "ANCESTOR_EMPTY_LOCKING_SCRIPT",
                    "ANCESTOR",
                    Some(source.vin),
                    None,
                    Some(slot),
                    Some(ancestor_txid.to_string()),
                    None,
                );
                continue;
            };
            let ancestor_identity = hex::encode(identity);
            let mut edge = TokenAncestorEdge {
                current_vin: source.vin,
                parent_txid: source.parent.txid().to_string(),
                parent_code_vout: source.pair.code_vout,
                parent_slot: slot,
                parent_vin: slot,
                abi_prepre_index: 5 - slot,
                ancestor_txid: ancestor_txid.to_string(),
                ancestor_vout: parent_input.previous_output.vout,
                parent_identity: source.pair.code.identity.clone(),
                ancestor_identity,
                resolution: String::new(),
            };
            if edge.ancestor_identity == edge.parent_identity {
                edge.resolution = "SAME_IDENTITY".to_string();
                ctx.lineage_got += 1;
                ctx.result.ancestor_edges.push(edge);
            } else if slot == 0
                && outpoint_wire(ancestor_txid, parent_input.previous_output.vout)
                    == source.pair.code.original_wire
            {
                edge.resolution = "ORIGINAL_UTXO".to_string();
                ctx.lineage_got += 1;
                ctx.result.original_utxo_boundaries += 1;
                ctx.result.ancestor_edges.push(edge);
            } else {
                add_invalid(
                    &mut ctx,
                    if slot == 0 {
                        "ORIGINAL_UTXO_MISMATCH"
                    } else {
                        "ANCESTOR_IDENTITY_MISMATCH"
                    },
                    "ANCESTOR",
                    Some(source.vin),
                    Some(ancestor_vout),
                    Some(slot),
                    Some(ancestor_txid.to_string()),
                    None,
                );
            }
        }
    }
    if ctx.invalid.is_empty() && complete && ctx.lineage_want == ctx.lineage_got {
        ctx.result
            .assurances
            .push("OUTPUT_SOURCE_LINEAGE".to_string());
        if ctx.unknown.is_empty() {
            ctx.result
                .assurances
                .push("OUTPUT_SOURCE_GRAPH_RESOLVED".to_string());
        }
    }
    finalize(ctx)
}

#[cfg(feature = "network-api")]
pub async fn assert_valid_on_chain_transaction(
    options: TokenValidationOptions<'_>,
) -> Result<TokenValidationResult> {
    let report = validate_on_chain_transaction(options).await;
    if report.status == "VALID" && report.kind == "TRANSITION" {
        Ok(report)
    } else {
        Err(Error::InvalidTransactionHex)
    }
}

#[cfg(feature = "network-api")]
async fn preload_on_chain_transactions(options: &TokenValidationOptions<'_>) -> Vec<Transaction> {
    let root = options.transaction.clone().or_else(|| {
        let raw = options.raw_hex.as_ref()?;
        Transaction::from_hex(raw)
            .ok()
            .filter(|transaction| transaction.to_hex().eq_ignore_ascii_case(raw))
    });
    let Some(root) = root else {
        return Vec::new();
    };
    let network = options.network.trim();
    if network.is_empty() {
        return Vec::new();
    }
    let base_url = match network {
        "testnet" => "https://api.tbcdev.org/api/tbc/".to_string(),
        "mainnet" => "https://api.turingbitchain.io/api/tbc/".to_string(),
        custom if custom.ends_with('/') => custom.to_string(),
        custom => format!("{custom}/"),
    };
    let api = crate::ApiClient::with_base_url(base_url);
    let mut loaded = HashMap::<Txid, Transaction>::new();
    let parent_ids = root
        .inputs
        .iter()
        .map(|input| input.previous_output.txid)
        .collect::<HashSet<_>>();
    for txid in parent_ids {
        if let Ok(transaction) = api.fetch_raw_transaction(&txid.to_string()).await
            && transaction.txid() == txid
        {
            loaded.insert(txid, transaction);
        }
    }

    let mut ancestor_ids = HashSet::new();
    for input in &root.inputs {
        let Some(parent) = loaded.get(&input.previous_output.txid) else {
            continue;
        };
        let Ok(Some(pair)) = decode_pair(parent, input.previous_output.vout as usize) else {
            continue;
        };
        for (slot, amount) in pair.tape.slots.iter().enumerate() {
            if *amount > 0
                && let Some(parent_input) = parent.inputs.get(slot)
            {
                ancestor_ids.insert(parent_input.previous_output.txid);
            }
        }
    }
    for txid in ancestor_ids {
        if loaded.contains_key(&txid) {
            continue;
        }
        if let Ok(transaction) = api.fetch_raw_transaction(&txid.to_string()).await
            && transaction.txid() == txid
        {
            loaded.insert(txid, transaction);
        }
    }
    loaded.into_values().collect()
}

fn normalize_options(
    options: TokenValidationOptions<'_>,
) -> (
    Option<Transaction>,
    String,
    bool,
    Option<&dyn TokenTransactionFetcher>,
    Option<TokenValidationResult>,
) {
    if options.transaction.is_none() && options.raw_hex.is_none() {
        return (
            None,
            String::new(),
            false,
            None,
            Some(invalid_policy(
                "transaction must be a Transaction, Buffer, or hex string",
            )),
        );
    }
    if options.network.trim().is_empty() {
        return (
            None,
            String::new(),
            false,
            None,
            Some(invalid_policy("network must be a non-empty string")),
        );
    }
    let preset = options.policy.preset.as_deref().unwrap_or("strict");
    if !matches!(preset, "strict" | "relaxed-metadata") {
        return (
            None,
            String::new(),
            false,
            None,
            Some(invalid_policy("policy.preset is unsupported")),
        );
    }
    let exact = options
        .policy
        .require_exact_tape_envelope
        .unwrap_or(preset == "strict");
    if preset == "strict" && !exact {
        return (
            None,
            String::new(),
            false,
            None,
            Some(invalid_policy(
                "strict policy cannot disable exact Tape envelopes",
            )),
        );
    }
    let root = options.transaction.or_else(|| {
        let raw = options.raw_hex?;
        if raw.is_empty() || raw.len() % 2 != 0 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return None;
        }
        Transaction::from_hex(&raw)
            .ok()
            .filter(|transaction| transaction.to_hex().eq_ignore_ascii_case(&raw))
    });
    (
        root,
        options.network.trim().to_string(),
        exact,
        options.fetcher,
        None,
    )
}

fn invalid_policy(message: &str) -> TokenValidationResult {
    let mut result = TokenValidationResult::empty();
    result.status = "INVALID".to_string();
    result.issues.push(issue(
        "INVALID_POLICY",
        "ROOT",
        message,
        None,
        None,
        None,
        None,
        None,
    ));
    result
}

fn scan_outputs(
    transaction: &Transaction,
    ctx: &mut ValidationContext<'_>,
) -> BTreeMap<usize, DecodedPair> {
    let mut pairs = BTreeMap::new();
    if transaction.outputs.len() > TBC20_MAX_OUTPUTS {
        add_invalid_message(
            ctx,
            "OUTPUT_LIMIT_EXCEEDED",
            "ROOT",
            format!(
                "transaction has {} physical outputs; maximum is {TBC20_MAX_OUTPUTS}",
                transaction.outputs.len()
            ),
        );
        return pairs;
    }
    let mut logical = 0usize;
    let mut vout = 0usize;
    let mut protocol_keys = HashSet::new();
    while vout < transaction.outputs.len() {
        if transaction.outputs[vout]
            .script_pubkey
            .as_bytes()
            .is_empty()
        {
            add_invalid(
                ctx,
                "EMPTY_LOCKING_SCRIPT",
                "OUTPUT_SCAN",
                None,
                Some(vout),
                None,
                None,
                None,
            );
            return pairs;
        }
        match decode_pair(transaction, vout) {
            Ok(Some(pair)) => {
                protocol_keys.insert(format!(
                    "{}:v{}",
                    pair.code.protocol.family, pair.code.protocol.version
                ));
                ctx.result.protocol = Some(pair.code.protocol.clone());
                ctx.result.output_groups.push(TokenOutputGroup {
                    logical_index: logical,
                    kind: pair.code.kind.clone(),
                    first_vout: vout,
                    physical_vout_count: 2,
                    code_vout: Some(vout),
                    tape_vout: Some(vout + 1),
                    identity: Some(pair.code.identity.clone()),
                    protocol: Some(pair.code.protocol.clone()),
                    recognized_contract: None,
                    slots: Some(pair.tape.slots.iter().map(u64::to_string).collect()),
                    balance_raw: Some(pair.tape.balance.to_string()),
                });
                pairs.insert(logical, pair);
                logical += 1;
                vout += 2;
            }
            Ok(None) => {
                if let Some(protocol) =
                    recognized_contract(&transaction.outputs[vout].script_pubkey)
                {
                    protocol_keys.insert(format!("{}:v{}", protocol.family, protocol.version));
                    ctx.result.output_groups.push(TokenOutputGroup {
                        logical_index: logical,
                        kind: "CONTRACT".to_string(),
                        first_vout: vout,
                        physical_vout_count: 1,
                        code_vout: None,
                        tape_vout: None,
                        identity: None,
                        protocol: None,
                        recognized_contract: Some(protocol),
                        slots: None,
                        balance_raw: None,
                    });
                    logical += 1;
                    vout += 1;
                    continue;
                }
                ctx.result.output_groups.push(TokenOutputGroup {
                    logical_index: logical,
                    kind: "ORDINARY".to_string(),
                    first_vout: vout,
                    physical_vout_count: 1,
                    code_vout: None,
                    tape_vout: None,
                    identity: None,
                    protocol: None,
                    recognized_contract: None,
                    slots: None,
                    balance_raw: None,
                });
                logical += 1;
                vout += 1;
            }
            Err(error) => {
                add_invalid_full(
                    ctx,
                    issue(
                        if error.to_string().contains("TBC20") {
                            "INVALID_TBC20_CODE"
                        } else {
                            "INVALID_TOKEN_TAPE"
                        },
                        "OUTPUT_SCAN",
                        error.to_string(),
                        None,
                        Some(vout),
                        None,
                        None,
                        None,
                    ),
                );
                return pairs;
            }
        }
    }
    if protocol_keys.len() > 1 {
        add_invalid(
            ctx,
            "MIXED_TOKEN_PROTOCOLS",
            "OUTPUT_SCAN",
            None,
            None,
            None,
            None,
            None,
        );
    }
    pairs
}

#[derive(Clone)]
struct FtArtifact {
    version: u8,
    coin: bool,
    code_bytes: usize,
    partial_offset: usize,
    normalized_sha256: &'static str,
    identity_ranges: Vec<(usize, usize)>,
    original_range: Option<(usize, usize)>,
    tape_size_offsets: Vec<usize>,
    tape_size: usize,
}

fn ft_artifacts() -> Vec<FtArtifact> {
    vec![
        ordinary_artifact(
            1,
            1564,
            1536,
            "bfd8126a4cc55725a62b3ae0a7235f6cabe1b15c70f27fe3e7d7fada9bc37c73",
            (303, 339),
            &[
                566, 636, 678, 750, 794, 866, 910, 982, 1026, 1098, 1142, 1214, 1258, 1330, 1374,
                1446,
            ],
        ),
        ordinary_artifact(
            1,
            1564,
            1536,
            "aa4471260dc8dbc3e9ba5a7e98653b87e617634b5c37c6025374b73e55310735",
            (313, 349),
            &[
                576, 646, 688, 760, 804, 876, 920, 992, 1036, 1108, 1152, 1224, 1268, 1340, 1384,
                1456,
            ],
        ),
        ordinary_artifact(
            2,
            1884,
            1856,
            "f4b034ef624fc3de2dd461996712d4389c31e39fc4f74524e663465f1c7bd4cf",
            (619, 655),
            &[
                882, 952, 994, 1066, 1110, 1182, 1226, 1298, 1342, 1414, 1458, 1530, 1574, 1646,
                1690, 1762,
            ],
        ),
        ordinary_artifact(
            3,
            1884,
            1856,
            "fdfa23a85f44ca26cff96e5053fa33e5b47af7dd3bc31ffbc577ab191952fb82",
            (647, 683),
            &[
                919, 989, 1031, 1103, 1147, 1219, 1263, 1335, 1379, 1451, 1495, 1567, 1611, 1683,
                1727, 1799,
            ],
        ),
        ordinary_artifact(
            4,
            2012,
            1984,
            "2c80025bcbe3e42a3fe171547d0f1a576d7bc53a1d8c8fb2ff5c996e56af9172",
            (672, 708),
            &[
                1019, 1089, 1131, 1203, 1247, 1319, 1363, 1435, 1479, 1551, 1595, 1667, 1711, 1783,
                1827, 1899,
            ],
        ),
        coin_artifact(
            2,
            2012,
            1984,
            "e08e43f220636197380d8763df8c31c8b4bc76c326f66b9385d4e973d16200b8",
            &[(258, 278), (705, 737)],
            &[
                1041, 1111, 1153, 1225, 1269, 1341, 1385, 1457, 1501, 1573, 1617, 1689, 1733, 1805,
                1849, 1921,
            ],
        ),
        coin_artifact(
            2,
            2012,
            1984,
            "77b60cc9e884901425987112ff3a9547a0dfd155db641aea0f752ad29b6a30a9",
            &[(256, 276), (669, 701)],
            &[
                998, 1068, 1110, 1182, 1226, 1298, 1342, 1414, 1458, 1530, 1574, 1646, 1690, 1762,
                1806, 1878,
            ],
        ),
        coin_artifact(
            3,
            2012,
            1984,
            "0f226cbd6cf89f89d2c22eca43f8295e4bcafb750e11141bc1cee5aebbb42b3b",
            &[(278, 298), (697, 729)],
            &[
                1050, 1120, 1162, 1234, 1278, 1350, 1394, 1466, 1510, 1582, 1626, 1698, 1742, 1814,
                1858, 1930,
            ],
        ),
        ordinary_artifact(
            4,
            2076,
            2048,
            "d0a57bdf42b2f919c14febc71aac79ded1f25099cdee8373242261e83150fa74",
            (696, 732),
            &[
                1043, 1117, 1159, 1235, 1279, 1355, 1399, 1475, 1519, 1595, 1639, 1715, 1759, 1835,
                1879, 1955,
            ],
        ),
        coin_artifact(
            4,
            2076,
            2048,
            "7d283417e489492719705e2b495775e53f6667751736abe90e2a5d5af14db5d9",
            &[(302, 322), (721, 753)],
            &[
                1074, 1148, 1190, 1266, 1310, 1386, 1430, 1506, 1550, 1626, 1670, 1746, 1790, 1866,
                1910, 1986,
            ],
        ),
    ]
}

fn ordinary_artifact(
    version: u8,
    code_bytes: usize,
    partial_offset: usize,
    hash: &'static str,
    original: (usize, usize),
    tape_offsets: &[usize],
) -> FtArtifact {
    FtArtifact {
        version,
        coin: false,
        code_bytes,
        partial_offset,
        normalized_sha256: hash,
        identity_ranges: vec![original],
        original_range: Some(original),
        tape_size_offsets: tape_offsets.to_vec(),
        tape_size: 0,
    }
}

fn coin_artifact(
    version: u8,
    code_bytes: usize,
    partial_offset: usize,
    hash: &'static str,
    identity_ranges: &[(usize, usize)],
    tape_offsets: &[usize],
) -> FtArtifact {
    FtArtifact {
        version,
        coin: true,
        code_bytes,
        partial_offset,
        normalized_sha256: hash,
        identity_ranges: identity_ranges.to_vec(),
        original_range: None,
        tape_size_offsets: tape_offsets.to_vec(),
        tape_size: 0,
    }
}

fn decode_published_ft_code(code: &[u8]) -> Option<FtArtifact> {
    let mut matched = None;
    for mut artifact in ft_artifacts() {
        if code.len() != artifact.code_bytes
            || artifact.partial_offset + 28 != code.len()
            || code[artifact.partial_offset] != 0x15
            || !matches!(code[artifact.partial_offset + 21], 0 | 1)
            || &code[artifact.partial_offset + 22..] != b"\x052Code"
        {
            continue;
        }
        let tape_size = usize::from(code[*artifact.tape_size_offsets.first()?]);
        if !artifact
            .tape_size_offsets
            .iter()
            .all(|offset| code.get(*offset) == Some(&(tape_size as u8)))
        {
            continue;
        }
        let mut normalized = code.to_vec();
        let mut ranges = artifact.identity_ranges.clone();
        ranges.extend(
            artifact
                .tape_size_offsets
                .iter()
                .map(|offset| (*offset, *offset + 1)),
        );
        ranges.push((artifact.partial_offset + 1, artifact.partial_offset + 22));
        if ranges
            .iter()
            .any(|(start, end)| end < start || *end > normalized.len())
        {
            continue;
        }
        for (start, end) in ranges {
            normalized[start..end].fill(0);
        }
        if hex::encode(hash::sha256(&normalized)) != artifact.normalized_sha256 {
            continue;
        }
        artifact.tape_size = tape_size;
        if matched.is_some() {
            return None;
        }
        matched = Some(artifact);
    }
    matched
}

fn decoded_ft_code(script: &crate::script::Script, artifact: &FtArtifact) -> Result<DecodedCode> {
    let bytes = script.as_bytes();
    Ok(DecodedCode {
        kind: "FT".to_string(),
        identity: hex::encode(tbc20_code_identity(script)?),
        protocol: TokenProtocolDescriptor {
            family: "FT".to_string(),
            version: artifact.version,
        },
        original_wire: artifact
            .original_range
            .map(|(start, end)| bytes[start..end].to_vec())
            .unwrap_or_default(),
    })
}

fn recognized_contract(script: &crate::script::Script) -> Option<TokenProtocolDescriptor> {
    let artifact = decode_published_ft_code(script.as_bytes())?;
    artifact.coin.then_some(TokenProtocolDescriptor {
        family: "STABLE_COIN".to_string(),
        version: artifact.version,
    })
}

fn parse_published_ft_tape(tape: &[u8]) -> Result<([u64; 6], u128)> {
    if tape.len() < 59
        || !tape.starts_with(&[0, 0x6a, 0x30])
        || !tape.ends_with(b"\x05FTape")
        || !canonical_ft_pushes(&tape[51..])
    {
        return Err(Error::InvalidScript(
            "Tape is not a canonical published FT envelope".to_string(),
        ));
    }
    let mut amounts = [0u64; 6];
    let mut balance = 0u128;
    for (index, amount) in amounts.iter_mut().enumerate() {
        let start = 3 + index * 8;
        *amount = u64::from_le_bytes(tape[start..start + 8].try_into().unwrap());
        if *amount > crate::contracts::tbc20::TBC20_MAX_SLOT_AMOUNT {
            return Err(Error::InvalidScript(
                "Tape amount exceeds signed-63 range".to_string(),
            ));
        }
        balance += u128::from(*amount);
    }
    Ok((amounts, balance))
}

fn canonical_ft_pushes(bytes: &[u8]) -> bool {
    let mut offset = 0usize;
    let mut pushes = 0usize;
    let mut first_length = None;
    let mut last = None;
    while offset < bytes.len() {
        let start = offset;
        let opcode = bytes[offset];
        offset += 1;
        let length = match opcode {
            1..=0x4b => usize::from(opcode),
            0x4c => {
                let Some(length) = bytes.get(offset).copied() else {
                    return false;
                };
                offset += 1;
                if length < 0x4c {
                    return false;
                }
                usize::from(length)
            }
            0x4d => {
                let Some(raw) = bytes.get(offset..offset + 2) else {
                    return false;
                };
                offset += 2;
                let length = usize::from(u16::from_le_bytes(raw.try_into().unwrap()));
                if length <= 0xff {
                    return false;
                }
                length
            }
            _ => return false,
        };
        if pushes == 0 {
            first_length = Some(length);
        }
        last = Some((start, length));
        let Some(end) = offset.checked_add(length) else {
            return false;
        };
        if end > bytes.len() {
            return false;
        }
        offset = end;
        pushes += 1;
    }
    first_length == Some(1) && pushes >= 2 && last == Some((bytes.len() - 6, 5))
}

fn decode_pair(transaction: &Transaction, vout: usize) -> Result<Option<DecodedPair>> {
    // Preserve the validator's existing FT-only recognition behavior. The
    // local issuance classifier additionally inspects stable-coin pairs.
    decode_pair_outputs(&transaction.outputs[vout], transaction.outputs.get(vout + 1), vout, false)
}

fn decode_pair_outputs(
    code_output: &crate::TxOut,
    tape_output: Option<&crate::TxOut>,
    vout: usize,
    include_coin: bool,
) -> Result<Option<DecodedPair>> {
    decode_pair_outputs_with_value(code_output, tape_output, vout, include_coin, TBC20_CODE_SATOSHIS)
}

fn decode_pair_outputs_with_value(
    code_output: &crate::TxOut,
    tape_output: Option<&crate::TxOut>,
    vout: usize,
    include_coin: bool,
    expected_code_value: u64,
) -> Result<Option<DecodedPair>> {
    let bytes = code_output.script_pubkey.as_bytes();
    let (code, tape_size) = if bytes.len() == TBC20_CODE_BYTES {
        match validate_tbc20_code(&code_output.script_pubkey, None) {
            Ok(()) => (
                DecodedCode {
                    kind: "TBC20".to_string(),
                    identity: hex::encode(tbc20_code_identity(&code_output.script_pubkey)?),
                    protocol: TokenProtocolDescriptor {
                        family: "TBC20".to_string(),
                        version: 1,
                    },
                    original_wire: bytes[560..596].to_vec(),
                },
                usize::from(bytes[179]),
            ),
            Err(error) if is_tbc20_artifact_candidate(&code_output.script_pubkey) => {
                return Err(error);
            }
            Err(_) => {
                let Some(artifact) = decode_published_ft_code(bytes).filter(|item| include_coin || !item.coin)
                else {
                    return Ok(None);
                };
                (
                    decoded_pair_code(&code_output.script_pubkey, &artifact)?,
                    artifact.tape_size,
                )
            }
        }
    } else {
        let Some(artifact) = decode_published_ft_code(bytes).filter(|item| include_coin || !item.coin) else {
            return Ok(None);
        };
        (
            decoded_pair_code(&code_output.script_pubkey, &artifact)?,
            artifact.tape_size,
        )
    };
    let tape_output = tape_output.ok_or_else(|| {
        Error::InvalidScript("token Code has no adjacent Tape output".to_string())
    })?;
    if code_output.satoshis != expected_code_value || tape_output.satoshis != TBC20_TAPE_SATOSHIS {
        return Err(Error::InvalidScript(
            "token Code/Tape values must be exactly 500/0".to_string(),
        ));
    }
    if tape_output.script_pubkey.as_bytes().len() != tape_size {
        return Err(Error::InvalidScript(
            "Tape size differs from Code size".to_string(),
        ));
    }
    let (slots, balance) = if code.kind == "TBC20" {
        let tape = parse_tbc20_tape(&tape_output.script_pubkey)?;
        (tape.amounts, tape.balance)
    } else {
        parse_published_ft_tape(tape_output.script_pubkey.as_bytes())?
    };
    let mut envelope = tape_output.script_pubkey.as_bytes()[..3].to_vec();
    envelope.extend_from_slice(&tape_output.script_pubkey.as_bytes()[51..]);
    Ok(Some(DecodedPair {
        code_vout: vout,
        tape_vout: vout + 1,
        code,
        tape: DecodedTape {
            slots,
            balance,
            envelope_hash: hex::encode(hash::sha256(&envelope)),
            envelope,
        },
    }))
}

fn decoded_pair_code(script: &crate::script::Script, artifact: &FtArtifact) -> Result<DecodedCode> {
    let mut code = decoded_ft_code(script, artifact)?;
    if artifact.coin {
        code.kind = "STABLE_COIN".to_string();
        code.protocol.family = "STABLE_COIN".to_string();
    }
    Ok(code)
}

fn resolve_source(
    root: &Transaction,
    vin: usize,
    ctx: &mut ValidationContext<'_>,
) -> Option<ResolvedInput> {
    let prev_txid = root.inputs[vin].previous_output.txid;
    let prev_vout = root.inputs[vin].previous_output.vout as usize;
    ctx.result.inputs[vin].resolution = "UNAVAILABLE".to_string();
    require_txid(ctx, prev_txid);
    let Some(parent) = fetch(ctx, prev_txid) else {
        add_unknown(
            ctx,
            "PARENT_FETCH_FAILED",
            "PARENT",
            Some(vin),
            None,
            None,
            Some(prev_txid.to_string()),
            None,
        );
        return None;
    };
    if prev_vout >= parent.outputs.len() {
        ctx.result.inputs[vin].resolution = "INVALID".to_string();
        add_invalid(
            ctx,
            "PARENT_VOUT_OUT_OF_RANGE",
            "PARENT",
            Some(vin),
            Some(prev_vout),
            None,
            Some(prev_txid.to_string()),
            None,
        );
        return None;
    }
    ctx.result.parents_checked += 1;
    let pair = match decode_pair(&parent, prev_vout) {
        Ok(Some(pair)) => pair,
        _ => {
            ctx.result.inputs[vin].kind = "ORDINARY".to_string();
            ctx.result.inputs[vin].resolution = "RESOLVED".to_string();
            add_invalid(
                ctx,
                "AMOUNT_SLOT_WITHOUT_TOKEN_INPUT",
                "MATRIX",
                Some(vin),
                None,
                None,
                None,
                None,
            );
            return None;
        }
    };
    let evidence = &mut ctx.result.inputs[vin];
    evidence.kind = pair.code.kind.clone();
    evidence.resolution = "RESOLVED".to_string();
    evidence.source_role = Some("POSITIVE_SOURCE".to_string());
    evidence.parent_txid = Some(prev_txid.to_string());
    evidence.code_vout = Some(pair.code_vout);
    evidence.tape_vout = Some(pair.tape_vout);
    evidence.identity = Some(pair.code.identity.clone());
    evidence.slots = Some(pair.tape.slots.iter().map(u64::to_string).collect());
    evidence.balance_raw = Some(pair.tape.balance.to_string());
    evidence.protocol = Some(pair.code.protocol.clone());
    Some(ResolvedInput { vin, pair, parent })
}

fn require_txid(ctx: &mut ValidationContext<'_>, txid: Txid) {
    if ctx.required.insert(txid) {
        ctx.result
            .source
            .as_mut()
            .unwrap()
            .required_source_txids
            .push(txid.to_string());
    }
}

fn fetch(ctx: &mut ValidationContext<'_>, txid: Txid) -> Option<Transaction> {
    if let Some(transaction) = ctx.cache.get(&txid) {
        return Some(transaction.clone());
    }
    if ctx.failed.contains(&txid) {
        return None;
    }
    ctx.result
        .source
        .as_mut()
        .unwrap()
        .queried_txids
        .push(txid.to_string());
    let transaction = ctx
        .fetcher
        .and_then(|fetcher| fetcher.fetch_token_transaction(&txid, &ctx.network).ok());
    let Some(transaction) = transaction else {
        ctx.failed.insert(txid);
        return None;
    };
    if transaction.txid() != txid {
        ctx.failed.insert(txid);
        return None;
    }
    ctx.cache.insert(txid, transaction.clone());
    ctx.result
        .source
        .as_mut()
        .unwrap()
        .resolved_txids
        .push(txid.to_string());
    ctx.result.resolved_transactions += 1;
    Some(transaction)
}

fn outpoint_wire(txid: Txid, vout: u32) -> Vec<u8> {
    let mut result = txid.as_le_bytes().to_vec();
    result.extend_from_slice(&vout.to_le_bytes());
    result
}

fn finalize(mut ctx: ValidationContext<'_>) -> TokenValidationResult {
    if ctx.invalid.is_empty() && ctx.unknown.is_empty() && ctx.result.kind == "TRANSITION" {
        for mandatory in [
            "STRUCTURE",
            "TRANSITION",
            "OUTPUT_SOURCE_LINEAGE",
            "OUTPUT_SOURCE_GRAPH_RESOLVED",
        ] {
            if !ctx.result.assurances.iter().any(|value| value == mandatory) {
                add_unknown_message(
                    &mut ctx,
                    "VALIDATOR_INTERNAL_INCOMPLETE",
                    "ROOT",
                    "mandatory validation assurance is incomplete",
                );
                break;
            }
        }
    }
    ctx.result.status = if !ctx.invalid.is_empty() {
        "INVALID"
    } else if !ctx.unknown.is_empty() {
        "UNKNOWN"
    } else if ctx.result.kind == "TRANSITION" {
        "VALID"
    } else {
        "INVALID"
    }
    .to_string();
    ctx.result.issues.extend(ctx.invalid);
    ctx.result.issues.extend(ctx.unknown);
    ctx.result.issues.extend(ctx.warnings);
    ctx.result
}

// Mirrors the public JS issue schema field-for-field at the single construction point.
#[allow(clippy::too_many_arguments)]
fn issue(
    code: &str,
    stage: &str,
    message: impl Into<String>,
    vin: Option<usize>,
    vout: Option<usize>,
    slot: Option<usize>,
    txid: Option<String>,
    identity: Option<String>,
) -> TokenValidationIssue {
    TokenValidationIssue {
        code: code.to_string(),
        severity: "error".to_string(),
        stage: stage.to_string(),
        message: message.into(),
        vin,
        vout,
        slot,
        txid,
        identity,
    }
}

fn default_message(code: &str) -> String {
    code.to_ascii_lowercase().replace('_', " ")
}

#[allow(clippy::too_many_arguments)]
fn add_invalid(
    ctx: &mut ValidationContext<'_>,
    code: &str,
    stage: &str,
    vin: Option<usize>,
    vout: Option<usize>,
    slot: Option<usize>,
    txid: Option<String>,
    identity: Option<String>,
) {
    let message = default_message(code);
    add_invalid_full(
        ctx,
        issue(code, stage, message, vin, vout, slot, txid, identity),
    );
}

fn add_invalid_message(
    ctx: &mut ValidationContext<'_>,
    code: &str,
    stage: &str,
    message: impl Into<String>,
) {
    add_invalid_full(
        ctx,
        issue(code, stage, message, None, None, None, None, None),
    );
}

fn add_invalid_full(ctx: &mut ValidationContext<'_>, issue: TokenValidationIssue) {
    ctx.invalid.push(issue);
}

#[allow(clippy::too_many_arguments)]
fn add_unknown(
    ctx: &mut ValidationContext<'_>,
    code: &str,
    stage: &str,
    vin: Option<usize>,
    vout: Option<usize>,
    slot: Option<usize>,
    txid: Option<String>,
    identity: Option<String>,
) {
    let message = default_message(code);
    ctx.unknown
        .push(issue(code, stage, message, vin, vout, slot, txid, identity));
}

fn add_unknown_message(
    ctx: &mut ValidationContext<'_>,
    code: &str,
    stage: &str,
    message: impl Into<String>,
) {
    ctx.unknown
        .push(issue(code, stage, message, None, None, None, None, None));
}

fn add_warning_identity(ctx: &mut ValidationContext<'_>, identity: &str) {
    let mut warning = issue(
        "TAPE_ENVELOPE_MISMATCH",
        "MATRIX",
        "tape envelope mismatch",
        None,
        None,
        None,
        None,
        Some(identity.to_string()),
    );
    warning.severity = "warning".to_string();
    ctx.warnings.push(warning);
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::{OutPoint, TxIn};

    fn fixtures() -> (Value, Value) {
        (
            serde_json::from_str(include_str!("../tests/fixtures/js-166/tbc20.json")).unwrap(),
            serde_json::from_str(include_str!("../tests/fixtures/js-166/validator.json")).unwrap(),
        )
    }

    #[tokio::test]
    async fn invalid_policy_and_root_match_javascript_166() {
        let (_, expected) = fixtures();
        let policy = validate_on_chain_transaction(TokenValidationOptions::default()).await;
        assert_eq!(
            serde_json::to_value(policy).unwrap(),
            expected["invalidPolicy"]
        );

        let root = validate_on_chain_transaction(TokenValidationOptions {
            raw_hex: Some("00".to_string()),
            ..TokenValidationOptions::default()
        })
        .await;
        assert_eq!(serde_json::to_value(root).unwrap(), expected["invalidRoot"]);
    }

    #[tokio::test]
    async fn valid_transfer_and_merge_reports_match_javascript_166() {
        let (fixture, expected) = fixtures();
        let tx = &fixture["transactionFixture"];
        let source = Transaction::from_hex(tx["sourceRaw"].as_str().unwrap()).unwrap();
        let mint = Transaction::from_hex(tx["mintRaw"].as_str().unwrap()).unwrap();
        let transfer = Transaction::from_hex(tx["transferRaw"].as_str().unwrap()).unwrap();
        let split = Transaction::from_hex(tx["splitRaw"].as_str().unwrap()).unwrap();
        let merge = Transaction::from_hex(tx["mergeRaw"].as_str().unwrap()).unwrap();

        let transfer_fetcher = InMemoryTokenTransactionFetcher::new([source, mint.clone()]);
        let report = validate_on_chain_transaction(TokenValidationOptions {
            transaction: Some(transfer),
            fetcher: Some(&transfer_fetcher),
            ..TokenValidationOptions::default()
        })
        .await;
        assert_eq!(
            serde_json::to_value(report).unwrap(),
            expected["validTransfer"]
        );

        let merge_fetcher = InMemoryTokenTransactionFetcher::new([mint, split]);
        let report = validate_on_chain_transaction(TokenValidationOptions {
            transaction: Some(merge),
            fetcher: Some(&merge_fetcher),
            ..TokenValidationOptions::default()
        })
        .await;
        assert_eq!(
            serde_json::to_value(report).unwrap(),
            expected["validMerge"]
        );
    }

    #[tokio::test]
    async fn zero_balance_output_requires_and_accepts_an_identity_witness() {
        let (fixture, _) = fixtures();
        let tx = &fixture["transactionFixture"];
        let mut parent = Transaction::from_hex(tx["mintRaw"].as_str().unwrap()).unwrap();
        parent.outputs[1].script_pubkey = crate::contracts::tbc20::replace_tbc20_tape_amounts(
            &parent.outputs[1].script_pubkey,
            [0; TBC20_AMOUNT_SLOTS],
        )
        .unwrap();

        let mut root = Transaction::new();
        root.inputs.push(TxIn::new(OutPoint {
            txid: parent.txid(),
            vout: 0,
        }));
        root.outputs.extend_from_slice(&parent.outputs[..2]);

        let empty_fetcher = InMemoryTokenTransactionFetcher::new(std::iter::empty::<Transaction>());
        let missing = validate_on_chain_transaction(TokenValidationOptions {
            transaction: Some(root.clone()),
            fetcher: Some(&empty_fetcher),
            ..TokenValidationOptions::default()
        })
        .await;
        assert_eq!(missing.status, "UNKNOWN");
        assert!(
            missing
                .issues
                .iter()
                .any(|issue| issue.code == "ZERO_IDENTITY_WITNESS_UNRESOLVED")
        );

        let fetcher = InMemoryTokenTransactionFetcher::new([parent]);
        let valid = validate_on_chain_transaction(TokenValidationOptions {
            transaction: Some(root),
            fetcher: Some(&fetcher),
            ..TokenValidationOptions::default()
        })
        .await;
        assert_eq!(valid.status, "VALID");
        assert_eq!(
            valid.inputs[0].source_role.as_deref(),
            Some("ZERO_IDENTITY_WITNESS")
        );
        assert_eq!(valid.assets[0].input_raw, "0");
        assert_eq!(valid.assets[0].output_raw, "0");
    }
}
