use serde::{Deserialize, Serialize};
use tbc_sdk::{Transaction, contracts::ft::unlock::pre_pre_tx_data};

const TAPE_PREFIX_LENGTH: usize = 3;
const TAPE_AMOUNT_LENGTH: usize = 48;
const TAPE_SLOT_LENGTH: usize = 8;
const TAPE_SLOT_COUNT: usize = TAPE_AMOUNT_LENGTH / TAPE_SLOT_LENGTH;
const TAPE_MINIMUM_LENGTH: usize = 56;
const TAPE_PREFIX: [u8; 3] = [0x00, 0x6a, 0x30];
const TAPE_MARKER: &[u8] = b"FTape";

#[derive(Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
enum AssetAncestryRequest {
    Inspect { items: Vec<ParentEntry> },
    Prove { items: Vec<ProofEntry> },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ParentEntry {
    parent_txid: String,
    output_index: u32,
    parent_txraw: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProofEntry {
    parent_txid: String,
    output_index: u32,
    parent_txraw: String,
    grandparents: Vec<GrandparentEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GrandparentEntry {
    txid: String,
    output_index: u32,
    txraw: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AncestryReference {
    txid: String,
    output_index: u32,
    input_index: usize,
}

#[derive(Serialize)]
struct InspectResponse {
    items: Vec<InspectResponseItem>,
}

#[derive(Serialize)]
struct InspectResponseItem {
    references: Vec<AncestryReference>,
}

#[derive(Serialize)]
struct ProofResponse {
    items: Vec<ProofResponseItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProofResponseItem {
    pre_pre_tx_data: String,
}

fn parse_parent(
    parent_txid: &str,
    parent_txraw: &str,
    index: usize,
) -> Result<Transaction, String> {
    let parent = Transaction::from_hex(parent_txraw)
        .map_err(|error| format!("items[{index}].parentTxraw: {error}"))?;
    if parent.txid().to_string() != parent_txid.to_lowercase() {
        return Err(format!("items[{index}] parent txid mismatch"));
    }
    Ok(parent)
}

fn inspect_parent(
    parent: &Transaction,
    output_index: u32,
    index: usize,
) -> Result<Vec<AncestryReference>, String> {
    let tape_index = usize::try_from(output_index)
        .map_err(|_| format!("items[{index}].outputIndex is invalid"))?
        .checked_add(1)
        .ok_or_else(|| format!("items[{index}].outputIndex is invalid"))?;
    let tape_output = parent
        .outputs
        .get(tape_index)
        .ok_or_else(|| format!("items[{index}] parent Tape output is missing"))?;
    if tape_output.satoshis != 0 {
        return Err(format!(
            "items[{index}] parent Tape output must contain zero satoshis"
        ));
    }
    let tape = tape_output.script_pubkey.as_bytes();
    if tape.len() < TAPE_MINIMUM_LENGTH
        || !tape.starts_with(&TAPE_PREFIX)
        || !tape.ends_with(TAPE_MARKER)
    {
        return Err(format!(
            "items[{index}] parent Tape must be OP_FALSE OP_RETURN with a 48-byte amount push and FTape marker"
        ));
    }
    let tape_end = TAPE_PREFIX_LENGTH + TAPE_AMOUNT_LENGTH;
    let amounts = tape
        .get(TAPE_PREFIX_LENGTH..tape_end)
        .ok_or_else(|| format!("items[{index}] parent Tape output is malformed"))?;
    let mut references = Vec::new();
    for input_index in (0..TAPE_SLOT_COUNT).rev() {
        let start = input_index * TAPE_SLOT_LENGTH;
        if amounts[start..start + TAPE_SLOT_LENGTH]
            .iter()
            .all(|byte| *byte == 0)
        {
            continue;
        }
        let input = parent.inputs.get(input_index).ok_or_else(|| {
            format!("items[{index}] parent Tape references missing input index {input_index}")
        })?;
        references.push(AncestryReference {
            txid: input.previous_output.txid.to_string(),
            output_index: input.previous_output.vout,
            input_index,
        });
    }
    if references.is_empty() {
        return Err(format!(
            "items[{index}] parent Tape does not reference any source input"
        ));
    }
    Ok(references)
}

fn inspect_items(items: Vec<ParentEntry>) -> Result<String, String> {
    let response = items
        .into_iter()
        .enumerate()
        .map(|(index, item)| {
            let parent = parse_parent(&item.parent_txid, &item.parent_txraw, index)?;
            Ok(InspectResponseItem {
                references: inspect_parent(&parent, item.output_index, index)?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    serde_json::to_string(&InspectResponse { items: response }).map_err(|error| error.to_string())
}

fn prove_items(items: Vec<ProofEntry>) -> Result<String, String> {
    let response = items
        .into_iter()
        .enumerate()
        .map(|(index, item)| {
            let parent = parse_parent(&item.parent_txid, &item.parent_txraw, index)?;
            let references = inspect_parent(&parent, item.output_index, index)?;
            if references.len() != item.grandparents.len() {
                return Err(format!(
                    "items[{index}] grandparent count does not match parent references"
                ));
            }
            let mut proof = vec![0x57];
            for (grandparent_index, (reference, supplied)) in references
                .iter()
                .zip(item.grandparents.iter())
                .enumerate()
            {
                let grandparent = Transaction::from_hex(&supplied.txraw).map_err(|error| {
                    format!(
                        "items[{index}].grandparents[{grandparent_index}].txraw: {error}"
                    )
                })?;
                if grandparent.txid().to_string() != supplied.txid.to_lowercase() {
                    return Err(format!(
                        "items[{index}].grandparents[{grandparent_index}] grandparent txid mismatch"
                    ));
                }
                if supplied.txid.to_lowercase() != reference.txid
                    || supplied.output_index != reference.output_index
                {
                    return Err(format!(
                        "items[{index}].grandparents[{grandparent_index}] does not match parent reference"
                    ));
                }
                proof.extend_from_slice(
                    &pre_pre_tx_data(&grandparent, supplied.output_index as usize)
                        .map_err(|error| {
                            format!(
                                "items[{index}].grandparents[{grandparent_index}]: {error}"
                            )
                        })?,
                );
            }
            Ok(ProofResponseItem {
                pre_pre_tx_data: hex::encode(proof),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    serde_json::to_string(&ProofResponse { items: response }).map_err(|error| error.to_string())
}

pub fn prepare_asset_ancestry_json(request_json: &str) -> Result<String, String> {
    let request: AssetAncestryRequest = serde_json::from_str(request_json)
        .map_err(|error| format!("invalid asset ancestry request: {error}"))?;
    match request {
        AssetAncestryRequest::Inspect { items } => inspect_items(items),
        AssetAncestryRequest::Prove { items } => prove_items(items),
    }
}
