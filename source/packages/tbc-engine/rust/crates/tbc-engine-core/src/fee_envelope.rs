use crate::model::error;
use crate::signing::{SignedBundle, UnsignedPlan, maximum_signed_transaction_sizes};
use crate::{EngineError, ErrorCode};
use tbc_sdk::Transaction;

const MAX_P2PKH_SCRIPT_SIG_BYTES: usize = 107;

pub(crate) fn p2pkh_max_signed_size(
    input_count: usize,
    output_count: usize,
) -> Result<usize, EngineError> {
    4usize
        .checked_add(compact_size_len(input_count))
        .and_then(|value| value.checked_add(input_count.checked_mul(41)?))
        .and_then(|value| value.checked_add(compact_size_len(output_count)))
        .and_then(|value| value.checked_add(output_count.checked_mul(34)?))
        .and_then(|value| value.checked_add(4))
        .and_then(|value| value.checked_add(input_count.checked_mul(MAX_P2PKH_SCRIPT_SIG_BYTES)?))
        .ok_or_else(|| error(ErrorCode::InvalidInput, "transaction size overflow", "plan"))
}

pub(crate) fn fee_for_size(size: usize, fee_rate_sat_per_kb: u64) -> Result<u64, EngineError> {
    let bytes = u64::try_from(size)
        .map_err(|_| error(ErrorCode::InvalidInput, "transaction size exceeds uint64", "plan"))?;
    let proportional = bytes
        .checked_mul(fee_rate_sat_per_kb)
        .and_then(|value| value.checked_add(999))
        .map(|value| value / 1_000)
        .ok_or_else(|| {
            error(
                ErrorCode::InvalidInput,
                "fee calculation overflow",
                "policy.payload.feeRateSatPerKb",
            )
        })?;
    Ok(proportional.max(fee_rate_sat_per_kb))
}

pub(crate) fn verify_final_fee_envelopes(
    plan: &UnsignedPlan,
    finalized: &SignedBundle,
    planned_paid_fees: &[u64],
    fee_rate_sat_per_kb: u64,
) -> Result<(), EngineError> {
    if planned_paid_fees.len() != plan.transactions.len()
        || finalized.transactions.len() != plan.transactions.len()
    {
        return Err(error(
            ErrorCode::InvalidPlan,
            "fee envelope transaction count does not match the plan",
            "plan.payload.transactions",
        ));
    }
    let maximum_sizes = maximum_signed_transaction_sizes(plan)?;
    for (index, planned) in plan.transactions.iter().enumerate() {
        let path = format!("plan.payload.transactions[{index}].fee");
        let signed = finalized
            .transactions
            .iter()
            .find(|transaction| transaction.transaction_id == planned.transaction_id)
            .ok_or_else(|| {
                error(
                    ErrorCode::InvalidPlan,
                    "fee envelope is missing a signed transaction",
                    &path,
                )
            })?;
        let transaction = Transaction::from_hex(&signed.raw_transaction).map_err(|_| {
            error(
                ErrorCode::InvalidSignature,
                "signed transaction is not valid transaction hex",
                "signatures",
            )
        })?;
        let actual_size = transaction.serialize().len();
        let maximum_size = maximum_sizes[index];
        if actual_size > maximum_size {
            return Err(error(
                ErrorCode::InvalidSignature,
                "signed transaction exceeds the approved fee envelope",
                "signatures",
            ));
        }
        let required_upper_bound = fee_for_size(maximum_size, fee_rate_sat_per_kb)?;
        let required_actual_fee = fee_for_size(actual_size, fee_rate_sat_per_kb)?;
        let planned_paid_fee = planned_paid_fees[index];
        let residual = planned_paid_fee.checked_sub(required_upper_bound).ok_or_else(|| {
            error(
                ErrorCode::InvalidPlan,
                "planned fee is below the approved fee envelope",
                &path,
            )
        })?;
        let actual_overpayment = planned_paid_fee.checked_sub(required_actual_fee).ok_or_else(|| {
            error(
                ErrorCode::InvalidSignature,
                "signed transaction fee is below the required fee",
                "signatures",
            )
        })?;
        let allowed_overpayment = required_upper_bound
            .checked_sub(required_actual_fee)
            .and_then(|headroom| headroom.checked_add(residual))
            .ok_or_else(|| {
                error(
                    ErrorCode::InvalidPlan,
                    "fee envelope arithmetic is inconsistent",
                    &path,
                )
            })?;
        if actual_overpayment > allowed_overpayment {
            return Err(error(
                ErrorCode::InvalidSignature,
                "signed transaction fee exceeds the approved fee envelope",
                "signatures",
            ));
        }
    }
    Ok(())
}

pub(crate) fn reconcile_plan_fee_envelopes(
    plan: &mut UnsignedPlan,
    planned_paid_fees: &mut [u64],
    fee_rate_sat_per_kb: u64,
    account_change_script: &str,
) -> Result<Vec<bool>, EngineError> {
    if planned_paid_fees.len() != plan.transactions.len() {
        return Err(error(
            ErrorCode::InvalidPlan,
            "fee envelope transaction count does not match the plan",
            "plan.payload.transactions",
        ));
    }
    let mut changed_transactions = vec![false; plan.transactions.len()];
    let mut maximum_sizes = maximum_signed_transaction_sizes(plan).map_err(|source| {
        error(
            source.code,
            format!("initial fee envelope materialization failed: {}", source.message),
            source.path.as_deref().unwrap_or("plan"),
        )
    })?;
    for index in 0..plan.transactions.len() {
        let path = format!("plan.payload.transactions[{index}].fee");
        let input_sum = plan.transactions[index]
            .inputs
            .iter()
            .try_fold(0u64, |sum, input| sum.checked_add(input.previous_output_satoshis))
            .ok_or_else(|| {
                error(ErrorCode::InvalidPlan, "planned input sum overflows uint64", &path)
            })?;
        let output_sum = plan.transactions[index]
            .outputs
            .iter()
            .try_fold(0u64, |sum, output| sum.checked_add(output.satoshis))
            .ok_or_else(|| {
                error(ErrorCode::InvalidPlan, "planned output sum overflows uint64", &path)
            })?;
        let paid_fee = input_sum.checked_sub(output_sum).ok_or_else(|| {
            error(ErrorCode::InvalidPlan, "planned outputs exceed inputs", &path)
        })?;
        if paid_fee != planned_paid_fees[index] {
            return Err(error(
                ErrorCode::InvalidPlan,
                "planned fee does not match transaction value conservation",
                &path,
            ));
        }
        let required_fee = fee_for_size(maximum_sizes[index], fee_rate_sat_per_kb)?;
        if paid_fee >= required_fee {
            continue;
        }
        let deficit = required_fee.checked_sub(paid_fee).ok_or_else(|| {
            error(ErrorCode::InvalidPlan, "fee envelope subtraction underflow", &path)
        })?;
        let transaction_id = plan.transactions[index].transaction_id.clone();
        let change_vout = plan.transactions[index]
            .outputs
            .len()
            .checked_sub(1)
            .ok_or_else(|| {
                error(
                    ErrorCode::InsufficientFunds,
                    "transaction has no account change to fund its fee envelope",
                    "snapshot.payload.utxos",
                )
            })?;
        if plan.transactions[index].outputs[change_vout].locking_script != account_change_script {
            return Err(error(
                ErrorCode::InsufficientFunds,
                "transaction has no account change to fund its fee envelope",
                "snapshot.payload.utxos",
            ));
        }
        let previous_change = plan.transactions[index].outputs[change_vout].satoshis;
        let adjusted_change = previous_change.checked_sub(deficit).ok_or_else(|| {
            error(
                ErrorCode::InsufficientFunds,
                "account change cannot fund the transaction fee envelope",
                "snapshot.payload.utxos",
            )
        })?;
        let change_vout = u32::try_from(change_vout).map_err(|_| {
            error(ErrorCode::InvalidPlan, "change output index exceeds uint32", &path)
        })?;
        if adjusted_change < tbc_sdk::SDK_DUST_SAT {
            let required_successor = plan.transactions.iter().skip(index + 1).any(|dependent| {
                dependent.inputs.iter().any(|input| {
                    input.previous_transaction_id == transaction_id
                        && input.previous_output_index == change_vout
                })
            });
            if required_successor {
                return Err(error(
                    ErrorCode::InsufficientFunds,
                    "account change cannot fund the transaction fee envelope",
                    "snapshot.payload.utxos",
                ));
            }
            plan.transactions[index].outputs.pop();
            changed_transactions[index] = true;
            let no_change_paid = paid_fee.checked_add(previous_change).ok_or_else(|| {
                error(ErrorCode::InvalidPlan, "no-change fee overflows uint64", &path)
            })?;
            maximum_sizes = maximum_signed_transaction_sizes(plan).map_err(|source| {
                error(
                    source.code,
                    format!("no-change fee envelope materialization failed: {}", source.message),
                    source.path.as_deref().unwrap_or("plan"),
                )
            })?;
            let no_change_required =
                fee_for_size(maximum_sizes[index], fee_rate_sat_per_kb)?;
            if no_change_paid < no_change_required {
                return Err(error(
                    ErrorCode::InsufficientFunds,
                    "no-change transaction cannot fund its fee envelope",
                    "snapshot.payload.utxos",
                ));
            }
            planned_paid_fees[index] = no_change_paid;
            continue;
        }
        plan.transactions[index].outputs[change_vout as usize].satoshis = adjusted_change;
        changed_transactions[index] = true;
        planned_paid_fees[index] = required_fee;
        propagate_fee_successor_delta(
            plan,
            planned_paid_fees,
            &mut changed_transactions,
            index,
            &transaction_id,
            change_vout,
            deficit,
            account_change_script,
        )?;
    }
    Ok(changed_transactions)
}

fn propagate_fee_successor_delta(
    plan: &mut UnsignedPlan,
    planned_paid_fees: &mut [u64],
    changed_transactions: &mut [bool],
    parent_index: usize,
    parent_id: &str,
    parent_vout: u32,
    delta: u64,
    account_change_script: &str,
) -> Result<(), EngineError> {
    for dependent_index in parent_index + 1..plan.transactions.len() {
        let consumes_successor = plan.transactions[dependent_index].inputs.iter().any(|input| {
            input.previous_transaction_id == parent_id
                && input.previous_output_index == parent_vout
        });
        if !consumes_successor {
            continue;
        }
        changed_transactions[dependent_index] = true;
        for input in &mut plan.transactions[dependent_index].inputs {
            if input.previous_transaction_id == parent_id
                && input.previous_output_index == parent_vout
            {
                input.previous_output_satoshis = input
                    .previous_output_satoshis
                    .checked_sub(delta)
                    .ok_or_else(|| {
                        error(
                            ErrorCode::InvalidPlan,
                            "fee-successor input adjustment underflows",
                            "plan",
                        )
                    })?;
            }
        }

        let last_vout = plan.transactions[dependent_index].outputs.len().checked_sub(1);
        let has_change = last_vout.is_some_and(|vout| {
            plan.transactions[dependent_index].outputs[vout].locking_script
                == account_change_script
        });
        if has_change {
            let last_vout = last_vout.expect("checked account change output");
            let adjusted = plan.transactions[dependent_index].outputs[last_vout]
                .satoshis
                .checked_sub(delta)
                .ok_or_else(|| {
                    error(
                        ErrorCode::InsufficientFunds,
                        "fee-successor change cannot preserve dependent funding",
                        "snapshot.payload.utxos",
                    )
                })?;
            if adjusted < tbc_sdk::SDK_DUST_SAT {
                return Err(error(
                    ErrorCode::InsufficientFunds,
                    "fee-successor change cannot preserve dependent funding",
                    "snapshot.payload.utxos",
                ));
            }
            plan.transactions[dependent_index].outputs[last_vout].satoshis = adjusted;
            let dependent_id = plan.transactions[dependent_index].transaction_id.clone();
            let wire_vout = u32::try_from(last_vout).map_err(|_| {
                error(ErrorCode::InvalidPlan, "change output index exceeds uint32", "plan")
            })?;
            propagate_fee_successor_delta(
                plan,
                planned_paid_fees,
                changed_transactions,
                dependent_index,
                &dependent_id,
                wire_vout,
                delta,
                account_change_script,
            )?;
        } else {
            planned_paid_fees[dependent_index] = planned_paid_fees[dependent_index]
                .checked_sub(delta)
                .ok_or_else(|| {
                    error(
                        ErrorCode::InsufficientFunds,
                        "fee-successor input cannot preserve dependent outputs",
                        "snapshot.payload.utxos",
                    )
                })?;
        }
    }
    Ok(())
}

fn compact_size_len(value: usize) -> usize {
    match value {
        0..=252 => 1,
        253..=0xffff => 3,
        0x1_0000..=0xffff_ffff => 5,
        _ => 9,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        fee_for_size, p2pkh_max_signed_size, reconcile_plan_fee_envelopes,
        verify_final_fee_envelopes,
    };
    use crate::ErrorCode;
    use crate::signing::{
        PlannedInput, PlannedOutput, PlannedTransaction, PublicSigningContext, SignedBundle,
        SignedTransaction, UnsignedPlan, maximum_signed_transaction_sizes,
    };
    use tbc_sdk::{OutPoint, Transaction, TxIn, TxOut, Txid, script::Script};

    #[test]
    fn seven_input_p2pkh_shapes_have_independent_conservative_bounds() {
        assert_eq!(p2pkh_max_signed_size(7, 1).unwrap(), 1_080);
        assert_eq!(p2pkh_max_signed_size(7, 2).unwrap(), 1_114);
        assert_eq!(fee_for_size(1_080, 1_000).unwrap(), 1_080);
        assert_eq!(fee_for_size(1_114, 1_000).unwrap(), 1_114);
    }

    #[test]
    fn finalized_p2pkh_transaction_cannot_exceed_the_committed_shape_bound() {
        let plan = p2pkh_plan();
        let finalized = Transaction {
            version: tbc_sdk::TX_VERSION,
            inputs: vec![TxIn {
                previous_output: OutPoint {
                    txid: Txid::from_le_bytes([0x11; 32]),
                    vout: 0,
                },
                script_sig: Script::from_bytes(vec![0; 109]),
                sequence: tbc_sdk::DEFAULT_SEQUENCE,
            }],
            outputs: vec![TxOut {
                satoshis: 9_000,
                script_pubkey: Script::from_bytes(vec![0; 25]),
            }],
            lock_time: tbc_sdk::DEFAULT_LOCK_TIME,
        };
        let bundle = SignedBundle {
            transactions: vec![SignedTransaction {
                transaction_id: "primary".to_owned(),
                role: "primary".to_owned(),
                txid: finalized.txid().to_string(),
                raw_transaction: finalized.to_hex(),
            }],
        };

        let error = verify_final_fee_envelopes(&plan, &bundle, &[1_000], 80).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidSignature);
        assert_eq!(error.path.as_deref(), Some("signatures"));
    }

    #[test]
    fn maximum_signed_size_is_materialized_from_the_signing_plan() {
        assert_eq!(maximum_signed_transaction_sizes(&p2pkh_plan()).unwrap(), vec![192]);
    }

    #[test]
    fn finalized_bundle_rejects_a_planned_fee_below_its_materialized_upper_bound() {
        let plan = p2pkh_plan();
        let finalized = Transaction {
            version: tbc_sdk::TX_VERSION,
            inputs: vec![TxIn {
                previous_output: OutPoint {
                    txid: Txid::from_le_bytes([0x11; 32]),
                    vout: 0,
                },
                script_sig: Script::from_bytes(vec![0; 107]),
                sequence: tbc_sdk::DEFAULT_SEQUENCE,
            }],
            outputs: vec![TxOut {
                satoshis: 9_000,
                script_pubkey: Script::from_bytes(vec![
                    0x76, 0xa9, 0x14, 0x79, 0xb0, 0x00, 0x88, 0x76, 0x26, 0xb2, 0x94,
                    0xa9, 0x14, 0x50, 0x1a, 0x4c, 0xd2, 0x26, 0xb5, 0x8b, 0x23, 0x59,
                    0x83, 0x88, 0xac,
                ]),
            }],
            lock_time: tbc_sdk::DEFAULT_LOCK_TIME,
        };
        let bundle = SignedBundle {
            transactions: vec![SignedTransaction {
                transaction_id: "primary".to_owned(),
                role: "primary".to_owned(),
                txid: finalized.txid().to_string(),
                raw_transaction: finalized.to_hex(),
            }],
        };

        let error = verify_final_fee_envelopes(&plan, &bundle, &[79], 80).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidPlan);
        assert_eq!(error.path.as_deref(), Some("plan.payload.transactions[0].fee"));
    }

    #[test]
    fn reconciliation_funds_the_materialized_bound_only_from_account_change() {
        let mut plan = p2pkh_plan();
        let owner_script = plan.transactions[0].outputs[0].locking_script.clone();
        plan.transactions[0].outputs.push(PlannedOutput {
            satoshis: 980,
            locking_script: owner_script.clone(),
        });
        let mut fees = vec![20];

        reconcile_plan_fee_envelopes(&mut plan, &mut fees, 80, &owner_script).unwrap();

        assert_eq!(fees, vec![80]);
        assert_eq!(plan.transactions[0].outputs[0].satoshis, 9_000);
        assert_eq!(plan.transactions[0].outputs[1].satoshis, 920);
        assert_eq!(
            fees[0]
                + plan.transactions[0]
                    .outputs
                    .iter()
                    .map(|output| output.satoshis)
                    .sum::<u64>(),
            10_000,
        );
    }

    #[test]
    fn reconciliation_drops_optional_change_at_the_exact_no_change_boundary() {
        let mut plan = p2pkh_plan();
        let owner_script = plan.transactions[0].outputs[0].locking_script.clone();
        plan.transactions[0].outputs.push(PlannedOutput {
            satoshis: 980,
            locking_script: owner_script.clone(),
        });
        let mut fees = vec![20];

        reconcile_plan_fee_envelopes(&mut plan, &mut fees, 1_000, &owner_script).unwrap();

        assert_eq!(fees, vec![1_000]);
        assert_eq!(plan.transactions[0].outputs.len(), 1);
        assert_eq!(plan.transactions[0].outputs[0].satoshis, 9_000);
    }

    fn p2pkh_plan() -> UnsignedPlan {
        let owner_script = "76a91479b000887626b294a914501a4cd226b58b23598388ac";
        UnsignedPlan {
            evidence_table: Vec::new(),
            transactions: vec![PlannedTransaction {
                transaction_id: "primary".to_owned(),
                role: "primary".to_owned(),
                stage: 0,
                depends_on: Vec::new(),
                version: tbc_sdk::TX_VERSION,
                inputs: vec![PlannedInput {
                    previous_transaction_id: "11".repeat(32),
                    previous_output_index: 0,
                    previous_output_script: owner_script.to_owned(),
                    previous_output_satoshis: 10_000,
                    sequence: tbc_sdk::DEFAULT_SEQUENCE,
                    unlocking_script: String::new(),
                    signer: PublicSigningContext {
                        address: "1C6Rc3w25VHud3dLDamutaqfKWqhrLRTaD".to_owned(),
                        public_key:
                            "031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f"
                                .to_owned(),
                        public_key_hash: "79b000887626b294a914501a4cd226b58b235983"
                            .to_owned(),
                    },
                }],
                outputs: vec![PlannedOutput {
                    satoshis: 9_000,
                    locking_script: owner_script.to_owned(),
                }],
                lock_time: tbc_sdk::DEFAULT_LOCK_TIME,
            }],
        }
    }
}
