import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

describe('root environment loading in a fresh Node process', () => {
  it('loads root .env from API and arbitrary working directories without overriding injected vars', () => {
    const root = mkdtempSync(join(tmpdir(), 'clipforge-env-'));
    try {
      const dist = join(root, 'apps/api/dist');
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(root, '.env'), 'CF_ENV_PROBE=root-file\nCF_INJECTED_PROBE=must-not-win\n');
      const source = readFileSync('apps/api/src/load-env.ts', 'utf8');
      writeFileSync(join(dist, 'load-env.js'), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText);
      const script = `require(${JSON.stringify(join(dist, 'load-env.js'))}); console.log(process.env.CF_ENV_PROBE + ':' + process.env.CF_INJECTED_PROBE)`;
      for (const cwd of [root, join(root, 'apps/api'), tmpdir()]) {
        const result = execFileSync(process.execPath, ['-e', script], { cwd, env: { ...process.env, CF_INJECTED_PROBE: 'injected' }, encoding: 'utf8' });
        expect(result.trim()).toBe('root-file:injected');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
