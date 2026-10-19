// Explicit local scaffolding only: no install hook, downloads, keys or app changes.
import { cp, mkdir, realpath, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { syncNative } from './module/scripts/sync-native.mjs';

const app = await realpath(resolve(process.argv[2] ?? '.'));
if (!process.argv[3]) throw new Error('Pass the verified native SDK directory as the second argument; no hidden download or legacy bridge fallback');
const nativeSdkRoot = await realpath(resolve(process.argv[3]));
const options = process.argv.slice(4);
if (options.length && (options.length !== 2 || options[0] !== '--platform' || !['ios', 'android', 'all'].includes(options[1]))) {
  throw new Error('Optional argument: --platform ios|android|all');
}
const platform = options[1] ?? 'all';
const target = resolve(app, 'modules/tbc-kit-engine');
await mkdir(resolve(app, 'modules'), { recursive: true });
await mkdir(target); // EEXIST is deliberate: never overwrite an existing module.
await cp(resolve(import.meta.dirname, 'module'), target, { recursive: true, force: false });
await rename(resolve(target, 'generated-files.gitignore'), resolve(target, '.gitignore'));
await syncNative({ moduleRoot: target, appRoot: app, nativeSdkRoot, platform });
console.log(`TBC Engine module created at ${target}. Rebuild your native app; Expo Go is not supported.`);
