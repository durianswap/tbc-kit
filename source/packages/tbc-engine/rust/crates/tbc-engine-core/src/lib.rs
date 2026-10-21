#![forbid(unsafe_code)]

mod ancestry;
mod business;
mod confirmations;
mod error;
mod fee_envelope;
mod families;
mod finalize;
mod funding;
mod funding_fallback;
mod model;
mod normalize;
mod plan;
mod output_review;
pub mod protocols;
pub mod signing;
mod signing_wire;
mod validate;
mod wire;

pub use error::{EngineError, ErrorCode};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EngineMethod {
    NormalizeRequest,
    Plan,
    Validate,
    Finalize,
}

pub fn call_json(method: EngineMethod, input: &str) -> String {
    wire::encode_result(
        serde_json::from_str(input)
            .map_err(EngineError::invalid_input)
            .and_then(|input| dispatch(method, input)),
    )
}

pub fn call_json_name(method: &str, input: &str) -> String {
    let method = match method {
        "normalizeRequest" => EngineMethod::NormalizeRequest,
        "plan" => EngineMethod::Plan,
        "validate" => EngineMethod::Validate,
        "finalize" => EngineMethod::Finalize,
        unsupported => {
            return wire::encode_result(Err(EngineError::unsupported_method(unsupported)));
        }
    };

    call_json(method, input)
}

fn dispatch(method: EngineMethod, input: serde_json::Value) -> Result<serde_json::Value, EngineError> {
    match method {
        EngineMethod::NormalizeRequest => normalize::normalize_request(input),
        EngineMethod::Plan => plan::plan(input),
        EngineMethod::Validate => validate::validate(input),
        EngineMethod::Finalize => finalize::finalize(input),
    }
}
