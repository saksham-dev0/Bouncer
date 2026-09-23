import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULTS = {
  privacy: 'content',
  maxSuggested: 10,
  closeLookTopK: 20,
  blockBelow: 0.15,
  tinyFileLines: 30,
  timeoutMs: 8000,
  model: 'jev-latest',
  skimBatchSize: 300,
  maxCandidates: 5000,
  dirPassThreshold: 1500,
  headLines: 40,
  maxHeadChars: 4000,
};

export function bouncerHome() {
  return process.env.BOUNCER_HOME || join(homedir(), '.claude', 'bouncer');
}

function readJson(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

export function loadConfig(cwd) {
  const cfg = {
    ...DEFAULTS,
    ...readJson(join(bouncerHome(), 'config.json')),
    ...readJson(join(cwd, '.claude', 'bouncer.json')),
  };
  if (process.env.BOUNCER_PRIVACY) cfg.privacy = process.env.BOUNCER_PRIVACY;
  return cfg;
}
