import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Local source/host checks. No package installation, emulator replacement,
// secret access, signing, network or fund movement.
const root = import.meta.dirname;
const output = mkdtempSync(join(tmpdir(), 'tbc-native-fence-'));
const javaHome = process.env.JAVA_HOME ?? '/Applications/Android Studio.app/Contents/jbr/Contents/Home';
const cache = join(process.env.GRADLE_USER_HOME ?? join(homedir(), '.gradle'), 'caches/modules-2/files-2.1');
function jar(group, artifact, version) {
  const base = join(cache, group, artifact, version);
  const files = readdirSync(base).flatMap(hash => readdirSync(join(base, hash))
    .filter(name => name === `${artifact}-${version}.jar`).map(name => join(base, hash, name)));
  assert.equal(files.length, 1, `Need cached ${artifact}:${version}`); return files[0];
}
const stdlib = jar('org.jetbrains.kotlin', 'kotlin-stdlib', '2.1.20');
const annotations = jar('org.jetbrains', 'annotations', '13.0');
const compiler = [jar('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '2.1.20'), stdlib, annotations,
  jar('org.jetbrains.kotlin', 'kotlin-script-runtime', '2.1.20'),
  jar('org.jetbrains.kotlin', 'kotlin-reflect', '1.6.10'),
  jar('org.jetbrains.intellij.deps', 'trove4j', '1.0.20200330'),
  jar('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.8.0')].join(':');
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
run('xcrun', ['swiftc', '-swift-version', '6', '-parse-as-library', join(root, 'NativeSessionFence.swift'),
  join(root, 'FenceChecks.swift'), '-o', join(output, 'swift-fence')]);
const swift = run(join(output, 'swift-fence'), []);
assert.match(swift, /NATIVE_FENCE_PASS swift checks=15 executions=6 reads=0 posts=0/);
assert.match(swift, /NATIVE_BOUND_TASKS_PASS swift tasks=2/);
assert.match(swift, /NATIVE_DELIVERY_PASS swift/);
run(join(javaHome, 'bin/java'), ['-cp', compiler, 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
  '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-classpath', [stdlib, annotations].join(':'),
  join(root, 'NativeSessionFence.kt'), join(root, 'FenceChecks.kt'), '-d', join(output, 'classes')]);
const kotlin = run(join(javaHome, 'bin/java'), ['-cp', [join(output, 'classes'), stdlib].join(':'), 'io.tbc.kit.host.FenceChecksKt']);
assert.match(kotlin, /NATIVE_FENCE_PASS kotlin checks=15 executions=6 reads=0 posts=0 thread-check=pass/);
assert.match(kotlin, /NATIVE_BOUND_TASKS_PASS kotlin tasks=2/);
assert.match(kotlin, /NATIVE_DELIVERY_PASS kotlin/);
const sourceHashes = Object.fromEntries(['NativeSessionFence.swift', 'NativeSessionFence.kt', 'FenceChecks.swift', 'FenceChecks.kt']
  .map(name => [name, createHash('sha256').update(readFileSync(join(root, name))).digest('hex')]));
const report = { status: 'PASS', swift: swift.trim(), kotlin: kotlin.trim(), sourceHashes,
  runtime: 'macOS Swift + desktop JVM (not mobile device acceptance)', productionWallet: false,
  realSigner: false, externalPosts: 0, output: resolve(output) };
writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
