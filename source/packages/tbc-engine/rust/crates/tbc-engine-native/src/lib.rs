use std::{panic::{AssertUnwindSafe, catch_unwind}, ptr, slice, str};

#[repr(C)]
pub struct TbcEngineBuffer {
    pub ptr: *mut u8,
    pub len: usize,
    pub cap: usize,
}

impl TbcEngineBuffer {
    fn from_string(value: String) -> Self {
        let mut bytes = value.into_bytes();
        let buffer = Self { ptr: bytes.as_mut_ptr(), len: bytes.len(), cap: bytes.capacity() };
        std::mem::forget(bytes);
        buffer
    }
}

fn invalid_native_input(message: &str) -> String {
    format!(
        "{{\"error\":{{\"code\":\"INVALID_INPUT\",\"message\":{} ,\"path\":\"native\"}},\"ok\":false,\"version\":\"1.0\"}}",
        serde_json_string(message),
    )
}

fn serde_json_string(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('"');
    for character in value.chars() {
        match character {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            character if character.is_control() => {
                use std::fmt::Write;
                let _ = write!(escaped, "\\u{:04x}", character as u32);
            }
            character => escaped.push(character),
        }
    }
    escaped.push('"');
    escaped
}

unsafe fn utf8_argument<'a>(ptr: *const u8, len: usize, name: &str) -> Result<&'a str, String> {
    if len == 0 {
        return Ok("");
    }
    if ptr.is_null() {
        return Err(invalid_native_input(&format!("{name} pointer is null for a non-empty buffer")));
    }
    let bytes = unsafe { slice::from_raw_parts(ptr, len) };
    str::from_utf8(bytes)
        .map_err(|_| invalid_native_input(&format!("{name} is not valid UTF-8")))
}

unsafe fn byte_argument<'a>(ptr: *const u8, len: usize, name: &str) -> Result<&'a [u8], String> {
    if len == 0 {
        return Ok(&[]);
    }
    if ptr.is_null() {
        return Err(invalid_native_input(&format!("{name} pointer is null for a non-empty buffer")));
    }
    Ok(unsafe { slice::from_raw_parts(ptr, len) })
}

fn private_response(result: Result<String, String>) -> String {
    match result {
        Ok(value) => format!("{{\"ok\":true,\"value\":{value},\"version\":\"1.0\"}}"),
        Err(message) => format!(
            "{{\"error\":{{\"code\":\"INVALID_INPUT\",\"message\":{},\"path\":\"wallet-private-native\"}},\"ok\":false,\"version\":\"1.0\"}}",
            serde_json_string(&message),
        ),
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn tbc_engine_call(
    method_ptr: *const u8,
    method_len: usize,
    input_ptr: *const u8,
    input_len: usize,
) -> TbcEngineBuffer {
    let response = catch_unwind(AssertUnwindSafe(|| {
        let method = unsafe { utf8_argument(method_ptr, method_len, "method") }?;
        let input = unsafe { utf8_argument(input_ptr, input_len, "input") }?;
        Ok::<_, String>(tbc_engine_core::call_json_name(method, input))
    }))
    .map_err(|_| invalid_native_input("native adapter caught a Rust panic"))
    .and_then(|result| result)
    .unwrap_or_else(|error| error);
    TbcEngineBuffer::from_string(response)
}

/// Restricted wallet-private operations. The scalar is a separate byte buffer
/// and is never accepted in request JSON or by the public Engine entry point.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn tbc_wallet_private_call(
    method_ptr: *const u8,
    method_len: usize,
    input_ptr: *const u8,
    input_len: usize,
    scalar_ptr: *const u8,
    scalar_len: usize,
) -> TbcEngineBuffer {
    let response = catch_unwind(AssertUnwindSafe(|| {
        let method = unsafe { utf8_argument(method_ptr, method_len, "method") }?;
        let input = unsafe { utf8_argument(input_ptr, input_len, "input") }?;
        let scalar = unsafe { byte_argument(scalar_ptr, scalar_len, "scalar") }?;
        Ok::<_, String>(private_response(tbc_wallet_private_core::call(method, input, scalar)))
    }))
    .map_err(|_| invalid_native_input("wallet-private native adapter caught a Rust panic"))
    .and_then(|result| result)
    .unwrap_or_else(|error| error);
    TbcEngineBuffer::from_string(response)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn tbc_engine_free(buffer: TbcEngineBuffer) {
    if buffer.ptr.is_null() {
        return;
    }
    if buffer.cap < buffer.len {
        return;
    }
    unsafe {
        drop(Vec::from_raw_parts(buffer.ptr, buffer.len, buffer.cap));
    }
}

pub fn call_for_test(method: &str, input: &str) -> String {
    tbc_engine_core::call_json_name(method, input)
}

pub fn call_private_for_test(method: &str, input: &str, scalar: &[u8]) -> String {
    private_response(tbc_wallet_private_core::call(method, input, scalar))
}

pub fn empty_buffer() -> TbcEngineBuffer {
    TbcEngineBuffer { ptr: ptr::null_mut(), len: 0, cap: 0 }
}

#[cfg(test)]
mod tests {
    use super::{tbc_engine_call, tbc_engine_free, tbc_wallet_private_call, TbcEngineBuffer};

    unsafe fn read_and_free(buffer: TbcEngineBuffer) -> String {
        let value = String::from_utf8(
            unsafe { std::slice::from_raw_parts(buffer.ptr, buffer.len) }.to_vec(),
        )
        .unwrap();
        unsafe { tbc_engine_free(buffer) };
        value
    }

    #[test]
    fn private_c_abi_uses_a_separate_scalar_buffer() {
        let method = b"encryptMessage";
        let input = br#"{"messageHex":"68656c6c6f"}"#;
        let scalar = [7u8; 32];
        let response = unsafe {
            read_and_free(tbc_wallet_private_call(
                method.as_ptr(),
                method.len(),
                input.as_ptr(),
                input.len(),
                scalar.as_ptr(),
                scalar.len(),
            ))
        };
        assert!(response.contains("\"ok\":true"));
        assert!(response.contains("\"encryptedMessage\""));
        assert!(!response.contains("scalar"));
    }

    #[test]
    fn public_c_abi_does_not_route_wallet_private_methods() {
        let method = b"encryptMessage";
        let input = br#"{"messageHex":"68656c6c6f"}"#;
        let response = unsafe {
            read_and_free(tbc_engine_call(
                method.as_ptr(),
                method.len(),
                input.as_ptr(),
                input.len(),
            ))
        };
        assert!(response.contains("UNSUPPORTED_METHOD"));
        assert!(!response.contains("encryptedMessage"));
    }
}
