import assert from "node:assert/strict";
import test from "node:test";

const PACKAGE_COMMIT = "ab".repeat(20);
const APPROVAL_FINGERPRINT = "cd".repeat(32);
const TXID = "ef".repeat(32);
const PREVIEW = Object.freeze({
  version: "1.0",
  chainId: "tbc:testnet",
  sourceAddress: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
  destinationAddress: "1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP",
  amount: "100",
  totalFee: "80",
  transactions: [{ txid: TXID, rawTransactionSha256: "12".repeat(32) }],
  packageCommit: PACKAGE_COMMIT,
  preparedAt: "2026-09-02T00:00:00Z",
  approvalFingerprint: APPROVAL_FINGERPRINT,
});
const DRY_RUN = Object.freeze({
  status: "dry-run",
  preview: PREVIEW,
  transactionIds: [TXID],
  transactionStatuses: [],
  verifiedAt: "2026-09-02T00:00:01Z",
});
const BROADCAST = Object.freeze({
  ...DRY_RUN,
  status: "broadcast",
  transactionStatuses: [{ txid: TXID, status: "mempool", confirmations: "0" }],
});
const CONFIRMED = Object.freeze({
  ...BROADCAST,
  status: "confirmed",
  transactionStatuses: [{ txid: TXID, status: "confirmed", confirmations: "1" }],
  verifiedAt: "2026-09-02T00:00:02Z",
});
const RECORD = Object.freeze({
  schemaVersion: "1.0",
  status: "confirmed",
  chainId: PREVIEW.chainId,
  sourceAddress: PREVIEW.sourceAddress,
  destinationAddress: PREVIEW.destinationAddress,
  transactionIds: [TXID],
  packageCommit: PACKAGE_COMMIT,
  preparedAt: PREVIEW.preparedAt,
  verifiedAt: CONFIRMED.verifiedAt,
});

function externalInput() {
  return {
    node: Object.freeze({}),
    engineBackend: Object.freeze({ async call() { throw new Error("command test must not execute Engine"); } }),
    source: {
      address: PREVIEW.sourceAddress,
      publicKey: `02${"11".repeat(32)}`,
    },
    destination: PREVIEW.destinationAddress,
    amount: PREVIEW.amount,
    clientRequestId: "acceptance-command-test",
    expiresAt: "2026-09-02T00:05:00Z",
    policy: {
      feeRateSatPerKb: "80",
      dustThreshold: "24",
      minConfirmations: "1",
      maxFee: "200",
    },
    signer: async () => {
      throw new Error("the command test does not invoke the external signer");
    },
    clockNow: async () => "2026-09-02T00:00:02Z",
  };
}

test("runs dry by default and emits no broadcast authority", async () => {
  const { runTbcTestnetAcceptanceCommand } = await import(
    "../../../scripts/run-testnet-acceptance.mjs"
  );
  let output = "";

  const result = await runTbcTestnetAcceptanceCommand({
    input: externalInput(),
    packageCommit: PACKAGE_COMMIT,
    writeOutput(chunk) {
      output += chunk;
    },
    dependencies: {
      async runAcceptance(input) {
        assert.equal(input.packageCommit, PACKAGE_COMMIT);
        assert.equal(typeof input.engineBackend.call, "function");
        assert.equal(input.authorizeBroadcast, undefined);
        return DRY_RUN;
      },
    },
  });

  assert.deepEqual(result, { status: "dry-run", result: DRY_RUN });
  assert.deepEqual(JSON.parse(output), { kind: "dry-run", result: DRY_RUN });
  assert.doesNotMatch(output, /"rawTransaction":/);
});

test("rejects caller-supplied commit, broadcast authority, or extra fields", async () => {
  const { runTbcTestnetAcceptanceCommand } = await import(
    "../../../scripts/run-testnet-acceptance.mjs"
  );
  let runs = 0;
  const options = {
    packageCommit: PACKAGE_COMMIT,
    writeOutput() {},
    dependencies: {
      async runAcceptance() {
        runs += 1;
        return DRY_RUN;
      },
    },
  };

  await assert.rejects(
    runTbcTestnetAcceptanceCommand({
      ...options,
      input: { ...externalInput(), packageCommit: "12".repeat(20) },
    }),
    (error) => error?.code === "INVALID_INPUT",
  );
  await assert.rejects(
    runTbcTestnetAcceptanceCommand({
      ...options,
      input: { ...externalInput(), authorizeBroadcast() {} },
    }),
    (error) => error?.code === "INVALID_INPUT",
  );
  await assert.rejects(
    runTbcTestnetAcceptanceCommand({
      ...options,
      input: { ...externalInput(), privateKey: "must-not-cross-this-boundary" },
    }),
    (error) => error?.code === "INVALID_INPUT",
  );
  assert.equal(runs, 0);
});

test("rejects an acceptance result that contradicts the command mode", async () => {
  const { runTbcTestnetAcceptanceCommand } = await import(
    "../../../scripts/run-testnet-acceptance.mjs"
  );
  const common = {
    input: externalInput(),
    packageCommit: PACKAGE_COMMIT,
    writeOutput() {},
    writeStatus() {},
  };

  await assert.rejects(
    runTbcTestnetAcceptanceCommand({
      ...common,
      dependencies: { async runAcceptance() { return BROADCAST; } },
    }),
    (error) => error?.code === "INVALID_INPUT",
  );
  await assert.rejects(
    runTbcTestnetAcceptanceCommand({
      ...common,
      broadcast: true,
      dependencies: { async runAcceptance() { return DRY_RUN; } },
    }),
    (error) => error?.code === "INVALID_INPUT",
  );
});

test("rejects a non-boolean broadcast mode before running acceptance", async () => {
  const { runTbcTestnetAcceptanceCommand } = await import(
    "../../../scripts/run-testnet-acceptance.mjs"
  );
  let runs = 0;

  await assert.rejects(
    runTbcTestnetAcceptanceCommand({
      input: externalInput(),
      packageCommit: PACKAGE_COMMIT,
      broadcast: "yes",
      writeOutput() {},
      writeStatus() {},
      dependencies: {
        async runAcceptance() {
          runs += 1;
          return CONFIRMED;
        },
      },
    }),
    (error) => error?.code === "INVALID_INPUT",
  );
  assert.equal(runs, 0);
});

test("requires the exact in-process fingerprint before broadcasting and emits a confirmed record", async () => {
  const { runTbcTestnetAcceptanceCommand } = await import(
    "../../../scripts/run-testnet-acceptance.mjs"
  );
  let output = "";
  let prompt = "";
  let refreshes = 0;

  const result = await runTbcTestnetAcceptanceCommand({
    input: externalInput(),
    packageCommit: PACKAGE_COMMIT,
    broadcast: true,
    confirmationAttempts: 1,
    confirmationIntervalMs: 0,
    async readApproval() {
      return APPROVAL_FINGERPRINT;
    },
    writeOutput(chunk) {
      output += chunk;
    },
    writeStatus(chunk) {
      prompt += chunk;
    },
    dependencies: {
      async runAcceptance(input) {
        const authorization = await input.authorizeBroadcast(PREVIEW);
        assert.deepEqual(authorization, {
          status: "approved",
          approvalFingerprint: APPROVAL_FINGERPRINT,
        });
        return BROADCAST;
      },
      async refreshAcceptance(_node, resultToRefresh, verifiedAt) {
        refreshes += 1;
        assert.equal(resultToRefresh, BROADCAST);
        assert.equal(verifiedAt, "2026-09-02T00:00:02Z");
        return CONFIRMED;
      },
      createRecord(resultToRecord) {
        assert.equal(resultToRecord, CONFIRMED);
        return RECORD;
      },
      async wait(milliseconds) {
        assert.equal(milliseconds, 0);
      },
    },
  });

  assert.deepEqual(result, { status: "confirmed", record: RECORD });
  assert.deepEqual(JSON.parse(output), RECORD);
  assert.equal(refreshes, 1);
  assert.match(prompt, new RegExp(APPROVAL_FINGERPRINT));
  assert.doesNotMatch(prompt, /"rawTransaction":/);
});

test("rejects a mistyped fingerprint before broadcast authority is returned", async () => {
  const { runTbcTestnetAcceptanceCommand } = await import(
    "../../../scripts/run-testnet-acceptance.mjs"
  );
  let authorityReturned = 0;

  await assert.rejects(
    runTbcTestnetAcceptanceCommand({
      input: externalInput(),
      packageCommit: PACKAGE_COMMIT,
      broadcast: true,
      async readApproval() {
        return "00".repeat(32);
      },
      writeOutput() {},
      writeStatus() {},
      dependencies: {
        async runAcceptance(input) {
          await input.authorizeBroadcast(PREVIEW);
          authorityReturned += 1;
          return BROADCAST;
        },
      },
    }),
    (error) => error?.code === "AUTHORIZATION_MISMATCH",
  );
  assert.equal(authorityReturned, 0);
});

test("keeps an unconfirmed broadcast off stdout and out of result artifacts", async () => {
  const { runTbcTestnetAcceptanceCommand } = await import(
    "../../../scripts/run-testnet-acceptance.mjs"
  );
  let output = "";
  let status = "";

  const result = await runTbcTestnetAcceptanceCommand({
    input: externalInput(),
    packageCommit: PACKAGE_COMMIT,
    broadcast: true,
    confirmationAttempts: 0,
    async readApproval() {
      return APPROVAL_FINGERPRINT;
    },
    writeOutput(chunk) {
      output += chunk;
    },
    writeStatus(chunk) {
      status += chunk;
    },
    dependencies: {
      async runAcceptance(input) {
        await input.authorizeBroadcast(PREVIEW);
        return BROADCAST;
      },
    },
  });

  assert.deepEqual(result, { status: "broadcast", result: BROADCAST });
  assert.equal(output, "");
  assert.match(status, /"kind":"confirmation-pending"/);
  assert.doesNotMatch(status, /"rawTransaction":/);
});

test("parses only the documented adapter, broadcast, and confirmation flags", async () => {
  const { parseTbcTestnetAcceptanceArgs } = await import(
    "../../../scripts/run-testnet-acceptance.mjs"
  );

  assert.deepEqual(
    parseTbcTestnetAcceptanceArgs([
      "--adapter",
      "/outside/acceptance-adapter.mjs",
      "--broadcast",
      "--confirmation-attempts",
      "3",
      "--confirmation-interval-ms",
      "250",
    ]),
    {
      adapter: "/outside/acceptance-adapter.mjs",
      broadcast: true,
      confirmationAttempts: 3,
      confirmationIntervalMs: 250,
    },
  );
  assert.throws(
    () => parseTbcTestnetAcceptanceArgs([
      "--adapter",
      "/outside/acceptance-adapter.mjs",
      "--approval-fingerprint",
      APPROVAL_FINGERPRINT,
    ]),
    (error) => error?.code === "INVALID_INPUT",
  );
});

test("maps arbitrary external error codes to one credential-free failure code", async () => {
  const { testnetAcceptanceFailureCode } = await import(
    "../../../scripts/run-testnet-acceptance.mjs"
  );

  assert.equal(
    testnetAcceptanceFailureCode({ code: "PRIVATE_MATERIAL_MUST_NOT_PRINT" }),
    "TESTNET_ACCEPTANCE_FAILED",
  );
  assert.equal(
    testnetAcceptanceFailureCode({ code: "AUTHORIZATION_MISMATCH" }),
    "AUTHORIZATION_MISMATCH",
  );
});

test("loads an external adapter and binds the current repository commit", async () => {
  const { runTbcTestnetAcceptanceCli } = await import(
    "../../../scripts/run-testnet-acceptance.mjs"
  );
  const input = externalInput();
  let received;
  let cleanChecks = 0;

  const result = await runTbcTestnetAcceptanceCli({
    argv: ["--adapter", "/outside/acceptance-adapter.mjs"],
    repositoryRoot: "/repo",
    dependencies: {
      async loadAdapter(adapterPath) {
        assert.equal(adapterPath, "/outside/acceptance-adapter.mjs");
        return {
          async createTbcTestnetAcceptanceInput(tools) {
            assert.equal(tools.testnetApiOrigin, "https://api.tbcdev.org");
            assert.equal(typeof tools.createRestNodeAccess, "function");
            return input;
          },
        };
      },
      readPackageCommit(root) {
        assert.equal(root, "/repo");
        return PACKAGE_COMMIT;
      },
      assertCleanRepository(root) {
        assert.equal(root, "/repo");
        cleanChecks += 1;
      },
      async runCommand(options) {
        received = options;
        return { status: "dry-run", result: DRY_RUN };
      },
    },
  });

  assert.deepEqual(result, { status: "dry-run", result: DRY_RUN });
  assert.equal(received.input, input);
  assert.equal(received.packageCommit, PACKAGE_COMMIT);
  assert.equal(received.broadcast, false);
  assert.equal(received.confirmationAttempts, 12);
  assert.equal(received.confirmationIntervalMs, 5_000);
  assert.equal(cleanChecks, 2);
});

test("rejects in-repository adapters and adapter-returned authority fields", async () => {
  const { runTbcTestnetAcceptanceCli } = await import(
    "../../../scripts/run-testnet-acceptance.mjs"
  );
  let commands = 0;

  await assert.rejects(
    runTbcTestnetAcceptanceCli({
      argv: ["--adapter", "/repo/secrets.mjs"],
      repositoryRoot: "/repo",
      dependencies: {
        async loadAdapter() {
          throw new Error("must not load an in-repository adapter");
        },
      },
    }),
    (error) => error?.code === "INVALID_INPUT",
  );

  await assert.rejects(
    runTbcTestnetAcceptanceCli({
      argv: ["--adapter", "/outside/acceptance-adapter.mjs"],
      repositoryRoot: "/repo",
      dependencies: {
        async loadAdapter() {
          return {
            async createTbcTestnetAcceptanceInput() {
              return { ...externalInput(), authorizeBroadcast() {} };
            },
          };
        },
        readPackageCommit() {
          return PACKAGE_COMMIT;
        },
        assertCleanRepository() {},
        async runCommand() {
          commands += 1;
        },
      },
    }),
    (error) => error?.code === "INVALID_INPUT",
  );
  assert.equal(commands, 0);
});
