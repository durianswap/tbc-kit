// esbuild places source filenames in its internal module labels. Preserve
// loader semantics while keeping the pinned Kit checkout path out of Hermes.
import assert from 'node:assert/strict';
import {posix, resolve, sep} from 'node:path';

export function normalizeRuntimeModuleLabels(source, kitDirectory, dependencyRoots = []) {
  const roots = [
    {path: kitDirectory, label: 'kit'},
    ...dependencyRoots,
  ].map(({path,label}) => {
    assert.match(label, /^[a-z][a-z0-9-]*$/u, 'Invalid module label namespace');
    return {marker: `${resolve(path).split(sep).join('/')}/`, label};
  }).sort((a,b) => b.marker.length - a.marker.length);
  let kitReplaced = 0;
  const result = source.replace(/(__commonJS\d*|__esm\d*)\(\{"([^"]+)"/gu,
    (whole, loader, label) => {
      const root = roots.find(({marker}) => label.includes(marker));
      if (root === undefined) return whole;
      const index = label.indexOf(root.marker);
      assert.match(label.slice(0, index), /^(?:(?:\.\.\/)*\.\.)?$/u,
        'Unexpected source label prefix');
      const relative = label.slice(index + root.marker.length);
      assert.ok(relative && !relative.startsWith('/') &&
        relative !== '..' && !relative.startsWith('../') &&
        posix.normalize(relative) === relative,
      'Noncanonical source label');
      if (root.label === 'kit') kitReplaced++;
      return `${loader}({"${root.label}:${relative}"`;
    });
  assert.ok(kitReplaced > 0, 'Private runtime did not bundle pinned Kit modules');
  for (const {marker} of roots) {
    assert.ok(!result.includes(marker), 'Build path remains outside module labels');
  }
  return result;
}

// esbuild's minified browser bundle renames its module factory helper, so its
// dependency labels need a separate, narrow pass. Never alter runtime strings.
export function normalizeMinifiedDependencyLabels(source, dependencyRoots) {
  const roots = dependencyRoots.map(({path,label}) => {
    assert.match(label, /^[a-z][a-z0-9-]*$/u, 'Invalid module label namespace');
    return {marker:`${resolve(path).split(sep).join('/')}/`,label};
  }).sort((a,b) => b.marker.length - a.marker.length);
  const result = source.replace(/([a-zA-Z_$][\w$]*\(\{")([^"]+)("\()/gu,
    (whole,prefix,sourceLabel,suffix) => {
      const root = roots.find(({marker}) => sourceLabel.includes(marker));
      if (root === undefined) return whole;
      const index = sourceLabel.indexOf(root.marker);
      assert.match(sourceLabel.slice(0,index), /^(?:(?:\.\.\/)*\.\.)?$/u,
        'Unexpected dependency label prefix');
      const relative = sourceLabel.slice(index+root.marker.length);
      assert.ok(relative && !relative.startsWith('/') && relative !== '..' &&
        !relative.startsWith('../') && posix.normalize(relative) === relative,
      'Noncanonical dependency label');
      return `${prefix}${root.label}:${relative}${suffix}`;
    });
  for (const {marker} of roots)
    assert.ok(!result.includes(marker), 'Dependency build path remains outside module labels');
  return result;
}
