// SwiftPM flattens static XCFramework headers into a shared include directory.
// Keep the keyless Clang module map in its own namespace to avoid colliding
// with Core's module.modulemap. The C header and ABI remain unchanged.
import assert from 'node:assert/strict';
import {mkdir, copyFile, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export async function prepareKeylessAppleHeaders(source, destination) {
  await mkdir(join(destination, 'TbcKeylessNative'), {recursive: true});
  const map = await readFile(join(source, 'module.modulemap'), 'utf8');
  assert.ok(map.includes('header "tbc_keyless.h"'), 'Unexpected keyless module map');
  await copyFile(join(source, 'tbc_keyless.h'), join(destination, 'tbc_keyless.h'));
  await writeFile(join(destination, 'TbcKeylessNative/module.modulemap'),
    map.replace('header "tbc_keyless.h"', 'header "../tbc_keyless.h"'));
}
