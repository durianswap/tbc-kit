use crate::{
    Address, DEFAULT_FEE_RATE_SAT_PER_KB, DEFAULT_SIGHASH, Error, FtInfo, PrivateKey, PublicKey,
    Result, SDK_DUST_SAT, Transaction, TxIn, TxOut, Txid, Utxo, UtxoInfo,
    builder::{ChangePolicy, finalize_signed_fee},
    script::Script,
};
#[cfg(feature = "network-api")]
use crate::ApiClient;

use super::{
    FTLP_CODE_SATOSHIS, FTLP_TAPE_SATOSHIS, FtScriptVersion, FtSpendContext, FtlpCodeParams,
    FtlpSpendContext, FtlpTapeLayout, FtlpTapeParams, LocalPoolOperationContext, LockedLpCost,
    LockedPoolCodeParams, POOL_CODE_SATOSHIS, POOL_TAPE_SATOSHIS, PoolAmounts, PoolCodeParams,
    PoolOperationContext, PoolSpendContext, PoolState, PoolSwapOption, PoolUnlockContext,
    PoolUnlockOption, PoolUnlockSignature, ftlp_code, ftlp_lock_time_code, ftlp_tape,
    locked_pool_code, parse_decimal_raw, pool_code, pool_held_ft_code, pool_tape, pool_unlock,
    scripts::{locked_pool_lp_cost, transfer_ftlp_code_script},
};
use crate::contracts::ft::{
    amount::{balance_from_tape, build_tape_amount_with_offset},
    builder::{sign_ft_input, sign_ft_swap_input},
    partial_sha256::calculate_partial_hash,
    scripts::{FT_CODE_SATOSHIS, FtCodeReceiver, transfer_code_script, transfer_tape_script},
    unlock::classify_ft_script,
};

const POOL_MINT_SOURCE_SATOSHIS: u64 = 9_800;
const POOL_MINT_SOURCE_MARKER: &[u8] = b"for poolnft mint";
const MAX_MONEY_SAT: u64 = 21_000_000 * 100_000_000;
const MAX_POOL_FT_INPUTS: usize = 3;
// Released `fetchFtUTXOsforPool(..., 4)` cap for the TBC -> FT swap path.
const MAX_SWAP_POOL_FT_INPUTS: usize = 4;
const MAX_UNLOCK_FTLP_INPUTS: usize = 6;
const FTLP_BURN_ADDRESS: &str = "1BitcoinEaterAddressDontSendf59kuE";
const SERVICE_FEE_ADDRESSES: [&str; 6] = [
    "13oCEJaqyyiC8iRrfup6PDL2GKZ3xQrsZL",
    "1Fa6Uy64Ub4qNdB896zX2pNMx4a8zMhtCy",
    "125fTLNsraQxTYqT4EeQNF2ggzcqicveKL",
    "19DetoaaohQkjFVJ6oGXd83xhZYQSbpE1g",
    "15EKrhuD8Yf3SfhjAgbizYqfnBbKh9ZMZ7",
    "1N7rf2AuAHB2aCrVgnbQhSWhaUVk3rGhjm",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolNftV2 {
    pub contract_id: Option<Txid>,
    pub state: PoolState,
    /// Full value of the current Pool output, including the code dust.  This
    /// is deliberately distinct from `state.amounts.tbc_sat`: released Pool
    /// arithmetic uses the full output value in its FT-A branch.
    pub current_pool_value_sat: Option<u64>,
    pub pool_code: Script,
    ft_authority: Option<PoolFtAuthority>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolFtAuthority {
    pub info: FtInfo,
    pub contract_tx: Transaction,
}

#[derive(Clone, Debug)]
struct ValidatedFtAuthority {
    code: Script,
    tape: Script,
    version: FtScriptVersion,
    version_number: u8,
    is_coin: bool,
    metadata: FtTapeMetadata,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FtTapeMetadata {
    total_supply_raw: u128,
    decimal: u8,
    name: String,
    symbol: String,
    coin_suffix: Option<[u8; 4]>,
}

/// Explicit local authority needed to initialize a Pool without network access.
#[derive(Clone, Debug)]
pub struct PoolInitContext {
    pub pool: PoolSpendContext,
    pub ft: FtSpendContext,
    pub ft_authority: PoolFtAuthority,
    pub ft_grandparents: Vec<Transaction>,
    /// Exact parent transaction for the P2PKH fee input.
    pub fee_parent: Transaction,
    pub lp_receiver: Address,
    /// The exact canonical key set embedded in locked Pool Code, or empty for standard Code.
    pub public_key_lock: Vec<PublicKey>,
}

impl PoolNftV2 {
    /// Creates a state-only handle for released Pool arithmetic and tape
    /// construction. This handle has no FT authority and cannot create a Pool.
    pub fn for_state(ft_contract_id: Txid) -> Self {
        Self {
            contract_id: None,
            state: PoolState {
                amounts: PoolAmounts {
                    ft_lp_raw: 0,
                    ft_a_raw: 0,
                    tbc_sat: 0,
                },
                ft_lp_partial_hash: vec![0; 32],
                ft_a_partial_hash: vec![0; 32],
                ft_a_contract_id: ft_contract_id,
                service_fee_rate: 35,
                service_provider: String::new(),
                lp_plan: 1,
                public_key_locked: false,
                ftlp_lock_time_enabled: false,
            },
            current_pool_value_sat: None,
            pool_code: Script::empty(),
            ft_authority: None,
        }
    }

    /// Creates a fresh Pool handle bound to validated released FT authority.
    pub fn for_create(ft_contract_id: Txid, ft_authority: PoolFtAuthority) -> Result<Self> {
        validate_ft_authority(ft_contract_id, &ft_authority)?;
        Ok(Self {
            ft_authority: Some(ft_authority),
            ..Self::for_state(ft_contract_id)
        })
    }

    /// Compatibility alias for [`Self::for_create`].
    #[deprecated(since = "0.1.3", note = "use PoolNftV2::for_create")]
    pub fn for_create_with_ft_authority(
        ft_contract_id: Txid,
        ft_authority: PoolFtAuthority,
    ) -> Result<Self> {
        Self::for_create(ft_contract_id, ft_authority)
    }

    #[cfg(feature = "network-api")]
    pub async fn from_contract_id(api: &ApiClient, id: Txid) -> Result<Self> {
        let info = api.fetch_pool_nft_info(&id).await?;
        Ok(Self {
            contract_id: Some(id),
            state: info.state,
            current_pool_value_sat: Some(info.current_utxo.satoshis),
            pool_code: info.pool_code,
            ft_authority: None,
        })
    }

    pub fn init_pool(
        &self,
        context: PoolInitContext,
        owner: &PrivateKey,
        fee: Utxo,
        tbc_human: &str,
        ft_human: &str,
        lock_time: u32,
    ) -> Result<Transaction> {
        let (authority, ft_pre_pre_tx_data) = validate_init_context(self, &context, owner, &fee)?;
        let total_tbc_sat = parse_decimal_raw(tbc_human, 6)?;
        let ft_raw = parse_decimal_raw(ft_human, authority.metadata.decimal)?;
        if total_tbc_sat == 0 || ft_raw == 0 {
            return Err(Error::InvalidUtxo(
                "Pool initial TBC and FT amounts must both be positive".to_string(),
            ));
        }
        let locked_lp_cost = if context.pool.state.public_key_locked {
            let (address, satoshis) = locked_pool_lp_cost(&context.pool.pool_utxo.script_pubkey)?;
            validate_money_value(satoshis, "locked Pool LP cost")?;
            Some(LockedLpCost { address, satoshis })
        } else {
            None
        };
        let tbc_sat = if let Some(cost) = &locked_lp_cost {
            total_tbc_sat
                .checked_sub(cost.satoshis)
                .filter(|amount| *amount > 0)
                .ok_or_else(|| {
                    Error::InvalidUtxo(
                        "Pool initial TBC amount must exceed the locked LP cost".to_string(),
                    )
                })?
        } else {
            total_tbc_sat
        };

        let ft_code = authority.code.clone();
        let ft_tape = authority.tape.clone();
        let (pool_ft_amount, ft_change_amount) = build_tape_amount_with_offset(
            u128::from(ft_raw),
            &[context.ft.utxo.ft_balance_raw],
            1,
        )?;

        let pool_value = checked_money_sum(
            &[context.pool.pool_utxo.satoshis, tbc_sat],
            "Pool TBC reserve",
        )?;
        let mut next_state = context.pool.state.clone();
        next_state.amounts = PoolAmounts {
            ft_lp_raw: super::initial_lp_raw(tbc_sat)?,
            ft_a_raw: ft_raw,
            tbc_sat,
        };

        let pool_hash = crate::hash::sha256(self.pool_code.as_bytes());
        let pool_hash160 = crate::hash::hash160(&pool_hash);
        let ftlp_tape_script = if next_state.ftlp_lock_time_enabled {
            ftlp_tape(&FtlpTapeParams {
                amount_raw: next_state.amounts.ft_lp_raw,
                layout: FtlpTapeLayout::LockTime {
                    lock_time,
                    source_ft_tape_size: ft_tape.as_bytes().len(),
                },
            })?
        } else {
            standard_ftlp_tape(
                next_state.amounts.ft_lp_raw,
                &authority.metadata,
                authority.is_coin,
            )?
        };
        let ftlp_params =
            FtlpCodeParams::for_tape(&ftlp_tape_script, authority.version, authority.is_coin)?;
        let ftlp_code_script = if next_state.ftlp_lock_time_enabled {
            ftlp_lock_time_code(pool_hash, &context.lp_receiver, &ftlp_params)?
        } else {
            ftlp_code(pool_hash, &context.lp_receiver, &ftlp_params)?
        };
        let ftlp_partial_offset = partial_hash_offset(authority.version_number, authority.is_coin)?;
        if calculate_partial_hash(&ftlp_code_script.as_bytes()[..ftlp_partial_offset]).as_slice()
            != next_state.ft_lp_partial_hash
        {
            return Err(Error::InvalidUtxo(
                "Pool init FTLP metadata does not match the Pool partial hash".to_string(),
            ));
        }

        let mut core_outputs = vec![
            TxOut {
                satoshis: pool_value,
                script_pubkey: self.pool_code.clone(),
            },
            TxOut {
                satoshis: POOL_TAPE_SATOSHIS,
                script_pubkey: pool_tape(&next_state)?,
            },
            TxOut {
                satoshis: context.ft.utxo.base.satoshis,
                script_pubkey: pool_held_ft_code(&ft_code, pool_hash160)?,
            },
            TxOut {
                satoshis: 0,
                script_pubkey: transfer_tape_script(&ft_tape, &pool_ft_amount)?,
            },
            TxOut {
                satoshis: FTLP_CODE_SATOSHIS,
                script_pubkey: ftlp_code_script,
            },
            TxOut {
                satoshis: FTLP_TAPE_SATOSHIS,
                script_pubkey: ftlp_tape_script,
            },
        ];
        if let Some(cost) = &locked_lp_cost {
            core_outputs.push(TxOut {
                satoshis: cost.satoshis,
                script_pubkey: cost.address.script_pubkey(),
            });
        }
        if context.ft.utxo.ft_balance_raw > u128::from(ft_raw) {
            core_outputs.extend([
                TxOut {
                    satoshis: context.ft.utxo.base.satoshis,
                    script_pubkey: transfer_code_script(
                        &ft_code,
                        FtCodeReceiver::Address(owner.address()),
                    )?,
                },
                TxOut {
                    satoshis: 0,
                    script_pubkey: transfer_tape_script(&ft_tape, &ft_change_amount)?,
                },
            ]);
        }

        let input_sum = checked_money_sum(
            &[
                context.pool.pool_utxo.satoshis,
                context.ft.utxo.base.satoshis,
                fee.satoshis,
            ],
            "Pool init input amount",
        )?;
        let output_sum = sum_outputs(&core_outputs)?;
        let pool_uses_large_unlock =
            super::unlock::uses_large_pool_unlock(&context.pool.pool_utxo.script_pubkey)?;
        finalize_signed_fee(
            input_sum,
            output_sum,
            DEFAULT_FEE_RATE_SAT_PER_KB,
            DEFAULT_FEE_RATE_SAT_PER_KB,
            ChangePolicy::Optional { dust: SDK_DUST_SAT },
            |change| {
                let mut tx = Transaction::new();
                tx.inputs
                    .push(TxIn::new(context.pool.pool_utxo.outpoint.clone()));
                tx.inputs
                    .push(TxIn::new(context.ft.utxo.base.outpoint.clone()));
                tx.inputs.push(TxIn::new(fee.outpoint.clone()));
                if authority.is_coin {
                    tx.inputs[1].sequence = 0xffff_fffe;
                }
                tx.outputs.extend_from_slice(&core_outputs);
                if let Some(change) = change {
                    validate_money_value(change, "Pool init fee change")?;
                    tx.outputs.push(TxOut {
                        satoshis: change,
                        script_pubkey: fee.private_key.address().script_pubkey(),
                    });
                }

                let pool_signature = if pool_uses_large_unlock {
                    None
                } else {
                    Some(PoolUnlockSignature {
                        signature_with_hashtype: tx.signature_with_hashtype(
                            0,
                            owner,
                            &context.pool.pool_utxo.script_pubkey,
                            context.pool.pool_utxo.satoshis,
                            DEFAULT_SIGHASH,
                        )?,
                        public_key: owner.public_key(),
                    })
                };
                let input_parents = [context.ft.pre_tx.clone(), context.fee_parent.clone()];
                tx.inputs[0].script_sig = Script::from_bytes(pool_unlock(&PoolUnlockContext {
                    transaction: &tx,
                    input_index: 0,
                    spent_vout: 0,
                    pool: &context.pool,
                    input_parents: &input_parents,
                    option: PoolUnlockOption::IncreaseLiquidity,
                    swap_option: None,
                    with_lock: context.pool.state.public_key_locked,
                    signature: pool_signature.as_ref(),
                    public_key_lock: &context.public_key_lock,
                })?);
                sign_ft_input(
                    &mut tx,
                    1,
                    owner,
                    &context.ft.utxo,
                    &context.ft.pre_tx,
                    &ft_pre_pre_tx_data,
                    authority.is_coin,
                )?;
                tx.sign_p2pkh_input(
                    2,
                    &fee.private_key,
                    &fee.script_pubkey,
                    fee.satoshis,
                    DEFAULT_SIGHASH,
                )?;
                Ok(tx)
            },
        )
    }

    pub fn increase_lp(
        &self,
        context: PoolOperationContext,
        owner: &PrivateKey,
        fee: Utxo,
        tbc_human: &str,
        lock_time: u32,
    ) -> Result<Transaction> {
        self.increase_lp_to(context, owner, &owner.address(), fee, tbc_human, lock_time)
    }

    pub fn increase_lp_to(
        &self,
        context: PoolOperationContext,
        owner: &PrivateKey,
        receiver: &Address,
        fee: Utxo,
        tbc_human: &str,
        lock_time: u32,
    ) -> Result<Transaction> {
        validate_operation_context(self, &context, &fee)?;
        if context.ft_inputs.len() != 1 || !context.ftlp_inputs.is_empty() {
            return Err(Error::InvalidUtxo(
                "Pool increase requires exactly one FT-A input and no FT-LP inputs".to_string(),
            ));
        }
        let ft = &context.ft_inputs[0];
        let (ft_code, ft_tape, metadata, is_coin, version, version_number) =
            validate_ft_spend(ft, owner, &context.ft_grandparents[0])?;
        validate_underlying_ft_binding(&ft_code, &context.pool.state, version_number, is_coin)?;
        let requested = parse_decimal_raw(tbc_human, 6)?;
        let (increment, lp_cost) = if context.pool.state.public_key_locked {
            let cost = context.locked_lp_cost.as_ref().ok_or_else(|| {
                Error::InvalidUtxo(
                    "locked Pool increase requires its explicit LP-cost output".to_string(),
                )
            })?;
            validate_money_value(cost.satoshis, "locked Pool LP cost")?;
            let (code_address, code_satoshis) =
                locked_pool_lp_cost(&context.pool.pool_utxo.script_pubkey)?;
            if cost.address != code_address || cost.satoshis != code_satoshis {
                return Err(Error::InvalidUtxo(
                    "locked Pool LP cost does not match the spent Pool Code".to_string(),
                ));
            }
            let increment = requested.checked_sub(cost.satoshis).ok_or_else(|| {
                Error::InvalidUtxo(
                    "Pool increase TBC amount must exceed the locked LP cost".to_string(),
                )
            })?;
            if increment == 0 {
                return Err(Error::InvalidUtxo(
                    "Pool increase TBC amount must exceed the locked LP cost".to_string(),
                ));
            }
            (increment, Some(cost))
        } else {
            if context.locked_lp_cost.is_some() {
                return Err(Error::InvalidUtxo(
                    "standard Pool increase must not include an LP-cost output".to_string(),
                ));
            }
            (requested, None)
        };
        validate_money_value(fee.satoshis, "Pool increase fee input")?;
        let delta = super::increase_lp(
            &context.pool.state.amounts,
            context.pool.pool_utxo.satoshis,
            increment,
        )?;
        let ft_add = delta_to_u64(delta.ft_a_delta, "Pool FT-A increase")?;
        let lp_add = delta_to_u64(delta.ft_lp_delta, "Pool LP increase")?;
        let mut next_state = context.pool.state.clone();
        next_state.amounts.ft_lp_raw = next_state
            .amounts
            .ft_lp_raw
            .checked_add(lp_add)
            .ok_or_else(|| Error::InvalidUtxo("Pool LP reserve overflow".to_string()))?;
        next_state.amounts.ft_a_raw = next_state
            .amounts
            .ft_a_raw
            .checked_add(ft_add)
            .ok_or_else(|| Error::InvalidUtxo("Pool FT-A reserve overflow".to_string()))?;
        next_state.amounts.tbc_sat = next_state
            .amounts
            .tbc_sat
            .checked_add(increment)
            .ok_or_else(|| Error::InvalidUtxo("Pool TBC reserve overflow".to_string()))?;
        let (pool_ft_tape, ft_change_tape) =
            build_tape_amount_with_offset(u128::from(ft_add), &[ft.utxo.ft_balance_raw], 1)?;
        let pool_hash = crate::hash::sha256(self.pool_code.as_bytes());
        let ftlp_tape_script = if next_state.ftlp_lock_time_enabled {
            ftlp_tape(&FtlpTapeParams {
                amount_raw: lp_add,
                layout: FtlpTapeLayout::LockTime {
                    lock_time,
                    source_ft_tape_size: ft_tape.as_bytes().len(),
                },
            })?
        } else {
            standard_ftlp_tape(lp_add, &metadata, is_coin)?
        };
        let ftlp_params = FtlpCodeParams::for_tape(&ftlp_tape_script, version, is_coin)?;
        let ftlp_code_script = if next_state.ftlp_lock_time_enabled {
            ftlp_lock_time_code(pool_hash, receiver, &ftlp_params)?
        } else {
            ftlp_code(pool_hash, receiver, &ftlp_params)?
        };
        let expected_lp_hash = calculate_partial_hash(
            &ftlp_code_script.as_bytes()[..partial_hash_offset(version_number, is_coin)?],
        );
        if next_state.ft_lp_partial_hash != expected_lp_hash {
            return Err(Error::InvalidUtxo(
                "Pool increase FTLP code does not match Pool state".to_string(),
            ));
        }
        let pool_hash160 = crate::hash::hash160(&pool_hash);
        let mut outputs = vec![
            TxOut {
                satoshis: context
                    .pool
                    .pool_utxo
                    .satoshis
                    .checked_add(increment)
                    .ok_or_else(|| {
                        Error::InvalidUtxo("Pool increase value overflow".to_string())
                    })?,
                script_pubkey: self.pool_code.clone(),
            },
            TxOut {
                satoshis: POOL_TAPE_SATOSHIS,
                script_pubkey: pool_tape(&next_state)?,
            },
            TxOut {
                satoshis: ft.utxo.base.satoshis,
                script_pubkey: pool_held_ft_code(&ft_code, pool_hash160)?,
            },
            TxOut {
                satoshis: 0,
                script_pubkey: transfer_tape_script(&ft_tape, &pool_ft_tape)?,
            },
            TxOut {
                satoshis: FTLP_CODE_SATOSHIS,
                script_pubkey: ftlp_code_script,
            },
            TxOut {
                satoshis: FTLP_TAPE_SATOSHIS,
                script_pubkey: ftlp_tape_script,
            },
        ];
        if let Some(cost) = lp_cost {
            outputs.push(TxOut {
                satoshis: cost.satoshis,
                script_pubkey: cost.address.script_pubkey(),
            });
        }
        if ft.utxo.ft_balance_raw > u128::from(ft_add) {
            outputs.extend([
                TxOut {
                    satoshis: ft.utxo.base.satoshis,
                    script_pubkey: transfer_code_script(
                        &ft_code,
                        FtCodeReceiver::Address(owner.address()),
                    )?,
                },
                TxOut {
                    satoshis: 0,
                    script_pubkey: transfer_tape_script(&ft_tape, &ft_change_tape)?,
                },
            ]);
        }
        let input_sum = checked_money_sum(
            &[
                context.pool.pool_utxo.satoshis,
                ft.utxo.base.satoshis,
                fee.satoshis,
            ],
            "Pool increase input",
        )?;
        let output_sum = sum_outputs(&outputs)?;
        let large = super::unlock::uses_large_pool_unlock(&context.pool.pool_utxo.script_pubkey)?;
        finalize_signed_fee(
            input_sum,
            output_sum,
            DEFAULT_FEE_RATE_SAT_PER_KB,
            DEFAULT_FEE_RATE_SAT_PER_KB,
            ChangePolicy::Optional { dust: SDK_DUST_SAT },
            |change| {
                let mut tx = Transaction::new();
                tx.inputs
                    .push(TxIn::new(context.pool.pool_utxo.outpoint.clone()));
                tx.inputs.push(TxIn::new(ft.utxo.base.outpoint.clone()));
                tx.inputs.push(TxIn::new(fee.outpoint.clone()));
                if is_coin {
                    tx.inputs[1].sequence = 0xffff_fffe;
                }
                tx.outputs.extend_from_slice(&outputs);
                if let Some(change) = change {
                    tx.outputs.push(TxOut {
                        satoshis: change,
                        script_pubkey: fee.private_key.address().script_pubkey(),
                    });
                }
                let signature = if large {
                    None
                } else {
                    Some(PoolUnlockSignature {
                        signature_with_hashtype: tx.signature_with_hashtype(
                            0,
                            owner,
                            &context.pool.pool_utxo.script_pubkey,
                            context.pool.pool_utxo.satoshis,
                            DEFAULT_SIGHASH,
                        )?,
                        public_key: owner.public_key(),
                    })
                };
                let parents = [ft.pre_tx.clone(), context.fee_parent.clone()];
                tx.inputs[0].script_sig = Script::from_bytes(pool_unlock(&PoolUnlockContext {
                    transaction: &tx,
                    input_index: 0,
                    spent_vout: 0,
                    pool: &context.pool,
                    input_parents: &parents,
                    option: PoolUnlockOption::IncreaseLiquidity,
                    swap_option: None,
                    with_lock: context.pool.state.public_key_locked,
                    signature: signature.as_ref(),
                    public_key_lock: &context.public_key_lock,
                })?);
                sign_ft_input(
                    &mut tx,
                    1,
                    owner,
                    &ft.utxo,
                    &ft.pre_tx,
                    &ft.pre_pre_tx_data,
                    is_coin,
                )?;
                tx.sign_p2pkh_input(
                    2,
                    &fee.private_key,
                    &fee.script_pubkey,
                    fee.satoshis,
                    DEFAULT_SIGHASH,
                )?;
                Ok(tx)
            },
        )
    }

    pub fn consume_lp(
        &self,
        context: PoolOperationContext,
        owner: &PrivateKey,
        fee: Utxo,
        lp_human: &str,
        current_lock_time: Option<u32>,
    ) -> Result<Vec<Transaction>> {
        self.consume_lp_to(
            context,
            owner,
            &owner.address(),
            fee,
            lp_human,
            current_lock_time,
        )
    }

    pub fn consume_lp_to(
        &self,
        context: PoolOperationContext,
        owner: &PrivateKey,
        receiver: &Address,
        fee: Utxo,
        lp_human: &str,
        current_lock_time: Option<u32>,
    ) -> Result<Vec<Transaction>> {
        validate_operation_context(self, &context, &fee)?;
        if context.ftlp_inputs.is_empty()
            || context.ftlp_inputs.len() > MAX_UNLOCK_FTLP_INPUTS
            || (!context.pool.state.ftlp_lock_time_enabled && context.ftlp_inputs.len() != 1)
            || context.ft_inputs.is_empty()
            || context.ft_inputs.len() > MAX_POOL_FT_INPUTS
        {
            return Err(Error::InvalidUtxo(format!(
                "Pool consume requires one FT-LP input and one to {MAX_POOL_FT_INPUTS} pool FT-A inputs"
            )));
        }
        let lp_raw = parse_decimal_raw(lp_human, 6)?;
        let mut ft_descriptors = Vec::with_capacity(context.ft_inputs.len());
        for (input, parents) in context.ft_inputs.iter().zip(&context.ft_grandparents) {
            let descriptor = validate_pool_ft_spend(input, &context.pool, parents)?;
            validate_underlying_ft_binding(
                &descriptor.0,
                &context.pool.state,
                descriptor.5,
                descriptor.3,
            )?;
            ft_descriptors.push(descriptor);
        }
        let (ft_code, ft_tape, metadata, is_coin, _version, ft_version_number) =
            ft_descriptors[0].clone();
        for (input, parents) in context.ftlp_inputs.iter().zip(&context.ftlp_grandparents) {
            let (code, tape) = validate_ftlp_spend(input, owner, parents)?;
            validate_ftlp_pool_binding(
                &code,
                &tape,
                input.utxo.ft_balance_raw,
                &context.pool.state,
                &context.pool.pool_utxo.script_pubkey,
                &owner.address(),
                ft_version_number,
                is_coin,
                &metadata,
                ft_tape.as_bytes().len(),
            )?;
        }
        let mut ftlp = context.ftlp_inputs[0].clone();
        let mut precursor = None;
        let fee_for_consume;
        let fee_parent_for_consume;
        if context.pool.state.ftlp_lock_time_enabled {
            let lock = current_lock_time.ok_or_else(|| {
                Error::InvalidUtxo(
                    "lock-time Pool consume requires an explicit current lock time".to_string(),
                )
            })?;
            let lock_times = context
                .ftlp_inputs
                .iter()
                .map(ftlp_lock_time)
                .collect::<Result<Vec<_>>>()?;
            if lock_times.iter().any(|time| *time > lock) {
                return Err(Error::InvalidUtxo("FTLP is still time locked".to_string()));
            }
            if context.ftlp_inputs.len() != 1 || lock_times[0] != 0 {
                let unlock = build_ftlp_unlock(&context, owner, &fee, lock)?;
                let unlock_output = unlock.outputs.first().ok_or_else(|| {
                    Error::InvalidUtxo("local FTLP unlock is missing output 0".to_string())
                })?;
                let pre_pre = crate::contracts::ft::unlock::pre_pre_tx_data_from_parents(
                    &unlock,
                    0,
                    &context
                        .ftlp_inputs
                        .iter()
                        .rev()
                        .map(|input| input.pre_tx.clone())
                        .collect::<Vec<_>>(),
                )?;
                ftlp = FtlpSpendContext {
                    utxo: crate::FtlpUtxo {
                        base: crate::UtxoInfo {
                            outpoint: crate::OutPoint {
                                txid: unlock.txid(),
                                vout: 0,
                            },
                            satoshis: unlock_output.satoshis,
                            script_pubkey: unlock_output.script_pubkey.clone(),
                        },
                        ft_balance_raw: context.ftlp_inputs.iter().try_fold(
                            0u128,
                            |sum, input| {
                                sum.checked_add(input.utxo.ft_balance_raw).ok_or_else(|| {
                                    Error::InvalidUtxo("FTLP balance overflow".to_string())
                                })
                            },
                        )?,
                    },
                    pre_tx: unlock.clone(),
                    pre_pre_tx_data: pre_pre,
                    grandparents: context
                        .ftlp_inputs
                        .iter()
                        .rev()
                        .map(|input| input.pre_tx.clone())
                        .collect(),
                    pool: None,
                    fee_parent: Some(unlock.clone()),
                };
                let child_fee = unlock.outputs.get(2).ok_or_else(|| {
                    Error::InvalidUtxo(
                        "local FTLP unlock must retain its P2PKH change at output 2".to_string(),
                    )
                })?;
                fee_for_consume = Utxo {
                    outpoint: crate::OutPoint {
                        txid: unlock.txid(),
                        vout: 2,
                    },
                    satoshis: child_fee.satoshis,
                    script_pubkey: child_fee.script_pubkey.clone(),
                    private_key: owner.clone(),
                };
                fee_parent_for_consume = unlock.clone();
                precursor = Some(unlock);
            } else {
                fee_for_consume = fee.clone();
                fee_parent_for_consume = context.fee_parent.clone();
            }
        } else {
            fee_for_consume = fee.clone();
            fee_parent_for_consume = context.fee_parent.clone();
        }
        let (lp_code, lp_tape) = if let Some(unlock) = precursor.as_ref() {
            let source_parents = context
                .ftlp_inputs
                .iter()
                .rev()
                .map(|input| input.pre_tx.clone())
                .collect::<Vec<_>>();
            validate_local_ftlp_spend(&ftlp, owner, unlock, &source_parents)?
        } else {
            validate_ftlp_spend(&ftlp, owner, &context.ftlp_grandparents[0])?
        };
        validate_ftlp_pool_binding(
            &lp_code,
            &lp_tape,
            ftlp.utxo.ft_balance_raw,
            &context.pool.state,
            &context.pool.pool_utxo.script_pubkey,
            &owner.address(),
            ft_version_number,
            is_coin,
            &metadata,
            ft_tape.as_bytes().len(),
        )?;
        let delta = super::consume_lp(
            &context.pool.state.amounts,
            context.pool.pool_utxo.satoshis,
            lp_raw,
        )?;
        let ft_out = abs_delta_to_u64(delta.ft_a_delta, "Pool FT-A consume")?;
        let tbc_out = abs_delta_to_u64(delta.tbc_sat_delta, "Pool TBC consume")?;
        let pool_out = abs_delta_to_u64(delta.pool_value_delta, "Pool value consume")?;
        let mut next_state = context.pool.state.clone();
        next_state.amounts.ft_lp_raw = next_state
            .amounts
            .ft_lp_raw
            .checked_sub(lp_raw)
            .ok_or_else(|| Error::InvalidUtxo("Pool LP reserve underflow".to_string()))?;
        next_state.amounts.ft_a_raw = next_state
            .amounts
            .ft_a_raw
            .checked_sub(ft_out)
            .ok_or_else(|| Error::InvalidUtxo("Pool FT-A reserve underflow".to_string()))?;
        next_state.amounts.tbc_sat = next_state
            .amounts
            .tbc_sat
            .checked_sub(tbc_out)
            .ok_or_else(|| Error::InvalidUtxo("Pool TBC reserve underflow".to_string()))?;
        let pool_balances = context
            .ft_inputs
            .iter()
            .map(|input| input.utxo.ft_balance_raw)
            .collect::<Vec<_>>();
        let (ft_user_tape, ft_pool_change_tape) =
            build_tape_amount_with_offset(u128::from(ft_out), &pool_balances, 2)?;
        let (lp_burn_tape, lp_change_tape) =
            build_tape_amount_with_offset(u128::from(lp_raw), &[ftlp.utxo.ft_balance_raw], 1)?;
        let pool_hash = crate::hash::sha256(self.pool_code.as_bytes());
        let lp_burn_base = if context.pool.state.ftlp_lock_time_enabled {
            ftlp_tape(&FtlpTapeParams {
                amount_raw: 0,
                layout: FtlpTapeLayout::LockTime {
                    lock_time: 0,
                    source_ft_tape_size: ft_tape.as_bytes().len(),
                },
            })?
        } else {
            standard_ftlp_tape(0, &metadata, is_coin)?
        };
        let mut outputs = vec![
            TxOut {
                satoshis: context
                    .pool
                    .pool_utxo
                    .satoshis
                    .checked_sub(pool_out)
                    .ok_or_else(|| {
                        Error::InvalidUtxo("Pool consume value underflow".to_string())
                    })?,
                script_pubkey: self.pool_code.clone(),
            },
            TxOut {
                satoshis: 0,
                script_pubkey: pool_tape(&next_state)?,
            },
            TxOut {
                satoshis: FT_CODE_SATOSHIS,
                script_pubkey: transfer_code_script(
                    &ft_code,
                    FtCodeReceiver::Address(receiver.clone()),
                )?,
            },
            TxOut {
                satoshis: 0,
                script_pubkey: transfer_tape_script(&ft_tape, &ft_user_tape)?,
            },
            TxOut {
                // Released consume pays the proportional change in the full
                // Pool output value. This can differ from the NTape reserve
                // delta after service-fee-bearing swaps.
                satoshis: pool_out,
                script_pubkey: receiver.script_pubkey(),
            },
            TxOut {
                satoshis: ftlp.utxo.base.satoshis,
                script_pubkey: transfer_ftlp_code_script(
                    &lp_code,
                    &Address::from_string(FTLP_BURN_ADDRESS)?,
                )?,
            },
            TxOut {
                satoshis: 0,
                script_pubkey: transfer_tape_script(&lp_burn_base, &lp_burn_tape)?,
            },
        ];
        if ftlp.utxo.ft_balance_raw > u128::from(lp_raw) {
            outputs.extend([
                TxOut {
                    satoshis: ftlp.utxo.base.satoshis,
                    script_pubkey: transfer_ftlp_code_script(&lp_code, &owner.address())?,
                },
                TxOut {
                    satoshis: 0,
                    script_pubkey: transfer_tape_script(&lp_burn_base, &lp_change_tape)?,
                },
            ]);
        }
        let pool_ft_total = pool_balances.iter().try_fold(0u128, |sum, amount| {
            sum.checked_add(*amount)
                .ok_or_else(|| Error::InvalidUtxo("Pool FT balance overflow".to_string()))
        })?;
        if pool_ft_total > u128::from(ft_out) {
            outputs.extend([
                TxOut {
                    satoshis: FT_CODE_SATOSHIS,
                    script_pubkey: pool_held_ft_code(&ft_code, crate::hash::hash160(&pool_hash))?,
                },
                TxOut {
                    satoshis: 0,
                    script_pubkey: transfer_tape_script(&ft_tape, &ft_pool_change_tape)?,
                },
            ]);
        }
        let input_values = std::iter::once(context.pool.pool_utxo.satoshis)
            .chain(std::iter::once(ftlp.utxo.base.satoshis))
            .chain(
                context
                    .ft_inputs
                    .iter()
                    .map(|input| input.utxo.base.satoshis),
            )
            .chain(std::iter::once(fee_for_consume.satoshis))
            .collect::<Vec<_>>();
        let input_sum = checked_money_sum(&input_values, "Pool consume input")?;
        let output_sum = sum_outputs(&outputs)?;
        let large = super::unlock::uses_large_pool_unlock(&context.pool.pool_utxo.script_pubkey)?;
        let consume = finalize_signed_fee(
            input_sum,
            output_sum,
            DEFAULT_FEE_RATE_SAT_PER_KB,
            DEFAULT_FEE_RATE_SAT_PER_KB,
            ChangePolicy::Optional { dust: SDK_DUST_SAT },
            |change| {
                let mut tx = Transaction::new();
                tx.inputs
                    .push(TxIn::new(context.pool.pool_utxo.outpoint.clone()));
                tx.inputs.push(TxIn::new(ftlp.utxo.base.outpoint.clone()));
                for input in &context.ft_inputs {
                    tx.inputs.push(TxIn::new(input.utxo.base.outpoint.clone()));
                }
                tx.inputs.push(TxIn::new(fee_for_consume.outpoint.clone()));
                if context.pool.state.ftlp_lock_time_enabled {
                    tx.inputs[1].sequence = 0xffff_fffe;
                }
                if is_coin {
                    for input in tx.inputs.iter_mut().skip(2).take(context.ft_inputs.len()) {
                        input.sequence = 0xffff_fffe;
                    }
                }
                tx.outputs.extend_from_slice(&outputs);
                if let Some(change) = change {
                    tx.outputs.push(TxOut {
                        satoshis: change,
                        script_pubkey: fee_for_consume.private_key.address().script_pubkey(),
                    });
                }
                let signature = (!large)
                    .then(|| -> Result<PoolUnlockSignature> {
                        Ok(PoolUnlockSignature {
                            signature_with_hashtype: tx.signature_with_hashtype(
                                0,
                                owner,
                                &context.pool.pool_utxo.script_pubkey,
                                context.pool.pool_utxo.satoshis,
                                DEFAULT_SIGHASH,
                            )?,
                            public_key: owner.public_key(),
                        })
                    })
                    .transpose()?;
                let mut parents = vec![ftlp.pre_tx.clone()];
                parents.extend(context.ft_inputs.iter().map(|input| input.pre_tx.clone()));
                parents.push(fee_parent_for_consume.clone());
                tx.inputs[0].script_sig = Script::from_bytes(pool_unlock(&PoolUnlockContext {
                    transaction: &tx,
                    input_index: 0,
                    spent_vout: 0,
                    pool: &context.pool,
                    input_parents: &parents,
                    option: PoolUnlockOption::ConsumeLiquidity,
                    swap_option: None,
                    with_lock: context.pool.state.public_key_locked,
                    signature: signature.as_ref(),
                    public_key_lock: &context.public_key_lock,
                })?);
                sign_ftlp_input(&mut tx, 1, owner, &ftlp)?;
                for (index, input) in context.ft_inputs.iter().enumerate() {
                    sign_ft_swap_input(
                        &mut tx,
                        index + 2,
                        owner,
                        &input.utxo,
                        &input.pre_tx,
                        &input.pre_pre_tx_data,
                        &context.pool.pool_pre_tx,
                        version_number(&ft_code)?,
                        is_coin,
                    )?;
                }
                let fee_index = context.ft_inputs.len() + 2;
                tx.sign_p2pkh_input(
                    fee_index,
                    &fee_for_consume.private_key,
                    &fee_for_consume.script_pubkey,
                    fee_for_consume.satoshis,
                    DEFAULT_SIGHASH,
                )?;
                Ok(tx)
            },
        )?;
        Ok(precursor
            .into_iter()
            .chain(std::iter::once(consume))
            .collect())
    }

    /// Swaps a caller-supplied TBC fee UTXO for FT-A.  The context is fully
    /// resolved so this builder is deterministic and never performs API I/O.
    pub fn swap_to_token(
        &self,
        context: PoolOperationContext,
        owner: &PrivateKey,
        fee: Utxo,
        tbc_human: &str,
        lp_plan: u8,
    ) -> Result<Transaction> {
        self.swap_to_token_to(context, owner, &owner.address(), fee, tbc_human, lp_plan)
    }

    pub fn swap_to_token_to(
        &self,
        context: PoolOperationContext,
        owner: &PrivateKey,
        receiver: &Address,
        fee: Utxo,
        tbc_human: &str,
        lp_plan: u8,
    ) -> Result<Transaction> {
        validate_operation_context(self, &context, &fee)?;
        if context.ft_inputs.is_empty()
            || context.ft_inputs.len() > MAX_SWAP_POOL_FT_INPUTS
            || !context.ftlp_inputs.is_empty()
        {
            return Err(Error::InvalidUtxo(format!(
                "Pool TBC-to-FT swap requires one to {MAX_SWAP_POOL_FT_INPUTS} pool FT-A inputs and no FT-LP inputs"
            )));
        }
        let plan = effective_swap_plan(&context.pool.state, lp_plan)?;
        let input_sat = parse_decimal_raw(tbc_human, 6)?;
        if fee.satoshis < input_sat {
            return Err(Error::InvalidUtxo(
                "Pool TBC-to-FT swap fee input does not cover the TBC swap amount".to_string(),
            ));
        }
        let mut descriptors = Vec::with_capacity(context.ft_inputs.len());
        for (input, grandparents) in context.ft_inputs.iter().zip(&context.ft_grandparents) {
            let descriptor = validate_pool_ft_spend(input, &context.pool, grandparents)?;
            validate_underlying_ft_binding(
                &descriptor.0,
                &context.pool.state,
                descriptor.5,
                descriptor.3,
            )?;
            descriptors.push(descriptor);
        }
        let (ft_code, ft_tape, metadata, is_coin, _version, ft_version) = descriptors[0].clone();
        if descriptors.iter().any(|descriptor| {
            descriptor.0 != ft_code
                || descriptor.3 != is_coin
                || descriptor.5 != ft_version
                || !same_ft_family_metadata(&descriptor.2, &metadata)
        }) {
            return Err(Error::InvalidUtxo(
                "Pool TBC-to-FT inputs must belong to the same FT family".to_string(),
            ));
        }
        let delta = super::swap_tbc_to_ft(
            &context.pool.state.amounts,
            input_sat,
            context.pool.state.service_fee_rate,
            plan,
        )?;
        let ft_out = abs_delta_to_u64(delta.ft_a_delta, "Pool TBC-to-FT output")?;
        let reserve_in = delta_to_u64(delta.tbc_sat_delta, "Pool TBC reserve increment")?;
        let pool_in = delta_to_u64(delta.pool_value_delta, "Pool TBC-to-FT value increment")?;
        let provider_fee = input_sat.checked_sub(pool_in).ok_or_else(|| {
            Error::InvalidUtxo("Pool TBC-to-FT provider fee underflow".to_string())
        })?;
        let pool_balances = context
            .ft_inputs
            .iter()
            .map(|input| input.utxo.ft_balance_raw)
            .collect::<Vec<_>>();
        let pool_total = sum_ft_balances(&pool_balances, "Pool TBC-to-FT FT inputs")?;
        if pool_total < u128::from(ft_out) {
            return Err(Error::InvalidUtxo(
                "Pool TBC-to-FT swap has insufficient pool FT balance".to_string(),
            ));
        }
        let (owner_tape, pool_change_tape) =
            build_tape_amount_with_offset(u128::from(ft_out), &pool_balances, 2)?;
        let mut next_state = context.pool.state.clone();
        next_state.amounts.ft_a_raw = next_state
            .amounts
            .ft_a_raw
            .checked_sub(ft_out)
            .ok_or_else(|| Error::InvalidUtxo("Pool FT-A reserve underflow".to_string()))?;
        next_state.amounts.tbc_sat = next_state
            .amounts
            .tbc_sat
            .checked_add(reserve_in)
            .ok_or_else(|| Error::InvalidUtxo("Pool TBC reserve overflow".to_string()))?;
        let pool_value = context
            .pool
            .pool_utxo
            .satoshis
            .checked_add(pool_in)
            .ok_or_else(|| Error::InvalidUtxo("Pool TBC-to-FT value overflow".to_string()))?;
        let pool_hash = crate::hash::sha256(self.pool_code.as_bytes());
        let mut outputs = vec![
            TxOut {
                satoshis: pool_value,
                script_pubkey: self.pool_code.clone(),
            },
            TxOut {
                satoshis: POOL_TAPE_SATOSHIS,
                script_pubkey: pool_tape(&next_state)?,
            },
            TxOut {
                satoshis: FT_CODE_SATOSHIS,
                script_pubkey: transfer_code_script(
                    &ft_code,
                    FtCodeReceiver::Address(receiver.clone()),
                )?,
            },
            TxOut {
                satoshis: 0,
                script_pubkey: transfer_tape_script(&ft_tape, &owner_tape)?,
            },
        ];
        if provider_fee >= 10 {
            outputs.push(TxOut {
                satoshis: provider_fee,
                script_pubkey: service_fee_script(plan)?,
            });
        }
        if pool_total > u128::from(ft_out) {
            outputs.extend([
                TxOut {
                    satoshis: FT_CODE_SATOSHIS,
                    script_pubkey: pool_held_ft_code(&ft_code, crate::hash::hash160(&pool_hash))?,
                },
                TxOut {
                    satoshis: 0,
                    script_pubkey: transfer_tape_script(&ft_tape, &pool_change_tape)?,
                },
            ]);
        }
        let input_sum = checked_money_sum(
            &std::iter::once(context.pool.pool_utxo.satoshis)
                .chain(std::iter::once(fee.satoshis))
                .chain(
                    context
                        .ft_inputs
                        .iter()
                        .map(|input| input.utxo.base.satoshis),
                )
                .collect::<Vec<_>>(),
            "Pool TBC-to-FT swap input",
        )?;
        let output_sum = sum_outputs(&outputs)?;
        finalize_signed_fee(
            input_sum,
            output_sum,
            DEFAULT_FEE_RATE_SAT_PER_KB,
            DEFAULT_FEE_RATE_SAT_PER_KB,
            ChangePolicy::Optional { dust: SDK_DUST_SAT },
            |change| {
                let mut tx = Transaction::new();
                tx.inputs
                    .push(TxIn::new(context.pool.pool_utxo.outpoint.clone()));
                tx.inputs.push(TxIn::new(fee.outpoint.clone()));
                for input in &context.ft_inputs {
                    tx.inputs.push(TxIn::new(input.utxo.base.outpoint.clone()));
                }
                if is_coin {
                    for input in tx.inputs.iter_mut().skip(2) {
                        input.sequence = 0xffff_fffe;
                    }
                }
                tx.outputs.extend_from_slice(&outputs);
                if let Some(change) = change {
                    tx.outputs.push(TxOut {
                        satoshis: change,
                        script_pubkey: fee.private_key.address().script_pubkey(),
                    });
                }
                let signature = pool_swap_signature(
                    &tx,
                    &context.pool,
                    owner,
                    context.pool.state.public_key_locked,
                )?;
                let mut parents = vec![context.fee_parent.clone()];
                parents.extend(context.ft_inputs.iter().map(|input| input.pre_tx.clone()));
                tx.inputs[0].script_sig = Script::from_bytes(pool_unlock(&PoolUnlockContext {
                    transaction: &tx,
                    input_index: 0,
                    spent_vout: 0,
                    pool: &context.pool,
                    input_parents: &parents,
                    option: PoolUnlockOption::Swap,
                    swap_option: Some(PoolSwapOption::TbcToFt),
                    with_lock: context.pool.state.public_key_locked,
                    signature: signature.as_ref(),
                    public_key_lock: &context.public_key_lock,
                })?);
                tx.sign_p2pkh_input(
                    1,
                    &fee.private_key,
                    &fee.script_pubkey,
                    fee.satoshis,
                    DEFAULT_SIGHASH,
                )?;
                for (index, input) in context.ft_inputs.iter().enumerate() {
                    sign_ft_swap_input(
                        &mut tx,
                        index + 2,
                        owner,
                        &input.utxo,
                        &input.pre_tx,
                        &input.pre_pre_tx_data,
                        &context.pool.pool_pre_tx,
                        ft_version,
                        is_coin,
                    )?;
                }
                Ok(tx)
            },
        )
    }

    /// Swaps a caller-supplied FT-A UTXO for TBC without resolving network state.
    pub fn swap_to_tbc(
        &self,
        context: PoolOperationContext,
        owner: &PrivateKey,
        fee: Utxo,
        ft_human: &str,
        lp_plan: u8,
    ) -> Result<Transaction> {
        self.swap_to_tbc_core(
            context,
            owner,
            &owner.address(),
            fee,
            ft_human,
            lp_plan,
            None,
        )
    }

    pub fn swap_to_tbc_to(
        &self,
        context: PoolOperationContext,
        owner: &PrivateKey,
        receiver: &Address,
        fee: Utxo,
        ft_human: &str,
        lp_plan: u8,
    ) -> Result<Transaction> {
        self.swap_to_tbc_core(context, owner, receiver, fee, ft_human, lp_plan, None)
    }

    /// Local form of [`Self::swap_to_tbc`].  `local_parents` is an integrity
    /// binding for the exact non-Pool input-parent sequence used in the unlock.
    pub fn swap_to_tbc_local(
        &self,
        local: LocalPoolOperationContext,
        owner: &PrivateKey,
        fee: Utxo,
        ft_human: &str,
        lp_plan: u8,
    ) -> Result<Transaction> {
        self.swap_to_tbc_core(
            local.operation,
            owner,
            &owner.address(),
            fee,
            ft_human,
            lp_plan,
            Some(local.local_parents),
        )
    }

    fn swap_to_tbc_core(
        &self,
        context: PoolOperationContext,
        owner: &PrivateKey,
        receiver: &Address,
        fee: Utxo,
        ft_human: &str,
        lp_plan: u8,
        local_parents: Option<Vec<Transaction>>,
    ) -> Result<Transaction> {
        validate_operation_context(self, &context, &fee)?;
        if context.ft_inputs.len() != 1 || !context.ftlp_inputs.is_empty() {
            return Err(Error::InvalidUtxo(
                "Pool FT-to-TBC swap requires exactly one owner FT-A input and no FT-LP inputs"
                    .to_string(),
            ));
        }
        if let Some(local_parents) = local_parents {
            let expected = vec![
                context.ft_inputs[0].pre_tx.clone(),
                context.fee_parent.clone(),
            ];
            if local_parents != expected {
                return Err(Error::InvalidUtxo(
                    "local Pool FT-to-TBC parent context does not match the signed input order"
                        .to_string(),
                ));
            }
        }
        let plan = effective_swap_plan(&context.pool.state, lp_plan)?;
        let ft = &context.ft_inputs[0];
        let (ft_code, ft_tape, metadata, is_coin, _version, ft_version) =
            validate_ft_spend(ft, owner, &context.ft_grandparents[0])?;
        validate_underlying_ft_binding(&ft_code, &context.pool.state, ft_version, is_coin)?;
        let input_raw = parse_decimal_raw(ft_human, metadata.decimal)?;
        if ft.utxo.ft_balance_raw < u128::from(input_raw) {
            return Err(Error::InvalidUtxo(
                "Pool FT-to-TBC swap has insufficient owner FT balance".to_string(),
            ));
        }
        let delta = super::swap_ft_to_tbc(
            &context.pool.state.amounts,
            input_raw,
            context.pool.state.service_fee_rate,
            plan,
        )?;
        let gross_tbc = abs_delta_to_u64(delta.tbc_sat_delta, "Pool FT-to-TBC gross output")?;
        let pool_out = abs_delta_to_u64(delta.pool_value_delta, "Pool FT-to-TBC value decrement")?;
        let (service, _lp_fee, provider_fee) =
            swap_fee_parts(gross_tbc, context.pool.state.service_fee_rate, plan)?;
        let owner_tbc = gross_tbc.checked_sub(service).ok_or_else(|| {
            Error::InvalidUtxo("Pool FT-to-TBC service fee exceeds output".to_string())
        })?;
        if owner_tbc == 0
            || (provider_fee >= 10 && pool_out != owner_tbc + provider_fee)
            || (provider_fee < 10 && pool_out != owner_tbc)
        {
            return Err(Error::InvalidUtxo(
                "Pool FT-to-TBC released fee accounting is inconsistent".to_string(),
            ));
        }
        let mut next_state = context.pool.state.clone();
        next_state.amounts.ft_a_raw = next_state
            .amounts
            .ft_a_raw
            .checked_add(input_raw)
            .ok_or_else(|| Error::InvalidUtxo("Pool FT-A reserve overflow".to_string()))?;
        next_state.amounts.tbc_sat = next_state
            .amounts
            .tbc_sat
            .checked_sub(gross_tbc)
            .ok_or_else(|| Error::InvalidUtxo("Pool TBC reserve underflow".to_string()))?;
        let pool_value = context
            .pool
            .pool_utxo
            .satoshis
            .checked_sub(pool_out)
            .ok_or_else(|| Error::InvalidUtxo("Pool FT-to-TBC value underflow".to_string()))?;
        let (pool_ft_tape, owner_change_tape) =
            build_tape_amount_with_offset(u128::from(input_raw), &[ft.utxo.ft_balance_raw], 1)?;
        let pool_hash = crate::hash::sha256(self.pool_code.as_bytes());
        let mut outputs = vec![
            TxOut {
                satoshis: pool_value,
                script_pubkey: self.pool_code.clone(),
            },
            TxOut {
                satoshis: POOL_TAPE_SATOSHIS,
                script_pubkey: pool_tape(&next_state)?,
            },
            TxOut {
                satoshis: owner_tbc,
                script_pubkey: receiver.script_pubkey(),
            },
            TxOut {
                satoshis: ft.utxo.base.satoshis,
                script_pubkey: pool_held_ft_code(&ft_code, crate::hash::hash160(&pool_hash))?,
            },
            TxOut {
                satoshis: 0,
                script_pubkey: transfer_tape_script(&ft_tape, &pool_ft_tape)?,
            },
        ];
        if provider_fee >= 10 {
            outputs.push(TxOut {
                satoshis: provider_fee,
                script_pubkey: service_fee_script(plan)?,
            });
        }
        if ft.utxo.ft_balance_raw > u128::from(input_raw) {
            outputs.extend([
                TxOut {
                    satoshis: ft.utxo.base.satoshis,
                    script_pubkey: transfer_code_script(
                        &ft_code,
                        FtCodeReceiver::Address(owner.address()),
                    )?,
                },
                TxOut {
                    satoshis: 0,
                    script_pubkey: transfer_tape_script(&ft_tape, &owner_change_tape)?,
                },
            ]);
        }
        let input_sum = checked_money_sum(
            &[
                context.pool.pool_utxo.satoshis,
                ft.utxo.base.satoshis,
                fee.satoshis,
            ],
            "Pool FT-to-TBC swap input",
        )?;
        let output_sum = sum_outputs(&outputs)?;
        finalize_signed_fee(
            input_sum,
            output_sum,
            DEFAULT_FEE_RATE_SAT_PER_KB,
            DEFAULT_FEE_RATE_SAT_PER_KB,
            ChangePolicy::Optional { dust: SDK_DUST_SAT },
            |change| {
                let mut tx = Transaction::new();
                tx.inputs
                    .push(TxIn::new(context.pool.pool_utxo.outpoint.clone()));
                tx.inputs.push(TxIn::new(ft.utxo.base.outpoint.clone()));
                tx.inputs.push(TxIn::new(fee.outpoint.clone()));
                if is_coin {
                    tx.inputs[1].sequence = 0xffff_fffe;
                }
                tx.outputs.extend_from_slice(&outputs);
                if let Some(change) = change {
                    tx.outputs.push(TxOut {
                        satoshis: change,
                        script_pubkey: fee.private_key.address().script_pubkey(),
                    });
                }
                let signature = pool_swap_signature(
                    &tx,
                    &context.pool,
                    owner,
                    context.pool.state.public_key_locked,
                )?;
                let parents = [ft.pre_tx.clone(), context.fee_parent.clone()];
                tx.inputs[0].script_sig = Script::from_bytes(pool_unlock(&PoolUnlockContext {
                    transaction: &tx,
                    input_index: 0,
                    spent_vout: 0,
                    pool: &context.pool,
                    input_parents: &parents,
                    option: PoolUnlockOption::Swap,
                    swap_option: Some(PoolSwapOption::FtToTbc),
                    with_lock: context.pool.state.public_key_locked,
                    signature: signature.as_ref(),
                    public_key_lock: &context.public_key_lock,
                })?);
                sign_ft_input(
                    &mut tx,
                    1,
                    owner,
                    &ft.utxo,
                    &ft.pre_tx,
                    &ft.pre_pre_tx_data,
                    is_coin,
                )?;
                tx.sign_p2pkh_input(
                    2,
                    &fee.private_key,
                    &fee.script_pubkey,
                    fee.satoshis,
                    DEFAULT_SIGHASH,
                )?;
                Ok(tx)
            },
        )
    }

    /// Removes expired FTLP lock-time encumbrances without querying an API.
    pub fn unlock_ftlp(
        &self,
        owner: &PrivateKey,
        fee: Utxo,
        ftlp: Vec<FtlpSpendContext>,
        current_lock_time: u32,
    ) -> Result<Transaction> {
        let validated = validate_standalone_ftlp_contexts(self, owner, &fee, &ftlp)?;
        if !validated.locked {
            return Err(Error::InvalidUtxo(
                "FTLP unlock is only valid for a lock-time Pool".to_string(),
            ));
        }
        let selected =
            select_ftlp_inputs(&validated, current_lock_time, true, MAX_UNLOCK_FTLP_INPUTS)?;
        if selected.is_empty() {
            return Err(Error::InvalidUtxo("no unlockable FTLP input".to_string()));
        }
        if selected.len() == 1 && ftlp_lock_time(&selected[0])? == 0 {
            return Err(Error::InvalidUtxo(
                "a single already-unlocked FTLP input has no unlock work".to_string(),
            ));
        }
        build_standalone_ftlp_tx(
            owner,
            &fee,
            selected,
            validated.locked,
            current_lock_time,
            validated.source_ft_tape_size,
            FtlpOutputOverride::default(),
        )
    }

    /// Consolidates FTLP fragments.  `None` is reserved for the released
    /// already-merged case (fewer than two eligible inputs).
    pub fn merge_ftlp(
        &self,
        owner: &PrivateKey,
        fee: Utxo,
        ftlp: Vec<FtlpSpendContext>,
        current_lock_time: Option<u32>,
    ) -> Result<Option<Transaction>> {
        let validated = validate_standalone_ftlp_contexts(self, owner, &fee, &ftlp)?;
        let selected = if validated.locked {
            match current_lock_time {
                Some(lock_time) => select_ftlp_inputs(&validated, lock_time, true, 5)?,
                None => validated
                    .inputs
                    .iter()
                    .filter(|input| ftlp_lock_time(input).ok() == Some(0))
                    .take(5)
                    .cloned()
                    .collect(),
            }
        } else {
            validated.inputs.iter().take(5).cloned().collect()
        };
        if selected.len() < 2 {
            return Ok(None);
        }
        let lock_time = current_lock_time.unwrap_or_default();
        Ok(Some(build_standalone_ftlp_tx(
            owner,
            &fee,
            selected,
            validated.locked,
            lock_time,
            validated.source_ft_tape_size,
            FtlpOutputOverride::default(),
        )?))
    }

    /// Sends up to five FTLP fragments to the released eater address.
    pub fn burn_ftlp(
        &self,
        owner: &PrivateKey,
        fee: Utxo,
        ftlp: Vec<FtlpSpendContext>,
    ) -> Result<Transaction> {
        let validated = validate_standalone_ftlp_contexts(self, owner, &fee, &ftlp)?;
        let selected = validated.inputs.iter().take(5).cloned().collect::<Vec<_>>();
        if selected.is_empty() {
            return Err(Error::InvalidUtxo(
                "burn requires an FTLP input".to_string(),
            ));
        }
        if validated.locked {
            let selected_lock_times = selected
                .iter()
                .map(ftlp_lock_time)
                .collect::<Result<Vec<_>>>()?;
            if selected_lock_times.iter().any(|time| *time != 0) {
                return Err(Error::InvalidUtxo(
                    "locked-family FTLP burn requires already-unlocked inputs".to_string(),
                ));
            }
        }
        let eater = Address::from_string(FTLP_BURN_ADDRESS)?;
        let output_code = transfer_ftlp_code_script(&selected[0].utxo.base.script_pubkey, &eater)?;
        build_standalone_ftlp_tx(
            owner,
            &fee,
            selected,
            validated.locked,
            0,
            validated.source_ft_tape_size,
            FtlpOutputOverride {
                code: Some(output_code),
                tape_base: Some(validated.authority_tape),
            },
        )
    }

    /// Consolidates Pool-held FT fragments in caller order.  Each successor
    /// spends the preceding transaction's Pool Code (vout 0) and P2PKH fee
    /// change (vout 4), so the returned transactions form an offline chain.
    pub fn merge_ft_in_pool(
        &self,
        context: PoolOperationContext,
        owner: &PrivateKey,
        fee: Utxo,
        rounds: usize,
    ) -> Result<Vec<Transaction>> {
        validate_operation_context(self, &context, &fee)?;
        // Authenticate every caller-supplied candidate before selecting any
        // round, including fragments that a small `rounds` value will not use.
        for (spend, grandparents) in context.ft_inputs.iter().zip(&context.ft_grandparents) {
            let (code, _, _, is_coin, _, version) =
                validate_pool_ft_spend(spend, &context.pool, grandparents)?;
            validate_underlying_ft_binding(&code, &context.pool.state, version, is_coin)?;
        }
        if context.ft_inputs.len() < 2 || rounds == 0 {
            return Ok(Vec::new());
        }

        let mut result = Vec::new();
        let mut pool = context.pool.clone();
        let mut fee_input = fee;
        let mut fee_parent = context.fee_parent.clone();
        let mut offset = 0usize;
        for _ in 0..rounds {
            let end = (offset + 4).min(context.ft_inputs.len());
            let selected = &context.ft_inputs[offset..end];
            let selected_grandparents = &context.ft_grandparents[offset..end];
            if selected.len() < 2 {
                break;
            }
            let tx = build_merge_pool_ft_round(
                self,
                &pool,
                selected,
                selected_grandparents,
                owner,
                &fee_input,
                &fee_parent,
                &context.public_key_lock,
            )?;
            let next_fee = tx.outputs.get(4).ok_or_else(|| {
                Error::InvalidUtxo("Pool FT merge must retain fee change at vout 4".to_string())
            })?;
            fee_input = Utxo {
                outpoint: crate::OutPoint {
                    txid: tx.txid(),
                    vout: 4,
                },
                satoshis: next_fee.satoshis,
                script_pubkey: next_fee.script_pubkey.clone(),
                private_key: owner.clone(),
            };
            pool = PoolSpendContext {
                pool_utxo: UtxoInfo {
                    outpoint: crate::OutPoint {
                        txid: tx.txid(),
                        vout: 0,
                    },
                    satoshis: tx.outputs[0].satoshis,
                    script_pubkey: tx.outputs[0].script_pubkey.clone(),
                },
                pool_pre_tx: tx.clone(),
                pool_pre_pre_tx: pool.pool_pre_tx,
                contract_tx: pool.contract_tx,
                state: pool.state,
            };
            fee_parent = tx.clone();
            result.push(tx);
            offset = end;
        }
        Ok(result)
    }

    pub fn create_pool(
        &self,
        key: &PrivateKey,
        funding: Utxo,
        tag: &str,
        service_fee_rate: u16,
        lp_plan: u8,
        with_lock_time: bool,
    ) -> Result<Vec<Transaction>> {
        self.create_pool_inner(
            key,
            funding,
            tag,
            None,
            service_fee_rate,
            lp_plan,
            with_lock_time,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_pool_with_lock(
        &self,
        key: &PrivateKey,
        funding: Utxo,
        tag: &str,
        lp_cost_address: Address,
        lp_cost_sat: u64,
        public_keys: &[PublicKey],
        service_fee_rate: u16,
        lp_plan: u8,
        with_lock_time: bool,
    ) -> Result<Vec<Transaction>> {
        self.create_pool_inner(
            key,
            funding,
            tag,
            Some(PoolCreateLock {
                lp_cost_address,
                lp_cost_sat,
                public_keys,
            }),
            service_fee_rate,
            lp_plan,
            with_lock_time,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn create_pool_inner(
        &self,
        key: &PrivateKey,
        funding: Utxo,
        tag: &str,
        lock: Option<PoolCreateLock<'_>>,
        service_fee_rate: u16,
        lp_plan: u8,
        with_lock_time: bool,
    ) -> Result<Vec<Transaction>> {
        validate_create_common(self, key, &funding, service_fee_rate, lp_plan)?;
        if let Some(lock) = &lock {
            validate_money_value(lock.lp_cost_sat, "locked Pool LP cost")?;
        }
        let authority = self.ft_authority.as_ref().ok_or_else(|| {
            Error::InvalidUtxo(
                "Pool creation requires explicit FT authority from released code and tape"
                    .to_string(),
            )
        })?;
        let authority = validate_ft_authority(self.state.ft_a_contract_id, authority)?;
        let ft_code = authority.code;
        let ft_tape = authority.tape;
        let source_output = TxOut {
            satoshis: POOL_MINT_SOURCE_SATOSHIS,
            script_pubkey: pool_mint_source_script(&key.address()),
        };
        let source = build_signed_funding_tx(&funding, key, &[source_output])?;
        let source_outpoint = crate::OutPoint {
            txid: source.txid(),
            vout: 0,
        };
        let params = PoolCodeParams {
            lp_plan,
            ft_version: authority.version,
            is_coin: authority.is_coin,
        };
        let code = if let Some(lock) = &lock {
            locked_pool_code(
                source_outpoint,
                tag.as_bytes(),
                lock.public_keys,
                &LockedPoolCodeParams {
                    pool: params,
                    lp_cost_address: lock.lp_cost_address.clone(),
                    lp_cost_sat: lock.lp_cost_sat,
                },
            )?
        } else {
            pool_code(source_outpoint, tag.as_bytes(), &params)?
        };
        let ftlp_params = FtlpCodeParams::for_tape(&ft_tape, params.ft_version, params.is_coin)?;
        let pool_hash = crate::hash::sha256(code.as_bytes());
        let ftlp = if with_lock_time {
            ftlp_lock_time_code(pool_hash, &key.address(), &ftlp_params)?
        } else {
            ftlp_code(pool_hash, &key.address(), &ftlp_params)?
        };
        let partial_offset = partial_hash_offset(authority.version_number, authority.is_coin)?;
        let mut state = self.state.clone();
        state.amounts = PoolAmounts {
            ft_lp_raw: 0,
            ft_a_raw: 0,
            tbc_sat: 0,
        };
        state.ft_lp_partial_hash =
            calculate_partial_hash(&ftlp.as_bytes()[..partial_offset]).to_vec();
        state.ft_a_partial_hash =
            calculate_partial_hash(&ft_code.as_bytes()[..partial_offset]).to_vec();
        state.service_fee_rate = service_fee_rate;
        state.service_provider = tag.to_string();
        state.lp_plan = lp_plan;
        state.public_key_locked = lock.is_some();
        state.ftlp_lock_time_enabled = with_lock_time;
        let outputs = [
            TxOut {
                satoshis: POOL_CODE_SATOSHIS,
                script_pubkey: code,
            },
            TxOut {
                satoshis: POOL_TAPE_SATOSHIS,
                script_pubkey: pool_tape(&state)?,
            },
        ];
        let mint = build_signed_child_tx(&source, key, &outputs)?;
        Ok(vec![source, mint])
    }
}

/// Builds the address-specific FTLP Code required by the online query facade.
/// The authority is read from the explicit Pool context, so this does not add
/// a second source of FT metadata or transaction-construction logic.
#[cfg(feature = "network-api")]
pub(crate) fn ftlp_code_for_owner(pool: &PoolSpendContext, owner: &Address) -> Result<Script> {
    let authority = resolve_pool_ft_authority(pool)?;
    let tape = if pool.state.ftlp_lock_time_enabled {
        ftlp_tape(&FtlpTapeParams {
            amount_raw: 0,
            layout: FtlpTapeLayout::LockTime {
                lock_time: 0,
                source_ft_tape_size: authority.tape.as_bytes().len(),
            },
        })?
    } else {
        standard_ftlp_tape(0, &authority.metadata, authority.is_coin)?
    };
    let version = match authority.version {
        1 => FtScriptVersion::V1,
        2 => FtScriptVersion::V2,
        3 => FtScriptVersion::V3,
        4 => FtScriptVersion::V4,
        _ => unreachable!("released FT classifier only returns versions 1..=4"),
    };
    let params = FtlpCodeParams::for_tape(&tape, version, authority.is_coin)?;
    let pool_hash = crate::hash::sha256(pool.pool_utxo.script_pubkey.as_bytes());
    if pool.state.ftlp_lock_time_enabled {
        ftlp_lock_time_code(pool_hash, owner, &params)
    } else {
        ftlp_code(pool_hash, owner, &params)
    }
}

pub(crate) fn pool_ft_authority_from_context(pool: &PoolSpendContext) -> Result<PoolFtAuthority> {
    if pool.contract_tx.txid() != pool.state.ft_a_contract_id {
        return Err(Error::InvalidUtxo(
            "Pool FT authority transaction id does not match Pool state".to_string(),
        ));
    }

    let mut candidates = Vec::new();
    for (code_vout, tape_vout) in [(0usize, 1usize), (3usize, 4usize)] {
        let (Some(code_output), Some(tape_output)) = (
            pool.contract_tx.outputs.get(code_vout),
            pool.contract_tx.outputs.get(tape_vout),
        ) else {
            continue;
        };
        if code_output.satoshis != FT_CODE_SATOSHIS || tape_output.satoshis != 0 {
            continue;
        }
        let Ok(classified) = classify_ft_script(&code_output.script_pubkey) else {
            continue;
        };
        // Released ordinary FT authority is exactly 0/1; released Coin is
        // exactly 3/4.  Never infer authority from arbitrary adjacent pairs.
        if (classified.is_coin && (code_vout, tape_vout) != (3, 4))
            || (!classified.is_coin && (code_vout, tape_vout) != (0, 1))
        {
            continue;
        }
        if validate_underlying_ft_binding(
            &code_output.script_pubkey,
            &pool.state,
            classified.version,
            classified.is_coin,
        )
        .is_err()
        {
            continue;
        }
        let metadata = parse_canonical_ft_tape(&tape_output.script_pubkey, classified.is_coin)?;
        candidates.push(PoolFtAuthority {
            info: FtInfo {
                contract_txid: Some(pool.state.ft_a_contract_id.to_string()),
                code_script: hex::encode(code_output.script_pubkey.as_bytes()),
                tape_script: hex::encode(tape_output.script_pubkey.as_bytes()),
                total_supply_raw: metadata.total_supply_raw,
                decimal: metadata.decimal,
                name: metadata.name,
                symbol: metadata.symbol,
            },
            contract_tx: pool.contract_tx.clone(),
        });
    }
    match candidates.len() {
        1 => {
            let authority = candidates.pop().expect("length checked");
            validate_ft_authority(pool.state.ft_a_contract_id, &authority)?;
            Ok(authority)
        }
        0 => Err(Error::InvalidUtxo(
            "Pool authority has no canonical released FT Code/Tape pair".to_string(),
        )),
        _ => Err(Error::InvalidUtxo(
            "Pool authority has multiple canonical released FT Code/Tape pairs".to_string(),
        )),
    }
}

struct PoolCreateLock<'a> {
    lp_cost_address: Address,
    lp_cost_sat: u64,
    public_keys: &'a [PublicKey],
}

fn validate_init_context(
    pool: &PoolNftV2,
    context: &PoolInitContext,
    owner: &PrivateKey,
    fee: &Utxo,
) -> Result<(ValidatedFtAuthority, Vec<u8>)> {
    let contract_id = pool.contract_id.ok_or_else(|| {
        Error::InvalidUtxo("Pool init requires an existing contract id".to_string())
    })?;
    validate_money_value(context.pool.pool_utxo.satoshis, "Pool init Pool Code input")?;
    validate_money_value(context.ft.utxo.base.satoshis, "Pool init FT Code input")?;
    validate_money_value(fee.satoshis, "Pool init fee input")?;
    let pool_pre_output = context.pool.pool_pre_tx.outputs.first().ok_or_else(|| {
        Error::InvalidUtxo("Pool init zero-state transaction is missing output 0".to_string())
    })?;
    if contract_id != context.pool.pool_pre_tx.txid()
        || context.pool.pool_utxo.outpoint.txid != contract_id
        || pool_pre_output.satoshis != context.pool.pool_utxo.satoshis
        || pool_pre_output.script_pubkey != context.pool.pool_utxo.script_pubkey
    {
        return Err(Error::InvalidUtxo(
            "Pool contract id must be the zero-state Pool transaction id".to_string(),
        ));
    }
    if pool.pool_code != context.pool.pool_utxo.script_pubkey || pool.state != context.pool.state {
        return Err(Error::InvalidUtxo(
            "Pool init context does not match the loaded Pool state and Code".to_string(),
        ));
    }
    if context.pool.pool_utxo.outpoint.vout != 0
        || context.pool.pool_utxo.satoshis != POOL_CODE_SATOSHIS
        || context.pool.state.amounts.ft_lp_raw != 0
        || context.pool.state.amounts.ft_a_raw != 0
        || context.pool.state.amounts.tbc_sat != 0
    {
        return Err(Error::InvalidUtxo(
            "Pool init requires the zero-state mint output 0".to_string(),
        ));
    }
    let authority =
        validate_ft_authority(context.pool.state.ft_a_contract_id, &context.ft_authority)?;
    if context.pool.contract_tx != context.ft_authority.contract_tx {
        return Err(Error::InvalidUtxo(
            "Pool init FT contract transaction does not match Pool state".to_string(),
        ));
    }

    let partial_offset = partial_hash_offset(authority.version_number, authority.is_coin)?;
    if calculate_partial_hash(&authority.code.as_bytes()[..partial_offset]).as_slice()
        != context.pool.state.ft_a_partial_hash
    {
        return Err(Error::InvalidUtxo(
            "Pool init FT authority does not match the Pool partial hash".to_string(),
        ));
    }
    let expected_owner_code =
        transfer_code_script(&authority.code, FtCodeReceiver::Address(owner.address()))?;
    if context.ft.utxo.base.script_pubkey != expected_owner_code
        || context.ft.utxo.base.private_key.public_key() != owner.public_key()
    {
        return Err(Error::InvalidUtxo(
            "Pool init FT input is not owned by the supplied key".to_string(),
        ));
    }
    if context.ft.utxo.ft_balance_raw == 0 {
        return Err(Error::InvalidUtxo(
            "Pool init FT input balance must be positive".to_string(),
        ));
    }
    let ft_parent_output = context
        .ft
        .pre_tx
        .outputs
        .get(context.ft.utxo.base.outpoint.vout as usize)
        .ok_or_else(|| Error::InvalidUtxo("Pool init FT parent vout is missing".to_string()))?;
    let ft_parent_tape = context
        .ft
        .pre_tx
        .outputs
        .get(context.ft.utxo.base.outpoint.vout as usize + 1)
        .ok_or_else(|| Error::InvalidUtxo("Pool init FT parent tape is missing".to_string()))?;
    if context.ft.pre_tx.txid() != context.ft.utxo.base.outpoint.txid
        || ft_parent_output.satoshis != context.ft.utxo.base.satoshis
        || ft_parent_output.script_pubkey != context.ft.utxo.base.script_pubkey
        || ft_parent_tape.satoshis != 0
    {
        return Err(Error::InvalidUtxo(
            "Pool init FT input ancestry is inconsistent".to_string(),
        ));
    }
    let parent_metadata =
        parse_canonical_ft_tape(&ft_parent_tape.script_pubkey, authority.is_coin)?;
    if parent_metadata.total_supply_raw != context.ft.utxo.ft_balance_raw
        || parent_metadata.decimal != authority.metadata.decimal
        || parent_metadata.name != authority.metadata.name
        || parent_metadata.symbol != authority.metadata.symbol
        || parent_metadata.coin_suffix != authority.metadata.coin_suffix
    {
        return Err(Error::InvalidUtxo(
            "Pool init FT parent Tape balance or metadata is inconsistent".to_string(),
        ));
    }
    let ft_pre_pre_tx_data = crate::contracts::ft::unlock::pre_pre_tx_data_from_parents(
        &context.ft.pre_tx,
        context.ft.utxo.base.outpoint.vout as usize,
        &context.ft_grandparents,
    )?;
    if ft_pre_pre_tx_data != context.ft.pre_pre_tx_data {
        return Err(Error::InvalidUtxo(
            "Pool init FT pre-pre transaction data does not match grandparents".to_string(),
        ));
    }

    let fee_parent_output = context
        .fee_parent
        .outputs
        .get(fee.outpoint.vout as usize)
        .ok_or_else(|| Error::InvalidUtxo("Pool init fee parent vout is missing".to_string()))?;
    if context.fee_parent.txid() != fee.outpoint.txid
        || fee_parent_output.satoshis != fee.satoshis
        || fee_parent_output.script_pubkey != fee.script_pubkey
        || fee.script_pubkey != fee.private_key.address().script_pubkey()
    {
        return Err(Error::InvalidUtxo(
            "Pool init fee input ancestry, key, or script is inconsistent".to_string(),
        ));
    }
    Ok((authority, ft_pre_pre_tx_data))
}

fn validate_operation_context(
    pool: &PoolNftV2,
    context: &PoolOperationContext,
    fee: &Utxo,
) -> Result<()> {
    if pool.pool_code != context.pool.pool_utxo.script_pubkey || pool.state != context.pool.state {
        return Err(Error::InvalidUtxo(
            "Pool operation context does not match the loaded Pool".to_string(),
        ));
    }
    let pre_code = context
        .pool
        .pool_pre_tx
        .outputs
        .first()
        .ok_or_else(|| Error::InvalidUtxo("Pool parent has no output 0".to_string()))?;
    let pre_tape = context
        .pool
        .pool_pre_tx
        .outputs
        .get(1)
        .ok_or_else(|| Error::InvalidUtxo("Pool parent has no Tape output".to_string()))?;
    if context.pool.pool_utxo.outpoint.vout != 0
        || context.pool.pool_pre_tx.txid() != context.pool.pool_utxo.outpoint.txid
        || pre_code.satoshis != context.pool.pool_utxo.satoshis
        || pre_code.script_pubkey != context.pool.pool_utxo.script_pubkey
        || pre_tape.satoshis != 0
        || PoolState::from_v2_tape(
            &pre_tape.script_pubkey,
            context.pool.state.service_provider.clone(),
        )? != context.pool.state
    {
        return Err(Error::InvalidUtxo(
            "Pool operation state ancestry is inconsistent".to_string(),
        ));
    }
    let minimum_pool_value = POOL_CODE_SATOSHIS
        .checked_add(context.pool.state.amounts.tbc_sat)
        .ok_or_else(|| Error::InvalidUtxo("Pool Code minimum value overflow".to_string()))?;
    if context.pool.pool_utxo.satoshis < minimum_pool_value {
        return Err(Error::InvalidUtxo(format!(
            "Pool Code value is below {POOL_CODE_SATOSHIS} plus the tape TBC reserve"
        )));
    }
    if context.ft_inputs.len() != context.ft_grandparents.len()
        || context.ftlp_inputs.len() != context.ftlp_grandparents.len()
    {
        return Err(Error::InvalidUtxo(
            "Pool operation grandparent sets must match inputs".to_string(),
        ));
    }
    if context
        .ftlp_grandparents
        .iter()
        .any(|grandparents| grandparents.is_empty())
    {
        return Err(Error::InvalidUtxo(
            "caller-supplied FTLP inputs require explicit grandparents".to_string(),
        ));
    }
    validate_distinct_operation_outpoints(context, fee)?;
    let fee_parent = context
        .fee_parent
        .outputs
        .get(fee.outpoint.vout as usize)
        .ok_or_else(|| Error::InvalidUtxo("Pool fee parent vout is missing".to_string()))?;
    if context.fee_parent.txid() != fee.outpoint.txid
        || fee_parent.satoshis != fee.satoshis
        || fee_parent.script_pubkey != fee.script_pubkey
        || fee.script_pubkey != fee.private_key.address().script_pubkey()
    {
        return Err(Error::InvalidUtxo(
            "Pool fee input ancestry, key, or script is inconsistent".to_string(),
        ));
    }
    validate_money_value(context.pool.pool_utxo.satoshis, "Pool Code input")?;
    validate_money_value(fee.satoshis, "Pool fee input")?;
    Ok(())
}

fn validate_distinct_operation_outpoints(context: &PoolOperationContext, fee: &Utxo) -> Result<()> {
    let mut outpoints = Vec::with_capacity(2 + context.ft_inputs.len() + context.ftlp_inputs.len());
    outpoints.push(&context.pool.pool_utxo.outpoint);
    outpoints.extend(
        context
            .ft_inputs
            .iter()
            .map(|input| &input.utxo.base.outpoint),
    );
    outpoints.extend(
        context
            .ftlp_inputs
            .iter()
            .map(|input| &input.utxo.base.outpoint),
    );
    outpoints.push(&fee.outpoint);
    for (index, outpoint) in outpoints.iter().enumerate() {
        if outpoints
            .iter()
            .skip(index + 1)
            .any(|other| *other == *outpoint)
        {
            return Err(Error::InvalidUtxo(
                "Pool operation input outpoints must be distinct".to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_ft_spend(
    spend: &FtSpendContext,
    owner: &PrivateKey,
    grandparents: &[Transaction],
) -> Result<(Script, Script, FtTapeMetadata, bool, FtScriptVersion, u8)> {
    let output = spend
        .pre_tx
        .outputs
        .get(spend.utxo.base.outpoint.vout as usize)
        .ok_or_else(|| Error::InvalidUtxo("FT parent code output is missing".to_string()))?;
    let tape = spend
        .pre_tx
        .outputs
        .get(spend.utxo.base.outpoint.vout as usize + 1)
        .ok_or_else(|| Error::InvalidUtxo("FT parent Tape output is missing".to_string()))?;
    if spend.pre_tx.txid() != spend.utxo.base.outpoint.txid
        || output.satoshis != spend.utxo.base.satoshis
        || output.script_pubkey != spend.utxo.base.script_pubkey
        || tape.satoshis != 0
    {
        return Err(Error::InvalidUtxo(
            "FT input ancestry is inconsistent".to_string(),
        ));
    }
    let classified = classify_ft_script(&output.script_pubkey)?;
    let metadata = parse_canonical_ft_tape(&tape.script_pubkey, classified.is_coin)?;
    if metadata.total_supply_raw != spend.utxo.ft_balance_raw
        || output.script_pubkey
            != transfer_code_script(
                &output.script_pubkey,
                FtCodeReceiver::Address(owner.address()),
            )?
    {
        return Err(Error::InvalidUtxo(
            "FT input is not owned by the supplied key".to_string(),
        ));
    }
    let expected_pre_pre = crate::contracts::ft::unlock::pre_pre_tx_data_from_parents(
        &spend.pre_tx,
        spend.utxo.base.outpoint.vout as usize,
        grandparents,
    )?;
    if expected_pre_pre != spend.pre_pre_tx_data {
        return Err(Error::InvalidUtxo(
            "FT input pre-pre data does not match explicit grandparents".to_string(),
        ));
    }
    let version = match classified.version {
        1 => FtScriptVersion::V1,
        2 => FtScriptVersion::V2,
        3 => FtScriptVersion::V3,
        4 => FtScriptVersion::V4,
        _ => unreachable!(),
    };
    Ok((
        output.script_pubkey.clone(),
        tape.script_pubkey.clone(),
        metadata,
        classified.is_coin,
        version,
        classified.version,
    ))
}

fn validate_pool_ft_spend(
    spend: &FtSpendContext,
    pool: &PoolSpendContext,
    grandparents: &[Transaction],
) -> Result<(Script, Script, FtTapeMetadata, bool, FtScriptVersion, u8)> {
    let output = spend
        .pre_tx
        .outputs
        .get(spend.utxo.base.outpoint.vout as usize)
        .ok_or_else(|| Error::InvalidUtxo("Pool FT parent code output is missing".to_string()))?;
    let tape = spend
        .pre_tx
        .outputs
        .get(spend.utxo.base.outpoint.vout as usize + 1)
        .ok_or_else(|| Error::InvalidUtxo("Pool FT parent Tape output is missing".to_string()))?;
    if spend.pre_tx.txid() != spend.utxo.base.outpoint.txid
        || output.satoshis != spend.utxo.base.satoshis
        || output.script_pubkey != spend.utxo.base.script_pubkey
        || tape.satoshis != 0
    {
        return Err(Error::InvalidUtxo(
            "Pool FT input ancestry is inconsistent".to_string(),
        ));
    }
    let classified = classify_ft_script(&output.script_pubkey)?;
    let metadata = parse_canonical_ft_tape(&tape.script_pubkey, classified.is_coin)?;
    if metadata.total_supply_raw != spend.utxo.ft_balance_raw
        || output.script_pubkey
            != pool_held_ft_code(
                &output.script_pubkey,
                crate::hash::hash160(&pool.pool_utxo.script_pubkey.sha256()),
            )?
    {
        return Err(Error::InvalidUtxo(
            "FT input is not held by this Pool".to_string(),
        ));
    }
    let expected_pre_pre = crate::contracts::ft::unlock::pre_pre_tx_data_from_parents(
        &spend.pre_tx,
        spend.utxo.base.outpoint.vout as usize,
        grandparents,
    )?;
    if expected_pre_pre != spend.pre_pre_tx_data {
        return Err(Error::InvalidUtxo(
            "Pool FT pre-pre data does not match explicit grandparents".to_string(),
        ));
    }
    let version = match classified.version {
        1 => FtScriptVersion::V1,
        2 => FtScriptVersion::V2,
        3 => FtScriptVersion::V3,
        4 => FtScriptVersion::V4,
        _ => unreachable!(),
    };
    Ok((
        output.script_pubkey.clone(),
        tape.script_pubkey.clone(),
        metadata,
        classified.is_coin,
        version,
        classified.version,
    ))
}

fn validate_ftlp_spend(
    spend: &FtlpSpendContext,
    owner: &PrivateKey,
    grandparents: &[Transaction],
) -> Result<(Script, Script)> {
    if grandparents.is_empty() {
        return Err(Error::InvalidUtxo(
            "FTLP input requires explicit grandparents".to_string(),
        ));
    }
    let output = spend
        .pre_tx
        .outputs
        .get(spend.utxo.base.outpoint.vout as usize)
        .ok_or_else(|| Error::InvalidUtxo("FTLP parent code output is missing".to_string()))?;
    let tape = spend
        .pre_tx
        .outputs
        .get(spend.utxo.base.outpoint.vout as usize + 1)
        .ok_or_else(|| Error::InvalidUtxo("FTLP parent Tape output is missing".to_string()))?;
    if spend.pre_tx.txid() != spend.utxo.base.outpoint.txid
        || output.satoshis != spend.utxo.base.satoshis
        || output.script_pubkey != spend.utxo.base.script_pubkey
        || tape.satoshis != 0
        || balance_from_tape(&tape.script_pubkey)? != spend.utxo.ft_balance_raw
    {
        return Err(Error::InvalidUtxo(
            "FTLP input ancestry is inconsistent".to_string(),
        ));
    }
    if output.script_pubkey != transfer_ftlp_code_script(&output.script_pubkey, &owner.address())? {
        return Err(Error::InvalidUtxo(
            "FTLP input is not owned by the supplied key".to_string(),
        ));
    }
    let expected = crate::contracts::ft::unlock::pre_pre_tx_data_from_parents(
        &spend.pre_tx,
        spend.utxo.base.outpoint.vout as usize,
        grandparents,
    )?;
    if expected != spend.pre_pre_tx_data {
        return Err(Error::InvalidUtxo(
            "FTLP pre-pre data does not match explicit grandparents".to_string(),
        ));
    }
    Ok((output.script_pubkey.clone(), tape.script_pubkey.clone()))
}

fn validate_local_ftlp_spend(
    spend: &FtlpSpendContext,
    owner: &PrivateKey,
    unlock: &Transaction,
    source_parents: &[Transaction],
) -> Result<(Script, Script)> {
    if spend.utxo.base.outpoint.txid != unlock.txid() || spend.utxo.base.outpoint.vout != 0 {
        return Err(Error::InvalidUtxo(
            "local FTLP spend does not reference unlock output 0".to_string(),
        ));
    }
    let output = unlock
        .outputs
        .first()
        .ok_or_else(|| Error::InvalidUtxo("local FTLP unlock has no output 0".to_string()))?;
    let tape = unlock
        .outputs
        .get(1)
        .ok_or_else(|| Error::InvalidUtxo("local FTLP unlock has no Tape output".to_string()))?;
    if spend.pre_tx.txid() != unlock.txid()
        || output.satoshis != spend.utxo.base.satoshis
        || output.script_pubkey != spend.utxo.base.script_pubkey
        || tape.satoshis != 0
        || balance_from_tape(&tape.script_pubkey)? != spend.utxo.ft_balance_raw
        || output.script_pubkey
            != transfer_ftlp_code_script(&output.script_pubkey, &owner.address())?
    {
        return Err(Error::InvalidUtxo(
            "local FTLP unlock output is inconsistent".to_string(),
        ));
    }
    let expected =
        crate::contracts::ft::unlock::pre_pre_tx_data_from_parents(unlock, 0, source_parents)?;
    if expected != spend.pre_pre_tx_data {
        return Err(Error::InvalidUtxo(
            "local FTLP pre-pre data does not match unlock ancestry".to_string(),
        ));
    }
    Ok((output.script_pubkey.clone(), tape.script_pubkey.clone()))
}

#[allow(clippy::too_many_arguments)]
fn validate_ftlp_pool_binding(
    code: &Script,
    tape: &Script,
    amount_raw: u128,
    state: &PoolState,
    pool_code: &Script,
    owner: &Address,
    ft_version: u8,
    is_coin: bool,
    metadata: &FtTapeMetadata,
    source_ft_tape_size: usize,
) -> Result<()> {
    let amount_raw = u64::try_from(amount_raw).map_err(|_| {
        Error::InvalidUtxo("FTLP balance exceeds released uint64 range".to_string())
    })?;
    let expected_tape = if state.ftlp_lock_time_enabled {
        ftlp_tape(&FtlpTapeParams {
            amount_raw,
            layout: FtlpTapeLayout::LockTime {
                lock_time: ftlp_lock_time_from_tape(tape)?,
                source_ft_tape_size,
            },
        })?
    } else {
        standard_ftlp_tape(amount_raw, metadata, is_coin)?
    };
    // Released FTLP transfers and merges preserve each source amount in the
    // 48-byte balance slots, for both standard and lock-time families.  The
    // amount sum and ancestry are checked separately; require every
    // structural byte outside those source slots to remain canonical.
    let actual = tape.as_bytes();
    let expected = expected_tape.as_bytes();
    let tape_matches_released_layout = actual.len() == expected.len()
        && actual.get(..3) == expected.get(..3)
        && actual.get(51..) == expected.get(51..);
    if !tape_matches_released_layout {
        return Err(Error::InvalidUtxo(
            "FTLP Tape does not use this Pool's released layout".to_string(),
        ));
    }
    let version = match ft_version {
        1 => FtScriptVersion::V1,
        2 => FtScriptVersion::V2,
        3 => FtScriptVersion::V3,
        4 => FtScriptVersion::V4,
        _ => {
            return Err(Error::InvalidUtxo(
                "unsupported Pool FT version".to_string(),
            ));
        }
    };
    let params = FtlpCodeParams::for_tape(tape, version, is_coin)?;
    let expected_code = if state.ftlp_lock_time_enabled {
        ftlp_lock_time_code(crate::hash::sha256(pool_code.as_bytes()), owner, &params)?
    } else {
        ftlp_code(crate::hash::sha256(pool_code.as_bytes()), owner, &params)?
    };
    if code != &expected_code
        || calculate_partial_hash(&code.as_bytes()[..partial_hash_offset(ft_version, is_coin)?])
            .as_slice()
            != state.ft_lp_partial_hash.as_slice()
    {
        return Err(Error::InvalidUtxo(
            "FTLP input does not belong to this Pool".to_string(),
        ));
    }
    Ok(())
}

fn validate_underlying_ft_binding(
    code: &Script,
    state: &PoolState,
    version: u8,
    is_coin: bool,
) -> Result<()> {
    if calculate_partial_hash(&code.as_bytes()[..partial_hash_offset(version, is_coin)?]).as_slice()
        != state.ft_a_partial_hash.as_slice()
    {
        return Err(Error::InvalidUtxo(
            "FT-A input does not match the Pool FT partial hash".to_string(),
        ));
    }
    Ok(())
}

fn ftlp_lock_time(spend: &FtlpSpendContext) -> Result<u32> {
    let tape = spend
        .pre_tx
        .outputs
        .get(spend.utxo.base.outpoint.vout as usize + 1)
        .ok_or_else(|| Error::InvalidUtxo("FTLP Tape output is missing".to_string()))?;
    ftlp_lock_time_from_tape(&tape.script_pubkey)
}

fn ftlp_lock_time_from_tape(tape: &Script) -> Result<u32> {
    let chunks = canonical_op_return_chunks(tape)?;
    let bytes: [u8; 4] = chunks
        .get(1)
        .filter(|value| value.len() == 4)
        .ok_or_else(|| Error::InvalidUtxo("FTLP lock-time Tape is malformed".to_string()))?
        .as_slice()
        .try_into()
        .expect("length checked");
    Ok(u32::from_le_bytes(bytes))
}

fn sign_ftlp_input(
    tx: &mut Transaction,
    index: usize,
    owner: &PrivateKey,
    spend: &FtlpSpendContext,
) -> Result<()> {
    let utxo = crate::FtUtxo {
        base: Utxo {
            outpoint: spend.utxo.base.outpoint.clone(),
            satoshis: spend.utxo.base.satoshis,
            script_pubkey: spend.utxo.base.script_pubkey.clone(),
            private_key: owner.clone(),
        },
        ft_balance_raw: spend.utxo.ft_balance_raw,
    };
    sign_ft_input(
        tx,
        index,
        owner,
        &utxo,
        &spend.pre_tx,
        &spend.pre_pre_tx_data,
        false,
    )
}

struct StandaloneFtlpValidation {
    inputs: Vec<FtlpSpendContext>,
    locked: bool,
    source_ft_tape_size: usize,
    authority_tape: Script,
}

#[derive(Default)]
struct FtlpOutputOverride {
    code: Option<Script>,
    tape_base: Option<Script>,
}

fn validate_standalone_ftlp_contexts(
    pool_nft: &PoolNftV2,
    owner: &PrivateKey,
    fee: &Utxo,
    inputs: &[FtlpSpendContext],
) -> Result<StandaloneFtlpValidation> {
    let first = inputs.first().ok_or_else(|| {
        Error::InvalidUtxo("FTLP lifecycle requires at least one input".to_string())
    })?;
    let pool = first.pool.as_ref().ok_or_else(|| {
        Error::InvalidUtxo("FTLP lifecycle requires an explicit Pool context".to_string())
    })?;
    let fee_parent = first.fee_parent.as_ref().ok_or_else(|| {
        Error::InvalidUtxo("FTLP lifecycle requires an explicit fee parent".to_string())
    })?;
    if inputs.iter().any(|input| {
        input.pool.as_ref() != Some(pool) || input.fee_parent.as_ref() != Some(fee_parent)
    }) {
        return Err(Error::InvalidUtxo(
            "FTLP lifecycle inputs must share Pool and fee-parent context".to_string(),
        ));
    }
    let operation = PoolOperationContext {
        pool: pool.clone(),
        ft_inputs: vec![],
        ftlp_inputs: inputs.to_vec(),
        ft_grandparents: vec![],
        ftlp_grandparents: inputs
            .iter()
            .map(|input| input.grandparents.clone())
            .collect(),
        fee_parent: fee_parent.clone(),
        public_key_lock: vec![],
        locked_lp_cost: None,
    };
    validate_operation_context(pool_nft, &operation, fee)?;

    if pool.contract_tx.txid() != pool.state.ft_a_contract_id {
        return Err(Error::InvalidUtxo(
            "FTLP Pool authority does not match Pool state".to_string(),
        ));
    }
    let authority = resolve_pool_ft_authority(pool)?;
    for input in inputs {
        validate_money_value(input.utxo.base.satoshis, "FTLP lifecycle input")?;
        let (code, tape) = validate_ftlp_spend(input, owner, &input.grandparents)?;
        validate_ftlp_pool_binding(
            &code,
            &tape,
            input.utxo.ft_balance_raw,
            &pool.state,
            &pool.pool_utxo.script_pubkey,
            &owner.address(),
            authority.version,
            authority.is_coin,
            &authority.metadata,
            authority.tape.as_bytes().len(),
        )?;
    }
    Ok(StandaloneFtlpValidation {
        inputs: inputs.to_vec(),
        locked: pool.state.ftlp_lock_time_enabled,
        source_ft_tape_size: authority.tape.as_bytes().len(),
        authority_tape: authority.tape,
    })
}

struct ResolvedPoolFtAuthority {
    tape: Script,
    metadata: FtTapeMetadata,
    is_coin: bool,
    version: u8,
}

fn resolve_pool_ft_authority(pool: &PoolSpendContext) -> Result<ResolvedPoolFtAuthority> {
    let authority = pool_ft_authority_from_context(pool)?;
    let validated = validate_ft_authority(pool.state.ft_a_contract_id, &authority)?;
    Ok(ResolvedPoolFtAuthority {
        tape: validated.tape,
        metadata: validated.metadata,
        is_coin: validated.is_coin,
        version: validated.version_number,
    })
}

fn select_ftlp_inputs(
    validated: &StandaloneFtlpValidation,
    current_lock_time: u32,
    require_current: bool,
    limit: usize,
) -> Result<Vec<FtlpSpendContext>> {
    if !validated.locked {
        return Ok(validated.inputs.iter().take(limit).cloned().collect());
    }
    if require_current && current_lock_time == 0 {
        return Err(Error::InvalidUtxo(
            "lock-time FTLP selection requires a current height or timestamp".to_string(),
        ));
    }
    let current_is_height = current_lock_time < 500_000_000;
    let mut selected = Vec::new();
    for input in &validated.inputs {
        let lock_time = ftlp_lock_time(input)?;
        if lock_time == 0 {
            selected.push(input.clone());
        } else {
            let input_is_height = lock_time < 500_000_000;
            if input_is_height != current_is_height {
                return Err(Error::InvalidUtxo(
                    "FTLP lock-time domain does not match current lock time".to_string(),
                ));
            }
            if lock_time <= current_lock_time {
                selected.push(input.clone());
            }
        }
        if selected.len() == limit {
            break;
        }
    }
    Ok(selected)
}

fn build_standalone_ftlp_tx(
    owner: &PrivateKey,
    fee: &Utxo,
    inputs: Vec<FtlpSpendContext>,
    locked: bool,
    lock_time: u32,
    source_ft_tape_size: usize,
    output: FtlpOutputOverride,
) -> Result<Transaction> {
    let first = inputs
        .first()
        .ok_or_else(|| Error::InvalidUtxo("missing FTLP input".to_string()))?;
    let (_, first_tape) = validate_ftlp_spend(first, owner, &first.grandparents)?;
    let total = sum_ft_balances(
        &inputs
            .iter()
            .map(|input| input.utxo.ft_balance_raw)
            .collect::<Vec<_>>(),
        "FTLP lifecycle",
    )?;
    let balances = inputs
        .iter()
        .map(|input| input.utxo.ft_balance_raw)
        .collect::<Vec<_>>();
    let (amount_tape, change_tape) = build_tape_amount_with_offset(total, &balances, 0)?;
    if change_tape.iter().any(|byte| *byte != 0) {
        return Err(Error::InvalidUtxo(
            "FTLP lifecycle change is not zero".to_string(),
        ));
    }
    let tape_script = if let Some(authority_tape) = output.tape_base {
        ftlp_burn_tape(&authority_tape, &amount_tape)?
    } else {
        let base_tape = if locked {
            ftlp_tape(&FtlpTapeParams {
                amount_raw: 0,
                layout: FtlpTapeLayout::LockTime {
                    lock_time: 0,
                    source_ft_tape_size,
                },
            })?
        } else {
            first_tape
        };
        transfer_tape_script(&base_tape, &amount_tape)?
    };
    let code = output.code.unwrap_or(transfer_ftlp_code_script(
        &first.utxo.base.script_pubkey,
        &owner.address(),
    )?);
    let outputs = vec![
        TxOut {
            satoshis: FTLP_CODE_SATOSHIS,
            script_pubkey: code,
        },
        TxOut {
            satoshis: 0,
            script_pubkey: tape_script,
        },
    ];
    let input_sum = checked_money_sum(
        &inputs
            .iter()
            .map(|input| input.utxo.base.satoshis)
            .chain(std::iter::once(fee.satoshis))
            .collect::<Vec<_>>(),
        "FTLP lifecycle input",
    )?;
    let output_sum = sum_outputs(&outputs)?;
    finalize_signed_fee(
        input_sum,
        output_sum,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        ChangePolicy::Required {
            minimum: SDK_DUST_SAT,
        },
        |change| {
            let mut tx = Transaction::new();
            for input in &inputs {
                tx.inputs.push(TxIn::new(input.utxo.base.outpoint.clone()));
            }
            tx.inputs.push(TxIn::new(fee.outpoint.clone()));
            if locked {
                for input in tx.inputs.iter_mut().take(inputs.len()) {
                    input.sequence = 0xffff_fffe;
                }
                tx.lock_time = lock_time;
            }
            tx.outputs.extend_from_slice(&outputs);
            tx.outputs.push(TxOut {
                satoshis: change.expect("required FTLP lifecycle change"),
                script_pubkey: owner.address().script_pubkey(),
            });
            for (index, input) in inputs.iter().enumerate() {
                sign_ftlp_input(&mut tx, index, owner, input)?;
            }
            tx.sign_p2pkh_input(
                inputs.len(),
                &fee.private_key,
                &fee.script_pubkey,
                fee.satoshis,
                DEFAULT_SIGHASH,
            )?;
            Ok(tx)
        },
    )
}

fn ftlp_burn_tape(authority_tape: &Script, amount_tape: &[u8; 48]) -> Result<Script> {
    transfer_tape_script(authority_tape, amount_tape)
}

#[allow(clippy::too_many_arguments)]
fn build_merge_pool_ft_round(
    pool_nft: &PoolNftV2,
    pool: &PoolSpendContext,
    inputs: &[FtSpendContext],
    grandparents: &[Vec<Transaction>],
    owner: &PrivateKey,
    fee: &Utxo,
    fee_parent: &Transaction,
    public_key_lock: &[PublicKey],
) -> Result<Transaction> {
    if !(2..=4).contains(&inputs.len()) || inputs.len() != grandparents.len() {
        return Err(Error::InvalidUtxo(
            "Pool FT merge requires two to four inputs".to_string(),
        ));
    }
    let operation = PoolOperationContext {
        pool: pool.clone(),
        ft_inputs: inputs.to_vec(),
        ftlp_inputs: vec![],
        ft_grandparents: grandparents.to_vec(),
        ftlp_grandparents: vec![],
        fee_parent: fee_parent.clone(),
        public_key_lock: public_key_lock.to_vec(),
        locked_lp_cost: None,
    };
    validate_operation_context(pool_nft, &operation, fee)?;
    let mut validated = Vec::new();
    for (input, parents) in inputs.iter().zip(grandparents) {
        let value = validate_pool_ft_spend(input, pool, parents)?;
        validate_underlying_ft_binding(&value.0, &pool.state, value.5, value.3)?;
        validated.push(value);
    }
    let (code, tape, metadata, is_coin, _, version) = &validated[0];
    for (_, _, other, other_coin, _, other_version) in validated.iter().skip(1) {
        if other.decimal != metadata.decimal
            || other.name != metadata.name
            || other.symbol != metadata.symbol
            || other.coin_suffix != metadata.coin_suffix
            || other_coin != is_coin
            || other_version != version
        {
            return Err(Error::InvalidUtxo(
                "Pool FT merge inputs are not one canonical family".to_string(),
            ));
        }
    }
    let balances = inputs
        .iter()
        .map(|input| input.utxo.ft_balance_raw)
        .collect::<Vec<_>>();
    let total = sum_ft_balances(&balances, "Pool FT merge")?;
    let (amount_tape, change_tape) = build_tape_amount_with_offset(total, &balances, 1)?;
    if change_tape.iter().any(|byte| *byte != 0) {
        return Err(Error::InvalidUtxo(
            "Pool FT merge change is not zero".to_string(),
        ));
    }
    let pool_hash = crate::hash::sha256(pool.pool_utxo.script_pubkey.as_bytes());
    let outputs = vec![
        TxOut {
            satoshis: pool.pool_utxo.satoshis,
            script_pubkey: pool.pool_utxo.script_pubkey.clone(),
        },
        TxOut {
            satoshis: 0,
            script_pubkey: pool_tape(&pool.state)?,
        },
        TxOut {
            satoshis: FT_CODE_SATOSHIS,
            script_pubkey: pool_held_ft_code(code, crate::hash::hash160(&pool_hash))?,
        },
        TxOut {
            satoshis: 0,
            script_pubkey: transfer_tape_script(tape, &amount_tape)?,
        },
    ];
    let input_sum = checked_money_sum(
        &std::iter::once(pool.pool_utxo.satoshis)
            .chain(inputs.iter().map(|input| input.utxo.base.satoshis))
            .chain(std::iter::once(fee.satoshis))
            .collect::<Vec<_>>(),
        "Pool FT merge input",
    )?;
    let output_sum = sum_outputs(&outputs)?;
    let large = super::unlock::uses_large_pool_unlock(&pool.pool_utxo.script_pubkey)?;
    finalize_signed_fee(
        input_sum,
        output_sum,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        ChangePolicy::Required {
            minimum: SDK_DUST_SAT,
        },
        |change| {
            let mut tx = Transaction::new();
            tx.inputs.push(TxIn::new(pool.pool_utxo.outpoint.clone()));
            for input in inputs {
                tx.inputs.push(TxIn::new(input.utxo.base.outpoint.clone()));
            }
            tx.inputs.push(TxIn::new(fee.outpoint.clone()));
            if *is_coin {
                for input in tx.inputs.iter_mut().skip(1).take(inputs.len()) {
                    input.sequence = 0xffff_fffe;
                }
            }
            tx.outputs.extend_from_slice(&outputs);
            tx.outputs.push(TxOut {
                satoshis: change.expect("required Pool FT merge change"),
                script_pubkey: owner.address().script_pubkey(),
            });
            let signature = (!large)
                .then(|| -> Result<PoolUnlockSignature> {
                    Ok(PoolUnlockSignature {
                        signature_with_hashtype: tx.signature_with_hashtype(
                            0,
                            owner,
                            &pool.pool_utxo.script_pubkey,
                            pool.pool_utxo.satoshis,
                            DEFAULT_SIGHASH,
                        )?,
                        public_key: owner.public_key(),
                    })
                })
                .transpose()?;
            let mut parents = inputs
                .iter()
                .map(|input| input.pre_tx.clone())
                .collect::<Vec<_>>();
            parents.push(fee_parent.clone());
            tx.inputs[0].script_sig = Script::from_bytes(pool_unlock(&PoolUnlockContext {
                transaction: &tx,
                input_index: 0,
                spent_vout: 0,
                pool,
                input_parents: &parents,
                option: PoolUnlockOption::MergePoolFt,
                swap_option: None,
                with_lock: pool.state.public_key_locked,
                signature: signature.as_ref(),
                public_key_lock,
            })?);
            for (index, input) in inputs.iter().enumerate() {
                sign_ft_swap_input(
                    &mut tx,
                    index + 1,
                    owner,
                    &input.utxo,
                    &input.pre_tx,
                    &input.pre_pre_tx_data,
                    &pool.pool_pre_tx,
                    *version,
                    *is_coin,
                )?;
            }
            tx.sign_p2pkh_input(
                inputs.len() + 1,
                &fee.private_key,
                &fee.script_pubkey,
                fee.satoshis,
                DEFAULT_SIGHASH,
            )?;
            Ok(tx)
        },
    )
}

fn build_ftlp_unlock(
    context: &PoolOperationContext,
    owner: &PrivateKey,
    fee: &Utxo,
    lock_time: u32,
) -> Result<Transaction> {
    if context.ftlp_inputs.is_empty() || context.ftlp_inputs.len() > MAX_UNLOCK_FTLP_INPUTS {
        return Err(Error::InvalidUtxo(
            "FTLP unlock requires one to six inputs".to_string(),
        ));
    }
    for (input, grandparents) in context.ftlp_inputs.iter().zip(&context.ftlp_grandparents) {
        validate_ftlp_spend(input, owner, grandparents)?;
    }
    let first = &context.ftlp_inputs[0];
    let (_, source_tape) = validate_ftlp_spend(first, owner, &context.ftlp_grandparents[0])?;
    let total = context.ftlp_inputs.iter().try_fold(0u128, |sum, input| {
        sum.checked_add(input.utxo.ft_balance_raw)
            .ok_or_else(|| Error::InvalidUtxo("FTLP balance overflow".to_string()))
    })?;
    let balances = context
        .ftlp_inputs
        .iter()
        .map(|input| input.utxo.ft_balance_raw)
        .collect::<Vec<_>>();
    let (amount_tape, change_tape) = build_tape_amount_with_offset(total, &balances, 0)?;
    if change_tape.iter().any(|byte| *byte != 0) {
        return Err(Error::InvalidUtxo(
            "FTLP unlock must consume all selected LP inputs".to_string(),
        ));
    }
    let unlock_tape = ftlp_tape(&FtlpTapeParams {
        amount_raw: 0,
        layout: FtlpTapeLayout::LockTime {
            lock_time: 0,
            source_ft_tape_size: source_tape.as_bytes().len(),
        },
    })?;
    let outputs = vec![
        TxOut {
            satoshis: FTLP_CODE_SATOSHIS,
            script_pubkey: transfer_ftlp_code_script(
                &first.utxo.base.script_pubkey,
                &owner.address(),
            )?,
        },
        TxOut {
            satoshis: 0,
            script_pubkey: transfer_tape_script(&unlock_tape, &amount_tape)?,
        },
    ];
    let input_sum = checked_money_sum(
        &context
            .ftlp_inputs
            .iter()
            .map(|input| input.utxo.base.satoshis)
            .chain(std::iter::once(fee.satoshis))
            .collect::<Vec<_>>(),
        "FTLP unlock input",
    )?;
    let output_sum = sum_outputs(&outputs)?;
    finalize_signed_fee(
        input_sum,
        output_sum,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        ChangePolicy::Required {
            minimum: SDK_DUST_SAT,
        },
        |change| {
            let mut tx = Transaction::new();
            for input in &context.ftlp_inputs {
                tx.inputs.push(TxIn::new(input.utxo.base.outpoint.clone()));
            }
            tx.inputs.push(TxIn::new(fee.outpoint.clone()));
            for input in tx.inputs.iter_mut().take(context.ftlp_inputs.len()) {
                input.sequence = 0xffff_fffe;
            }
            tx.lock_time = lock_time;
            tx.outputs.append(&mut outputs.clone());
            tx.outputs.push(TxOut {
                satoshis: change.expect("required change"),
                script_pubkey: owner.address().script_pubkey(),
            });
            for (index, input) in context.ftlp_inputs.iter().enumerate() {
                sign_ftlp_input(&mut tx, index, owner, input)?;
            }
            tx.sign_p2pkh_input(
                context.ftlp_inputs.len(),
                &fee.private_key,
                &fee.script_pubkey,
                fee.satoshis,
                DEFAULT_SIGHASH,
            )?;
            Ok(tx)
        },
    )
}

fn delta_to_u64(delta: i128, subject: &str) -> Result<u64> {
    u64::try_from(delta).map_err(|_| Error::InvalidUtxo(format!("{subject} is outside u64 range")))
}

fn effective_swap_plan(state: &PoolState, requested: u8) -> Result<u8> {
    // Released JS/Go gives the persistent Pool plan unconditional precedence.
    // Canonical Pool v2 NTape parsing normally makes the fallback unreachable.
    if (1..=6).contains(&state.lp_plan) {
        return Ok(state.lp_plan);
    }
    if !(1..=6).contains(&requested) {
        return Err(Error::InvalidUtxo(
            "Pool swap LP plan must be in 1..=6".to_string(),
        ));
    }
    Ok(requested)
}

fn service_fee_script(plan: u8) -> Result<Script> {
    let index = usize::from(
        plan.checked_sub(1)
            .ok_or_else(|| Error::InvalidUtxo("Pool service-fee plan underflow".to_string()))?,
    );
    Ok(
        Address::from_string(SERVICE_FEE_ADDRESSES.get(index).ok_or_else(|| {
            Error::InvalidUtxo("Pool service-fee plan must be in 1..=6".to_string())
        })?)?
        .script_pubkey(),
    )
}

fn sum_ft_balances(balances: &[u128], subject: &str) -> Result<u128> {
    balances.iter().try_fold(0u128, |sum, balance| {
        sum.checked_add(*balance)
            .ok_or_else(|| Error::InvalidUtxo(format!("{subject} balance overflow")))
    })
}

fn same_ft_family_metadata(left: &FtTapeMetadata, right: &FtTapeMetadata) -> bool {
    // The 48-byte FT Tape amount is per UTXO.  It is deliberately excluded:
    // Pool input fragments are legal when their balances differ.
    left.decimal == right.decimal
        && left.name == right.name
        && left.symbol == right.symbol
        && left.coin_suffix == right.coin_suffix
}

fn swap_fee_parts(amount: u64, service_fee_rate: u16, lp_plan: u8) -> Result<(u64, u64, u64)> {
    if !(1..=6).contains(&lp_plan) {
        return Err(Error::InvalidUtxo(
            "Pool swap LP plan must be in 1..=6".to_string(),
        ));
    }
    let minimum_rate = if lp_plan == 1 { 10 } else { 5 };
    if service_fee_rate < minimum_rate {
        return Err(Error::InvalidUtxo(format!(
            "Pool swap service fee rate must be at least {minimum_rate}"
        )));
    }
    let lp_rate = super::math::lp_fee_rate(service_fee_rate, lp_plan)?;
    let service = u128::from(amount)
        .checked_mul(u128::from(service_fee_rate))
        .ok_or_else(|| Error::InvalidUtxo("Pool swap service fee overflow".to_string()))?
        / 10_000;
    let lp = u128::from(amount)
        .checked_mul(u128::from(lp_rate))
        .ok_or_else(|| Error::InvalidUtxo("Pool swap LP fee overflow".to_string()))?
        / 10_000;
    let provider = service
        .checked_sub(lp)
        .ok_or_else(|| Error::InvalidUtxo("Pool swap provider fee underflow".to_string()))?;
    Ok((
        u64::try_from(service)
            .map_err(|_| Error::InvalidUtxo("Pool swap service fee overflow".to_string()))?,
        u64::try_from(lp)
            .map_err(|_| Error::InvalidUtxo("Pool swap LP fee overflow".to_string()))?,
        u64::try_from(provider)
            .map_err(|_| Error::InvalidUtxo("Pool swap provider fee overflow".to_string()))?,
    ))
}

fn pool_swap_signature(
    tx: &Transaction,
    pool: &PoolSpendContext,
    owner: &PrivateKey,
    locked: bool,
) -> Result<Option<PoolUnlockSignature>> {
    locked
        .then(|| {
            Ok(PoolUnlockSignature {
                signature_with_hashtype: tx.signature_with_hashtype(
                    0,
                    owner,
                    &pool.pool_utxo.script_pubkey,
                    pool.pool_utxo.satoshis,
                    DEFAULT_SIGHASH,
                )?,
                public_key: owner.public_key(),
            })
        })
        .transpose()
}

fn abs_delta_to_u64(delta: i128, subject: &str) -> Result<u64> {
    delta
        .checked_abs()
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| Error::InvalidUtxo(format!("{subject} is outside u64 range")))
}
fn version_number(code: &Script) -> Result<u8> {
    Ok(classify_ft_script(code)?.version)
}

fn validate_create_common(
    pool: &PoolNftV2,
    key: &PrivateKey,
    funding: &Utxo,
    service_fee_rate: u16,
    lp_plan: u8,
) -> Result<()> {
    if pool.contract_id.is_some() || !pool.pool_code.as_bytes().is_empty() {
        return Err(Error::InvalidUtxo(
            "Pool creation requires a fresh for_create handle".to_string(),
        ));
    }
    if pool.state.amounts.ft_lp_raw != 0
        || pool.state.amounts.ft_a_raw != 0
        || pool.state.amounts.tbc_sat != 0
    {
        return Err(Error::InvalidUtxo(
            "Pool creation state amounts must all be zero".to_string(),
        ));
    }
    if !(1..=6).contains(&lp_plan) {
        return Err(Error::InvalidUtxo(
            "Pool LP plan must be in 1..=6".to_string(),
        ));
    }
    let expected_rate = match lp_plan {
        1 | 2 => 35,
        3 => 135,
        4 => 335,
        5 => 535,
        6 => 330,
        _ => unreachable!(),
    };
    if service_fee_rate != expected_rate {
        return Err(Error::InvalidUtxo(format!(
            "Pool service fee rate must be {expected_rate} for LP plan {lp_plan}"
        )));
    }
    validate_money_value(funding.satoshis, "Pool funding amount")?;
    if funding.private_key.public_key() != key.public_key()
        || funding.script_pubkey != key.address().script_pubkey()
    {
        return Err(Error::InvalidUtxo(
            "Pool funding key or script does not match the creator".to_string(),
        ));
    }
    Ok(())
}

fn validate_ft_authority(
    ft_contract_id: Txid,
    authority: &PoolFtAuthority,
) -> Result<ValidatedFtAuthority> {
    let authority_id = authority
        .info
        .contract_txid
        .as_deref()
        .ok_or_else(|| {
            Error::InvalidUtxo("Pool FT authority requires an explicit contract id".to_string())
        })?
        .parse::<Txid>()
        .map_err(|_| {
            Error::InvalidUtxo("Pool FT authority contains an invalid contract id".to_string())
        })?;
    if authority_id != ft_contract_id || authority.contract_tx.txid() != ft_contract_id {
        return Err(Error::InvalidUtxo(
            "Pool FT authority transaction and contract id must match".to_string(),
        ));
    }
    if authority.contract_tx.inputs.is_empty() {
        return Err(Error::InvalidUtxo(
            "Pool FT authority transaction must contain a real mint input".to_string(),
        ));
    }

    let code = Script::from_bytes(hex::decode(&authority.info.code_script)?);
    let tape = Script::from_bytes(hex::decode(&authority.info.tape_script)?);
    let classified = classify_ft_script(&code)?;
    let (code_vout, tape_vout) = if classified.is_coin { (3, 4) } else { (0, 1) };
    let code_output = authority
        .contract_tx
        .outputs
        .get(code_vout)
        .ok_or_else(|| {
            Error::InvalidUtxo(format!(
                "Pool FT authority is missing released Code output {code_vout}"
            ))
        })?;
    let tape_output = authority
        .contract_tx
        .outputs
        .get(tape_vout)
        .ok_or_else(|| {
            Error::InvalidUtxo(format!(
                "Pool FT authority is missing released Tape output {tape_vout}"
            ))
        })?;
    if code_output.satoshis != FT_CODE_SATOSHIS
        || code_output.script_pubkey != code
        || tape_output.satoshis != 0
        || tape_output.script_pubkey != tape
    {
        return Err(Error::InvalidUtxo(
            "Pool FT authority released outputs do not match FtInfo".to_string(),
        ));
    }

    let version = match classified.version {
        1 => FtScriptVersion::V1,
        2 => FtScriptVersion::V2,
        3 => FtScriptVersion::V3,
        4 => FtScriptVersion::V4,
        _ => unreachable!("FT classifier only returns versions 1..=4"),
    };
    let metadata = parse_canonical_ft_tape(&tape, classified.is_coin)?;
    if metadata.total_supply_raw != authority.info.total_supply_raw
        || metadata.decimal != authority.info.decimal
        || metadata.name != authority.info.name
        || metadata.symbol != authority.info.symbol
    {
        return Err(Error::InvalidUtxo(
            "Pool FT authority Tape metadata does not match FtInfo".to_string(),
        ));
    }
    if metadata.decimal > 18 {
        return Err(Error::InvalidUtxo(
            "Pool FT authority decimal cannot exceed 18".to_string(),
        ));
    }

    Ok(ValidatedFtAuthority {
        code,
        tape,
        version,
        version_number: classified.version,
        is_coin: classified.is_coin,
        metadata,
    })
}

fn parse_canonical_ft_tape(tape: &Script, is_coin: bool) -> Result<FtTapeMetadata> {
    let chunks = canonical_op_return_chunks(tape)?;
    let valid_length = if is_coin {
        chunks.len() == 6
    } else {
        chunks.len() == 5
    };
    if !valid_length
        || chunks.first().is_none_or(|amount| amount.len() != 48)
        || chunks.get(1).is_none_or(|decimal| decimal.len() != 1)
        || chunks.last().map(Vec::as_slice) != Some(b"FTape")
        || (!is_coin && chunks.len() != 5)
        || (chunks.len() == 6 && chunks.get(4).is_none_or(|suffix| suffix.len() != 4))
    {
        return Err(Error::InvalidScript(
            "Pool FT Tape must contain amount, decimal, name, symbol, optional coin suffix, and FTape"
                .to_string(),
        ));
    }

    let name = String::from_utf8(chunks[2].clone())
        .map_err(|_| Error::InvalidScript("Pool FT Tape name is not UTF-8".to_string()))?;
    let symbol = String::from_utf8(chunks[3].clone())
        .map_err(|_| Error::InvalidScript("Pool FT Tape symbol is not UTF-8".to_string()))?;
    let coin_suffix = if chunks.len() == 6 {
        Some(
            chunks[4]
                .as_slice()
                .try_into()
                .expect("coin suffix length checked"),
        )
    } else {
        None
    };
    Ok(FtTapeMetadata {
        total_supply_raw: balance_from_tape(tape)?,
        decimal: chunks[1][0],
        name,
        symbol,
        coin_suffix,
    })
}

fn canonical_op_return_chunks(script: &Script) -> Result<Vec<Vec<u8>>> {
    let bytes = script.as_bytes();
    if !bytes.starts_with(&[
        crate::script::opcodes::OP_FALSE,
        crate::script::opcodes::OP_RETURN,
    ]) {
        return Err(Error::InvalidScript(
            "Tape must start with OP_FALSE OP_RETURN".to_string(),
        ));
    }
    let mut chunks = Vec::new();
    let mut index = 2usize;
    while index < bytes.len() {
        let opcode = bytes[index];
        index += 1;
        let length = match opcode {
            0x00..=0x4b => opcode as usize,
            crate::script::opcodes::OP_PUSHDATA1 => {
                let length = *bytes.get(index).ok_or_else(|| {
                    Error::InvalidScript("truncated FT Tape OP_PUSHDATA1".to_string())
                })? as usize;
                index += 1;
                length
            }
            crate::script::opcodes::OP_PUSHDATA2 => {
                let raw: [u8; 2] = bytes
                    .get(index..index + 2)
                    .ok_or_else(|| {
                        Error::InvalidScript("truncated FT Tape OP_PUSHDATA2".to_string())
                    })?
                    .try_into()
                    .expect("slice length checked");
                index += 2;
                u16::from_le_bytes(raw) as usize
            }
            crate::script::opcodes::OP_PUSHDATA4 => {
                let raw: [u8; 4] = bytes
                    .get(index..index + 4)
                    .ok_or_else(|| {
                        Error::InvalidScript("truncated FT Tape OP_PUSHDATA4".to_string())
                    })?
                    .try_into()
                    .expect("slice length checked");
                index += 4;
                usize::try_from(u32::from_le_bytes(raw)).map_err(|_| {
                    Error::InvalidScript("FT Tape push length does not fit usize".to_string())
                })?
            }
            _ => {
                return Err(Error::InvalidScript(
                    "Pool FT Tape contains a non-push opcode".to_string(),
                ));
            }
        };
        let end = index
            .checked_add(length)
            .ok_or_else(|| Error::InvalidScript("Pool FT Tape push length overflow".to_string()))?;
        let chunk = bytes.get(index..end).ok_or_else(|| {
            Error::InvalidScript("Pool FT Tape contains a truncated push".to_string())
        })?;
        chunks.push(chunk.to_vec());
        index = end;
    }

    if Script::op_return(&chunks) != *script {
        return Err(Error::InvalidScript(
            "Tape pushes must use canonical minimal encoding".to_string(),
        ));
    }
    Ok(chunks)
}

fn partial_hash_offset(ft_version: u8, is_coin: bool) -> Result<usize> {
    match (ft_version, is_coin) {
        (_, true) => Ok(1_984),
        (1, false) => Ok(1_536),
        (2 | 3, false) => Ok(1_856),
        (4, false) => Ok(2_048),
        _ => Err(Error::InvalidScript(
            "unsupported Pool FT authority family".to_string(),
        )),
    }
}

fn standard_ftlp_tape(
    amount_raw: u64,
    source_metadata: &FtTapeMetadata,
    is_coin: bool,
) -> Result<Script> {
    // FTLP is a distinct six-decimal asset, regardless of the paired FT's precision.
    ftlp_tape(&FtlpTapeParams {
        amount_raw,
        layout: FtlpTapeLayout::Standard {
            decimal: 6,
            name: &source_metadata.name,
            symbol: &source_metadata.symbol,
            is_coin,
        },
    })
}

fn pool_mint_source_script(address: &Address) -> Script {
    Script::from_asm(&format!(
        "OP_DUP OP_HASH160 {} OP_EQUALVERIFY OP_CHECKSIG OP_RETURN {}",
        hex::encode(address.hash160()),
        hex::encode(POOL_MINT_SOURCE_MARKER)
    ))
    .expect("static Pool mint source ASM is valid")
}

fn build_signed_funding_tx(
    funding: &Utxo,
    key: &PrivateKey,
    outputs: &[TxOut],
) -> Result<Transaction> {
    let output_sum = sum_outputs(outputs)?;
    finalize_signed_fee(
        funding.satoshis,
        output_sum,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        ChangePolicy::Optional { dust: SDK_DUST_SAT },
        |change| {
            let mut tx = Transaction::new();
            tx.inputs.push(TxIn::new(funding.outpoint.clone()));
            tx.outputs.extend_from_slice(outputs);
            if let Some(change) = change {
                validate_money_value(change, "Pool funding change")?;
                tx.outputs.push(TxOut {
                    satoshis: change,
                    script_pubkey: key.address().script_pubkey(),
                });
            }
            tx.sign_p2pkh_input(
                0,
                key,
                &funding.script_pubkey,
                funding.satoshis,
                DEFAULT_SIGHASH,
            )?;
            Ok(tx)
        },
    )
}

fn build_signed_child_tx(
    source: &Transaction,
    key: &PrivateKey,
    outputs: &[TxOut],
) -> Result<Transaction> {
    let source_output = source
        .outputs
        .first()
        .ok_or_else(|| Error::InvalidUtxo("Pool source output 0 is missing".to_string()))?;
    let output_sum = sum_outputs(outputs)?;
    finalize_signed_fee(
        source_output.satoshis,
        output_sum,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        DEFAULT_FEE_RATE_SAT_PER_KB,
        ChangePolicy::Optional { dust: SDK_DUST_SAT },
        |change| {
            let mut tx = Transaction::new();
            tx.add_input_from_prev_tx(source, 0)?;
            tx.outputs.extend_from_slice(outputs);
            if let Some(change) = change {
                validate_money_value(change, "Pool mint change")?;
                tx.outputs.push(TxOut {
                    satoshis: change,
                    script_pubkey: key.address().script_pubkey(),
                });
            }
            tx.sign_p2pkh_input(
                0,
                key,
                &source_output.script_pubkey,
                source_output.satoshis,
                DEFAULT_SIGHASH,
            )?;
            Ok(tx)
        },
    )
}

fn sum_outputs(outputs: &[TxOut]) -> Result<u64> {
    outputs.iter().try_fold(0u64, |sum, output| {
        validate_pool_output_value(output)?;
        let next = sum
            .checked_add(output.satoshis)
            .ok_or_else(|| Error::InvalidUtxo("Pool output amount overflow".to_string()))?;
        if next > MAX_MONEY_SAT {
            return Err(Error::InvalidUtxo(
                "Pool output total is outside consensus MoneyRange".to_string(),
            ));
        }
        Ok(next)
    })
}

fn validate_money_value(value: u64, subject: &str) -> Result<()> {
    if !(1..=MAX_MONEY_SAT).contains(&value) {
        return Err(Error::InvalidUtxo(format!(
            "{subject} is outside consensus MoneyRange"
        )));
    }
    Ok(())
}

fn checked_money_sum(values: &[u64], subject: &str) -> Result<u64> {
    values.iter().try_fold(0u64, |sum, value| {
        validate_money_value(*value, subject)?;
        let next = sum
            .checked_add(*value)
            .ok_or_else(|| Error::InvalidUtxo(format!("{subject} total overflow")))?;
        if next > MAX_MONEY_SAT {
            return Err(Error::InvalidUtxo(format!(
                "{subject} total is outside consensus MoneyRange"
            )));
        }
        Ok(next)
    })
}

fn validate_pool_output_value(output: &TxOut) -> Result<()> {
    if output.satoshis != 0 {
        return validate_money_value(output.satoshis, "Pool Code output amount");
    }
    let chunks = canonical_op_return_chunks(&output.script_pubkey)?;
    let marker = chunks.last().map(Vec::as_slice);
    if marker != Some(b"FTape") && marker != Some(b"NTape") {
        return Err(Error::InvalidUtxo(
            "zero-satoshi Pool output must be a canonical Tape".to_string(),
        ));
    }
    if marker == Some(b"FTape") {
        let standard = parse_canonical_ft_tape(&output.script_pubkey, false).is_ok()
            || parse_canonical_ft_tape(&output.script_pubkey, true).is_ok();
        let lock_time = chunks.len() >= 3
            && chunks.first().is_some_and(|amount| amount.len() == 48)
            && chunks.get(1).is_some_and(|lock_time| lock_time.len() == 4)
            && chunks[2..chunks.len() - 1].iter().all(Vec::is_empty);
        if !standard && !lock_time {
            return Err(Error::InvalidUtxo(
                "zero-satoshi FT output must use a canonical FT Tape layout".to_string(),
            ));
        }
    } else if super::PoolState::from_v2_tape(&output.script_pubkey, String::new()).is_err() {
        return Err(Error::InvalidUtxo(
            "zero-satoshi Pool output must use a canonical Pool Tape layout".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    use super::{PoolFtAuthority, PoolInitContext, PoolNftV2};
    use crate::{
        Address, ApiClient, FtInfo, FtUtxo, OutPoint, PrivateKey, StableCoin, Transaction, TxIn,
        TxOut, Txid, Utxo, UtxoInfo,
        contracts::pool_nft_v2::{
            FtSpendContext, FtlpSpendContext, LocalPoolOperationContext, LockedLpCost,
            PoolOperationContext, PoolSpendContext, scripts::transfer_ftlp_code_script,
        },
    };

    fn ft_info() -> FtInfo {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/pool-v2-js-165.json"))
                .unwrap();
        let mut amount = [0u8; 48];
        amount[..8].copy_from_slice(&2_500_000u64.to_le_bytes());
        let tape = crate::contracts::ft::scripts::mint_tape_script(
            &amount,
            6,
            fixture["ftName"].as_str().unwrap(),
            fixture["ftSymbol"].as_str().unwrap(),
        );
        assert_eq!(
            tape.as_bytes().len(),
            fixture["ftTapeSize"].as_u64().unwrap() as usize
        );
        FtInfo {
            contract_txid: None,
            code_script: fixture["ftCodeHex"].as_str().unwrap().to_string(),
            tape_script: hex::encode(tape.as_bytes()),
            total_supply_raw: 2_500_000,
            decimal: 6,
            name: fixture["ftName"].as_str().unwrap().to_string(),
            symbol: fixture["ftSymbol"].as_str().unwrap().to_string(),
        }
    }

    fn released_family_authority(parent_index: usize) -> PoolFtAuthority {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/pool-v2-unlock-js-165.json"
        ))
        .unwrap();
        let raw = fixture["vectors"]["option1_standard"]["inputParentRaws"][parent_index]
            .as_str()
            .unwrap();
        let parent = crate::Transaction::from_hex(raw).unwrap();
        let code = parent.outputs[0].script_pubkey.clone();
        let classified = crate::contracts::ft::unlock::classify_ft_script(&code).unwrap();
        let metadata =
            super::parse_canonical_ft_tape(&parent.outputs[1].script_pubkey, classified.is_coin)
                .or_else(|_| {
                    super::parse_canonical_ft_tape(&parent.outputs[1].script_pubkey, false)
                })
                .unwrap();
        let info = FtInfo {
            contract_txid: Some(parent.txid().to_string()),
            code_script: hex::encode(parent.outputs[0].script_pubkey.as_bytes()),
            tape_script: hex::encode(parent.outputs[1].script_pubkey.as_bytes()),
            total_supply_raw: metadata.total_supply_raw,
            decimal: metadata.decimal,
            name: metadata.name,
            symbol: metadata.symbol,
        };
        PoolFtAuthority {
            info,
            contract_tx: parent,
        }
    }

    fn funding(key: &PrivateKey, satoshis: u64) -> Utxo {
        Utxo {
            outpoint: OutPoint {
                txid: "0101010101010101010101010101010101010101010101010101010101010101"
                    .parse()
                    .unwrap(),
                vout: 0,
            },
            satoshis,
            script_pubkey: key.address().script_pubkey(),
            private_key: key.clone(),
        }
    }

    fn transaction_with_outputs(outputs: Vec<TxOut>, nonce: u8) -> Transaction {
        let mut transaction = Transaction::new();
        transaction.inputs.push(TxIn::new(OutPoint {
            txid: Txid::from_le_bytes([nonce; 32]),
            vout: 0,
        }));
        transaction.outputs = outputs;
        transaction
    }

    fn authority_from_info(mut info: FtInfo, nonce: u8) -> PoolFtAuthority {
        let contract_tx = transaction_with_outputs(
            vec![
                TxOut {
                    satoshis: 500,
                    script_pubkey: crate::script::Script::from_bytes(
                        hex::decode(&info.code_script).unwrap(),
                    ),
                },
                TxOut {
                    satoshis: 0,
                    script_pubkey: crate::script::Script::from_bytes(
                        hex::decode(&info.tape_script).unwrap(),
                    ),
                },
            ],
            nonce,
        );
        info.contract_txid = Some(contract_tx.txid().to_string());
        PoolFtAuthority { info, contract_tx }
    }

    fn real_stable_coin_authority() -> PoolFtAuthority {
        let admin = PrivateKey::from_slice(&[47; 32]).unwrap();
        let funding_prev_tx = transaction_with_outputs(
            vec![TxOut {
                satoshis: 20_000,
                script_pubkey: admin.address().script_pubkey(),
            }],
            95,
        );
        let funding = Utxo {
            outpoint: OutPoint {
                txid: funding_prev_tx.txid(),
                vout: 0,
            },
            satoshis: 20_000,
            script_pubkey: admin.address().script_pubkey(),
            private_key: admin.clone(),
        };
        let mut coin =
            StableCoin::new("USD Coin".to_string(), "USDC".to_string(), 1_000_000, 6).unwrap();
        let finalized = coin
            .create_coin(
                admin.x_only_public_key(),
                admin.clone(),
                admin.address(),
                funding,
                funding_prev_tx,
                None,
            )
            .unwrap()
            .finalize_with_admin_key(&admin)
            .unwrap();
        let info = FtInfo {
            contract_txid: Some(finalized.contract_txid),
            code_script: coin.code_script,
            tape_script: coin.tape_script,
            total_supply_raw: coin.total_supply_raw,
            decimal: coin.decimal,
            name: coin.name,
            symbol: coin.symbol,
        };
        PoolFtAuthority {
            info,
            contract_tx: finalized.mint,
        }
    }

    fn independently_verify_input_signature(
        transaction: &Transaction,
        input_index: usize,
        locking_script: &crate::script::Script,
        satoshis: u64,
        public_key: &crate::PublicKey,
    ) {
        let digest = transaction
            .sighash_digest(
                input_index,
                locking_script,
                satoshis,
                crate::DEFAULT_SIGHASH,
            )
            .unwrap();
        let script = transaction.inputs[input_index].script_sig.as_bytes();
        let public_key_bytes = public_key.to_bytes();
        let mut verified = false;
        for public_key_start in 1..script.len().saturating_sub(public_key_bytes.len()) + 1 {
            if script.get(public_key_start - 1) != Some(&(public_key_bytes.len() as u8))
                || script.get(public_key_start..public_key_start + public_key_bytes.len())
                    != Some(public_key_bytes.as_slice())
            {
                continue;
            }
            let signature_end = public_key_start - 1;
            for push_start in 0..signature_end {
                let signature_len = script[push_start] as usize;
                if !(8..=75).contains(&signature_len)
                    || push_start + 1 + signature_len != signature_end
                {
                    continue;
                }
                let signature = &script[push_start + 1..signature_end];
                if signature.last().copied() != Some((crate::DEFAULT_SIGHASH & 0xff) as u8) {
                    continue;
                }
                if public_key
                    .verify_ecdsa_digest(&digest, &signature[..signature.len() - 1])
                    .unwrap_or(false)
                {
                    verified = true;
                    break;
                }
            }
        }
        assert!(
            verified,
            "input {input_index} has no independently valid signature"
        );
    }

    fn assert_exact_signed_fee(transaction: &Transaction, input_sum: u64) {
        assert_eq!(
            crate::builder::paid_fee(transaction, input_sum).unwrap(),
            crate::builder::fee_for_size(
                transaction.serialize().len(),
                crate::DEFAULT_FEE_RATE_SAT_PER_KB,
            ),
            "fee must match the finalized signed size exactly"
        );
    }

    struct LpFixture {
        zero_pool: PoolNftV2,
        init_context: PoolInitContext,
        pool: PoolNftV2,
        owner: PrivateKey,
        fee: Utxo,
        increase: PoolOperationContext,
        consume: PoolOperationContext,
    }

    fn lp_fixture(locked_pool: bool, with_lock_time: bool) -> LpFixture {
        lp_fixture_with_plan(locked_pool, with_lock_time, 1)
    }

    fn lp_fixture_with_plan(locked_pool: bool, with_lock_time: bool, lp_plan: u8) -> LpFixture {
        let owner = PrivateKey::from_slice(&[81; 32]).unwrap();
        let fee_key = PrivateKey::from_slice(&[82; 32]).unwrap();
        let authority = authority_from_info(ft_info(), 83);
        let ft_code =
            crate::script::Script::from_bytes(hex::decode(&authority.info.code_script).unwrap());
        let ft_tape =
            crate::script::Script::from_bytes(hex::decode(&authority.info.tape_script).unwrap());
        let create =
            PoolNftV2::for_create(authority.contract_tx.txid(), authority.clone()).unwrap();
        let lock_keys = vec![owner.public_key()];
        let created = if locked_pool {
            create
                .create_pool_with_lock(
                    &owner,
                    funding(&owner, 100_000),
                    "lp-fixture",
                    Address::from_hash160([0x44; 20]),
                    24,
                    &lock_keys,
                    35,
                    lp_plan,
                    with_lock_time,
                )
                .unwrap()
        } else {
            create
                .create_pool(
                    &owner,
                    funding(&owner, 100_000),
                    "lp-fixture",
                    35,
                    lp_plan,
                    with_lock_time,
                )
                .unwrap()
        };
        let zero_state = super::PoolState::from_v2_tape(
            &created[1].outputs[1].script_pubkey,
            "lp-fixture".to_string(),
        )
        .unwrap();
        let zero_pool = PoolNftV2 {
            contract_id: Some(created[1].txid()),
            state: zero_state.clone(),
            current_pool_value_sat: Some(created[1].outputs[0].satoshis),
            pool_code: created[1].outputs[0].script_pubkey.clone(),
            ft_authority: None,
        };

        let grandparent = transaction_with_outputs(
            vec![TxOut {
                satoshis: 500,
                script_pubkey: ft_code.clone(),
            }],
            84,
        );
        let owned_code = crate::contracts::ft::scripts::transfer_code_script(
            &ft_code,
            crate::contracts::ft::scripts::FtCodeReceiver::Address(owner.address()),
        )
        .unwrap();
        let amount = crate::contracts::ft::amount::build_tape_amount(5_000_000, &[5_000_000])
            .unwrap()
            .0;
        let mut ft_parent = transaction_with_outputs(
            vec![
                TxOut {
                    satoshis: 500,
                    script_pubkey: owned_code.clone(),
                },
                TxOut {
                    satoshis: 0,
                    script_pubkey: crate::contracts::ft::scripts::transfer_tape_script(
                        &ft_tape, &amount,
                    )
                    .unwrap(),
                },
            ],
            85,
        );
        ft_parent.inputs[0].previous_output = OutPoint {
            txid: grandparent.txid(),
            vout: 0,
        };
        let ft_pre_pre = crate::contracts::ft::unlock::pre_pre_tx_data_from_parents(
            &ft_parent,
            0,
            std::slice::from_ref(&grandparent),
        )
        .unwrap();
        let init_ft = FtSpendContext {
            utxo: FtUtxo {
                base: Utxo {
                    outpoint: OutPoint {
                        txid: ft_parent.txid(),
                        vout: 0,
                    },
                    satoshis: 500,
                    script_pubkey: owned_code,
                    private_key: owner.clone(),
                },
                ft_balance_raw: 5_000_000,
            },
            pre_tx: ft_parent.clone(),
            pre_pre_tx_data: ft_pre_pre,
        };
        let fee_parent = transaction_with_outputs(
            vec![TxOut {
                satoshis: 100_000,
                script_pubkey: fee_key.address().script_pubkey(),
            }],
            86,
        );
        let fee = Utxo {
            outpoint: OutPoint {
                txid: fee_parent.txid(),
                vout: 0,
            },
            satoshis: 100_000,
            script_pubkey: fee_key.address().script_pubkey(),
            private_key: fee_key,
        };
        let init_context = PoolInitContext {
            pool: PoolSpendContext {
                pool_utxo: UtxoInfo {
                    outpoint: OutPoint {
                        txid: created[1].txid(),
                        vout: 0,
                    },
                    satoshis: 1_000,
                    script_pubkey: created[1].outputs[0].script_pubkey.clone(),
                },
                pool_pre_tx: created[1].clone(),
                pool_pre_pre_tx: created[0].clone(),
                contract_tx: authority.contract_tx.clone(),
                state: zero_state,
            },
            ft: init_ft,
            ft_authority: authority.clone(),
            ft_grandparents: vec![grandparent],
            fee_parent: fee_parent.clone(),
            lp_receiver: owner.address(),
            public_key_lock: if locked_pool {
                lock_keys.clone()
            } else {
                vec![]
            },
        };
        let initialized = zero_pool
            .init_pool(
                init_context.clone(),
                &owner,
                fee.clone(),
                "0.01",
                "2.5",
                if with_lock_time { 5_000 } else { 0 },
            )
            .unwrap();
        let state = super::PoolState::from_v2_tape(
            &initialized.outputs[1].script_pubkey,
            "lp-fixture".to_string(),
        )
        .unwrap();
        let pool = PoolNftV2 {
            contract_id: Some(created[1].txid()),
            state: state.clone(),
            current_pool_value_sat: Some(initialized.outputs[0].satoshis),
            pool_code: initialized.outputs[0].script_pubkey.clone(),
            ft_authority: None,
        };
        // JavaScript 1.6.6 inserts the locked LP-cost payment at output 6,
        // before the ordinary FT-A change pair.
        let change_index = if locked_pool { 7 } else { 6 };
        let change_pre_pre = crate::contracts::ft::unlock::pre_pre_tx_data_from_parents(
            &initialized,
            change_index,
            std::slice::from_ref(&ft_parent),
        )
        .unwrap();
        let increase_ft = FtSpendContext {
            utxo: FtUtxo {
                base: Utxo {
                    outpoint: OutPoint {
                        txid: initialized.txid(),
                        vout: change_index as u32,
                    },
                    satoshis: 500,
                    script_pubkey: initialized.outputs[change_index].script_pubkey.clone(),
                    private_key: owner.clone(),
                },
                ft_balance_raw: 2_500_000,
            },
            pre_tx: initialized.clone(),
            pre_pre_tx_data: change_pre_pre,
        };
        let reserve_pre_pre = crate::contracts::ft::unlock::pre_pre_tx_data_from_parents(
            &initialized,
            2,
            std::slice::from_ref(&ft_parent),
        )
        .unwrap();
        let reserve_ft = FtSpendContext {
            utxo: FtUtxo {
                base: Utxo {
                    outpoint: OutPoint {
                        txid: initialized.txid(),
                        vout: 2,
                    },
                    satoshis: 500,
                    script_pubkey: initialized.outputs[2].script_pubkey.clone(),
                    private_key: owner.clone(),
                },
                ft_balance_raw: 2_500_000,
            },
            pre_tx: initialized.clone(),
            pre_pre_tx_data: reserve_pre_pre,
        };
        let lp_pre_pre = crate::contracts::ft::unlock::pre_pre_tx_data_from_parents(
            &initialized,
            4,
            std::slice::from_ref(&created[1]),
        )
        .unwrap();
        let ftlp = FtlpSpendContext {
            utxo: crate::FtlpUtxo {
                base: UtxoInfo {
                    outpoint: OutPoint {
                        txid: initialized.txid(),
                        vout: 4,
                    },
                    satoshis: 500,
                    script_pubkey: initialized.outputs[4].script_pubkey.clone(),
                },
                ft_balance_raw: u128::from(state.amounts.ft_lp_raw),
            },
            pre_tx: initialized.clone(),
            pre_pre_tx_data: lp_pre_pre,
            grandparents: vec![created[1].clone()],
            pool: None,
            fee_parent: None,
        };
        let pool_spend = PoolSpendContext {
            pool_utxo: UtxoInfo {
                outpoint: OutPoint {
                    txid: initialized.txid(),
                    vout: 0,
                },
                satoshis: initialized.outputs[0].satoshis,
                script_pubkey: initialized.outputs[0].script_pubkey.clone(),
            },
            pool_pre_tx: initialized.clone(),
            pool_pre_pre_tx: created[1].clone(),
            contract_tx: authority.contract_tx,
            state,
        };
        let locked_lp_cost = locked_pool.then_some(LockedLpCost {
            address: Address::from_hash160([0x44; 20]),
            satoshis: 24,
        });
        LpFixture {
            zero_pool,
            init_context,
            pool,
            owner,
            fee: fee.clone(),
            increase: PoolOperationContext {
                pool: pool_spend.clone(),
                ft_inputs: vec![increase_ft],
                ftlp_inputs: vec![],
                ft_grandparents: vec![vec![ft_parent.clone()]],
                ftlp_grandparents: vec![],
                fee_parent: fee_parent.clone(),
                public_key_lock: if locked_pool {
                    lock_keys.clone()
                } else {
                    vec![]
                },
                locked_lp_cost: locked_lp_cost.clone(),
            },
            consume: PoolOperationContext {
                pool: pool_spend,
                ft_inputs: vec![reserve_ft],
                ftlp_inputs: vec![ftlp],
                ft_grandparents: vec![vec![ft_parent]],
                ftlp_grandparents: vec![vec![created[1].clone()]],
                fee_parent,
                public_key_lock: if locked_pool { lock_keys } else { vec![] },
                locked_lp_cost,
            },
        }
    }

    fn mock_api_sequence(responses: Vec<String>) -> (String, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            responses
                .into_iter()
                .map(|body| {
                    let (mut stream, _) = listener.accept().unwrap();
                    let mut request = [0u8; 8_192];
                    let read = stream.read(&mut request).unwrap();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(), body
                    );
                    stream.write_all(response.as_bytes()).unwrap();
                    String::from_utf8_lossy(&request[..read]).into_owned()
                })
                .collect()
        });
        (format!("http://{address}/api/tbc/"), handle)
    }

    fn raw_response(transaction: &Transaction) -> String {
        serde_json::json!({"code": 200, "data": {"txraw": transaction.to_hex()}}).to_string()
    }

    fn raw_request_path(transaction: &Transaction) -> String {
        format!("/api/tbc/txraw/txid/{}", transaction.txid())
    }

    fn pool_info_request_path(contract_id: Txid) -> String {
        format!("/api/tbc/pool/poolinfo/poolid/{contract_id}")
    }

    fn assert_request_paths(requests: Vec<String>, expected: Vec<String>) {
        let actual = requests
            .iter()
            .map(|request| {
                request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .expect("mock request must contain an HTTP request path")
                    .to_string()
            })
            .collect::<Vec<_>>();
        assert_eq!(actual, expected);
    }

    fn operation_responses(context: &PoolOperationContext) -> Vec<String> {
        let mut responses = vec![
            pool_info_response(context),
            raw_response(&context.pool.pool_pre_pre_tx),
            raw_response(&context.pool.pool_pre_tx),
            raw_response(&context.pool.pool_pre_tx),
            raw_response(&context.pool.pool_pre_pre_tx),
            raw_response(&context.pool.contract_tx),
        ];
        for (input, grandparents) in context.ft_inputs.iter().zip(&context.ft_grandparents) {
            responses.push(raw_response(&input.pre_tx));
            responses.extend(grandparents.iter().map(raw_response));
        }
        for (input, grandparents) in context.ftlp_inputs.iter().zip(&context.ftlp_grandparents) {
            responses.push(raw_response(&input.pre_tx));
            responses.extend(grandparents.iter().map(raw_response));
        }
        responses.push(raw_response(&context.fee_parent));
        responses
    }

    fn operation_request_paths(context: &PoolOperationContext) -> Vec<String> {
        let mut paths = vec![
            pool_info_request_path(context.pool.pool_pre_pre_tx.txid()),
            raw_request_path(&context.pool.pool_pre_pre_tx),
            raw_request_path(&context.pool.pool_pre_tx),
            raw_request_path(&context.pool.pool_pre_tx),
            raw_request_path(&context.pool.pool_pre_pre_tx),
            raw_request_path(&context.pool.contract_tx),
        ];
        for (input, grandparents) in context.ft_inputs.iter().zip(&context.ft_grandparents) {
            paths.push(raw_request_path(&input.pre_tx));
            paths.extend(grandparents.iter().map(raw_request_path));
        }
        for (input, grandparents) in context.ftlp_inputs.iter().zip(&context.ftlp_grandparents) {
            paths.push(raw_request_path(&input.pre_tx));
            paths.extend(grandparents.iter().map(raw_request_path));
        }
        paths.push(raw_request_path(&context.fee_parent));
        paths
    }

    fn ftlp_list_response(inputs: &[FtlpSpendContext]) -> String {
        serde_json::json!({"code": 200, "data": {"utxos": inputs.iter().map(|input| {
            serde_json::json!({
                "txid": input.utxo.base.outpoint.txid.to_string(),
                "index": input.utxo.base.outpoint.vout,
                "tbc_balance": input.utxo.base.satoshis,
                "decimal": 6,
                "lp_balance": input.utxo.ft_balance_raw.to_string(),
            })
        }).collect::<Vec<_>>()}})
        .to_string()
    }

    fn ftlp_request_path(code: &crate::script::Script) -> String {
        use sha2::{Digest, Sha256};

        let mut hash = Sha256::digest(code.as_bytes()).to_vec();
        hash.reverse();
        format!(
            "/api/tbc/pool/lputxo/scriptpubkeyhash/{}",
            hex::encode(hash)
        )
    }

    fn lifecycle_responses(
        pool: &PoolSpendContext,
        inputs: &[FtlpSpendContext],
        fee_parent: &Transaction,
    ) -> Vec<String> {
        let mut responses = vec![
            pool_info_response_for(pool),
            raw_response(&pool.pool_pre_pre_tx),
            raw_response(&pool.pool_pre_tx),
            raw_response(&pool.pool_pre_tx),
            raw_response(&pool.pool_pre_pre_tx),
            raw_response(&pool.contract_tx),
            ftlp_list_response(inputs),
            raw_response(fee_parent),
        ];
        for input in inputs {
            responses.push(raw_response(&input.pre_tx));
            responses.extend(input.grandparents.iter().map(raw_response));
        }
        responses
    }

    fn lifecycle_request_paths(
        pool: &PoolSpendContext,
        inputs: &[FtlpSpendContext],
        fee_parent: &Transaction,
    ) -> Vec<String> {
        let mut paths = vec![
            pool_info_request_path(pool.pool_pre_pre_tx.txid()),
            raw_request_path(&pool.pool_pre_pre_tx),
            raw_request_path(&pool.pool_pre_tx),
            raw_request_path(&pool.pool_pre_tx),
            raw_request_path(&pool.pool_pre_pre_tx),
            raw_request_path(&pool.contract_tx),
            ftlp_request_path(&inputs[0].utxo.base.script_pubkey),
            raw_request_path(fee_parent),
        ];
        for input in inputs {
            paths.push(raw_request_path(&input.pre_tx));
            paths.extend(input.grandparents.iter().map(raw_request_path));
        }
        paths
    }

    fn pool_info_response(context: &PoolOperationContext) -> String {
        pool_info_response_for(&context.pool)
    }

    fn pool_info_response_for(context: &PoolSpendContext) -> String {
        let state = &context.state;
        serde_json::json!({"code": 200, "data": {
            "lp_balance": state.amounts.ft_lp_raw, "token_balance": state.amounts.ft_a_raw,
            "tbc_balance": state.amounts.tbc_sat, "ft_lp_partial_hash": hex::encode(&state.ft_lp_partial_hash),
            "ft_a_partial_hash": hex::encode(&state.ft_a_partial_hash), "ft_contract_id": state.ft_a_contract_id.to_string(),
            "service_fee_rate": state.service_fee_rate, "service_provider": state.service_provider,
            "pool_code_script": hex::encode(context.pool_utxo.script_pubkey.as_bytes()),
            "version": 2, "txid": context.pool_utxo.outpoint.txid.to_string(), "vout": 0,
            "value": context.pool_utxo.satoshis
        }}).to_string()
    }

    #[tokio::test]
    async fn online_increase_resolves_indexed_context_and_matches_offline_bytes() {
        let fixture = lp_fixture(false, false);
        let explicit = fixture
            .pool
            .increase_lp(
                fixture.increase.clone(),
                &fixture.owner,
                fixture.fee.clone(),
                "0.001",
                0,
            )
            .unwrap();
        let pool = &fixture.increase.pool;
        let ft = &fixture.increase.ft_inputs[0];
        let grandparent = &fixture.increase.ft_grandparents[0][0];
        let (base_url, requests) = mock_api_sequence(vec![
            pool_info_response(&fixture.increase),
            raw_response(&pool.pool_pre_pre_tx),
            raw_response(&pool.pool_pre_tx),
            raw_response(&pool.pool_pre_tx),
            raw_response(&pool.pool_pre_pre_tx),
            raw_response(&pool.contract_tx),
            raw_response(&ft.pre_tx),
            raw_response(grandparent),
            raw_response(&fixture.increase.fee_parent),
        ]);
        let online = fixture
            .pool
            .increase_lp_online(
                &ApiClient::with_base_url(base_url),
                ft.utxo.clone(),
                &fixture.owner,
                fixture.fee.clone(),
                "0.001",
                0,
                vec![],
                None,
            )
            .await
            .unwrap();
        assert_eq!(online.to_hex(), explicit.to_hex());
        assert_request_paths(
            requests.join().unwrap(),
            vec![
                pool_info_request_path(pool.pool_pre_pre_tx.txid()),
                raw_request_path(&pool.pool_pre_pre_tx),
                raw_request_path(&pool.pool_pre_tx),
                raw_request_path(&pool.pool_pre_tx),
                raw_request_path(&pool.pool_pre_pre_tx),
                raw_request_path(&pool.contract_tx),
                raw_request_path(&ft.pre_tx),
                raw_request_path(grandparent),
                raw_request_path(&fixture.increase.fee_parent),
            ],
        );
    }

    #[test]
    fn increase_to_preserves_the_explicit_ftlp_receiver() {
        let fixture = lp_fixture(false, false);
        let receiver = Address::from_hash160([0x91; 20]);
        let transaction = fixture
            .pool
            .increase_lp_to(
                fixture.increase.clone(),
                &fixture.owner,
                &receiver,
                fixture.fee.clone(),
                "0.001",
                0,
            )
            .unwrap();

        assert_eq!(
            transfer_ftlp_code_script(&transaction.outputs[4].script_pubkey, &receiver).unwrap(),
            transaction.outputs[4].script_pubkey
        );
        assert_ne!(
            transfer_ftlp_code_script(
                &transaction.outputs[4].script_pubkey,
                &fixture.owner.address()
            )
            .unwrap(),
            transaction.outputs[4].script_pubkey
        );
    }

    #[tokio::test]
    async fn online_init_resolves_indexed_context_and_matches_offline_bytes() {
        let fixture = lp_fixture(false, false);
        let context = &fixture.init_context;
        let explicit = fixture
            .zero_pool
            .init_pool(
                context.clone(),
                &fixture.owner,
                fixture.fee.clone(),
                "0.01",
                "2.5",
                0,
            )
            .unwrap();
        let (base_url, requests) = mock_api_sequence(vec![
            pool_info_response_for(&context.pool),
            raw_response(&context.pool.pool_pre_tx),
            raw_response(&context.pool.pool_pre_tx),
            raw_response(&context.pool.pool_pre_tx),
            raw_response(&context.pool.pool_pre_pre_tx),
            raw_response(&context.pool.contract_tx),
            raw_response(&context.ft.pre_tx),
            raw_response(&context.ft_grandparents[0]),
            raw_response(&context.fee_parent),
        ]);
        let online = fixture
            .zero_pool
            .init_pool_online(
                &ApiClient::with_base_url(base_url),
                context.ft.utxo.clone(),
                &fixture.owner,
                fixture.fee.clone(),
                context.lp_receiver.clone(),
                context.public_key_lock.clone(),
                "0.01",
                "2.5",
                0,
            )
            .await
            .unwrap();
        assert_eq!(online.to_hex(), explicit.to_hex());
        assert_request_paths(
            requests.join().unwrap(),
            vec![
                pool_info_request_path(context.pool.pool_pre_tx.txid()),
                raw_request_path(&context.pool.pool_pre_tx),
                raw_request_path(&context.pool.pool_pre_tx),
                raw_request_path(&context.pool.pool_pre_tx),
                raw_request_path(&context.pool.pool_pre_pre_tx),
                raw_request_path(&context.pool.contract_tx),
                raw_request_path(&context.ft.pre_tx),
                raw_request_path(&context.ft_grandparents[0]),
                raw_request_path(&context.fee_parent),
            ],
        );
    }

    #[tokio::test]
    async fn online_consume_resolves_indexed_context_and_matches_offline_vectors() {
        let fixture = lp_fixture(false, false);
        let explicit = fixture
            .pool
            .consume_lp(
                fixture.consume.clone(),
                &fixture.owner,
                fixture.fee.clone(),
                "0.001",
                None,
            )
            .unwrap();
        let (base_url, requests) = mock_api_sequence(operation_responses(&fixture.consume));
        let online = fixture
            .pool
            .consume_lp_online(
                &ApiClient::with_base_url(base_url),
                fixture
                    .consume
                    .ft_inputs
                    .iter()
                    .map(|input| input.utxo.clone())
                    .collect(),
                fixture
                    .consume
                    .ftlp_inputs
                    .iter()
                    .map(|input| input.utxo.clone())
                    .collect(),
                &fixture.owner,
                fixture.fee.clone(),
                "0.001",
                None,
                vec![],
            )
            .await
            .unwrap();
        assert_eq!(
            online.iter().map(Transaction::to_hex).collect::<Vec<_>>(),
            explicit.iter().map(Transaction::to_hex).collect::<Vec<_>>(),
        );
        assert_request_paths(
            requests.join().unwrap(),
            operation_request_paths(&fixture.consume),
        );
    }

    #[tokio::test]
    async fn online_swap_delegates_match_explicit_and_local_bytes() {
        let fixture = lp_fixture(false, false);

        let (tbc_fee, tbc_fee_parent) = swap_fee_context(&fixture, 5_000_000, 151);
        let mut tbc_context = fixture.consume.clone();
        tbc_context.ftlp_inputs.clear();
        tbc_context.ftlp_grandparents.clear();
        tbc_context.fee_parent = tbc_fee_parent;
        let explicit_token = fixture
            .pool
            .swap_to_token(tbc_context.clone(), &fixture.owner, tbc_fee.clone(), "1", 1)
            .unwrap();
        let (base_url, requests) = mock_api_sequence(operation_responses(&tbc_context));
        let online_token = fixture
            .pool
            .swap_to_token_online(
                &ApiClient::with_base_url(base_url),
                tbc_context
                    .ft_inputs
                    .iter()
                    .map(|input| input.utxo.clone())
                    .collect(),
                &fixture.owner,
                tbc_fee.clone(),
                "1",
                1,
                vec![],
            )
            .await
            .unwrap();
        assert_eq!(online_token.to_hex(), explicit_token.to_hex());
        assert_request_paths(
            requests.join().unwrap(),
            operation_request_paths(&tbc_context),
        );

        let (ft_fee, ft_fee_parent) = swap_fee_context(&fixture, 100_000, 152);
        let mut ft_context = fixture.increase.clone();
        ft_context.fee_parent = ft_fee_parent.clone();
        let explicit_tbc = fixture
            .pool
            .swap_to_tbc(ft_context.clone(), &fixture.owner, ft_fee.clone(), "0.1", 1)
            .unwrap();
        let local_tbc = fixture
            .pool
            .swap_to_tbc_local(
                LocalPoolOperationContext {
                    operation: ft_context.clone(),
                    local_parents: vec![ft_context.ft_inputs[0].pre_tx.clone(), ft_fee_parent],
                },
                &fixture.owner,
                ft_fee.clone(),
                "0.1",
                1,
            )
            .unwrap();
        let (base_url, requests) = mock_api_sequence(operation_responses(&ft_context));
        let online_tbc = fixture
            .pool
            .swap_to_tbc_online(
                &ApiClient::with_base_url(base_url),
                ft_context
                    .ft_inputs
                    .iter()
                    .map(|input| input.utxo.clone())
                    .collect(),
                &fixture.owner,
                ft_fee,
                "0.1",
                1,
                vec![],
            )
            .await
            .unwrap();
        assert_eq!(online_tbc.to_hex(), explicit_tbc.to_hex());
        assert_eq!(online_tbc.to_hex(), local_tbc.to_hex());
        assert_request_paths(
            requests.join().unwrap(),
            operation_request_paths(&ft_context),
        );
    }

    #[tokio::test]
    async fn online_merge_ft_in_pool_matches_explicit_vectors() {
        let fixture = lp_fixture(false, false);
        let (inputs, grandparents) = distinct_pool_ft_inputs(&fixture, &[10, 20, 30, 40, 50, 60]);
        let mut context = fixture.consume.clone();
        context.ft_inputs = inputs;
        context.ft_grandparents = grandparents;
        context.ftlp_inputs.clear();
        context.ftlp_grandparents.clear();
        let explicit = fixture
            .pool
            .merge_ft_in_pool(context.clone(), &fixture.owner, fixture.fee.clone(), 2)
            .unwrap();
        let (base_url, requests) = mock_api_sequence(operation_responses(&context));
        let online = fixture
            .pool
            .merge_ft_in_pool_online(
                &ApiClient::with_base_url(base_url),
                context
                    .ft_inputs
                    .iter()
                    .map(|input| input.utxo.clone())
                    .collect(),
                &fixture.owner,
                fixture.fee.clone(),
                2,
                vec![],
            )
            .await
            .unwrap();
        assert_eq!(
            online.iter().map(Transaction::to_hex).collect::<Vec<_>>(),
            explicit.iter().map(Transaction::to_hex).collect::<Vec<_>>(),
        );
        assert_request_paths(requests.join().unwrap(), operation_request_paths(&context));
    }

    #[tokio::test]
    async fn online_ftlp_lifecycle_delegates_match_explicit_vectors_and_locked_ordering() {
        let locked = lp_fixture(true, true);
        let locked_inputs = locked
            .consume
            .ftlp_inputs
            .iter()
            .cloned()
            .map(|mut input| {
                input.pool = Some(locked.consume.pool.clone());
                input.fee_parent = Some(locked.consume.fee_parent.clone());
                input
            })
            .collect::<Vec<_>>();
        let explicit_unlock = locked
            .pool
            .unlock_ftlp(
                &locked.owner,
                locked.fee.clone(),
                locked_inputs.clone(),
                5_000,
            )
            .unwrap();
        let (base_url, requests) = mock_api_sequence(lifecycle_responses(
            &locked.consume.pool,
            &locked_inputs,
            &locked.consume.fee_parent,
        ));
        let online_unlock = locked
            .pool
            .unlock_ftlp_online(
                &ApiClient::with_base_url(base_url),
                &locked.owner,
                locked.fee.clone(),
                5_000,
            )
            .await
            .unwrap();
        assert_eq!(online_unlock.to_hex(), explicit_unlock.to_hex());
        assert_request_paths(
            requests.join().unwrap(),
            lifecycle_request_paths(
                &locked.consume.pool,
                &locked_inputs,
                &locked.consume.fee_parent,
            ),
        );

        let standard = lp_fixture(false, false);
        let standard_inputs = distinct_standard_ftlp_inputs(&standard, &[4_000, 6_000])
            .into_iter()
            .map(|mut input| {
                input.pool = Some(standard.consume.pool.clone());
                input.fee_parent = Some(standard.consume.fee_parent.clone());
                input
            })
            .collect::<Vec<_>>();
        let explicit_merge = standard
            .pool
            .merge_ftlp(
                &standard.owner,
                standard.fee.clone(),
                standard_inputs.clone(),
                None,
            )
            .unwrap();
        let (base_url, requests) = mock_api_sequence(lifecycle_responses(
            &standard.consume.pool,
            &standard_inputs,
            &standard.consume.fee_parent,
        ));
        let online_merge = standard
            .pool
            .merge_ftlp_online(
                &ApiClient::with_base_url(base_url),
                &standard.owner,
                standard.fee.clone(),
                None,
            )
            .await
            .unwrap();
        assert!(online_merge.is_some());
        assert!(explicit_merge.is_some());
        assert_eq!(
            online_merge.as_ref().map(Transaction::to_hex),
            explicit_merge.as_ref().map(Transaction::to_hex),
        );
        assert_request_paths(
            requests.join().unwrap(),
            lifecycle_request_paths(
                &standard.consume.pool,
                &standard_inputs,
                &standard.consume.fee_parent,
            ),
        );

        let explicit_burn = standard
            .pool
            .burn_ftlp(
                &standard.owner,
                standard.fee.clone(),
                standard_inputs.clone(),
            )
            .unwrap();
        let (base_url, requests) = mock_api_sequence(lifecycle_responses(
            &standard.consume.pool,
            &standard_inputs,
            &standard.consume.fee_parent,
        ));
        let online_burn = standard
            .pool
            .burn_ftlp_online(
                &ApiClient::with_base_url(base_url),
                &standard.owner,
                standard.fee.clone(),
            )
            .await
            .unwrap();
        assert_eq!(online_burn.to_hex(), explicit_burn.to_hex());
        assert_request_paths(
            requests.join().unwrap(),
            lifecycle_request_paths(
                &standard.consume.pool,
                &standard_inputs,
                &standard.consume.fee_parent,
            ),
        );
    }

    fn distinct_pool_ft_inputs(
        fixture: &LpFixture,
        balances: &[u128],
    ) -> (Vec<FtSpendContext>, Vec<Vec<Transaction>>) {
        let template = &fixture.consume.ft_inputs[0];
        let code = template.utxo.base.script_pubkey.clone();
        let tape = fixture.consume.ft_inputs[0]
            .pre_tx
            .outputs
            .get(template.utxo.base.outpoint.vout as usize + 1)
            .unwrap()
            .script_pubkey
            .clone();
        balances
            .iter()
            .enumerate()
            .map(|(index, balance)| {
                let grandparent = transaction_with_outputs(
                    vec![TxOut {
                        satoshis: 500,
                        script_pubkey: code.clone(),
                    }],
                    120 + index as u8,
                );
                let (amount, _) = crate::contracts::ft::amount::build_tape_amount_with_offset(
                    *balance,
                    &[*balance],
                    0,
                )
                .unwrap();
                let mut parent = transaction_with_outputs(
                    vec![
                        TxOut {
                            satoshis: 500,
                            script_pubkey: code.clone(),
                        },
                        TxOut {
                            satoshis: 0,
                            script_pubkey: crate::contracts::ft::scripts::transfer_tape_script(
                                &tape, &amount,
                            )
                            .unwrap(),
                        },
                    ],
                    130 + index as u8,
                );
                parent.inputs[0].previous_output = OutPoint {
                    txid: grandparent.txid(),
                    vout: 0,
                };
                let pre_pre = crate::contracts::ft::unlock::pre_pre_tx_data_from_parents(
                    &parent,
                    0,
                    std::slice::from_ref(&grandparent),
                )
                .unwrap();
                (
                    FtSpendContext {
                        utxo: FtUtxo {
                            base: Utxo {
                                outpoint: OutPoint {
                                    txid: parent.txid(),
                                    vout: 0,
                                },
                                satoshis: 500,
                                script_pubkey: code.clone(),
                                private_key: fixture.owner.clone(),
                            },
                            ft_balance_raw: *balance,
                        },
                        pre_tx: parent,
                        pre_pre_tx_data: pre_pre,
                    },
                    vec![grandparent],
                )
            })
            .unzip()
    }

    fn distinct_locked_ftlp_inputs(
        fixture: &LpFixture,
        balances: &[u128],
        lock_time: u32,
    ) -> (Vec<FtlpSpendContext>, Vec<Vec<Transaction>>) {
        let template = &fixture.consume.ftlp_inputs[0];
        let code = template.utxo.base.script_pubkey.clone();
        let source_ft_tape_size = fixture.consume.ft_inputs[0]
            .pre_tx
            .outputs
            .get(fixture.consume.ft_inputs[0].utxo.base.outpoint.vout as usize + 1)
            .unwrap()
            .script_pubkey
            .as_bytes()
            .len();
        balances
            .iter()
            .enumerate()
            .map(|(index, balance)| {
                let grandparent = transaction_with_outputs(
                    vec![TxOut {
                        satoshis: 500,
                        script_pubkey: code.clone(),
                    }],
                    150 + index as u8,
                );
                let tape = super::ftlp_tape(&super::FtlpTapeParams {
                    amount_raw: u64::try_from(*balance).unwrap(),
                    layout: super::FtlpTapeLayout::LockTime {
                        lock_time,
                        source_ft_tape_size,
                    },
                })
                .unwrap();
                let mut parent = transaction_with_outputs(
                    vec![
                        TxOut {
                            satoshis: 500,
                            script_pubkey: code.clone(),
                        },
                        TxOut {
                            satoshis: 0,
                            script_pubkey: tape,
                        },
                    ],
                    160 + index as u8,
                );
                parent.inputs[0].previous_output = OutPoint {
                    txid: grandparent.txid(),
                    vout: 0,
                };
                let pre_pre = crate::contracts::ft::unlock::pre_pre_tx_data_from_parents(
                    &parent,
                    0,
                    std::slice::from_ref(&grandparent),
                )
                .unwrap();
                (
                    FtlpSpendContext {
                        utxo: crate::FtlpUtxo {
                            base: UtxoInfo {
                                outpoint: OutPoint {
                                    txid: parent.txid(),
                                    vout: 0,
                                },
                                satoshis: 500,
                                script_pubkey: code.clone(),
                            },
                            ft_balance_raw: *balance,
                        },
                        pre_tx: parent,
                        pre_pre_tx_data: pre_pre,
                        grandparents: vec![grandparent.clone()],
                        pool: None,
                        fee_parent: None,
                    },
                    vec![grandparent],
                )
            })
            .unzip()
    }

    fn distinct_standard_ftlp_inputs(
        fixture: &LpFixture,
        balances: &[u128],
    ) -> Vec<FtlpSpendContext> {
        let template = &fixture.consume.ftlp_inputs[0];
        let code = template.utxo.base.script_pubkey.clone();
        let tape = template.pre_tx.outputs[template.utxo.base.outpoint.vout as usize + 1]
            .script_pubkey
            .clone();
        balances
            .iter()
            .enumerate()
            .map(|(index, balance)| {
                let grandparent = transaction_with_outputs(
                    vec![TxOut {
                        satoshis: 500,
                        script_pubkey: code.clone(),
                    }],
                    180 + index as u8,
                );
                let amount = crate::contracts::ft::amount::build_tape_amount(*balance, &[*balance])
                    .unwrap()
                    .0;
                let mut parent = transaction_with_outputs(
                    vec![
                        TxOut {
                            satoshis: 500,
                            script_pubkey: code.clone(),
                        },
                        TxOut {
                            satoshis: 0,
                            script_pubkey: crate::contracts::ft::scripts::transfer_tape_script(
                                &tape, &amount,
                            )
                            .unwrap(),
                        },
                    ],
                    190 + index as u8,
                );
                parent.inputs[0].previous_output = OutPoint {
                    txid: grandparent.txid(),
                    vout: 0,
                };
                let pre_pre_tx_data = crate::contracts::ft::unlock::pre_pre_tx_data_from_parents(
                    &parent,
                    0,
                    std::slice::from_ref(&grandparent),
                )
                .unwrap();
                FtlpSpendContext {
                    utxo: crate::FtlpUtxo {
                        base: UtxoInfo {
                            outpoint: OutPoint {
                                txid: parent.txid(),
                                vout: 0,
                            },
                            satoshis: 500,
                            script_pubkey: code.clone(),
                        },
                        ft_balance_raw: *balance,
                    },
                    pre_tx: parent,
                    pre_pre_tx_data,
                    grandparents: vec![grandparent],
                    pool: Some(fixture.consume.pool.clone()),
                    fee_parent: Some(fixture.consume.fee_parent.clone()),
                }
            })
            .collect()
    }

    #[test]
    fn create_authority_binds_real_contract_outputs_and_metadata() {
        let authority = authority_from_info(ft_info(), 90);
        let id = authority.contract_tx.txid();
        assert!(PoolNftV2::for_create(id, authority.clone()).is_ok());

        let mut missing_id = authority.clone();
        missing_id.info.contract_txid = None;
        assert!(PoolNftV2::for_create(id, missing_id).is_err());

        let mut wrong_id = authority.clone();
        wrong_id.info.contract_txid = Some(Txid::from_le_bytes([0x77; 32]).to_string());
        assert!(PoolNftV2::for_create(id, wrong_id).is_err());

        let mut copied_code = authority.clone();
        copied_code.contract_tx.outputs[0].script_pubkey = crate::script::Script::empty();
        copied_code.info.contract_txid = Some(copied_code.contract_tx.txid().to_string());
        assert!(PoolNftV2::for_create(copied_code.contract_tx.txid(), copied_code,).is_err());

        let mut copied_tape = authority.clone();
        copied_tape.contract_tx.outputs[1].script_pubkey = crate::script::Script::op_return(&[
            vec![0; 48],
            vec![6],
            b"Copy".to_vec(),
            b"CPY".to_vec(),
            b"FTape".to_vec(),
        ]);
        copied_tape.info.contract_txid = Some(copied_tape.contract_tx.txid().to_string());
        assert!(PoolNftV2::for_create(copied_tape.contract_tx.txid(), copied_tape,).is_err());

        let mut contradictory = authority;
        contradictory.info.name.push_str("-wrong");
        assert!(PoolNftV2::for_create(id, contradictory).is_err());
    }

    #[test]
    fn create_accepts_real_finalized_stable_coin_authority_at_outputs_three_and_four() {
        let authority = real_stable_coin_authority();
        let contract_id = authority.contract_tx.txid();
        assert_eq!(authority.info.contract_txid, Some(contract_id.to_string()));
        assert_eq!(authority.contract_tx.outputs[3].satoshis, 500);
        assert_eq!(authority.contract_tx.outputs[4].satoshis, 0);

        PoolNftV2::for_create(contract_id, authority).unwrap();
    }

    #[test]
    fn standalone_ftlp_authority_resolution_uses_coin_outputs_three_and_four() {
        let authority = real_stable_coin_authority();
        let code = &authority.contract_tx.outputs[3].script_pubkey;
        let classified = super::classify_ft_script(code).unwrap();
        let state = super::PoolState {
            amounts: super::PoolAmounts {
                ft_lp_raw: 0,
                ft_a_raw: 0,
                tbc_sat: 0,
            },
            ft_lp_partial_hash: vec![0; 32],
            ft_a_partial_hash: super::calculate_partial_hash(
                &code.as_bytes()
                    [..super::partial_hash_offset(classified.version, classified.is_coin).unwrap()],
            )
            .to_vec(),
            ft_a_contract_id: authority.contract_tx.txid(),
            service_fee_rate: 35,
            service_provider: "coin-authority".to_string(),
            lp_plan: 1,
            public_key_locked: false,
            ftlp_lock_time_enabled: false,
        };
        let pool = PoolSpendContext {
            pool_utxo: UtxoInfo {
                outpoint: OutPoint {
                    txid: Txid::from_le_bytes([201; 32]),
                    vout: 0,
                },
                satoshis: 1_000,
                script_pubkey: crate::script::Script::empty(),
            },
            pool_pre_tx: transaction_with_outputs(vec![], 202),
            pool_pre_pre_tx: transaction_with_outputs(vec![], 203),
            contract_tx: authority.contract_tx.clone(),
            state,
        };
        let resolved = super::resolve_pool_ft_authority(&pool).unwrap();
        assert!(resolved.is_coin);
        assert_eq!(
            resolved.tape,
            authority.contract_tx.outputs[4].script_pubkey
        );
        assert_ne!(
            resolved.tape,
            authority.contract_tx.outputs[1].script_pubkey
        );
        let (amount, _) =
            crate::contracts::ft::amount::build_tape_amount_with_offset(9, &[9], 0).unwrap();
        assert_eq!(
            super::ftlp_burn_tape(&resolved.tape, &amount).unwrap(),
            crate::contracts::ft::scripts::transfer_tape_script(
                &authority.contract_tx.outputs[4].script_pubkey,
                &amount,
            )
            .unwrap()
        );
    }

    #[test]
    fn pool_authority_context_requires_matching_txid_and_released_pair_vouts() {
        let authority = authority_from_info(ft_info(), 91);
        let code = authority.contract_tx.outputs[0].script_pubkey.clone();
        let classified = super::classify_ft_script(&code).unwrap();
        let state_for = |contract_id| super::PoolState {
            amounts: super::PoolAmounts {
                ft_lp_raw: 0,
                ft_a_raw: 0,
                tbc_sat: 0,
            },
            ft_lp_partial_hash: vec![0; 32],
            ft_a_partial_hash: super::calculate_partial_hash(
                &code.as_bytes()
                    [..super::partial_hash_offset(classified.version, classified.is_coin).unwrap()],
            )
            .to_vec(),
            ft_a_contract_id: contract_id,
            service_fee_rate: 35,
            service_provider: "authority-layout".to_string(),
            lp_plan: 1,
            public_key_locked: false,
            ftlp_lock_time_enabled: false,
        };
        let context_for = |contract_tx: Transaction, state: super::PoolState| PoolSpendContext {
            pool_utxo: UtxoInfo {
                outpoint: OutPoint {
                    txid: Txid::from_le_bytes([92; 32]),
                    vout: 0,
                },
                satoshis: 1_000,
                script_pubkey: crate::script::Script::empty(),
            },
            pool_pre_tx: transaction_with_outputs(vec![], 93),
            pool_pre_pre_tx: transaction_with_outputs(vec![], 94),
            contract_tx,
            state,
        };

        let valid = context_for(
            authority.contract_tx.clone(),
            state_for(authority.contract_tx.txid()),
        );
        assert!(super::pool_ft_authority_from_context(&valid).is_ok());

        let wrong_id = context_for(
            authority.contract_tx.clone(),
            state_for(Txid::from_le_bytes([95; 32])),
        );
        assert!(super::pool_ft_authority_from_context(&wrong_id).is_err());

        let mut noncanonical = authority.contract_tx.clone();
        let code_output = noncanonical.outputs.remove(0);
        let tape_output = noncanonical.outputs.remove(0);
        noncanonical.outputs = vec![
            TxOut {
                satoshis: 1,
                script_pubkey: crate::script::Script::empty(),
            },
            TxOut {
                satoshis: 1,
                script_pubkey: crate::script::Script::empty(),
            },
            code_output,
            tape_output,
        ];
        let noncanonical_context =
            context_for(noncanonical.clone(), state_for(noncanonical.txid()));
        assert!(super::pool_ft_authority_from_context(&noncanonical_context).is_err());
    }

    #[test]
    fn coin_authority_rejects_ordinary_ft_output_layout() {
        let authority = released_family_authority(3);
        assert!(PoolNftV2::for_create(authority.contract_tx.txid(), authority).is_err());

        let mut authority = authority_from_info(ft_info(), 96);
        let code = authority.contract_tx.outputs[0].clone();
        let tape = authority.contract_tx.outputs[1].clone();
        authority.contract_tx.outputs = vec![
            TxOut {
                satoshis: 200,
                script_pubkey: crate::script::Script::empty(),
            },
            TxOut {
                satoshis: 100,
                script_pubkey: crate::script::Script::empty(),
            },
            TxOut {
                satoshis: 0,
                script_pubkey: crate::script::Script::op_return(&[b"NTape".to_vec()]),
            },
            code,
            tape,
        ];
        authority.info.contract_txid = Some(authority.contract_tx.txid().to_string());
        assert!(PoolNftV2::for_create(authority.contract_tx.txid(), authority).is_err());
    }

    #[test]
    fn coin_tape_requires_exact_four_byte_lock_time_suffix() {
        let authority = real_stable_coin_authority();
        let tape = &authority.contract_tx.outputs[4].script_pubkey;
        let mut chunks = super::canonical_op_return_chunks(tape).unwrap();
        assert_eq!(chunks.len(), 6);
        assert_eq!(chunks[4].len(), 4);

        let assert_rejected = |chunks: Vec<Vec<u8>>| {
            let tape = crate::script::Script::op_return(&chunks);
            assert!(super::parse_canonical_ft_tape(&tape, true).is_err());
            let mut authority = real_stable_coin_authority();
            authority.info.tape_script = hex::encode(tape.as_bytes());
            authority.contract_tx.outputs[4].script_pubkey = tape;
            authority.info.contract_txid = Some(authority.contract_tx.txid().to_string());
            assert!(PoolNftV2::for_create(authority.contract_tx.txid(), authority,).is_err());
        };

        chunks.remove(4);
        assert_rejected(chunks.clone());

        chunks.insert(4, vec![0; 3]);
        assert_rejected(chunks);
    }

    #[test]
    fn standard_ftlp_tape_is_always_six_decimal_for_supported_ft_precisions() {
        for decimal in [0, 8, 18] {
            let metadata = super::FtTapeMetadata {
                total_supply_raw: 1,
                decimal,
                name: "Token".to_string(),
                symbol: "TOK".to_string(),
                coin_suffix: None,
            };
            let tape = super::standard_ftlp_tape(1, &metadata, false).unwrap();
            let parsed = super::parse_canonical_ft_tape(&tape, false).unwrap();
            assert_eq!(parsed.decimal, 6, "underlying FT decimal {decimal}");
        }
    }

    #[test]
    fn lp_transition_methods_expose_the_released_operation_surface() {
        // These entry points intentionally take an explicit operation context:
        // LP transitions must never acquire parent or grandparent transactions
        // implicitly while assembling a 0-conf chain.
        let _increase = PoolNftV2::increase_lp;
        let _consume = PoolNftV2::consume_lp;
    }

    #[test]
    fn swap_transition_methods_expose_the_explicit_context_surface() {
        // Swap builders are intentionally offline: every parent and
        // grandparent needed for a 0-conf chain is supplied by the caller.
        let _to_token = PoolNftV2::swap_to_token;
        let _to_tbc = PoolNftV2::swap_to_tbc;
        let _to_tbc_local = PoolNftV2::swap_to_tbc_local;
    }

    #[test]
    fn lp_locked_cost_is_bound_to_the_spent_pool_code_not_context_metadata() {
        let owner = PrivateKey::from_slice(&[71; 32]).unwrap();
        let authority = authority_from_info(ft_info(), 72);
        let pool = PoolNftV2::for_create(authority.contract_tx.txid(), authority).unwrap();
        let address = Address::from_hash160([0x42; 20]);
        let created = pool
            .create_pool_with_lock(
                &owner,
                funding(&owner, 100_000),
                "lp-cost",
                address.clone(),
                24,
                &[owner.public_key()],
                35,
                1,
                false,
            )
            .unwrap();
        let decoded = super::locked_pool_lp_cost(&created[1].outputs[0].script_pubkey).unwrap();
        assert_eq!(decoded, (address, 24));
        let mut tampered = created[1].outputs[0].script_pubkey.as_bytes().to_vec();
        let cost = 24u64.to_le_bytes();
        let offset = tampered
            .windows(cost.len())
            .position(|window| window == cost)
            .unwrap();
        tampered[offset + cost.len()] ^= 1;
        assert!(super::locked_pool_lp_cost(&crate::script::Script::from_bytes(tampered)).is_err());
    }

    #[test]
    fn lp_rejects_underlying_and_lp_partial_hash_mismatches_before_signing() {
        let code = crate::script::Script::from_bytes(hex::decode(ft_info().code_script).unwrap());
        let mut state = super::PoolState {
            amounts: super::PoolAmounts {
                ft_lp_raw: 10_000,
                ft_a_raw: 2_500_000,
                tbc_sat: 10_000,
            },
            ft_lp_partial_hash: vec![0x11; 32],
            ft_a_partial_hash: vec![0x22; 32],
            ft_a_contract_id: Txid::default(),
            service_fee_rate: 35,
            service_provider: "lp".to_string(),
            lp_plan: 1,
            public_key_locked: false,
            ftlp_lock_time_enabled: false,
        };
        assert!(super::validate_underlying_ft_binding(&code, &state, 2, false).is_err());
        state.ft_a_partial_hash =
            crate::contracts::ft::partial_sha256::calculate_partial_hash(&code.as_bytes()[..1856])
                .to_vec();
        assert!(super::validate_underlying_ft_binding(&code, &state, 2, false).is_ok());
    }

    #[test]
    fn lp_standard_builders_construct_proportional_successors_and_sign_inputs() {
        let fixture = lp_fixture(false, false);
        let increase = fixture
            .pool
            .increase_lp(
                fixture.increase.clone(),
                &fixture.owner,
                fixture.fee.clone(),
                "0.002",
                0,
            )
            .unwrap();
        let increase_state = super::PoolState::from_v2_tape(
            &increase.outputs[1].script_pubkey,
            "lp-fixture".to_string(),
        )
        .unwrap();
        assert_eq!(increase_state.amounts.ft_lp_raw, 12_000);
        assert_eq!(increase_state.amounts.ft_a_raw, 3_000_000);
        assert_eq!(increase_state.amounts.tbc_sat, 12_000);
        assert_eq!(
            increase.outputs[0].satoshis,
            1_000 + increase_state.amounts.tbc_sat
        );
        assert!(
            increase
                .inputs
                .iter()
                .all(|input| !input.script_sig.as_bytes().is_empty())
        );
        // Large Pool Code scripts use the released unlock form without a P2PKH
        // signature; the FT and fee inputs below are independently verified.
        independently_verify_input_signature(
            &increase,
            1,
            &fixture.increase.ft_inputs[0].utxo.base.script_pubkey,
            500,
            &fixture.owner.public_key(),
        );

        let consume = fixture
            .pool
            .consume_lp(
                fixture.consume.clone(),
                &fixture.owner,
                fixture.fee.clone(),
                "0.001",
                None,
            )
            .unwrap();
        assert_eq!(consume.len(), 1);
        let consume = &consume[0];
        let consume_state = super::PoolState::from_v2_tape(
            &consume.outputs[1].script_pubkey,
            "lp-fixture".to_string(),
        )
        .unwrap();
        assert_eq!(consume_state.amounts.ft_lp_raw, 9_000);
        assert_eq!(consume_state.amounts.ft_a_raw, 2_250_000);
        assert_eq!(consume_state.amounts.tbc_sat, 9_000);
        assert_eq!(
            consume.outputs[0].satoshis,
            1_000 + consume_state.amounts.tbc_sat
        );
        assert!(
            consume
                .inputs
                .iter()
                .all(|input| !input.script_sig.as_bytes().is_empty())
        );
        independently_verify_input_signature(
            consume,
            1,
            &fixture.consume.ftlp_inputs[0].utxo.base.script_pubkey,
            500,
            &fixture.owner.public_key(),
        );
        independently_verify_input_signature(
            consume,
            2,
            &fixture.consume.ft_inputs[0].utxo.base.script_pubkey,
            500,
            &fixture.owner.public_key(),
        );
        independently_verify_input_signature(
            consume,
            3,
            &fixture.fee.script_pubkey,
            fixture.fee.satoshis,
            &fixture.fee.private_key.public_key(),
        );

        // These constructed UTXOs hold 2.5 FT-A and 0.01 FT-LP respectively.
        // Requests beyond either selected balance must fail before a tx is
        // returned, rather than creating an underfunded successor.
        assert!(
            fixture
                .pool
                .increase_lp(
                    fixture.increase.clone(),
                    &fixture.owner,
                    fixture.fee.clone(),
                    "3",
                    0,
                )
                .is_err()
        );
        assert!(
            fixture
                .pool
                .consume_lp(
                    fixture.consume.clone(),
                    &fixture.owner,
                    fixture.fee.clone(),
                    "0.02",
                    None,
                )
                .is_err()
        );
    }

    #[test]
    fn consume_lp_routes_withdrawals_to_receiver_and_change_to_wallet() {
        let fixture = lp_fixture(false, false);
        let receiver = Address::from_hash160([0x93; 20]);
        let transactions = fixture
            .pool
            .consume_lp_to(
                fixture.consume.clone(),
                &fixture.owner,
                &receiver,
                fixture.fee.clone(),
                "0.001",
                None,
            )
            .unwrap();
        let consume = &transactions[0];

        assert_eq!(
            crate::contracts::ft::scripts::transfer_code_script(
                &consume.outputs[2].script_pubkey,
                crate::contracts::ft::scripts::FtCodeReceiver::Address(receiver.clone())
            )
            .unwrap(),
            consume.outputs[2].script_pubkey
        );
        assert_eq!(consume.outputs[4].script_pubkey, receiver.script_pubkey());
        assert_eq!(
            transfer_ftlp_code_script(&consume.outputs[7].script_pubkey, &fixture.owner.address())
                .unwrap(),
            consume.outputs[7].script_pubkey
        );
        assert_eq!(
            consume.outputs.last().unwrap().script_pubkey,
            fixture.fee.private_key.address().script_pubkey()
        );
    }

    fn swap_fee_context(fixture: &LpFixture, satoshis: u64, nonce: u8) -> (Utxo, Transaction) {
        let parent = transaction_with_outputs(
            vec![TxOut {
                satoshis,
                script_pubkey: fixture.fee.script_pubkey.clone(),
            }],
            nonce,
        );
        (
            Utxo {
                outpoint: OutPoint {
                    txid: parent.txid(),
                    vout: 0,
                },
                satoshis,
                script_pubkey: fixture.fee.script_pubkey.clone(),
                private_key: fixture.fee.private_key.clone(),
            },
            parent,
        )
    }

    async fn reload_built_swap_successor(
        fixture: &LpFixture,
        successor: &Transaction,
    ) -> crate::PoolNftInfo {
        let state = super::PoolState::from_v2_tape(
            &successor.outputs[1].script_pubkey,
            "lp-fixture".to_string(),
        )
        .unwrap();
        let contract = &fixture.consume.pool.pool_pre_pre_tx;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let info = serde_json::json!({
            "code": 200,
            "data": {
                "lp_balance": state.amounts.ft_lp_raw,
                "token_balance": state.amounts.ft_a_raw,
                "tbc_balance": state.amounts.tbc_sat,
                "ft_lp_partial_hash": hex::encode(&state.ft_lp_partial_hash),
                "ft_a_partial_hash": hex::encode(&state.ft_a_partial_hash),
                "ft_contract_id": state.ft_a_contract_id.to_string(),
                "service_fee_rate": state.service_fee_rate,
                "service_provider": state.service_provider,
                "pool_code_script": hex::encode(successor.outputs[0].script_pubkey.as_bytes()),
                "version": 2,
                "txid": successor.txid().to_string(),
                "vout": 0,
                "value": successor.outputs[0].satoshis,
            }
        })
        .to_string();
        let responses = vec![
            info,
            serde_json::json!({"code": 200, "data": {"txraw": contract.to_hex()}}).to_string(),
            serde_json::json!({"code": 200, "data": {"txraw": successor.to_hex()}}).to_string(),
        ];
        let server = thread::spawn(move || {
            for body in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0u8; 8_192];
                let read = stream.read(&mut request).unwrap();
                assert!(read > 0);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let loaded = crate::ApiClient::with_base_url(format!("http://{address}/api/tbc/"))
            .fetch_pool_nft_info(&contract.txid())
            .await
            .unwrap();
        server.join().unwrap();
        loaded
    }

    #[test]
    fn swap_builders_construct_released_outputs_signatures_and_local_parity() {
        let fixture = lp_fixture(false, false);
        let (tbc_fee, tbc_fee_parent) = swap_fee_context(&fixture, 5_000_000, 151);
        let mut tbc_context = fixture.consume.clone();
        tbc_context.ftlp_inputs.clear();
        tbc_context.ftlp_grandparents.clear();
        tbc_context.fee_parent = tbc_fee_parent;
        let tbc_to_ft = fixture
            .pool
            .swap_to_token(tbc_context.clone(), &fixture.owner, tbc_fee.clone(), "1", 1)
            .unwrap();
        let tbc_state = super::PoolState::from_v2_tape(
            &tbc_to_ft.outputs[1].script_pubkey,
            "lp-fixture".to_string(),
        )
        .unwrap();
        // 1,000,000 * 35 / 10,000 = 3,500 total fee.  The provider's
        // 1,000 sat fee is emitted; the 2,500 sat LP fee remains in Code.
        assert_eq!(tbc_state.amounts.tbc_sat, 1_006_500);
        assert_eq!(tbc_to_ft.outputs[0].satoshis, 1_010_000);
        assert_eq!(tbc_to_ft.outputs[4].satoshis, 1_000);
        assert_eq!(
            tbc_to_ft.outputs[4].script_pubkey,
            super::service_fee_script(1).unwrap()
        );
        assert_eq!(tbc_to_ft.outputs[2].satoshis, 500);
        independently_verify_input_signature(
            &tbc_to_ft,
            1,
            &tbc_fee.script_pubkey,
            tbc_fee.satoshis,
            &tbc_fee.private_key.public_key(),
        );
        independently_verify_input_signature(
            &tbc_to_ft,
            2,
            &tbc_context.ft_inputs[0].utxo.base.script_pubkey,
            tbc_context.ft_inputs[0].utxo.base.satoshis,
            &fixture.owner.public_key(),
        );

        let mut ft_context = fixture.increase.clone();
        let (ft_fee, ft_fee_parent) = swap_fee_context(&fixture, 100_000, 152);
        ft_context.fee_parent = ft_fee_parent.clone();
        let online = fixture
            .pool
            .swap_to_tbc(ft_context.clone(), &fixture.owner, ft_fee.clone(), "0.1", 1)
            .unwrap();
        let local = fixture
            .pool
            .swap_to_tbc_local(
                crate::contracts::pool_nft_v2::LocalPoolOperationContext {
                    operation: ft_context.clone(),
                    local_parents: vec![ft_context.ft_inputs[0].pre_tx.clone(), ft_fee_parent],
                },
                &fixture.owner,
                ft_fee.clone(),
                "0.1",
                1,
            )
            .unwrap();
        assert_eq!(online.to_hex(), local.to_hex());
        let ft_state = super::PoolState::from_v2_tape(
            &online.outputs[1].script_pubkey,
            "lp-fixture".to_string(),
        )
        .unwrap();
        assert_eq!(ft_state.amounts.ft_a_raw, 2_600_000);
        assert_eq!(ft_state.amounts.tbc_sat, 9_615);
        assert_eq!(
            online.outputs[2].script_pubkey,
            fixture.owner.address().script_pubkey()
        );
        assert_eq!(online.outputs[3].satoshis, 500);
        independently_verify_input_signature(
            &online,
            1,
            &ft_context.ft_inputs[0].utxo.base.script_pubkey,
            ft_context.ft_inputs[0].utxo.base.satoshis,
            &fixture.owner.public_key(),
        );
        independently_verify_input_signature(
            &online,
            2,
            &ft_fee.script_pubkey,
            ft_fee.satoshis,
            &ft_fee.private_key.public_key(),
        );
    }

    #[tokio::test]
    async fn fee_bearing_swap_successors_reload_through_the_api_for_both_directions() {
        let fixture = lp_fixture(false, false);
        let (tbc_fee, tbc_parent) = swap_fee_context(&fixture, 5_000_000, 160);
        let mut tbc_context = fixture.consume.clone();
        tbc_context.ftlp_inputs.clear();
        tbc_context.ftlp_grandparents.clear();
        tbc_context.fee_parent = tbc_parent;
        let tbc_to_ft = fixture
            .pool
            .swap_to_token(tbc_context, &fixture.owner, tbc_fee, "1", 1)
            .unwrap();
        let loaded = reload_built_swap_successor(&fixture, &tbc_to_ft).await;
        assert_eq!(loaded.current_utxo.satoshis, tbc_to_ft.outputs[0].satoshis);
        assert!(loaded.current_utxo.satoshis > 1_000 + loaded.state.amounts.tbc_sat);

        let (ft_fee, ft_parent) = swap_fee_context(&fixture, 100_000, 161);
        let mut ft_context = fixture.increase.clone();
        ft_context.fee_parent = ft_parent;
        let ft_to_tbc = fixture
            .pool
            .swap_to_tbc(ft_context, &fixture.owner, ft_fee, "2.5", 1)
            .unwrap();
        let loaded = reload_built_swap_successor(&fixture, &ft_to_tbc).await;
        assert_eq!(loaded.current_utxo.satoshis, ft_to_tbc.outputs[0].satoshis);
        assert!(loaded.current_utxo.satoshis > 1_000 + loaded.state.amounts.tbc_sat);
    }

    #[test]
    fn swap_rejects_stale_ancestry_wrong_local_parents_and_above_released_cap() {
        let fixture = lp_fixture(false, false);
        let (fee, parent) = swap_fee_context(&fixture, 5_000_000, 153);
        let mut context = fixture.consume.clone();
        context.ftlp_inputs.clear();
        context.ftlp_grandparents.clear();
        context.fee_parent = parent;
        let mut stale = context.clone();
        stale.pool.state.amounts.tbc_sat += 1;
        assert!(
            fixture
                .pool
                .swap_to_token(stale, &fixture.owner, fee.clone(), "1", 1)
                .is_err()
        );

        let mut below_minimum = context.clone();
        below_minimum.pool.pool_utxo.satoshis -= 1;
        below_minimum.pool.pool_pre_tx.outputs[0].satoshis -= 1;
        below_minimum.pool.pool_utxo.outpoint.txid = below_minimum.pool.pool_pre_tx.txid();
        let error = fixture
            .pool
            .swap_to_token(below_minimum, &fixture.owner, fee.clone(), "1", 1)
            .unwrap_err();
        assert!(error.to_string().contains("below"));

        let mut retained_excess = context.clone();
        retained_excess.pool.pool_utxo.satoshis += 1;
        retained_excess.pool.pool_pre_tx.outputs[0].satoshis += 1;
        retained_excess.pool.pool_utxo.outpoint.txid = retained_excess.pool.pool_pre_tx.txid();
        assert!(
            fixture
                .pool
                .swap_to_token(retained_excess, &fixture.owner, fee.clone(), "1", 1)
                .is_ok()
        );

        let (five_inputs, five_grandparents) =
            distinct_pool_ft_inputs(&fixture, &[600_000, 600_000, 600_000, 600_000, 600_000]);
        let mut above_cap = context.clone();
        above_cap.ft_inputs = five_inputs;
        above_cap.ft_grandparents = five_grandparents;
        let error = fixture
            .pool
            .swap_to_token(above_cap, &fixture.owner, fee.clone(), "1", 1)
            .unwrap_err();
        assert!(error.to_string().contains("one to 4"));

        let mut to_tbc = fixture.increase.clone();
        let (ft_fee, ft_parent) = swap_fee_context(&fixture, 100_000, 154);
        to_tbc.fee_parent = ft_parent;
        assert!(
            fixture
                .pool
                .swap_to_tbc_local(
                    crate::contracts::pool_nft_v2::LocalPoolOperationContext {
                        operation: to_tbc,
                        local_parents: vec![],
                    },
                    &fixture.owner,
                    ft_fee,
                    "0.1",
                    1,
                )
                .is_err()
        );
    }

    #[test]
    fn swap_to_token_accepts_the_released_four_pool_ft_input_boundary() {
        let fixture = lp_fixture(false, false);
        let (fee, parent) = swap_fee_context(&fixture, 5_000_000, 157);
        let (ft_inputs, ft_grandparents) =
            distinct_pool_ft_inputs(&fixture, &[600_000, 650_000, 700_000, 850_000]);
        let mut context = fixture.consume.clone();
        context.ft_inputs = ft_inputs;
        context.ft_grandparents = ft_grandparents;
        context.ftlp_inputs.clear();
        context.ftlp_grandparents.clear();
        context.fee_parent = parent;
        let selected_inputs = context.ft_inputs.clone();
        let transaction = fixture
            .pool
            .swap_to_token(context, &fixture.owner, fee, "1", 1)
            .unwrap();
        assert_eq!(transaction.inputs.len(), 6);
        assert!(
            transaction
                .inputs
                .iter()
                .all(|input| !input.script_sig.as_bytes().is_empty())
        );
        for (input_index, input) in selected_inputs.iter().enumerate() {
            independently_verify_input_signature(
                &transaction,
                input_index + 2,
                &input.utxo.base.script_pubkey,
                input.utxo.base.satoshis,
                &fixture.owner.public_key(),
            );
        }
    }

    #[test]
    fn swap_to_token_accepts_unequal_two_and_four_input_tapes_but_rejects_metadata_mismatch() {
        let fixture = lp_fixture(false, false);
        for (nonce, balances) in [
            (162, vec![1_200_000, 1_400_000]),
            (163, vec![600_000, 650_000, 700_000, 850_000]),
        ] {
            let (fee, parent) = swap_fee_context(&fixture, 5_000_000, nonce);
            let (ft_inputs, ft_grandparents) = distinct_pool_ft_inputs(&fixture, &balances);
            let mut context = fixture.consume.clone();
            context.ft_inputs = ft_inputs;
            context.ft_grandparents = ft_grandparents;
            context.ftlp_inputs.clear();
            context.ftlp_grandparents.clear();
            context.fee_parent = parent;
            let selected = context.ft_inputs.clone();
            let transaction = fixture
                .pool
                .swap_to_token(context, &fixture.owner, fee, "1", 1)
                .unwrap();
            for (index, input) in selected.iter().enumerate() {
                independently_verify_input_signature(
                    &transaction,
                    index + 2,
                    &input.utxo.base.script_pubkey,
                    input.utxo.base.satoshis,
                    &fixture.owner.public_key(),
                );
            }
        }

        let (fee, parent) = swap_fee_context(&fixture, 5_000_000, 164);
        let (mut ft_inputs, ft_grandparents) =
            distinct_pool_ft_inputs(&fixture, &[1_300_000, 1_300_000]);
        let input = &mut ft_inputs[1];
        let mut tape =
            super::canonical_op_return_chunks(&input.pre_tx.outputs[1].script_pubkey).unwrap();
        tape[2] = b"Other Token".to_vec();
        input.pre_tx.outputs[1].script_pubkey = crate::script::Script::op_return(&tape);
        input.utxo.base.outpoint.txid = input.pre_tx.txid();
        input.pre_pre_tx_data = crate::contracts::ft::unlock::pre_pre_tx_data_from_parents(
            &input.pre_tx,
            0,
            &ft_grandparents[1],
        )
        .unwrap();
        let mut context = fixture.consume.clone();
        context.ft_inputs = ft_inputs;
        context.ft_grandparents = ft_grandparents;
        context.ftlp_inputs.clear();
        context.ftlp_grandparents.clear();
        context.fee_parent = parent;
        let error = fixture
            .pool
            .swap_to_token(context, &fixture.owner, fee, "1", 1)
            .unwrap_err();
        assert!(error.to_string().contains("same FT family"));
    }

    #[test]
    fn swap_uses_persisted_plan_two_when_caller_fallback_is_invalid() {
        let fixture = lp_fixture_with_plan(false, false, 2);
        let (tbc_fee, tbc_parent) = swap_fee_context(&fixture, 5_000_000, 158);
        let mut tbc_context = fixture.consume.clone();
        tbc_context.ftlp_inputs.clear();
        tbc_context.ftlp_grandparents.clear();
        tbc_context.fee_parent = tbc_parent;
        let fallback = fixture
            .pool
            .swap_to_token(tbc_context.clone(), &fixture.owner, tbc_fee.clone(), "1", 0)
            .unwrap();
        let explicit = fixture
            .pool
            .swap_to_token(tbc_context, &fixture.owner, tbc_fee, "1", 2)
            .unwrap();
        assert_eq!(fallback.to_hex(), explicit.to_hex());
        // Plan 2 uses a 5 bp LP fee, so the provider receives 3,000 sat.
        assert_eq!(fallback.outputs[4].satoshis, 3_000);
        assert_eq!(
            fallback.outputs[4].script_pubkey,
            super::service_fee_script(2).unwrap()
        );

        let (ft_fee, ft_parent) = swap_fee_context(&fixture, 100_000, 159);
        let mut ft_context = fixture.increase.clone();
        ft_context.fee_parent = ft_parent;
        let fallback = fixture
            .pool
            .swap_to_tbc(ft_context.clone(), &fixture.owner, ft_fee.clone(), "2.5", 6)
            .unwrap();
        let explicit = fixture
            .pool
            .swap_to_tbc(ft_context, &fixture.owner, ft_fee, "2.5", 2)
            .unwrap();
        assert_eq!(fallback.to_hex(), explicit.to_hex());
        assert_eq!(fallback.outputs[5].satoshis, 15);
        assert_eq!(
            fallback.outputs[5].script_pubkey,
            super::service_fee_script(2).unwrap()
        );
    }

    #[test]
    fn swap_locked_pool_requires_and_embeds_an_authorized_pool_signature() {
        let fixture = lp_fixture(true, false);
        let (tbc_fee, parent) = swap_fee_context(&fixture, 5_000_000, 155);
        let mut to_token = fixture.consume.clone();
        to_token.ftlp_inputs.clear();
        to_token.ftlp_grandparents.clear();
        to_token.fee_parent = parent;
        let tbc_to_ft = fixture
            .pool
            .swap_to_token(to_token, &fixture.owner, tbc_fee, "1", 1)
            .unwrap();
        assert!(
            tbc_to_ft.inputs[0]
                .script_sig
                .as_bytes()
                .windows(fixture.owner.public_key().to_bytes().len())
                .any(|bytes| bytes == fixture.owner.public_key().to_bytes())
        );

        let (ft_fee, parent) = swap_fee_context(&fixture, 100_000, 156);
        let mut to_tbc = fixture.increase.clone();
        to_tbc.fee_parent = parent;
        let ft_to_tbc = fixture
            .pool
            .swap_to_tbc(to_tbc, &fixture.owner, ft_fee, "0.1", 1)
            .unwrap();
        assert!(
            ft_to_tbc
                .inputs
                .iter()
                .all(|input| !input.script_sig.as_bytes().is_empty())
        );
    }

    #[test]
    fn lp_lock_time_and_locked_pool_transitions_preserve_released_ordering() {
        let timed = lp_fixture(false, true);
        let increase = timed
            .pool
            .increase_lp(
                timed.increase.clone(),
                &timed.owner,
                timed.fee.clone(),
                "0.002",
                5_000,
            )
            .unwrap();
        assert!(
            increase.outputs[5]
                .script_pubkey
                .as_bytes()
                .windows(4)
                .any(|window| window == 5_000u32.to_le_bytes())
        );
        assert!(
            timed
                .pool
                .consume_lp(
                    timed.consume.clone(),
                    &timed.owner,
                    timed.fee.clone(),
                    "0.001",
                    Some(4_999)
                )
                .is_err()
        );
        let chained = timed
            .pool
            .consume_lp(
                timed.consume.clone(),
                &timed.owner,
                timed.fee.clone(),
                "0.001",
                Some(5_000),
            )
            .unwrap();
        assert_eq!(chained.len(), 2);
        let (unlock, consume) = (&chained[0], &chained[1]);
        assert_eq!(unlock.lock_time, 5_000);
        assert_eq!(consume.lock_time, 0);
        assert_eq!(
            consume.inputs.last().unwrap().previous_output.txid,
            unlock.txid()
        );
        assert_eq!(consume.inputs.last().unwrap().previous_output.vout, 2);
        assert!(
            unlock
                .inputs
                .iter()
                .chain(consume.inputs.iter())
                .all(|input| !input.script_sig.as_bytes().is_empty())
        );

        let locked = lp_fixture(true, false);
        let increase = locked
            .pool
            .increase_lp(
                locked.increase.clone(),
                &locked.owner,
                locked.fee.clone(),
                "0.002",
                0,
            )
            .unwrap();
        assert_eq!(increase.outputs[6].satoshis, 24);
        assert_eq!(
            increase.outputs[6].script_pubkey,
            Address::from_hash160([0x44; 20]).script_pubkey()
        );
        let state = super::PoolState::from_v2_tape(
            &increase.outputs[1].script_pubkey,
            "lp-fixture".to_string(),
        )
        .unwrap();
        assert_eq!(state.amounts.tbc_sat, 11_952);
        assert_eq!(increase.outputs[0].satoshis, 1_000 + state.amounts.tbc_sat);
    }

    #[test]
    fn lp_constructed_contexts_enforce_released_input_caps() {
        let standard = lp_fixture(false, false);
        let mut too_many_pool_ft = standard.consume.clone();
        too_many_pool_ft.ft_inputs = vec![standard.consume.ft_inputs[0].clone(); 4];
        too_many_pool_ft.ft_grandparents = vec![standard.consume.ft_grandparents[0].clone(); 4];
        assert!(
            standard
                .pool
                .consume_lp(
                    too_many_pool_ft,
                    &standard.owner,
                    standard.fee.clone(),
                    "0.001",
                    None,
                )
                .is_err()
        );

        let timed = lp_fixture(false, true);
        let mut too_many_locked_lp = timed.consume.clone();
        too_many_locked_lp.ftlp_inputs = vec![timed.consume.ftlp_inputs[0].clone(); 7];
        too_many_locked_lp.ftlp_grandparents = vec![timed.consume.ftlp_grandparents[0].clone(); 7];
        assert!(
            timed
                .pool
                .consume_lp(
                    too_many_locked_lp,
                    &timed.owner,
                    timed.fee.clone(),
                    "0.001",
                    Some(5_000),
                )
                .is_err()
        );
    }

    #[test]
    fn lp_rejects_unverified_ftlp_ancestry_and_duplicate_transaction_inputs() {
        let standard = lp_fixture(false, false);
        let mut missing_ftlp_grandparent = standard.consume.clone();
        missing_ftlp_grandparent.ftlp_grandparents = vec![vec![]];
        let error = standard
            .pool
            .consume_lp(
                missing_ftlp_grandparent,
                &standard.owner,
                standard.fee.clone(),
                "0.001",
                None,
            )
            .unwrap_err();
        assert!(error.to_string().contains("grandparent"));

        let mut duplicate_pool_ft = standard.consume.clone();
        duplicate_pool_ft.ft_inputs = vec![standard.consume.ft_inputs[0].clone(); 2];
        duplicate_pool_ft.ft_grandparents = vec![standard.consume.ft_grandparents[0].clone(); 2];
        let error = standard
            .pool
            .consume_lp(
                duplicate_pool_ft,
                &standard.owner,
                standard.fee.clone(),
                "0.001",
                None,
            )
            .unwrap_err();
        assert!(error.to_string().contains("distinct"));

        let timed = lp_fixture(false, true);
        let mut duplicate_ftlp = timed.consume.clone();
        duplicate_ftlp.ftlp_inputs = vec![timed.consume.ftlp_inputs[0].clone(); 2];
        duplicate_ftlp.ftlp_grandparents = vec![timed.consume.ftlp_grandparents[0].clone(); 2];
        let error = timed
            .pool
            .consume_lp(
                duplicate_ftlp,
                &timed.owner,
                timed.fee.clone(),
                "0.001",
                Some(5_000),
            )
            .unwrap_err();
        assert!(error.to_string().contains("distinct"));

        let mut fee_collides_with_pool = standard.fee.clone();
        fee_collides_with_pool.outpoint = standard.consume.pool.pool_utxo.outpoint.clone();
        let error = standard
            .pool
            .consume_lp(
                standard.consume.clone(),
                &standard.owner,
                fee_collides_with_pool,
                "0.001",
                None,
            )
            .unwrap_err();
        assert!(error.to_string().contains("distinct"));
    }

    #[test]
    fn lp_consume_accepts_exactly_three_distinct_pool_ft_inputs() {
        let fixture = lp_fixture(false, false);
        let (ft_inputs, ft_grandparents) =
            distinct_pool_ft_inputs(&fixture, &[800_000, 900_000, 800_000]);
        assert_eq!(ft_inputs.len(), 3);
        for (index, input) in ft_inputs.iter().enumerate() {
            for other in ft_inputs.iter().skip(index + 1) {
                assert_ne!(input.utxo.base.outpoint, other.utxo.base.outpoint);
            }
        }
        let mut context = fixture.consume.clone();
        context.ft_inputs = ft_inputs;
        context.ft_grandparents = ft_grandparents;

        let built = fixture
            .pool
            .consume_lp(
                context.clone(),
                &fixture.owner,
                fixture.fee.clone(),
                "0.001",
                None,
            )
            .unwrap();
        assert_eq!(built.len(), 1);
        let consume = &built[0];
        assert_eq!(consume.inputs.len(), 6);
        assert_eq!(
            consume.inputs[2..5]
                .iter()
                .map(|input| input.previous_output.clone())
                .collect::<Vec<_>>(),
            context
                .ft_inputs
                .iter()
                .map(|input| input.utxo.base.outpoint.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            consume
                .inputs
                .iter()
                .all(|input| !input.script_sig.as_bytes().is_empty())
        );
        for index in 0..3 {
            independently_verify_input_signature(
                consume,
                index + 2,
                &context.ft_inputs[index].utxo.base.script_pubkey,
                context.ft_inputs[index].utxo.base.satoshis,
                &fixture.owner.public_key(),
            );
        }
        let state = super::PoolState::from_v2_tape(
            &consume.outputs[1].script_pubkey,
            "lp-fixture".to_string(),
        )
        .unwrap();
        assert_eq!(state.amounts.ft_lp_raw, 9_000);
        assert_eq!(state.amounts.ft_a_raw, 2_250_000);
        assert_eq!(state.amounts.tbc_sat, 9_000);
        assert_eq!(consume.outputs[0].satoshis, 1_000 + state.amounts.tbc_sat);
        assert_eq!(consume.outputs[2].satoshis, 500);
        assert_eq!(consume.outputs[3].satoshis, 0);
        assert_eq!(consume.outputs[4].satoshis, 1_000);
        assert_eq!(consume.outputs[9].satoshis, 500);
        assert_eq!(consume.outputs[10].satoshis, 0);
    }

    #[test]
    fn lp_lock_time_unlock_accepts_exactly_six_distinct_ftlp_inputs() {
        let fixture = lp_fixture(false, true);
        let balances = [1_666, 1_666, 1_666, 1_666, 1_666, 1_670];
        let (ftlp_inputs, ftlp_grandparents) =
            distinct_locked_ftlp_inputs(&fixture, &balances, 5_000);
        assert_eq!(ftlp_inputs.len(), 6);
        for (index, input) in ftlp_inputs.iter().enumerate() {
            for other in ftlp_inputs.iter().skip(index + 1) {
                assert_ne!(input.utxo.base.outpoint, other.utxo.base.outpoint);
            }
        }
        let mut context = fixture.consume.clone();
        context.ftlp_inputs = ftlp_inputs;
        context.ftlp_grandparents = ftlp_grandparents;
        let chained = fixture
            .pool
            .consume_lp(
                context.clone(),
                &fixture.owner,
                fixture.fee.clone(),
                "0.001",
                Some(5_000),
            )
            .unwrap();
        assert_eq!(chained.len(), 2);
        let (unlock, consume) = (&chained[0], &chained[1]);
        assert_eq!(unlock.inputs.len(), 7);
        assert_eq!(
            unlock.inputs[..6]
                .iter()
                .map(|input| input.previous_output.clone())
                .collect::<Vec<_>>(),
            context
                .ftlp_inputs
                .iter()
                .map(|input| input.utxo.base.outpoint.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            unlock
                .inputs
                .iter()
                .all(|input| !input.script_sig.as_bytes().is_empty())
        );
        for index in 0..6 {
            independently_verify_input_signature(
                unlock,
                index,
                &context.ftlp_inputs[index].utxo.base.script_pubkey,
                context.ftlp_inputs[index].utxo.base.satoshis,
                &fixture.owner.public_key(),
            );
        }
        assert_eq!(
            crate::contracts::ft::amount::balance_from_tape(&unlock.outputs[1].script_pubkey)
                .unwrap(),
            10_000
        );
        assert_eq!(consume.inputs[1].previous_output.txid, unlock.txid());
        assert_eq!(consume.inputs[1].previous_output.vout, 0);
        assert_eq!(
            consume.inputs.last().unwrap().previous_output.txid,
            unlock.txid()
        );
        assert_eq!(consume.inputs.last().unwrap().previous_output.vout, 2);
        assert!(
            consume
                .inputs
                .iter()
                .all(|input| !input.script_sig.as_bytes().is_empty())
        );
        let state = super::PoolState::from_v2_tape(
            &consume.outputs[1].script_pubkey,
            "lp-fixture".to_string(),
        )
        .unwrap();
        assert_eq!(state.amounts.ft_lp_raw, 9_000);
        assert_eq!(state.amounts.ft_a_raw, 2_250_000);
        assert_eq!(state.amounts.tbc_sat, 9_000);
        assert_eq!(consume.outputs[0].satoshis, 1_000 + state.amounts.tbc_sat);
    }

    #[test]
    fn ftlp_public_unlock_builds_an_expired_offline_spend() {
        let fixture = lp_fixture(false, true);
        let mut ftlp = fixture.consume.ftlp_inputs[0].clone();
        ftlp.pool = Some(fixture.consume.pool.clone());
        ftlp.fee_parent = Some(fixture.consume.fee_parent.clone());

        let unlock = fixture
            .pool
            .unlock_ftlp(&fixture.owner, fixture.fee.clone(), vec![ftlp], 5_000)
            .unwrap();

        assert_eq!(unlock.inputs.len(), 2);
        assert_eq!(unlock.outputs.len(), 3);
        assert_eq!(
            super::ftlp_lock_time_from_tape(&unlock.outputs[1].script_pubkey).unwrap(),
            0
        );
        assert_exact_signed_fee(&unlock, 100_500);
        independently_verify_input_signature(
            &unlock,
            1,
            &fixture.fee.script_pubkey,
            fixture.fee.satoshis,
            &fixture.fee.private_key.public_key(),
        );
    }

    #[test]
    fn ftlp_unlock_selects_expired_inputs_and_rejects_unexpired_only_set() {
        let fixture = lp_fixture(false, true);
        let (inputs, _) = distinct_locked_ftlp_inputs(&fixture, &[11, 12, 13], 5_000);
        let mut expired = inputs[0].clone();
        expired.pool = Some(fixture.consume.pool.clone());
        expired.fee_parent = Some(fixture.consume.fee_parent.clone());
        let mut unexpired = inputs[1].clone();
        // Rebuild its parent with a later lock time while preserving its code and ancestry.
        let source_size = expired.pre_tx.outputs[1].script_pubkey.as_bytes().len();
        unexpired.pre_tx.outputs[1].script_pubkey = super::ftlp_tape(&super::FtlpTapeParams {
            amount_raw: 12,
            layout: super::FtlpTapeLayout::LockTime {
                lock_time: 6_000,
                source_ft_tape_size: source_size,
            },
        })
        .unwrap();
        unexpired.utxo.base.outpoint.txid = unexpired.pre_tx.txid();
        unexpired.pre_pre_tx_data = crate::contracts::ft::unlock::pre_pre_tx_data_from_parents(
            &unexpired.pre_tx,
            0,
            &unexpired.grandparents,
        )
        .unwrap();
        unexpired.pool = Some(fixture.consume.pool.clone());
        unexpired.fee_parent = Some(fixture.consume.fee_parent.clone());
        let mut zero = inputs[2].clone();
        zero.pre_tx.outputs[1].script_pubkey = super::ftlp_tape(&super::FtlpTapeParams {
            amount_raw: 13,
            layout: super::FtlpTapeLayout::LockTime {
                lock_time: 0,
                source_ft_tape_size: source_size,
            },
        })
        .unwrap();
        zero.utxo.base.outpoint.txid = zero.pre_tx.txid();
        zero.pre_pre_tx_data = crate::contracts::ft::unlock::pre_pre_tx_data_from_parents(
            &zero.pre_tx,
            0,
            &zero.grandparents,
        )
        .unwrap();
        zero.pool = Some(fixture.consume.pool.clone());
        zero.fee_parent = Some(fixture.consume.fee_parent.clone());

        let tx = fixture
            .pool
            .unlock_ftlp(
                &fixture.owner,
                fixture.fee.clone(),
                vec![expired, unexpired.clone(), zero.clone()],
                5_000,
            )
            .unwrap();
        assert_eq!(tx.inputs.len(), 3, "expired and zero-lock inputs only");
        assert_eq!(
            crate::contracts::ft::amount::balance_from_tape(&tx.outputs[1].script_pubkey).unwrap(),
            24
        );
        independently_verify_input_signature(
            &tx,
            0,
            &inputs[0].utxo.base.script_pubkey,
            500,
            &fixture.owner.public_key(),
        );
        assert_exact_signed_fee(&tx, 101_000);
        independently_verify_input_signature(
            &tx,
            2,
            &fixture.fee.script_pubkey,
            fixture.fee.satoshis,
            &fixture.fee.private_key.public_key(),
        );
        independently_verify_input_signature(
            &tx,
            1,
            &inputs[2].utxo.base.script_pubkey,
            500,
            &fixture.owner.public_key(),
        );
        assert!(
            fixture
                .pool
                .unlock_ftlp(&fixture.owner, fixture.fee.clone(), vec![zero], 5_000)
                .is_err()
        );
        assert!(
            fixture
                .pool
                .unlock_ftlp(&fixture.owner, fixture.fee.clone(), vec![unexpired], 5_000)
                .is_err()
        );
    }

    #[test]
    fn ftlp_merge_and_burn_cap_at_five_and_preserve_exact_receiver() {
        let fixture = lp_fixture(false, true);
        let (inputs, _) = distinct_locked_ftlp_inputs(&fixture, &[1, 2, 3, 4, 5, 6], 5_000);
        let inputs = inputs
            .into_iter()
            .map(|mut input| {
                input.pool = Some(fixture.consume.pool.clone());
                input.fee_parent = Some(fixture.consume.fee_parent.clone());
                input
            })
            .collect::<Vec<_>>();
        assert!(
            fixture
                .pool
                .merge_ftlp(
                    &fixture.owner,
                    fixture.fee.clone(),
                    inputs[..1].to_vec(),
                    Some(5_000)
                )
                .unwrap()
                .is_none()
        );
        let merged = fixture
            .pool
            .merge_ftlp(
                &fixture.owner,
                fixture.fee.clone(),
                inputs.clone(),
                Some(5_000),
            )
            .unwrap()
            .unwrap();
        assert_eq!(merged.inputs.len(), 6, "five FTLP inputs plus fee");
        assert_exact_signed_fee(&merged, 102_500);
        assert_eq!(
            crate::contracts::ft::amount::balance_from_tape(&merged.outputs[1].script_pubkey)
                .unwrap(),
            15
        );
        for (index, input) in inputs.iter().enumerate().take(5) {
            independently_verify_input_signature(
                &merged,
                index,
                &input.utxo.base.script_pubkey,
                input.utxo.base.satoshis,
                &fixture.owner.public_key(),
            );
        }
        independently_verify_input_signature(
            &merged,
            5,
            &fixture.fee.script_pubkey,
            fixture.fee.satoshis,
            &fixture.fee.private_key.public_key(),
        );
        assert!(
            fixture
                .pool
                .burn_ftlp(&fixture.owner, fixture.fee.clone(), inputs.clone())
                .is_err()
        );
        let unlocked_inputs = inputs
            .iter()
            .cloned()
            .map(|mut input| {
                let source_size = input.pre_tx.outputs[1].script_pubkey.as_bytes().len();
                input.pre_tx.outputs[1].script_pubkey = super::ftlp_tape(&super::FtlpTapeParams {
                    amount_raw: u64::try_from(input.utxo.ft_balance_raw).unwrap(),
                    layout: super::FtlpTapeLayout::LockTime {
                        lock_time: 0,
                        source_ft_tape_size: source_size,
                    },
                })
                .unwrap();
                input.utxo.base.outpoint.txid = input.pre_tx.txid();
                input.pre_pre_tx_data = crate::contracts::ft::unlock::pre_pre_tx_data_from_parents(
                    &input.pre_tx,
                    0,
                    &input.grandparents,
                )
                .unwrap();
                input
            })
            .collect::<Vec<_>>();
        let burned = fixture
            .pool
            .burn_ftlp(&fixture.owner, fixture.fee.clone(), unlocked_inputs.clone())
            .unwrap();
        assert_exact_signed_fee(&burned, 102_500);
        let eater = Address::from_string(super::FTLP_BURN_ADDRESS).unwrap();
        assert_eq!(burned.inputs.len(), 6);
        assert_eq!(
            burned.outputs[0].script_pubkey,
            super::transfer_ftlp_code_script(&unlocked_inputs[0].utxo.base.script_pubkey, &eater)
                .unwrap()
        );
        assert_eq!(
            crate::contracts::ft::amount::balance_from_tape(&burned.outputs[1].script_pubkey)
                .unwrap(),
            15
        );
        let (amount, _) =
            crate::contracts::ft::amount::build_tape_amount_with_offset(15, &[1, 2, 3, 4, 5], 0)
                .unwrap();
        assert_eq!(
            burned.outputs[1].script_pubkey,
            crate::contracts::ft::scripts::transfer_tape_script(
                &fixture.consume.pool.contract_tx.outputs[1].script_pubkey,
                &amount,
            )
            .unwrap(),
            "locked-family burn must use the underlying authority FT tape"
        );
        for (index, input) in unlocked_inputs.iter().enumerate().take(5) {
            independently_verify_input_signature(
                &burned,
                index,
                &input.utxo.base.script_pubkey,
                500,
                &fixture.owner.public_key(),
            );
        }
        independently_verify_input_signature(
            &burned,
            5,
            &fixture.fee.script_pubkey,
            fixture.fee.satoshis,
            &fixture.fee.private_key.public_key(),
        );
    }

    #[test]
    fn standard_ftlp_merge_keeps_the_standard_tape_family() {
        let fixture = lp_fixture(false, false);
        let inputs = distinct_standard_ftlp_inputs(&fixture, &[7, 9]);
        let merged = fixture
            .pool
            .merge_ftlp(&fixture.owner, fixture.fee.clone(), inputs.clone(), None)
            .unwrap()
            .unwrap();
        assert_eq!(merged.inputs.len(), 3);
        assert_exact_signed_fee(&merged, 101_000);
        assert_eq!(
            crate::contracts::ft::amount::balance_from_tape(&merged.outputs[1].script_pubkey)
                .unwrap(),
            16
        );
        independently_verify_input_signature(
            &merged,
            2,
            &fixture.fee.script_pubkey,
            fixture.fee.satoshis,
            &fixture.fee.private_key.public_key(),
        );
    }

    #[test]
    fn standard_ftlp_merge_output_can_be_burned_in_the_next_zero_conf_transaction() {
        let fixture = lp_fixture(false, false);
        let inputs = distinct_standard_ftlp_inputs(&fixture, &[7, 9]);
        let merged = fixture
            .pool
            .merge_ftlp(&fixture.owner, fixture.fee.clone(), inputs.clone(), None)
            .unwrap()
            .unwrap();
        let grandparents = vec![inputs[1].pre_tx.clone(), inputs[0].pre_tx.clone()];
        let merged_input = FtlpSpendContext {
            utxo: crate::FtlpUtxo {
                base: UtxoInfo {
                    outpoint: OutPoint {
                        txid: merged.txid(),
                        vout: 0,
                    },
                    satoshis: merged.outputs[0].satoshis,
                    script_pubkey: merged.outputs[0].script_pubkey.clone(),
                },
                ft_balance_raw: 16,
            },
            pre_tx: merged.clone(),
            pre_pre_tx_data: crate::contracts::ft::unlock::pre_pre_tx_data_from_parents(
                &merged,
                0,
                &grandparents,
            )
            .unwrap(),
            grandparents,
            pool: Some(fixture.consume.pool.clone()),
            fee_parent: Some(merged.clone()),
        };
        let fee_vout = merged.outputs.len() - 1;
        let fee = Utxo {
            outpoint: OutPoint {
                txid: merged.txid(),
                vout: fee_vout as u32,
            },
            satoshis: merged.outputs[fee_vout].satoshis,
            script_pubkey: merged.outputs[fee_vout].script_pubkey.clone(),
            private_key: fixture.owner.clone(),
        };

        let burned = fixture
            .pool
            .burn_ftlp(&fixture.owner, fee, vec![merged_input])
            .unwrap();

        assert_eq!(burned.inputs[0].previous_output.txid, merged.txid());
        assert_eq!(burned.inputs[0].previous_output.vout, 0);
        assert_eq!(
            crate::contracts::ft::amount::balance_from_tape(&burned.outputs[1].script_pubkey)
                .unwrap(),
            16
        );
    }

    #[test]
    fn standard_consume_pays_the_full_pool_value_delta_after_reserve_value_diverges() {
        let fixture = lp_fixture(false, false);
        let mut context = fixture.consume.clone();
        context.pool.pool_pre_tx.outputs[0].satoshis += 1_000;
        context.pool.pool_utxo.satoshis = context.pool.pool_pre_tx.outputs[0].satoshis;
        context.pool.pool_utxo.outpoint.txid = context.pool.pool_pre_tx.txid();
        let delta = crate::contracts::pool_nft_v2::consume_lp(
            &context.pool.state.amounts,
            context.pool.pool_utxo.satoshis,
            1_000,
        )
        .unwrap();
        let full_value_out = u64::try_from(-delta.pool_value_delta).unwrap();
        let reserve_out = u64::try_from(-delta.tbc_sat_delta).unwrap();
        assert_ne!(full_value_out, reserve_out);

        let transaction = fixture
            .pool
            .consume_lp(context, &fixture.owner, fixture.fee.clone(), "0.001", None)
            .unwrap()
            .pop()
            .unwrap();

        assert_eq!(transaction.outputs[4].satoshis, full_value_out);
    }

    #[test]
    fn standard_ftlp_burn_uses_authority_tape_eater_and_signed_fee() {
        let fixture = lp_fixture(false, false);
        let inputs = distinct_standard_ftlp_inputs(&fixture, &[7, 9]);
        let burned = fixture
            .pool
            .burn_ftlp(&fixture.owner, fixture.fee.clone(), inputs.clone())
            .unwrap();
        let eater = Address::from_string(super::FTLP_BURN_ADDRESS).unwrap();
        let (amount, _) =
            crate::contracts::ft::amount::build_tape_amount_with_offset(16, &[7, 9], 0).unwrap();
        assert_eq!(burned.inputs.len(), 3);
        assert_eq!(
            burned.outputs[0].script_pubkey,
            super::transfer_ftlp_code_script(&inputs[0].utxo.base.script_pubkey, &eater).unwrap()
        );
        assert_eq!(
            burned.outputs[1].script_pubkey,
            crate::contracts::ft::scripts::transfer_tape_script(
                &fixture.consume.pool.contract_tx.outputs[1].script_pubkey,
                &amount,
            )
            .unwrap()
        );
        assert_exact_signed_fee(&burned, 101_000);
        for (index, input) in inputs.iter().enumerate() {
            independently_verify_input_signature(
                &burned,
                index,
                &input.utxo.base.script_pubkey,
                input.utxo.base.satoshis,
                &fixture.owner.public_key(),
            );
        }
        independently_verify_input_signature(
            &burned,
            2,
            &fixture.fee.script_pubkey,
            fixture.fee.satoshis,
            &fixture.fee.private_key.public_key(),
        );
    }

    #[test]
    fn unlock_ftlp_rejects_a_non_lock_time_pool_instead_of_merging() {
        let fixture = lp_fixture(false, false);
        let inputs = distinct_standard_ftlp_inputs(&fixture, &[7, 9]);
        assert!(
            fixture
                .pool
                .unlock_ftlp(&fixture.owner, fixture.fee.clone(), inputs, 5_000)
                .is_err()
        );
    }

    #[test]
    fn standalone_lifecycle_rejects_bad_ancestry_duplicates_and_no_mergeable_inputs() {
        let fixture = lp_fixture(false, true);
        let (inputs, _) = distinct_locked_ftlp_inputs(&fixture, &[7, 9], 5_000);
        let inputs = inputs
            .into_iter()
            .map(|mut input| {
                input.pool = Some(fixture.consume.pool.clone());
                input.fee_parent = Some(fixture.consume.fee_parent.clone());
                input
            })
            .collect::<Vec<_>>();
        let mut bad_ancestry = inputs[0].clone();
        bad_ancestry.pre_pre_tx_data[0] ^= 1;
        assert!(
            fixture
                .pool
                .merge_ftlp(
                    &fixture.owner,
                    fixture.fee.clone(),
                    vec![bad_ancestry, inputs[1].clone()],
                    Some(5_000),
                )
                .is_err()
        );
        assert!(
            fixture
                .pool
                .merge_ftlp(
                    &fixture.owner,
                    fixture.fee.clone(),
                    vec![inputs[0].clone(), inputs[0].clone()],
                    Some(5_000),
                )
                .is_err()
        );
        let mut later = inputs[0].clone();
        let source_size = later.pre_tx.outputs[1].script_pubkey.as_bytes().len();
        later.pre_tx.outputs[1].script_pubkey = super::ftlp_tape(&super::FtlpTapeParams {
            amount_raw: 7,
            layout: super::FtlpTapeLayout::LockTime {
                lock_time: 6_000,
                source_ft_tape_size: source_size,
            },
        })
        .unwrap();
        later.utxo.base.outpoint.txid = later.pre_tx.txid();
        later.pre_pre_tx_data = crate::contracts::ft::unlock::pre_pre_tx_data_from_parents(
            &later.pre_tx,
            0,
            &later.grandparents,
        )
        .unwrap();
        assert!(
            fixture
                .pool
                .merge_ftlp(
                    &fixture.owner,
                    fixture.fee.clone(),
                    vec![later],
                    Some(5_000)
                )
                .unwrap()
                .is_none()
        );

        let (pool_inputs, pool_grandparents) = distinct_pool_ft_inputs(&fixture, &[10, 20]);
        let mut pool_context = fixture.consume.clone();
        pool_context.ft_inputs = vec![pool_inputs[0].clone(), pool_inputs[0].clone()];
        pool_context.ft_grandparents =
            vec![pool_grandparents[0].clone(), pool_grandparents[0].clone()];
        pool_context.ftlp_inputs.clear();
        pool_context.ftlp_grandparents.clear();
        assert!(
            fixture
                .pool
                .merge_ft_in_pool(pool_context, &fixture.owner, fixture.fee.clone(), 1)
                .is_err()
        );
    }

    #[test]
    fn merge_pool_ft_preserves_state_and_chains_fee_change_at_vout_four() {
        let fixture = lp_fixture(false, false);
        let (inputs, grandparents) = distinct_pool_ft_inputs(&fixture, &[10, 20, 30, 40, 50, 60]);
        let mut context = fixture.consume.clone();
        context.ft_inputs = inputs.clone();
        context.ft_grandparents = grandparents;
        context.ftlp_inputs.clear();
        context.ftlp_grandparents.clear();
        let txs = fixture
            .pool
            .merge_ft_in_pool(context, &fixture.owner, fixture.fee.clone(), 2)
            .unwrap();
        assert_eq!(txs.len(), 2);
        for tx in &txs {
            let state = super::PoolState::from_v2_tape(
                &tx.outputs[1].script_pubkey,
                "lp-fixture".to_string(),
            )
            .unwrap();
            assert_eq!(state.amounts, fixture.pool.state.amounts);
            assert_eq!(tx.outputs.len(), 5);
        }
        assert_eq!(txs[1].inputs[0].previous_output.txid, txs[0].txid());
        assert_eq!(txs[1].inputs[0].previous_output.vout, 0);
        assert_eq!(
            txs[1].inputs.last().unwrap().previous_output.txid,
            txs[0].txid()
        );
        assert_eq!(txs[1].inputs.last().unwrap().previous_output.vout, 4);
        let pool_parent_data =
            crate::contracts::ft::unlock::contract_tx_data(&fixture.consume.pool.pool_pre_tx, -1)
                .unwrap();
        let authority_data =
            crate::contracts::ft::unlock::contract_tx_data(&fixture.consume.pool.contract_tx, -1)
                .unwrap();
        assert_ne!(pool_parent_data, authority_data);
        assert!(
            txs[0].inputs[1]
                .script_sig
                .as_bytes()
                .windows(pool_parent_data.len())
                .any(|window| window == pool_parent_data)
        );
        assert!(
            !txs[0].inputs[1]
                .script_sig
                .as_bytes()
                .windows(authority_data.len())
                .any(|window| window == authority_data)
        );
        for (round, tx) in txs.iter().enumerate() {
            for index in 0..4.min(inputs.len() - round * 4) {
                independently_verify_input_signature(
                    tx,
                    index + 1,
                    &inputs[round * 4 + index].utxo.base.script_pubkey,
                    500,
                    &fixture.owner.public_key(),
                );
            }
            let fee_index = tx.inputs.len() - 1;
            let fee_public_key = if round == 0 {
                fixture.fee.private_key.public_key()
            } else {
                fixture.owner.public_key()
            };
            independently_verify_input_signature(
                tx,
                fee_index,
                if round == 0 {
                    &fixture.fee.script_pubkey
                } else {
                    &txs[round - 1].outputs[4].script_pubkey
                },
                if round == 0 {
                    fixture.fee.satoshis
                } else {
                    txs[round - 1].outputs[4].satoshis
                },
                &fee_public_key,
            );
            let selected_start = round * 4;
            let selected_end = (selected_start + 4).min(inputs.len());
            let input_sum = if round == 0 {
                fixture.consume.pool.pool_utxo.satoshis
                    + inputs[selected_start..selected_end]
                        .iter()
                        .map(|input| input.utxo.base.satoshis)
                        .sum::<u64>()
                    + fixture.fee.satoshis
            } else {
                txs[round - 1].outputs[0].satoshis
                    + inputs[selected_start..selected_end]
                        .iter()
                        .map(|input| input.utxo.base.satoshis)
                        .sum::<u64>()
                    + txs[round - 1].outputs[4].satoshis
            };
            assert_exact_signed_fee(tx, input_sum);
        }
    }

    #[test]
    fn money_range_rejects_zero_and_above_max_code_values_and_non_tape_zero() {
        assert!(super::validate_money_value(1, "test").is_ok());
        assert!(super::validate_money_value(super::MAX_MONEY_SAT, "test").is_ok());
        assert!(super::validate_money_value(0, "test").is_err());
        assert!(super::validate_money_value(super::MAX_MONEY_SAT + 1, "test").is_err());
        assert!(
            super::sum_outputs(&[TxOut {
                satoshis: 0,
                script_pubkey: crate::script::Script::empty(),
            }])
            .is_err()
        );
        assert!(
            super::sum_outputs(&[TxOut {
                satoshis: 0,
                script_pubkey: crate::contracts::ft::scripts::mint_tape_script(
                    &[0; 48], 6, "Token", "TOK",
                ),
            }])
            .is_ok()
        );
    }

    #[test]
    fn create_standard_pool_builds_source_then_zero_state_mint() {
        let key = PrivateKey::from_slice(&[21; 32]).unwrap();
        let authority = authority_from_info(ft_info(), 91);
        let pool = PoolNftV2::for_create(authority.contract_tx.txid(), authority).unwrap();

        let created = pool
            .create_pool(&key, funding(&key, 100_000), "rust", 35, 1, false)
            .unwrap();

        independently_verify_input_signature(
            &created[0],
            0,
            &key.address().script_pubkey(),
            100_000,
            &key.public_key(),
        );
        independently_verify_input_signature(
            &created[1],
            0,
            &created[0].outputs[0].script_pubkey,
            created[0].outputs[0].satoshis,
            &key.public_key(),
        );

        assert_eq!(created.len(), 2);
        assert_eq!(created[0].outputs[0].satoshis, 9_800);
        assert!(
            created[0].outputs[0]
                .script_pubkey
                .as_bytes()
                .ends_with(b"for poolnft mint")
        );
        assert_eq!(created[1].inputs[0].previous_output.txid, created[0].txid());
        assert_eq!(created[1].inputs[0].previous_output.vout, 0);
        assert_eq!(created[1].outputs[0].satoshis, 1_000);
        assert_eq!(created[1].outputs[1].satoshis, 0);
        assert!(
            created[1].outputs[0]
                .script_pubkey
                .as_bytes()
                .ends_with(b"2Code")
        );
        assert!(
            created[1].outputs[1]
                .script_pubkey
                .as_bytes()
                .ends_with(b"NTape")
        );
        assert_eq!(
            crate::builder::paid_fee(&created[0], 100_000).unwrap(),
            crate::builder::fee_for_size(
                created[0].serialize().len(),
                crate::DEFAULT_FEE_RATE_SAT_PER_KB,
            )
        );
        assert_eq!(
            crate::builder::paid_fee(&created[1], 9_800).unwrap(),
            crate::builder::fee_for_size(
                created[1].serialize().len(),
                crate::DEFAULT_FEE_RATE_SAT_PER_KB,
            )
        );
    }

    #[test]
    fn state_only_handle_cannot_create_a_pool() {
        let key = PrivateKey::from_slice(&[21; 32]).unwrap();
        let pool = PoolNftV2::for_state(Txid::from_le_bytes([0x44; 32]));

        let error = pool
            .create_pool(&key, funding(&key, 100_000), "rust", 35, 1, false)
            .unwrap_err();

        assert!(error.to_string().contains("FT authority"));
    }

    #[test]
    fn create_locked_pool_accepts_one_three_and_ten_canonically_sorted_keys() {
        let key = PrivateKey::from_slice(&[21; 32]).unwrap();
        let authority = authority_from_info(ft_info(), 92);
        let pool = PoolNftV2::for_create(authority.contract_tx.txid(), authority).unwrap();
        let mut keys = (1u8..=10)
            .map(|scalar| PrivateKey::from_slice(&[scalar; 32]).unwrap().public_key())
            .collect::<Vec<_>>();
        keys.swap(1, 2);

        for selected in [&keys[..1], &keys[..3], &keys[..10]] {
            let created = pool
                .create_pool_with_lock(
                    &key,
                    funding(&key, 100_000),
                    "rust",
                    Address::from_hash160([0x55; 20]),
                    24,
                    selected,
                    35,
                    1,
                    true,
                )
                .unwrap();

            let tape = super::super::PoolState::from_v2_tape(
                &created[1].outputs[1].script_pubkey,
                "rust".to_string(),
            )
            .unwrap();
            assert!(tape.public_key_locked);
            assert!(tape.ftlp_lock_time_enabled);
            let source_tape =
                crate::script::Script::from_bytes(hex::decode(ft_info().tape_script).unwrap());
            let expected_ftlp = super::ftlp_lock_time_code(
                crate::hash::sha256(created[1].outputs[0].script_pubkey.as_bytes()),
                &key.address(),
                &super::FtlpCodeParams::for_tape(&source_tape, super::FtScriptVersion::V3, false)
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(
                tape.ft_lp_partial_hash,
                crate::contracts::ft::partial_sha256::calculate_partial_hash(
                    &expected_ftlp.as_bytes()[..1_856],
                )
            );
            assert_eq!(created[1].inputs[0].previous_output.txid, created[0].txid());
            for public_key in selected {
                assert!(
                    created[1].outputs[0]
                        .script_pubkey
                        .as_bytes()
                        .windows(33)
                        .any(|window| window == public_key.to_bytes())
                );
            }
        }
    }

    #[test]
    fn create_rejects_invalid_plan_rate_tag_keys_and_funding() {
        let key = PrivateKey::from_slice(&[21; 32]).unwrap();
        let other = PrivateKey::from_slice(&[22; 32]).unwrap();
        let authority = authority_from_info(ft_info(), 93);
        let pool = PoolNftV2::for_create(authority.contract_tx.txid(), authority).unwrap();

        for invalid_plan in [0, 7] {
            assert!(
                pool.create_pool(
                    &key,
                    funding(&key, 100_000),
                    "rust",
                    35,
                    invalid_plan,
                    false,
                )
                .is_err()
            );
        }
        for (rate, plan) in [(4, 2), (9, 1), (101, 1)] {
            assert!(
                pool.create_pool(&key, funding(&key, 100_000), "rust", rate, plan, false,)
                    .is_err(),
                "accepted invalid rate {rate} for plan {plan}"
            );
        }
        assert!(
            pool.create_pool(&key, funding(&key, 100_000), "中文", 35, 1, false,)
                .is_err()
        );

        let no_keys: [crate::PublicKey; 0] = [];
        assert!(
            pool.create_pool_with_lock(
                &key,
                funding(&key, 100_000),
                "rust",
                Address::from_hash160([0x55; 20]),
                24,
                &no_keys,
                35,
                1,
                false,
            )
            .is_err()
        );
        assert!(
            pool.create_pool_with_lock(
                &key,
                funding(&key, 100_000),
                "rust",
                Address::from_hash160([0x55; 20]),
                super::MAX_MONEY_SAT + 1,
                &[key.public_key()],
                35,
                1,
                false,
            )
            .is_err()
        );

        let wrong_funding = funding(&other, 100_000);
        assert!(
            pool.create_pool(&key, wrong_funding, "rust", 35, 1, false)
                .is_err()
        );
        assert!(
            pool.create_pool(&key, funding(&key, 9_800), "rust", 35, 1, false)
                .is_err()
        );
        assert!(
            pool.create_pool(
                &key,
                funding(&key, 21_000_000 * 100_000_000 + 1),
                "rust",
                35,
                1,
                false,
            )
            .is_err()
        );
    }

    #[test]
    fn create_accepts_exact_javascript_173_fee_plan_matrix() {
        let key = PrivateKey::from_slice(&[21; 32]).unwrap();
        let authority = authority_from_info(ft_info(), 95);
        let pool = PoolNftV2::for_create(authority.contract_tx.txid(), authority).unwrap();

        for (plan, rate) in [(1, 35), (2, 35), (3, 135), (4, 335), (5, 535), (6, 330)] {
            let created = pool
                .create_pool(&key, funding(&key, 100_000), "rust", rate, plan, false)
                .unwrap();
            let state =
                super::PoolState::from_v2_tape(&created[1].outputs[1].script_pubkey, String::new())
                    .unwrap();
            assert_eq!((state.lp_plan, state.service_fee_rate), (plan, rate));
        }
    }

    #[test]
    fn create_classifies_released_ft_families_and_commits_exact_partial_hashes() {
        let key = PrivateKey::from_slice(&[21; 32]).unwrap();
        let families = [
            (
                released_family_authority(0),
                super::FtScriptVersion::V1,
                false,
            ),
            (
                released_family_authority(1),
                super::FtScriptVersion::V2,
                false,
            ),
            (
                authority_from_info(ft_info(), 94),
                super::FtScriptVersion::V3,
                false,
            ),
            (
                real_stable_coin_authority(),
                super::FtScriptVersion::V4,
                true,
            ),
        ];

        for (family_index, (authority, version, is_coin)) in families.into_iter().enumerate() {
            let ft_code = crate::script::Script::from_bytes(
                hex::decode(&authority.info.code_script).unwrap(),
            );
            let ft_tape = crate::script::Script::from_bytes(
                hex::decode(&authority.info.tape_script).unwrap(),
            );
            let classified = crate::contracts::ft::unlock::classify_ft_script(&ft_code).unwrap();
            let expected_version = match version {
                super::FtScriptVersion::V1 => 1,
                super::FtScriptVersion::V2 => 2,
                super::FtScriptVersion::V3 => 3,
                super::FtScriptVersion::V4 => 4,
            };
            assert_eq!(
                classified.version, expected_version,
                "family {family_index}"
            );
            assert_eq!(classified.is_coin, is_coin, "family {family_index}");
            let pool = PoolNftV2::for_create(authority.contract_tx.txid(), authority).unwrap();
            let created = pool
                .create_pool(&key, funding(&key, 100_000), "rust", 35, 2, false)
                .unwrap();
            let expected_code = super::pool_code(
                OutPoint {
                    txid: created[0].txid(),
                    vout: 0,
                },
                b"rust",
                &super::PoolCodeParams {
                    lp_plan: 2,
                    ft_version: version,
                    is_coin,
                },
            )
            .unwrap();
            assert_eq!(created[1].outputs[0].script_pubkey, expected_code);

            let state = super::PoolState::from_v2_tape(
                &created[1].outputs[1].script_pubkey,
                "rust".to_string(),
            )
            .unwrap();
            let offset = super::partial_hash_offset(
                match version {
                    super::FtScriptVersion::V1 => 1,
                    super::FtScriptVersion::V2 => 2,
                    super::FtScriptVersion::V3 => 3,
                    super::FtScriptVersion::V4 => 4,
                },
                is_coin,
            )
            .unwrap();
            assert_eq!(
                state.ft_a_partial_hash,
                crate::contracts::ft::partial_sha256::calculate_partial_hash(
                    &ft_code.as_bytes()[..offset],
                )
            );
            let ftlp = super::ftlp_code(
                crate::hash::sha256(expected_code.as_bytes()),
                &key.address(),
                &super::FtlpCodeParams::for_tape(&ft_tape, version, is_coin).unwrap(),
            )
            .unwrap();
            assert_eq!(
                state.ft_lp_partial_hash,
                crate::contracts::ft::partial_sha256::calculate_partial_hash(
                    &ftlp.as_bytes()[..offset],
                ),
                "family {family_index}",
            );
        }
    }

    #[test]
    fn init_standard_pool_builds_released_six_output_core_and_signs_all_inputs() {
        let owner = PrivateKey::from_slice(&[22; 32]).unwrap();
        let authority = authority_from_info(ft_info(), 30);
        let source_ft_code =
            crate::script::Script::from_bytes(hex::decode(&authority.info.code_script).unwrap());
        let source_ft_tape =
            crate::script::Script::from_bytes(hex::decode(&authority.info.tape_script).unwrap());
        let create =
            PoolNftV2::for_create(authority.contract_tx.txid(), authority.clone()).unwrap();
        let created = create
            .create_pool(&owner, funding(&owner, 100_000), "rust", 35, 1, false)
            .unwrap();
        let state = super::PoolState::from_v2_tape(
            &created[1].outputs[1].script_pubkey,
            "rust".to_string(),
        )
        .unwrap();
        let pool = PoolNftV2 {
            contract_id: Some(created[1].txid()),
            state: state.clone(),
            current_pool_value_sat: Some(created[1].outputs[0].satoshis),
            pool_code: created[1].outputs[0].script_pubkey.clone(),
            ft_authority: None,
        };
        let lock_keys = (24u8..34)
            .map(|scalar| PrivateKey::from_slice(&[scalar; 32]).unwrap().public_key())
            .collect::<Vec<_>>();
        let locked_cases = [2usize, 10]
            .into_iter()
            .map(|key_count| {
                let created = create
                    .create_pool_with_lock(
                        &owner,
                        funding(&owner, 100_000),
                        "rust",
                        Address::from_hash160([0x55; 20]),
                        24,
                        &lock_keys[..key_count],
                        35,
                        1,
                        true,
                    )
                    .unwrap();
                let state = super::PoolState::from_v2_tape(
                    &created[1].outputs[1].script_pubkey,
                    "rust".to_string(),
                )
                .unwrap();
                let pool = PoolNftV2 {
                    contract_id: Some(created[1].txid()),
                    state: state.clone(),
                    current_pool_value_sat: Some(created[1].outputs[0].satoshis),
                    pool_code: created[1].outputs[0].script_pubkey.clone(),
                    ft_authority: None,
                };
                (key_count, created, state, pool)
            })
            .collect::<Vec<_>>();

        let ft_grandparent = transaction_with_outputs(
            vec![TxOut {
                satoshis: 500,
                script_pubkey: source_ft_code.clone(),
            }],
            31,
        );
        let amount_tape = crate::contracts::ft::amount::build_tape_amount(2_500_000, &[2_500_000])
            .unwrap()
            .0;
        let owned_ft_code = crate::contracts::ft::scripts::transfer_code_script(
            &source_ft_code,
            crate::contracts::ft::scripts::FtCodeReceiver::Address(owner.address()),
        )
        .unwrap();
        let ft_pre_tx = transaction_with_outputs(
            vec![
                TxOut {
                    satoshis: 500,
                    script_pubkey: owned_ft_code.clone(),
                },
                TxOut {
                    satoshis: 0,
                    script_pubkey: crate::contracts::ft::scripts::transfer_tape_script(
                        &source_ft_tape,
                        &amount_tape,
                    )
                    .unwrap(),
                },
            ],
            32,
        );
        let mut ft_pre_tx = ft_pre_tx;
        ft_pre_tx.inputs[0].previous_output = OutPoint {
            txid: ft_grandparent.txid(),
            vout: 0,
        };
        let pre_pre_tx_data = crate::contracts::ft::unlock::pre_pre_tx_data_from_parents(
            &ft_pre_tx,
            0,
            std::slice::from_ref(&ft_grandparent),
        )
        .unwrap();
        assert_eq!(
            hex::encode(&pre_pre_tx_data),
            "57100a00000000000000010000000100000020bfe7fb86ddae1445c49ec201de0477ad5937cf4ff3eb33ab3ec8643f5563bbc3205df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c94560008f4010000000000001c15670caa79e51d78ed0c583b89ff39d9c49b7199e7000532436f646520e9e76d08326b8948550c4f56ed9f31889f285ec9751caf3b15fe676ba628bb4f025c070052"
        );
        let ft = FtSpendContext {
            utxo: FtUtxo {
                base: Utxo {
                    outpoint: OutPoint {
                        txid: ft_pre_tx.txid(),
                        vout: 0,
                    },
                    satoshis: 500,
                    script_pubkey: owned_ft_code,
                    private_key: owner.clone(),
                },
                ft_balance_raw: 2_500_000,
            },
            pre_tx: ft_pre_tx,
            pre_pre_tx_data,
        };
        let fee_key = PrivateKey::from_slice(&[23; 32]).unwrap();
        let fee_parent = transaction_with_outputs(
            vec![TxOut {
                satoshis: 100_000,
                script_pubkey: fee_key.address().script_pubkey(),
            }],
            33,
        );
        let fee = Utxo {
            outpoint: OutPoint {
                txid: fee_parent.txid(),
                vout: 0,
            },
            satoshis: 100_000,
            script_pubkey: fee_key.address().script_pubkey(),
            private_key: fee_key.clone(),
        };
        let locked_init_cases = locked_cases
            .into_iter()
            .map(|(key_count, created, state, pool)| {
                let context = PoolInitContext {
                    pool: PoolSpendContext {
                        pool_utxo: UtxoInfo {
                            outpoint: OutPoint {
                                txid: created[1].txid(),
                                vout: 0,
                            },
                            satoshis: 1_000,
                            script_pubkey: created[1].outputs[0].script_pubkey.clone(),
                        },
                        pool_pre_tx: created[1].clone(),
                        pool_pre_pre_tx: created[0].clone(),
                        contract_tx: authority.contract_tx.clone(),
                        state,
                    },
                    ft: ft.clone(),
                    ft_authority: authority.clone(),
                    ft_grandparents: vec![ft_grandparent.clone()],
                    fee_parent: fee_parent.clone(),
                    lp_receiver: owner.address(),
                    public_key_lock: lock_keys[..key_count].to_vec(),
                };
                (key_count, pool, context)
            })
            .collect::<Vec<_>>();
        let init_context = PoolInitContext {
            pool: PoolSpendContext {
                pool_utxo: UtxoInfo {
                    outpoint: OutPoint {
                        txid: created[1].txid(),
                        vout: 0,
                    },
                    satoshis: 1_000,
                    script_pubkey: created[1].outputs[0].script_pubkey.clone(),
                },
                pool_pre_tx: created[1].clone(),
                pool_pre_pre_tx: created[0].clone(),
                contract_tx: authority.contract_tx.clone(),
                state,
            },
            ft,
            ft_authority: authority,
            ft_grandparents: vec![ft_grandparent],
            fee_parent,
            lp_receiver: owner.address(),
            public_key_lock: vec![],
        };
        let mut wrong_fee = fee.clone();
        wrong_fee.private_key = owner.clone();
        assert!(
            pool.init_pool(init_context.clone(), &owner, wrong_fee, "0.01", "2.5", 0,)
                .is_err()
        );
        assert!(
            pool.init_pool(
                init_context.clone(),
                &owner,
                fee.clone(),
                "0.0000001",
                "2.5",
                0,
            )
            .is_err()
        );
        assert!(
            pool.init_pool(
                init_context.clone(),
                &owner,
                fee.clone(),
                "18446744073709.551615",
                "2.5",
                0,
            )
            .is_err()
        );
        assert!(
            pool.init_pool(
                init_context.clone(),
                &owner,
                fee.clone(),
                "0.01",
                "2.5000001",
                0,
            )
            .is_err()
        );
        let mut bad_ancestry = init_context.clone();
        bad_ancestry.ft.pre_tx.outputs[0].satoshis += 1;
        assert!(
            pool.init_pool(bad_ancestry, &owner, fee.clone(), "0.01", "2.5", 0)
                .is_err()
        );
        let mut arbitrary_pre_pre = init_context.clone();
        arbitrary_pre_pre.ft.pre_pre_tx_data = vec![0xaa];
        assert!(
            pool.init_pool(arbitrary_pre_pre, &owner, fee.clone(), "0.01", "2.5", 0)
                .is_err()
        );
        let mut wrong_grandparent = init_context.clone();
        wrong_grandparent.ft_grandparents[0].outputs[0].satoshis += 1;
        assert!(
            pool.init_pool(wrong_grandparent, &owner, fee.clone(), "0.01", "2.5", 0)
                .is_err()
        );
        let mut wrong_balance = init_context.clone();
        wrong_balance.ft.utxo.ft_balance_raw -= 1;
        assert!(
            pool.init_pool(wrong_balance, &owner, fee.clone(), "0.01", "2.5", 0)
                .is_err()
        );
        for invalid in [0, super::MAX_MONEY_SAT + 1] {
            let mut invalid_pool_input = init_context.clone();
            invalid_pool_input.pool.pool_utxo.satoshis = invalid;
            assert!(
                pool.init_pool(invalid_pool_input, &owner, fee.clone(), "0.01", "2.5", 0,)
                    .is_err()
            );

            let mut invalid_ft_input = init_context.clone();
            invalid_ft_input.ft.utxo.base.satoshis = invalid;
            assert!(
                pool.init_pool(invalid_ft_input, &owner, fee.clone(), "0.01", "2.5", 0,)
                    .is_err()
            );

            let mut invalid_fee = fee.clone();
            invalid_fee.satoshis = invalid;
            assert!(
                pool.init_pool(init_context.clone(), &owner, invalid_fee, "0.01", "2.5", 0,)
                    .is_err()
            );
        }
        let mut wrong_contract_pool = pool.clone();
        wrong_contract_pool.contract_id = Some(Txid::from_le_bytes([0x66; 32]));
        assert!(
            wrong_contract_pool
                .init_pool(init_context.clone(), &owner, fee.clone(), "0.01", "2.5", 0,)
                .is_err()
        );
        let initialized = pool
            .init_pool(init_context.clone(), &owner, fee.clone(), "0.01", "2.5", 0)
            .unwrap();

        independently_verify_input_signature(
            &initialized,
            1,
            &init_context.ft.utxo.base.script_pubkey,
            init_context.ft.utxo.base.satoshis,
            &owner.public_key(),
        );
        independently_verify_input_signature(
            &initialized,
            2,
            &fee.script_pubkey,
            fee.satoshis,
            &fee_key.public_key(),
        );

        assert_eq!(initialized.inputs.len(), 3);
        assert!(
            initialized
                .inputs
                .iter()
                .all(|input| !input.script_sig.as_bytes().is_empty())
        );
        assert_eq!(initialized.outputs[0].satoshis, 11_000);
        assert_eq!(initialized.outputs[1].satoshis, 0);
        assert_eq!(initialized.outputs[2].satoshis, 500);
        assert_eq!(initialized.outputs[3].satoshis, 0);
        assert_eq!(initialized.outputs[4].satoshis, 500);
        assert_eq!(initialized.outputs[5].satoshis, 0);
        assert_eq!(
            initialized.outputs.last().unwrap().script_pubkey,
            fee_key.address().script_pubkey()
        );
        assert_eq!(
            crate::builder::paid_fee(&initialized, 101_500).unwrap(),
            crate::builder::fee_for_size(
                initialized.serialize().len(),
                crate::DEFAULT_FEE_RATE_SAT_PER_KB,
            )
        );
        let initialized_state = super::PoolState::from_v2_tape(
            &initialized.outputs[1].script_pubkey,
            "rust".to_string(),
        )
        .unwrap();
        assert_eq!(initialized_state.amounts.ft_lp_raw, 10_000);
        assert_eq!(initialized_state.amounts.ft_a_raw, 2_500_000);
        assert_eq!(initialized_state.amounts.tbc_sat, 10_000);

        let locked_results = locked_init_cases
            .into_iter()
            .map(|(key_count, pool, context)| {
                let result =
                    pool.init_pool(context.clone(), &owner, fee.clone(), "0.01", "2.5", 1_234);
                (key_count, context, result)
            })
            .collect::<Vec<_>>();
        let failures = locked_results
            .iter()
            .filter_map(|(key_count, _, result)| {
                result
                    .as_ref()
                    .err()
                    .map(|error| (*key_count, error.to_string()))
            })
            .collect::<Vec<_>>();
        assert!(failures.is_empty(), "locked init failures: {failures:?}");
        for (_, locked_init_context, locked_initialized) in locked_results {
            let locked_initialized = locked_initialized.unwrap();
            assert_eq!(locked_initialized.outputs.len(), 8);
            assert_eq!(locked_initialized.outputs[6].satoshis, 24);
            assert_eq!(
                locked_initialized.outputs[6].script_pubkey,
                Address::from_hash160([0x55; 20]).script_pubkey()
            );
            assert_eq!(
                locked_initialized.outputs[7].script_pubkey,
                fee_key.address().script_pubkey()
            );
            let locked_initialized_state = super::PoolState::from_v2_tape(
                &locked_initialized.outputs[1].script_pubkey,
                "rust".to_string(),
            )
            .unwrap();
            assert!(locked_initialized_state.public_key_locked);
            assert!(locked_initialized_state.ftlp_lock_time_enabled);
            assert_eq!(locked_initialized_state.amounts.ft_lp_raw, 9_976);
            assert_eq!(locked_initialized_state.amounts.ft_a_raw, 2_500_000);
            assert_eq!(locked_initialized_state.amounts.tbc_sat, 9_976);
            assert!(
                locked_initialized.outputs[5]
                    .script_pubkey
                    .as_bytes()
                    .windows(4)
                    .any(|window| window == 1_234u32.to_le_bytes())
            );
            let locked_parents = [
                locked_init_context.ft.pre_tx.clone(),
                locked_init_context.fee_parent.clone(),
            ];
            let expected_unlock = super::pool_unlock(&super::PoolUnlockContext {
                transaction: &locked_initialized,
                input_index: 0,
                spent_vout: 0,
                pool: &locked_init_context.pool,
                input_parents: &locked_parents,
                option: super::PoolUnlockOption::IncreaseLiquidity,
                swap_option: None,
                with_lock: true,
                signature: None,
                public_key_lock: &locked_init_context.public_key_lock,
            })
            .unwrap();
            assert_eq!(
                locked_initialized.inputs[0].script_sig.as_bytes(),
                expected_unlock
            );
        }
    }
}
