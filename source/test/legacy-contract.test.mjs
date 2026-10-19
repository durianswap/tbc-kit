import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cp, rm, writeFile } from "node:fs/promises";
import { repositoryRoot } from "../scripts/lib/repository.mjs";

const root = repositoryRoot(import.meta.url);

async function checker() {
  return import("../scripts/check-legacy-contract.mjs");
}

test("freezes one executable Legacy contract outside the five public packages", async () => {
  const { checkLegacyContract } = await checker();
  assert.deepEqual(checkLegacyContract(root), {
    version: "1.0.5",
    methods: 20,
    events: 4,
    baselineA: 15,
    baselineB: 11,
  });

  const baselineB = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        "contracts/legacy-window-turing/v1/vectors/baseline-b.json",
      ),
      "utf8",
    ),
  );
  const signMessage = baselineB.vectors.find(
    ({ id }) => id === "durian-sign-message-public-key-alias",
  );
  assert.equal(signMessage.expected.value.pubKey, signMessage.expected.value.pubkey);

  for (const packageName of [
    "core",
    "host",
    "provider",
    "tbc-engine",
    "wallet-standard",
  ]) {
    const manifest = fs.readFileSync(
      path.join(root, "packages", packageName, "package.json"),
      "utf8",
    );
    assert.doesNotMatch(manifest, /legacy-window-turing/u);
  }
});

test("rejects a platform that changes Legacy business failures to Promise rejection", async (context) => {
  const copyRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "tws-legacy-contract-"),
  );
  context.after(() => rm(copyRoot, { recursive: true, force: true }));
  await cp(
    path.join(root, "contracts"),
    path.join(copyRoot, "contracts"),
    { recursive: true },
  );
  const contractPath = path.join(
    copyRoot,
    "contracts/legacy-window-turing/v1/contract.json",
  );
  const contract = JSON.parse(await fs.promises.readFile(contractPath, "utf8"));
  contract.errors.businessFailureSettlement = "reject";
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

  const { checkLegacyContract } = await checker();
  assert.throws(
    () => checkLegacyContract(copyRoot, { verifyManifest: false }),
    /business failures must resolve/u,
  );
});

test("keeps every evidenced Baseline B scenario required", async (context) => {
  const copyRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "tws-legacy-baseline-b-"),
  );
  context.after(() => rm(copyRoot, { recursive: true, force: true }));
  await cp(
    path.join(root, "contracts"),
    path.join(copyRoot, "contracts"),
    { recursive: true },
  );
  const vectorsPath = path.join(
    copyRoot,
    "contracts/legacy-window-turing/v1/vectors/baseline-b.json",
  );
  const vectors = JSON.parse(await fs.promises.readFile(vectorsPath, "utf8"));
  vectors.vectors[0].required = false;
  await writeFile(vectorsPath, `${JSON.stringify(vectors, null, 2)}\n`);

  const { checkLegacyContract } = await checker();
  assert.throws(
    () => checkLegacyContract(copyRoot, { verifyManifest: false }),
    /Baseline B vectors must remain required/u,
  );
});
