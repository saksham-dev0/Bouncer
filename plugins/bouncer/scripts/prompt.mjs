#!/usr/bin/env node
import { join } from 'node:path';
import { readStdinJson, emit } from '../lib/io.mjs';
import { readSession, writeSession } from '../lib/state.mjs';
import { loadConfig, bouncerHome } from '../lib/config.mjs';
import { appendLog } from '../lib/log.mjs';
import { repoRoot, loadCandidates } from '../lib/files.mjs';
import { systemOne } from '../lib/jev.mjs';
import { followupRequest } from '../lib/questions.mjs';
import { buildMap } from '../lib/mapper.mjs';
import { formatMap, summaryLine } from '../lib/format.mjs';

const COMMAND_RE = /^\s*\/bouncer:(on|off|map|stats)\b\s*([\s\S]*)$/;
const NEEDS_CODE_MIN = 0.3;
const FOLLOWUP_MAX = 0.5;

function deactivate(session) {
  session.active = false;
  session.oneShot = false;
  session.map = null;
  session.denied = [];
  session.overridden = [];
}

async function main() {
  const input = await readStdinJson();
  const prompt = String(input.prompt || '');
  const sessionId = input.session_id;
  const cwd = input.cwd || process.cwd();
  if (!sessionId || !prompt) return;

  const session = readSession(sessionId);
  const cmd = prompt.match(COMMAND_RE);

  if (cmd?.[1] === 'on') {
    session.enabled = true;
    writeSession(sessionId, session);
    return;
  }
  if (cmd?.[1] === 'off') {
    session.enabled = false;
    session.task = null;
    deactivate(session);
    writeSession(sessionId, session);
    return;
  }
  if (cmd?.[1] === 'stats') return;

  const oneShot = cmd?.[1] === 'map';
  const taskText = oneShot ? cmd[2].trim() : prompt;

  if (!session.enabled && !oneShot) {
    if (session.map || session.active) {
      session.task = null;
      deactivate(session);
      writeSession(sessionId, session);
    }
    return;
  }
  if (!taskText) return;

  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    deactivate(session);
    writeSession(sessionId, session);
    appendLog({ kind: 'map', status: 'no_key' });
    emit({ systemMessage: 'Bouncer: TYPESAFE_API_KEY is not set, so this prompt has no file map.' });
    return;
  }

  const cfg = loadConfig(cwd);
  const opts = { model: cfg.model, timeoutMs: cfg.timeoutMs, apiKey };
  let task = taskText;

  if (!oneShot && session.task && session.map) {
    const f = await systemOne({ ...followupRequest(session.task, taskText), ...opts });
    if (f.ok) {
      const noul = (k) => (typeof f.answers[k]?.noul === 'number' ? f.answers[k].noul : 1);
      if (noul('needs_code') < NEEDS_CODE_MIN) {
        session.active = false;
        writeSession(sessionId, session);
        appendLog({ kind: 'map', status: 'no_code', inputTokens: f.inputTokens, latencyMs: f.latencyMs });
        return;
      }
      if (noul('new_task') < FOLLOWUP_MAX) {
        if (noul('adds_scope') < FOLLOWUP_MAX) {
          session.active = true;
          writeSession(sessionId, session);
          appendLog({ kind: 'map', status: 'reused', inputTokens: f.inputTokens, latencyMs: f.latencyMs });
          return;
        }
        task = `${session.task}\n${taskText}`;
      }
    }
  }

  const repo = repoRoot(cwd);
  const files = loadCandidates(repo, cfg, join(bouncerHome(), 'cache'));
  const map = await buildMap({ task, prompt: taskText, repo, files, cfg, apiKey });

  if (!map.ok) {
    deactivate(session);
    writeSession(sessionId, session);
    appendLog({ kind: 'map', status: 'failed', error: map.error });
    emit({ systemMessage: `Bouncer: TypeSafe unavailable (${map.error}), continuing without a file map.` });
    return;
  }
  if (!map.needsCode) {
    session.task = task;
    session.active = false;
    writeSession(sessionId, session);
    appendLog({ kind: 'map', status: 'no_code', inputTokens: map.inputTokens, latencyMs: map.latencyMs });
    return;
  }

  Object.assign(session, { task, map, active: true, oneShot, denied: [], overridden: [] });
  writeSession(sessionId, session);
  appendLog({
    kind: 'map',
    status: 'mapped',
    repo,
    scanned: map.scanned,
    suggested: map.core.length + map.supporting.length,
    blocked: map.blocked.length,
    inputTokens: map.inputTokens,
    latencyMs: map.latencyMs,
    partial: map.partial,
    model: map.model,
  });
  emit({
    systemMessage: summaryLine(map),
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: formatMap(map) },
  });
}

main().catch(() => {});
