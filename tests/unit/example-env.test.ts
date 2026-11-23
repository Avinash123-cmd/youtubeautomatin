import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('example environment', () => {
  it('uses placeholder origins rather than the existing hosted deployment', () => {
    const text = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    for (const key of ['APP_URL', 'ALLOWED_ORIGINS', 'STORAGE_LOCAL_PUBLIC_BASE_URL', 'YOUTUBE_REDIRECT_URI', 'META_REDIRECT_URI', 'API_INTERNAL_URL']) {
      const value = text.split('\n').find(line => line.startsWith(`${key}=`))?.split('#')[0] ?? '';
      expect(value, `missing ${key}`).toContain('example.com');
      expect(value).not.toMatch(/(?:vercel\.app|onrender\.com)/i);
    }
  });
});
