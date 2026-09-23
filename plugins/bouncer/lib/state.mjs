import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bouncerHome } from './config.mjs';

export function emptySession() {
  return { enabled: false, active: false, oneShot: false, task: null, map: null, denied: [], overridden: [] };
}

export function sessionPath(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'unknown';
  return join(bouncerHome(), 'sessions', `${safe}.json`);
}

export function readSession(sessionId) {
  try {
    return { ...emptySession(), ...JSON.parse(readFileSync(sessionPath(sessionId), 'utf8')) };
  } catch {
    return emptySession();
  }
}

export function writeSession(sessionId, session) {
  const path = sessionPath(sessionId);
  mkdirSync(join(bouncerHome(), 'sessions'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(session));
  renameSync(tmp, path);
}
