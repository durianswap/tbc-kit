use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidInput,
    UnsupportedMethod,
    UnsupportedIntent,
    MissingMaterial,
    InvalidAncestry,
    InsufficientFunds,
    FeeCapExceeded,
    InvalidPlan,
    MissingSignature,
    InvalidSignature,
    InternalInvariant,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl EngineError {
    pub(crate) fn invalid_input(error: serde_json::Error) -> Self {
        Self {
            code: ErrorCode::InvalidInput,
            message: format!("invalid JSON input: {error}"),
            path: Some("input".to_owned()),
        }
    }

    pub(crate) fn unsupported_method(method: &str) -> Self {
        Self {
            code: ErrorCode::UnsupportedMethod,
            message: format!("unsupported Engine method: {method}"),
            path: Some("method".to_owned()),
        }
    }
}
