import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTmp } from './helpers/tmp.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { isCandidatePath, extractSymbols, listFiles, loadCandidates, readHead, repoRoot } from '../lib/files.mjs';

function write(root, rel, content) {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function fixture() {
  const dir = makeTmp();
  const repo = join(dir, 'repo');
  write(repo, 'src/auth/login.ts', 'export function loginHandler() {}\nexport const MAX = 5\nclass Session {}\n');
  write(repo, 'src/billing/invoice.ts', 'export async function createInvoice() {}\n');
  write(repo, 'my folder/notes.md', '# notes\n');
  write(repo, 'node_modules/x/index.js', 'module.exports = 1');
  write(repo, 'dist/bundle.js', 'x');
  write(repo, 'package-lock.json', '{}');
  write(repo, 'logo.png', 'png');
  writeFileSync(join(repo, 'blob.dat'), Buffer.from([1, 0, 2, 3]));
  return { dir, repo };
}

test('isCandidatePath excludes vendored, built, lock and binary paths', () => {
  assert.equal(isCandidatePath('src/a.ts'), true);
  assert.equal(isCandidatePath('node_modules/x/a.js'), false);
  assert.equal(isCandidatePath('packages/web/dist/a.js'), false);
  assert.equal(isCandidatePath('package-lock.json'), false);
  assert.equal(isCandidatePath('yarn.lock'), false);
  assert.equal(isCandidatePath('img/logo.PNG'), false);
  assert.equal(isCandidatePath('app.min.js'), false);
});

test('extractSymbols finds common declarations, dedupes, caps', () => {
  const syms = extractSymbols('function a(){}\nclass B {}\ndef c():\nexport const D = 1\nfunction a(){}\nfn e() {}\n');
  assert.deepEqual(syms, ['a', 'B', 'c', 'D', 'e']);
  assert.equal(extractSymbols('function a(){} function b(){} function c(){}', 2).length, 2);
});

test('listFiles walks a non-git folder (fallback) and keeps spaces in names', () => {
  const { repo } = fixture();
  const files = listFiles(repo, 100);
  assert.ok(files.includes('src/auth/login.ts'));
  assert.ok(files.includes('my folder/notes.md'));
  assert.ok(!files.some((f) => f.startsWith('node_modules/')));
  assert.equal(repoRoot(repo), repo);
});

test('listFiles uses git when available, honouring .gitignore', () => {
  const { repo } = fixture();
  writeFileSync(join(repo, '.gitignore'), 'src/billing/\n');
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
  } catch {
    return; // git unavailable: fallback already covered
  }
  const files = listFiles(repo, 100);
  assert.ok(files.includes('src/auth/login.ts'));
  assert.ok(!files.includes('src/billing/invoice.ts'));
});

test('loadCandidates filters, skips binaries, extracts symbols and caches by mtime', () => {
  const { dir, repo } = fixture();
  const cacheDir = join(dir, 'cache');
  const cands = loadCandidates(repo, DEFAULTS, cacheDir);
  const paths = cands.map((c) => c.path).sort();
  assert.deepEqual(paths, ['my folder/notes.md', 'src/auth/login.ts', 'src/billing/invoice.ts']);
  const login = cands.find((c) => c.path === 'src/auth/login.ts');
  assert.deepEqual(login.symbols, ['loginHandler', 'MAX', 'Session']);
  assert.equal(login.lines, 4);

  // change content but restore mtime: cached symbols are reused
  writeFileSync(join(repo, 'src/auth/login.ts'), 'function other(){}\n');
  const t = new Date(login.mtime);
  utimesSync(join(repo, 'src/auth/login.ts'), t, t);
  const again = loadCandidates(repo, DEFAULTS, cacheDir);
  assert.deepEqual(again.find((c) => c.path === 'src/auth/login.ts').symbols, ['loginHandler', 'MAX', 'Session']);
});

test('loadCandidates respects maxCandidates', () => {
  const { dir, repo } = fixture();
  assert.equal(loadCandidates(repo, { ...DEFAULTS, maxCandidates: 1 }, join(dir, 'c')).length, 1);
});

test('readHead caps lines and chars', () => {
  const { repo } = fixture();
  write(repo, 'long.txt', Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'));
  const head = readHead(repo, 'long.txt', { ...DEFAULTS, headLines: 3 });
  assert.equal(head, 'line 0\nline 1\nline 2');
  assert.equal(readHead(repo, 'long.txt', { ...DEFAULTS, maxHeadChars: 5 }).length, 5);
  assert.equal(readHead(repo, 'missing.txt', DEFAULTS), '');
});
