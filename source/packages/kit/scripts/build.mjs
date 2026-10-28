import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildKitRuntime } from "./runtime-build.mjs";
import { omitEmbeddedSources } from "./source-map-policy.mjs";
import { stripWasmNameSection } from "./wasm-metadata.mjs";
import { closePortableParserDependencies } from "./portable-parser-dependencies.mjs";
import { patchContract173Parser } from "./contract173-parser-patch.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageRoot = resolve(root, "packages/kit");
execFileSync(process.execPath, [resolve(root, "scripts/check-kit-source-state.mjs"), "--begin-build"], { stdio: "inherit" });
const internalCoreTypes = resolve(packageRoot, "dist/types/internal/core");
await rm(internalCoreTypes, { recursive: true, force: true });
await cp(
  resolve(root, "packages/core/dist/types"),
  internalCoreTypes,
  {
    recursive: true,
    filter: (source) => !source.endsWith(".map"),
  },
);

const internalHostTypes = resolve(packageRoot, "dist/types/internal/host");
await rm(internalHostTypes, { recursive: true, force: true });
await cp(
  resolve(root, "packages/host/dist/types"),
  internalHostTypes,
  {
    recursive: true,
    filter: (source) => !source.endsWith(".map"),
  },
);

let rewrittenHostCoreImports = 0;
for (const entry of await readdir(internalHostTypes, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".d.ts")) continue;
  const path = resolve(internalHostTypes, entry.name);
  const declaration = await readFile(path, "utf8");
  const rewritten = declaration.replaceAll(
    '"@tbc-wallet/core"',
    '"../core/index.js"',
  );
  if (rewritten !== declaration) {
    rewrittenHostCoreImports += 1;
    await writeFile(path, rewritten);
  }
}
if (rewrittenHostCoreImports !== 4) {
  throw new Error(
    `Expected four Host declarations to bind bundled Core, rewrote ${rewrittenHostCoreImports}`,
  );
}

const internalProviderTypes = resolve(
  packageRoot,
  "dist/types/internal/provider",
);
await rm(internalProviderTypes, { recursive: true, force: true });
await cp(
  resolve(root, "packages/provider/dist/types"),
  internalProviderTypes,
  {
    recursive: true,
    filter: (source) => !source.endsWith(".map"),
  },
);

const providerTransportTypes = resolve(
  packageRoot,
  "dist/types/provider-transport.d.ts",
);
const providerTransportDeclaration = await readFile(
  providerTransportTypes,
  "utf8",
);
const selfContainedProviderTransportDeclaration =
  providerTransportDeclaration.replaceAll(
    '"@tbc-wallet/provider"',
    '"./internal/provider/index.js"',
  );
if (
  selfContainedProviderTransportDeclaration === providerTransportDeclaration
) {
  throw new Error("Kit Provider declaration closure was not rewritten");
}
await writeFile(
  providerTransportTypes,
  selfContainedProviderTransportDeclaration,
);

const declarationRewrites = [
  ["approved-host-task.d.ts", '"@tbc-wallet/core"', '"./internal/core/index.js"'],
  ["core-runtime.d.ts", '"@tbc-wallet/core"', '"./internal/core/index.js"'],
  ["legacy-bitcoin-message.d.ts", '"@tbc-wallet/core"', '"./internal/core/index.js"'],
  ["lop-material.d.ts", '"@tbc-wallet/core"', '"./internal/core/index.js"'],
  ["host-runtime.d.ts", '"@tbc-wallet/host"', '"./internal/host/index.js"'],
  ["wallet-runtime.d.ts", '"@tbc-wallet/core"', '"./internal/core/index.js"'],
  ["wallet-runtime.d.ts", '"@tbc-wallet/host"', '"./internal/host/index.js"'],
  ["nft-mint-job-wallet.d.ts", '"@tbc-wallet/core"', '"./internal/core/index.js"'],
  ["nft-mint-job-material.d.ts", '"@tbc-wallet/core"', '"./internal/core/index.js"'],
  ["reviewed-coin-admin.d.ts", '"@tbc-wallet/core"', '"./internal/core/index.js"'],
  ["reviewed-role-executor.d.ts", '"@tbc-wallet/core"', '"./internal/core/index.js"'],
  ["reviewed-transaction-types.d.ts", '"@tbc-wallet/core"', '"./internal/core/index.js"'],
  ["standard-workflow-capabilities.d.ts", '"@tbc-wallet/core"', '"./internal/core/index.js"'],
  ["sqlite.d.ts", '"@tbc-wallet/host/sqlite"', '"./internal/host/sqlite.js"'],
];
for (const [name, from, to] of declarationRewrites) {
  const path = resolve(packageRoot, "dist/types", name);
  const declaration = await readFile(path, "utf8");
  const rewritten = declaration.replaceAll(from, to);
  if (rewritten === declaration) {
    throw new Error(`Kit declaration closure was not rewritten for ${name}`);
  }
  await writeFile(path, rewritten);
}

execFileSync(
  "cargo",
  ["build", "--locked", "--release", "--offline", "-p", "tbc-keyless-wasm", "--target", "wasm32-unknown-unknown"],
  { cwd: resolve(root, "packages/tbc-engine/rust"), stdio: "inherit" },
);
execFileSync(
  process.execPath,
  [resolve(root, "packages/tbc-engine/scripts/build-keyless-native.mjs")],
  { cwd: root, stdio: "inherit" },
);

await rm(resolve(packageRoot, "dist/esm"), { recursive: true, force: true });
await rm(resolve(packageRoot, "dist/cjs"), { recursive: true, force: true });

async function installPortableTransactionParser(outputRoot) {
  async function installExplicitBufferBindings(directory, format, skipDirectories = new Set()) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirectories.has(entry.name)) {
          await installExplicitBufferBindings(path, format);
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      const original = await readFile(path, "utf8");
      if (!/\bBuffer\b/u.test(original)) continue;
      const binding = format === "esm"
        ? "import { Buffer } from 'buffer';\n"
        : "var Buffer = require('buffer').Buffer;\n";
      if (!original.includes(binding)) {
        if (format === "cjs") {
          const strictDirective = original.match(/^(?:'use strict'|"use strict");?\r?\n/u);
          const insertionOffset = strictDirective?.[0].length ?? 0;
          await writeFile(path, `${original.slice(0, insertionOffset)}${binding}${original.slice(insertionOffset)}`);
        } else {
          await writeFile(path, `${binding}${original}`);
        }
      }
    }
  }

  const parserTarget = resolve(outputRoot, "vendor/tbc-tx-parser");
  await cp(resolve(root, "node_modules/tbc-tx-parser/dist"), parserTarget, {
    recursive: true,
  });
  // The published parser imports the package roots of tbc-lib-js and
  // tbc-contract. Those roots eagerly pull signing, randomness and mnemonic
  // modules into Metro even though review is read-only. Keep a private copy of
  // the SDK implementation and expose only the primitives the parser uses.
  const portableTbcLib = resolve(parserTarget, "vendor/tbc-lib-js/lib");
  await cp(resolve(root, "node_modules/tbc-lib-js/lib"), portableTbcLib, {
    recursive: true,
  });
  await writeFile(
    resolve(parserTarget, "vendor/tbc-lib-js/package.json"),
    `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
  );
  await writeFile(
    resolve(portableTbcLib, "crypto/hash.js"),
    "module.exports = require('./hash.browser.js');\n",
  );
  const publicKeyPath = resolve(portableTbcLib, "publickey.js");
  const publicKeyOriginal = await readFile(publicKeyPath, "utf8");
  const publicKeyPortable = publicKeyOriginal.replace(
    `PublicKey._isPrivateKey = function (param) {
  var PrivateKey = require('./privatekey')
  return param instanceof PrivateKey
}`,
    `PublicKey._isPrivateKey = function () {
  return false
}`,
  );
  if (publicKeyPortable === publicKeyOriginal || publicKeyPortable.includes("require('./privatekey')")) {
    throw new Error("Portable public-key parser patch was not applied");
  }
  await writeFile(publicKeyPath, publicKeyPortable);
  const addressPath = resolve(portableTbcLib, "address.js");
  const addressOriginal = await readFile(addressPath, "utf8");
  const addressPortable = addressOriginal.replaceAll("require('./script')", "require('./script/script')");
  if (addressPortable === addressOriginal || addressPortable.includes("require('./script')")) {
    throw new Error("Portable address parser patch was not applied");
  }
  await writeFile(addressPath, addressPortable);
  const bufferWriterPath = resolve(portableTbcLib, "encoding/bufferwriter.js");
  const bufferWriterOriginal = await readFile(bufferWriterPath, "utf8");
  const bufferWriterPortable = bufferWriterOriginal
    .replace("var assert = require('assert')\n\n", "")
    .replace(
      "    assert(Buffer.isBuffer(buf))",
      "    if (!Buffer.isBuffer(buf)) throw new TypeError('Expected Buffer')",
    );
  if (bufferWriterPortable === bufferWriterOriginal || bufferWriterPortable.includes("require('assert')")) {
    throw new Error("Portable buffer-writer patch was not applied");
  }
  await writeFile(bufferWriterPath, bufferWriterPortable);
  for (const unusedPath of [
    "block",
    "ecies",
    "message",
    "mnemonic",
    "transaction",
    "hash-cache.js",
    "hdprivatekey.js",
    "hdpublickey.js",
    "privatekey.js",
    "taproot.js",
    "crypto/ecdsa.js",
    "crypto/hash.node.js",
    "crypto/musig2.js",
    "crypto/random.js",
    "crypto/schnorr.js",
    "script/interpreter.js",
    "script/stack.js",
  ]) {
    await rm(resolve(portableTbcLib, unusedPath), { recursive: true, force: true });
  }
  const bundledBnPath = resolve(portableTbcLib, "bn.js");
  const bundledBn = await readFile(bundledBnPath, "utf8");
  await writeFile(bundledBnPath, bundledBn.replace("require('buffer/')", "require('buffer')"));
  await installExplicitBufferBindings(portableTbcLib, "cjs");
  await writeFile(
    resolve(parserTarget, "adapters/tbc-lib.js"),
    `import Address from '../vendor/tbc-lib-js/lib/address.js';
import Hash from '../vendor/tbc-lib-js/lib/crypto/hash.browser.js';
import Base58 from '../vendor/tbc-lib-js/lib/encoding/base58.js';
import Networks from '../vendor/tbc-lib-js/lib/networks.js';
import Opcode from '../vendor/tbc-lib-js/lib/opcode.js';
import PublicKey from '../vendor/tbc-lib-js/lib/publickey.js';
import Script from '../vendor/tbc-lib-js/lib/script/script.js';

// Read-only parser facade: deliberately excludes Transaction, private keys,
// random generation, mnemonic support and every Node crypto entry.
export const tbc = Object.freeze({
  Address,
  Networks,
  Opcode,
  PublicKey,
  Script,
  crypto: Object.freeze({ Hash }),
  encoding: Object.freeze({ Base58 }),
});
`,
  );

  const decodePath = resolve(parserTarget, "decode-tx-raw.js");
  const decodeOriginal = await readFile(decodePath, "utf8");
  const decodePortable = decodeOriginal
    .replace(
      /function parseTransactionObject\(txraw\) \{[\s\S]*?\n\}/u,
      `function parseTransactionObject(txraw) {
    return parseRawTransactionObject(txraw);
}`,
    )
    .replace(
      "const prevTxRaw = buffer.subarray(offset, offset + 32);",
      "const prevTxRaw = Buffer.from(buffer.subarray(offset, offset + 32));",
    )
    .replaceAll(
      "const script = buffer.subarray(offset, offset + scriptLength.value);",
      "const script = Buffer.from(buffer.subarray(offset, offset + scriptLength.value));",
    )
    .replace("input.prevTxRaw.copy(buffer, 0);", "buffer.set(input.prevTxRaw, 0);");
  if (
    decodePortable === decodeOriginal ||
    decodePortable.includes("new tbc.Transaction") ||
    decodePortable.includes("input.prevTxRaw.copy") ||
    !decodePortable.includes("buffer.set(input.prevTxRaw, 0)") ||
    !decodePortable.includes("const prevTxRaw = Buffer.from(buffer.subarray") ||
    decodePortable.match(/const script = Buffer\.from\(buffer\.subarray/gu)?.length !== 2
  ) {
    throw new Error("Portable transaction parser raw decoder patch was not applied");
  }
  await writeFile(decodePath, decodePortable);

  const nftPath = resolve(parserTarget, "protocols/nft/index.js");
  const nftOriginal = await readFile(nftPath, "utf8");
  const nftPortable = nftOriginal
    .replace(
      "import tbcContract from 'tbc-contract';",
      "import { buildNftCodeScripts } from '../../adapters/nft-code-scripts.js';",
    )
    .replace("const { NFT } = tbcContract;\n", "")
    .replace(
      `        const canonicalHexes = [
            NFT.buildCodeScript(origin.txid, origin.vout),
            NFT.buildCodeScript_v1(origin.txid, origin.vout),
            NFT.buildCodeScript_v0(origin.txid, origin.vout),
        ].map((canonicalScript) => canonicalScript.toBuffer().toString('hex').toLowerCase());`,
      `        const canonicalHexes = buildNftCodeScripts(origin.txid, origin.vout);`,
    );
  if (
    nftPortable === nftOriginal ||
    nftPortable.includes("tbc-contract") ||
    nftPortable.includes("NFT.buildCodeScript")
  ) {
    throw new Error("Portable transaction parser NFT patch was not applied");
  }
  await writeFile(nftPath, nftPortable);
  await writeFile(
    resolve(parserTarget, "adapters/nft-code-scripts.js"),
    `import { tbc } from './tbc-lib.js';

const CODE_V2 = 'OP_1 OP_PICK OP_3 OP_SPLIT 0x01 0x14 OP_SPLIT OP_DROP OP_TOALTSTACK OP_DROP OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_OVER OP_TOALTSTACK OP_TOALTSTACK OP_CAT OP_FROMALTSTACK OP_CAT OP_SHA256 OP_CAT OP_OVER 0x01 0x24 OP_SPLIT OP_DROP OP_TOALTSTACK OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_HASH256 OP_6 OP_PUSH_META 0x01 0x20 OP_SPLIT OP_4 OP_SPLIT OP_DROP OP_BIN2NUM OP_0 OP_EQUALVERIFY OP_EQUALVERIFY OP_OVER OP_TOALTSTACK OP_CAT OP_CAT OP_SHA256 OP_CAT OP_CAT OP_CAT OP_HASH256 OP_FROMALTSTACK OP_FROMALTSTACK OP_DUP 0x01 0x20 OP_SPLIT OP_BIN2NUM OP_TOALTSTACK OP_3 OP_ROLL OP_EQUALVERIFY OP_SWAP OP_FROMALTSTACK OP_FROMALTSTACK OP_DUP OP_TOALTSTACK OP_ROT OP_EQUAL OP_IF OP_0 OP_EQUALVERIFY OP_DROP OP_ELSE OP_DROP 0x24 {outpoint} OP_EQUALVERIFY OP_ENDIF OP_OVER OP_FROMALTSTACK OP_EQUALVERIFY OP_CAT OP_CAT OP_SHA256 OP_7 OP_PUSH_META OP_EQUALVERIFY OP_DUP OP_HASH160 OP_FROMALTSTACK OP_EQUALVERIFY OP_CHECKSIG OP_RETURN 0x05 0x33436f6465';
const CODE_V1 = 'OP_1 OP_PICK OP_3 OP_SPLIT 0x01 0x14 OP_SPLIT OP_DROP OP_TOALTSTACK OP_DROP OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_OVER OP_TOALTSTACK OP_TOALTSTACK OP_CAT OP_FROMALTSTACK OP_CAT OP_SHA256 OP_CAT OP_OVER 0x01 0x24 OP_SPLIT OP_DROP OP_TOALTSTACK OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_HASH256 OP_6 OP_PUSH_META 0x01 0x20 OP_SPLIT OP_DROP OP_EQUALVERIFY OP_OVER OP_TOALTSTACK OP_TOALTSTACK OP_CAT OP_FROMALTSTACK OP_CAT OP_SHA256 OP_CAT OP_CAT OP_CAT OP_HASH256 OP_FROMALTSTACK OP_FROMALTSTACK OP_DUP 0x01 0x20 OP_SPLIT OP_DROP OP_3 OP_ROLL OP_EQUALVERIFY OP_SWAP OP_FROMALTSTACK OP_DUP OP_TOALTSTACK OP_EQUAL OP_IF OP_DROP OP_ELSE 0x24 {outpoint} OP_EQUALVERIFY OP_ENDIF OP_OVER OP_FROMALTSTACK OP_EQUALVERIFY OP_CAT OP_CAT OP_SHA256 OP_7 OP_PUSH_META OP_EQUALVERIFY OP_DUP OP_HASH160 OP_FROMALTSTACK OP_EQUALVERIFY OP_CHECKSIG OP_RETURN';
const CODE_V0 = 'OP_1 OP_PICK OP_3 OP_SPLIT 0x01 0x14 OP_SPLIT OP_DROP OP_TOALTSTACK OP_DROP OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_1 OP_PICK OP_TOALTSTACK OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_SHA256 OP_CAT OP_1 OP_PICK 0x01 0x24 OP_SPLIT OP_DROP OP_TOALTSTACK OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_SHA256 OP_SHA256 OP_6 OP_PUSH_META 0x01 0x20 OP_SPLIT OP_DROP OP_EQUALVERIFY OP_1 OP_PICK OP_TOALTSTACK OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_SHA256 OP_CAT OP_CAT OP_CAT OP_SHA256 OP_SHA256 OP_FROMALTSTACK OP_FROMALTSTACK OP_DUP 0x01 0x20 OP_SPLIT OP_DROP OP_3 OP_ROLL OP_EQUALVERIFY OP_SWAP OP_FROMALTSTACK OP_DUP OP_TOALTSTACK OP_EQUAL OP_IF OP_DROP OP_ELSE 0x24 {outpoint} OP_EQUALVERIFY OP_ENDIF OP_1 OP_PICK OP_FROMALTSTACK OP_EQUALVERIFY OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_SHA256 OP_7 OP_PUSH_META OP_EQUALVERIFY OP_DUP OP_HASH160 OP_FROMALTSTACK OP_EQUALVERIFY OP_CHECKSIG OP_RETURN 0x05 0x33436f6465';

function canonicalCodeHex(template, txid, vout) {
  const outputIndex = Buffer.alloc(4);
  outputIndex.writeUInt32LE(vout);
  const outpoint = '0x' + Buffer.from(txid, 'hex').reverse().toString('hex') + outputIndex.toString('hex');
  return new tbc.Script(template.replace('{outpoint}', outpoint)).toBuffer().toString('hex').toLowerCase();
}

export function buildNftCodeScripts(txid, vout) {
  return [CODE_V2, CODE_V1, CODE_V0].map((template) => canonicalCodeHex(template, txid, vout));
}
`,
  );

  const publicScriptPath = resolve(parserTarget, "core/public-script.js");
  const original = await readFile(publicScriptPath, "utf8");
  const portable = original
    .replace(
      "import { createHash } from 'node:crypto';",
      "import { sha256 } from '@noble/hashes/sha2.js';",
    )
    .replace(
      /function tbcApiScriptHash\(hex\) \{[\s\S]*?\n\}/u,
      `function tbcApiScriptHash(hex) {
    const bytes = Uint8Array.from(hex.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));
    return Array.from(sha256(bytes)).reverse().map((byte) => byte.toString(16).padStart(2, '0')).join('');
}`,
    );
  if (
    portable === original ||
    portable.includes("node:crypto") ||
    !portable.includes("sha256(bytes)")
  ) {
    throw new Error("Portable transaction parser SHA-256 patch was not applied");
  }
  await writeFile(publicScriptPath, portable);
  await installExplicitBufferBindings(parserTarget, "esm", new Set(["vendor"]));
  await closePortableParserDependencies(parserTarget);
  await patchContract173Parser(parserTarget);

  const forbiddenImports = [];
  for (const relativePath of [
    "adapters/tbc-lib.js",
    "decode-tx-raw.js",
    "protocols/nft/index.js",
    "core/public-script.js",
  ]) {
    const content = await readFile(resolve(parserTarget, relativePath), "utf8");
    if (/(?:'|")(?:node:crypto|crypto|tbc-contract|tbc-lib-js)(?:'|")/u.test(content)) {
      forbiddenImports.push(relativePath);
    }
  }
  if (forbiddenImports.length > 0) {
    throw new Error(`Portable parser retains forbidden imports: ${forbiddenImports.join(", ")}`);
  }
}

await installPortableTransactionParser(resolve(packageRoot, "dist/esm"));
await installPortableTransactionParser(resolve(packageRoot, "dist/cjs"));
await mkdir(resolve(packageRoot, "artifacts/wasm"), { recursive: true });
await rm(resolve(packageRoot, "artifacts/keyless-native"), { recursive: true, force: true });
await rm(resolve(packageRoot, "artifacts/native"), { recursive: true, force: true });
await cp(
  resolve(root, "packages/tbc-engine/artifacts/wasm/tbc_engine_wasm.wasm"),
  resolve(packageRoot, "artifacts/wasm/tbc_engine_wasm.wasm"),
);
await cp(
  resolve(root, "packages/tbc-engine/rust/target/wasm32-unknown-unknown/release/tbc_keyless_wasm.wasm"),
  resolve(packageRoot, "artifacts/wasm/tbc_keyless_wasm.wasm"),
);
for (const name of ["tbc_engine_wasm.wasm", "tbc_keyless_wasm.wasm"]) {
  const path = resolve(packageRoot, "artifacts/wasm", name);
  await writeFile(path, stripWasmNameSection(await readFile(path)));
}
await cp(
  resolve(root, "packages/tbc-engine/artifacts/keyless-native"),
  resolve(packageRoot, "artifacts/keyless-native"),
  { recursive: true },
);
await cp(
  resolve(root, "packages/tbc-engine/artifacts/native"),
  resolve(packageRoot, "artifacts/native"),
  { recursive: true },
);

await buildKitRuntime({ root, packageRoot });

// Keep the packaged provenance mechanically bound to the exact generated
// protocol identity and artifact bytes. Candidate narrative remains reviewed
// source, while drift-prone identities are always refreshed by the build.
const provenancePath = resolve(packageRoot, "artifacts/provenance.json");
const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
const packageManifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const releaseSource = await readFile(resolve(root, "packages/core/src/generated/v1-candidate-release.ts"), "utf8");
const protocolFingerprint = releaseSource.match(
  /GENERATED_TWS_RELEASE_FINGERPRINT\s*=\s*\n?\s*"([0-9a-f]{64})"/u,
)?.[1];
if (protocolFingerprint === undefined) throw new Error("Generated protocol fingerprint is unavailable");
const sha256File = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
provenance.package = `${packageManifest.name}@${packageManifest.version}`;
provenance.protocolFingerprint = protocolFingerprint;
for (const artifact of provenance.artifacts) {
  artifact.sha256 = await sha256File(resolve(packageRoot, artifact.path));
}
if (provenance.publicMerge?.schemas !== undefined) {
  provenance.publicMerge.schemas["schemas/transaction-request.schema.json"] =
    await sha256File(resolve(root, "schemas/transaction-request.schema.json"));
  provenance.publicMerge.schemas["schemas/integration.schema.json"] =
    await sha256File(resolve(root, "schemas/integration.schema.json"));
}
if (provenance.publicMerge?.nativeDelivery !== undefined) {
  provenance.publicMerge.nativeDelivery.iosArm64Sha256 = await sha256File(resolve(
    packageRoot, "artifacts/native/ios/TbcEngineNative.xcframework/ios-arm64/libtbc_engine_native.a",
  ));
  provenance.publicMerge.nativeDelivery.iosSimulatorArm64Sha256 = await sha256File(resolve(
    packageRoot, "artifacts/native/ios/TbcEngineNative.xcframework/ios-arm64-simulator/libtbc_engine_native.a",
  ));
  provenance.publicMerge.nativeDelivery.wasmSha256 = await sha256File(resolve(
    packageRoot, "artifacts/wasm/tbc_engine_wasm.wasm",
  ));
}
await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

// Map-only finalization avoids changing runtime bytes or hashed chunk names.
await omitEmbeddedSources(resolve(packageRoot, "dist"));
// Record only after all build outputs have been produced. A source edit or
// artifact edit after this point invalidates the normal npm prepack check.
execFileSync(process.execPath, [resolve(root, "scripts/check-kit-source-state.mjs"), "--record-build"], { stdio: "inherit" });
