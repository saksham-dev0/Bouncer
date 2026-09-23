import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'bouncer-test-'));
  process.env.BOUNCER_HOME = join(dir, 'home');
  return dir;
}
