import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, renderStats } from '../lib/stats.mjs';

const now = Date.parse('2026-09-23T12:00:00Z');
const at = (h) => new Date(now - h * 3600e3).toISOString();
const rows = [
  { ts: at(1), kind: 'map', status: 'mapped', scanned: 400, suggested: 5, inputTokens: 30000, latencyMs: 1000 },
  { ts: at(1), kind: 'map', status: 'mapped', scanned: 400, suggested: 3, inputTokens: 30000, latencyMs: 1400 },
  { ts: at(1), kind: 'map', status: 'reused' },
  { ts: at(1), kind: 'map', status: 'no_code' },
  { ts: at(1), kind: 'read', reason: 'in_map' },
  { ts: at(1), kind: 'read', reason: 'blocked', bytes: 8000 },
  { ts: at(1), kind: 'read', reason: 'blocked', bytes: 4000 },
  { ts: at(1), kind: 'read', reason: 'retry_override' },
  { ts: at(1), kind: 'read', reason: 'not_blocked' },
  { ts: at(24 * 30), kind: 'map', status: 'mapped', scanned: 999, suggested: 9, inputTokens: 1, latencyMs: 1 },
];

test('summarize counts within window', () => {
  const s = summarize(rows, now - 7 * 24 * 3600e3);
  assert.equal(s.mapped, 2);
  assert.equal(s.reused, 1);
  assert.equal(s.noCode, 1);
  assert.equal(s.scanned, 800);
  assert.equal(s.suggested, 8);
  assert.equal(s.readInMap, 1);
  assert.equal(s.skipped, 2);
  assert.equal(s.tokensSaved, 3000);
  assert.equal(s.overridden, 1);
  assert.equal(s.avgLatencyMs, 1200);
  assert.ok(Math.abs(s.costUsd - 60000 * 0.042 / 1e6) < 1e-12);
});

test('renderStats prints the key lines', () => {
  const text = renderStats(summarize(rows, now - 7 * 24 * 3600e3));
  assert.match(text, /prompts mapped\s+2/);
  assert.match(text, /reads skipped\s+2 \(≈ 3,000 tokens not loaded\) · overridden 1/);
  assert.match(text, /override rate 50%/);
});

test('renderStats with no data', () => {
  assert.match(renderStats(summarize([], 0)), /No Bouncer activity yet/);
});
