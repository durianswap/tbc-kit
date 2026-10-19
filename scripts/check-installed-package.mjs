import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(join(tmpdir(), 'tbc-kit-consumer-'));
const run = (args) => execFileSync(process.execPath, args, {
  cwd: directory,
  encoding: 'utf8',
  timeout: 120_000,
});

try {
  execFileSync('npm', [
    'install', '--prefix', directory, '--ignore-scripts', '--no-audit', '--no-fund',
    join(root, 'artifacts/tbc-kit.tgz'),
  ], { encoding: 'utf8', timeout: 120_000 });

  const entrypoints = ['', '/wallet', '/api', '/rpc', '/engine', '/sqlite', '/testing', '/multisig'];
  const esm = run(['--input-type=module', '-e', `
    for (const suffix of ${JSON.stringify(entrypoints)}) {
      const value = await import('@tbc/kit' + suffix);
      if (Object.keys(value).length === 0) throw new Error('Empty ESM entry: ' + suffix);
    }
    console.log('ESM_IMPORTS_PASS');
  `]);
  assert.match(esm, /ESM_IMPORTS_PASS/);
  const cjs = run(['-e', `
    for (const suffix of ${JSON.stringify(entrypoints)}) {
      const value = require('@tbc/kit' + suffix);
      if (Object.keys(value).length === 0) throw new Error('Empty CJS entry: ' + suffix);
    }
    console.log('CJS_IMPORTS_PASS');
  `]);
  assert.match(cjs, /CJS_IMPORTS_PASS/);

  // These examples use public fixture data and never contact a node or broadcast.
  for (const name of ['backend-node', 'multi-wallet']) {
    const output = run([join(directory, 'node_modules/@tbc/kit/examples', name, 'run.mjs')]);
    console.log(output.trim());
  }
  const metadata = JSON.parse(await readFile(join(directory, 'node_modules/@tbc/kit/package.json'), 'utf8'));
  console.log(JSON.stringify({
    status: 'PASS', version: metadata.version, esmImports: entrypoints.length,
    cjsImports: entrypoints.length, offlineExamples: 2,
  }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
