import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {prepareKeylessAppleHeaders} from './keyless-apple-headers.mjs';

test('Apple keyless headers do not collide with the Core module map', async () => {
  const source = resolve(import.meta.dirname,
    '../../../packages/tbc-engine/rust/crates/tbc-keyless-native/include');
  const destination = await mkdtemp(join(tmpdir(), 'tbc-keyless-headers-test-'));
  await prepareKeylessAppleHeaders(source, destination);
  assert.deepEqual((await readdir(destination)).sort(), ['TbcKeylessNative', 'tbc_keyless.h']);
  assert.deepEqual(await readFile(join(destination, 'tbc_keyless.h')),
    await readFile(join(source, 'tbc_keyless.h')));
  assert.equal(await readFile(join(destination, 'TbcKeylessNative/module.modulemap'), 'utf8'),
    (await readFile(join(source, 'module.modulemap'), 'utf8'))
      .replace('header "tbc_keyless.h"', 'header "../tbc_keyless.h"'));
});
