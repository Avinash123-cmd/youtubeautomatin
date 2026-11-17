import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const manifest = (relative: string) => JSON.parse(readFileSync(path.join(root, relative, 'package.json'), 'utf8'));

describe('validation workspace runtime entry (no Vitest source aliases)', () => {
  it.each(['apps/web', 'apps/api'])('loads actual built Zod exports from %s', app => {
    // A fresh Node process deliberately bypasses this suite\'s source aliases and module cache.
    const output = execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const entry = require.resolve('@clipforge/validation');
      const schemas = require('@clipforge/validation');
      const { z } = require('zod');
      for (const name of ['botProvidersResponseSchema', 'botLoginStatusResponseSchema', 'botChallengeResponseSchema', 'botLoginCompleteResponseSchema']) {
        assert(schemas[name] instanceof z.ZodType, name + ' must be an initialized Zod schema');
        assert.equal(typeof schemas[name].safeParse, 'function');
      }
      const providers = schemas.botProvidersResponseSchema.safeParse({ telegram: { enabled: false } });
      assert.equal(providers.success, true);
      assert.deepEqual(providers.data.telegram.missing, []);
      assert.equal(schemas.botProvidersResponseSchema.safeParse({ telegram: { enabled: false, missing: null } }).success, false);
      assert.equal(schemas.botLoginStatusResponseSchema.safeParse({ state: 'IDLE' }).success, true);
      assert.equal(schemas.botLoginStatusResponseSchema.safeParse({ state: 'VERIFYING' }).success, false);
      console.log(entry);
    `], { cwd: path.join(root, app), encoding: 'utf8' });
    expect(output.replaceAll('\\', '/')).toContain('/packages/validation/dist/index.js');
  });

  it('refreshes runtime and declaration artifacts before frontend/API entry commands', () => {
    for (const app of ['apps/web', 'apps/api']) {
      const pkg = manifest(app);
      for (const hook of ['predev', 'prebuild', 'pretypecheck']) {
        expect(pkg.scripts[hook]).toBe(app === 'apps/api'
          ? 'npm run build -w @clipforge/validation -w @clipforge/platform-connectors -w @clipforge/database'
          : 'npm run build -w @clipforge/validation');
      }
    }
    const validation = manifest('packages/validation');
    expect(validation.dependencies['@clipforge/shared-types']).toBe('1.0.0');
    expect(validation.devDependencies['@clipforge/shared-types']).toBeUndefined();
    expect(validation.main).toBe('dist/index.js');
    expect(validation.types).toBe('dist/index.d.ts');
    expect(validation.scripts.prebuild).toBe('npm run build -w @clipforge/shared-types');
  });
});

it('loads all backend runtime workspace entries and generated Prisma models without aliases', () => {
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    for (const name of ['database', 'platform-connectors', 'validation', 'shared-types']) {
      assert(require.resolve('@clipforge/' + name).replaceAll('\\\\', '/').endsWith('/dist/index.js'));
      assert(require('@clipforge/' + name));
    }
    const { Prisma, OtpChannel, OtpMode, OtpPurpose } = require('@prisma/client');
    assert(OtpChannel && OtpMode && OtpPurpose);
    assert(Prisma.dmmf.datamodel.models.some(model => model.name === 'SourceVideo'));
  `], { cwd: path.join(root, 'apps/api'), encoding: 'utf8' });
  const pkg = manifest('.');
  expect(pkg.scripts['build:api']).toBe('npm run build -w @clipforge/api');
  expect(pkg.scripts['start:api']).toBe('npm run start -w @clipforge/api');
});
