use tbc_sdk::{
    Address, OutPoint, Transaction, TxIn, TxOut, Txid,
    contracts::nft::{CollectionData, NftData, scripts::{self, NftVersion}},
    script::Script,
};

use crate::families::ft::{
    checked_sum_u64, enforce_max_fee, fee_rate, finish_plan, funding_candidates, internal,
    invalid_input, native_input, planned_output, required, validate_material_identity,
    validate_policy,
};
use crate::funding::{NativeFundingUtxo, conservative_transaction_fee};
use crate::model::{AssetFlow, CanonicalRequest, PlannedTransfer, Violation, WalletMaterial, error};
use crate::normalize::{hex, parse_decimal_u64, validate_request};
use crate::signing::{
    EvidenceEntry, FtTransactionSource, PlannedInput, PlannedTransaction, PublicSigningContext,
    UnsignedPlan, begin_signing, nft_unlocking_descriptor,
};
use crate::{EngineError, ErrorCode};

const MAX_P2PKH_SCRIPT_SIG_BYTES: u64 = 108;
const LEGACY_CODE_PREFIX: &str = "OP_1 OP_PICK OP_3 OP_SPLIT 0x01 0x14 OP_SPLIT OP_DROP OP_TOALTSTACK OP_DROP OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_1 OP_PICK OP_TOALTSTACK OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_SHA256 OP_CAT OP_1 OP_PICK 0x01 0x24 OP_SPLIT OP_DROP OP_TOALTSTACK OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_SHA256 OP_SHA256 OP_6 OP_PUSH_META 0x01 0x20 OP_SPLIT OP_DROP OP_EQUALVERIFY OP_1 OP_PICK OP_TOALTSTACK OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_SHA256 OP_CAT OP_CAT OP_CAT OP_SHA256 OP_SHA256 OP_FROMALTSTACK OP_FROMALTSTACK OP_DUP 0x01 0x20 OP_SPLIT OP_DROP OP_3 OP_ROLL OP_EQUALVERIFY OP_SWAP OP_FROMALTSTACK OP_DUP OP_TOALTSTACK OP_EQUAL OP_IF OP_DROP OP_ELSE 0x24";
const LEGACY_CODE_SUFFIX: &str = "OP_EQUALVERIFY OP_ENDIF OP_1 OP_PICK OP_FROMALTSTACK OP_EQUALVERIFY OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_SHA256 OP_7 OP_PUSH_META OP_EQUALVERIFY OP_DUP OP_HASH160 OP_FROMALTSTACK OP_EQUALVERIFY OP_CHECKSIG OP_RETURN 0x05 0x33436f6465";
pub(crate) fn plan_nft(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
) -> Result<PlannedTransfer, EngineError> {
    validate_request(request)?;
    validate_material_identity(request, material)?;
    validate_policy(material)?;
    match request.intent.intent_type.as_str() {
        "tbc.collection.create" => plan_collection_create(request, material, signing),
        "tbc.nft.mint" => plan_nft_mint(request, material, signing),
        "tbc.nft.transfer" => plan_nft_transfer(request, material, signing),
        _ => Err(error(ErrorCode::UnsupportedIntent, "unsupported NFT intent", "request.intent.type")),
    }
}

pub(crate) fn validate_nft_plan(request: &CanonicalRequest, plan: &UnsignedPlan) -> Vec<Violation> {
    let roles = plan.transactions.iter().map(|tx| tx.role.as_str()).collect::<Vec<_>>();
    let expected = match request.intent.intent_type.as_str() {
        "tbc.collection.create" | "tbc.nft.mint" | "tbc.nft.transfer" => vec!["primary"],
        _ => Vec::new(),
    };
    let mut violations = Vec::new();
    if roles != expected {
        violations.push(Violation { code: "BUSINESS_OUTPUT_MISMATCH".to_owned(), path: Some("plan.payload.transactions".to_owned()) });
    }
    if begin_signing(plan).is_err() {
        violations.push(Violation { code: "SIGNING_TASK_MISMATCH".to_owned(), path: Some("plan.payload.signingTasks".to_owned()) });
    }
    violations
}

fn plan_collection_create(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
) -> Result<PlannedTransfer, EngineError> {
    let supply = parse_decimal_u64(required(&request.intent.supply, "request.intent.supply")?, "request.intent.supply")? as u32;
    let media = serde_json::to_string(request.intent.media.as_ref().ok_or_else(|| invalid_input("collection media is missing", "request.intent.media"))?)
        .map_err(|_| internal("could not serialize collection media"))?;
    let data = CollectionData {
        collection_name: required(&request.intent.name, "request.intent.name")?.to_owned(),
        description: required(&request.intent.description, "request.intent.description")?.to_owned(),
        supply,
        file: media,
    };
    let owner = Address::from_string(&signing.address).map_err(|_| internal("validated account address became invalid"))?;
    let mut outputs = vec![TxOut { satoshis: scripts::NFT_TAPE_SATOSHIS, script_pubkey: scripts::tape_script(&data).map_err(|_| internal("could not encode collection Tape"))? }];
    outputs.extend((0..supply).map(|_| TxOut { satoshis: scripts::NFT_HOLD_SATOSHIS, script_pubkey: scripts::mint_script(&owner) }));
    build_single_nft_plan(request, material, signing, Vec::new(), outputs, None, Vec::new(), vec![AssetFlow {
        kind: "collection".to_owned(), direction: "create".to_owned(), amount: supply.to_string(), contract_id: None, from: request.from.clone(), to: Some(request.from.clone()),
    }])
}

fn plan_nft_mint(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
) -> Result<PlannedTransfer, EngineError> {
    let collection_id = required(&request.intent.collection_id, "request.intent.collectionId")?;
    let contract = unique_contract(material, collection_id, "collection")?;
    if contract.contract_id != contract.creation_txid
        || contract.protocol_version != "2.0"
        || contract.current_outpoint.txid != contract.creation_txid
    {
        return Err(invalid_ancestry("collection contract identity or version is inconsistent"));
    }
    let owner = Address::from_string(&signing.address).map_err(|_| internal("validated account address became invalid"))?;
    let (parent, collection) = validate_collection_origin(material, collection_id, Some(&owner))?;
    let slots = material.snapshot.payload.utxos.iter().filter(|utxo| {
        utxo.classification == "collection-slot" && utxo.contract_id.as_deref() == Some(collection_id)
            && utxo.txid == contract.current_outpoint.txid && utxo.vout == contract.current_outpoint.vout
    }).collect::<Vec<_>>();
    if slots.len() != 1 { return Err(invalid_ancestry("snapshot must contain exactly one current collection mint slot")); }
    let slot = slots[0];
    require_confirmations(slot.confirmations.as_deref(), material)?;
    let output = parent.outputs.get(slot.vout as usize).ok_or_else(|| invalid_ancestry("collection mint slot output is missing"))?;
    if output.satoshis != scripts::NFT_HOLD_SATOSHIS || output.script_pubkey != scripts::mint_script(&owner)
        || slot.satoshis != output.satoshis.to_string() || slot.script_pub_key != hex(output.script_pubkey.as_bytes()) {
        return Err(invalid_ancestry("collection mint slot does not match its authenticated parent"));
    }
    if slot.vout == 0 || slot.vout > collection.supply {
        return Err(invalid_ancestry("collection mint slots do not match authenticated supply or owner"));
    }
    let attributes = serde_json::to_string(request.intent.attributes.as_ref().ok_or_else(|| invalid_input("NFT attributes are missing", "request.intent.attributes"))?)
        .map_err(|_| internal("could not serialize NFT attributes"))?;
    let file = request.intent.media.as_ref().map(serde_json::to_string).transpose().map_err(|_| internal("could not serialize NFT media"))?
        .or_else(|| Some(format!("{}{}", collection_id, hex(&slot.vout.to_le_bytes()))));
    let data = NftData {
        nft_name: required(&request.intent.name, "request.intent.name")?.to_owned(),
        symbol: required(&request.intent.symbol, "request.intent.symbol")?.to_owned(),
        description: required(&request.intent.description, "request.intent.description")?.to_owned(),
        attributes,
        file,
    };
    let outputs = vec![
        TxOut { satoshis: scripts::NFT_CODE_SATOSHIS, script_pubkey: scripts::code_script(&slot.txid, slot.vout).map_err(|_| invalid_ancestry("could not bind NFT code to collection slot"))? },
        TxOut { satoshis: scripts::NFT_HOLD_SATOSHIS, script_pubkey: scripts::hold_script(&owner) },
        TxOut { satoshis: scripts::NFT_TAPE_SATOSHIS, script_pubkey: scripts::tape_script(&data).map_err(|_| internal("could not encode NFT Tape"))? },
    ];
    let contract_input = PlannedInput {
        previous_transaction_id: slot.txid.clone(), previous_output_index: slot.vout,
        previous_output_script: slot.script_pub_key.clone(), previous_output_satoshis: output.satoshis,
        sequence: tbc_sdk::DEFAULT_SEQUENCE, unlocking_script: String::new(), signer: signing.clone(),
    };
    build_single_nft_plan(request, material, signing, vec![contract_input], outputs, None, Vec::new(), vec![AssetFlow {
        kind: "nft".to_owned(), direction: "mint".to_owned(), amount: "1".to_owned(), contract_id: None, from: request.from.clone(), to: Some(request.from.clone()),
    }])
}

fn plan_nft_transfer(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
) -> Result<PlannedTransfer, EngineError> {
    let contract_id = required(&request.intent.contract_id, "request.intent.contractId")?;
    let contract = unique_contract(material, contract_id, "nft")?;
    let parent = verified_parent(material, &contract.current_outpoint.txid)?;
    if contract.contract_id != contract.creation_txid || contract.protocol_version != "2.0" {
        return Err(invalid_ancestry("NFT contract identity or version is inconsistent"));
    }
    if contract.current_outpoint.vout != 0 || parent.outputs.len() < 3 { return Err(invalid_ancestry("NFT current outpoint topology is invalid")); }
    let code = &parent.outputs[0];
    let hold = &parent.outputs[1];
    let code_version = scripts::nft_version(&code.script_pubkey).ok_or_else(|| invalid_ancestry("NFT code version is unsupported"))?;
    if code.satoshis != scripts::NFT_CODE_SATOSHIS || hold.satoshis != scripts::NFT_HOLD_SATOSHIS {
        return Err(invalid_ancestry("NFT code or hold output is invalid"));
    }
    let owner = Address::from_string(&signing.address).map_err(|_| internal("validated account address became invalid"))?;
    if hold.script_pubkey != scripts::hold_script(&owner) { return Err(invalid_ancestry("NFT hold output is not controlled by the snapshot account")); }
    for vout in [0u32, 1] {
        let utxo = material.snapshot.payload.utxos.iter().find(|utxo| utxo.classification == "nft" && utxo.contract_id.as_deref() == Some(contract_id) && utxo.txid == contract.current_outpoint.txid && utxo.vout == vout)
            .ok_or_else(|| error(ErrorCode::MissingMaterial, "NFT code and hold UTXOs are required", "snapshot.payload.utxos"))?;
        require_confirmations(utxo.confirmations.as_deref(), material)?;
        let output = &parent.outputs[vout as usize];
        if utxo.satoshis != output.satoshis.to_string() || utxo.script_pub_key != hex(output.script_pubkey.as_bytes()) { return Err(invalid_ancestry("NFT UTXO does not match its authenticated parent")); }
    }
    let data: NftData = decode_tape(&parent.outputs[2])?;
    let (collection_id, collection_index) = code_origin(&code.script_pubkey, code_version)?;
    authenticate_nft_lineage(
        material,
        &contract.creation_txid,
        &parent,
        &code.script_pubkey,
        &parent.outputs[2].script_pubkey,
        &collection_id,
        collection_index,
    )?;
    let recipient = Address::from_string(required(&request.intent.to, "request.intent.to")?).map_err(|_| invalid_input("invalid NFT recipient", "request.intent.to"))?;
    let next_code = match code_version {
        NftVersion::V1 => scripts::code_script_v1(&collection_id, collection_index),
        NftVersion::V2 => scripts::code_script(&collection_id, collection_index),
            NftVersion::V0 => legacy_code_script(&collection_id, collection_index),
    }.map_err(|_| invalid_ancestry("NFT origin cannot be reconstructed"))?;
    let outputs = vec![
        TxOut { satoshis: scripts::NFT_CODE_SATOSHIS, script_pubkey: next_code },
        TxOut { satoshis: scripts::NFT_HOLD_SATOSHIS, script_pubkey: scripts::hold_script(&recipient) },
        TxOut { satoshis: scripts::NFT_TAPE_SATOSHIS, script_pubkey: scripts::tape_script(&data).map_err(|_| internal("could not preserve NFT Tape"))? },
    ];
    let pre_pre_txid = parent.inputs.first().ok_or_else(|| invalid_ancestry("NFT parent input is missing"))?.previous_output.txid.to_string();
    let pre_pre_item = material.snapshot.payload.parents.iter().find(|item| item.txid == pre_pre_txid).ok_or_else(|| invalid_ancestry("NFT pre-pre transaction is missing"))?;
    let parent_item = material.snapshot.payload.parents.iter()
        .find(|item| item.txid == parent.txid().to_string())
        .ok_or_else(|| invalid_ancestry("NFT parent evidence is missing"))?;
    let evidence_table = vec![
        EvidenceEntry { txid: parent_item.txid.clone(), raw_transaction: parent_item.raw_transaction.clone() },
        EvidenceEntry { txid: pre_pre_item.txid.clone(), raw_transaction: pre_pre_item.raw_transaction.clone() },
    ];
        let descriptor = nft_unlocking_descriptor(
            FtTransactionSource::Evidence(0),
            FtTransactionSource::Evidence(1),
            nft_version_number(code_version),
        )?;
    let contract_inputs = vec![
        PlannedInput { previous_transaction_id: parent.txid().to_string(), previous_output_index: 0, previous_output_script: hex(code.script_pubkey.as_bytes()), previous_output_satoshis: code.satoshis, sequence: tbc_sdk::DEFAULT_SEQUENCE, unlocking_script: descriptor, signer: signing.clone() },
        PlannedInput { previous_transaction_id: parent.txid().to_string(), previous_output_index: 1, previous_output_script: hex(hold.script_pubkey.as_bytes()), previous_output_satoshis: hold.satoshis, sequence: tbc_sdk::DEFAULT_SEQUENCE, unlocking_script: String::new(), signer: signing.clone() },
    ];
    let pre_pre = verified_parent(material, &pre_pre_item.txid)?;
        build_single_nft_plan(request, material, signing, contract_inputs, outputs, Some((parent, pre_pre, code_version)), evidence_table, vec![AssetFlow {
        kind: "nft".to_owned(), direction: "send".to_owned(), amount: "1".to_owned(), contract_id: None, from: request.from.clone(), to: request.intent.to.clone(),
    }])
}

fn build_single_nft_plan(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
    contract_inputs: Vec<PlannedInput>,
    base_outputs: Vec<TxOut>,
    covenant_parents: Option<(Transaction, Transaction, NftVersion)>,
    evidence_table: Vec<EvidenceEntry>,
    flows: Vec<AssetFlow>,
) -> Result<PlannedTransfer, EngineError> {
    let rate = fee_rate(material)?;
    let fixed = checked_sum_u64(base_outputs.iter().map(|output| output.satoshis), "NFT output sum overflow")?;
    let contract_value = checked_sum_u64(contract_inputs.iter().map(|input| input.previous_output_satoshis), "NFT input sum overflow")?;
    let owner_script = Address::from_string(&signing.address).map_err(|_| internal("validated account address became invalid"))?.script_pubkey();
    for funding in funding_candidates(material, signing)? {
        let input_sum = contract_value.checked_add(funding.satoshis).ok_or_else(|| internal("NFT input sum overflow"))?;
        let mut with_change = base_outputs.clone();
        with_change.push(TxOut { satoshis: 1, script_pubkey: owner_script.clone() });
        let fee_with = estimate_nft_fee(&contract_inputs, &funding, &with_change, rate, covenant_parents.as_ref())?;
        let (outputs, fee) = if let Some(change) = input_sum.checked_sub(fixed.saturating_add(fee_with)).filter(|change| *change >= tbc_sdk::SDK_DUST_SAT) {
            let mut outputs = base_outputs.clone();
            outputs.push(TxOut { satoshis: change, script_pubkey: owner_script.clone() });
            (outputs, fee_with)
        } else {
            let fee_min = estimate_nft_fee(&contract_inputs, &funding, &base_outputs, rate, covenant_parents.as_ref())?;
            let Some(paid) = input_sum.checked_sub(fixed) else { continue };
            if paid < fee_min { continue; }
            (base_outputs.clone(), paid)
        };
        enforce_max_fee(request, fee)?;
        let mut inputs = contract_inputs.clone();
        inputs.push(native_input(&funding, signing));
        let planned = PlannedTransaction {
            transaction_id: match request.intent.intent_type.as_str() { "tbc.collection.create" => "collection-create-1", "tbc.nft.mint" => "nft-mint-1", _ => "nft-transfer-1" }.to_owned(),
            role: "primary".to_owned(), stage: 0, depends_on: Vec::new(), version: tbc_sdk::TX_VERSION,
            inputs, outputs: outputs.iter().map(planned_output).collect(), lock_time: 0,
        };
        let preview = preview_transaction(&planned, &outputs)?;
        return finish_plan(request, material, UnsignedPlan { transactions: vec![planned], evidence_table }, vec![preview], vec![fee], Vec::new(), flows);
    }
    Err(error(ErrorCode::InsufficientFunds, "no native UTXO can fund the NFT transaction", "snapshot.payload.utxos"))
}

fn estimate_nft_fee(
    contract_inputs: &[PlannedInput],
    funding: &NativeFundingUtxo,
    outputs: &[TxOut],
    rate: u64,
    covenant_parents: Option<&(Transaction, Transaction, NftVersion)>,
) -> Result<u64, EngineError> {
    let mut inputs = contract_inputs.to_vec();
    inputs.push(PlannedInput { previous_transaction_id: funding.txid.clone(), previous_output_index: funding.vout, previous_output_script: funding.script.clone(), previous_output_satoshis: funding.satoshis, sequence: tbc_sdk::DEFAULT_SEQUENCE, unlocking_script: String::new(), signer: contract_inputs.first().map(|input| input.signer.clone()).unwrap_or_else(|| PublicSigningContext { address: String::new(), public_key: String::new(), public_key_hash: String::new() }) });
    let tx = Transaction { version: tbc_sdk::TX_VERSION, inputs: inputs.iter().map(|input| TxIn::new(OutPoint { txid: input.previous_transaction_id.parse().expect("authenticated txid"), vout: input.previous_output_index })).collect(), outputs: outputs.to_vec(), lock_time: 0 };
    let p2pkh = u64::try_from(inputs.len()).map_err(|_| internal("NFT input count overflow"))?.checked_mul(MAX_P2PKH_SCRIPT_SIG_BYTES).ok_or_else(|| internal("NFT signature headroom overflow"))?;
        let covenant_headroom = if let Some((parent, pre_pre, version)) = covenant_parents {
            let (current, pre_pre, pre) = if *version == NftVersion::V0 {
                (
                    crate::signing::legacy_current_tx_data(&tx)?,
                    crate::signing::legacy_pre_pre_tx_data(pre_pre)?,
                    crate::signing::legacy_pre_tx_data(parent)?,
                )
            } else {
                (
                    tbc_sdk::contracts::nft::unlock::current_tx_data(&tx).map_err(|_| internal("could not size NFT current transaction covenant data"))?,
                    tbc_sdk::contracts::nft::unlock::pre_pre_tx_data(pre_pre).map_err(|_| invalid_ancestry("could not size NFT pre-pre covenant data"))?,
                    tbc_sdk::contracts::nft::unlock::pre_tx_data(parent).map_err(|_| invalid_ancestry("could not size NFT parent covenant data"))?,
                )
            };
        u64::try_from(current.len().checked_add(pre_pre.len()).and_then(|sum| sum.checked_add(pre.len()))
            .ok_or_else(|| internal("NFT covenant size overflow"))?)
            .map_err(|_| internal("NFT covenant size exceeds uint64"))?
    } else {
        0
    };
    conservative_transaction_fee(tx.serialize().len(), p2pkh.checked_add(covenant_headroom).ok_or_else(|| internal("NFT signature headroom overflow"))?, rate)
}

fn authenticate_nft_lineage(
    material: &WalletMaterial<'_>,
    creation_txid: &str,
    current: &Transaction,
    immutable_code: &Script,
    immutable_tape: &Script,
    collection_id: &str,
    collection_index: u32,
) -> Result<(), EngineError> {
    // Issuance validity is the trusted node/indexer's responsibility. A holder
    // transfer needs its immutable mint identity and immediate unlock proof,
    // not a second audit of the collection's historical supply transaction.
    if collection_index == 0 { return Err(invalid_ancestry("NFT collection slot must be nonzero")); }
    // The wallet's trusted node supplies the current unspent pair. Bind mint,
    // current and direct predecessor locally; older transfers are node history,
    // not material needed to unlock this transaction.
    let mint = verified_parent(material, creation_txid)?;
    let validate = |tx: &Transaction| -> Result<(), EngineError> {
        if tx.outputs.len() < 3
            || tx.outputs[0].satoshis != scripts::NFT_CODE_SATOSHIS
            || tx.outputs[0].script_pubkey != *immutable_code
            || tx.outputs[1].satoshis != scripts::NFT_HOLD_SATOSHIS
            || tx.outputs[2].satoshis != scripts::NFT_TAPE_SATOSHIS
            || tx.outputs[2].script_pubkey != *immutable_tape {
            return Err(invalid_ancestry("NFT descendant mutated immutable code or Tape state"));
        }
        Ok(())
    };
    validate(&mint)?;
    validate(current)?;
    let mint_input = mint.inputs.first().ok_or_else(|| invalid_ancestry("NFT creation input is missing"))?;
    if mint_input.previous_output.txid.to_string() != collection_id || mint_input.previous_output.vout != collection_index {
        return Err(invalid_ancestry("NFT creation does not spend its bound collection slot"));
    }
    if current.txid().to_string() != creation_txid {
        if current.inputs.len() < 2
            || current.inputs[0].previous_output.txid != current.inputs[1].previous_output.txid
            || current.inputs[0].previous_output.vout != 0 || current.inputs[1].previous_output.vout != 1 {
            return Err(invalid_ancestry("NFT descendant inputs do not spend the preceding code and hold pair"));
        }
        let previous = verified_parent(material, &current.inputs[0].previous_output.txid.to_string())?;
        validate(&previous)?;
    }
    Ok(())
}

fn preview_transaction(planned: &PlannedTransaction, outputs: &[TxOut]) -> Result<Transaction, EngineError> {
    Ok(Transaction { version: planned.version, inputs: planned.inputs.iter().map(|input| Ok(TxIn::new(OutPoint { txid: input.previous_transaction_id.parse().map_err(|_| invalid_ancestry("planned NFT input txid is invalid"))?, vout: input.previous_output_index }))).collect::<Result<Vec<_>, EngineError>>()?, outputs: outputs.to_vec(), lock_time: planned.lock_time })
}

fn unique_contract<'a>(material: &'a WalletMaterial<'_>, contract_id: &str, family: &str) -> Result<&'a crate::model::ContractRecord, EngineError> {
    let matches = material.snapshot.payload.contracts.iter().filter(|record| record.contract_id == contract_id && record.family == family).collect::<Vec<_>>();
    if matches.len() != 1 { return Err(invalid_ancestry("snapshot must contain exactly one matching contract record")); }
    Ok(matches[0])
}

fn verified_parent(material: &WalletMaterial<'_>, txid: &str) -> Result<Transaction, EngineError> {
    let item = material.snapshot.payload.parents.iter().find(|item| item.txid == txid).ok_or_else(|| invalid_ancestry("required parent transaction is missing"))?;
    let tx = Transaction::from_hex(&item.raw_transaction).map_err(|_| invalid_ancestry("parent transaction is malformed"))?;
    if tx.txid().to_string() != item.txid || tx.to_hex() != item.raw_transaction { return Err(invalid_ancestry("parent transaction identity or encoding is inconsistent")); }
    Ok(tx)
}

fn require_confirmations(value: Option<&str>, material: &WalletMaterial<'_>) -> Result<(), EngineError> {
    let minimum = parse_decimal_u64(&material.policy.payload.min_confirmations, "policy.payload.minConfirmations")?;
    if !crate::confirmations::meets_minimum(value, minimum, "snapshot.payload.utxos.confirmations")? {
        return Err(error(ErrorCode::MissingMaterial, "contract UTXO lacks required confirmations", "snapshot.payload.utxos"));
    }
    Ok(())
}

fn decode_tape<T: serde::de::DeserializeOwned>(output: &TxOut) -> Result<T, EngineError> {
    crate::protocols::nft_metadata::decode_tape(output)
}

pub(crate) fn code_origin(script: &Script, version: NftVersion) -> Result<(String, u32), EngineError> {
    let bytes = script.as_bytes();
    for start in 0..bytes.len().saturating_sub(36) {
        if bytes[start] != 0x24 || start + 37 > bytes.len() { continue; }
        let mut txid = bytes[start + 1..start + 33].to_vec();
        txid.reverse();
        let id = hex(&txid);
        let vout = u32::from_le_bytes(bytes[start + 33..start + 37].try_into().unwrap());
            let candidate = match version { NftVersion::V1 => scripts::code_script_v1(&id, vout), NftVersion::V2 => scripts::code_script(&id, vout), NftVersion::V0 => legacy_code_script(&id, vout) };
        if candidate.as_ref().is_ok_and(|candidate| candidate == script) { return Ok((id, vout)); }
    }
    Err(invalid_ancestry("NFT code origin binding is invalid"))
}

fn nft_version_number(version: NftVersion) -> u8 {
    match version { NftVersion::V0 => 0, NftVersion::V1 => 1, NftVersion::V2 => 2 }
}

pub(crate) fn legacy_code_script(collection_id: &str, collection_index: u32) -> Result<Script, tbc_sdk::Error> {
    let txid = collection_id.parse::<Txid>()?;
    let origin = format!("{}{}", hex(txid.as_le_bytes()), hex(&collection_index.to_le_bytes()));
    Script::from_asm(&format!("{LEGACY_CODE_PREFIX} 0x{origin} {LEGACY_CODE_SUFFIX}"))
}

fn validate_collection_origin(
    material: &WalletMaterial<'_>,
    collection_id: &str,
    expected_owner: Option<&Address>,
) -> Result<(Transaction, CollectionData), EngineError> {
    let collection = verified_parent(material, collection_id)?;
    let data: CollectionData = decode_tape(collection.outputs.first().ok_or_else(|| invalid_ancestry("collection Tape is missing"))?)?;
    if data.supply == 0 { return Err(invalid_ancestry("collection supply must be positive")); }
    let required_outputs = usize::try_from(data.supply).map_err(|_| invalid_ancestry("collection supply exceeds local limits"))?
        .checked_add(1).ok_or_else(|| invalid_ancestry("collection output count overflow"))?;
    if collection.outputs.len() != required_outputs && collection.outputs.len() != required_outputs + 1 {
        return Err(invalid_ancestry("collection output count does not match declared supply"));
    }
    let first = collection.outputs.get(1).ok_or_else(|| invalid_ancestry("collection mint slots are missing"))?;
    if first.satoshis != scripts::NFT_HOLD_SATOSHIS { return Err(invalid_ancestry("collection mint slot value is invalid")); }
    let owner = mint_script_owner(&first.script_pubkey)?;
    if expected_owner.is_some_and(|expected| expected != &owner) { return Err(invalid_ancestry("collection mint slots are bound to a different owner")); }
    let expected_script = scripts::mint_script(&owner);
    if collection.outputs[1..required_outputs].iter().any(|output| output.satoshis != scripts::NFT_HOLD_SATOSHIS || output.script_pubkey != expected_script) {
        return Err(invalid_ancestry("collection mint slots do not match authenticated supply or owner"));
    }
    if let Some(change) = collection.outputs.get(required_outputs) {
        if change.satoshis < tbc_sdk::SDK_DUST_SAT || !is_p2pkh_script(&change.script_pubkey) {
            return Err(invalid_ancestry("collection trailing output is not a valid change output"));
        }
    }
    let mut inputs = std::collections::BTreeSet::new();
    for input in &collection.inputs {
        let key = (input.previous_output.txid.to_string(), input.previous_output.vout);
        if !inputs.insert(key.clone()) { return Err(invalid_ancestry("collection funding inputs contain a duplicate outpoint")); }
    }
    Ok((collection, data))
}

fn mint_script_owner(script: &Script) -> Result<Address, EngineError> {
    let bytes = script.as_bytes();
    for start in 0..=bytes.len().saturating_sub(20) {
        let Ok(hash) = <[u8; 20]>::try_from(&bytes[start..start + 20]) else { continue };
        let owner = Address::from_hash160(hash);
        if scripts::mint_script(&owner) == *script { return Ok(owner); }
    }
    Err(invalid_ancestry("collection mint script is not canonical"))
}

fn is_p2pkh_script(script: &Script) -> bool {
    let bytes = script.as_bytes();
    bytes.len() == 25 && bytes[0..3] == [0x76, 0xa9, 0x14] && bytes[23..25] == [0x88, 0xac]
}

fn invalid_ancestry(message: &str) -> EngineError {
    error(ErrorCode::InvalidAncestry, message, "snapshot.payload")
}

#[cfg(test)]
mod task6_round1_tests {
    use super::*;

    #[test]
    fn pinned_legacy_v0_script_is_detected_and_round_trips_its_origin() {
        let collection_id = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let script = legacy_code_script(collection_id, 7).expect("legacy script");
        assert_eq!(script.as_bytes().len(), 142);
        assert_eq!(scripts::nft_version(&script), Some(NftVersion::V0));
        assert_eq!(code_origin(&script, NftVersion::V0).unwrap(), (collection_id.to_owned(), 7));
        assert!(code_origin(&script, NftVersion::V1).is_err());
        assert!(code_origin(&script, NftVersion::V2).is_err());
    }
}
