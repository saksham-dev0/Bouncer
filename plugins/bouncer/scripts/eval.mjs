#!/usr/bin/env node
// node plugins/bouncer/scripts/eval.mjs [bench/tasks.jsonl]
// Each line: {"repo": "<path, relative to the current directory or absolute>", "task": "...", "needed": ["repo/relative/path", ...]}
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, bouncerHome } from '../lib/config.mjs';
import { loadCandidates } from '../lib/files.mjs';
import { buildMap } from '../lib/mapper.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const benchPath = process.argv[2] || join(here, '..', 'bench', 'tasks.jsonl');
const cases = readFileSync(benchPath, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('//')).map((l) => JSON.parse(l));
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error('TYPESAFE_API_KEY is not set');
  process.exitCode = 2;
} else {
  let needed = 0, found = 0, wronglyBlocked = 0, suggested = 0;
  for (const c of cases) {
    const repo = resolve(c.repo);
    const cfg = loadConfig(repo);
    const files = loadCandidates(repo, cfg, join(bouncerHome(), 'cache'));
    const map = await buildMap({ task: c.task, prompt: c.task, repo, files, cfg, apiKey });
    if (!map.ok || !map.needsCode) {
      console.log(`SKIP  ${c.task}  (${map.ok ? 'no code needed' : map.error})`);
      continue;
    }
    const picked = new Set([...map.core, ...map.supporting]);
    const hit = c.needed.filter((p) => picked.has(p));
    const bad = c.needed.filter((p) => map.blocked.includes(p));
    needed += c.needed.length;
    found += hit.length;
    wronglyBlocked += bad.length;
    suggested += picked.size;
    console.log(`${bad.length ? 'FAIL' : 'ok  '}  recall ${hit.length}/${c.needed.length}  picked ${picked.size}  blocked ${map.blocked.length}  ${map.latencyMs}ms  ${c.task}`);
    for (const p of bad) console.log(`        wrongly blocked: ${p}`);
  }
  console.log(`\nrecall ${(found / Math.max(needed, 1)).toFixed(2)} (target ≥ 0.80) · wrongly blocked ${wronglyBlocked} (target 0) · avg picked ${(suggested / Math.max(cases.length, 1)).toFixed(1)}`);
}
