#![doc = include_str!("../../../docs/pool-nft-v2-api.md")]

#[cfg(feature = "internal-signing")]
pub mod builder;
pub mod data;
pub mod math;
pub mod scripts;
pub mod unlock;

#[cfg(feature = "internal-signing")]
pub use builder::{PoolFtAuthority, PoolInitContext, PoolNftV2};

use crate::FtlpUtxo;
#[cfg(feature = "internal-signing")]
use crate::{Error, Result, script::Script};
#[cfg(feature = "network-api")]
use crate::{Address, ApiClient, FtUtxo, PrivateKey, PublicKey, Utxo};
pub use data::{
    FtSpendContext, FtlpSpendContext, LocalPoolOperationContext, LockedLpCost, PoolAmounts,
    PoolDifference, PoolOperationContext, PoolSpendContext, PoolState, PoolSwapOption,
    PoolUnlockContext, PoolUnlockOption, PoolUnlockSignature, PoolUpdate,
};
pub use math::{
    POOL_CODE_DUST_SAT, consume_lp, format_decimal_raw, increase_lp, initial_lp_raw,
    parse_decimal_raw, swap_ft_to_tbc, swap_tbc_to_ft,
};
pub use scripts::{
    FTLP_CODE_SATOSHIS, FTLP_TAPE_SATOSHIS, FtScriptVersion, FtlpCodeParams, FtlpTapeLayout,
    FtlpTapeParams, LockedPoolCodeParams, POOL_CODE_SATOSHIS, POOL_TAPE_SATOSHIS, PoolCodeParams,
    ftlp_code, ftlp_lock_time_code, ftlp_tape, locked_pool_code, pool_code, pool_held_ft_code,
    pool_tape,
};
pub use unlock::{
    current_inputs_data, input_parent_data, pool_outputs_data, pool_parent_data,
    pool_pre_parent_data, pool_unlock, pool_unlock_requires_signature, pool_unlock_unsigned_body,
    push_data_length, script_size_le,
};

#[cfg(feature = "internal-signing")]
impl PoolNftV2 {
    /// Applies the released `UpdatePoolNFT` arithmetic without mutating this
    /// handle.  Transaction builders remain the authoritative consumers of
    /// the returned explicit state and difference.
    pub fn update_pool_state(
        &self,
        increment_human: &str,
        ft_decimal: u8,
        option: PoolUpdate,
    ) -> Result<(PoolState, PoolDifference)> {
        let amount = parse_decimal_raw(
            increment_human,
            if option == PoolUpdate::FtA {
                ft_decimal
            } else {
                6
            },
        )?;
        if amount == 0 {
            return Ok((self.state.clone(), zero_pool_difference()));
        }
        let current_pool_value = self.current_pool_value_sat.ok_or_else(|| {
            pool_facade_error("Pool value is unavailable; load the Pool from its contract id")
        })?;
        let (next_amounts, next_pool_value) =
            released_pool_update(&self.state.amounts, current_pool_value, amount, option)?;
        let difference = pool_difference(
            &self.state.amounts,
            current_pool_value,
            &next_amounts,
            next_pool_value,
        )?;
        let mut next = self.state.clone();
        next.amounts = next_amounts;
        Ok((next, difference))
    }

    /// Builds the canonical current Pool NTape with caller-selected released
    /// operation flags, without changing the handle's cached state.
    pub fn pool_tape(
        &self,
        lp_plan: u8,
        public_key_locked: bool,
        ftlp_lock_time_enabled: bool,
    ) -> Result<Script> {
        let mut state = self.state.clone();
        state.lp_plan = lp_plan;
        state.public_key_locked = public_key_locked;
        state.ftlp_lock_time_enabled = ftlp_lock_time_enabled;
        crate::contracts::pool_nft_v2::scripts::pool_tape(&state)
    }

    /// Serializes a Pool unlock from fully explicit local context.  This
    /// method never performs a query and is suitable for zero-confirmation
    /// child transactions.
    pub fn pool_unlock_offline(&self, context: &PoolUnlockContext<'_>) -> Result<Script> {
        Ok(Script::from_bytes(pool_unlock(context)?))
    }

    /// Resolves the live Pool UTXO and its required parent transactions into
    /// the same explicit context accepted by every offline Pool builder.
    #[cfg(feature = "network-api")]
    pub async fn resolve_pool_spend_context(&self, api: &ApiClient) -> Result<PoolSpendContext> {
        let contract_id = self.contract_id.ok_or_else(|| {
            pool_facade_error(
                "online Pool resolution requires a contract id; use for_create offline",
            )
        })?;
        let info = api.fetch_pool_nft_info(&contract_id).await?;
        let pool_pre_tx = api
            .fetch_raw_transaction(&info.current_utxo.outpoint.txid.to_string())
            .await?;
        if pool_pre_tx.txid() != info.current_utxo.outpoint.txid {
            return Err(pool_facade_error(
                "current Pool response transaction id does not match its requested outpoint",
            ));
        }
        let pool_input = pool_pre_tx.inputs.first().ok_or_else(|| {
            pool_facade_error("current Pool transaction is missing its Pool input")
        })?;
        if pool_input.previous_output.vout != 0 {
            return Err(pool_facade_error("current Pool input must spend vout 0"));
        }
        let pool_pre_pre_tx = api
            .fetch_raw_transaction(&pool_input.previous_output.txid.to_string())
            .await?;
        if pool_pre_pre_tx.txid() != pool_input.previous_output.txid {
            return Err(pool_facade_error(
                "previous Pool response transaction id does not match its requested outpoint",
            ));
        }
        let contract_tx = api
            .fetch_raw_transaction(&info.state.ft_a_contract_id.to_string())
            .await?;
        if contract_tx.txid() != info.state.ft_a_contract_id {
            return Err(pool_facade_error(
                "FT authority response transaction id does not match the Pool state",
            ));
        }
        let context = PoolSpendContext {
            pool_utxo: info.current_utxo,
            pool_pre_tx,
            pool_pre_pre_tx,
            contract_tx,
            state: info.state,
        };
        // Fail at the query boundary if the indexed state is bound to an
        // invalid FT authority. This includes Coin's released vout 3/4 pair.
        builder::pool_ft_authority_from_context(&context)?;
        Ok(context)
    }

    /// Fetches every FTLP UTXO controlled by `owner`.  The exact standard or
    /// lock-time FTLP Code is derived from the live Pool state and validated
    /// FT authority; callers never provide a hand-assembled script hash.
    #[cfg(feature = "network-api")]
    pub async fn fetch_ftlp_utxos(
        &self,
        api: &ApiClient,
        owner: &Address,
    ) -> Result<Vec<FtlpUtxo>> {
        let context = self.resolve_pool_spend_context(api).await?;
        let code = builder::ftlp_code_for_owner(&context, owner)?;
        api.fetch_ftlp_utxos(&code).await
    }

    /// Returns the checked sum of all owner FTLP UTXOs.
    #[cfg(feature = "network-api")]
    pub async fn fetch_ftlp_balance(&self, api: &ApiClient, owner: &Address) -> Result<u128> {
        self.fetch_ftlp_utxos(api, owner)
            .await?
            .into_iter()
            .try_fold(0u128, |sum, utxo| {
                sum.checked_add(utxo.ft_balance_raw)
                    .ok_or_else(|| pool_facade_error("FTLP balance overflow"))
            })
    }

    /// Fetches lock-time metadata for each owner FTLP UTXO.  Standard FTLP
    /// has no lock-time tape, so this returns a precise error instead of
    /// inventing a zero value.
    #[cfg(feature = "network-api")]
    pub async fn fetch_ftlp_lock_times(
        &self,
        api: &ApiClient,
        owner: &Address,
    ) -> Result<Vec<FtlpLockTimeEntry>> {
        let context = self.resolve_pool_spend_context(api).await?;
        if !context.state.ftlp_lock_time_enabled {
            return Err(pool_facade_error(
                "FTLP lock-time query requires a lock-time-enabled Pool",
            ));
        }
        let code = builder::ftlp_code_for_owner(&context, owner)?;
        let utxos = api.fetch_ftlp_utxos(&code).await?;
        let mut entries = Vec::with_capacity(utxos.len());
        for utxo in utxos {
            let transaction = api
                .fetch_raw_transaction(&utxo.base.outpoint.txid.to_string())
                .await?;
            ensure_raw_txid(&transaction, utxo.base.outpoint.txid, "FTLP lock-time")?;
            let tape = transaction
                .outputs
                .get(utxo.base.outpoint.vout as usize + 1)
                .ok_or_else(|| pool_facade_error("FTLP transaction is missing Tape vout + 1"))?;
            entries.push(FtlpLockTimeEntry {
                lock_time: ftlp_lock_time_from_tape(&tape.script_pubkey)?,
                utxo,
            });
        }
        Ok(entries)
    }

    /// Resolves caller-selected FT and FTLP API records into the fully
    /// explicit operation context consumed by the existing offline builders.
    /// FT discovery is intentionally caller-controlled because the public
    /// indexer has no canonical "select sufficient FT inputs" endpoint.
    #[cfg(feature = "network-api")]
    #[allow(clippy::too_many_arguments)]
    pub async fn resolve_operation_context(
        &self,
        api: &ApiClient,
        ft_inputs: Vec<FtUtxo>,
        ftlp_inputs: Vec<FtlpUtxo>,
        fee: &Utxo,
        public_key_lock: Vec<PublicKey>,
        locked_lp_cost: Option<LockedLpCost>,
    ) -> Result<PoolOperationContext> {
        let pool = self.resolve_pool_spend_context(api).await?;
        let mut resolved_ft = Vec::with_capacity(ft_inputs.len());
        let mut ft_grandparents = Vec::with_capacity(ft_inputs.len());
        for utxo in ft_inputs {
            let (spend, grandparents) = resolve_ft_spend(api, utxo).await?;
            resolved_ft.push(spend);
            ft_grandparents.push(grandparents);
        }
        let mut resolved_ftlp = Vec::with_capacity(ftlp_inputs.len());
        let mut ftlp_grandparents = Vec::with_capacity(ftlp_inputs.len());
        for utxo in ftlp_inputs {
            let (spend, grandparents) = resolve_ftlp_spend(api, utxo, &pool).await?;
            resolved_ftlp.push(spend);
            ftlp_grandparents.push(grandparents);
        }
        let fee_parent = api
            .fetch_raw_transaction(&fee.outpoint.txid.to_string())
            .await?;
        ensure_raw_txid(&fee_parent, fee.outpoint.txid, "fee parent")?;
        Ok(PoolOperationContext {
            pool,
            ft_inputs: resolved_ft,
            ftlp_inputs: resolved_ftlp,
            ft_grandparents,
            ftlp_grandparents,
            fee_parent,
            public_key_lock,
            locked_lp_cost,
        })
    }

    /// Resolves all current owner FTLP UTXOs into standalone lifecycle spend
    /// contexts.  Callers pass a selected subset to `unlock_ftlp`,
    /// `merge_ftlp`, or `burn_ftlp`; transaction construction stays in those
    /// offline builders.
    #[cfg(feature = "network-api")]
    pub async fn resolve_ftlp_spends(
        &self,
        api: &ApiClient,
        owner: &Address,
        fee: &Utxo,
    ) -> Result<Vec<FtlpSpendContext>> {
        let pool = self.resolve_pool_spend_context(api).await?;
        let code = builder::ftlp_code_for_owner(&pool, owner)?;
        let utxos = api.fetch_ftlp_utxos(&code).await?;
        self.resolve_selected_ftlp_spends(api, utxos, &pool, fee)
            .await
    }

    #[cfg(feature = "network-api")]
    async fn resolve_selected_ftlp_spends(
        &self,
        api: &ApiClient,
        utxos: Vec<FtlpUtxo>,
        pool: &PoolSpendContext,
        fee: &Utxo,
    ) -> Result<Vec<FtlpSpendContext>> {
        let fee_parent = api
            .fetch_raw_transaction(&fee.outpoint.txid.to_string())
            .await?;
        ensure_raw_txid(&fee_parent, fee.outpoint.txid, "fee parent")?;
        let mut spends = Vec::with_capacity(utxos.len());
        for utxo in utxos {
            let (mut spend, _) = resolve_ftlp_spend(api, utxo, pool).await?;
            spend.fee_parent = Some(fee_parent.clone());
            spends.push(spend);
        }
        Ok(spends)
    }

    /// Resolves indexed inputs, then delegates to the established initializer.
    #[cfg(feature = "network-api")]
    #[allow(clippy::too_many_arguments)]
    pub async fn init_pool_online(
        &self,
        api: &ApiClient,
        ft_input: FtUtxo,
        owner: &PrivateKey,
        fee: Utxo,
        lp_receiver: Address,
        public_key_lock: Vec<PublicKey>,
        tbc_human: &str,
        ft_human: &str,
        lock_time: u32,
    ) -> Result<crate::Transaction> {
        let pool = self.resolve_pool_spend_context(api).await?;
        let (ft, ft_grandparents) = resolve_ft_spend(api, ft_input).await?;
        let fee_parent = api
            .fetch_raw_transaction(&fee.outpoint.txid.to_string())
            .await?;
        ensure_raw_txid(&fee_parent, fee.outpoint.txid, "fee parent")?;
        self.init_pool(
            PoolInitContext {
                ft_authority: builder::pool_ft_authority_from_context(&pool)?,
                pool,
                ft,
                ft_grandparents,
                fee_parent,
                lp_receiver,
                public_key_lock,
            },
            owner,
            fee,
            tbc_human,
            ft_human,
            lock_time,
        )
    }

    #[cfg(feature = "network-api")]
    #[allow(clippy::too_many_arguments)]
    pub async fn increase_lp_online(
        &self,
        api: &ApiClient,
        ft_input: FtUtxo,
        owner: &PrivateKey,
        fee: Utxo,
        tbc_human: &str,
        lock_time: u32,
        public_key_lock: Vec<PublicKey>,
        locked_lp_cost: Option<LockedLpCost>,
    ) -> Result<crate::Transaction> {
        let context = self
            .resolve_operation_context(
                api,
                vec![ft_input],
                vec![],
                &fee,
                public_key_lock,
                locked_lp_cost,
            )
            .await?;
        self.increase_lp(context, owner, fee, tbc_human, lock_time)
    }

    #[cfg(feature = "network-api")]
    #[allow(clippy::too_many_arguments)]
    pub async fn consume_lp_online(
        &self,
        api: &ApiClient,
        pool_ft_inputs: Vec<FtUtxo>,
        ftlp_inputs: Vec<FtlpUtxo>,
        owner: &PrivateKey,
        fee: Utxo,
        lp_human: &str,
        current_lock_time: Option<u32>,
        public_key_lock: Vec<PublicKey>,
    ) -> Result<Vec<crate::Transaction>> {
        let context = self
            .resolve_operation_context(
                api,
                pool_ft_inputs,
                ftlp_inputs,
                &fee,
                public_key_lock,
                None,
            )
            .await?;
        self.consume_lp(context, owner, fee, lp_human, current_lock_time)
    }

    #[cfg(feature = "network-api")]
    #[allow(clippy::too_many_arguments)]
    pub async fn swap_to_token_online(
        &self,
        api: &ApiClient,
        pool_ft_inputs: Vec<FtUtxo>,
        owner: &PrivateKey,
        fee: Utxo,
        tbc_human: &str,
        lp_plan: u8,
        public_key_lock: Vec<PublicKey>,
    ) -> Result<crate::Transaction> {
        let context = self
            .resolve_operation_context(api, pool_ft_inputs, vec![], &fee, public_key_lock, None)
            .await?;
        self.swap_to_token(context, owner, fee, tbc_human, lp_plan)
    }

    #[cfg(feature = "network-api")]
    #[allow(clippy::too_many_arguments)]
    pub async fn swap_to_tbc_online(
        &self,
        api: &ApiClient,
        ft_inputs: Vec<FtUtxo>,
        owner: &PrivateKey,
        fee: Utxo,
        ft_human: &str,
        lp_plan: u8,
        public_key_lock: Vec<PublicKey>,
    ) -> Result<crate::Transaction> {
        let context = self
            .resolve_operation_context(api, ft_inputs, vec![], &fee, public_key_lock, None)
            .await?;
        self.swap_to_tbc(context, owner, fee, ft_human, lp_plan)
    }

    #[cfg(feature = "network-api")]
    pub async fn unlock_ftlp_online(
        &self,
        api: &ApiClient,
        owner: &PrivateKey,
        fee: Utxo,
        current_lock_time: u32,
    ) -> Result<crate::Transaction> {
        let spends = self
            .resolve_ftlp_spends(api, &owner.address(), &fee)
            .await?;
        self.unlock_ftlp(owner, fee, spends, current_lock_time)
    }

    #[cfg(feature = "network-api")]
    pub async fn merge_ftlp_online(
        &self,
        api: &ApiClient,
        owner: &PrivateKey,
        fee: Utxo,
        current_lock_time: Option<u32>,
    ) -> Result<Option<crate::Transaction>> {
        let spends = self
            .resolve_ftlp_spends(api, &owner.address(), &fee)
            .await?;
        self.merge_ftlp(owner, fee, spends, current_lock_time)
    }

    #[cfg(feature = "network-api")]
    pub async fn burn_ftlp_online(
        &self,
        api: &ApiClient,
        owner: &PrivateKey,
        fee: Utxo,
    ) -> Result<crate::Transaction> {
        let spends = self
            .resolve_ftlp_spends(api, &owner.address(), &fee)
            .await?;
        self.burn_ftlp(owner, fee, spends)
    }

    #[cfg(feature = "network-api")]
    #[allow(clippy::too_many_arguments)]
    pub async fn merge_ft_in_pool_online(
        &self,
        api: &ApiClient,
        pool_ft_inputs: Vec<FtUtxo>,
        owner: &PrivateKey,
        fee: Utxo,
        rounds: usize,
        public_key_lock: Vec<PublicKey>,
    ) -> Result<Vec<crate::Transaction>> {
        let context = self
            .resolve_operation_context(api, pool_ft_inputs, vec![], &fee, public_key_lock, None)
            .await?;
        self.merge_ft_in_pool(context, owner, fee, rounds)
    }
}

/// A lock-time value decoded from an FTLP Tape together with the queried FTLP
/// UTXO that carries it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FtlpLockTimeEntry {
    pub utxo: FtlpUtxo,
    pub lock_time: u32,
}

#[cfg(feature = "network-api")]
fn ftlp_lock_time_from_tape(tape: &Script) -> Result<u32> {
    let chunks = op_return_pushes(tape)?;
    let amount = chunks
        .first()
        .filter(|value| value.len() == 48)
        .ok_or_else(|| pool_facade_error("FTLP lock-time Tape has no 48-byte amount field"))?;
    let _ = amount;
    let lock_time: [u8; 4] = chunks
        .get(1)
        .filter(|value| value.len() == 4)
        .ok_or_else(|| pool_facade_error("FTLP lock-time Tape has no four-byte lock time"))?
        .as_slice()
        .try_into()
        .expect("length checked");
    if chunks.last().map(Vec::as_slice) != Some(b"FTape") {
        return Err(pool_facade_error("FTLP lock-time Tape marker is missing"));
    }
    Ok(u32::from_le_bytes(lock_time))
}

#[cfg(feature = "network-api")]
fn op_return_pushes(script: &Script) -> Result<Vec<Vec<u8>>> {
    let bytes = script.as_bytes();
    if !bytes.starts_with(&[0x00, 0x6a]) {
        return Err(pool_facade_error("Tape must begin OP_FALSE OP_RETURN"));
    }
    let mut offset = 2usize;
    let mut chunks = Vec::new();
    while offset < bytes.len() {
        let opcode = bytes[offset];
        offset += 1;
        let length = match opcode {
            0x00..=0x4b => usize::from(opcode),
            0x4c => usize::from(
                *bytes
                    .get(offset)
                    .ok_or_else(|| pool_facade_error("truncated OP_PUSHDATA1"))?,
            ),
            0x4d => {
                let raw: [u8; 2] = bytes
                    .get(offset..offset + 2)
                    .ok_or_else(|| pool_facade_error("truncated OP_PUSHDATA2"))?
                    .try_into()
                    .expect("length checked");
                offset += 2;
                usize::from(u16::from_le_bytes(raw))
            }
            0x4e => {
                let raw: [u8; 4] = bytes
                    .get(offset..offset + 4)
                    .ok_or_else(|| pool_facade_error("truncated OP_PUSHDATA4"))?
                    .try_into()
                    .expect("length checked");
                offset += 4;
                usize::try_from(u32::from_le_bytes(raw))
                    .map_err(|_| pool_facade_error("FTLP push length overflow"))?
            }
            _ => return Err(pool_facade_error("Tape contains a non-push opcode")),
        };
        if opcode == 0x4c {
            offset += 1;
        }
        let end = offset
            .checked_add(length)
            .ok_or_else(|| pool_facade_error("FTLP push length overflow"))?;
        chunks.push(
            bytes
                .get(offset..end)
                .ok_or_else(|| pool_facade_error("truncated Tape field"))?
                .to_vec(),
        );
        offset = end;
    }
    Ok(chunks)
}

#[cfg(feature = "network-api")]
async fn resolve_ft_spend(
    api: &ApiClient,
    utxo: FtUtxo,
) -> Result<(FtSpendContext, Vec<crate::Transaction>)> {
    let pre_tx = api
        .fetch_raw_transaction(&utxo.base.outpoint.txid.to_string())
        .await?;
    ensure_raw_txid(&pre_tx, utxo.base.outpoint.txid, "FT input")?;
    let vout = usize::try_from(utxo.base.outpoint.vout)
        .map_err(|_| pool_facade_error("FT vout does not fit usize"))?;
    let grandparents = api.fetch_ft_pre_pre_transactions(&pre_tx, vout).await?;
    let pre_pre_tx_data =
        crate::contracts::ft::unlock::pre_pre_tx_data_from_parents(&pre_tx, vout, &grandparents)?;
    Ok((
        FtSpendContext {
            utxo,
            pre_tx,
            pre_pre_tx_data,
        },
        grandparents,
    ))
}

#[cfg(feature = "network-api")]
async fn resolve_ftlp_spend(
    api: &ApiClient,
    utxo: FtlpUtxo,
    pool: &PoolSpendContext,
) -> Result<(FtlpSpendContext, Vec<crate::Transaction>)> {
    let pre_tx = api
        .fetch_raw_transaction(&utxo.base.outpoint.txid.to_string())
        .await?;
    ensure_raw_txid(&pre_tx, utxo.base.outpoint.txid, "FTLP input")?;
    let vout = usize::try_from(utxo.base.outpoint.vout)
        .map_err(|_| pool_facade_error("FTLP vout does not fit usize"))?;
    let grandparents = api.fetch_ft_pre_pre_transactions(&pre_tx, vout).await?;
    let pre_pre_tx_data =
        crate::contracts::ft::unlock::pre_pre_tx_data_from_parents(&pre_tx, vout, &grandparents)?;
    Ok((
        FtlpSpendContext {
            utxo,
            pre_tx,
            pre_pre_tx_data,
            grandparents: grandparents.clone(),
            pool: Some(pool.clone()),
            fee_parent: None,
        },
        grandparents,
    ))
}

#[cfg(feature = "network-api")]
fn ensure_raw_txid(
    transaction: &crate::Transaction,
    expected: crate::Txid,
    label: &str,
) -> Result<()> {
    if transaction.txid() != expected {
        return Err(pool_facade_error(format!(
            "{label} response transaction id does not match its requested outpoint"
        )));
    }
    Ok(())
}

#[cfg(feature = "internal-signing")]
const RELEASED_POOL_PRECISION: u128 = 1_000_000;

#[cfg(feature = "internal-signing")]
fn released_pool_update(
    amounts: &PoolAmounts,
    current_pool_value: u64,
    increment: u64,
    option: PoolUpdate,
) -> Result<(PoolAmounts, u64)> {
    let full_without_dust = current_pool_value
        .checked_sub(POOL_CODE_DUST_SAT)
        .ok_or_else(|| pool_facade_error("Pool value is below code dust"))?;
    let scaled = |value: u64, multiplier: u128, divisor: u128, field: &str| -> Result<u64> {
        if divisor == 0 {
            return Err(pool_facade_error(format!("{field} ratio is zero")));
        }
        let value = u128::from(value);
        let next = value
            .checked_mul(multiplier)
            .ok_or_else(|| pool_facade_error(format!("{field} multiplication overflow")))?
            / divisor;
        u64::try_from(next).map_err(|_| pool_facade_error(format!("{field} exceeds uint64")))
    };

    match option {
        PoolUpdate::Lp => {
            if increment > amounts.ft_lp_raw {
                return Err(pool_facade_error("LP increment exceeds Pool FT-LP reserve"));
            }
            let ratio = u128::from(amounts.ft_lp_raw)
                .checked_mul(RELEASED_POOL_PRECISION)
                .ok_or_else(|| pool_facade_error("LP ratio overflow"))?
                / u128::from(increment);
            let ft_a_delta = scaled(amounts.ft_a_raw, RELEASED_POOL_PRECISION, ratio, "FT-A")?;
            let tbc_delta = scaled(amounts.tbc_sat, RELEASED_POOL_PRECISION, ratio, "TBC")?;
            let full_delta = scaled(
                full_without_dust,
                RELEASED_POOL_PRECISION,
                ratio,
                "Pool value",
            )?;
            Ok((
                PoolAmounts {
                    ft_lp_raw: amounts.ft_lp_raw - increment,
                    ft_a_raw: amounts
                        .ft_a_raw
                        .checked_sub(ft_a_delta)
                        .ok_or_else(|| pool_facade_error("FT-A reserve underflow"))?,
                    tbc_sat: amounts
                        .tbc_sat
                        .checked_sub(tbc_delta)
                        .ok_or_else(|| pool_facade_error("TBC reserve underflow"))?,
                },
                current_pool_value
                    .checked_sub(full_delta)
                    .ok_or_else(|| pool_facade_error("Pool value underflow"))?,
            ))
        }
        PoolUpdate::Tbc => {
            // The released over-reserve branch divides by the Pool value
            // excluding Code dust. A canonical zero-state Pool has exactly
            // dust here, so reject it before performing the division.
            if full_without_dust == 0 {
                return Err(pool_facade_error(
                    "TBC increment requires a Pool value above code dust",
                ));
            }
            let ratio = if increment <= amounts.tbc_sat {
                u128::from(full_without_dust)
                    .checked_mul(RELEASED_POOL_PRECISION)
                    .ok_or_else(|| pool_facade_error("TBC ratio overflow"))?
                    / u128::from(increment)
            } else {
                u128::from(increment)
                    .checked_mul(RELEASED_POOL_PRECISION)
                    .ok_or_else(|| pool_facade_error("TBC ratio overflow"))?
                    / u128::from(full_without_dust)
            };
            let (lp_delta, ft_a_delta) = if increment <= amounts.tbc_sat {
                (
                    scaled(amounts.ft_lp_raw, RELEASED_POOL_PRECISION, ratio, "FT-LP")?,
                    scaled(amounts.ft_a_raw, RELEASED_POOL_PRECISION, ratio, "FT-A")?,
                )
            } else {
                (
                    scaled(amounts.ft_lp_raw, ratio, RELEASED_POOL_PRECISION, "FT-LP")?,
                    scaled(amounts.ft_a_raw, ratio, RELEASED_POOL_PRECISION, "FT-A")?,
                )
            };
            Ok((
                PoolAmounts {
                    ft_lp_raw: amounts
                        .ft_lp_raw
                        .checked_add(lp_delta)
                        .ok_or_else(|| pool_facade_error("FT-LP reserve overflow"))?,
                    ft_a_raw: amounts
                        .ft_a_raw
                        .checked_add(ft_a_delta)
                        .ok_or_else(|| pool_facade_error("FT-A reserve overflow"))?,
                    tbc_sat: amounts
                        .tbc_sat
                        .checked_add(increment)
                        .ok_or_else(|| pool_facade_error("TBC reserve overflow"))?,
                },
                current_pool_value
                    .checked_add(increment)
                    .ok_or_else(|| pool_facade_error("Pool value overflow"))?,
            ))
        }
        PoolUpdate::FtA => {
            if amounts.ft_a_raw == 0 {
                return Err(pool_facade_error(
                    "FT-A increment requires a nonzero FT-A reserve",
                ));
            }
            let ratio = if increment <= amounts.ft_a_raw {
                u128::from(amounts.ft_a_raw)
                    .checked_mul(RELEASED_POOL_PRECISION)
                    .ok_or_else(|| pool_facade_error("FT-A ratio overflow"))?
                    / u128::from(increment)
            } else {
                u128::from(increment)
                    .checked_mul(RELEASED_POOL_PRECISION)
                    .ok_or_else(|| pool_facade_error("FT-A ratio overflow"))?
                    / u128::from(amounts.ft_a_raw)
            };
            let (lp_delta, tbc_delta, full_delta) = if increment <= amounts.ft_a_raw {
                (
                    scaled(amounts.ft_lp_raw, RELEASED_POOL_PRECISION, ratio, "FT-LP")?,
                    scaled(amounts.tbc_sat, RELEASED_POOL_PRECISION, ratio, "TBC")?,
                    scaled(
                        current_pool_value,
                        RELEASED_POOL_PRECISION,
                        ratio,
                        "Pool value",
                    )?,
                )
            } else {
                (
                    scaled(amounts.ft_lp_raw, ratio, RELEASED_POOL_PRECISION, "FT-LP")?,
                    scaled(amounts.tbc_sat, ratio, RELEASED_POOL_PRECISION, "TBC")?,
                    scaled(
                        current_pool_value,
                        ratio,
                        RELEASED_POOL_PRECISION,
                        "Pool value",
                    )?,
                )
            };
            Ok((
                PoolAmounts {
                    ft_lp_raw: amounts
                        .ft_lp_raw
                        .checked_add(lp_delta)
                        .ok_or_else(|| pool_facade_error("FT-LP reserve overflow"))?,
                    ft_a_raw: amounts
                        .ft_a_raw
                        .checked_add(increment)
                        .ok_or_else(|| pool_facade_error("FT-A reserve overflow"))?,
                    tbc_sat: amounts
                        .tbc_sat
                        .checked_add(tbc_delta)
                        .ok_or_else(|| pool_facade_error("TBC reserve overflow"))?,
                },
                current_pool_value
                    .checked_add(full_delta)
                    .ok_or_else(|| pool_facade_error("Pool value overflow"))?,
            ))
        }
    }
}

#[cfg(feature = "internal-signing")]
fn zero_pool_difference() -> PoolDifference {
    PoolDifference {
        ft_lp_delta: 0,
        ft_a_delta: 0,
        tbc_sat_delta: 0,
        pool_value_delta: 0,
    }
}

#[cfg(feature = "internal-signing")]
fn pool_difference(
    previous: &PoolAmounts,
    previous_value: u64,
    next: &PoolAmounts,
    next_value: u64,
) -> Result<PoolDifference> {
    let delta = |before: u64, after: u64, field: &str| -> Result<i128> {
        i128::from(after)
            .checked_sub(i128::from(before))
            .ok_or_else(|| pool_facade_error(format!("{field} difference overflow")))
    };
    Ok(PoolDifference {
        ft_lp_delta: delta(previous.ft_lp_raw, next.ft_lp_raw, "FT-LP")?,
        ft_a_delta: delta(previous.ft_a_raw, next.ft_a_raw, "FT-A")?,
        tbc_sat_delta: delta(previous.tbc_sat, next.tbc_sat, "TBC")?,
        pool_value_delta: delta(previous_value, next_value, "Pool value")?,
    })
}

#[cfg(feature = "internal-signing")]
fn pool_facade_error(message: impl Into<String>) -> Error {
    Error::InvalidUtxo(format!("Pool NFT v2 facade: {}", message.into()))
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    use super::*;
    use crate::{OutPoint, PrivateKey, StableCoin, Transaction, TxIn, TxOut, Txid, Utxo, UtxoInfo};

    fn state() -> PoolState {
        PoolState {
            amounts: PoolAmounts {
                ft_lp_raw: 1_000_000,
                ft_a_raw: 2_000_000,
                tbc_sat: 3_000_000,
            },
            ft_lp_partial_hash: vec![0x11; 32],
            ft_a_partial_hash: vec![0x22; 32],
            ft_a_contract_id: Txid::from_le_bytes([0x33; 32]),
            service_fee_rate: 35,
            service_provider: "deterministic-test".to_owned(),
            lp_plan: 2,
            public_key_locked: false,
            ftlp_lock_time_enabled: false,
        }
    }

    #[test]
    fn online_update_pool_state_matches_explicit_liquidity_math() {
        let mut pool = PoolNftV2::for_state(Txid::from_le_bytes([0x33; 32]));
        pool.state = state();
        pool.current_pool_value_sat = Some(3_001_000);

        let (next, difference) = pool.update_pool_state("1", 6, PoolUpdate::Tbc).unwrap();
        let expected = increase_lp(&pool.state.amounts, 3_001_000, 1_000_000).unwrap();

        assert_eq!(difference, expected);
        assert_eq!(next.amounts.ft_lp_raw, 1_333_333);
        assert_eq!(next.amounts.ft_a_raw, 2_666_666);
        assert_eq!(next.amounts.tbc_sat, 4_000_000);
    }

    #[test]
    fn online_update_pool_state_uses_retained_full_value_and_keeps_zero_as_a_noop() {
        let mut pool = PoolNftV2::for_state(Txid::from_le_bytes([0x33; 32]));
        pool.state = state();
        pool.current_pool_value_sat = Some(9_000_000);

        for option in [PoolUpdate::Lp, PoolUpdate::Tbc, PoolUpdate::FtA] {
            let (next, difference) = pool.update_pool_state("0", 6, option).unwrap();
            assert_eq!(next, pool.state);
            assert_eq!(
                difference,
                PoolDifference {
                    ft_lp_delta: 0,
                    ft_a_delta: 0,
                    tbc_sat_delta: 0,
                    pool_value_delta: 0,
                }
            );
        }

        let (next, difference) = pool.update_pool_state("1", 6, PoolUpdate::FtA).unwrap();
        assert_eq!(next.amounts.ft_a_raw, 3_000_000);
        assert_eq!(next.amounts.ft_lp_raw, 1_500_000);
        assert_eq!(next.amounts.tbc_sat, 4_500_000);
        assert_eq!(difference.pool_value_delta, 4_500_000);
    }

    #[test]
    fn online_update_pool_state_rejects_zero_state_tbc_over_reserve_without_panicking() {
        let pool = PoolNftV2::for_state(Txid::from_le_bytes([0x33; 32]));
        let mut pool = pool;
        pool.current_pool_value_sat = Some(POOL_CODE_DUST_SAT);

        let result =
            std::panic::catch_unwind(|| pool.update_pool_state("0.000001", 6, PoolUpdate::Tbc));
        assert!(
            result.is_ok(),
            "zero-state TBC update must return an error, not panic"
        );
        assert!(result.unwrap().is_err());
    }

    #[test]
    fn online_update_pool_state_matches_released_ft_over_reserve_and_full_lp_boundaries() {
        let mut pool = PoolNftV2::for_state(Txid::from_le_bytes([0x33; 32]));
        pool.state = state();
        // Deliberately not `tbc_sat + dust`: this mirrors a post-swap Pool
        // output and proves the FT-A branch scales its *full* output value.
        pool.current_pool_value_sat = Some(9_000_000);

        let (next, difference) = pool.update_pool_state("3", 6, PoolUpdate::FtA).unwrap();
        assert_eq!(next.amounts.ft_lp_raw, 2_500_000);
        assert_eq!(next.amounts.ft_a_raw, 5_000_000);
        assert_eq!(next.amounts.tbc_sat, 7_500_000);
        assert_eq!(difference.pool_value_delta, 13_500_000);

        let (next, difference) = pool.update_pool_state("1", 6, PoolUpdate::Lp).unwrap();
        assert_eq!(
            next.amounts,
            PoolAmounts {
                ft_lp_raw: 0,
                ft_a_raw: 0,
                tbc_sat: 0
            }
        );
        assert_eq!(difference.ft_lp_delta, -1_000_000);
        assert_eq!(difference.ft_a_delta, -2_000_000);
        assert_eq!(difference.tbc_sat_delta, -3_000_000);
        assert_eq!(difference.pool_value_delta, -8_999_000);
    }

    #[test]
    fn online_pool_tape_uses_requested_flags_without_mutating_state() {
        let mut pool = PoolNftV2::for_state(Txid::from_le_bytes([0x33; 32]));
        pool.state = state();

        let tape = pool.pool_tape(5, true, true).unwrap();
        let parsed = PoolState::from_v2_tape(&tape, "deterministic-test".to_owned()).unwrap();

        assert_eq!(parsed.lp_plan, 5);
        assert!(parsed.public_key_locked);
        assert!(parsed.ftlp_lock_time_enabled);
        assert_eq!(pool.state.lp_plan, 2);
        assert!(!pool.state.public_key_locked);
    }

    #[test]
    fn online_lock_time_parser_accepts_locked_ftlp_and_rejects_standard_ftlp() {
        let locked = ftlp_tape(&FtlpTapeParams {
            amount_raw: 100,
            layout: FtlpTapeLayout::LockTime {
                lock_time: 987_654,
                source_ft_tape_size: 81,
            },
        })
        .unwrap();
        let standard = ftlp_tape(&FtlpTapeParams {
            amount_raw: 100,
            layout: FtlpTapeLayout::Standard {
                decimal: 6,
                name: "Token",
                symbol: "TOK",
                is_coin: false,
            },
        })
        .unwrap();

        assert_eq!(ftlp_lock_time_from_tape(&locked).unwrap(), 987_654);
        assert!(ftlp_lock_time_from_tape(&standard).is_err());
    }

    #[tokio::test]
    async fn online_resolvers_reject_raw_transactions_that_do_not_match_requested_outpoints() {
        let owner = PrivateKey::from_slice(&[0x61; 32]).unwrap();
        let requested = Txid::from_le_bytes([0x62; 32]);
        let mut wrong = Transaction::new();
        wrong.inputs.push(TxIn::new(OutPoint {
            txid: Txid::from_le_bytes([0x63; 32]),
            vout: 0,
        }));
        let response = serde_json::json!({
            "code": 200,
            "data": {"txraw": wrong.to_hex()}
        })
        .to_string();
        let (base_url, requests) = mock_sequence(vec![response]);
        let result = resolve_ft_spend(
            &ApiClient::with_base_url(base_url),
            FtUtxo {
                base: Utxo {
                    outpoint: OutPoint {
                        txid: requested,
                        vout: 0,
                    },
                    satoshis: 500,
                    script_pubkey: owner.address().script_pubkey(),
                    private_key: owner,
                },
                ft_balance_raw: 1,
            },
        )
        .await;
        assert!(result.is_err());
        let request = requests.join().unwrap().pop().unwrap();
        assert_eq!(
            request.lines().next().unwrap(),
            format!("GET /api/tbc/txraw/txid/{requested} HTTP/1.1")
        );
    }

    #[tokio::test]
    async fn online_resolve_pool_context_matches_validated_api_state() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/pool-v2-js-165.json"))
                .unwrap();
        let pool_code = Script::from_bytes(
            hex::decode(
                fixture["scripts"]["lockedPoolOneKey"]["hex"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap(),
        );
        let mut state = state();
        state.public_key_locked = true;
        state.ftlp_lock_time_enabled = true;
        let ft_code =
            Script::from_bytes(hex::decode(fixture["ftCodeHex"].as_str().unwrap()).unwrap());
        let mut amount = [0u8; 48];
        amount[..8].copy_from_slice(&2_500_000u64.to_le_bytes());
        let ft_tape = crate::contracts::ft::scripts::mint_tape_script(
            &amount,
            6,
            fixture["ftName"].as_str().unwrap(),
            fixture["ftSymbol"].as_str().unwrap(),
        );
        let mut authority = Transaction::new();
        authority.inputs.push(TxIn::new(OutPoint {
            txid: Txid::from_le_bytes([0x44; 32]),
            vout: 0,
        }));
        authority.outputs = vec![
            TxOut {
                satoshis: crate::contracts::ft::scripts::FT_CODE_SATOSHIS,
                script_pubkey: ft_code.clone(),
            },
            TxOut {
                satoshis: 0,
                script_pubkey: ft_tape,
            },
        ];
        state.ft_a_contract_id = authority.txid();
        state.ft_a_partial_hash = crate::contracts::ft::partial_sha256::calculate_partial_hash(
            &ft_code.as_bytes()[..1_856],
        )
        .to_vec();
        let mut creation_state = state.clone();
        creation_state.amounts = PoolAmounts {
            ft_lp_raw: 0,
            ft_a_raw: 0,
            tbc_sat: 0,
        };
        let source = scripts::pool_code_source_outpoint(&pool_code).unwrap();
        let mut creation = Transaction::new();
        creation.inputs.push(TxIn::new(source));
        creation.outputs = vec![
            TxOut {
                satoshis: POOL_CODE_SATOSHIS,
                script_pubkey: pool_code.clone(),
            },
            TxOut {
                satoshis: 0,
                script_pubkey: pool_tape(&creation_state).unwrap(),
            },
        ];
        let contract_id = creation.txid();
        let mut current = Transaction::new();
        current.inputs.push(TxIn::new(OutPoint {
            txid: contract_id,
            vout: 0,
        }));
        current.outputs = vec![
            TxOut {
                satoshis: POOL_CODE_SATOSHIS + state.amounts.tbc_sat,
                script_pubkey: pool_code.clone(),
            },
            TxOut {
                satoshis: 0,
                script_pubkey: pool_tape(&state).unwrap(),
            },
        ];
        let current_id = current.txid();
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
                "pool_code_script": hex::encode(pool_code.as_bytes()),
                "version": 2,
                "txid": current_id.to_string(), "vout": 0,
                "value": POOL_CODE_SATOSHIS + state.amounts.tbc_sat,
            }
        })
        .to_string();
        let tx_response = |tx: &Transaction| {
            serde_json::json!({
                "code": 200, "data": {"txraw": tx.to_hex()}
            })
            .to_string()
        };
        let (base_url, requests) =
            mock_sequence(vec![info, tx_response(&creation), tx_response(&current)]);
        let pool =
            PoolNftV2::from_contract_id(&ApiClient::with_base_url(base_url.clone()), contract_id)
                .await
                .unwrap();
        // `from_contract_id` consumed the first three deterministic responses;
        // resolve the actual API context through a second resolver sequence.
        let _ = requests.join().unwrap();
        let (base_url, requests) = mock_sequence(vec![
            serde_json::json!({
                "code": 200,
                "data": {
                    "lp_balance": state.amounts.ft_lp_raw, "token_balance": state.amounts.ft_a_raw,
                    "tbc_balance": state.amounts.tbc_sat, "ft_lp_partial_hash": hex::encode(&state.ft_lp_partial_hash),
                    "ft_a_partial_hash": hex::encode(&state.ft_a_partial_hash), "ft_contract_id": state.ft_a_contract_id.to_string(),
                    "service_fee_rate": state.service_fee_rate, "service_provider": state.service_provider,
                    "pool_code_script": hex::encode(pool_code.as_bytes()), "version": 2,
                    "txid": current_id.to_string(), "vout": 0, "value": POOL_CODE_SATOSHIS + state.amounts.tbc_sat,
                }
            }).to_string(),
            tx_response(&creation), tx_response(&current), tx_response(&current), tx_response(&creation), tx_response(&authority),
        ]);
        let context = pool
            .resolve_pool_spend_context(&ApiClient::with_base_url(base_url))
            .await
            .unwrap();
        assert_eq!(context.state, state);
        assert_eq!(context.pool_utxo.outpoint.txid, current_id);
        assert_eq!(context.pool_pre_tx, current);
        assert_eq!(context.pool_pre_pre_tx, creation);
        assert_eq!(context.contract_tx, authority);
        assert_eq!(requests.join().unwrap().len(), 6);
    }

    #[test]
    fn online_coin_authority_uses_released_vouts_three_and_four() {
        let admin = PrivateKey::from_slice(&[47; 32]).unwrap();
        let mut funding_parent = Transaction::new();
        funding_parent.inputs.push(TxIn::new(OutPoint {
            txid: Txid::from_le_bytes([0x61; 32]),
            vout: 0,
        }));
        funding_parent.outputs.push(TxOut {
            satoshis: 20_000,
            script_pubkey: admin.address().script_pubkey(),
        });
        let funding = Utxo {
            outpoint: OutPoint {
                txid: funding_parent.txid(),
                vout: 0,
            },
            satoshis: 20_000,
            script_pubkey: admin.address().script_pubkey(),
            private_key: admin.clone(),
        };
        let mut coin =
            StableCoin::new("USD Coin".to_owned(), "USDC".to_owned(), 1_000_000, 6).unwrap();
        let finalized = coin
            .create_coin(
                admin.x_only_public_key(),
                admin.clone(),
                admin.address(),
                funding,
                funding_parent,
                None,
            )
            .unwrap()
            .finalize_with_admin_key(&admin)
            .unwrap();
        let code = Script::from_bytes(hex::decode(&coin.code_script).unwrap());
        let mut state = state();
        state.ft_a_contract_id = finalized.mint.txid();
        state.ft_a_partial_hash =
            crate::contracts::ft::partial_sha256::calculate_partial_hash(&code.as_bytes()[..1_984])
                .to_vec();
        let context = PoolSpendContext {
            pool_utxo: UtxoInfo {
                outpoint: OutPoint {
                    txid: Txid::from_le_bytes([0x62; 32]),
                    vout: 0,
                },
                satoshis: POOL_CODE_SATOSHIS + state.amounts.tbc_sat,
                script_pubkey: Script::empty(),
            },
            pool_pre_tx: Transaction::new(),
            pool_pre_pre_tx: Transaction::new(),
            contract_tx: finalized.mint,
            state,
        };
        let authority = builder::pool_ft_authority_from_context(&context).unwrap();
        assert_eq!(
            authority.contract_tx.outputs[3].script_pubkey, code,
            "Coin authority code must be read from vout 3"
        );
        assert_eq!(authority.contract_tx.outputs[4].satoshis, 0);
        assert_eq!(authority.info.decimal, 6);
    }

    fn mock_sequence(responses: Vec<String>) -> (String, thread::JoinHandle<Vec<String>>) {
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
}
