use std::str::FromStr;

use crate::{
    Error, FtUtxo, FtlpUtxo, PublicKey, Result, Transaction, Txid, UtxoInfo, script::Script,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolAmounts {
    pub ft_lp_raw: u64,
    pub ft_a_raw: u64,
    pub tbc_sat: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolDifference {
    pub ft_lp_delta: i128,
    pub ft_a_delta: i128,
    pub tbc_sat_delta: i128,
    pub pool_value_delta: i128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PoolUpdate {
    Lp,
    Tbc,
    FtA,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolState {
    pub amounts: PoolAmounts,
    pub ft_lp_partial_hash: Vec<u8>,
    pub ft_a_partial_hash: Vec<u8>,
    pub ft_a_contract_id: Txid,
    pub service_fee_rate: u16,
    pub service_provider: String,
    pub lp_plan: u8,
    pub public_key_locked: bool,
    pub ftlp_lock_time_enabled: bool,
}

impl PoolState {
    pub fn from_v2_tape(tape: &Script, service_provider: String) -> Result<Self> {
        let chunks = tape_chunks(tape.as_bytes())?;
        if chunks.len() != 8 || chunks[7].as_slice() != b"NTape" {
            return Err(invalid_tape("expected eight Pool v2 NTape fields"));
        }
        if chunks[0].len() != 64 || chunks[1].len() != 24 || chunks[2].len() != 32 {
            return Err(invalid_tape(
                "invalid hashes, amounts, or contract id length",
            ));
        }

        let ft_lp_raw = u64::from_le_bytes(chunks[1][0..8].try_into().unwrap());
        let ft_a_raw = u64::from_le_bytes(chunks[1][8..16].try_into().unwrap());
        let tbc_sat = u64::from_le_bytes(chunks[1][16..24].try_into().unwrap());
        let service_fee_rate = fee_rate(&chunks[3])?;
        let lp_plan = one_byte(&chunks[4], "LP plan")?;
        if !(1..=6).contains(&lp_plan) {
            return Err(invalid_tape("LP plan must be in 1..=6"));
        }
        let public_key_locked = boolean_byte(&chunks[5], "public-key lock flag")?;
        let ftlp_lock_time_enabled = boolean_byte(&chunks[6], "lock-time flag")?;
        let contract_id = hex::encode(&chunks[2]);

        let state = Self {
            amounts: PoolAmounts {
                ft_lp_raw,
                ft_a_raw,
                tbc_sat,
            },
            ft_lp_partial_hash: chunks[0][..32].to_vec(),
            ft_a_partial_hash: chunks[0][32..].to_vec(),
            ft_a_contract_id: Txid::from_str(&contract_id)?,
            service_fee_rate,
            service_provider,
            lp_plan,
            public_key_locked,
            ftlp_lock_time_enabled,
        };
        let canonical = super::scripts::pool_tape(&state)?;
        if canonical != *tape {
            return Err(invalid_tape(
                "must use the released canonical minimal-push layout",
            ));
        }
        Ok(state)
    }
}

fn tape_chunks(bytes: &[u8]) -> Result<Vec<Vec<u8>>> {
    if !bytes.starts_with(&[0x00, 0x6a]) {
        return Err(invalid_tape("must start with OP_FALSE OP_RETURN"));
    }
    let mut offset = 2usize;
    let mut chunks = Vec::new();
    while offset < bytes.len() {
        let opcode = bytes[offset];
        offset += 1;
        let length = match opcode {
            0x01..=0x4b => usize::from(opcode),
            0x4c => usize::from(read_length::<1>(bytes, &mut offset)?[0]),
            0x4d => usize::from(u16::from_le_bytes(read_length(bytes, &mut offset)?)),
            0x4e => {
                let length = u32::from_le_bytes(read_length(bytes, &mut offset)?);
                usize::try_from(length).map_err(|_| invalid_tape("push length overflow"))?
            }
            _ => return Err(invalid_tape("contains a non-push opcode")),
        };
        let end = offset
            .checked_add(length)
            .ok_or_else(|| invalid_tape("push length overflow"))?;
        let chunk = bytes
            .get(offset..end)
            .ok_or_else(|| invalid_tape("truncated pushed field"))?;
        chunks.push(chunk.to_vec());
        offset = end;
    }
    Ok(chunks)
}

fn read_length<const N: usize>(bytes: &[u8], offset: &mut usize) -> Result<[u8; N]> {
    let end = offset
        .checked_add(N)
        .ok_or_else(|| invalid_tape("push length overflow"))?;
    let raw = bytes
        .get(*offset..end)
        .ok_or_else(|| invalid_tape("truncated push length"))?;
    *offset = end;
    Ok(raw.try_into().unwrap())
}

fn one_byte(chunk: &[u8], field: &str) -> Result<u8> {
    if chunk.len() != 1 {
        return Err(invalid_tape(format!("{field} must contain one byte")));
    }
    Ok(chunk[0])
}

fn fee_rate(chunk: &[u8]) -> Result<u16> {
    match chunk {
        [value] => Ok(u16::from(*value)),
        [high, low] if *high != 0 => Ok(u16::from_be_bytes([*high, *low])),
        _ => Err(invalid_tape(
            "service fee rate must contain one or two canonical big-endian bytes",
        )),
    }
}

fn boolean_byte(chunk: &[u8], field: &str) -> Result<bool> {
    match one_byte(chunk, field)? {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(invalid_tape(format!("{field} must be zero or one"))),
    }
}

fn invalid_tape(message: impl Into<String>) -> Error {
    Error::InvalidScript(format!("Pool NFT v2 NTape: {}", message.into()))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum PoolUnlockOption {
    IncreaseLiquidity = 1,
    ConsumeLiquidity = 2,
    Swap = 3,
    MergePoolFt = 4,
}

impl PoolUnlockOption {
    pub const fn tag(self) -> u8 {
        0x50 + self as u8
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum PoolSwapOption {
    TbcToFt = 1,
    FtToTbc = 2,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolSpendContext {
    pub pool_utxo: UtxoInfo,
    pub pool_pre_tx: Transaction,
    pub pool_pre_pre_tx: Transaction,
    pub contract_tx: Transaction,
    pub state: PoolState,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolUnlockSignature {
    pub signature_with_hashtype: Vec<u8>,
    pub public_key: PublicKey,
}

#[derive(Clone, Debug)]
pub struct PoolUnlockContext<'a> {
    pub transaction: &'a Transaction,
    pub input_index: usize,
    pub spent_vout: u32,
    pub pool: &'a PoolSpendContext,
    /// Parents for current inputs 1.. in exact input order.
    pub input_parents: &'a [Transaction],
    pub option: PoolUnlockOption,
    pub swap_option: Option<PoolSwapOption>,
    /// Released per-operation output-layout flag. This is independent from
    /// the Pool's persistent public-key lock state (notably during init).
    pub with_lock: bool,
    pub signature: Option<&'a PoolUnlockSignature>,
    pub public_key_lock: &'a [PublicKey],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FtlpSpendContext {
    pub utxo: FtlpUtxo,
    pub pre_tx: Transaction,
    pub pre_pre_tx_data: Vec<u8>,
    /// Explicit parents used to derive `pre_pre_tx_data` for offline FTLP
    /// signature validation.  Standalone FTLP lifecycle calls require this.
    pub grandparents: Vec<Transaction>,
    /// The Pool which issued this FTLP.  Standalone lifecycle calls use this
    /// to validate the released Pool binding instead of consulting an API.
    pub pool: Option<PoolSpendContext>,
    /// Exact parent transaction for the shared P2PKH fee input.  Keeping it
    /// on the spend context preserves the compact public lifecycle methods.
    pub fee_parent: Option<Transaction>,
}

#[derive(Clone, Debug)]
pub struct FtSpendContext {
    pub utxo: FtUtxo,
    pub pre_tx: Transaction,
    pub pre_pre_tx_data: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct PoolOperationContext {
    pub pool: PoolSpendContext,
    /// User-owned FT-A inputs, in their exact transaction-input order.
    pub ft_inputs: Vec<FtSpendContext>,
    /// User-owned FT-LP inputs, in their exact transaction-input order.
    pub ftlp_inputs: Vec<FtlpSpendContext>,
    /// One explicit grandparent set per FT-A input.
    pub ft_grandparents: Vec<Vec<Transaction>>,
    /// One explicit grandparent set per FT-LP input.
    pub ftlp_grandparents: Vec<Vec<Transaction>>,
    /// Exact parent for the P2PKH fee input.  A locked consume may instead
    /// use the locally-built unlock transaction's output 2 as its fee input.
    pub fee_parent: Transaction,
    /// Canonical locked-Pool key set, or an empty set for standard Pools.
    pub public_key_lock: Vec<PublicKey>,
    /// Fixed P2PKH output required by the released locked increase path.
    pub locked_lp_cost: Option<LockedLpCost>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LockedLpCost {
    pub address: crate::Address,
    pub satoshis: u64,
}

#[derive(Clone, Debug)]
pub struct LocalPoolOperationContext {
    pub operation: PoolOperationContext,
    pub local_parents: Vec<Transaction>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Txid, contracts::pool_nft_v2::pool_tape};

    #[test]
    fn pool_state_exposes_the_planned_raw_fields() {
        let state = PoolState {
            amounts: PoolAmounts {
                ft_lp_raw: 30_000_000,
                ft_a_raw: 100_000_000,
                tbc_sat: 30_000_000,
            },
            ft_lp_partial_hash: vec![0x11; 32],
            ft_a_partial_hash: vec![0x22; 32],
            ft_a_contract_id: Txid::default(),
            service_fee_rate: 35,
            service_provider: "released-js-1.6.5".to_string(),
            lp_plan: 2,
            public_key_locked: true,
            ftlp_lock_time_enabled: true,
        };

        assert_eq!(state.amounts.ft_lp_raw, 30_000_000);
        assert_eq!(state.amounts.ft_a_raw, 100_000_000);
        assert_eq!(state.amounts.tbc_sat, 30_000_000);
        assert_eq!(state.service_provider, "released-js-1.6.5");
        assert_eq!(state.clone(), state);
    }

    #[test]
    fn pool_difference_and_update_variants_are_signed_and_typed() {
        let difference = PoolDifference {
            ft_lp_delta: 0,
            ft_a_delta: -331_067,
            tbc_sat_delta: 99_650,
            pool_value_delta: 99_700,
        };

        assert_eq!(difference.ft_a_delta, -331_067);
        assert_eq!(PoolUpdate::Lp, PoolUpdate::Lp);
        assert_eq!(PoolUpdate::Tbc, PoolUpdate::Tbc);
        assert_eq!(PoolUpdate::FtA, PoolUpdate::FtA);
    }

    #[test]
    fn pool_state_rejects_nonminimal_pushdata1_pushdata2_and_pushdata4_tapes() {
        let state = PoolState {
            amounts: PoolAmounts {
                ft_lp_raw: 1_000,
                ft_a_raw: 2_000,
                tbc_sat: 3_000,
            },
            ft_lp_partial_hash: vec![0x11; 32],
            ft_a_partial_hash: vec![0x22; 32],
            ft_a_contract_id: "33".repeat(32).parse().unwrap(),
            service_fee_rate: 35,
            service_provider: "fixture-provider".to_string(),
            lp_plan: 2,
            public_key_locked: true,
            ftlp_lock_time_enabled: true,
        };
        let canonical = pool_tape(&state).unwrap();
        assert_eq!(canonical.as_bytes().len(), 139);

        let accepted = [vec![0x4c, 64], vec![0x4d, 64, 0], vec![0x4e, 64, 0, 0, 0]]
            .into_iter()
            .filter(|prefix| {
                let mut nonminimal = canonical.as_bytes().to_vec();
                nonminimal.splice(2..3, prefix.iter().copied());
                PoolState::from_v2_tape(
                    &Script::from_bytes(nonminimal),
                    state.service_provider.clone(),
                )
                .is_ok()
            })
            .count();

        assert_eq!(accepted, 0, "non-minimal Pool NTape pushes were accepted");
    }

    #[test]
    fn pool_state_round_trips_two_byte_javascript_166_fee_rates() {
        for (plan, rate) in [(3, 135), (4, 335), (5, 535), (6, 130)] {
            let state = PoolState {
                amounts: PoolAmounts {
                    ft_lp_raw: 1,
                    ft_a_raw: 2,
                    tbc_sat: 3,
                },
                ft_lp_partial_hash: vec![0x11; 32],
                ft_a_partial_hash: vec![0x22; 32],
                ft_a_contract_id: "33".repeat(32).parse().unwrap(),
                service_fee_rate: rate,
                service_provider: String::new(),
                lp_plan: plan,
                public_key_locked: false,
                ftlp_lock_time_enabled: false,
            };
            let tape = pool_tape(&state).unwrap();
            let parsed = PoolState::from_v2_tape(&tape, String::new()).unwrap();
            assert_eq!((parsed.lp_plan, parsed.service_fee_rate), (plan, rate));
            assert_eq!(tape.as_bytes().len(), if rate > 255 { 140 } else { 139 });
        }
    }
}
