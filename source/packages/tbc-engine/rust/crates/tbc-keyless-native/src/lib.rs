use std::{
    panic::{AssertUnwindSafe, catch_unwind},
    ptr, slice, str,
};

#[repr(C)]
pub struct TbcKeylessBuffer {
    pub ptr: *mut u8,
    pub len: usize,
    pub cap: usize,
}

impl TbcKeylessBuffer {
    fn from_string(value: String) -> Self {
        let mut bytes = value.into_bytes();
        let buffer = Self {
            ptr: bytes.as_mut_ptr(),
            len: bytes.len(),
            cap: bytes.capacity(),
        };
        std::mem::forget(bytes);
        buffer
    }
}

fn response(result: Result<String, String>) -> String {
    match result {
        Ok(value) => value,
        Err(message) => serde_json::json!({ "error": message }).to_string(),
    }
}

unsafe fn utf8_argument<'a>(
    ptr: *const u8,
    len: usize,
    name: &str,
) -> Result<&'a str, String> {
    if len == 0 {
        return Ok("");
    }
    if ptr.is_null() {
        return Err(format!("{name} pointer is null"));
    }
    str::from_utf8(unsafe { slice::from_raw_parts(ptr, len) })
        .map_err(|_| format!("{name} is not valid UTF-8"))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn tbc_keyless_call(
    operation_ptr: *const u8,
    operation_len: usize,
    input_ptr: *const u8,
    input_len: usize,
) -> TbcKeylessBuffer {
    let output = catch_unwind(AssertUnwindSafe(|| {
        let operation = unsafe { utf8_argument(operation_ptr, operation_len, "operation") }?;
        let input = unsafe { utf8_argument(input_ptr, input_len, "input") }?;
        Ok::<_, String>(response(tbc_keyless_core::call(operation, input)))
    }))
    .map_err(|_| "native adapter caught a Rust panic".to_owned())
    .and_then(|result| result)
    .unwrap_or_else(|error| response(Err(error)));
    TbcKeylessBuffer::from_string(output)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn tbc_keyless_free(buffer: TbcKeylessBuffer) {
    if buffer.ptr.is_null() || buffer.cap < buffer.len {
        return;
    }
    unsafe { drop(Vec::from_raw_parts(buffer.ptr, buffer.len, buffer.cap)) };
}

pub fn call_for_test(operation: &str, input: &str) -> String {
    response(tbc_keyless_core::call(operation, input))
}

pub fn empty_buffer() -> TbcKeylessBuffer {
    TbcKeylessBuffer {
        ptr: ptr::null_mut(),
        len: 0,
        cap: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_facade_exposes_keyless_core_without_signing() {
        let info = call_for_test("legacyPoolPreview", r#"{"operation":"increaseLp","ftContractId":"2222222222222222222222222222222222222222222222222222222222222222","ftDecimal":6,"amount":"0.001","lockTime":0,"pool":{"ftLpRaw":"10000","ftARaw":"5000","tbcSat":"10000","poolValueSat":"11000","publicKeyLocked":false}}"#);
        assert!(info.contains("\"ftlpMintedRaw\":\"1000\""));
        assert_eq!(call_for_test("sign", "{}"), r#"{"error":"KEYLESS_OPERATION_UNAVAILABLE"}"#);
    }
}
