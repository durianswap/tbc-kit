use serde::Serialize;
use serde_json::Value;

use crate::EngineError;

const VERSION: &str = "1.0";
const INTERNAL_ERROR: &str = r#"{"version":"1.0","ok":false,"error":{"code":"INTERNAL_INVARIANT","message":"failed to encode Engine response"}}"#;

#[derive(Serialize)]
struct SuccessEnvelope {
    version: &'static str,
    ok: bool,
    result: Value,
}

#[derive(Serialize)]
struct ErrorEnvelope {
    version: &'static str,
    ok: bool,
    error: EngineError,
}

pub(crate) fn encode_result(result: Result<Value, EngineError>) -> String {
    let encoded = match result {
        Ok(result) => serde_json::to_string(&SuccessEnvelope {
            version: VERSION,
            ok: true,
            result,
        }),
        Err(error) => serde_json::to_string(&ErrorEnvelope {
            version: VERSION,
            ok: false,
            error,
        }),
    };

    encoded.unwrap_or_else(|_| INTERNAL_ERROR.to_owned())
}
