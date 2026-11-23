import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const text = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('Python work limit deployment wiring', () => {
  it('documents and passes each limit into both Compose environments', () => {
    const settings = ['AI_ENGINE_MAX_CONCURRENT_WORK', 'VIDEO_PROCESSOR_MAX_CONCURRENT_WORK', 'VIDEO_PROCESSOR_MAX_CONCURRENT_PROBES'];
    const example = text('.env.example');
    const files = ['docker-compose.dev.yml', 'docker-compose.prod.yml'].map(text);
    for (const setting of settings) {
      expect(example).toMatch(new RegExp(`^${setting}=\\d+`, 'm'));
      for (const file of files) expect(file).toContain(`${setting}: \${${setting}:-`);
    }
  });

  it.each(['ai-engine', 'video-processor'])('copies the shared limiter into the %s image', service => {
    expect(text(`infrastructure/docker/${service}.Dockerfile`)).toMatch(/COPY[^\n]*services\/media_paths\.py\s+services\/work_limits\.py\s+\.\/services\//);
  });
});
