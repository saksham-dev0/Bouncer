import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTmp } from './helpers/tmp.mjs';
import { startFakeJev, keywordAnswers } from './helpers/fake-jev.mjs';
import { readSession } from '../lib/state.mjs';
import { readLog } from '../lib/log.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'prompt.mjs');

function run(input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

function setup(answerFn = keywordAnswers('auth')) {
  const dir = makeTmp();
  const repo = join(dir, 'repo');
  for (const p of ['src/auth/login.ts', 'src/billing/invoice.ts']) {
    mkdirSync(join(repo, p, '..'), { recursive: true });
    writeFileSync(join(repo, p), `// ${p}\n`.repeat(50));
  }
  return { repo, answerFn };
}

async function withFake(answerFn, fn, opts) {
  const fake = await startFakeJev(answerFn, opts);
  try {
    return await fn({ BOUNCER_HOME: process.env.BOUNCER_HOME, BOUNCER_API_BASE: fake.base, TYPESAFE_API_KEY: 'k' }, fake);
  } finally {
    await fake.close();
  }
}

test('garbage stdin exits 0 with no output', async () => {
  makeTmp();
  const r = await run('not json', { BOUNCER_HOME: process.env.BOUNCER_HOME });
  assert.deepEqual([r.code, r.out], [0, '']);
});

test('off by default: normal prompt does nothing', async () => {
  const { repo } = setup();
  await withFake(keywordAnswers('auth'), async (env, fake) => {
    const r = await run({ session_id: 's', prompt: 'rate limit login', cwd: repo }, env);
    assert.equal(r.out, '');
    assert.equal(fake.calls.length, 0);
  });
});

test('/bouncer:on then prompt -> map injected and saved; /bouncer:off clears', async () => {
  const { repo } = setup();
  await withFake(keywordAnswers('auth'), async (env) => {
    assert.equal((await run({ session_id: 's', prompt: '/bouncer:on', cwd: repo }, env)).out, '');
    assert.equal(readSession('s').enabled, true);

    const r = await run({ session_id: 's', prompt: 'rate limit login', cwd: repo }, env);
    const out = JSON.parse(r.out);
    assert.match(out.systemMessage, /^Bouncer: 2 files scanned → 1 picked/);
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(out.hookSpecificOutput.additionalContext, /core: src\/auth\/login\.ts/);
    const s = readSession('s');
    assert.equal(s.active, true);
    assert.deepEqual(s.map.blocked, ['src/billing/invoice.ts']);

    await run({ session_id: 's', prompt: '/bouncer:off', cwd: repo }, env);
    const off = readSession('s');
    assert.deepEqual([off.enabled, off.active, off.map], [false, false, null]);
  });
});

test('follow-up "yes" reuses map without scanning', async () => {
  const { repo } = setup();
  const answers = (key, q, state) =>
    key === 'new_task' || key === 'adds_scope' ? { type: 'noul', noul: 0.1 } : key === 'needs_code' ? { type: 'noul', noul: 0.9 } : keywordAnswers('auth')(key, q, state);
  await withFake(answers, async (env, fake) => {
    await run({ session_id: 's', prompt: '/bouncer:on', cwd: repo }, env);
    await run({ session_id: 's', prompt: 'rate limit login', cwd: repo }, env);
    const before = fake.calls.length;
    const r = await run({ session_id: 's', prompt: 'yes go ahead', cwd: repo }, env);
    assert.equal(r.out, '');
    assert.equal(fake.calls.length, before + 1); // only the follow-up request
    assert.equal(readSession('s').active, true);
    assert.equal(readLog().at(-1).status, 'reused');
  });
});

test('follow-up that needs no code deactivates gating for the turn', async () => {
  const { repo } = setup();
  const answers = (key, q, state) => (key === 'needs_code' && 'previous_task' in state ? { type: 'noul', noul: 0.05 } : keywordAnswers('auth')(key, q, state));
  await withFake(answers, async (env) => {
    await run({ session_id: 's', prompt: '/bouncer:on', cwd: repo }, env);
    await run({ session_id: 's', prompt: 'rate limit login', cwd: repo }, env);
    await run({ session_id: 's', prompt: 'commit this', cwd: repo }, env);
    assert.equal(readSession('s').active, false);
  });
});

test('/bouncer:map one-shot works while off and is cleared on next prompt', async () => {
  const { repo } = setup();
  await withFake(keywordAnswers('auth'), async (env) => {
    const r = await run({ session_id: 's', prompt: '/bouncer:map rate limit login', cwd: repo }, env);
    assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /src\/auth\/login\.ts/);
    assert.deepEqual([readSession('s').enabled, readSession('s').active, readSession('s').oneShot], [false, true, true]);
    await run({ session_id: 's', prompt: 'thanks', cwd: repo }, env);
    assert.deepEqual([readSession('s').active, readSession('s').map], [false, null]);
  });
});

test('no API key -> one-line notice, no gating', async () => {
  const { repo } = setup();
  const env = { BOUNCER_HOME: process.env.BOUNCER_HOME, TYPESAFE_API_KEY: '' };
  await run({ session_id: 's', prompt: '/bouncer:on', cwd: repo }, env);
  const r = await run({ session_id: 's', prompt: 'rate limit login', cwd: repo }, env);
  assert.match(JSON.parse(r.out).systemMessage, /TYPESAFE_API_KEY/);
  assert.equal(readSession('s').active, false);
});

test('Jev down -> notice, no gating', async () => {
  const { repo } = setup();
  await withFake(keywordAnswers('auth'), async (env) => {
    await run({ session_id: 's', prompt: '/bouncer:on', cwd: repo }, env);
    const r = await run({ session_id: 's', prompt: 'rate limit login', cwd: repo }, env);
    assert.match(JSON.parse(r.out).systemMessage, /unavailable/);
    assert.equal(readSession('s').active, false);
  }, { status: 529 });
});
