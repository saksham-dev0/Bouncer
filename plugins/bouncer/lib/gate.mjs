import { isAbsolute, relative, resolve, sep } from 'node:path';

export function decideRead({ session, filePath }) {
  const map = session.map;
  if (!session.active || !map) return { action: 'allow', reason: 'inactive' };
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(map.repo, filePath);
  const rel = relative(map.repo, abs).split(sep).join('/');
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { action: 'allow', reason: 'outside_repo' };
  if (map.core.includes(rel) || map.supporting.includes(rel)) return { action: 'allow', reason: 'in_map', rel };
  if (session.overridden.includes(rel)) return { action: 'allow', reason: 'overridden', rel };
  if (!map.blocked.includes(rel)) return { action: 'allow', reason: 'not_blocked', rel };
  if (session.denied.includes(rel)) return { action: 'allow', reason: 'retry_override', rel };
  return { action: 'deny', reason: 'blocked', rel };
}

export function denyMessage(rel) {
  return `Bouncer: ${rel} looks unrelated to this task, so it was skipped to save tokens. Read it again if you really need it.`;
}
