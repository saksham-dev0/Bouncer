import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bouncerHome } from './config.mjs';

const logPath = () => join(bouncerHome(), 'log.jsonl');

export function appendLog(entry) {
  try {
    mkdirSync(bouncerHome(), { recursive: true });
    appendFileSync(logPath(), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    // logging must never break a hook
  }
}

export function readLog() {
  let text;
  try {
    text = readFileSync(logPath(), 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}
