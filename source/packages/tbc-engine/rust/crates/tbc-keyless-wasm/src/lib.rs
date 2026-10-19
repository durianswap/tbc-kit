use std::{slice, str};

#[repr(C)]
pub struct TbcKeylessWasmBuffer {
    ptr: *mut u8,
    len: usize,
    cap: usize,
}

fn response(result: Result<String, String>) -> String {
    match result {
        Ok(value) => value,
        Err(message) => serde_json::json!({ "error": message }).to_string(),
    }
}

unsafe fn utf8_argument<'a>(ptr: *const u8, len: usize, name: &str) -> Result<&'a str, String> {
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
pub extern "C" fn tbc_keyless_wasm_alloc(len: usize) -> *mut u8 {
    let mut bytes = vec![0u8; len];
    let ptr = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    ptr
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn tbc_keyless_wasm_free_input(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        unsafe { drop(Vec::from_raw_parts(ptr, len, len)) };
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn tbc_keyless_wasm_call(
    operation_ptr: *const u8,
    operation_len: usize,
    input_ptr: *const u8,
    input_len: usize,
) -> *mut TbcKeylessWasmBuffer {
    let output = match (
        unsafe { utf8_argument(operation_ptr, operation_len, "operation") },
        unsafe { utf8_argument(input_ptr, input_len, "input") },
    ) {
        (Ok(operation), Ok(input)) => response(tbc_keyless_core::call(operation, input)),
        (Err(error), _) | (_, Err(error)) => response(Err(error)),
    };
    let mut bytes = output.into_bytes();
    let buffer = Box::new(TbcKeylessWasmBuffer {
        ptr: bytes.as_mut_ptr(),
        len: bytes.len(),
        cap: bytes.capacity(),
    });
    std::mem::forget(bytes);
    Box::into_raw(buffer)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn tbc_keyless_wasm_result_ptr(
    buffer: *const TbcKeylessWasmBuffer,
) -> *mut u8 {
    unsafe { (*buffer).ptr }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn tbc_keyless_wasm_result_len(buffer: *const TbcKeylessWasmBuffer) -> usize {
    unsafe { (*buffer).len }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn tbc_keyless_wasm_free_result(buffer: *mut TbcKeylessWasmBuffer) {
    if buffer.is_null() {
        return;
    }
    let buffer = unsafe { Box::from_raw(buffer) };
    if !buffer.ptr.is_null() && buffer.cap >= buffer.len {
        unsafe { drop(Vec::from_raw_parts(buffer.ptr, buffer.len, buffer.cap)) };
    }
}

pub fn call_for_test(operation: &str, input: &str) -> String {
    response(tbc_keyless_core::call(operation, input))
}
