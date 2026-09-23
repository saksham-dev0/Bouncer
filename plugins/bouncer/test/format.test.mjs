import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMap, summaryLine } from '../lib/format.mjs';

const map = { scanned: 412, core: ['src/auth/login.ts', 'src/middleware/index.ts'], supporting: ['src/auth/session.ts'], blocked: ['x'], latencyMs: 1100 };

test('formatMap lists core and supporting with guidance', () => {
  const text = formatMap(map);
  assert.match(text, /412 files scanned/);
  assert.match(text, /core: src\/auth\/login\.ts, src\/middleware\/index\.ts/);
  assert.match(text, /supporting: src\/auth\/session\.ts/);
  assert.match(text, /Start with these/);
});

test('formatMap handles empty map', () => {
  const text = formatMap({ ...map, core: [], supporting: [] });
  assert.match(text, /no files stood out/i);
});

test('summaryLine is one line with counts and seconds', () => {
  assert.equal(summaryLine(map), 'Bouncer: 412 files scanned → 3 picked (1.1s)');
});
