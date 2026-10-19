import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {partialSha256BodyHash, parserRuntimeDependencies} from '../scripts/portable-parser-dependencies.mjs';

test('portable parser uses its existing partial SHA in ESM and CJS, with explicit runtime dependencies', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.dependencies['tbc-lib-js'], undefined);
  for (const [name, version] of Object.entries(parserRuntimeDependencies)) assert.equal(pkg.dependencies[name], version);
  for (const format of ['esm','cjs']) {
    const base = new URL(`../dist/${format}/vendor/tbc-tx-parser/`, import.meta.url);
    const adapter = await readFile(new URL('adapters/partial-sha256.js', base), 'utf8');
    assert.match(adapter, /from '\.\.\/vendor\/tbc-lib-js\/lib\/util\/partial-sha256\.js'/);
    const internal = await readFile(new URL('vendor/tbc-lib-js/lib/util/partial-sha256.js', base), 'utf8');
    const body = internal.replace(/^var Buffer = require\('buffer'\)\.Buffer;\r?\n/, '');
    assert.equal(createHash('sha256').update(body).digest('hex'), partialSha256BodyHash);
    const {calculatePartialSha256} = await import(new URL('adapters/partial-sha256.js', base));
    const originalBuffer = globalThis.Buffer;
    const input = originalBuffer.alloc(193, 0x51);
    const expected = calculatePartialSha256(input);
    try {
      globalThis.Buffer = undefined;
      assert.equal(calculatePartialSha256(input), expected);
    } finally { globalThis.Buffer = originalBuffer; }
  }
});
