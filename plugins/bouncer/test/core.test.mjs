import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { loadConfig, DEFAULTS, bouncerHome } from '../lib/config.mjs';
import { readSession, writeSession, sessionPath, emptySession } from '../lib/state.mjs';
import { appendLog, readLog } from '../lib/log.mjs';

test('loadConfig merges defaults < user < project < env', () => {
  const dir = makeTmp();
  mkdirSync(bouncerHome(), { recursive: true });
  writeFileSync(join(bouncerHome(), 'config.json'), JSON.stringify({ maxSuggested: 5, blockBelow: 0.2 }));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'bouncer.json'), JSON.stringify({ blockBelow: 0.1 }));
  process.env.BOUNCER_PRIVACY = 'symbols';
  const cfg = loadConfig(dir);
  delete process.env.BOUNCER_PRIVACY;
  assert.equal(cfg.maxSuggested, 5);
  assert.equal(cfg.blockBelow, 0.1);
  assert.equal(cfg.privacy, 'symbols');
  assert.equal(cfg.model, DEFAULTS.model);
});

test('loadConfig ignores corrupt config files', () => {
  const dir = makeTmp();
  mkdirSync(bouncerHome(), { recursive: true });
  writeFileSync(join(bouncerHome(), 'config.json'), '{not json');
  assert.equal(loadConfig(dir).maxSuggested, DEFAULTS.maxSuggested);
});

test('session round-trips and defaults when missing', () => {
  makeTmp();
  assert.deepEqual(readSession('abc'), emptySession());
  const s = { ...emptySession(), enabled: true, denied: ['a.ts'] };
  writeSession('abc', s);
  assert.deepEqual(readSession('abc'), s);
});

test('session id is sanitised against traversal', () => {
  makeTmp();
  const p = sessionPath('../../etc/passwd');
  assert.equal(dirname(p), join(bouncerHome(), 'sessions'));
  assert.ok(!p.includes('..'));
  assert.equal(dirname(sessionPath('')), join(bouncerHome(), 'sessions'));
  writeSession('../x', emptySession());
  assert.ok(existsSync(sessionPath('../x')));
});

test('corrupt session file reads as empty', () => {
  makeTmp();
  writeSession('s1', emptySession());
  writeFileSync(sessionPath('s1'), 'garbage');
  assert.deepEqual(readSession('s1'), emptySession());
});

test('log appends jsonl with ts and skips bad lines', () => {
  makeTmp();
  appendLog({ kind: 'map', scanned: 3 });
  appendLog({ kind: 'read', reason: 'in_map' });
  const rows = readLog();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'map');
  assert.ok(rows[0].ts);
});
