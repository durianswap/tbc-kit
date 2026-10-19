use std::collections::HashSet;

use crate::{
    Address, DEFAULT_FEE_RATE_SAT_PER_KB, DEFAULT_SIGHASH, Error, PrivateKey, Result, SDK_DUST_SAT,
    Transaction, TxIn, TxOut, Utxo,
    builder::{ChangePolicy, finalize_signed_fee, paid_fee},
};

use super::{
    TBC20_AMOUNT_SLOTS, TBC20_CODE_SATOSHIS, TBC20_MAX_INPUTS, TBC20_MAX_OUTPUT_GROUPS,
    TBC20_MAX_OUTPUTS, TBC20_MAX_SLOT_AMOUNT, TBC20_TAPE_SATOSHIS, Tbc20, Tbc20Outpoint,
    Tbc20OutputGroup, build_tbc20_tape, build_tbc20_unlock_script, instantiate_tbc20_code,
    parse_tbc20_tape, replace_tbc20_controller, replace_tbc20_tape_amounts,
    tbc20_address_controller, tbc20_code_identity, tbc20_controller, tbc20_human_to_raw,
    validate_tbc20_code,
};

#[derive(Clone, Debug)]
pub struct Tbc20Spend {
    pub parent: Transaction,
    pub code_vout: usize,
    pub ancestors: Vec<Transaction>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tbc20TokenOutput {
    pub code_vout: usize,
    pub tape_vout: usize,
    pub amount_raw: u128,
    pub amounts_by_input: [u64; TBC20_AMOUNT_SLOTS],
    pub controller: [u8; 21],
}

#[derive(Clone, Debug)]
pub struct Tbc20BuildResult {
    pub transaction: Transaction,
    pub fee_satoshis: u64,
    pub token_outputs: Vec<Tbc20TokenOutput>,
    pub output_groups: Vec<Tbc20OutputGroup>,
}

#[derive(Clone, Debug)]
pub struct Tbc20MintResult {
    pub build: Tbc20BuildResult,
    pub source_transaction: Transaction,
    pub source_fee_satoshis: u64,
    pub original_utxo: Tbc20Outpoint,
}

#[derive(Clone)]
struct ValidatedInput {
    parent: Transaction,
    code_vout: usize,
    ancestors: Vec<Transaction>,
    balance: u128,
    code: crate::script::Script,
    tape: crate::script::Script,
    controller: [u8; 21],
    identity: Vec<u8>,
}

#[derive(Clone, Debug)]
struct OutputPlan {
    controller: [u8; 21],
    amount: u128,
    slots: [u64; TBC20_AMOUNT_SLOTS],
}

impl Tbc20 {
    pub fn mint(
        &mut self,
        private_key: &PrivateKey,
        recipient: &Address,
        funding: &Utxo,
    ) -> Result<Tbc20MintResult> {
        let supply = self
            .declared_supply_raw
            .ok_or_else(|| invalid("mint requires constructor metadata with declared supply"))?;
        if self.code_script.is_some() || self.tape_script.is_some() || self.contract_txid.is_some()
        {
            return Err(invalid("mint requires an uninitialized token"));
        }
        assert_p2pkh_owner(funding, private_key, "funding UTXO")?;
        if funding.satoshis <= DEFAULT_FEE_RATE_SAT_PER_KB {
            return Err(invalid("funding UTXO is too small for source fee"));
        }

        let source_value = funding.satoshis - DEFAULT_FEE_RATE_SAT_PER_KB;
        let mut source = Transaction::new();
        source.inputs.push(TxIn::new(funding.outpoint.clone()));
        source.outputs.push(TxOut {
            satoshis: source_value,
            script_pubkey: private_key.address().script_pubkey(),
        });
        source.sign_p2pkh_input(
            0,
            private_key,
            &funding.script_pubkey,
            funding.satoshis,
            DEFAULT_SIGHASH,
        )?;

        let original_utxo = Tbc20Outpoint {
            txid: source.txid(),
            output_index: 0,
        };
        let controller = tbc20_address_controller(recipient);
        let code = instantiate_tbc20_code(&original_utxo, controller, self.tape_size)?;
        let mut amounts = [0u64; TBC20_AMOUNT_SLOTS];
        amounts[0] = supply;
        let tape = build_tbc20_tape(amounts, self.tape_size, &self.extension_data)?;
        let source_script = private_key.address().script_pubkey();
        let source_outpoint = crate::OutPoint {
            txid: source.txid(),
            vout: 0,
        };
        let genesis = finalize_signed_fee(
            source_value,
            TBC20_CODE_SATOSHIS,
            DEFAULT_FEE_RATE_SAT_PER_KB,
            DEFAULT_FEE_RATE_SAT_PER_KB,
            ChangePolicy::Optional { dust: SDK_DUST_SAT },
            |change| {
                let mut transaction = Transaction::new();
                transaction.inputs.push(TxIn::new(source_outpoint.clone()));
                transaction.outputs.push(TxOut {
                    satoshis: TBC20_CODE_SATOSHIS,
                    script_pubkey: code.clone(),
                });
                transaction.outputs.push(TxOut {
                    satoshis: TBC20_TAPE_SATOSHIS,
                    script_pubkey: tape.clone(),
                });
                if let Some(change) = change {
                    transaction.outputs.push(TxOut {
                        satoshis: change,
                        script_pubkey: source_script.clone(),
                    });
                }
                transaction.sign_p2pkh_input(
                    0,
                    private_key,
                    &source_script,
                    source_value,
                    DEFAULT_SIGHASH,
                )?;
                Ok(transaction)
            },
        )?;
        let fee_satoshis = paid_fee(&genesis, source_value)?;
        let mut groups = vec![Tbc20OutputGroup {
            code_vout: 0,
            tape_vout: Some(1),
        }];
        if genesis.outputs.len() == 3 {
            groups.push(Tbc20OutputGroup {
                code_vout: 2,
                tape_vout: None,
            });
        }
        self.code_script = Some(code);
        self.tape_script = Some(tape);
        self.contract_txid = Some(genesis.txid());
        Ok(Tbc20MintResult {
            build: Tbc20BuildResult {
                transaction: genesis,
                fee_satoshis,
                token_outputs: vec![Tbc20TokenOutput {
                    code_vout: 0,
                    tape_vout: 1,
                    amount_raw: u128::from(supply),
                    amounts_by_input: amounts,
                    controller,
                }],
                output_groups: groups,
            },
            source_transaction: source,
            source_fee_satoshis: DEFAULT_FEE_RATE_SAT_PER_KB,
            original_utxo,
        })
    }

    pub fn transfer(
        &self,
        private_key: &PrivateKey,
        recipient: &Address,
        human_amount: &str,
        token_inputs: &[Tbc20Spend],
        fee_utxo: &Utxo,
        tbc_change_address: Option<&Address>,
    ) -> Result<Tbc20BuildResult> {
        let decimal = self
            .definition
            .as_ref()
            .ok_or_else(|| invalid("human transfer requires constructor metadata"))?
            .decimal;
        let amount = tbc20_human_to_raw(human_amount, decimal)?;
        if amount == 0 {
            return Err(invalid("transfer amount must be positive"));
        }
        self.transfer_raw(
            private_key,
            tbc20_address_controller(recipient),
            u128::from(amount),
            token_inputs,
            fee_utxo,
            tbc_change_address,
        )
    }

    pub fn merge(
        &self,
        private_key: &PrivateKey,
        token_inputs: &[Tbc20Spend],
        fee_utxo: &Utxo,
        controller: Option<&Address>,
        tbc_change_address: Option<&Address>,
    ) -> Result<Tbc20BuildResult> {
        if token_inputs.len() < 2 {
            return Err(invalid("merge requires at least two token inputs"));
        }
        let validated = self.validate_transfer_inputs(private_key, token_inputs)?;
        let total = validated.iter().try_fold(0u128, |sum, input| {
            sum.checked_add(input.balance)
                .ok_or_else(|| invalid("token balance overflows u128"))
        })?;
        let controller = controller.cloned().unwrap_or_else(|| private_key.address());
        self.transfer_raw(
            private_key,
            tbc20_address_controller(&controller),
            total,
            token_inputs,
            fee_utxo,
            tbc_change_address,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn transfer_raw(
        &self,
        private_key: &PrivateKey,
        receiver_controller: [u8; 21],
        amount: u128,
        token_inputs: &[Tbc20Spend],
        fee_utxo: &Utxo,
        tbc_change_address: Option<&Address>,
    ) -> Result<Tbc20BuildResult> {
        if amount == 0 {
            return Err(invalid("transfer amount must be positive"));
        }
        assert_p2pkh_owner(fee_utxo, private_key, "fee UTXO")?;
        let validated = self.validate_transfer_inputs(private_key, token_inputs)?;
        ensure_unique_inputs(&validated, fee_utxo)?;
        let total = validated.iter().try_fold(0u128, |sum, input| {
            sum.checked_add(input.balance)
                .ok_or_else(|| invalid("token balance overflows u128"))
        })?;
        if amount > total {
            return Err(invalid("transfer amount exceeds available balance"));
        }
        let mut remaining = validated
            .iter()
            .map(|input| input.balance)
            .collect::<Vec<_>>();
        let mut plans = Vec::new();
        allocate(&mut plans, &mut remaining, receiver_controller, amount)?;
        if total > amount {
            allocate(
                &mut plans,
                &mut remaining,
                validated[0].controller,
                total - amount,
            )?;
        }

        let input_sum = validated
            .len()
            .checked_mul(TBC20_CODE_SATOSHIS as usize)
            .and_then(|token_sat| u64::try_from(token_sat).ok())
            .and_then(|token_sat| token_sat.checked_add(fee_utxo.satoshis))
            .ok_or_else(|| invalid("input satoshi total overflows"))?;
        let fixed_satoshis = (plans.len() as u64)
            .checked_mul(TBC20_CODE_SATOSHIS)
            .ok_or_else(|| invalid("output satoshi total overflows"))?;
        let can_add_change =
            plans.len() < TBC20_MAX_OUTPUT_GROUPS && plans.len() * 2 < TBC20_MAX_OUTPUTS;
        let change_policy = if can_add_change {
            ChangePolicy::Optional { dust: SDK_DUST_SAT }
        } else {
            ChangePolicy::Forbidden
        };
        let change_script = tbc_change_address
            .cloned()
            .unwrap_or_else(|| private_key.address())
            .script_pubkey();

        let transaction = finalize_signed_fee(
            input_sum,
            fixed_satoshis,
            DEFAULT_FEE_RATE_SAT_PER_KB,
            DEFAULT_FEE_RATE_SAT_PER_KB,
            change_policy,
            |change| {
                let (mut transaction, groups, _) =
                    build_unsigned(&validated, fee_utxo, &plans, &change_script, change)?;
                for (index, input) in validated.iter().enumerate() {
                    let unsigned = transaction.clone();
                    transaction.inputs[index].script_sig = build_tbc20_unlock_script(
                        super::Tbc20UnlockOptions {
                            current_tx: &unsigned,
                            input_index: index,
                            pre_tx: &input.parent,
                            pre_tx_vout: input.code_vout,
                            output_groups: &groups,
                            ancestor_transactions: &input.ancestors,
                            contract_controller: None,
                            signature: &[],
                            public_key: &[],
                        },
                        private_key,
                    )?;
                }
                let fee_index = validated.len();
                transaction.sign_p2pkh_input(
                    fee_index,
                    private_key,
                    &fee_utxo.script_pubkey,
                    fee_utxo.satoshis,
                    DEFAULT_SIGHASH,
                )?;
                Ok(transaction)
            },
        )?;
        if !can_add_change
            && paid_fee(&transaction, input_sum)?
                > crate::builder::fee_for_size(
                    transaction.serialize().len(),
                    DEFAULT_FEE_RATE_SAT_PER_KB,
                ) + SDK_DUST_SAT
        {
            return Err(invalid("no logical output slot remains for TBC change"));
        }
        let (_, groups, token_outputs) = build_unsigned(
            &validated,
            fee_utxo,
            &plans,
            &change_script,
            (transaction.outputs.len() > plans.len() * 2)
                .then(|| transaction.outputs.last().unwrap().satoshis),
        )?;
        Ok(Tbc20BuildResult {
            fee_satoshis: paid_fee(&transaction, input_sum)?,
            transaction,
            token_outputs,
            output_groups: groups,
        })
    }

    fn validate_transfer_inputs(
        &self,
        private_key: &PrivateKey,
        inputs: &[Tbc20Spend],
    ) -> Result<Vec<ValidatedInput>> {
        if inputs.is_empty() || inputs.len() > TBC20_MAX_INPUTS - 1 {
            return Err(invalid(format!(
                "transfer requires 1-{} token inputs",
                TBC20_MAX_INPUTS - 1
            )));
        }
        let key_hash = crate::hash::hash160(&private_key.public_key().to_bytes());
        let canonical_identity = self
            .code_script
            .as_ref()
            .map(tbc20_code_identity)
            .transpose()?;
        let mut validated = Vec::with_capacity(inputs.len());
        for (index, input) in inputs.iter().enumerate() {
            let code = input
                .parent
                .outputs
                .get(input.code_vout)
                .ok_or_else(|| invalid(format!("token input {index} code is missing")))?;
            let tape = input
                .parent
                .outputs
                .get(input.code_vout + 1)
                .ok_or_else(|| invalid(format!("token input {index} tape is missing")))?;
            if code.satoshis != TBC20_CODE_SATOSHIS || tape.satoshis != TBC20_TAPE_SATOSHIS {
                return Err(invalid(format!(
                    "token input {index} code/tape values differ"
                )));
            }
            validate_tbc20_code(&code.script_pubkey, Some(self.tape_size))?;
            let parsed = parse_tbc20_tape(&tape.script_pubkey)?;
            if parsed.size != self.tape_size || parsed.extension_data != self.extension_data {
                return Err(invalid(format!(
                    "token input {index} has incompatible tape"
                )));
            }
            let controller = tbc20_controller(&code.script_pubkey)?;
            if controller[20] != 0 || controller[..20] != key_hash {
                return Err(invalid(format!(
                    "token input {index} is not controlled by the signing key"
                )));
            }
            let identity = tbc20_code_identity(&code.script_pubkey)?;
            if canonical_identity
                .as_ref()
                .is_some_and(|canonical| canonical != &identity)
            {
                return Err(invalid(format!(
                    "token input {index} belongs to another token"
                )));
            }
            validated.push(ValidatedInput {
                parent: input.parent.clone(),
                code_vout: input.code_vout,
                ancestors: input.ancestors.clone(),
                balance: parsed.balance,
                code: code.script_pubkey.clone(),
                tape: tape.script_pubkey.clone(),
                controller,
                identity,
            });
        }
        let envelope = tape_envelope(&validated[0].tape);
        for (index, input) in validated.iter().enumerate().skip(1) {
            if input.identity != validated[0].identity || tape_envelope(&input.tape) != envelope {
                return Err(invalid(format!(
                    "token input {index} belongs to a different identity or tape envelope"
                )));
            }
        }
        Ok(validated)
    }
}

fn build_unsigned(
    inputs: &[ValidatedInput],
    fee_utxo: &Utxo,
    plans: &[OutputPlan],
    change_script: &crate::script::Script,
    change: Option<u64>,
) -> Result<(Transaction, Vec<Tbc20OutputGroup>, Vec<Tbc20TokenOutput>)> {
    let mut transaction = Transaction::new();
    for input in inputs {
        transaction.inputs.push(TxIn::new(crate::OutPoint {
            txid: input.parent.txid(),
            vout: input.code_vout as u32,
        }));
    }
    transaction
        .inputs
        .push(TxIn::new(fee_utxo.outpoint.clone()));
    let mut groups = Vec::with_capacity(plans.len() + usize::from(change.is_some()));
    let mut token_outputs = Vec::with_capacity(plans.len());
    for plan in plans {
        let code_vout = transaction.outputs.len();
        transaction.outputs.push(TxOut {
            satoshis: TBC20_CODE_SATOSHIS,
            script_pubkey: replace_tbc20_controller(&inputs[0].code, plan.controller)?,
        });
        transaction.outputs.push(TxOut {
            satoshis: TBC20_TAPE_SATOSHIS,
            script_pubkey: replace_tbc20_tape_amounts(&inputs[0].tape, plan.slots)?,
        });
        groups.push(Tbc20OutputGroup {
            code_vout,
            tape_vout: Some(code_vout + 1),
        });
        token_outputs.push(Tbc20TokenOutput {
            code_vout,
            tape_vout: code_vout + 1,
            amount_raw: plan.amount,
            amounts_by_input: plan.slots,
            controller: plan.controller,
        });
    }
    if let Some(change) = change {
        let code_vout = transaction.outputs.len();
        transaction.outputs.push(TxOut {
            satoshis: change,
            script_pubkey: change_script.clone(),
        });
        groups.push(Tbc20OutputGroup {
            code_vout,
            tape_vout: None,
        });
    }
    Ok((transaction, groups, token_outputs))
}

fn allocate(
    plans: &mut Vec<OutputPlan>,
    remaining: &mut [u128],
    controller: [u8; 21],
    requested: u128,
) -> Result<()> {
    let mut needed = requested;
    while needed > 0 {
        let mut plan = OutputPlan {
            controller,
            amount: 0,
            slots: [0; TBC20_AMOUNT_SLOTS],
        };
        for (input_index, available) in remaining.iter_mut().enumerate() {
            if needed == 0 {
                break;
            }
            let value = (*available)
                .min(u128::from(TBC20_MAX_SLOT_AMOUNT))
                .min(needed);
            if value == 0 {
                continue;
            }
            plan.slots[input_index] = value as u64;
            *available -= value;
            needed -= value;
            plan.amount += value;
        }
        if plan.amount == 0 {
            return Err(invalid("internal token allocation failure"));
        }
        plans.push(plan);
        if plans.len() > TBC20_MAX_OUTPUT_GROUPS {
            return Err(invalid(format!(
                "token amounts require more than {TBC20_MAX_OUTPUT_GROUPS} output groups"
            )));
        }
    }
    Ok(())
}

fn ensure_unique_inputs(inputs: &[ValidatedInput], fee_utxo: &Utxo) -> Result<()> {
    let mut seen = HashSet::new();
    for input in inputs {
        if !seen.insert((input.parent.txid(), input.code_vout as u32)) {
            return Err(invalid("duplicate token input outpoint"));
        }
    }
    if !seen.insert((fee_utxo.outpoint.txid, fee_utxo.outpoint.vout)) {
        return Err(invalid("fee input duplicates a token input"));
    }
    Ok(())
}

fn tape_envelope(script: &crate::script::Script) -> Vec<u8> {
    let bytes = script.as_bytes();
    let mut envelope = bytes[..3].to_vec();
    envelope.extend_from_slice(&bytes[51..]);
    envelope
}

fn assert_p2pkh_owner(utxo: &Utxo, key: &PrivateKey, label: &str) -> Result<()> {
    if utxo.script_pubkey != key.address().script_pubkey() {
        return Err(invalid(format!(
            "{label} is not controlled by the signing key"
        )));
    }
    Ok(())
}

fn invalid(message: impl Into<String>) -> Error {
    Error::InvalidUtxo(format!("TBC20: {}", message.into()))
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use serde_json::Value;

    use super::*;
    use crate::Txid;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../../tests/fixtures/js-166/tbc20.json")).unwrap()
    }

    fn key(transaction: &Value) -> PrivateKey {
        PrivateKey::from_slice(
            &hex::decode(transaction["privateKeyHex"].as_str().unwrap()).unwrap(),
        )
        .unwrap()
    }

    fn token_from_mint(transaction: &Value) -> Tbc20 {
        let mint = Transaction::from_hex(transaction["mintRaw"].as_str().unwrap()).unwrap();
        Tbc20::new(super::super::Tbc20Config {
            definition: Some(super::super::Tbc20Definition {
                name: "Parity Token".to_string(),
                symbol: "PTY".to_string(),
                supply: "1000".to_string(),
                decimal: 8,
            }),
            code_script: Some(mint.outputs[0].script_pubkey.clone()),
            tape_script: Some(mint.outputs[1].script_pubkey.clone()),
            contract_txid: Some(mint.txid()),
            ..Default::default()
        })
        .unwrap()
    }

    #[test]
    fn mint_matches_javascript_166_raw_transactions() {
        let fixture = fixture();
        let transaction = &fixture["transactionFixture"];
        let key = key(transaction);
        let funding = Utxo {
            outpoint: crate::OutPoint {
                txid: Txid::from_str(&"aa".repeat(32)).unwrap(),
                vout: 0,
            },
            satoshis: 300_000,
            script_pubkey: key.address().script_pubkey(),
            private_key: key.clone(),
        };
        let mut token = Tbc20::new(super::super::Tbc20Config {
            definition: Some(super::super::Tbc20Definition {
                name: "Parity Token".to_string(),
                symbol: "PTY".to_string(),
                supply: "1000".to_string(),
                decimal: 8,
            }),
            ..Default::default()
        })
        .unwrap();
        let result = token.mint(&key, &key.address(), &funding).unwrap();
        assert_eq!(
            result.source_transaction.to_hex(),
            transaction["sourceRaw"].as_str().unwrap()
        );
        let mut expected = Transaction::from_hex(transaction["mintRaw"].as_str().unwrap()).unwrap();
        let mut actual = result.build.transaction.clone();
        assert!(!actual.inputs[0].script_sig.as_bytes().is_empty());
        expected.inputs[0].script_sig = crate::script::Script::empty();
        actual.inputs[0].script_sig = crate::script::Script::empty();
        assert_eq!(actual, expected);
        assert_eq!(
            result.build.fee_satoshis,
            transaction["mintFeeSatoshis"].as_u64().unwrap()
        );
    }

    #[test]
    fn transfer_matches_javascript_166_raw_transaction() {
        let fixture = fixture();
        let transaction = &fixture["transactionFixture"];
        let key = key(transaction);
        let token = token_from_mint(transaction);
        let mint = Transaction::from_hex(transaction["mintRaw"].as_str().unwrap()).unwrap();
        let source = Transaction::from_hex(transaction["sourceRaw"].as_str().unwrap()).unwrap();
        let recipient = Address::from_string(transaction["recipient"].as_str().unwrap()).unwrap();
        let fee = Utxo {
            outpoint: crate::OutPoint {
                txid: Txid::from_str(&"bb".repeat(32)).unwrap(),
                vout: 1,
            },
            satoshis: 100_000,
            script_pubkey: key.address().script_pubkey(),
            private_key: key.clone(),
        };
        let result = token
            .transfer(
                &key,
                &recipient,
                "123.456",
                &[Tbc20Spend {
                    parent: mint,
                    code_vout: 0,
                    ancestors: vec![source],
                }],
                &fee,
                None,
            )
            .unwrap();
        assert_eq!(
            result.transaction.to_hex(),
            transaction["transferRaw"].as_str().unwrap()
        );
        assert_eq!(
            result.fee_satoshis,
            transaction["transferFeeSatoshis"].as_u64().unwrap()
        );
    }

    #[test]
    fn merge_matches_javascript_166_raw_transaction() {
        let fixture = fixture();
        let transaction = &fixture["transactionFixture"];
        let key = key(transaction);
        let token = token_from_mint(transaction);
        let split = Transaction::from_hex(transaction["splitRaw"].as_str().unwrap()).unwrap();
        let mint = Transaction::from_hex(transaction["mintRaw"].as_str().unwrap()).unwrap();
        let fee = Utxo {
            outpoint: crate::OutPoint {
                txid: Txid::from_str(&"cc".repeat(32)).unwrap(),
                vout: 0,
            },
            satoshis: 100_000,
            script_pubkey: key.address().script_pubkey(),
            private_key: key.clone(),
        };
        let result = token
            .merge(
                &key,
                &[
                    Tbc20Spend {
                        parent: split.clone(),
                        code_vout: 0,
                        ancestors: vec![mint.clone()],
                    },
                    Tbc20Spend {
                        parent: split,
                        code_vout: 2,
                        ancestors: vec![mint],
                    },
                ],
                &fee,
                None,
                None,
            )
            .unwrap();
        assert_eq!(
            result.transaction.to_hex(),
            transaction["mergeRaw"].as_str().unwrap()
        );
        assert_eq!(
            result.fee_satoshis,
            transaction["mergeFeeSatoshis"].as_u64().unwrap()
        );
    }
}
