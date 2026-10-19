import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertIosDeployment, iosBuildEnvironment } from '../scripts/ios-deployment.mjs';

test('iOS build pins both C and Rust deployment and selects the explicit SDK', () => {
  const result = iosBuildEnvironment('aarch64-apple-ios-sim', '/Xcode/iPhoneSimulator.sdk', {
    SDKROOT: '/wrong/macos.sdk', IPHONEOS_DEPLOYMENT_TARGET: '26.5', PATH: '/tools',
  });
  assert.equal(result.SDKROOT, '/Xcode/iPhoneSimulator.sdk');
  assert.equal(result.IPHONEOS_DEPLOYMENT_TARGET, '15.1');
  assert.equal(result.PATH, '/tools');
  assert.throws(() => iosBuildEnvironment('aarch64-apple-darwin', '/sdk'), /Unsupported/);
});

test('archive audit accepts legacy and modern objects but rejects one newer C object', () => {
  const good = 'cmd LC_VERSION_MIN_IPHONEOS\n version 10.0\n sdk 26.5\ncmd LC_BUILD_VERSION\n platform 7\n minos 15.1\n sdk 27.0\ncmd LC_SYMTAB';
  assert.deepEqual(assertIosDeployment(good).versions, ['10.0', '15.1']);
  assert.throws(() => assertIosDeployment(good + '\ncmd LC_BUILD_VERSION\n minos 26.5\n sdk 26.5'), /exceeds/);
  assert.throws(() => assertIosDeployment('not an archive'), /No iOS/);
});
