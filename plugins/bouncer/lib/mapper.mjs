import { basename } from 'node:path';
import { askBatched, systemOne } from './jev.mjs';
import { NEEDS_CODE_Q, skimQuestion, closeLookQuestion, dirQuestion } from './questions.mjs';
import { readHead } from './files.mjs';

const CONTEXT_FILE_RE =
  /(^|\/)(readme[^/]*|package\.json|pyproject\.toml|cargo\.toml|go\.mod|tsconfig[^/]*\.json|claude\.md|agents\.md|makefile|dockerfile)$|(^|\/)(index|main|app|server)\.[a-z]+$/i;
const CORE_MIN = 2.5;
const SUPPORTING_MIN = 1.5;
const NEEDS_CODE_MIN = 0.3;
const DIR_KEEP_MIN = 0.3;
const SKIM_FALLBACK_MIN = 0.6;
const CLOSE_LOOK_MIN_MS = 2000; // skip the close look when less budget than this remains

export function isContextFile(rel) {
  return CONTEXT_FILE_RE.test(rel);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function namedInPrompt(prompt, paths) {
  const text = String(prompt).toLowerCase();
  return paths.filter((p) => {
    const lower = p.toLowerCase();
    const base = basename(lower);
    const stem = base.replace(/\.[^.]+$/, '');
    return (
      text.includes(lower) ||
      (base.length >= 4 && base.includes('.') && text.includes(base)) ||
      (stem.length >= 5 && new RegExp(`\\b${escapeRe(stem)}\\b`).test(text))
    );
  });
}

export function classify({ files, skim, close, named, cfg }) {
  const core = [];
  const supporting = [];
  const add = (list, path) => {
    if (core.length + supporting.length < cfg.maxSuggested && !core.includes(path) && !supporting.includes(path)) list.push(path);
  };
  for (const path of named) add(core, path);
  const ranked = Object.entries(close).sort((a, b) => b[1] - a[1]);
  for (const [path, score] of ranked) {
    if (score >= CORE_MIN) add(core, path);
    else if (score >= SUPPORTING_MIN) add(supporting, path);
  }
  const suggested = new Set([...core, ...supporting, ...named]);
  const blocked = files
    .filter((f) => skim[f.path] !== undefined && skim[f.path] < cfg.blockBelow)
    .filter((f) => !suggested.has(f.path) && !isContextFile(f.path) && f.lines > cfg.tinyFileLines)
    .map((f) => f.path);
  return { core, supporting, blocked };
}

function groupKey(rel) {
  const parts = rel.split('/');
  return parts.length === 1 ? '' : parts.slice(0, Math.min(2, parts.length - 1)).join('/');
}

async function directoryPass(files, state, opts, cfg) {
  const groups = new Map();
  for (const f of files) {
    const key = groupKey(f.path);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const dirs = [...groups.keys()].filter((d) => d !== '');
  const questions = Object.fromEntries(dirs.map((d, i) => [`d_${i}`, dirQuestion(d, groups.get(d).slice(0, 10).map((f) => f.path))]));
  const r = await askBatched({ state, questions, batchSize: cfg.skimBatchSize, ...opts });
  const keep = new Set(['']);
  dirs.forEach((d, i) => {
    const a = r.answers[`d_${i}`];
    if (!a || a.noul >= DIR_KEEP_MIN) keep.add(d);
  });
  return { pool: files.filter((f) => keep.has(groupKey(f.path))), inputTokens: r.inputTokens, latencyMs: r.latencyMs };
}

export async function buildMap({ task, prompt, repo, files, cfg, apiKey, deadline = Date.now() + cfg.budgetMs }) {
  const remaining = () => deadline - Date.now();
  const callOpts = () => ({ model: cfg.model, apiKey, timeoutMs: Math.max(1, Math.min(cfg.timeoutMs, remaining())) });
  const state = { task };
  let pool = files;
  let inputTokens = 0;
  let latencyMs = 0;

  if (remaining() <= 0) return { ok: false, error: 'budget' };
  if (files.length > cfg.dirPassThreshold) {
    const d = await directoryPass(files, state, callOpts(), cfg);
    pool = d.pool;
    inputTokens += d.inputTokens;
    latencyMs += d.latencyMs;
  }

  const keyToPath = new Map();
  const skimQs = { needs_code: NEEDS_CODE_Q };
  pool.forEach((f, i) => {
    keyToPath.set(`f_${i}`, f.path);
    skimQs[`f_${i}`] = skimQuestion(f);
  });
  if (remaining() <= 0) return { ok: false, error: 'budget' };
  const s = await askBatched({ state, questions: skimQs, batchSize: cfg.skimBatchSize, ...callOpts() });
  inputTokens += s.inputTokens;
  latencyMs += s.latencyMs;
  if (s.failed === s.total) return { ok: false, error: 'jev_unavailable' };

  const needsCode = s.answers.needs_code?.noul;
  if (needsCode !== undefined && needsCode < NEEDS_CODE_MIN) return { ok: true, needsCode: false, inputTokens, latencyMs };

  const skim = {};
  for (const [key, path] of keyToPath) {
    const a = s.answers[key];
    if (a && typeof a.noul === 'number') skim[path] = a.noul;
  }

  const named = namedInPrompt(prompt, pool.map((f) => f.path));
  const top = [...new Set([...named, ...Object.entries(skim).sort((a, b) => b[1] - a[1]).map(([p]) => p)])].slice(0, cfg.closeLookTopK + named.length);
  const byPath = new Map(pool.map((f) => [f.path, f]));
  const closeQs = {};
  top.forEach((path, i) => {
    const detail = cfg.privacy === 'symbols' ? { symbols: byPath.get(path)?.symbols || [] } : { head: readHead(repo, path, cfg) };
    closeQs[`r_${i}`] = closeLookQuestion(path, detail);
  });

  let close = {};
  if (top.length) {
    const c =
      remaining() >= CLOSE_LOOK_MIN_MS ? await systemOne({ state, questions: closeQs, ...callOpts() }) : { ok: false, error: 'budget', latencyMs: 0 };
    latencyMs += c.latencyMs;
    if (c.ok) {
      inputTokens += c.inputTokens;
      top.forEach((path, i) => {
        const a = c.answers[`r_${i}`];
        if (a && typeof a.score === 'number') close[path] = a.score;
      });
    } else {
      // close look failed: fall back to strong skim scores as "supporting"
      close = Object.fromEntries(top.filter((p) => skim[p] >= SKIM_FALLBACK_MIN).map((p) => [p, SUPPORTING_MIN]));
    }
  }

  const { core, supporting, blocked } = classify({ files: pool, skim, close, named, cfg });
  return {
    ok: true,
    needsCode: true,
    task,
    repo,
    scanned: pool.length,
    core,
    supporting,
    blocked,
    inputTokens,
    latencyMs,
    partial: s.failed > 0,
    model: s.model,
  };
}
