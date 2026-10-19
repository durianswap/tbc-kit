use crate::{Error, Result, contracts::pool_nft_v2::data::PoolDifference};

use super::PoolAmounts;

pub const POOL_CODE_DUST_SAT: u64 = 1_000;
const POOL_MATH_PRECISION: u128 = 1_000_000;
const FEE_RATE_DENOMINATOR: u128 = 10_000;
const SERVICE_FEE_OUTPUT_DUST_SAT: u128 = 10;

pub fn parse_decimal_raw(input: &str, decimal: u8) -> Result<u64> {
    validate_decimal(decimal)?;
    let input = input.trim();
    if input.is_empty() || input.starts_with(['+', '-']) {
        return Err(math_error("invalid decimal amount"));
    }

    let mut parts = input.split('.');
    let whole = parts.next().unwrap_or_default();
    let fraction = parts.next();
    if parts.next().is_some() {
        return Err(math_error("invalid decimal amount"));
    }
    let fraction = fraction.unwrap_or_default();
    if whole.is_empty() && fraction.is_empty() {
        return Err(math_error("invalid decimal amount"));
    }
    if !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(math_error("invalid decimal amount"));
    }
    if fraction.len() > usize::from(decimal) {
        return Err(math_error("decimal amount has excess fractional places"));
    }

    let scale = decimal_scale(decimal)?;
    let whole = if whole.is_empty() {
        0
    } else {
        whole
            .parse::<u128>()
            .map_err(|_| math_error("decimal amount overflow"))?
    };
    let mut fractional = if fraction.is_empty() {
        0
    } else {
        fraction
            .parse::<u128>()
            .map_err(|_| math_error("decimal amount overflow"))?
    };
    for _ in fraction.len()..usize::from(decimal) {
        fractional = fractional
            .checked_mul(10)
            .ok_or_else(|| math_error("decimal amount overflow"))?;
    }
    let raw = whole
        .checked_mul(scale)
        .and_then(|value| value.checked_add(fractional))
        .ok_or_else(|| math_error("decimal amount overflow"))?;
    u64::try_from(raw).map_err(|_| math_error("decimal amount overflow"))
}

pub fn format_decimal_raw(raw: u64, decimal: u8) -> Result<String> {
    validate_decimal(decimal)?;
    if decimal == 0 {
        return Ok(raw.to_string());
    }

    let scale =
        u64::try_from(decimal_scale(decimal)?).map_err(|_| math_error("decimal scale overflow"))?;
    let whole = raw / scale;
    let fraction = raw % scale;
    if fraction == 0 {
        return Ok(whole.to_string());
    }

    let mut fraction = format!("{fraction:0width$}", width = usize::from(decimal));
    while fraction.ends_with('0') {
        fraction.pop();
    }
    Ok(format!("{whole}.{fraction}"))
}

pub fn initial_lp_raw(tbc_sat: u64) -> Result<u64> {
    if tbc_sat == 0 {
        return Err(math_error("initial TBC amount must be positive"));
    }
    Ok(tbc_sat)
}

pub fn increase_lp(
    state: &PoolAmounts,
    current_pool_value_sat: u64,
    tbc_increment_sat: u64,
) -> Result<PoolDifference> {
    validate_reserves(state)?;
    if tbc_increment_sat == 0 {
        return Err(math_error("TBC increment must be positive"));
    }
    let pool_reserve = pool_reserve(current_pool_value_sat)?;
    let increment = u128::from(tbc_increment_sat);

    let (lp_add, ft_add) = if tbc_increment_sat <= state.tbc_sat {
        let ratio = checked_mul_div(pool_reserve, POOL_MATH_PRECISION, increment)?;
        if ratio == 0 {
            return Err(math_error("liquidity ratio truncated to zero"));
        }
        (
            checked_mul_div(u128::from(state.ft_lp_raw), POOL_MATH_PRECISION, ratio)?,
            checked_mul_div(u128::from(state.ft_a_raw), POOL_MATH_PRECISION, ratio)?,
        )
    } else {
        let ratio = checked_mul_div(increment, POOL_MATH_PRECISION, pool_reserve)?;
        if ratio == 0 {
            return Err(math_error("liquidity ratio truncated to zero"));
        }
        (
            checked_mul_div(u128::from(state.ft_lp_raw), ratio, POOL_MATH_PRECISION)?,
            checked_mul_div(u128::from(state.ft_a_raw), ratio, POOL_MATH_PRECISION)?,
        )
    };

    if lp_add == 0 || ft_add == 0 {
        return Err(math_error("liquidity increment produces a zero output"));
    }
    checked_resulting_add(state.ft_lp_raw, lp_add)?;
    checked_resulting_add(state.ft_a_raw, ft_add)?;
    state
        .tbc_sat
        .checked_add(tbc_increment_sat)
        .ok_or_else(|| math_error("TBC reserve overflow"))?;
    current_pool_value_sat
        .checked_add(tbc_increment_sat)
        .ok_or_else(|| math_error("Pool value overflow"))?;

    Ok(PoolDifference {
        ft_lp_delta: positive_delta(lp_add)?,
        ft_a_delta: positive_delta(ft_add)?,
        tbc_sat_delta: i128::from(tbc_increment_sat),
        pool_value_delta: i128::from(tbc_increment_sat),
    })
}

pub fn consume_lp(
    state: &PoolAmounts,
    current_pool_value_sat: u64,
    lp_amount_raw: u64,
) -> Result<PoolDifference> {
    validate_reserves(state)?;
    if lp_amount_raw == 0 || lp_amount_raw > state.ft_lp_raw {
        return Err(math_error(
            "LP amount must be positive and not exceed total LP",
        ));
    }
    let pool_reserve = pool_reserve(current_pool_value_sat)?;
    let ratio = checked_mul_div(
        u128::from(state.ft_lp_raw),
        POOL_MATH_PRECISION,
        u128::from(lp_amount_raw),
    )?;
    if ratio == 0 {
        return Err(math_error("liquidity ratio truncated to zero"));
    }

    let ft_sub = checked_mul_div(u128::from(state.ft_a_raw), POOL_MATH_PRECISION, ratio)?;
    let tbc_sub = checked_mul_div(u128::from(state.tbc_sat), POOL_MATH_PRECISION, ratio)?;
    let pool_sub = checked_mul_div(pool_reserve, POOL_MATH_PRECISION, ratio)?;
    if ft_sub == 0 || tbc_sub == 0 || pool_sub == 0 {
        return Err(math_error("LP consumption produces a zero output"));
    }
    if lp_amount_raw < state.ft_lp_raw {
        ensure_remaining(state.ft_a_raw, ft_sub, "FT-A")?;
        ensure_remaining(state.tbc_sat, tbc_sub, "TBC")?;
        ensure_remaining_u128(pool_reserve, pool_sub, "Pool value")?;
    }

    Ok(PoolDifference {
        ft_lp_delta: -i128::from(lp_amount_raw),
        ft_a_delta: negative_delta(ft_sub)?,
        tbc_sat_delta: negative_delta(tbc_sub)?,
        pool_value_delta: negative_delta(pool_sub)?,
    })
}

pub fn swap_tbc_to_ft(
    state: &PoolAmounts,
    tbc_input_sat: u64,
    service_fee_rate: u16,
    lp_plan: u8,
) -> Result<PoolDifference> {
    validate_swap_reserves(state)?;
    if tbc_input_sat == 0 {
        return Err(math_error("TBC swap input must be positive"));
    }
    let fees = swap_fees(u128::from(tbc_input_sat), service_fee_rate, lp_plan)?;
    let swap_input = u128::from(tbc_input_sat)
        .checked_sub(fees.service)
        .ok_or_else(|| math_error("service fee exceeds swap input"))?;
    if swap_input == 0 {
        return Err(math_error("service fee consumes the swap input"));
    }
    let swap_input_u64 = checked_u64(swap_input, "TBC reserve increment")?;
    let new_tbc = state
        .tbc_sat
        .checked_add(swap_input_u64)
        .ok_or_else(|| math_error("TBC reserve overflow"))?;
    let product = checked_mul(u128::from(state.ft_a_raw), u128::from(state.tbc_sat))?;
    let new_ft = product
        .checked_div(u128::from(new_tbc))
        .ok_or_else(|| math_error("invalid zero TBC reserve"))?;
    let new_ft = checked_u64(new_ft, "FT-A reserve")?;
    if new_ft == 0 || new_ft >= state.ft_a_raw {
        return Err(math_error(
            "swap produces zero FT output or exhausts reserve",
        ));
    }
    let ft_output = state.ft_a_raw - new_ft;
    let pool_increment = if fees.service_provider >= SERVICE_FEE_OUTPUT_DUST_SAT {
        u128::from(tbc_input_sat)
            .checked_sub(fees.service_provider)
            .ok_or_else(|| math_error("service provider fee exceeds input"))?
    } else {
        u128::from(tbc_input_sat)
    };

    Ok(PoolDifference {
        ft_lp_delta: 0,
        ft_a_delta: -i128::from(ft_output),
        tbc_sat_delta: i128::from(swap_input_u64),
        pool_value_delta: positive_delta(pool_increment)?,
    })
}

pub fn swap_ft_to_tbc(
    state: &PoolAmounts,
    ft_input_raw: u64,
    service_fee_rate: u16,
    lp_plan: u8,
) -> Result<PoolDifference> {
    validate_swap_reserves(state)?;
    if ft_input_raw == 0 {
        return Err(math_error("FT swap input must be positive"));
    }
    let new_ft = state
        .ft_a_raw
        .checked_add(ft_input_raw)
        .ok_or_else(|| math_error("FT-A reserve overflow"))?;
    let product = checked_mul(u128::from(state.ft_a_raw), u128::from(state.tbc_sat))?;
    let new_tbc = product
        .checked_div(u128::from(new_ft))
        .ok_or_else(|| math_error("invalid zero FT-A reserve"))?;
    let new_tbc = checked_u64(new_tbc, "TBC reserve")?;
    if new_tbc == 0 || new_tbc >= state.tbc_sat {
        return Err(math_error(
            "swap produces zero TBC output or exhausts reserve",
        ));
    }
    let gross_output = state.tbc_sat - new_tbc;
    let fees = swap_fees(u128::from(gross_output), service_fee_rate, lp_plan)?;
    let user_output = u128::from(gross_output)
        .checked_sub(fees.service)
        .ok_or_else(|| math_error("service fee exceeds TBC output"))?;
    if user_output == 0 {
        return Err(math_error("swap produces a zero user output"));
    }
    let pool_decrement = if fees.service_provider >= SERVICE_FEE_OUTPUT_DUST_SAT {
        u128::from(gross_output)
            .checked_sub(fees.lp)
            .ok_or_else(|| math_error("LP fee exceeds TBC output"))?
    } else {
        user_output
    };

    Ok(PoolDifference {
        ft_lp_delta: 0,
        ft_a_delta: i128::from(ft_input_raw),
        tbc_sat_delta: -i128::from(gross_output),
        pool_value_delta: negative_delta(pool_decrement)?,
    })
}

#[derive(Clone, Copy)]
struct SwapFees {
    service: u128,
    lp: u128,
    service_provider: u128,
}

pub fn lp_fee_rate(service_fee_rate: u16, lp_plan: u8) -> Result<u16> {
    if !(1..=6).contains(&lp_plan) {
        return Err(math_error("LP plan must be in 1..=6"));
    }
    let minimum_rate = if lp_plan == 1 { 10 } else { 5 };
    if service_fee_rate < minimum_rate {
        return Err(math_error("service fee rate is below the LP fee rate"));
    }
    Ok(match lp_plan {
        1 => service_fee_rate - 10,
        // User confirmed no deployed 130/80 Pool2 LP6 assets. Match current
        // 1.7.3 only; a different authenticated Tape rate is not reinterpreted.
        6 => match service_fee_rate {
            330 => 200,
            _ => return Err(math_error("unsupported Pool2 LP6 total fee rate")),
        },
        _ => 5,
    })
}

fn swap_fees(amount: u128, service_fee_rate: u16, lp_plan: u8) -> Result<SwapFees> {
    let lp_rate = lp_fee_rate(service_fee_rate, lp_plan)?;
    let service = checked_mul_div(amount, u128::from(service_fee_rate), FEE_RATE_DENOMINATOR)?;
    let lp = checked_mul_div(amount, u128::from(lp_rate), FEE_RATE_DENOMINATOR)?;
    let service_provider = service
        .checked_sub(lp)
        .ok_or_else(|| math_error("LP fee exceeds total service fee"))?;
    Ok(SwapFees {
        service,
        lp,
        service_provider,
    })
}

fn validate_decimal(decimal: u8) -> Result<()> {
    if decimal > 18 {
        return Err(math_error("decimal cannot exceed 18"));
    }
    Ok(())
}

fn decimal_scale(decimal: u8) -> Result<u128> {
    10u128
        .checked_pow(u32::from(decimal))
        .ok_or_else(|| math_error("decimal scale overflow"))
}

fn validate_reserves(state: &PoolAmounts) -> Result<()> {
    if state.ft_lp_raw == 0 || state.ft_a_raw == 0 || state.tbc_sat == 0 {
        return Err(math_error("Pool reserves must all be nonzero"));
    }
    Ok(())
}

fn validate_swap_reserves(state: &PoolAmounts) -> Result<()> {
    if state.ft_a_raw == 0 || state.tbc_sat == 0 {
        return Err(math_error("swap reserves must be nonzero"));
    }
    Ok(())
}

fn pool_reserve(current_pool_value_sat: u64) -> Result<u128> {
    let reserve = current_pool_value_sat
        .checked_sub(POOL_CODE_DUST_SAT)
        .ok_or_else(|| math_error("Pool value is below the code dust"))?;
    if reserve == 0 {
        return Err(math_error("Pool value reserve must be nonzero"));
    }
    Ok(u128::from(reserve))
}

fn checked_mul(left: u128, right: u128) -> Result<u128> {
    left.checked_mul(right)
        .ok_or_else(|| math_error("Pool multiplication overflow"))
}

fn checked_mul_div(left: u128, right: u128, denominator: u128) -> Result<u128> {
    if denominator == 0 {
        return Err(math_error("Pool division by zero"));
    }
    checked_mul(left, right)?
        .checked_div(denominator)
        .ok_or_else(|| math_error("Pool division by zero"))
}

fn checked_resulting_add(current: u64, delta: u128) -> Result<()> {
    let delta = checked_u64(delta, "Pool delta")?;
    current
        .checked_add(delta)
        .ok_or_else(|| math_error("Pool reserve overflow"))?;
    Ok(())
}

fn ensure_remaining(current: u64, decrement: u128, reserve: &str) -> Result<()> {
    ensure_remaining_u128(u128::from(current), decrement, reserve)
}

fn ensure_remaining_u128(current: u128, decrement: u128, reserve: &str) -> Result<()> {
    let remaining = current
        .checked_sub(decrement)
        .ok_or_else(|| math_error(format!("{reserve} reserve underflow")))?;
    if remaining == 0 {
        return Err(math_error(format!("{reserve} reserve exhaustion")));
    }
    Ok(())
}

fn checked_u64(value: u128, name: &str) -> Result<u64> {
    u64::try_from(value).map_err(|_| math_error(format!("{name} exceeds uint64")))
}

fn positive_delta(value: u128) -> Result<i128> {
    i128::try_from(value).map_err(|_| math_error("positive delta exceeds int128"))
}

fn negative_delta(value: u128) -> Result<i128> {
    positive_delta(value)?
        .checked_neg()
        .ok_or_else(|| math_error("negative delta exceeds int128"))
}

fn math_error(message: impl Into<String>) -> Error {
    Error::InvalidUtxo(format!("Pool math: {}", message.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::pool_nft_v2::data::PoolAmounts;

    fn released_state() -> PoolAmounts {
        PoolAmounts {
            ft_lp_raw: 30_000_000,
            ft_a_raw: 100_000_000,
            tbc_sat: 30_000_000,
        }
    }

    #[test]
    fn decimal_parser_and_formatter_never_use_float_rounding() {
        assert_eq!(parse_decimal_raw("0.000001", 6).unwrap(), 1);
        assert_eq!(parse_decimal_raw("1.234", 6).unwrap(), 1_234_000);
        assert_eq!(parse_decimal_raw(".5", 6).unwrap(), 500_000);
        assert_eq!(parse_decimal_raw("1.", 6).unwrap(), 1_000_000);
        assert_eq!(format_decimal_raw(1, 6).unwrap(), "0.000001");
        assert_eq!(format_decimal_raw(1_234_000, 6).unwrap(), "1.234");
        assert_eq!(format_decimal_raw(0, 18).unwrap(), "0");
    }

    #[test]
    fn decimal_parser_rejects_symbols_scientific_notation_excess_places_and_overflow() {
        for invalid in [
            "",
            ".",
            "+1",
            "-1",
            "NaN",
            "nan",
            "Infinity",
            "1e6",
            "1E6",
            "1.2.3",
            "0.0000001",
            "12_000",
        ] {
            assert!(
                parse_decimal_raw(invalid, 6).is_err(),
                "accepted invalid decimal {invalid:?}"
            );
        }
        assert_eq!(
            parse_decimal_raw("18446744073709551615", 0).unwrap(),
            u64::MAX
        );
        assert!(parse_decimal_raw("18446744073709551616", 0).is_err());
        assert!(parse_decimal_raw("1", 19).is_err());
        assert!(format_decimal_raw(1, 19).is_err());
    }

    #[test]
    fn decimal_u64_boundary_round_trips_at_eighteen_places() {
        let rendered = format_decimal_raw(u64::MAX, 18).unwrap();
        assert_eq!(rendered, "18.446744073709551615");
        assert_eq!(parse_decimal_raw(&rendered, 18).unwrap(), u64::MAX);
    }

    #[test]
    fn initial_lp_matches_released_js_tbc_satoshi_amount() {
        // tbc-contract 1.6.5 poolNFT2.0.js:353-359 and Go poolnft2.go:1888-1902.
        assert_eq!(initial_lp_raw(30_000_000).unwrap(), 30_000_000);
        assert!(initial_lp_raw(0).is_err());
    }

    #[test]
    fn increase_lp_matches_released_js_and_go_ratio_vector_without_mutating_input() {
        // tbc-contract 1.6.5 poolNFT2.0.js:3114-3150; Go poolnft2.go:333-371.
        let state = released_state();
        let original = state.clone();
        let delta = increase_lp(&state, 30_001_000, 100_000).unwrap();

        assert_eq!(
            delta,
            crate::contracts::pool_nft_v2::data::PoolDifference {
                ft_lp_delta: 100_000,
                ft_a_delta: 333_333,
                tbc_sat_delta: 100_000,
                pool_value_delta: 100_000,
            }
        );
        assert_eq!(state, original);
    }

    #[test]
    fn consume_lp_matches_released_js_and_go_ratio_vector_without_mutating_input() {
        // tbc-contract 1.6.5 poolNFT2.0.js:3054-3077; Go poolnft2.go:261-287.
        let state = released_state();
        let original = state.clone();
        let delta = consume_lp(&state, 30_001_000, 100_000).unwrap();

        assert_eq!(delta.ft_lp_delta, -100_000);
        assert_eq!(delta.ft_a_delta, -333_333);
        assert_eq!(delta.tbc_sat_delta, -100_000);
        assert_eq!(delta.pool_value_delta, -100_000);
        assert_eq!(state, original);
    }

    #[test]
    fn consume_lp_allows_released_js_full_withdrawal() {
        let state = released_state();
        let delta = consume_lp(&state, 30_001_000, state.ft_lp_raw).unwrap();

        assert_eq!(delta.ft_lp_delta, -30_000_000);
        assert_eq!(delta.ft_a_delta, -100_000_000);
        assert_eq!(delta.tbc_sat_delta, -30_000_000);
        assert_eq!(delta.pool_value_delta, -30_000_000);
    }

    #[test]
    fn tbc_to_ft_matches_released_js_plan_two_fee_and_truncation_vector() {
        // Formula: tbc-contract 1.6.5 poolNFT2.0.js:1000-1023.
        // Cross-check: tbc-contract-go poolnft2.go:2885-2918.
        let state = released_state();
        let original = state.clone();
        let delta = swap_tbc_to_ft(&state, 100_000, 35, 2).unwrap();

        assert_eq!(delta.ft_lp_delta, 0);
        assert_eq!(delta.ft_a_delta, -331_067);
        assert_eq!(delta.tbc_sat_delta, 99_650);
        assert_eq!(delta.pool_value_delta, 99_700);
        assert_eq!(state, original);
    }

    #[test]
    fn tbc_to_ft_lp_plan_changes_only_the_pool_value_fee_share() {
        let state = released_state();
        let plan_one = swap_tbc_to_ft(&state, 100_000, 35, 1).unwrap();
        let plan_two = swap_tbc_to_ft(&state, 100_000, 35, 2).unwrap();
        let plan_five = swap_tbc_to_ft(&state, 100_000, 35, 5).unwrap();

        assert_eq!(plan_one.ft_a_delta, plan_two.ft_a_delta);
        assert_eq!(plan_one.tbc_sat_delta, plan_two.tbc_sat_delta);
        assert_eq!(plan_one.pool_value_delta, 99_900);
        assert_eq!(plan_two.pool_value_delta, 99_700);
        assert_eq!(plan_five, plan_two);
    }

    #[test]
    fn ft_to_tbc_matches_released_js_plan_two_fee_and_truncation_vector() {
        // Formula: tbc-contract 1.6.5 poolNFT2.0.js:1162-1185.
        // Cross-check: tbc-contract-go poolnft2.go:3200-3220.
        let state = released_state();
        let original = state.clone();
        let delta = swap_ft_to_tbc(&state, 1_000_000, 35, 2).unwrap();

        assert_eq!(delta.ft_lp_delta, 0);
        assert_eq!(delta.ft_a_delta, 1_000_000);
        assert_eq!(delta.tbc_sat_delta, -297_030);
        assert_eq!(delta.pool_value_delta, -296_882);
        assert_eq!(state, original);
    }

    #[test]
    fn ft_to_tbc_lp_plan_matches_released_lp_fee_share() {
        let state = released_state();
        let plan_one = swap_ft_to_tbc(&state, 1_000_000, 35, 1).unwrap();
        let plan_two = swap_ft_to_tbc(&state, 1_000_000, 35, 2).unwrap();

        assert_eq!(plan_one.tbc_sat_delta, -297_030);
        assert_eq!(plan_one.pool_value_delta, -296_288);
        assert_eq!(plan_two.pool_value_delta, -296_882);
    }

    #[test]
    fn swaps_preserve_integer_truncation_for_one_raw_unit() {
        let delta = swap_tbc_to_ft(&released_state(), 1, 35, 2).unwrap();
        assert_eq!(delta.ft_a_delta, -4);
        assert_eq!(delta.tbc_sat_delta, 1);
        assert_eq!(delta.pool_value_delta, 1);
    }

    #[test]
    fn math_rejects_zero_reserves_exhaustion_invalid_fees_and_invalid_plans() {
        let zero_ft = PoolAmounts {
            ft_a_raw: 0,
            ..released_state()
        };
        assert!(swap_tbc_to_ft(&zero_ft, 1, 35, 2).is_err());

        let zero_tbc = PoolAmounts {
            tbc_sat: 0,
            ..released_state()
        };
        assert!(increase_lp(&zero_tbc, 1_000, 1).is_err());
        assert!(swap_ft_to_tbc(&zero_tbc, 1, 35, 2).is_err());

        assert!(consume_lp(&released_state(), 30_001_000, 30_000_001).is_err());
        assert!(increase_lp(&released_state(), 999, 1).is_err());
        assert!(swap_tbc_to_ft(&released_state(), 1, 35, 0).is_err());
        assert!(swap_tbc_to_ft(&released_state(), 1, 35, 7).is_err());
        assert!(swap_tbc_to_ft(&released_state(), 1, 9, 1).is_err());
        assert!(swap_ft_to_tbc(&released_state(), 1, 4, 2).is_err());
    }

    #[test]
    fn math_rejects_zero_inputs_overflow_underflow_and_zero_outputs() {
        let state = released_state();
        assert!(increase_lp(&state, 30_001_000, 0).is_err());
        assert!(consume_lp(&state, 30_001_000, 0).is_err());
        assert!(swap_tbc_to_ft(&state, 0, 35, 2).is_err());
        assert!(swap_ft_to_tbc(&state, 0, 35, 2).is_err());

        let almost_full = PoolAmounts {
            ft_lp_raw: u64::MAX,
            ft_a_raw: u64::MAX,
            tbc_sat: 1,
        };
        assert!(increase_lp(&almost_full, 1_001, u64::MAX).is_err());

        let one_ft = PoolAmounts {
            ft_a_raw: 1,
            ..released_state()
        };
        assert!(swap_tbc_to_ft(&one_ft, 30_000_000, 35, 2).is_err());

        let one_tbc = PoolAmounts {
            tbc_sat: 1,
            ..released_state()
        };
        assert!(swap_ft_to_tbc(&one_tbc, 1, 35, 2).is_err());
    }
}
