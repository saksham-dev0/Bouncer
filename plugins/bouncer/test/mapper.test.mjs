import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { startFakeJev, keywordAnswers } from './helpers/fake-jev.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { followupRequest, skimQuestion } from '../lib/questions.mjs';
import { isContextFile, namedInPrompt, classify, buildMap } from '../lib/mapper.mjs';

const cfg = { ...DEFAULTS, tinyFileLines: 0 };
const cand = (path, lines = 100) => ({ path, lines, symbols: [] });

test('skimQuestion carries the file inside instructions', () => {
  const q = skimQuestion({ path: 'a.ts', symbols: ['x'] });
  assert.equal(q.type, 'noul');
  assert.deepEqual(q.instructions.file, { path: 'a.ts', symbols: ['x'] });
});

test('followupRequest asks new_task, adds_scope, needs_code', () => {
  const r = followupRequest('old', 'yes');
  assert.deepEqual(r.state, { previous_task: 'old', prompt: 'yes' });
  assert.deepEqual(Object.keys(r.questions).sort(), ['adds_scope', 'needs_code', 'new_task']);
});

test('isContextFile matches project-wide files only', () => {
  for (const p of ['README.md', 'package.json', 'src/index.ts', 'tsconfig.base.json', 'CLAUDE.md']) assert.ok(isContextFile(p), p);
  for (const p of ['src/auth/login.ts', 'src/billing/invoice.ts']) assert.ok(!isContextFile(p), p);
});

test('namedInPrompt matches full path, basename and stem', () => {
  const paths = ['src/auth/login.ts', 'src/billing/invoice.ts', 'src/a.ts'];
  assert.deepEqual(namedInPrompt('fix src/auth/login.ts', paths), ['src/auth/login.ts']);
  assert.deepEqual(namedInPrompt('look at invoice.ts', paths), ['src/billing/invoice.ts']);
  assert.deepEqual(namedInPrompt('the invoice flow is broken', paths), ['src/billing/invoice.ts']);
  assert.deepEqual(namedInPrompt('a thing', paths), []);
});

test('classify: named first, thresholds, cap, and blocked excludes named/context/tiny/unscored', () => {
  const files = [cand('a.ts'), cand('b.ts'), cand('c.ts'), cand('d.ts'), cand('README.md'), cand('tiny.ts', 5), cand('named.ts'), cand('unscored.ts')];
  const skim = { 'a.ts': 0.9, 'b.ts': 0.8, 'c.ts': 0.5, 'd.ts': 0.05, 'README.md': 0.01, 'tiny.ts': 0.01, 'named.ts': 0.01 };
  const close = { 'a.ts': 3, 'b.ts': 1.7, 'c.ts': 0.4, 'named.ts': 0 };
  const r = classify({ files, skim, close, named: ['named.ts'], cfg: { ...cfg, tinyFileLines: 30 } });
  assert.deepEqual(r.core, ['named.ts', 'a.ts']);
  assert.deepEqual(r.supporting, ['b.ts']);
  assert.deepEqual(r.blocked, ['d.ts']);
  const capped = classify({ files, skim, close, named: [], cfg: { ...cfg, maxSuggested: 1 } });
  assert.deepEqual([...capped.core, ...capped.supporting], ['a.ts']);
});

function repoWith(paths) {
  const dir = makeTmp();
  const repo = join(dir, 'repo');
  for (const p of paths) {
    mkdirSync(join(repo, p, '..'), { recursive: true });
    writeFileSync(join(repo, p), `// ${p}\n`.repeat(50));
  }
  return repo;
}

test('buildMap: skim + close look produce core and blocked', async () => {
  const paths = ['src/auth/login.ts', 'src/auth/session.ts', 'src/billing/invoice.ts', 'src/billing/tax.ts'];
  const repo = repoWith(paths);
  const fake = await startFakeJev(keywordAnswers('auth'));
  process.env.BOUNCER_API_BASE = fake.base;
  const map = await buildMap({ task: 'rate limit login', prompt: 'rate limit login', repo, files: paths.map((p) => cand(p)), cfg, apiKey: 'k' });
  await fake.close();
  assert.equal(map.ok, true);
  assert.equal(map.needsCode, true);
  assert.equal(map.scanned, 4);
  assert.deepEqual([...map.core].sort(), ['src/auth/login.ts', 'src/auth/session.ts']);
  assert.deepEqual([...map.blocked].sort(), ['src/billing/invoice.ts', 'src/billing/tax.ts']);
  const closeCall = fake.calls[1].body;
  const firstClose = Object.values(closeCall.questions)[0];
  assert.equal(firstClose.type, 'score');
  assert.ok(firstClose.instructions.file.head.includes('//'));
});

test('buildMap: symbols privacy sends no head', async () => {
  const paths = ['src/auth/login.ts'];
  const repo = repoWith(paths);
  const fake = await startFakeJev(keywordAnswers('auth'));
  process.env.BOUNCER_API_BASE = fake.base;
  await buildMap({ task: 't', prompt: 't', repo, files: paths.map((p) => cand(p)), cfg: { ...cfg, privacy: 'symbols' }, apiKey: 'k' });
  await fake.close();
  assert.ok(!JSON.stringify(fake.calls).includes('"head"'));
});

test('buildMap: needs_code low -> no map', async () => {
  const repo = repoWith(['a.ts']);
  const fake = await startFakeJev(keywordAnswers('auth', { needsCode: 0.1 }));
  process.env.BOUNCER_API_BASE = fake.base;
  const map = await buildMap({ task: 'commit this', prompt: 'commit this', repo, files: [cand('a.ts')], cfg, apiKey: 'k' });
  await fake.close();
  assert.deepEqual([map.ok, map.needsCode], [true, false]);
  assert.equal(fake.calls.length, 1);
});

test('buildMap: total Jev failure -> ok:false', async () => {
  const repo = repoWith(['a.ts']);
  const fake = await startFakeJev(keywordAnswers('auth'), { status: 529 });
  process.env.BOUNCER_API_BASE = fake.base;
  const map = await buildMap({ task: 't', prompt: 't', repo, files: [cand('a.ts')], cfg, apiKey: 'k' });
  await fake.close();
  assert.equal(map.ok, false);
});

test('buildMap: partially failed skim never blocks unscored files', async () => {
  const paths = ['src/billing/a.ts', 'src/billing/b.ts', 'src/billing/c.ts'];
  const repo = repoWith(paths);
  const fake = await startFakeJev(keywordAnswers('auth'), { failWhen: (req) => JSON.stringify(req).includes('billing/c.ts') && !('needs_code' in req.questions) });
  process.env.BOUNCER_API_BASE = fake.base;
  const map = await buildMap({ task: 't', prompt: 't', repo, files: paths.map((p) => cand(p)), cfg: { ...cfg, skimBatchSize: 2 }, apiKey: 'k' });
  await fake.close();
  assert.equal(map.partial, true);
  assert.ok(!map.blocked.includes('src/billing/c.ts'));
  assert.ok(map.blocked.includes('src/billing/a.ts'));
});

test('buildMap: directory pass prunes irrelevant folders on big repos', async () => {
  const paths = ['src/auth/login.ts', 'src/auth/x.ts', 'src/billing/invoice.ts', 'README.md'];
  const repo = repoWith(paths);
  const fake = await startFakeJev(keywordAnswers('auth'));
  process.env.BOUNCER_API_BASE = fake.base;
  const map = await buildMap({ task: 't', prompt: 't', repo, files: paths.map((p) => cand(p)), cfg: { ...cfg, dirPassThreshold: 2 }, apiKey: 'k' });
  await fake.close();
  assert.equal(map.scanned, 3); // src/auth/* + root README.md
  assert.ok(!map.blocked.includes('src/billing/invoice.ts')); // pruned = unscored = never blocked
});
