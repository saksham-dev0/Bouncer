import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Resolve symlinks via the nearest existing ancestor, so /tmp vs /private/tmp and symlinked checkouts compare equal.
function real(p) {
  const tail = [];
  let cur = p;
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

export function decideRead({ session, filePath }) {
  const map = session.map;
  if (!session.active || !map) return { action: 'allow', reason: 'inactive' };
  const abs = real(isAbsolute(filePath) ? resolve(filePath) : resolve(map.repo, filePath));
  const rel = relative(real(map.repo), abs).split(sep).join('/');
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return { action: 'allow', reason: 'outside_repo' };
  if (map.core.includes(rel) || map.supporting.includes(rel)) return { action: 'allow', reason: 'in_map', rel };
  if (session.overridden.includes(rel)) return { action: 'allow', reason: 'overridden', rel };
  if (!map.blocked.includes(rel)) return { action: 'allow', reason: 'not_blocked', rel };
  if (session.denied.includes(rel)) return { action: 'allow', reason: 'retry_override', rel };
  return { action: 'deny', reason: 'blocked', rel };
}

export function denyMessage(rel) {
  return `Bouncer: ${rel} looks unrelated to this task, so it was skipped to save tokens. Read it again if you really need it.`;
}
