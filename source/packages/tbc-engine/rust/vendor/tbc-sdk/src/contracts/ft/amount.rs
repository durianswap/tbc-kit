use crate::{Error, Result, script::Script};

pub fn parse_decimal_to_raw(input: &str, decimal: u8) -> Result<u128> {
    if decimal > 18 {
        return Err(Error::InvalidUtxo(
            "FT decimal cannot exceed 18".to_string(),
        ));
    }
    let trimmed = input.trim();
    if trimmed.is_empty() || trimmed.starts_with('-') || trimmed.starts_with('+') {
        return Err(Error::InvalidUtxo("invalid FT amount".to_string()));
    }

    let mut parts = trimmed.split('.');
    let whole = parts.next().unwrap_or_default();
    let fraction = parts.next();
    if parts.next().is_some() {
        return Err(Error::InvalidUtxo("invalid FT amount".to_string()));
    }
    if whole.is_empty() && fraction.unwrap_or_default().is_empty() {
        return Err(Error::InvalidUtxo("invalid FT amount".to_string()));
    }
    if !whole.chars().all(|ch| ch.is_ascii_digit()) {
        return Err(Error::InvalidUtxo("invalid FT amount".to_string()));
    }

    let fraction = fraction.unwrap_or_default();
    if !fraction.chars().all(|ch| ch.is_ascii_digit()) || fraction.len() > decimal as usize {
        return Err(Error::InvalidUtxo(
            "invalid FT amount precision".to_string(),
        ));
    }

    let mut digits = String::new();
    digits.push_str(if whole.is_empty() { "0" } else { whole });
    digits.push_str(fraction);
    for _ in fraction.len()..decimal as usize {
        digits.push('0');
    }
    digits
        .parse::<u128>()
        .map_err(|_| Error::InvalidUtxo("FT amount overflow".to_string()))
}

pub fn build_tape_amount(
    amount_raw: u128,
    input_balances: &[u128],
) -> Result<([u8; 48], [u8; 48])> {
    build_tape_amount_with_offset(amount_raw, input_balances, 0)
}

pub(crate) fn build_tape_amount_with_offset(
    mut amount_raw: u128,
    input_balances: &[u128],
    input_offset: usize,
) -> Result<([u8; 48], [u8; 48])> {
    let mut amount_slots = [0u64; 6];
    let mut change_slots = [0u64; 6];

    if input_offset >= 6 || input_offset + input_balances.len() > 6 {
        return Err(Error::InvalidUtxo(
            "FT tape input slots exceed supported width".to_string(),
        ));
    }

    for (balance_index, balance) in input_balances.iter().enumerate() {
        if amount_raw == 0 {
            break;
        }
        let index = input_offset + balance_index;
        let balance = *balance;
        let spend = balance.min(amount_raw);
        amount_slots[index] = u64_slot(spend)?;
        change_slots[index] = u64_slot(balance - spend)?;
        amount_raw -= spend;
    }

    if amount_raw > 0 {
        return Err(Error::InsufficientFunds {
            input: input_balances
                .iter()
                .copied()
                .sum::<u128>()
                .min(u64::MAX as u128) as u64,
            required: u64_slot(amount_raw)?,
        });
    }

    for (balance_index, balance) in input_balances.iter().enumerate() {
        let index = input_offset + balance_index;
        if input_balances.get(balance_index).is_some()
            && amount_slots[index] == 0
            && change_slots[index] == 0
        {
            change_slots[index] = u64_slot(*balance)?;
        }
    }

    Ok((encode_slots(amount_slots), encode_slots(change_slots)))
}

pub fn build_multi_tape_amounts(
    output_amounts: &[u128],
    input_balances: &[u128],
) -> Result<Vec<[u8; 48]>> {
    let mut remaining = [0u128; 6];
    for (index, value) in input_balances.iter().take(6).enumerate() {
        remaining[index] = *value;
    }

    let mut tapes = Vec::with_capacity(output_amounts.len() + 1);
    for output_amount in output_amounts {
        let mut needed = *output_amount;
        let mut slots = [0u64; 6];
        for index in 0..6 {
            if needed == 0 {
                break;
            }
            let spend = remaining[index].min(needed);
            slots[index] = u64_slot(spend)?;
            remaining[index] -= spend;
            needed -= spend;
        }
        if needed > 0 {
            return Err(Error::InsufficientFunds {
                input: input_balances
                    .iter()
                    .copied()
                    .sum::<u128>()
                    .min(u64::MAX as u128) as u64,
                required: u64_slot(needed)?,
            });
        }
        tapes.push(encode_slots(slots));
    }

    let mut change = [0u64; 6];
    for index in 0..6 {
        change[index] = u64_slot(remaining[index])?;
    }
    tapes.push(encode_slots(change));
    Ok(tapes)
}

pub fn balance_from_tape(script: &Script) -> Result<u128> {
    let bytes = script.as_bytes();
    let amount_bytes = bytes
        .get(3..51)
        .ok_or_else(|| Error::InvalidScript("FT tape missing amount data".to_string()))?;
    let mut balance = 0u128;
    for chunk in amount_bytes.chunks_exact(8) {
        let mut raw = [0u8; 8];
        raw.copy_from_slice(chunk);
        balance = balance
            .checked_add(u64::from_le_bytes(raw) as u128)
            .ok_or_else(|| Error::InvalidUtxo("FT balance overflow".to_string()))?;
    }
    Ok(balance)
}

fn encode_slots(slots: [u64; 6]) -> [u8; 48] {
    let mut bytes = [0u8; 48];
    for (index, slot) in slots.iter().enumerate() {
        bytes[index * 8..index * 8 + 8].copy_from_slice(&slot.to_le_bytes());
    }
    bytes
}

fn u64_slot(value: u128) -> Result<u64> {
    u64::try_from(value).map_err(|_| Error::InvalidUtxo("FT tape slot overflow".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ft_parse_decimal_to_raw_avoids_floats() {
        assert_eq!(parse_decimal_to_raw("1.234", 6).unwrap(), 1_234_000);
        assert_eq!(parse_decimal_to_raw("0.000001", 6).unwrap(), 1);
        assert!(parse_decimal_to_raw("0.0000001", 6).is_err());
    }

    #[test]
    fn ft_build_tape_amount_distributes_amount_and_change() {
        let (amount, change) = build_tape_amount(750, &[500, 300]).unwrap();
        assert_eq!(
            &hex::encode(amount)[0..32],
            "f401000000000000fa00000000000000"
        );
        assert_eq!(
            &hex::encode(change)[0..32],
            "00000000000000003200000000000000"
        );
        assert_eq!(amount.len(), 48);
        assert_eq!(change.len(), 48);
    }

    #[test]
    fn ft_build_tape_amount_supports_input_offset() {
        let (amount, change) = build_tape_amount_with_offset(750, &[500, 300], 1).unwrap();
        assert_eq!(&hex::encode(amount)[0..16], "0000000000000000");
        assert_eq!(
            &hex::encode(amount)[16..48],
            "f401000000000000fa00000000000000"
        );
        assert_eq!(&hex::encode(change)[0..16], "0000000000000000");
        assert_eq!(
            &hex::encode(change)[16..48],
            "00000000000000003200000000000000"
        );
    }

    #[test]
    fn ft_build_multi_tape_amounts_leaves_final_change() {
        let tapes = build_multi_tape_amounts(&[200, 300], &[600]).unwrap();
        assert_eq!(tapes.len(), 3);
        assert_eq!(&hex::encode(tapes[2])[0..16], "6400000000000000");
    }
}
