import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
it.skipIf(process.platform === 'win32')('exits nonzero after repeated worker failures so the platform can restart it', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cf-worker-test-'));
  try {
    mkdirSync(path.join(root, 'bin'));
    writeFileSync(path.join(root, 'bin/node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const result = spawnSync('bash', ['apps/api/scripts/run-workers.sh'], { encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, WORKER_ROLES: 'pipeline', WORKER_MAX_FAILURES: '1' } });
    expect(result.status).toBe(1); expect(result.stdout).toContain('escalating');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
