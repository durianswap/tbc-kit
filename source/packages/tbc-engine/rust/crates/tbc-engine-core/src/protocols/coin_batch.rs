//! Coin holder maintenance over one immutable snapshot. Every transaction still
//! uses the pinned five-Coin-plus-one-fee builder. Preview IDs are never spend
//! IDs: existing typed Planned sources bind the real signed predecessors.
use super::{
    coin,
    coin_proof::{inspect_parent, ParentMaterial},
    coin_transfer::{
        build_merge_plan, build_transfer_plan, CoinInput, FeeInput, Receiver, TransferOptions,
    },
    tbc20_batch::BatchPlan,
};
use crate::{
    signing::{
        bind_funding_recipe, materialize_unsigned_preview, remap_fungible_evidence, UnsignedPlan,
    },
    EngineError, ErrorCode,
};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use tbc_sdk::{script::Script, OutPoint, PublicKey, TxOut};

pub struct BatchOptions<'a> {
    pub transfer: TransferOptions<'a>,
    pub max_transactions: usize,
}
struct Token {
    parent: ParentMaterial,
    ancestors: Vec<Vec<u8>>,
    key: PublicKey,
}
struct Fee {
    point: OutPoint,
    output: TxOut,
    key: PublicKey,
}
struct Preview {
    raw: String,
    id: String,
}
fn invalid(message: &str) -> EngineError {
    EngineError {
        code: ErrorCode::InvalidPlan,
        message: message.into(),
        path: None,
    }
}
fn limit(max: usize) -> EngineError {
    EngineError {
        code: ErrorCode::InvalidInput,
        message: if max == 1 {
            "Coin inputs require maintenance but policy permits only one transaction"
        } else {
            "Coin maintenance exceeds policy bundle transaction limit"
        }
        .into(),
        path: Some("policy.payload.maxBundleTransactions".into()),
    }
}

pub fn build_batch_transfer_plan(options: BatchOptions<'_>) -> Result<BatchPlan, EngineError> {
    build(options, false)
}
pub fn build_batch_merge_plan(options: BatchOptions<'_>) -> Result<BatchPlan, EngineError> {
    build(options, true)
}
fn build(options: BatchOptions<'_>, merge: bool) -> Result<BatchPlan, EngineError> {
    let original = options.transfer;
    if original.inputs.is_empty() || original.inputs.len() > 128 {
        return Err(invalid("Coin batch requires 1..128 selected token inputs"));
    }
    if options.max_transactions == 0 {
        return Err(limit(0));
    }
    if merge && (original.additional_payment.is_some() || original.additional_info.is_some()) {
        return Err(invalid(
            "Coin merge cannot include a payment or additional data",
        ));
    }
    if original.inputs.len() <= 5 {
        let owner = original.token_change_controller;
        let p = if merge {
            build_merge_plan(original, owner)?
        } else {
            build_transfer_plan(original)?
        };
        return Ok(BatchPlan {
            unsigned_plan: p.unsigned_plan,
            token_outputs: p.token_outputs,
            fees: vec![p.fee],
            maximum_signed_bytes: vec![p.maximum_signed_bytes],
        });
    }
    if options.max_transactions == 1 {
        return Err(limit(1));
    }
    let owner = original
        .inputs
        .iter()
        .map(|i| i.public_key)
        .find(|key| {
            let mut c = [0; 21];
            c[..20].copy_from_slice(&key.hash160());
            c == original.token_change_controller
        })
        .ok_or_else(|| invalid("Coin maintenance change must belong to a supplied holder"))?
        .clone();
    let mut seen = BTreeSet::new();
    for point in original
        .inputs
        .iter()
        .map(|i| i.parent.selected())
        .chain(std::iter::once(&original.fee_input.outpoint))
    {
        if !seen.insert((point.txid.to_string(), point.vout)) {
            return Err(invalid("Coin batch repeats an original outpoint"));
        }
    }
    let mut queue: VecDeque<_> = original
        .inputs
        .iter()
        .map(|i| Token {
            parent: i.parent.clone(),
            ancestors: i.ancestor_raws.iter().map(|b| b.to_vec()).collect(),
            key: i.public_key.clone(),
        })
        .collect();
    let mut fee = Fee {
        point: original.fee_input.outpoint.clone(),
        output: original.fee_input.output.clone(),
        key: original.fee_input.public_key.clone(),
    };
    let mut aggregate = BatchPlan {
        unsigned_plan: UnsignedPlan {
            transactions: vec![],
            evidence_table: vec![],
        },
        token_outputs: vec![],
        fees: vec![],
        maximum_signed_bytes: vec![],
    };
    let mut previews = BTreeMap::<String, Preview>::new();
    let mut evidence = BTreeMap::<String, u32>::new();
    let mut total_fee = 0u64;
    loop {
        if aggregate.fees.len() >= options.max_transactions {
            return Err(limit(options.max_transactions));
        }
        let last = queue.len() <= 5;
        let selected: Vec<_> = queue.drain(..queue.len().min(5)).collect();
        let raw_refs: Vec<Vec<_>> = selected
            .iter()
            .map(|t| t.ancestors.iter().map(Vec::as_slice).collect())
            .collect();
        let inputs: Vec<_> = selected
            .iter()
            .zip(&raw_refs)
            .map(|(t, raws)| CoinInput {
                parent: &t.parent,
                ancestor_raws: raws,
                public_key: &t.key,
            })
            .collect();
        let fee_input = FeeInput {
            outpoint: fee.point.clone(),
            output: &fee.output,
            public_key: &fee.key,
        };
        let own = [Receiver {
            controller: original.token_change_controller,
            amount: inputs.iter().map(|i| i.parent.tape().balance).sum(),
        }];
        let round_options = TransferOptions {
            inputs: &inputs,
            fee_input: &fee_input,
            receivers: if last && !merge {
                original.receivers
            } else {
                &own
            },
            expected_identity: original.expected_identity,
            token_change_controller: original.token_change_controller,
            additional_payment: if last && !merge {
                original.additional_payment
            } else {
                None
            },
            additional_info: if last && !merge {
                original.additional_info
            } else {
                None
            },
            max_fee: original.max_fee - total_fee,
        };
        let mut round = if last && !merge {
            build_transfer_plan(round_options)?
        } else {
            build_merge_plan(round_options, original.token_change_controller)?
        };
        if !last && round.token_outputs.len() >= selected.len() {
            return Err(invalid(
                "Coin amount-slot capacity prevents a reducing maintenance round",
            ));
        }
        let preview = materialize_unsigned_preview(
            &round.unsigned_plan.transactions[0],
            &round.unsigned_plan,
        )?;
        let preview_id = preview.txid().to_string();
        if previews.contains_key(&preview_id) {
            return Err(invalid("Coin maintenance preview collision"));
        }
        let id = if last {
            if merge {
                "tbc20-stablecoin-merge".to_owned()
            } else {
                "tbc20-stablecoin-transfer".to_owned()
            }
        } else {
            format!("tbc20-stablecoin-maintenance-{}", aggregate.fees.len())
        };
        let mut indices = BTreeMap::new();
        for (i, entry) in round.unsigned_plan.evidence_table.iter().enumerate() {
            if let Some(prior) = previews.get(&entry.txid) {
                if entry.raw_transaction != prior.raw {
                    return Err(invalid("Coin planned evidence differs from its preview"));
                }
                continue;
            }
            let global = if let Some(&n) = evidence.get(&entry.txid) {
                if aggregate.unsigned_plan.evidence_table[n as usize] != *entry {
                    return Err(invalid("conflicting immutable Coin evidence"));
                }
                n
            } else {
                let n = aggregate.unsigned_plan.evidence_table.len() as u32;
                aggregate.unsigned_plan.evidence_table.push(entry.clone());
                evidence.insert(entry.txid.clone(), n);
                n
            };
            indices.insert(i as u32, global);
        }
        let transaction = &mut round.unsigned_plan.transactions[0];
        transaction.transaction_id = id.clone();
        if !last {
            transaction.role = "maintenance".into();
        }
        let mut dependencies = Vec::new();
        for input in &mut transaction.inputs {
            if let Some(prior) = previews.get(&input.previous_transaction_id) {
                input.previous_transaction_id = prior.id.clone();
                if !dependencies.contains(&prior.id) {
                    dependencies.push(prior.id.clone());
                }
            }
            if input.unlocking_script.is_empty() {
                continue;
            }
            for (txid, prior) in &previews {
                let local: Vec<_> = round
                    .unsigned_plan
                    .evidence_table
                    .iter()
                    .enumerate()
                    .filter(|(_, e)| &e.txid == txid)
                    .map(|(i, _)| i as u32)
                    .collect();
                input.unlocking_script =
                    bind_funding_recipe(&input.unlocking_script, &prior.raw, &local, &prior.id)?;
            }
            input.unlocking_script = remap_fungible_evidence(&input.unlocking_script, &indices)?;
        }
        transaction.depends_on = dependencies;
        transaction.stage = transaction
            .depends_on
            .iter()
            .map(|id| {
                aggregate
                    .unsigned_plan
                    .transactions
                    .iter()
                    .find(|t| &t.transaction_id == id)
                    .map(|t| t.stage + 1)
                    .ok_or_else(|| invalid("Coin maintenance dependency missing"))
            })
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .max()
            .unwrap_or(0);
        total_fee = total_fee
            .checked_add(round.fee)
            .ok_or_else(|| invalid("Coin batch fee overflow"))?;
        aggregate.fees.push(round.fee);
        aggregate
            .maximum_signed_bytes
            .push(round.maximum_signed_bytes);
        aggregate
            .unsigned_plan
            .transactions
            .push(round.unsigned_plan.transactions.remove(0));
        if last {
            aggregate.token_outputs = round.token_outputs;
            return Ok(aggregate);
        }
        let mut ancestors = BTreeMap::new();
        for token in &selected {
            ancestors.insert(
                token.parent.selected().txid.to_string(),
                token.parent.transaction().serialize(),
            );
        }
        let raw = preview.serialize();
        let mut created = 0;
        let mut next_fee = None;
        for (vout, output) in preview.outputs.iter().enumerate() {
            if coin::parse_code(output.script_pubkey.as_bytes()).is_ok() {
                let parent = inspect_parent(
                    &raw,
                    &OutPoint {
                        txid: preview.txid(),
                        vout: vout as u32,
                    },
                    Some(original.expected_identity),
                )?;
                let required: BTreeSet<_> = parent
                    .dependencies()
                    .iter()
                    .map(|p| p.txid.to_string())
                    .collect();
                let raws = required
                    .iter()
                    .map(|id| {
                        ancestors
                            .get(id)
                            .cloned()
                            .ok_or_else(|| invalid("Coin maintenance ancestor closure incomplete"))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                queue.push_back(Token {
                    parent,
                    ancestors: raws,
                    key: owner.clone(),
                });
                created += 1;
            } else if output.script_pubkey == Script::p2pkh(&fee.key.hash160()) {
                if next_fee.is_some() {
                    return Err(invalid("Coin maintenance has multiple fee change outputs"));
                }
                next_fee = Some(Fee {
                    point: OutPoint {
                        txid: preview.txid(),
                        vout: vout as u32,
                    },
                    output: output.clone(),
                    key: fee.key.clone(),
                });
            } else if output.satoshis != 0
                || coin::parse_tape(output.script_pubkey.as_bytes(), None).is_err()
            {
                return Err(invalid("unknown Coin maintenance output"));
            }
        }
        if created != round.token_outputs.len() {
            return Err(invalid(
                "Coin maintenance output count differs from allocation",
            ));
        }
        fee = next_fee.ok_or_else(|| invalid("Coin maintenance fee change missing"))?;
        previews.insert(
            preview_id,
            Preview {
                raw: preview.to_hex(),
                id,
            },
        );
    }
}
