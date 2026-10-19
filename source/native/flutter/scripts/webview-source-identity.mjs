// Stable, portable provenance identifiers. The build machine path is never
// embedded in a page resource; files are still re-read at build time.
import assert from 'node:assert/strict';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';

function inside(base, path) {
  const rel = relative(resolve(base), resolve(path));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel) ? rel.split(sep).join('/') : null;
}

export function sourceIdentifier(repository, kit, path) {
  const kitPart = inside(kit, path);
  if (kitPart) return `kit:${kitPart}`;
  const repoPart = inside(repository, path);
  if (repoPart) return `repo:${repoPart}`;
  throw new Error('Page input is outside the repository and pinned Kit');
}

export function sourcePath(repository, kit, identifier) {
  assert.match(identifier, /^(?:kit|repo):[^\\]+$/u);
  const colon = identifier.indexOf(':');
  const scope = identifier.slice(0, colon);
  const subpath = identifier.slice(colon + 1);
  assert.ok(!subpath.startsWith('/') && !subpath.split('/').includes('..') &&
    !subpath.split('/').includes('.') && !subpath.includes('//'),
  'Noncanonical page input identifier');
  const base = scope === 'kit' ? kit : repository;
  const path = join(resolve(base), ...subpath.split('/'));
  assert.equal(sourceIdentifier(repository, kit, path), identifier);
  return path;
}
