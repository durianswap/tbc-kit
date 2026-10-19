#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceCommit = "923497e8b2473c0e179fa0b86dbb32a2f188d25a";
const sourceSubtree = "modules/tbc-transaction-engine/rust";
const usage = `Usage:
  TBC_WALLET_SOURCE_REPO=/absolute/path/to/turing-wallet \\
    node packages/tbc-engine/scripts/compare-rust-tbc-source-vector.mjs

Prerequisites: git, tar, Cargo/Rust, and the pinned crate dependencies in Cargo's
local cache. The comparator reads the pinned commit through git archive, so dirty
or untracked source-worktree contents cannot affect the result.`;

if (process.argv.includes("--help")) {
  console.log(usage);
  process.exit(0);
}
const sourceRepository = process.env.TBC_WALLET_SOURCE_REPO;
if (!sourceRepository) throw new Error(`TBC_WALLET_SOURCE_REPO is required.\n\n${usage}`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error?.code === "ENOENT") throw new Error(`required external tool is unavailable: ${command}`);
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

assert.equal(
  run("git", ["-C", sourceRepository, "rev-parse", `${sourceCommit}^{commit}`]),
  sourceCommit,
  "source repository does not contain the pinned commit",
);

const temporary = mkdtempSync(path.join(os.tmpdir(), "tbc-source-vector-"));
try {
  const archive = path.join(temporary, "source.tar");
  run("git", ["-C", sourceRepository, "archive", "--format=tar", `--output=${archive}`, sourceCommit, sourceSubtree]);
  run("tar", ["-xf", archive, "-C", temporary]);
  const sourceCrate = path.join(temporary, sourceSubtree);
  const comparator = path.join(temporary, "comparator");
  mkdirSync(path.join(comparator, "src"), { recursive: true });
  writeFileSync(path.join(comparator, "Cargo.toml"), `[package]
name = "tbc-source-vector-comparator"
version = "0.0.0"
edition = "2024"
publish = false

[dependencies]
hex = "0.4"
serde_json = "1"
tbc-sdk = { path = "${path.join(sourceCrate, "vendor/tbc-sdk")}" }
tbc-transaction-engine = { path = "${sourceCrate}" }
`);
  writeFileSync(path.join(comparator, "src/main.rs"), String.raw`
use serde_json::{Value, json};
use tbc_sdk::{DEFAULT_SIGHASH, PrivateKey, Transaction, script::Script};

fn compact_from_der(der: &[u8]) -> Result<Vec<u8>, String> {
    if der.len() < 8 || der[0] != 0x30 || der[1] as usize + 2 != der.len() || der[2] != 0x02 {
        return Err("source signature is not canonical DER".to_owned());
    }
    let r_len = der[3] as usize;
    let s_tag = 4 + r_len;
    if s_tag + 2 > der.len() || der[s_tag] != 0x02 { return Err("invalid DER integers".to_owned()); }
    let s_len = der[s_tag + 1] as usize;
    if s_tag + 2 + s_len != der.len() { return Err("invalid DER length".to_owned()); }
    let normalize = |integer: &[u8]| -> Result<[u8; 32], String> {
        let integer = if integer.first() == Some(&0) { &integer[1..] } else { integer };
        if integer.len() > 32 { return Err("DER integer exceeds compact64".to_owned()); }
        let mut result = [0u8; 32];
        result[32 - integer.len()..].copy_from_slice(integer);
        Ok(result)
    };
    let r = normalize(&der[4..4 + r_len])?;
    let s = normalize(&der[s_tag + 2..])?;
    Ok([r.as_slice(), s.as_slice()].concat())
}

fn main() -> Result<(), String> {
    let key = PrivateKey::from_slice(&{ let mut scalar = [0u8; 32]; scalar[31] = 1; scalar })
        .map_err(|error| error.to_string())?;
    let script_hex = "76a914751e76e8199196d454941c45d1b3a323f1433bd688ac";
    let request = json!({
        "privateKeyWif": key.to_wif(),
        "inputs": [{"txid": "f32f5392aa7ab9414bf93d497fde479dce609f6a74b708be7988cf9bb698e4d1", "outputIndex": 0, "satoshis": 10000, "script": script_hex}],
        "outputs": [{"address": "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP", "satoshis": 1000}],
        "changeAddress": "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
        "feeSat": 80
    });
    let response: Value = serde_json::from_str(&tbc_transaction_engine::build_tbc_transaction_json(&request.to_string())?)
        .map_err(|error| error.to_string())?;
    let raw = response["txraw"].as_str().ok_or("source response omitted txraw")?;
    let signed = Transaction::from_hex(raw).map_err(|error| error.to_string())?;
    let source_script = Script::from_bytes(hex::decode(script_hex).map_err(|e| e.to_string())?);
    let digest = signed.sighash_digest(0, &source_script, 10_000, DEFAULT_SIGHASH)
        .map_err(|error| error.to_string())?;
    let script = signed.inputs[0].script_sig.as_bytes();
    let signature_length = *script.first().ok_or("source scriptSig is empty")? as usize;
    if signature_length < 2 || signature_length + 1 > script.len() { return Err("malformed source signature push".to_owned()); }
    let signature_with_type = &script[1..1 + signature_length];
    if signature_with_type[signature_with_type.len() - 1] != (DEFAULT_SIGHASH & 0xff) as u8 {
        return Err("unexpected source sighash byte".to_owned());
    }
    let compact = compact_from_der(&signature_with_type[..signature_with_type.len() - 1])?;
    let mut unsigned = signed.clone();
    unsigned.inputs[0].script_sig = Script::from_bytes(Vec::new());
    println!("{}", json!({
        "rawTransaction": raw,
        "unsignedTransaction": unsigned.to_hex(),
        "txid": response["txid"],
        "feeSat": response["feeSat"],
        "sighash": hex::encode(digest),
        "signature": hex::encode(compact)
    }));
    Ok(())
}
`);

  const generated = JSON.parse(run("cargo", ["run", "--quiet", "--offline"], {
    cwd: comparator,
    env: { ...process.env, CARGO_TARGET_DIR: path.join(temporary, "target") },
  }));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const fixture = JSON.parse(readFileSync(path.join(repoRoot, "packages/tbc-engine/rust/fixtures/tbc-transfer.json"), "utf8"));
  assert.deepEqual(generated, {
    rawTransaction: fixture.finalized.bundle.transactions[0].rawTransaction,
    unsignedTransaction: fixture.plan.plan.payload.transactions[0].unsignedTransaction,
    txid: fixture.finalized.bundle.transactions[0].txid,
    feeSat: Number(fixture.finalized.bundle.totalFee),
    sighash: fixture.plan.plan.payload.signingTasks[0].digest,
    signature: fixture.finalizeInput.signatures[0].signature,
  });
  console.log(`PASS pinned source ${sourceCommit}: raw/unsigned transaction, sighash, signature, txid, and fee match`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
