import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  TBC_TESTNET_API_ORIGIN,
  TestnetAcceptanceError,
  createCredentialFreeTestnetRecord,
  createTbcTestnetRestNodeAccess,
  refreshTbcTestnetAcceptance,
  runTbcTestnetAcceptance,
} from "../examples/third-party-wallet-minimal/dist/esm/testnet-adapter.js";

const PACKAGE_COMMIT = /^[0-9a-f]{40}$/;
const PUBLIC_FAILURE_CODES = new Set([
  "INVALID_INPUT",
  "NODE_RESPONSE_INVALID",
  "NODE_REQUEST_FAILED",
  "INSUFFICIENT_PUBLIC_INPUTS",
  "AUTHORIZATION_REQUIRED",
  "AUTHORIZATION_MISMATCH",
  "SIGNED_TRANSACTION_DRIFT",
  "BROADCAST_MISMATCH",
  "CONFIRMATION_REQUIRED",
]);
const EXTERNAL_INPUT_KEYS = Object.freeze([
  "amount",
  "clientRequestId",
  "clockNow",
  "destination",
  "engineBackend",
  "expiresAt",
  "node",
  "policy",
  "signer",
  "source",
]);

function fail(code, message) {
  throw new TestnetAcceptanceError(code, message);
}

export function testnetAcceptanceFailureCode(error) {
  return PUBLIC_FAILURE_CODES.has(error?.code)
    ? error.code
    : "TESTNET_ACCEPTANCE_FAILED";
}

function assertCommandOptions({
  input,
  packageCommit,
  broadcast,
  confirmationAttempts,
  confirmationIntervalMs,
}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("INVALID_INPUT", "The external acceptance input must be an object.");
  }
  if (
    Object.hasOwn(input, "packageCommit") ||
    Object.hasOwn(input, "authorizeBroadcast")
  ) {
    fail(
      "INVALID_INPUT",
      "The external input cannot provide packageCommit or authorizeBroadcast.",
    );
  }
  if (!PACKAGE_COMMIT.test(packageCommit)) {
    fail("INVALID_INPUT", "packageCommit must be a full lowercase Git SHA.");
  }
  if (typeof broadcast !== "boolean") {
    fail("INVALID_INPUT", "broadcast must be boolean.");
  }
  if (
    !Number.isSafeInteger(confirmationAttempts) ||
    confirmationAttempts < 0 ||
    confirmationAttempts > 1_000
  ) {
    fail("INVALID_INPUT", "confirmationAttempts must be an integer from 0 to 1000.");
  }
  if (
    !Number.isSafeInteger(confirmationIntervalMs) ||
    confirmationIntervalMs < 0 ||
    confirmationIntervalMs > 60_000
  ) {
    fail("INVALID_INPUT", "confirmationIntervalMs must be an integer from 0 to 60000.");
  }
}

async function readApprovalFromTerminal() {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY === true,
  });
  try {
    return await terminal.question("");
  } finally {
    terminal.close();
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function unsignedIntegerArgument(value, flag) {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    fail("INVALID_INPUT", `${flag} requires an unsigned integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    fail("INVALID_INPUT", `${flag} exceeds the safe integer range.`);
  }
  return parsed;
}

export function parseTbcTestnetAcceptanceArgs(argv) {
  const parsed = {
    adapter: undefined,
    broadcast: false,
    confirmationAttempts: 12,
    confirmationIntervalMs: 5_000,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) fail("INVALID_INPUT", `${flag} may be provided only once.`);
    seen.add(flag);
    if (flag === "--broadcast") {
      parsed.broadcast = true;
      continue;
    }
    if (flag === "--adapter") {
      parsed.adapter = argv[index += 1];
      if (parsed.adapter === undefined || parsed.adapter.startsWith("--")) {
        fail("INVALID_INPUT", "--adapter requires a module path.");
      }
      continue;
    }
    if (flag === "--confirmation-attempts") {
      parsed.confirmationAttempts = unsignedIntegerArgument(argv[index += 1], flag);
      continue;
    }
    if (flag === "--confirmation-interval-ms") {
      parsed.confirmationIntervalMs = unsignedIntegerArgument(argv[index += 1], flag);
      continue;
    }
    fail("INVALID_INPUT", `Unsupported acceptance argument: ${flag}.`);
  }
  if (parsed.adapter === undefined) {
    fail("INVALID_INPUT", "--adapter is required.");
  }
  return Object.freeze(parsed);
}

function outsideRepository(adapterPath, repositoryRoot) {
  const relative = path.relative(repositoryRoot, adapterPath);
  return relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function resolveExternalAdapter(candidate, cwd) {
  const resolved = path.resolve(cwd, candidate);
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
}

async function importExternalAdapter(adapterPath) {
  return import(pathToFileURL(adapterPath).href);
}

function currentPackageCommit(repositoryRoot) {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function assertCleanCheckout(repositoryRoot) {
  const status = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (status !== "") {
    fail("INVALID_INPUT", "Testnet acceptance requires a clean Git checkout.");
  }
}

function assertExternalInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("INVALID_INPUT", "The external adapter must return an input object.");
  }
  if (typeof input.engineBackend?.call !== "function") {
    fail("INVALID_INPUT", "The external adapter must supply a TbcEngineBackend.");
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== EXTERNAL_INPUT_KEYS.length ||
    keys.some((key, index) => key !== EXTERNAL_INPUT_KEYS[index])
  ) {
    fail(
      "INVALID_INPUT",
      `The external adapter must return only: ${EXTERNAL_INPUT_KEYS.join(", ")}.`,
    );
  }
}

function assertResultStatus(result, allowed) {
  if (
    result === null ||
    typeof result !== "object" ||
    !allowed.includes(result.status)
  ) {
    fail("INVALID_INPUT", "The acceptance result contradicts the command mode.");
  }
}

/**
 * Runs the acceptance flow without accepting secrets or approval authority in
 * serializable command input. The external signer remains an opaque closure.
 */
export async function runTbcTestnetAcceptanceCommand({
  input,
  packageCommit,
  broadcast = false,
  confirmationAttempts = 12,
  confirmationIntervalMs = 5_000,
  readApproval = readApprovalFromTerminal,
  writeOutput = (chunk) => process.stdout.write(chunk),
  writeStatus = (chunk) => process.stderr.write(chunk),
  dependencies = {},
}) {
  assertCommandOptions({
    input,
    packageCommit,
    broadcast,
    confirmationAttempts,
    confirmationIntervalMs,
  });
  assertExternalInput(input);
  if (typeof input.clockNow !== "function") {
    fail("INVALID_INPUT", "The external adapter must provide clockNow().");
  }

  const runAcceptance = dependencies.runAcceptance ?? runTbcTestnetAcceptance;
  const refreshAcceptance =
    dependencies.refreshAcceptance ?? refreshTbcTestnetAcceptance;
  const createRecord =
    dependencies.createRecord ?? createCredentialFreeTestnetRecord;
  const wait = dependencies.wait ?? delay;

  const commandInput = { ...input, packageCommit };
  if (broadcast) {
    commandInput.authorizeBroadcast = async (preview) => {
      writeStatus(`${JSON.stringify({ kind: "approval-required", preview })}\n`);
      writeStatus(
        "Paste the exact approvalFingerprint above to authorize this broadcast, then press Enter:\n",
      );
      const entered = await readApproval(preview);
      if (entered !== preview.approvalFingerprint) {
        fail("AUTHORIZATION_MISMATCH", "The entered approval fingerprint did not match.");
      }
      return Object.freeze({
        status: "approved",
        approvalFingerprint: preview.approvalFingerprint,
      });
    };
  }

  let result = await runAcceptance(commandInput);
  if (!broadcast) {
    assertResultStatus(result, ["dry-run"]);
    writeOutput(`${JSON.stringify({ kind: "dry-run", result })}\n`);
    return Object.freeze({ status: "dry-run", result });
  }
  assertResultStatus(result, ["broadcast", "confirmed"]);

  for (
    let attempt = 0;
    result.status === "broadcast" && attempt < confirmationAttempts;
    attempt += 1
  ) {
    await wait(confirmationIntervalMs);
    result = await refreshAcceptance(
      input.node,
      result,
      await input.clockNow(),
    );
    assertResultStatus(result, ["broadcast", "confirmed"]);
  }

  if (result.status === "confirmed") {
    const record = createRecord(result);
    writeOutput(`${JSON.stringify(record)}\n`);
    return Object.freeze({ status: "confirmed", record });
  }

  writeStatus(`${JSON.stringify({ kind: "confirmation-pending", result })}\n`);
  return Object.freeze({ status: "broadcast", result });
}

export async function runTbcTestnetAcceptanceCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  repositoryRoot = fileURLToPath(new URL("../..", import.meta.url)),
  dependencies = {},
} = {}) {
  const parsed = parseTbcTestnetAcceptanceArgs(argv);
  const resolveAdapterPath = dependencies.resolveAdapterPath ?? resolveExternalAdapter;
  const loadAdapter = dependencies.loadAdapter ?? importExternalAdapter;
  const readPackageCommit = dependencies.readPackageCommit ?? currentPackageCommit;
  const assertCleanRepository =
    dependencies.assertCleanRepository ?? assertCleanCheckout;
  const runCommand = dependencies.runCommand ?? runTbcTestnetAcceptanceCommand;
  const adapterPath = resolveAdapterPath(parsed.adapter, cwd);
  if (!outsideRepository(adapterPath, repositoryRoot)) {
    fail("INVALID_INPUT", "The acceptance adapter must be stored outside the repository.");
  }
  assertCleanRepository(repositoryRoot);
  const adapter = await loadAdapter(adapterPath);
  if (typeof adapter.createTbcTestnetAcceptanceInput !== "function") {
    fail(
      "INVALID_INPUT",
      "The adapter must export createTbcTestnetAcceptanceInput().",
    );
  }
  const input = await adapter.createTbcTestnetAcceptanceInput(Object.freeze({
    testnetApiOrigin: TBC_TESTNET_API_ORIGIN,
    createRestNodeAccess: createTbcTestnetRestNodeAccess,
  }));
  assertExternalInput(input);
  assertCleanRepository(repositoryRoot);
  return runCommand({
    input,
    packageCommit: readPackageCommit(repositoryRoot),
    broadcast: parsed.broadcast,
    confirmationAttempts: parsed.confirmationAttempts,
    confirmationIntervalMs: parsed.confirmationIntervalMs,
  });
}

const entryUrl = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(process.argv[1]).href;

if (entryUrl === import.meta.url) {
  try {
    const result = await runTbcTestnetAcceptanceCli();
    if (result.status === "broadcast") process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: "fail",
      code: testnetAcceptanceFailureCode(error),
    })}\n`);
    process.exitCode = 1;
  }
}
