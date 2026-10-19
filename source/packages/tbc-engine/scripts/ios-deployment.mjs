import assert from 'node:assert/strict';

// Shared by Rust/cc-rs builds and the Expo bridge's platform support policy.
export const IOS_MINIMUM_VERSION = '15.1';
export const IOS_TARGETS = ['aarch64-apple-ios', 'aarch64-apple-ios-sim'];

export function iosBuildEnvironment(target, sdkRoot, base = process.env) {
  assert.ok(IOS_TARGETS.includes(target), 'Unsupported iOS target');
  assert.ok(sdkRoot?.startsWith('/'), 'Expected an absolute Xcode SDK path');
  return { ...base, SDKROOT: sdkRoot, IPHONEOS_DEPLOYMENT_TARGET: IOS_MINIMUM_VERSION };
}

function versionNumber(version) {
  const [major, minor = 0, patch = 0] = version.split('.').map(Number);
  return major * 1000000 + minor * 1000 + patch;
}

/** Inspect every member, including C dependencies, not just the archive's Rust member. */
export function assertIosDeployment(loadCommands, maximum = IOS_MINIMUM_VERSION) {
  const versions = [];
  for (const block of loadCommands.split(/(?=\s*cmd LC_)/)) {
    const key = /cmd LC_BUILD_VERSION\b/.test(block) ? 'minos'
      : /cmd LC_VERSION_MIN_IPHONEOS\b/.test(block) ? 'version' : undefined;
    if (!key) continue;
    const value = block.match(new RegExp(`\\b${key}\\s+(\\d+(?:\\.\\d+){0,2})`))?.[1];
    assert.ok(value, 'Missing deployment version in Mach-O load command');
    versions.push(value);
  }
  assert.ok(versions.length > 0, 'No iOS deployment load commands found');
  const excessive = versions.filter(version => versionNumber(version) > versionNumber(maximum));
  assert.equal(excessive.length, 0, `Native object exceeds iOS ${maximum}: ${[...new Set(excessive)].join(', ')}`);
  return { objectCount: versions.length, versions: [...new Set(versions)].sort(), maximum };
}
