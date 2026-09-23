export function formatMap(map) {
  const lines = [`Bouncer file map for this task (TypeSafe Jev, ${map.scanned} files scanned):`];
  if (!map.core.length && !map.supporting.length) {
    lines.push('No files stood out as clearly relevant. Explore as needed; reads of files judged unrelated will be skipped.');
    return lines.join('\n');
  }
  if (map.core.length) lines.push(`core: ${map.core.join(', ')}`);
  if (map.supporting.length) lines.push(`supporting: ${map.supporting.join(', ')}`);
  lines.push(
    'Start with these. Avoid broad exploration; reads of files judged unrelated will be skipped. Ignore this map if it clearly does not fit the task.',
  );
  return lines.join('\n');
}

export function summaryLine(map) {
  const picked = map.core.length + map.supporting.length;
  return `Bouncer: ${map.scanned} files scanned → ${picked} picked (${(map.latencyMs / 1000).toFixed(1)}s)`;
}
