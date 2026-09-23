import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp } from './helpers/tmp.mjs';
import { emptySession, writeSession, readSession } from '../lib/state.mjs';
import { readLog } from '../lib/log.mjs';
import { decideRead, denyMessage } from '../lib/gate.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'gate.mjs');
const repo = '/work/repo';
const session = (over = {}) => ({
  ...emptySession(),
  active: true,
  map: { repo, core: ['src/a.ts'], supporting: ['src/b.ts'], blocked: ['src/bad.ts', 'my dir/bad file.ts'] },
  ...over,
});

test('decideRead truth table', () => {
  const d = (s, p) => decideRead({ session: s, filePath: p });
  assert.equal(d(session({ active: false }), `${repo}/src/bad.ts`).reason, 'inactive');
  assert.equal(d(session(), `${repo}/src/a.ts`).reason, 'in_map');
  assert.equal(d(session(), `${repo}/src/b.ts`).reason, 'in_map');
  assert.equal(d(session(), `${repo}/src/other.ts`).reason, 'not_blocked');
  assert.equal(d(session(), '/etc/hosts').reason, 'outside_repo');
  assert.equal(d(session(), `${repo}/../elsewhere/src/bad.ts`).reason, 'outside_repo');
  assert.deepEqual(d(session(), `${repo}/src/bad.ts`), { action: 'deny', reason: 'blocked', rel: 'src/bad.ts' });
  assert.equal(d(session(), `${repo}/my dir/bad file.ts`).action, 'deny');
  assert.equal(d(session(), 'src/bad.ts').action, 'deny'); // relative resolves against repo
  assert.equal(d(session({ denied: ['src/bad.ts'] }), `${repo}/src/bad.ts`).reason, 'retry_override');
  assert.equal(d(session({ overridden: ['src/bad.ts'] }), `${repo}/src/bad.ts`).reason, 'overridden');
});

test('denyMessage tells Claude how to override', () => {
  assert.match(denyMessage('src/bad.ts'), /src\/bad\.ts.*Read it again/);
});

function run(input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

test('gate script: deny, then retry passes, logs both', async () => {
  const dir = makeTmp();
  const r = join(dir, 'repo');
  mkdirSync(join(r, 'src'), { recursive: true });
  writeFileSync(join(r, 'src', 'bad.ts'), 'x'.repeat(4000));
  writeSession('s', session({ map: { repo: r, core: [], supporting: [], blocked: ['src/bad.ts'] } }));
  const input = { session_id: 's', tool_name: 'Read', cwd: r, tool_input: { file_path: join(r, 'src', 'bad.ts') } };

  const first = await run(input);
  const out = JSON.parse(first.out);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Bouncer/);
  assert.deepEqual(readSession('s').denied, ['src/bad.ts']);

  const second = await run(input);
  assert.equal(second.out, '');
  assert.deepEqual(readSession('s').overridden, ['src/bad.ts']);

  const rows = readLog().filter((x) => x.kind === 'read');
  assert.deepEqual(rows.map((x) => x.reason), ['blocked', 'retry_override']);
  assert.equal(rows[0].bytes, 4000);
});

test('gate script: subagent reads, non-Read tools and garbage are allowed silently', async () => {
  makeTmp();
  writeSession('s', session());
  assert.equal((await run({ session_id: 's', tool_name: 'Read', agent_id: 'x', tool_input: { file_path: `${repo}/src/bad.ts` } })).out, '');
  assert.equal((await run({ session_id: 's', tool_name: 'Grep', tool_input: {} })).out, '');
  const g = await run('nope');
  assert.deepEqual([g.code, g.out], [0, '']);
});
