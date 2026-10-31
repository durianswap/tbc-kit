import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { readFile, mkdir, mkdtemp, rm, copyFile, link, lstat } from 'node:fs/promises';
import { dirname, resolve, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

export function safePath(root, name) {
  assert(typeof name === 'string' && name && !name.includes('\\') && !name.includes('\0'));
  assert(!name.startsWith('/') && !name.split('/').some(p => p === '..' || p === '.'));
  const result = resolve(root, name);
  assert(result.startsWith(resolve(root) + sep), `Path leaves repository: ${name}`);
  return result;
}

export async function verifyFile(path, expected) {
  const info = await lstat(path);
  assert(info.isFile() && !info.isSymbolicLink(), `Not a regular file: ${path}`);
  assert.equal(info.size, expected.bytes, `Size mismatch: ${path}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  assert.equal(hash.digest('hex'), expected.sha256, `SHA256 mismatch: ${path}`);
}

// Repository maintenance only. No SDK/runtime code imports this downloader.
export async function acquireAsset(root, asset, from) {
  const destination = safePath(root, asset.path);
  if (existsSync(destination)) {
    await verifyFile(destination, asset);
    return destination;
  }
  const url = new URL(asset.url);
  assert.equal(url.origin, 'https://github.com');
  assert(url.pathname.startsWith('/durianswap/tbc-kit/releases/download/'));
  await mkdir(dirname(destination), { recursive: true });
  const scratch = await mkdtemp(join(dirname(destination), '.asset-'));
  try {
    const temporary = join(scratch, 'download');
    if (from) {
      await copyFile(safePath(from, asset.name), temporary);
    } else {
      const response = await fetch(url);
      assert(response.ok && response.body, `Download failed (${response.status}): ${asset.name}`);
      let received = 0;
      const limit = new Transform({ transform(chunk, _encoding, done) {
        received += chunk.length;
        done(received > asset.bytes ? new Error(`Oversized download: ${asset.name}`) : null, chunk);
      }});
      await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(temporary, { flags: 'wx' }));
    }
    await verifyFile(temporary, asset);
    // A concurrently installed or edited file must never be silently replaced.
    try { await link(temporary, destination); }
    catch (error) { if (error.code !== 'EEXIST') throw error; await verifyFile(destination, asset); }
    return destination;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function restoreFiles(root, asset, archive) {
  if (!asset.files) return 0;
  let missing = false;
  for (const file of asset.files) {
    const destination = safePath(root, file.path);
    if (existsSync(destination)) await verifyFile(destination, file);
    else missing = true;
  }
  if (!missing) return 0;
  const members = asset.files.map(file => {
    assert(file.path.startsWith(asset.extractTo));
    return asset.archiveRoot + file.path.slice(asset.extractTo.length);
  });
  const list = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    .trim().split('\n').filter(Boolean);
  for (const name of list) safePath(root, name.replace(/\/$/, ''));
  assert.deepEqual(list.filter(name => !name.endsWith('/')).sort(), [...members].sort(), `Archive members differ: ${asset.id}`);
  const details = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert(details.trim().split('\n').every(line => line[0] === '-' || line[0] === 'd'), 'Archive contains links or special files');
  const scratch = await mkdtemp(join(tmpdir(), 'tbc-kit-restore-'));
  try {
    execFileSync('tar', ['-xzf', archive, '-C', scratch]);
    // Verify the entire material set before restoring anything.
    for (const [i, file] of asset.files.entries()) await verifyFile(safePath(scratch, members[i]), file);
    let count = 0;
    for (const [i, file] of asset.files.entries()) {
      const destination = safePath(root, file.path);
      if (existsSync(destination)) await verifyFile(destination, file);
      else {
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(safePath(scratch, members[i]), destination, 1 /* COPYFILE_EXCL */);
        count++;
      }
    }
    return count;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function fetchAssets(root, requested = ['verification'], from) {
  const manifest = JSON.parse(await readFile(join(root, 'release/downloads.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  const selected = new Set();
  for (const name of requested) {
    const ids = name === 'all' ? manifest.assets.map(a => a.id) : manifest.groups[name] ?? [name];
    for (const id of ids) {
      assert(manifest.assets.some(a => a.id === id), `Unknown asset/group: ${name}`);
      selected.add(id);
    }
  }
  for (const asset of manifest.assets.filter(a => selected.has(a.id))) {
    const archive = await acquireAsset(root, asset, from);
    const restored = await restoreFiles(root, asset, archive);
    console.log(`${asset.id}: SHA256 verified; ${restored} files restored`);
  }
  if (requested.includes('acceptance') || requested.includes('all')) {
    for (const alias of manifest.aliases) {
      const asset = manifest.assets.find(a => a.id === alias.asset);
      const destination = safePath(root, alias.path);
      if (existsSync(destination)) await verifyFile(destination, alias);
      else {
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(safePath(root, asset.path), destination, 1);
        await verifyFile(destination, alias);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  let from;
  const at = args.indexOf('--from');
  if (at !== -1) {
    assert(args[at + 1], '--from requires a local asset directory');
    from = resolve(args[at + 1]);
    args.splice(at, 2);
  }
  await fetchAssets(resolve(import.meta.dirname, '..'), args.length ? args : ['verification'], from);
}
