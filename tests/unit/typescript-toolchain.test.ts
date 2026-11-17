import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const { checkTypeScript } = createRequire(import.meta.url)('../../scripts/check-typescript.cjs');

describe('consistent monorepo compiler', () => {
  it('verifies every real workspace resolves the exact locked compiler', () => {
    expect(checkTypeScript()).toBe('5.9.3');
  });
  it.each([
    { actual: '6.0.0', locked: '5.9.3', pin: '5.9.3', message: 'resolves TypeScript 6.0.0' },
    { actual: '5.9.3', locked: '6.0.0', pin: '5.9.3', message: 'incompatible TypeScript' },
    { actual: '5.9.3', locked: '5.9.3', pin: '^5.9.3', message: 'exact version' },
  ])('rejects drift before invoking tsc: %j', ({ actual, locked, pin, message }) => {
    const root = mkdtempSync(path.join(tmpdir(), 'clipforge-compiler-'));
    const json = (file: string, body: unknown) => writeFileSync(path.join(root, file), JSON.stringify(body));
    try {
      json('package.json', { name: 'fixture', workspaces: [], devDependencies: { typescript: pin }, overrides: { typescript: '$typescript' } });
      json('package-lock.json', { packages: { '': { devDependencies: { typescript: pin } }, 'node_modules/typescript': { version: locked } } });
      mkdirSync(path.join(root, 'node_modules/typescript'), { recursive: true });
      json('node_modules/typescript/package.json', { main: 'index.js' });
      writeFileSync(path.join(root, 'node_modules/typescript/index.js'), `exports.version = ${JSON.stringify(actual)};`);
      expect(() => checkTypeScript(root)).toThrow(message);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
