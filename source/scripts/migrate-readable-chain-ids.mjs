// One-shot, explicit draft migration. Historical deliveries/handoffs/native
// Candidate188 probe evidence are not rewritten. No transaction data or keys.
import { readFile, writeFile, readdir, mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const backup = await mkdtemp(join(tmpdir(), 'tbc-readable-chain-ids-'));
const replacements = [
  ['tbc:000000006ec607045ad2c990de903d04', 'tbc:mainnet'],
  ['tbc:0000000000cee779eb6a6c2ce087218a', 'tbc:testnet'],
  // Synthetic unregistered networks used only by conformance fixtures.
  ['tbc:11111111111111111111111111111111', 'tbc:other'],
  ['tbc:22222222222222222222222222222222', 'tbc:other-two'],
];
const skip = new Set(['node_modules', 'dist', 'target', 'vendor', 'delivery', 'artifacts', '.git', 'work', 'generated']);
const changed = [];
async function visit(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const file = join(path, entry.name);
    if (entry.isDirectory()) { await visit(file); continue; }
    if (!/\.(ts|mjs|js|json|md|swift|kt|rs)$/.test(file) ||
        /\/(?:migrate|rebase)-readable-chain-(?:ids|vectors)\.mjs$/.test(file)) continue;
    const source = await readFile(file, 'utf8');
    let result = source;
    for (const [from, to] of replacements) result = result.replaceAll(from, to);
    if (source !== result) {
      const name = relative(root, file), saved = join(backup, name);
      await mkdir(dirname(saved), { recursive: true }); await writeFile(saved, source);
      await writeFile(file, result); changed.push(name);
    }
  }
}
for (const directory of ['packages', 'schemas', 'registry', 'standards', 'test', 'test-vectors', 'examples', 'scripts', 'docs/reference', 'docs/dapp', 'docs/wallet']) {
  try { await visit(join(root, directory)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await writeFile(join(backup, 'changed.json'), JSON.stringify(changed, null, 2));
console.log(JSON.stringify({ backup, files: changed.length }));
