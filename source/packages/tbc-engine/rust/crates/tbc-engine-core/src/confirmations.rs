use serde::{Deserialize, Deserializer};

use crate::model::error;
use crate::normalize::parse_decimal_u64;
use crate::{EngineError, ErrorCode};

fn parse_count(value: &str, path: &str) -> Result<u32, EngineError> {
    let count = parse_decimal_u64(value, path)?;
    u32::try_from(count).map_err(|_| {
        error(ErrorCode::InvalidInput, "confirmation count exceeds uint32", path)
    })
}

// serde's default handles absence. A present field must be a canonical string:
// null is not an alternative spelling of unknown, and unknown never becomes 0.
pub(crate) fn deserialize_optional<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    parse_count(&value, "snapshot.payload.utxos.confirmations")
        .map_err(|error| serde::de::Error::custom(error.message))?;
    Ok(Some(value))
}

pub(crate) fn meets_minimum(
    value: Option<&str>,
    minimum: u64,
    path: &str,
) -> Result<bool, EngineError> {
    if minimum > u32::MAX as u64 {
        return Err(error(ErrorCode::InvalidInput, "minimum confirmations exceeds uint32", "policy.payload.minConfirmations"));
    }
    let actual = value.map(|value| parse_count(value, path)).transpose()?;
    Ok(minimum == 0 || actual.is_some_and(|actual| u64::from(actual) >= minimum))
}

pub(crate) fn validate_minimum(value: &str) -> Result<(), EngineError> {
    parse_count(value, "policy.payload.minConfirmations").map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::WalletUtxo;
    use crate::normalize::canonical_hash;
    use serde_json::{Value, json};

    #[test]
    fn optional_confirmations_threshold_truth_table() {
        for (value, minimum, expected) in [
            (None, 0, true), (None, 1, false),
            (Some("0"), 0, true), (Some("0"), 1, false),
            (Some("1"), 1, true), (Some("1"), 2, false),
            (Some("2"), 2, true), (Some("4294967295"), u32::MAX as u64, true),
        ] {
            assert_eq!(meets_minimum(value, minimum, "test").unwrap(), expected);
        }
        for invalid in ["", "00", "01", "-1", "+1", " 1", "1.0", "4294967296"] {
            assert!(meets_minimum(Some(invalid), 0, "test").is_err());
        }
    }

    #[test]
    fn optional_confirmations_serde_preserves_absence_zero_and_hashes() {
        let absent = json!({"txid":"11".repeat(32), "vout":0, "satoshis":"1000",
            "scriptPubKey":"51", "classification":"native"});
        let unknown: WalletUtxo = serde_json::from_value(absent.clone()).unwrap();
        assert_eq!(unknown.confirmations, None);
        assert_eq!(serde_json::to_value(&unknown).unwrap(), absent);
        assert_eq!(canonical_hash(&unknown).unwrap(), canonical_hash(&absent).unwrap());
        let mut zero = absent.clone();
        zero["confirmations"] = json!("0");
        let known: WalletUtxo = serde_json::from_value(zero.clone()).unwrap();
        assert_eq!(known.confirmations.as_deref(), Some("0"));
        assert_eq!(serde_json::to_value(&known).unwrap(), zero);
        assert_ne!(canonical_hash(&known).unwrap(), canonical_hash(&unknown).unwrap());
        for invalid in [Value::Null, json!(0), json!(false), json!("01"), json!("4294967296")] {
            let mut value = absent.clone();
            value["confirmations"] = invalid;
            assert!(serde_json::from_value::<WalletUtxo>(value).is_err());
        }
    }
}
