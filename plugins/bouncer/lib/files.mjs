import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const EXCLUDE_DIR_RE = /(^|\/)(node_modules|dist|build|out|vendor|\.git|\.next|coverage|__pycache__|target)\//;
const EXCLUDE_FILE_RE =
  /(\.lock|\.min\.(js|css)|\.map|\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tar|woff2?|ttf|eot|mp[34]|mov|wasm|so|dylib|dll|exe|bin|jar|class|pyc))$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|go\.sum)$/i;
const SYMBOL_RE =
  /\b(?:function|class|def|fn|func|interface|type|struct|enum|trait)\s+([A-Za-z_$][\w$]*)|\bexport\s+(?:default\s+)?(?:async\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
const MAX_FILE_BYTES = 1_000_000;

export function isCandidatePath(rel) {
  return !EXCLUDE_DIR_RE.test(rel) && !EXCLUDE_FILE_RE.test(rel);
}

export function repoRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return cwd;
  }
}

export function listFiles(repo, max) {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], {
      cwd: repo,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\0').filter(Boolean).slice(0, max);
  } catch {
    return walk(repo, max);
  }
}

function walk(repo, max) {
  const found = [];
  const stack = [''];
  while (stack.length && found.length < max) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(join(repo, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (isCandidatePath(`${rel}/`)) stack.push(rel);
      } else if (entry.isFile()) {
        found.push(rel);
        if (found.length >= max) break;
      }
    }
  }
  return found;
}

export function extractSymbols(text, max = 15) {
  const seen = new Set();
  for (const match of text.matchAll(SYMBOL_RE)) {
    const name = match[1] || match[2];
    if (name && !seen.has(name)) {
      seen.add(name);
      if (seen.size >= max) break;
    }
  }
  return [...seen];
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

export function loadCandidates(repo, cfg, cacheDir) {
  const cacheFile = join(cacheDir, `${createHash('sha1').update(repo).digest('hex').slice(0, 16)}.json`);
  let cache = {};
  try {
    cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
  } catch {
    cache = {};
  }
  const next = {};
  const candidates = [];
  for (const rel of listFiles(repo, cfg.maxCandidates * 4)) {
    if (candidates.length >= cfg.maxCandidates) break;
    if (!isCandidatePath(rel)) continue;
    let st;
    try {
      st = statSync(join(repo, rel));
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
    const mtime = Math.floor(st.mtimeMs); // ms precision survives utimes round-trips
    let entry = cache[rel];
    if (!entry || entry.mtime !== mtime) {
      let buf;
      try {
        buf = readFileSync(join(repo, rel));
      } catch {
        continue;
      }
      entry = isBinary(buf)
        ? { mtime, binary: true }
        : { mtime, size: st.size, lines: buf.toString('utf8').split('\n').length, symbols: extractSymbols(buf.toString('utf8')) };
    }
    next[rel] = entry;
    if (!entry.binary) candidates.push({ path: rel, lines: entry.lines, size: entry.size, symbols: entry.symbols, mtime: entry.mtime });
  }
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(next));
  } catch {
    // cache is an optimisation only
  }
  return candidates;
}

export function readHead(repo, rel, cfg) {
  try {
    return readFileSync(join(repo, rel), 'utf8').split('\n').slice(0, cfg.headLines).join('\n').slice(0, cfg.maxHeadChars);
  } catch {
    return '';
  }
}
