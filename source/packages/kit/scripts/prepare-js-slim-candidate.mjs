import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { buildKitRuntime } from "./runtime-build.mjs";
import { omitEmbeddedSources } from "./source-map-policy.mjs";
import { fileInventory, platformCatalog, sha256 } from "./platform-resources.mjs";
import { verifiedKitCandidate } from "../../../native/flutter/scripts/candidate-inputs.mjs";
import { closePortableParserDependencies, parserRuntimeDependencies } from "./portable-parser-dependencies.mjs";

const [baseArg, outArg, version] = process.argv.slice(2);
assert.ok(baseArg && outArg && version, "FROZEN_KIT NEW_OUTPUT VERSION");
assert.match(version, /^0\.1\.0-platform-slim\.\d{8}\.\d+$/);
const root = resolve(import.meta.dirname, "../../..");
const base = resolve(baseArg), out = resolve(outArg);
const baseline = await verifiedKitCandidate(base);
const before = await fileInventory(base);
const sourceBefore = {};
for (const name of ["core", "host", "provider", "wallet-standard", "tbc-engine", "kit"]) {
  for (const [p, item] of Object.entries(await fileInventory(join(root, "packages", name, "src")))) sourceBefore[`packages/${name}/src/${p}`] = item.sha256;
}
await mkdir(out);
const rebuilt = join(out, "source-rebuild"), kit = join(out, "package");
// Prove the current sources recreate the frozen JS before any optimization.
await mkdir(rebuilt);
await buildKitRuntime({ root, packageRoot: rebuilt, shared: false });
const rebuiltFiles = await fileInventory(rebuilt);
const jsPaths = Object.keys(before).filter(p => /^dist\/(esm|cjs)\//.test(p) && /\.(js|cjs)$/.test(p) && !p.includes("/vendor/"));
// esbuild chunk names include output-relative source-map paths. Compare every
// byte of JS apart from those names/map comments; bind each renamed import to
// the recursive content identity of its target, not a wildcard replacement.
async function graphIdentity(directory, paths) {
  const contents = new Map(await Promise.all(paths.map(async p=>[p,await readFile(join(directory,p),"utf8")])));
  const identities = new Map();
  function identity(p, visiting = new Set()) {
    if (identities.has(p)) return identities.get(p);
    assert.ok(!visiting.has(p), `Unexpected emitted chunk cycle: ${p}`);
    const next = new Set([...visiting,p]);
    const text = contents.get(p).replace(/\/\/# sourceMappingURL=[^\r\n]*/g, "")
      .replace(/(["'])\.\/((?:chunk|node|network|prepared)-[A-Z0-9]+\.js)\1/g, (_m,q,target)=> {
        const imported=join(dirname(p),target); assert.ok(contents.has(imported), imported);
        return `${q}./content-${identity(imported,next)}.js${q}`;
      });
    const digest=sha256(text);identities.set(p,digest);return digest;
  }
  for (const p of paths) identity(p);
  return identities;
}
const rebuiltJs=Object.keys(rebuiltFiles).filter(p=>/\.(js|cjs)$/.test(p));
const oldGraph=await graphIdentity(base,jsPaths),newGraph=await graphIdentity(rebuilt,rebuiltJs);
assert.deepEqual([...newGraph.values()].sort(),[...oldGraph.values()].sort(),"Source JS body or graph differs from frozen candidate");
for(const p of jsPaths.filter(p=>!/(?:chunk|node|network|prepared)-[A-Z0-9]+\.js$/.test(p))) assert.equal(newGraph.get(p),oldGraph.get(p),p);
await writeFile(join(out, "source-parity.json"), JSON.stringify({baseline, files: jsPaths.length,
  contentAndImportGraphEqual:true, ignoredOnly:"source-map comments and content-verified chunk filenames",
  byteIdentical:jsPaths.filter(p=>before[p].sha256===rebuiltFiles[p]?.sha256).length}, null, 2)+"\n");

await cp(base, kit, { recursive: true, errorOnExist: true, force: false });
// These paths belong only to the newly created staging copy, not the source
// checkout or any frozen release. Preserve the already-audited parser copy.
for (const format of ["esm", "cjs"]) {
  const directory = join(kit, "dist", format);
  for (const entry of await readdir(directory)) if (entry !== "vendor") await rm(join(directory, entry), { recursive: true });
}
await buildKitRuntime({ root, packageRoot: kit, minifyWhitespace: true });
for (const format of ["esm", "cjs"]) await closePortableParserDependencies(join(kit, "dist", format, "vendor/tbc-tx-parser"));
await omitEmbeddedSources(join(kit, "dist"));
const debug = join(out, "debug");
await mkdir(debug);
let separatedMaps = 0, separatedMapBytes = 0;
async function separateMaps(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) { await separateMaps(absolute); continue; }
    if (entry.name.endsWith(".map")) {
      const relative = absolute.slice(kit.length + 1), bytes = await readFile(absolute);
      await mkdir(dirname(join(debug, relative)), {recursive: true});
      await writeFile(join(debug, relative), bytes); await rm(absolute);
      separatedMaps++; separatedMapBytes += bytes.length;
    } else if (/\.(?:js|cjs|ts)$/.test(entry.name)) {
      const original = await readFile(absolute, "utf8");
      const clean = original.replace(/(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n|$)/g, "\n");
      if (clean !== original) await writeFile(absolute, clean);
    }
  }
}
await separateMaps(join(kit, "dist"));
const pkg = JSON.parse(await readFile(join(kit, "package.json")));
pkg.version = version;
delete pkg.dependencies["tbc-contract"];
delete pkg.dependencies["tbc-tx-parser"];
delete pkg.dependencies["tbc-lib-js"];
Object.assign(pkg.dependencies, parserRuntimeDependencies);
await writeFile(join(kit, "package.json"), JSON.stringify(pkg, null, 2)+"\n");
const provenance = JSON.parse(await readFile(join(kit, "artifacts/provenance.json")));
provenance.package = `@tbc/kit@${version}`;
const catalog = await platformCatalog(base);
if (catalog) {
  // Resource filenames, hashes and native bytes are deliberately reused.
  catalog.package = provenance.package;
  const catalogBytes = JSON.stringify(catalog,null,2)+"\n";
  await writeFile(join(kit,"artifacts/platform-resources.json"),catalogBytes);
  provenance.platformResources.sha256 = sha256(catalogBytes);
}
provenance.javascriptDistribution = {baseline, sourceParityFiles: jsPaths.length, sharedGeneratedValidation: true,
  validationRulesChanged: false, minifyWhitespace: true, minifyIdentifiers: false,
  debugMaps: "separate maintainer archive", nativeAndWasmChanged: false,
  acceptance: "pending separate receipt", published: false};
await writeFile(join(kit, "artifacts/provenance.json"), JSON.stringify(provenance, null, 2)+"\n");
await writeFile(join(debug, "identity.json"), JSON.stringify({version, baseline, maps: separatedMaps,
  bytes: separatedMapBytes, sourceFiles: sourceBefore}, null, 2)+"\n");
const after = await fileInventory(kit);
for (const p of Object.keys(before).filter(p=>p.startsWith("artifacts/wasm/"))) assert.equal(after[p].sha256, before[p].sha256, p);
for (const [p, hash] of Object.entries(sourceBefore)) assert.equal(sha256(await readFile(join(root,p))), hash, `Source changed during build: ${p}`);
const identity = {schema: 1, version, sourceVersion: baseline.version, protocolFingerprint: baseline.protocolFingerprint,
  rustSourceSha256: baseline.rustSourceSha256, files: Object.fromEntries(Object.entries(after)
    .filter(([p])=>p!=="artifacts/flutter-kit-candidate.json").map(([p,v])=>[p,v.sha256]))};
await writeFile(join(kit, "artifacts/flutter-kit-candidate.json"), JSON.stringify({artifactId: sha256(JSON.stringify(identity)), ...identity}, null, 2)+"\n");
await verifiedKitCandidate(kit);
await platformCatalog(kit);
const [packed] = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", out], {cwd:kit, encoding:"utf8", maxBuffer:4*1024*1024}));
execFileSync("tar", ["-czf", join(out,"debug-maps.tgz"), "-C", out, "debug"], {env:{...process.env,COPYFILE_DISABLE:"1"}});
const report = {status:"BUILT_NOT_ACCEPTED", baseline, version, tarball:packed.filename,
  tarballSha256:sha256(await readFile(join(out,packed.filename))), compressedBytes:packed.size, unpackedBytes:packed.unpackedSize,
  separatedMaps, separatedMapBytes, debugArchiveSha256:sha256(await readFile(join(out,"debug-maps.tgz"))),
  sourceParityFiles:jsPaths.length, nativeAndWasmChanged:false, realChain:false,published:false};
await writeFile(join(out,"candidate.json"), JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
