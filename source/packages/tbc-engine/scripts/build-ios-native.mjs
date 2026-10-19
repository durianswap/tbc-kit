import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { IOS_TARGETS, iosBuildEnvironment, assertIosDeployment } from './ios-deployment.mjs';

const packageRoot = resolve(import.meta.dirname, '..');
const workspace = resolve(packageRoot, 'rust');
const [outputArgument, targetArgument] = process.argv.slice(2);
if (!outputArgument || !targetArgument) throw new Error('Usage: node build-ios-native.mjs NEW_OUTPUT_DIRECTORY CARGO_TARGET_DIRECTORY');
const output = resolve(outputArgument);
const targetRoot = resolve(targetArgument);
if (existsSync(output)) throw new Error('Refusing to overwrite an existing native delivery');
const libraries = [];
const evidence = [];
for (const target of IOS_TARGETS) {
  const sdk = target.endsWith('-sim') ? 'iphonesimulator' : 'iphoneos';
  const sdkRoot = execFileSync('xcrun', ['--sdk', sdk, '--show-sdk-path'], { encoding: 'utf8' }).trim();
  execFileSync('cargo', ['build', '--locked', '--offline', '--release', '-p', 'tbc-engine-native', '--target', target, '--target-dir', targetRoot], {
    cwd: workspace, env: iosBuildEnvironment(target, sdkRoot), stdio: 'inherit',
  });
  const library = resolve(targetRoot, target, 'release/libtbc_engine_native.a');
  const commands = execFileSync('xcrun', ['otool', '-l', library], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  evidence.push({ target, sdkRoot, ...assertIosDeployment(commands), sha256: createHash('sha256').update(readFileSync(library)).digest('hex') });
  libraries.push(library);
}
mkdirSync(dirname(output), { recursive: true });
execFileSync('xcodebuild', ['-create-xcframework',
  ...libraries.flatMap(library => ['-library', library, '-headers', resolve(workspace, 'crates/tbc-engine-native/include')]),
  '-output', output], { stdio: 'inherit' });
console.log(JSON.stringify({ output, evidence }, null, 2));
