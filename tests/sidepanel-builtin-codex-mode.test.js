const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('sidepanel exposes builtin codex json source option', () => {
  const html = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');
  const source = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');

  assert.match(html, /<option value="builtin-codex">内置 Codex JSON<\/option>/);
  assert.match(source, /normalized === 'builtin-codex'/);
  assert.match(source, /useBuiltinCodex \? '生成 Codex JSON'/);
});

test('manifest grants downloads permission for builtin codex json output', () => {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  assert.ok(manifest.permissions.includes('downloads'));
});
