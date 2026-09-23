#!/usr/bin/env node
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { readStdinJson, emit } from '../lib/io.mjs';
import { readSession, writeSession } from '../lib/state.mjs';
import { appendLog } from '../lib/log.mjs';
import { decideRead, denyMessage } from '../lib/gate.mjs';

async function main() {
  const input = await readStdinJson();
  if (input.tool_name !== 'Read' || !input.session_id) return;
  const filePath = input.tool_input?.file_path;
  if (typeof filePath !== 'string' || !filePath) return;
  if (input.agent_id) return; // subagents have their own task; never gate them

  const session = readSession(input.session_id);
  const decision = decideRead({ session, filePath });
  if (decision.reason === 'inactive') return;

  if (decision.action === 'deny') {
    let bytes = 0;
    try {
      bytes = statSync(join(session.map.repo, decision.rel)).size;
    } catch {
      bytes = 0;
    }
    session.denied.push(decision.rel);
    writeSession(input.session_id, session);
    appendLog({ kind: 'read', reason: decision.reason, rel: decision.rel, bytes });
    emit({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denyMessage(decision.rel),
      },
    });
    return;
  }

  if (decision.reason === 'retry_override') {
    session.denied = session.denied.filter((p) => p !== decision.rel);
    session.overridden.push(decision.rel);
    writeSession(input.session_id, session);
  }
  appendLog({ kind: 'read', reason: decision.reason, rel: decision.rel });
}

main().catch(() => {});
