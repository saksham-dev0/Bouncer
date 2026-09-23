import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeTmp } from './helpers/tmp.mjs';
import { startFakeJev, keywordAnswers } from './helpers/fake-jev.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { emptySession, writeSession, readSession } from '../lib/state.mjs';
import { isCandidatePath, listFiles, readHead } from '../lib/files.mjs';
import { askBatched } from '../lib/jev.mjs';
import { buildMap } from '../lib/mapper.mjs';
import { decideRead } from '../lib/gate.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'prompt.mjs');
const cand = (path) => ({ path, lines: 100, symbols: [] });

function repoWith(paths) {
  const dir = makeTmp();
  const repo = join(dir, 'repo');
  for (const p of paths) {
    mkdirSync(join(repo, p, '..'), { recursive: true });
    writeFileSync(join(repo, p), `// ${p}\n`.repeat(50));
  }
  return { dir, repo };
}

function spawnHook(input, env) {
  const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, ...env } });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const done = new Promise((resolve) => child.on('close', () => resolve(out)));
  child.stdin.end(JSON.stringify(input));
  return { child, done };
}

// Important #1a: slow Jev must not leave the previous map enforced if the hook is killed
test('rebuild deactivates the old map before any network call', async () => {
  const { repo } = repoWith(['src/a.ts']);
  writeSession('s', { ...emptySession(), enabled: true, active: true, task: 'old', map: { repo, core: [], supporting: [], blocked: ['src/a.ts'] } });
  const fake = await startFakeJev(keywordAnswers('x'), { delayMs: 5000 });
  const { child, done } = spawnHook({ session_id: 's', prompt: 'a new task', cwd: repo }, { BOUNCER_HOME: process.env.BOUNCER_HOME, BOUNCER_API_BASE: fake.base, TYPESAFE_API_KEY: 'k' });
  await new Promise((r) => setTimeout(r, 600));
  child.kill('SIGKILL');
  await done;
  await fake.close();
  assert.equal(readSession('s').active, false);
});

// Important #1b: whole map respects an overall budget, not timeoutMs per call
test('buildMap finishes within budgetMs even when every call is slow', async () => {
  const { repo } = repoWith(['src/a.ts', 'src/b.ts']);
  const fake = await startFakeJev(keywordAnswers('a.ts'), { delayMs: 400 });
  process.env.BOUNCER_API_BASE = fake.base;
  const started = Date.now();
  const map = await buildMap({ task: 't', prompt: 't', repo, files: ['src/a.ts', 'src/b.ts'].map(cand), cfg: { ...DEFAULTS, tinyFileLines: 0, timeoutMs: 8000, budgetMs: 600 }, apiKey: 'k' });
  await fake.close();
  assert.ok(Date.now() - started < 750, `took ${Date.now() - started}ms`);
  assert.equal(map.ok, true); // skim finished; close look skipped for lack of budget
  assert.equal(fake.calls.length, 1);
});

// Re-graded Minor #2 -> Important: batchSize 0 must not loop forever
test('askBatched treats batchSize < 1 as 1', async () => {
  const fake = await startFakeJev(keywordAnswers('x'));
  process.env.BOUNCER_API_BASE = fake.base;
  const r = await askBatched({ state: {}, questions: { a: { type: 'noul', instructions: 'q' }, b: { type: 'noul', instructions: 'q' } }, batchSize: 0, model: 'm', timeoutMs: 1000, apiKey: 'k' });
  await fake.close();
  assert.equal(r.total, 2);
});

// Important #2: a no-code new task must drop the old map so a follow-up cannot revive it
test('no-code new task clears the previous map', async () => {
  const { repo } = repoWith(['src/auth/login.ts', 'src/billing/invoice.ts']);
  const answers = (key, q, state) => {
    if ('previous_task' in state) return { type: 'noul', noul: key === 'new_task' ? 0.9 : 0.9 };
    if (key === 'needs_code') return { type: 'noul', noul: state.task === 'what is a mutex' ? 0.05 : 0.95 };
    return keywordAnswers('auth')(key, q, state);
  };
  const fake = await startFakeJev(answers);
  const env = { BOUNCER_HOME: process.env.BOUNCER_HOME, BOUNCER_API_BASE: fake.base, TYPESAFE_API_KEY: 'k' };
  await spawnHook({ session_id: 's', prompt: '/bouncer:on', cwd: repo }, env).done;
  await spawnHook({ session_id: 's', prompt: 'fix login bug', cwd: repo }, env).done;
  assert.ok(readSession('s').map);
  await spawnHook({ session_id: 's', prompt: 'what is a mutex', cwd: repo }, env).done;
  await fake.close();
  assert.deepEqual([readSession('s').map, readSession('s').active], [null, false]);
});

// Important #3: symlinked checkout paths must still be gated
test('decideRead resolves symlinks on both sides', () => {
  const dir = makeTmp();
  const real = join(dir, 'real');
  mkdirSync(join(real, 'src'), { recursive: true });
  writeFileSync(join(real, 'src', 'bad.ts'), 'x');
  symlinkSync(real, join(dir, 'link'));
  const session = { ...emptySession(), active: true, map: { repo: realpathSync(real), core: [], supporting: [], blocked: ['src/bad.ts'] } };
  assert.equal(decideRead({ session, filePath: join(dir, 'link', 'src', 'bad.ts') }).action, 'deny');
  const viaLinkRepo = { ...session, map: { ...session.map, repo: join(dir, 'link') } };
  assert.equal(decideRead({ session: viaLinkRepo, filePath: join(real, 'src', 'bad.ts') }).action, 'deny');
  assert.equal(decideRead({ session, filePath: join(real, '..foo') }).reason, 'not_blocked'); // in-repo name, not a parent dir
  assert.equal(decideRead({ session, filePath: join(dir, 'elsewhere.ts') }).reason, 'outside_repo');
  assert.equal(decideRead({ session, filePath: join(real, '..foo', 'x') }).reason, 'not_blocked');
});

// Important #4: secret files never become candidates; secret-looking lines never leave in heads; never walk $HOME
test('secret paths are never candidates', () => {
  for (const p of ['.env', '.env.local', 'config/.env.production', 'certs/server.pem', 'k/id_rsa', 'deploy.key', 'aws/credentials.json', 'my_secrets.yml', '.npmrc', '.netrc', 'prod.tfvars', 'cert.p12'])
    assert.equal(isCandidatePath(p), false, p);
  assert.equal(isCandidatePath('src/keyboard.ts'), true);
});

test('readHead redacts secret-looking lines', () => {
  const { repo } = repoWith([]);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'db.yml'), 'host: db\npassword: hunter2\napi_key = abc\nport: 5432\n');
  const head = readHead(repo, 'db.yml', DEFAULTS);
  assert.ok(!head.includes('hunter2') && !head.includes('abc'));
  assert.match(head, /host: db/);
  assert.match(head, /\[redacted\]/);
});

test('listFiles refuses to walk the home directory', () => {
  assert.deepEqual(listFiles(homedir(), 10), []);
});
