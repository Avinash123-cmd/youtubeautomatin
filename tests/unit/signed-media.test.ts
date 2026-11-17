import 'reflect-metadata';
import { beforeEach, expect, it, vi } from 'vitest';
const config = vi.hoisted(() => ({ STORAGE_DRIVER: 's3', S3_ENDPOINT: 'https://objects.example.com', S3_REGION: 'us-east-1', S3_BUCKET: 'private-media', S3_ACCESS_KEY_ID: 'isolated-test-access', S3_SECRET_ACCESS_KEY: 'isolated-test-signing-secret', S3_FORCE_PATH_STYLE: true }));
vi.mock('../../apps/api/src/common/env', () => ({ env: config }));
import { StorageService } from '../../apps/api/src/storage/storage.service';
beforeEach(() => { config.STORAGE_DRIVER = 's3'; config.S3_ENDPOINT = 'https://objects.example.com'; });
it('signs private object GET access with a bounded expiry without a public bucket or network request', async () => {
  const storage = new StorageService();
  const url = new URL((await storage.platformReadUrl('ws/a/clips/clip.mp4', 600))!);
  expect(url.protocol).toBe('https:'); expect(url.pathname).toBe('/private-media/ws/a/clips/clip.mp4');
  expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
  expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
  expect(url.toString()).not.toContain(config.S3_SECRET_ACCESS_KEY);
  expect(storage.publicUrl('ws/a/clips/clip.mp4')).toBeNull();
});
it('rejects traversal and unbounded signature lifetime', async () => {
  const storage = new StorageService();
  await expect(storage.platformReadUrl('../outside')).rejects.toThrow();
  await expect(storage.platformReadUrl('clip.mp4', 86401)).rejects.toThrow();
});
it('does not pretend authenticated local routes can be fetched by Instagram', async () => {
  config.STORAGE_DRIVER = 'local'; const storage = new StorageService();
  expect(await storage.platformReadUrl('clip.mp4')).toBeNull();
  expect((await storage.expectPublicHttps()).ok).toBe(false);
});
it('does not issue platform URLs for plaintext S3 endpoints', async () => {
  config.S3_ENDPOINT = 'http://objects.example.com';
  expect(await new StorageService().platformReadUrl('clip.mp4')).toBeNull();
});
