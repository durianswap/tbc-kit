//! Offline test runner for current-source cross-language interoperability checks.
//! Only the public four-method Engine facade is exposed; no keys or transports.
use std::io::{self, Read, Write};

fn main() {
    if let Err(message) = run() {
        eprintln!("PUBLIC_ENGINE_RUNNER_ERROR: {message}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), &'static str> {
    const MAX_INPUT: u64 = 16 * 1024 * 1024;
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 2 { return Err("expected exactly one public method argument"); }
    if !matches!(args[1].as_str(), "normalizeRequest" | "plan" | "validate" | "finalize") {
        return Err("unsupported public method");
    }
    let mut input = Vec::new();
    io::stdin().lock().take(MAX_INPUT + 1).read_to_end(&mut input)
        .map_err(|_| "could not read bounded stdin")?;
    if input.len() as u64 > MAX_INPUT { return Err("stdin exceeds 16 MiB test-runner limit"); }
    let input = std::str::from_utf8(&input).map_err(|_| "stdin must be UTF-8 JSON")?;
    let result = tbc_engine_core::call_json_name(&args[1], input);
    let mut stdout = io::stdout().lock();
    stdout.write_all(result.as_bytes()).map_err(|_| "could not write Engine response")?;
    stdout.write_all(b"\n").map_err(|_| "could not terminate Engine response")?;
    Ok(())
}
