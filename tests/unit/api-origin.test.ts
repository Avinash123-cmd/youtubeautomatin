import { expect, it } from 'vitest';
import { apiOrigin } from '../../apps/web/lib/api-origin';
it('uses a validated HTTPS origin for hosted proxy builds', () => {
  expect(apiOrigin('https://youtubeautomatin.onrender.com/api/', true)).toBe('https://youtubeautomatin.onrender.com');
  expect(apiOrigin('http://api:4000', false)).toBe('http://api:4000');
});
it.each(['https://user:secret@example.com', 'https://example.com/?token=secret', 'https://example.com/#secret', 'https://example.com/other', 'http://localhost:4000', 'https://127.10.0.1', 'https://[::1]', 'http://api:4000', 'not-a-url'])('rejects unsafe hosted API target %s', raw => { expect(apiOrigin(raw, true)).toBeNull(); });
