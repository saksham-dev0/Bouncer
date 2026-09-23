#!/usr/bin/env node
// Manual: node plugins/bouncer/scripts/map-cli.mjs --task "add rate limiting to /login" --repo .
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { loadConfig, bouncerHome } from '../lib/config.mjs';
import { loadCandidates, repoRoot } from '../lib/files.mjs';
import { buildMap } from '../lib/mapper.mjs';
import { formatMap, summaryLine } from '../lib/format.mjs';

const { values } = parseArgs({ options: { task: { type: 'string' }, repo: { type: 'string', default: '.' } } });
if (!values.task) {
  console.error('usage: map-cli.mjs --task "<task>" [--repo <dir>]');
  process.exitCode = 2;
} else if (!process.env.TYPESAFE_API_KEY) {
  console.error('TYPESAFE_API_KEY is not set');
  process.exitCode = 2;
} else {
  const repo = repoRoot(resolve(values.repo));
  const cfg = loadConfig(repo);
  const files = loadCandidates(repo, cfg, join(bouncerHome(), 'cache'));
  const map = await buildMap({ task: values.task, prompt: values.task, repo, files, cfg, apiKey: process.env.TYPESAFE_API_KEY });
  if (!map.ok) console.log(`Jev unavailable: ${map.error}`);
  else if (!map.needsCode) console.log('Task does not need code files; no map.');
  else {
    console.log(summaryLine(map));
    console.log(formatMap(map));
    console.log(`blocked: ${map.blocked.length} files · tokens ${map.inputTokens}${map.partial ? ' · PARTIAL' : ''}`);
  }
}
