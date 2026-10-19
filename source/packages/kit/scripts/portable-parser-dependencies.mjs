// Build-time dependency closure. This does not change a parser algorithm.
import assert from 'node:assert/strict';
import {readFile, writeFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

export const parserRuntimeDependencies = Object.freeze({
  bs58: '4.0.1', elliptic: '6.6.1', 'hash.js': '1.1.7',
});
export const partialSha256BodyHash = '484f8dff255eb1799895ef40fa95ef2d48434e94e192265a31ad969eafe7855b';
const external = 'tbc-lib-js/lib/util/partial-sha256.js';
const internal = '../vendor/tbc-lib-js/lib/util/partial-sha256.js';

export async function closePortableParserDependencies(parserRoot) {
  const implementation = await readFile(join(parserRoot, 'vendor/tbc-lib-js/lib/util/partial-sha256.js'), 'utf8');
  const body = implementation.replace(/^var Buffer = require\('buffer'\)\.Buffer;\r?\n/, '');
  assert.equal(createHash('sha256').update(body).digest('hex'), partialSha256BodyHash,
    'Review upstream partial SHA implementation before changing the pinned parser');
  const adapter = join(parserRoot, 'adapters/partial-sha256.js');
  const source = await readFile(adapter, 'utf8');
  assert.ok(source.includes(`from '${external}'`) || source.includes(`from '${internal}'`), 'Unexpected partial SHA adapter');
  await writeFile(adapter, source.replace(`from '${external}'`, `from '${internal}'`));
  const imports = new Set();
  async function scan(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (entry.name.endsWith('.js')) {
        const text = await readFile(path, 'utf8');
        for (const match of text.matchAll(/(?:require\s*\(\s*|from\s+|import\s+)["']([^"']+)["']/g)) {
          if (!match[1].startsWith('.')) imports.add(match[1]);
        }
      }
    }
  }
  await scan(parserRoot);
  assert.deepEqual([...imports].sort(), ['@noble/hashes/sha2.js', 'buffer', ...Object.keys(parserRuntimeDependencies)].sort(),
    'Declare and review every portable parser runtime dependency');
  return {partialSha256BodyHash, externalImports: [...imports].sort()};
}
