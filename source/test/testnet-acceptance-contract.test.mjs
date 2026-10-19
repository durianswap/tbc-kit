import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { repositoryRoot } from "../scripts/lib/repository.mjs";

const root = repositoryRoot(import.meta.url);

test("ships the credential-free record from the confirmed authorized testnet run", () => {
  const document = fs.readFileSync(
    path.join(root, "docs/testing/testnet-acceptance.md"),
    "utf8",
  );
  assert.match(document, /\*\*CONFIRMED — 真实广播已由官方 Testnet 节点确认。\*\*/);
  assert.match(document, /默认命令永远是 dry-run/);
  assert.match(document, /approvalFingerprint/);
  assert.match(document, /npm run testnet:acceptance -- --adapter/);
  assert.match(document, /--broadcast/);
  assert.match(document, /createTbcTestnetAcceptanceInput/);
  assert.match(document, /同一进程/);
  assert.match(document, /只有全部交易 confirmed/);
  assert.match(document, /不得加入 raw transaction、signature、secret、token/);

  const resultArtifacts = fs.readdirSync(path.join(root, "release"))
    .filter((name) => name.startsWith("testnet-acceptance-"));
  assert.deepEqual(resultArtifacts, ["testnet-acceptance-2026-09-02.json"]);
  const record = JSON.parse(fs.readFileSync(
    path.join(root, "release", resultArtifacts[0]),
    "utf8",
  ));
  assert.deepEqual(record, {
    schemaVersion: "1.0",
    status: "confirmed",
    // Historical evidence is immutable: this run predates readable Chain IDs.
    chainId: "tbc:0000000000cee779eb6a6c2ce087218a",
    sourceAddress: "18cq3AMvs3U9Y6dwtLbtqDTsn2iVcBL9mv",
    destinationAddress: "1ENQrm8PzZw2npimyUhufA5RnLJ7Ld4G8q",
    transactionIds: [
      "1da2cbe253f8339128c3a7daf14be182e9f12093753a21e7828b2403dbe08e10",
    ],
    packageCommit: "4b9ec93d645b4c299b63678b47cb75d2cbadcb79",
    preparedAt: "2026-09-01T19:41:26Z",
    verifiedAt: "2026-09-01T19:50:05Z",
  });
  assert.deepEqual(Object.keys(record), [
    "schemaVersion",
    "status",
    "chainId",
    "sourceAddress",
    "destinationAddress",
    "transactionIds",
    "packageCommit",
    "preparedAt",
    "verifiedAt",
  ]);
  assert.doesNotMatch(JSON.stringify(record), /rawTransaction|signature|secret|token/i);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(manifest.scripts["build:example:minimal"], /testnet-adapter\.ts/);
  assert.equal(
    manifest.scripts["testnet:acceptance"],
    "npm run build:example:minimal && node scripts/run-testnet-acceptance.mjs",
  );
});
