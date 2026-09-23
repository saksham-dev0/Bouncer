const USD_PER_TOKEN = 0.042 / 1e6; // jev-1.13 input price; output is free
const BYTES_PER_TOKEN = 4;

export function summarize(rows, sinceMs) {
  const s = { mapped: 0, reused: 0, noCode: 0, failed: 0, scanned: 0, suggested: 0, inputTokens: 0, latencySum: 0, readInMap: 0, skipped: 0, skippedBytes: 0, overridden: 0 };
  for (const r of rows) {
    if (Date.parse(r.ts) < sinceMs) continue;
    if (r.kind === 'map') {
      s.inputTokens += r.inputTokens || 0;
      if (r.status === 'mapped') {
        s.mapped++;
        s.scanned += r.scanned || 0;
        s.suggested += r.suggested || 0;
        s.latencySum += r.latencyMs || 0;
      } else if (r.status === 'reused') s.reused++;
      else if (r.status === 'no_code') s.noCode++;
      else s.failed++;
    } else if (r.kind === 'read') {
      if (r.reason === 'in_map') s.readInMap++;
      else if (r.reason === 'blocked') {
        s.skipped++;
        s.skippedBytes += r.bytes || 0;
      } else if (r.reason === 'retry_override') s.overridden++;
    }
  }
  return {
    ...s,
    tokensSaved: Math.round(s.skippedBytes / BYTES_PER_TOKEN),
    avgLatencyMs: s.mapped ? Math.round(s.latencySum / s.mapped) : 0,
    costUsd: s.inputTokens * USD_PER_TOKEN,
  };
}

export function renderStats(s) {
  if (!s.mapped && !s.reused && !s.noCode && !s.failed) return 'No Bouncer activity yet. Run /bouncer:on, then send a prompt.';
  const n = (x) => x.toLocaleString('en-US');
  const overrideRate = s.skipped ? Math.round((s.overridden / s.skipped) * 100) : 0;
  return [
    'Bouncer — last 7 days',
    `  prompts mapped    ${n(s.mapped)}   (reused ${s.reused}, no-code ${s.noCode}, failed ${s.failed})`,
    `  files scanned     ${n(s.scanned)}   (Jev ≈ $${s.costUsd.toFixed(4)}, avg ${(s.avgLatencyMs / 1000).toFixed(1)}s per map)`,
    `  suggested files   ${n(s.suggested)}   → Claude read ${n(s.readInMap)} of them`,
    `  reads skipped     ${n(s.skipped)} (≈ ${n(s.tokensSaved)} tokens not loaded) · overridden ${s.overridden}`,
    `  override rate ${overrideRate}%${overrideRate > 20 ? '  ← high: lower blockBelow in config' : ''}`,
  ].join('\n');
}
