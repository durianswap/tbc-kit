import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const manifestPath = path.join(
  repoRoot,
  "packages/tbc-engine/rust/provenance/upstream.json",
);
const sourceMapPath = path.join(
  repoRoot,
  "packages/tbc-engine/rust/provenance/source-map.json",
);
const signingTarget = "packages/tbc-engine/rust/crates/tbc-engine-core/src/signing.rs";
const sdkSourcePrefix = "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/";
const packageRoot = path.join(repoRoot, "packages/tbc-engine");
const sourceCommit = "923497e8b2473c0e179fa0b86dbb32a2f188d25a";

let sandboxRoot;
let pristinePackage;

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8" });
}

function runScript(testPackage, name, args = []) {
  return run(process.execPath, [path.join(testPackage, "scripts", name), ...args], testPackage);
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function digest(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function readJson(testPackage, relativePath) {
  return JSON.parse(await readFile(path.join(testPackage, relativePath), "utf8"));
}

async function writeJson(testPackage, relativePath, value) {
  await writeFile(path.join(testPackage, relativePath), canonicalJson(value));
}

async function replaceApprovedSigningText(testPackage, replacements) {
  const configPath = path.join(testPackage, "scripts/rust-provenance-config.mjs");
  const config = await readFile(configPath, "utf8");
  const marker = `target: "${signingTarget}"`;
  const signingStart = config.indexOf(marker);
  assert.notEqual(signingStart, -1, "approved signing map is required");
  let signing = config.slice(signingStart);
  for (const [from, to] of replacements) {
    assert.equal(signing.split(from).length - 1, 1, `expected one signing config value: ${from}`);
    signing = signing.replace(from, to);
  }
  await writeFile(configPath, `${config.slice(0, signingStart)}${signing}`);
}

async function newImportPackage(name) {
  const testPackage = path.join(sandboxRoot, name);
  await mkdir(testPackage, { recursive: true });
  await cp(path.join(packageRoot, "scripts"), path.join(testPackage, "scripts"), {
    recursive: true,
  });
  return testPackage;
}

async function newVerifiedPackage(name) {
  const testPackage = path.join(sandboxRoot, name);
  await cp(pristinePackage, testPackage, { recursive: true });
  return testPackage;
}

async function newGitRepository(name, files) {
  const repository = path.join(sandboxRoot, name);
  await mkdir(repository, { recursive: true });
  let result = run("git", ["init", "--quiet"], repository);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run("git", ["config", "user.email", "provenance-test@example.invalid"], repository);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run("git", ["config", "user.name", "Provenance Test"], repository);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(repository, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }
  result = run("git", ["add", "."], repository);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run("git", ["commit", "--quiet", "-m", "fixture"], repository);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run("git", ["rev-parse", "HEAD"], repository);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return { repository, commit: result.stdout.trim() };
}

async function classifyModified(testPackage, relativePath, reason) {
  const ledger = await readJson(testPackage, "rust/provenance/patch-ledger.json");
  ledger.push({
    path: relativePath,
    sha256: await digest(path.join(testPackage, "rust/vendor/tbc-sdk", relativePath)),
    status: "modified",
    reason,
  });
  await writeJson(testPackage, "rust/provenance/patch-ledger.json", ledger);
}

async function writeImplementedTarget(testPackage, name, targetSource) {
  const sourceMap = await readJson(testPackage, "rust/provenance/source-map.json");
  const mapping = sourceMap.find((entry) => entry.target.endsWith("/families/tbc.rs"));
  assert.ok(mapping, `${name} requires the known TBC source-map entry`);
  mapping.status = "implemented";
  await writeJson(testPackage, "rust/provenance/source-map.json", sourceMap);
  const targetPath = path.join(testPackage, mapping.target.replace("packages/tbc-engine/", ""));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, targetSource);
  return runScript(testPackage, "verify-rust-provenance.mjs");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test.before(async () => {
  sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "tbc-rust-provenance-"));
  pristinePackage = path.join(sandboxRoot, "pristine-package");
  await mkdir(pristinePackage, { recursive: true });
  await cp(path.join(packageRoot, "scripts"), path.join(pristinePackage, "scripts"), {
    recursive: true,
  });
  await cp(path.join(packageRoot, "rust"), path.join(pristinePackage, "rust"), {
    recursive: true,
    // Provenance checks source/ledgers, not multi-GB compiler caches. Copying
    // target into every negative fixture made this suite grow with local builds.
    filter: (source) => !path.relative(path.join(packageRoot, "rust"), source)
      .split(path.sep).some((part) => part === "target" || part === ".git"),
  });
});

test.after(async () => {
  await rm(sandboxRoot, { recursive: true, force: true });
});

test("vendored Rust SDK is complete and provenance-verified", async () => {
  const result = spawnSync(process.execPath, [
    "packages/tbc-engine/scripts/verify-rust-provenance.mjs",
  ], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.walletCommit, "923497e8b2473c0e179fa0b86dbb32a2f188d25a");
  assert.equal(manifest.crate.name, "tbc-sdk");
  assert.equal(manifest.crate.version, "0.3.0");
  assert.equal(manifest.crate.license, "MIT");
  assert.ok(manifest.files.length > 0);
  assert.ok(manifest.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)));

  const sourceMap = JSON.parse(await readFile(sourceMapPath, "utf8"));
  assert.ok(sourceMap.length > 0);
  assert.ok(sourceMap.every((entry) => entry.target && entry.sources.length > 0));
  assert.ok(sourceMap.every((entry) => ["planned", "implemented"].includes(entry.status)));
});

test("import rejects a source repository at the wrong commit", async () => {
  const source = await newGitRepository("wrong-commit-source", {
    "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/README.md": "fixture\n",
  });
  const testPackage = await newImportPackage("wrong-commit");
  const result = runScript(testPackage, "import-rust-sdk.mjs", ["--source", source.repository]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(sourceCommit));
});

test("Git-object reader ignores dirty and untracked checkout bytes", async () => {
  const source = await newGitRepository("git-object-source", {
    "snapshot/a.txt": "committed a\n",
    "snapshot/b.txt": "committed b\n",
  });
  await writeFile(path.join(source.repository, "snapshot/a.txt"), "dirty a\n");
  await writeFile(path.join(source.repository, "snapshot/untracked.txt"), "untracked\n");

  const { listGitTree, readGitObject } = await import(
    new URL("../scripts/git-object-reader.mjs", import.meta.url)
  );
  assert.deepEqual(
    listGitTree(source.repository, source.commit, "snapshot"),
    ["snapshot/a.txt", "snapshot/b.txt"],
  );
  assert.equal(
    readGitObject(source.repository, source.commit, "snapshot/a.txt").toString("utf8"),
    "committed a\n",
  );
});

test("import core successfully generates a snapshot from a supplied immutable policy", async () => {
  const license = "MIT License\n\nfixture license\n";
  const sdkSource = "pub fn sdk_fixture() {}\n";
  const wrapperFiles = {
    "wrappers/lib.rs": "pub fn source_lib() {}\n",
    "wrappers/asset_ancestry.rs": "pub fn source_ancestry() {}\n",
    "wrappers/funding.rs": "pub fn source_funding() {}\n",
    "wrappers/nft.rs": "pub fn source_nft() {}\n",
    "wrappers/pool_nft.rs": "pub fn source_pool() {}\n",
  };
  const cargo = [
    "[package]",
    'name = "fixture-sdk"',
    'version = "1.2.3"',
    'license = "MIT"',
    'repository = "https://example.invalid/fixture-sdk"',
    "",
  ].join("\n");
  const source = await newGitRepository("successful-import-source", {
    "sdk/Cargo.toml": cargo,
    "sdk/LICENSE": license,
    "sdk/src/lib.rs": sdkSource,
    ...wrapperFiles,
  });
  await writeFile(path.join(source.repository, "sdk/src/lib.rs"), "dirty checkout bytes\n");
  const mappedSources = Object.entries(wrapperFiles).map(([sourcePath, contents]) => ({
    repository: "fixture://wallet",
    commit: source.commit,
    path: sourcePath,
    sha256: createHash("sha256").update(contents).digest("hex"),
    sourceFunctions: [`source_${path.basename(sourcePath, ".rs").replace("asset_ancestry", "ancestry").replace("pool_nft", "pool")}`],
    targetFunctions: ["target_fixture"],
  }));
  const policy = deepFreeze({
    sourceCommit: source.commit,
    sourceRepository: "fixture://wallet",
    sourceSubtree: "sdk",
    sdk: {
      name: "fixture-sdk",
      version: "1.2.3",
      license: "MIT",
      repository: "https://example.invalid/fixture-sdk",
      licenseSha256: createHash("sha256").update(license).digest("hex"),
    },
    sourceMap: [{
      target: "packages/tbc-engine/rust/crates/tbc-engine-core/src/fixture.rs",
      status: "planned",
      sources: mappedSources,
    }],
  });
  const destination = path.join(sandboxRoot, "successful-import-destination");
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  const importer = await import(new URL("../scripts/import-rust-sdk.mjs?import-core-test", import.meta.url));
  process.exitCode = previousExitCode;
  assert.equal(typeof importer.importRustSdk, "function");
  await importer.importRustSdk({
    sourceRoot: source.repository,
    destinationPackageRoot: destination,
    policy,
  });

  assert.equal(await readFile(path.join(destination, "rust/vendor/tbc-sdk/src/lib.rs"), "utf8"), sdkSource);
  assert.equal(await readFile(path.join(destination, "rust/LICENSES/tbc-sdk-MIT.txt"), "utf8"), license);
  const upstream = await readJson(destination, "rust/provenance/upstream.json");
  assert.deepEqual(upstream, {
    repository: policy.sourceRepository,
    walletCommit: policy.sourceCommit,
    subtree: policy.sourceSubtree,
    crate: {
      name: policy.sdk.name,
      version: policy.sdk.version,
      license: policy.sdk.license,
      repository: policy.sdk.repository,
    },
    files: ["Cargo.toml", "LICENSE", "src/lib.rs"].map((relativePath) => ({
      path: relativePath,
      sha256: createHash("sha256").update({
        "Cargo.toml": cargo,
        "LICENSE": license,
        "src/lib.rs": sdkSource,
      }[relativePath]).digest("hex"),
      status: "unchanged",
    })),
  });
  assert.deepEqual(await readJson(destination, "rust/provenance/source-map.json"), policy.sourceMap);
  assert.deepEqual(await readJson(destination, "rust/provenance/patch-ledger.json"), []);
});

test("import is one-shot for vendor and every provenance manifest", async () => {
  const source = await newGitRepository("one-shot-source", {
    "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/README.md": "fixture\n",
  });
  const blockers = [
    "rust/vendor/tbc-sdk",
    "rust/provenance/upstream.json",
    "rust/provenance/source-map.json",
    "rust/provenance/patch-ledger.json",
  ];
  const statuses = [];
  const contents = [];

  for (const [index, blocker] of blockers.entries()) {
    const testPackage = await newImportPackage(`one-shot-${index}`);
    const blockerPath = path.join(testPackage, blocker);
    if (path.extname(blocker)) {
      await mkdir(path.dirname(blockerPath), { recursive: true });
      await writeFile(blockerPath, "sentinel\n");
    } else {
      await mkdir(blockerPath, { recursive: true });
      await writeFile(path.join(blockerPath, "SENTINEL"), "sentinel\n");
    }
    const before = path.extname(blocker)
      ? await readFile(blockerPath, "utf8")
      : await readFile(path.join(blockerPath, "SENTINEL"), "utf8");
    const result = runScript(testPackage, "import-rust-sdk.mjs", ["--source", source.repository]);
    statuses.push(result.status);
    const afterPath = path.extname(blocker) ? blockerPath : path.join(blockerPath, "SENTINEL");
    contents.push(await readFile(afterPath, "utf8").catch(() => null));
    assert.equal(before, "sentinel\n");
  }

  assert.deepEqual(statuses, [1, 1, 1, 1]);
  assert.deepEqual(contents, ["sentinel\n", "sentinel\n", "sentinel\n", "sentinel\n"]);
});

test("verification accepts classified modified and added vendor files", async () => {
  const testPackage = await newVerifiedPackage("patch-overlay");
  const vendorRoot = path.join(testPackage, "rust/vendor/tbc-sdk");
  await writeFile(path.join(vendorRoot, "README.md"), "reviewed local patch\n");
  await writeFile(path.join(vendorRoot, "LOCAL-NOTE.md"), "classified addition\n");
  const existingLedger = await readJson(testPackage, "rust/provenance/patch-ledger.json");
  await writeJson(testPackage, "rust/provenance/patch-ledger.json", [
    ...existingLedger.filter((entry) => !["README.md", "LOCAL-NOTE.md"].includes(entry.path)),
    {
      path: "README.md",
      sha256: await digest(path.join(vendorRoot, "README.md")),
      status: "modified",
      reason: "negative-test modified overlay",
    },
    {
      path: "LOCAL-NOTE.md",
      sha256: await digest(path.join(vendorRoot, "LOCAL-NOTE.md")),
      status: "added",
      reason: "negative-test added overlay",
    },
  ]);
  const sourceMap = await readJson(testPackage, "rust/provenance/source-map.json");
  await writeJson(testPackage, "rust/provenance/source-map.json", sourceMap);

  const result = runScript(testPackage, "verify-rust-provenance.mjs");
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("verification rejects approved implemented mappings downgraded to planned", async () => {
  const targets = [
    "packages/tbc-engine/rust/crates/tbc-engine-core/src/families/pool.rs",
    "packages/tbc-engine/rust/crates/tbc-engine-core/src/signing.rs",
  ];
  const statuses = [];

  for (const [index, target] of targets.entries()) {
    const testPackage = await newVerifiedPackage(`implemented-status-downgrade-${index}`);
    const sourceMap = await readJson(testPackage, "rust/provenance/source-map.json");
    const mapping = sourceMap.find((entry) => entry.target === target);
    assert.ok(mapping, `missing exact provenance mapping for ${target}`);
    assert.equal(mapping.status, "implemented");
    mapping.status = "planned";
    await writeJson(testPackage, "rust/provenance/source-map.json", sourceMap);

    const result = runScript(testPackage, "verify-rust-provenance.mjs");
    statuses.push(result.status);
  }

  assert.deepEqual(statuses, [1, 1]);
});

test("planned downgrade cannot bypass exact target declaration validation", async () => {
  const testPackage = await newVerifiedPackage("planned-downgrade-deleted-target");
  const sourceMap = await readJson(testPackage, "rust/provenance/source-map.json");
  const mapping = sourceMap.find(
    (entry) => entry.target === "packages/tbc-engine/rust/crates/tbc-engine-core/src/signing.rs",
  );
  assert.ok(mapping, "exact signing provenance mapping is required");
  assert.equal(mapping.status, "implemented");
  mapping.status = "planned";
  await writeJson(testPackage, "rust/provenance/source-map.json", sourceMap);
  await rm(path.join(testPackage, mapping.target.replace("packages/tbc-engine/", "")));

  const result = runScript(testPackage, "verify-rust-provenance.mjs");
  assert.notEqual(result.status, 0);
});

test("source-derived and Engine-specific overlap is rejected after synchronized downgrade", async () => {
  const testPackage = await newVerifiedPackage("planned-downgrade-source-overlap");
  const sourceMap = await readJson(testPackage, "rust/provenance/source-map.json");
  const mapping = sourceMap.find(
    (entry) => entry.target === "packages/tbc-engine/rust/crates/tbc-engine-core/src/signing.rs",
  );
  assert.ok(mapping, "exact signing provenance mapping is required");
  assert.equal(mapping.status, "implemented");
  assert.ok(mapping.sources.some((source) => source.targetFunctions.includes("pool_authority_binding")));
  assert.ok(!mapping.engineSpecificFunctions.includes("pool_authority_binding"));
  mapping.status = "planned";
  mapping.engineSpecificFunctions.push("pool_authority_binding");
  await writeJson(testPackage, "rust/provenance/source-map.json", sourceMap);
  await replaceApprovedSigningText(testPackage, [
    ['status: "implemented"', 'status: "planned"'],
    [
      '"validate_ftlp_recipe_order",',
      '"validate_ftlp_recipe_order",\n        "pool_authority_binding",',
    ],
  ]);

  const result = runScript(testPackage, "verify-rust-provenance.mjs");
  assert.notEqual(result.status, 0);
});

test("verification rejects implemented status when the target is absent", async () => {
  const testPackage = await newVerifiedPackage("implemented-target-absent");
  const sourceMap = await readJson(testPackage, "rust/provenance/source-map.json");
  const mapping = sourceMap.find((entry) => entry.target.endsWith("/families/tbc.rs"));
  assert.ok(mapping, "known implemented TBC mapping is required");
  mapping.status = "implemented";
  await writeJson(testPackage, "rust/provenance/source-map.json", sourceMap);
  await rm(path.join(testPackage, mapping.target.replace("packages/tbc-engine/", "")));

  const result = runScript(testPackage, "verify-rust-provenance.mjs");
  assert.notEqual(result.status, 0);
});

test("verification rejects implemented status when an exact target symbol is missing", async () => {
  const testPackage = await newVerifiedPackage("implemented-symbol-missing");
  const sourceMap = await readJson(testPackage, "rust/provenance/source-map.json");
  const mapping = sourceMap.find((entry) => entry.target.endsWith("/families/tbc.rs"));
  assert.ok(mapping, "known implemented TBC mapping is required");
  mapping.status = "implemented";
  await writeJson(testPackage, "rust/provenance/source-map.json", sourceMap);
  const targetPath = path.join(testPackage, mapping.target.replace("packages/tbc-engine/", ""));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, "pub(crate) fn plan_tbc_transfer() {}\n");

  const result = runScript(testPackage, "verify-rust-provenance.mjs");
  assert.notEqual(result.status, 0);
});

test("verification accepts implemented status with every exact target symbol", async () => {
  const testPackage = await newVerifiedPackage("implemented-target-matching");
  const sourceMap = await readJson(testPackage, "rust/provenance/source-map.json");
  const mapping = sourceMap.find((entry) => entry.target.endsWith("/families/tbc.rs"));
  assert.ok(mapping, "known implemented TBC mapping is required");
  mapping.status = "implemented";
  await writeJson(testPackage, "rust/provenance/source-map.json", sourceMap);
  const targetPath = path.join(testPackage, mapping.target.replace("packages/tbc-engine/", ""));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(
    targetPath,
    "pub(crate) fn plan_tbc_transfer() {}\npub(crate) fn validate_tbc_transfer() {}\n",
  );

  const result = runScript(testPackage, "verify-rust-provenance.mjs");
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("verification ignores declaration-shaped text outside Rust code", async () => {
  const falseTargets = [
    [
      "nested-block-comment",
      "/*\npub(crate) fn plan_tbc_transfer() {}\n/* nested */\npub(crate) fn validate_tbc_transfer() {}\n*/\n",
    ],
    [
      "line-comments",
      "// pub(crate) fn plan_tbc_transfer() {}\n// pub(crate) fn validate_tbc_transfer() {}\n",
    ],
    [
      "ordinary-multiline-string",
      "const TEXT: &str = \"\npub(crate) fn plan_tbc_transfer() {}\npub(crate) fn validate_tbc_transfer() {}\n\";\n",
    ],
    [
      "raw-multiline-string",
      "const TEXT: &str = r###\"\npub(crate) fn plan_tbc_transfer() {}\npub(crate) fn validate_tbc_transfer() {}\n\"###;\n",
    ],
    [
      "mixed-string-comment",
      "const TEXT: &str = \"pub(crate) fn plan_tbc_transfer() {}\";\n/* pub(crate) fn validate_tbc_transfer() {} */\n",
    ],
  ];
  const statuses = [];
  for (const [index, [name, targetSource]] of falseTargets.entries()) {
    const testPackage = await newVerifiedPackage(`implemented-false-positive-${index}-${name}`);
    statuses.push((await writeImplementedTarget(testPackage, name, targetSource)).status);
  }

  assert.deepEqual(statuses, [1, 1, 1, 1, 1]);
});

test("Pool provenance maps the split released FTLP selection responsibilities", async () => {
  const sourceMap = JSON.parse(await readFile(sourceMapPath, "utf8"));
  const mapping = sourceMap.find((entry) => entry.target.endsWith("/families/pool.rs"));
  assert.ok(mapping, "implemented Pool source-map entry is required");
  const builder = mapping.sources.find((source) => source.path.endsWith("/pool_nft_v2/builder.rs"));
  assert.ok(builder, "pinned Pool builder source is required");
  assert.ok(builder.targetFunctions.includes("select_ftlp"));
  assert.ok(builder.targetFunctions.includes("plan_ftlp_input"));
  assert.ok(builder.targetFunctions.includes("build_ftlp_maintenance"));
  assert.ok(!builder.targetFunctions.includes("select_ftlp_merge"));
});

test("Signing provenance classifies every reopened Task 7B helper", async () => {
  const sourceMap = JSON.parse(await readFile(sourceMapPath, "utf8"));
  const mapping = sourceMap.find((entry) => entry.target === signingTarget);
  assert.ok(mapping, "implemented signing source-map entry is required");

  const sourceDerived = [
    [
      "src/address.rs",
      ["Address::from_hash160"],
      ["authenticate_released_ftlp_code"],
    ],
    [
      "src/hash.rs",
      ["sha256", "hash160"],
      ["pool_authority_binding"],
    ],
    [
      "src/keys.rs",
      ["PublicKey::hash160"],
      ["authenticate_released_ftlp_code", "validate_ftlp_maintenance_topology"],
    ],
    [
      "src/script.rs",
      ["Script::as_bytes", "Script::p2pkh", "Script::sha256"],
      [
        "pool_authority_binding",
        "authenticate_released_ftlp_code",
        "validate_ftlp_maintenance_topology",
      ],
    ],
    [
      "src/transaction.rs",
      ["Transaction::txid"],
      ["resolve_ftlp_code_tape", "pool_authority_binding", "validate_pool_held_ft_proofs"],
    ],
    [
      "src/contracts/ft/amount.rs",
      ["build_tape_amount", "balance_from_tape"],
      ["resolve_ftlp_code_tape", "pool_authority_binding", "validate_ftlp_maintenance_topology"],
    ],
    [
      "src/contracts/ft/partial_sha256.rs",
      ["calculate_partial_hash"],
      ["pool_authority_binding", "authenticate_released_ftlp_code"],
    ],
    [
      "src/contracts/ft/scripts.rs",
      ["transfer_tape_script"],
      ["validate_ftlp_maintenance_topology"],
    ],
    [
      "src/contracts/ft/unlock.rs",
      [
        "classify_ft_script",
        "pre_pre_tx_data",
        "pre_pre_tx_data_from_parents",
        "pre_tx_data",
        "ft_pre_pre_source_indexes",
      ],
      [
        "resolve_source",
        "validate_evidence_table",
        "finalize_signing_stage",
        "pool_authority_binding",
        "tape_source_indexes",
        "validate_exact_recipe_proof_pairs",
        "resolve_recipe_parent_and_proofs",
        "validate_pool_held_ft_proofs",
        "validate_planned_ftlp_proofs",
        "validate_ftlp_maintenance_proofs",
      ],
    ],
    [
      "src/contracts/pool_nft_v2/data.rs",
      ["PoolState::from_v2_tape"],
      ["pool_authority_binding"],
    ],
    [
      "src/contracts/pool_nft_v2/builder.rs",
      [
        "PoolNftV2::for_create",
        "PoolNftV2::merge_ftlp",
        "ftlp_lock_time_from_tape",
        "sign_ftlp_input",
        "build_ftlp_unlock",
      ],
      [
        "pool_authority_binding",
        "ftlp_unlock_prefix",
        "ftlp_unlock_suffix",
        "validate_ftlp_lock",
        "validate_ftlp_maintenance_topology",
      ],
    ],
    [
      "src/contracts/pool_nft_v2/scripts.rs",
      [
        "FtlpCodeParams::for_tape",
        "pool_held_ft_code",
        "ftlp_code",
        "ftlp_lock_time_code",
        "ftlp_tape",
      ],
      [
        "pool_authority_binding",
        "authenticate_released_ftlp_code",
        "validate_ftlp_maintenance_topology",
      ],
    ],
    [
      "src/contracts/pool_nft_v2/unlock.rs",
      ["pool_outputs_data", "pool_unlock_requires_signature", "pool_unlock"],
      [
        "input_requires_external_signature",
        "pool_unlock_script",
        "pool_authority_binding",
        "validate_ftlp_maintenance_topology",
      ],
    ],
  ];
  for (const [relativePath, sourceFunctions, targetFunctions] of sourceDerived) {
    const exactPath = `${sdkSourcePrefix}${relativePath}`;
    const source = mapping.sources.find((candidate) => candidate.path === exactPath);
    assert.ok(source, `exact pinned signing source is required: ${exactPath}`);
    assert.equal(source.verification, "authenticated-vendor");
    assert.deepEqual(source.sourceFunctions, sourceFunctions);
    assert.deepEqual(source.targetFunctions, targetFunctions);
  }

  const engineSpecificFunctions = [
    "ftlp_maintenance_round",
    "resolve_source_for_plan_validation",
    "ft_script_version",
    "validate_final_pool_consumes",
    "final_ftlp_successor_id",
    "planned_source_identity_and_output",
    "validate_ftlp_recipe_order",
  ];
  assert.deepEqual(mapping.engineSpecificFunctions, engineSpecificFunctions);

  const { APPROVED_SOURCE_MAP } = await import("../scripts/rust-provenance-config.mjs");
  const approved = APPROVED_SOURCE_MAP.find((entry) => entry.target === mapping.target);
  assert.ok(approved, "approved signing source-map mirror is required");
  assert.deepEqual(approved.engineSpecificFunctions, engineSpecificFunctions);

  const classified = new Set([
    ...mapping.sources.flatMap((source) => source.targetFunctions),
    ...mapping.engineSpecificFunctions,
  ]);
  const reopenedHelpers = [
    "ftlp_maintenance_round",
    "resolve_ftlp_code_tape",
    "resolve_source_for_plan_validation",
    "ft_script_version",
    "pool_authority_binding",
    "tape_source_indexes",
    "validate_exact_recipe_proof_pairs",
    "resolve_recipe_parent_and_proofs",
    "validate_pool_held_ft_proofs",
    "validate_final_pool_consumes",
    "final_ftlp_successor_id",
    "authenticate_released_ftlp_code",
    "planned_source_identity_and_output",
    "validate_planned_ftlp_proofs",
    "validate_ftlp_maintenance_proofs",
    "validate_ftlp_maintenance_topology",
    "validate_ftlp_recipe_order",
  ];
  for (const targetFunction of reopenedHelpers) {
    assert.ok(classified.has(targetFunction), `${targetFunction} must be classified`);
  }
});

test("verification rejects an unqualified associated SDK source symbol", async () => {
  const testPackage = await newVerifiedPackage("signing-source-unqualified");
  const sourceMap = await readJson(testPackage, "rust/provenance/source-map.json");
  const mapping = sourceMap.find((entry) => entry.target === signingTarget);
  const builderPath = `${sdkSourcePrefix}src/contracts/pool_nft_v2/builder.rs`;
  const builder = mapping.sources.find((source) => source.path === builderPath);
  assert.ok(builder, "exact Pool builder source is required");
  const qualified = builder.sourceFunctions.find((symbol) => symbol.endsWith("::merge_ftlp"));
  const original = qualified ?? "merge_ftlp";
  builder.sourceFunctions[builder.sourceFunctions.indexOf(original)] = "merge_ftlp";
  await writeJson(testPackage, "rust/provenance/source-map.json", sourceMap);
  if (qualified) {
    await replaceApprovedSigningText(testPackage, [[`"${qualified}"`, '"merge_ftlp"']]);
  }

  const result = runScript(testPackage, "verify-rust-provenance.mjs");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /associated source function must be qualified: .*builder\.rs#merge_ftlp/);
});

test("verification rejects a stale approved SDK source symbol", async () => {
  const testPackage = await newVerifiedPackage("signing-source-stale");
  const sourceMap = await readJson(testPackage, "rust/provenance/source-map.json");
  const mapping = sourceMap.find((entry) => entry.target === signingTarget);
  const builderPath = `${sdkSourcePrefix}src/contracts/pool_nft_v2/builder.rs`;
  const builder = mapping.sources.find((source) => source.path === builderPath);
  assert.ok(builder, "exact Pool builder source is required");
  const original = builder.sourceFunctions.find((symbol) => symbol.endsWith("merge_ftlp"));
  assert.ok(original, "merge_ftlp source symbol is required");
  const missing = "PoolNftV2::missing_merge_ftlp";
  builder.sourceFunctions[builder.sourceFunctions.indexOf(original)] = missing;
  await writeJson(testPackage, "rust/provenance/source-map.json", sourceMap);
  await replaceApprovedSigningText(testPackage, [[`"${original}"`, `"${missing}"`]]);

  const result = runScript(testPackage, "verify-rust-provenance.mjs");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source function is absent: .*builder\.rs#PoolNftV2::missing_merge_ftlp/);
});

test("verification rejects an SDK source symbol mapped to the wrong exact path", async () => {
  const testPackage = await newVerifiedPackage("signing-source-wrong-path");
  const sourceMap = await readJson(testPackage, "rust/provenance/source-map.json");
  const mapping = sourceMap.find((entry) => entry.target === signingTarget);
  const builderPath = `${sdkSourcePrefix}src/contracts/pool_nft_v2/builder.rs`;
  const amountPath = `${sdkSourcePrefix}src/contracts/ft/amount.rs`;
  const builder = mapping.sources.find((source) => source.path === builderPath);
  const amount = mapping.sources.find((source) => source.path === amountPath);
  assert.ok(builder && amount, "exact Pool builder and FT amount sources are required");
  const oldHash = builder.sha256;
  builder.path = amountPath;
  builder.sha256 = amount.sha256;
  await writeJson(testPackage, "rust/provenance/source-map.json", sourceMap);
  await replaceApprovedSigningText(testPackage, [
    [`"${builderPath}"`, `"${amountPath}"`],
    [`"${oldHash}"`, `"${amount.sha256}"`],
  ]);

  const result = runScript(testPackage, "verify-rust-provenance.mjs");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source function is absent: .*amount\.rs#PoolNftV2::/);
});

test("verification rejects declaration-shaped SDK source decoys", async () => {
  const testPackage = await newVerifiedPackage("signing-source-decoy");
  const sourceMap = await readJson(testPackage, "rust/provenance/source-map.json");
  const mapping = sourceMap.find((entry) => entry.target === signingTarget);
  const sourcePath = "src/contracts/pool_nft_v2/builder.rs";
  const mappedPath = `${sdkSourcePrefix}${sourcePath}`;
  const builder = mapping.sources.find((source) => source.path === mappedPath);
  assert.ok(builder, "exact Pool builder source is required");
  const builderFile = path.join(testPackage, "rust/vendor/tbc-sdk", sourcePath);
  const source = await readFile(builderFile, "utf8");
  const declaration = "    pub fn merge_ftlp(";
  assert.equal(source.split(declaration).length - 1, 1, "one real merge_ftlp declaration is required");
  await writeFile(
    builderFile,
    `${source.replace(declaration, "    pub fn merge_ftlp_renamed(")}\nconst SOURCE_DECOY: &str = "pub fn merge_ftlp() {}";\n`,
  );
  const mutatedHash = await digest(builderFile);
  const oldHash = builder.sha256;
  builder.sha256 = mutatedHash;
  await writeJson(testPackage, "rust/provenance/source-map.json", sourceMap);
  await replaceApprovedSigningText(testPackage, [[`"${oldHash}"`, `"${mutatedHash}"`]]);
  const ledger = await readJson(testPackage, "rust/provenance/patch-ledger.json");
  const entry = ledger.find((candidate) => candidate.path === sourcePath);
  assert.ok(entry, "classified Pool builder patch is required");
  entry.sha256 = mutatedHash;
  await writeJson(testPackage, "rust/provenance/patch-ledger.json", ledger);

  const result = runScript(testPackage, "verify-rust-provenance.mjs");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source function is absent: .*builder\.rs#.*merge_ftlp/);
});

test("verification rejects a missing Task 7B signing provenance target", async () => {
  const testPackage = await newVerifiedPackage("signing-target-missing");
  const sourceMap = await readJson(testPackage, "rust/provenance/source-map.json");
  const mapping = sourceMap.find((entry) => entry.target.endsWith("/signing.rs"));
  assert.ok(mapping, "implemented signing source-map entry is required");
  const unlock = mapping.sources.find((source) => source.path.endsWith("/pool_nft_v2/unlock.rs"));
  assert.ok(unlock?.targetFunctions.includes("pool_authority_binding"));
  unlock.targetFunctions = unlock.targetFunctions.filter(
    (targetFunction) => targetFunction !== "pool_authority_binding",
  );
  await writeJson(testPackage, "rust/provenance/source-map.json", sourceMap);

  const result = runScript(testPackage, "verify-rust-provenance.mjs");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the approved pinned source object and functions/);
});

test("verification rejects renamed Task 7B signing security targets", async () => {
  const targets = [
    "validate_final_pool_consumes",
    "validate_exact_recipe_proof_pairs",
    "validate_pool_held_ft_proofs",
    "validate_ftlp_maintenance_topology",
  ];
  const statuses = [];
  for (const targetFunction of targets) {
    const testPackage = await newVerifiedPackage(`signing-target-renamed-${targetFunction}`);
    const sourceMap = await readJson(testPackage, "rust/provenance/source-map.json");
    const mapping = sourceMap.find((entry) => entry.target.endsWith("/signing.rs"));
    assert.ok(mapping, "implemented signing source-map entry is required");
    const targetPath = path.join(testPackage, mapping.target.replace("packages/tbc-engine/", ""));
    const targetSource = await readFile(targetPath, "utf8");
    const declaration = `fn ${targetFunction}(`;
    assert.equal(targetSource.split(declaration).length - 1, 1, "expected one real target declaration");
    await writeFile(targetPath, targetSource.replace(declaration, `fn ${targetFunction}_renamed(`));
    const result = runScript(testPackage, "verify-rust-provenance.mjs");
    statuses.push(result.status);
    assert.match(
      result.stderr,
      new RegExp(`implemented target function is absent: .*signing\\.rs#${targetFunction}`),
    );
  }
  assert.deepEqual(statuses, [1, 1, 1, 1]);
});

test("verification rejects declaration decoys for Task 7B covenant authentication", async () => {
  const targets = ["authenticate_released_ftlp_code", "validate_ftlp_maintenance_topology"];
  const statuses = [];
  for (const targetFunction of targets) {
    const testPackage = await newVerifiedPackage(`signing-target-decoy-${targetFunction}`);
    const sourceMap = await readJson(testPackage, "rust/provenance/source-map.json");
    const mapping = sourceMap.find((entry) => entry.target.endsWith("/signing.rs"));
    assert.ok(mapping, "implemented signing source-map entry is required");
    const targetPath = path.join(testPackage, mapping.target.replace("packages/tbc-engine/", ""));
    const targetSource = await readFile(targetPath, "utf8");
    const declaration = `fn ${targetFunction}(`;
    assert.equal(targetSource.split(declaration).length - 1, 1, "expected one real target declaration");
    await writeFile(
      targetPath,
      `${targetSource.replace(declaration, `fn ${targetFunction}_renamed(`)}\nconst SIGNING_TARGET_DECOY: &str = "fn ${targetFunction}() {}";\n`,
    );
    const result = runScript(testPackage, "verify-rust-provenance.mjs");
    statuses.push(result.status);
    assert.match(
      result.stderr,
      new RegExp(`implemented target function is absent: .*signing\\.rs#${targetFunction}`),
    );
  }
  assert.deepEqual(statuses, [1, 1]);
});

test("verification rejects a renamed split Pool FTLP target symbol", async () => {
  const testPackage = await newVerifiedPackage("pool-ftlp-target-renamed");
  const sourceMap = await readJson(testPackage, "rust/provenance/source-map.json");
  const mapping = sourceMap.find((entry) => entry.target.endsWith("/families/pool.rs"));
  assert.ok(mapping, "implemented Pool source-map entry is required");
  const builder = mapping.sources.find((source) => source.path.endsWith("/pool_nft_v2/builder.rs"));
  assert.ok(builder?.targetFunctions.includes("plan_ftlp_input"));
  const targetPath = path.join(testPackage, mapping.target.replace("packages/tbc-engine/", ""));
  const targetSource = await readFile(targetPath, "utf8");
  const declaration = "fn plan_ftlp_input(";
  assert.equal(targetSource.split(declaration).length - 1, 1, "expected one real target declaration");
  await writeFile(targetPath, targetSource.replace(declaration, "fn plan_ftlp_input_renamed("));

  const result = runScript(testPackage, "verify-rust-provenance.mjs");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /implemented target function is absent: .*pool\.rs#plan_ftlp_input/);
});

test("verification rejects a declaration-shaped decoy for split Pool FTLP selection", async () => {
  const testPackage = await newVerifiedPackage("pool-ftlp-target-decoy");
  const sourceMap = await readJson(testPackage, "rust/provenance/source-map.json");
  const mapping = sourceMap.find((entry) => entry.target.endsWith("/families/pool.rs"));
  assert.ok(mapping, "implemented Pool source-map entry is required");
  const builder = mapping.sources.find((source) => source.path.endsWith("/pool_nft_v2/builder.rs"));
  assert.ok(builder?.targetFunctions.includes("plan_ftlp_input"));
  const targetPath = path.join(testPackage, mapping.target.replace("packages/tbc-engine/", ""));
  const targetSource = await readFile(targetPath, "utf8");
  const declaration = "fn plan_ftlp_input(";
  assert.equal(targetSource.split(declaration).length - 1, 1, "expected one real target declaration");
  await writeFile(
    targetPath,
    `${targetSource.replace(declaration, "fn plan_ftlp_input_renamed(")}\nconst PLAN_FTLP_INPUT_DECOY: &str = \"fn plan_ftlp_input() {}\";\n`,
  );

  const result = runScript(testPackage, "verify-rust-provenance.mjs");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /implemented target function is absent: .*pool\.rs#plan_ftlp_input/);
});

test("verification rejects absolute and escaping manifest paths", async () => {
  const invalidPaths = ["/tmp/absolute.rs", "../escaping.rs"];
  const statuses = [];

  for (const [index, invalidPath] of invalidPaths.entries()) {
    const testPackage = await newVerifiedPackage(`invalid-path-${index}`);
    await writeJson(testPackage, "rust/provenance/patch-ledger.json", [{
      path: invalidPath,
      sha256: "0".repeat(64),
      status: "added",
      reason: "negative-test invalid path",
    }]);
    statuses.push(runScript(testPackage, "verify-rust-provenance.mjs").status);
  }

  assert.deepEqual(statuses, [1, 1]);
});

test("verification rejects missing, unclassified, and digest-mismatched files", async () => {
  const statuses = [];

  const missing = await newVerifiedPackage("missing-file");
  await rm(path.join(missing, "rust/vendor/tbc-sdk/README.md"));
  statuses.push(runScript(missing, "verify-rust-provenance.mjs").status);

  const unclassified = await newVerifiedPackage("unclassified-file");
  await writeFile(path.join(unclassified, "rust/vendor/tbc-sdk/UNCLASSIFIED"), "extra\n");
  statuses.push(runScript(unclassified, "verify-rust-provenance.mjs").status);

  const mismatched = await newVerifiedPackage("digest-mismatch");
  await writeFile(path.join(mismatched, "rust/vendor/tbc-sdk/README.md"), "drift\n");
  statuses.push(runScript(mismatched, "verify-rust-provenance.mjs").status);

  assert.deepEqual(statuses, [1, 1, 1]);
});

test("verification rejects malformed and false source maps", async () => {
  const statuses = [];
  const malformed = await newVerifiedPackage("source-map-malformed");
  await writeJson(malformed, "rust/provenance/source-map.json", { mappings: [] });
  statuses.push(runScript(malformed, "verify-rust-provenance.mjs").status);

  const mutations = [
    (mapping) => { mapping.target = "packages/tbc-engine/rust/crates/tbc-engine-core/src/false.rs"; },
    (mapping) => { mapping.sources[0].path = "modules/tbc-transaction-engine/rust/src/false.rs"; },
    (mapping) => { mapping.sources[0].sha256 = "0".repeat(64); },
    (mapping) => { mapping.sources[0].sourceFunctions = ["not_a_source_function"]; },
    (mapping) => { mapping.status = "reviewed"; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const testPackage = await newVerifiedPackage(`source-map-false-${index}`);
    const sourceMap = await readJson(testPackage, "rust/provenance/source-map.json");
    const mapping = sourceMap.find((entry) => entry.target.endsWith("/families/tbc.rs"));
    assert.ok(mapping, "negative source-map test requires the stable TBC entry");
    mapping.status = "planned";
    mutate(mapping);
    await writeJson(testPackage, "rust/provenance/source-map.json", sourceMap);
    statuses.push(runScript(testPackage, "verify-rust-provenance.mjs").status);
  }

  assert.deepEqual(statuses, [1, 1, 1, 1, 1, 1]);
});

test("verification derives exact crate identity from vendored Cargo.toml", async () => {
  const replacements = [
    ['name = "tbc-sdk"', 'name = "false-sdk"'],
    ['version = "0.3.0"', 'version = "9.9.9"'],
    ['license = "MIT"', 'license = "Apache-2.0"'],
    ['repository = "https://github.com/LoongYearMeta/tbc-rust-sdk"', 'repository = "https://example.com/false-sdk"'],
  ];
  const statuses = [];

  for (const [index, [from, to]] of replacements.entries()) {
    const testPackage = await newVerifiedPackage(`cargo-identity-${index}`);
    const cargoPath = path.join(testPackage, "rust/vendor/tbc-sdk/Cargo.toml");
    const original = await readFile(cargoPath, "utf8");
    const changed = original.replace(from, to);
    assert.notEqual(changed, original);
    await writeFile(cargoPath, changed);
    await classifyModified(testPackage, "Cargo.toml", "negative-test Cargo identity drift");
    statuses.push(runScript(testPackage, "verify-rust-provenance.mjs").status);
  }

  assert.deepEqual(statuses, [1, 1, 1, 1]);
});

test("verification enforces exact upstream metadata", async () => {
  const mutations = [
    (upstream) => { upstream.repository = "git@example.com:false/repository.git"; },
    (upstream) => { upstream.subtree = "false/subtree"; },
    (upstream) => { upstream.crate.repository = "https://example.com/false-sdk"; },
    (upstream) => { upstream.crate.name = "false-sdk"; },
    (upstream) => { upstream.crate.version = "9.9.9"; },
    (upstream) => { upstream.crate.license = "Apache-2.0"; },
  ];
  const statuses = [];

  for (const [index, mutate] of mutations.entries()) {
    const testPackage = await newVerifiedPackage(`metadata-drift-${index}`);
    const upstream = await readJson(testPackage, "rust/provenance/upstream.json");
    mutate(upstream);
    await writeJson(testPackage, "rust/provenance/upstream.json", upstream);
    statuses.push(runScript(testPackage, "verify-rust-provenance.mjs").status);
  }

  assert.deepEqual(statuses, [1, 1, 1, 1, 1, 1]);
});

test("verification rejects license drift even when it is classified", async () => {
  const testPackage = await newVerifiedPackage("license-drift");
  const driftedLicense = "MIT License\n\nfalse replacement\n";
  await writeFile(path.join(testPackage, "rust/vendor/tbc-sdk/LICENSE"), driftedLicense);
  await writeFile(path.join(testPackage, "rust/LICENSES/tbc-sdk-MIT.txt"), driftedLicense);
  await classifyModified(testPackage, "LICENSE", "negative-test classified license drift");

  const result = runScript(testPackage, "verify-rust-provenance.mjs");
  assert.notEqual(result.status, 0);
});
