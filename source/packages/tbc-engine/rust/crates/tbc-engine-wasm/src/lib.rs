use std::{slice, str};

fn unavailable_random(_: &mut [u8]) -> Result<(), getrandom_02::Error> {
    Err(getrandom_02::Error::UNSUPPORTED)
}

getrandom_02::register_custom_getrandom!(unavailable_random);

#[repr(C)]
pub struct TbcEngineWasmBuffer {
    ptr: *mut u8,
    len: usize,
    cap: usize,
}

fn invalid_wasm_input(message: &str) -> String {
    let escaped = message.replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        "{{\"error\":{{\"code\":\"INVALID_INPUT\",\"message\":\"{escaped}\",\"path\":\"wasm\"}},\"ok\":false,\"version\":\"1.0\"}}"
    )
}

unsafe fn utf8_argument<'a>(ptr: *const u8, len: usize, name: &str) -> Result<&'a str, String> {
    if len == 0 {
        return Ok("");
    }
    if ptr.is_null() {
        return Err(invalid_wasm_input(&format!("{name} pointer is null")));
    }
    str::from_utf8(unsafe { slice::from_raw_parts(ptr, len) })
        .map_err(|_| invalid_wasm_input(&format!("{name} is not valid UTF-8")))
}

#[unsafe(no_mangle)]
pub extern "C" fn tbc_engine_wasm_alloc(len: usize) -> *mut u8 {
    let mut bytes = vec![0u8; len];
    let ptr = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    ptr
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn tbc_engine_wasm_free_input(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        unsafe { drop(Vec::from_raw_parts(ptr, len, len)) };
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn tbc_engine_wasm_call(
    method_ptr: *const u8,
    method_len: usize,
    input_ptr: *const u8,
    input_len: usize,
) -> *mut TbcEngineWasmBuffer {
    let response = match (
        unsafe { utf8_argument(method_ptr, method_len, "method") },
        unsafe { utf8_argument(input_ptr, input_len, "input") },
    ) {
        (Ok(method), Ok(input)) => tbc_engine_core::call_json_name(method, input),
        (Err(error), _) | (_, Err(error)) => error,
    };
    let mut bytes = response.into_bytes();
    let buffer = Box::new(TbcEngineWasmBuffer {
        ptr: bytes.as_mut_ptr(),
        len: bytes.len(),
        cap: bytes.capacity(),
    });
    std::mem::forget(bytes);
    Box::into_raw(buffer)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn tbc_engine_wasm_result_ptr(
    buffer: *const TbcEngineWasmBuffer,
) -> *mut u8 {
    unsafe { (*buffer).ptr }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn tbc_engine_wasm_result_len(
    buffer: *const TbcEngineWasmBuffer,
) -> usize {
    unsafe { (*buffer).len }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn tbc_engine_wasm_free_result(buffer: *mut TbcEngineWasmBuffer) {
    if buffer.is_null() {
        return;
    }
    let buffer = unsafe { Box::from_raw(buffer) };
    if !buffer.ptr.is_null() && buffer.cap >= buffer.len {
        unsafe { drop(Vec::from_raw_parts(buffer.ptr, buffer.len, buffer.cap)) };
    }
}

pub fn call_for_test(method: &str, input: &str) -> String {
    tbc_engine_core::call_json_name(method, input)
}
