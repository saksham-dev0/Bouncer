import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeJev, keywordAnswers } from './helpers/fake-jev.mjs';
import { systemOne, askBatched, apiBase } from '../lib/jev.mjs';

const opts = { model: 'jev-latest', timeoutMs: 2000, apiKey: 'k1' };

test('apiBase defaults to TypeSafe and honours BOUNCER_API_BASE', () => {
  delete process.env.BOUNCER_API_BASE;
  assert.equal(apiBase(), 'https://api.typesafe.ai');
  process.env.BOUNCER_API_BASE = 'http://x';
  assert.equal(apiBase(), 'http://x');
  delete process.env.BOUNCER_API_BASE;
});

test('systemOne sends auth + body and returns answers', async () => {
  const fake = await startFakeJev(keywordAnswers('auth'));
  process.env.BOUNCER_API_BASE = fake.base;
  const r = await systemOne({ state: { task: 't' }, questions: { a: { type: 'noul', instructions: 'auth?' } }, ...opts });
  await fake.close();
  assert.equal(r.ok, true);
  assert.equal(r.answers.a.noul, 0.9);
  assert.equal(r.inputTokens, 100);
  assert.equal(fake.calls[0].headers.authorization, 'Bearer k1');
  assert.equal(fake.calls[0].body.model, 'jev-latest');
});

test('systemOne returns http error, never throws', async () => {
  const fake = await startFakeJev(keywordAnswers('x'), { status: 429 });
  process.env.BOUNCER_API_BASE = fake.base;
  const r = await systemOne({ state: {}, questions: { a: { type: 'noul', instructions: 'q' } }, ...opts });
  await fake.close();
  assert.deepEqual([r.ok, r.error], [false, 'http_429']);
});

test('systemOne times out', async () => {
  const fake = await startFakeJev(keywordAnswers('x'), { delayMs: 500 });
  process.env.BOUNCER_API_BASE = fake.base;
  const r = await systemOne({ state: {}, questions: { a: { type: 'noul', instructions: 'q' } }, ...opts, timeoutMs: 50 });
  await fake.close();
  assert.deepEqual([r.ok, r.error], [false, 'timeout']);
});

test('systemOne network error when nothing listens', async () => {
  process.env.BOUNCER_API_BASE = 'http://127.0.0.1:1';
  const r = await systemOne({ state: {}, questions: {}, ...opts });
  assert.deepEqual([r.ok, r.error], [false, 'network']);
});

test('askBatched splits, runs in parallel, merges, and counts failed batches', async () => {
  const questions = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`q${i}`, { type: 'noul', instructions: `auth ${i}` }]));
  const fake = await startFakeJev(keywordAnswers('auth'), { failWhen: (req) => 'q4' in req.questions });
  process.env.BOUNCER_API_BASE = fake.base;
  const r = await askBatched({ state: {}, questions, batchSize: 2, ...opts });
  await fake.close();
  assert.equal(fake.calls.length, 3);
  assert.equal(r.total, 3);
  assert.equal(r.failed, 1);
  assert.deepEqual(Object.keys(r.answers).sort(), ['q0', 'q1', 'q2', 'q3']);
  assert.equal(r.inputTokens, 200);
});
