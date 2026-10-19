// Build-only extraction: normalize generated JS layout, then evaluate only the
// standalone literal. Never evaluate the privileged wallet module in a page.
import assert from 'node:assert/strict';
import {transformSync} from 'esbuild';
import {runInNewContext} from 'node:vm';

export function extractLegacyPageBootstrap(moduleSource) {
  const formatted = transformSync(moduleSource, {
    loader: 'js', format: 'esm', minify: false, logLevel: 'silent',
  }).code;
  const matches = [...formatted.matchAll(/^var TBC_KIT_LEGACY_PAGE_BOOTSTRAP_SCRIPT = (.+);$/gm)];
  assert.equal(matches.length, 1, 'Pinned Kit must have one standalone Legacy page bootstrap');
  // esbuild emits an ordinary quoted literal here. Reject executable initializers.
  assert.match(matches[0][1], /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/u);
  const script = runInNewContext(matches[0][1], Object.create(null), {timeout: 1000});
  assert.ok(script.length > 0 && script.length <= 64 * 1024, 'Bounded Legacy page bootstrap');
  assert.ok(script.includes('legacy-window-turing-webview/1'), 'Wrong Legacy page protocol');
  return script;
}
