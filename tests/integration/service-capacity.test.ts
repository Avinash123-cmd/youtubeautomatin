/**
 * Opt-in: real PostgreSQL and a disposable Redis/BullMQ. The production pipeline/render
 * handlers and lease/recovery code run against stubbed service HTTP, storage and config.
 * Set DATABASE_URL (or .env) and REDIS_TEST_BINARY to an executable redis-server.
 */
import 'reflect-metadata';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, Worker, type Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  env: {
    NODE_ENV: 'test', LOG_LEVEL: 'error', WORK_DIR: '',
    WORKER_CONCURRENCY_AI: 1, WORKER_CONCURRENCY_RENDER: 1,
    JOB_LEASE_SECONDS: 3, JOB_HEARTBEAT_SECONDS: 0.5,
    AI_ENGINE_URL: 'http://ai.test', AI_ENGINE_API_KEY: 'test-key',
    VIDEO_PROCESSOR_URL: 'http://video.test', VIDEO_PROCESSOR_API_KEY: 'test-key',
    PRICE_GEMINI_INPUT_PER_1K_TOKENS: 0, PRICE_GEMINI_OUTPUT_PER_1K_TOKENS: 0,
    PRICE_VISION_INPUT_PER_1K_TOKENS: 0, PRICE_VISION_OUTPUT_PER_1K_TOKENS: 0,
    PRICE_TRANSCRIPTION_PER_SECOND: 0, PRICE_RENDER_PER_SECOND: 0,
    PRICE_STORAGE_PER_GB_MONTH: 0, PRICE_PUBLISH_CALL: 0,
  },
  handlers: {} as Record<string, (job: Job) => Promise<void>>,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../apps/api/src/common/env', () => ({ env: state.env, loadEnv: () => state.env }));
vi.mock('../../apps/api/src/common/services/config.service', () => ({
  AppConfigService: class {
    async resolveForProcessing() {
      return {
        aiTextModel: 'fixture', aiVisionModel: 'fixture', maxCandidatesPerCall: 12,
        maxOutputClips: 6, duplicateThreshold: 0.35, renderWidth: 1080, renderHeight: 1920,
        renderFps: 30, renderBitrateKbps: 2000, loudnessTargetLufs: -14,
      };
    }
  },
}));
vi.mock('../../apps/api/src/storage/storage.service', () => ({
  StorageService: class {
    driver = 'test';
    async downloadToFile() {}
    async exists() { return false; }
    async putFile(key: string) { return { key, sizeBytes: 10 }; }
  },
}));
vi.mock('../../apps/api/src/notifications/notifications.service', () => ({
  NotificationsService: class { async notify() {} },
}));
// Capture the real handler without starting production runtimes. Keep the real lease renewal.
vi.mock('../../apps/api/src/workers/base', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../apps/api/src/workers/base')>();
  return {
    ...original,
    createRuntime: (role: string) => ({ workerId: `${role}-integration`, logger: state.logger }),
    createWorker: (name: string, _runtime: unknown, handler: (job: Job) => Promise<void>) => { state.handlers[name] = handler; return {}; },
    wireShutdown: () => {},
  };
});

const enabled = !!process.env.REDIS_TEST_BINARY && (!!process.env.DATABASE_URL || existsSync('.env'));

describe.skipIf(!enabled)('capacity handling with real leases, recovery and BullMQ', () => {
  let db: typeof import('@clipforge/database');
  let dir = '', socket = '', workspaceId = '', userId = '', sourceId = '', presetId = '';
  let redis: ChildProcessWithoutNullStreams;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
    dir = await mkdtemp(join(tmpdir(), 'clipforge-capacity-'));
    socket = join(dir, 'redis.sock');
    state.env.WORK_DIR = join(dir, 'work');
    redis = spawn(process.env.REDIS_TEST_BINARY!, ['--port', '0', '--unixsocket', socket, '--unixsocketperm', '700', '--save', '', '--appendonly', 'no']);
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Redis did not start: ${output}`)), 5000);
      redis.once('error', error => { clearTimeout(timer); reject(error); });
      redis.once('exit', code => { clearTimeout(timer); reject(new Error(`Redis exited early: ${code}`)); });
      redis.stdout.on('data', chunk => {
        output += chunk.toString();
        if (/ready to accept connections/i.test(output)) { clearTimeout(timer); resolve(); }
      });
    });
    db = await import('@clipforge/database');
    const suffix = randomUUID();
    const user = await db.prisma.user.create({ data: { email: `capacity-${suffix}@example.test`, displayName: 'Capacity test' } });
    userId = user.id;
    const workspace = await db.prisma.workspace.create({ data: { name: 'Capacity test', slug: `capacity-${suffix}` } });
    workspaceId = workspace.id;
    const source = await db.prisma.sourceVideo.create({ data: {
      workspaceId, createdById: userId, kind: 'UPLOAD', status: 'VALIDATED', storageKey: 'test/source.mp4', durationSeconds: 30,
    } });
    sourceId = source.id;
    const preset = await db.prisma.subtitlePreset.create({ data: { workspaceId, name: 'Test', style: {} } });
    presetId = preset.id;
    await import('../../apps/api/src/workers/pipeline.worker');
    await import('../../apps/api/src/workers/render.worker');
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (db) {
      if (workspaceId) {
        const jobs = await db.prisma.processingJob.findMany({ where: { workspaceId }, include: { clips: true } });
        const aggregateIds = jobs.flatMap(job => [job.id, ...job.clips.map(clip => clip.id)]);
        await db.prisma.outboxEvent.deleteMany({ where: { aggregateId: { in: aggregateIds } } });
        await db.prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
      }
      if (userId) await db.prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
      await db.prisma.$disconnect();
    }
    if (redis && redis.exitCode === null) {
      const exited = once(redis, 'exit');
      redis.kill('SIGTERM');
      await exited;
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function createJob() {
    const job = await db.createProcessingJob({
      workspaceId, sourceVideoId: sourceId, createdById: userId,
      configuration: {
        framingMode: 'center_crop', framingFallback: 'center_crop', subtitlePresetId: presetId,
        subtitleLanguage: 'en', targetDurations: [15], maxClips: 1, minQualityScore: 70,
        autoPublish: false, platforms: [],
      },
    });
    await db.transitionJob(job.id, 'PROBING');
    await db.transitionJob(job.id, 'TRANSCRIBING');
    await db.transitionJob(job.id, 'AI_ANALYSIS');
    await db.prisma.transcript.create({ data: {
      workspaceId, sourceVideoId: sourceId, jobId: job.id, language: 'en', languageProbability: 1,
      provider: 'fixture', model: 'fixture', wordTimestamps: true, durationSeconds: 30, fullText: 'hello world',
      segments: { create: [{ sequence: 0, startSeconds: 0, endSeconds: 15, text: 'hello world', words: [{ word: 'hello', start: 1, end: 2, probability: 1 }] }] },
    } });
    return job;
  }

  function delivery(queueName: string, handlerName: string) {
    const connection = { path: socket, maxRetriesPerRequest: null };
    const prefix = `capacity-${randomUUID()}`;
    const queue = new Queue(queueName, { connection, prefix });
    const worker = new Worker(queueName, job => state.handlers[handlerName](job), {
      // Shorter than the capacity wait: BullMQ must renew its lock as well as the DB lease.
      connection, prefix, lockDuration: 3_000, stalledInterval: 2_000,
    });
    const completed = new Promise<Job>((resolve, reject) => {
      worker.once('completed', resolve);
      worker.once('failed', (_job, error) => reject(error));
      worker.once('error', reject);
    });
    // A failed handler may finish before the assertions below reach the promise.
    void completed.catch(() => undefined);
    return { queue, worker, completed };
  }

  async function waitForRefusal(signal: Promise<void>, completed: Promise<Job>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        signal,
        completed.then(() => { throw new Error('Delivery completed before the capacity refusal'); }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('No capacity response received')), 5_000); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const busy = () => new Response(JSON.stringify({ detail: {
    code: 'SERVICE_CAPACITY_EXHAUSTED', message: 'busy', retryable: true,
  } }), { status: 503, headers: { 'retry-after': '5' } });

  it('keeps the same job active across caption and render pressure without redoing analysis or recovery', async () => {
    const job = await createJob();
    const candidate = { start_time: 0, end_time: 15, target_duration: 15, hook: 'Hook', reason: 'Complete',
      transcript: 'hello world', content_category: 'educational', quality_score: 90, confidence: 0.9, visual_context: '', scores: {} };
    let analyzeCalls = 0, captionCalls = 0, renderCalls = 0;
    let captionBusy!: () => void, renderBusy!: () => void;
    const captionRefused = new Promise<void>(resolve => { captionBusy = resolve; });
    const renderRefused = new Promise<void>(resolve => { renderBusy = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string, request: RequestInit) => {
      if (url.endsWith('/analyze')) {
        analyzeCalls++;
        return new Response(JSON.stringify({ plan: [{ candidate, duration_kind: 15, start_time: 0, end_time: 15, derived: false }],
          report: { provider: 'fixture', clips_planned: 1, usage: { text: { total_tokens: 100, prompt_tokens: 90, candidate_tokens: 10 } } },
          variant_decisions: [], rejected_candidates: [], duplicates_dropped: [] }));
      }
      if (url.endsWith('/captions')) {
        captionCalls++;
        if (captionCalls === 1) { captionBusy(); return busy(); }
        return new Response(JSON.stringify({ results: [{ clipId: `${job.id}-0`, ok: true, metadata: { youtube: {}, instagram: {} } }] }));
      }
      if (url.endsWith('/render')) {
        renderCalls++;
        if (renderCalls === 1) { renderBusy(); return busy(); }
        const payload = JSON.parse(String(request.body));
        await writeFile(payload.output_path, 'test video');
        return new Response(JSON.stringify({ outputPath: payload.output_path, durationSeconds: 15, width: 1080, height: 1920,
          fps: 30, sizeBytes: 10, videoCodec: 'h264', audioCodec: 'aac', bitrateKbps: 2000,
          framing: { mode: 'center_crop', trackedFrames: 0, totalFrames: 0, coverage: 0, fallbackUsed: false, note: '' },
          subtitleWordCount: 1, subtitleStats: {}, audio: {}, validationErrors: [] }));
      }
      throw new Error(`Unexpected service request: ${url}`);
    }));

    const pipeline = delivery('pipeline-capacity', 'clipforge.pipeline');
    try {
      await pipeline.worker.waitUntilReady();
      const queued = await pipeline.queue.add('test', { jobId: job.id }, { attempts: 3 });
      await waitForRefusal(captionRefused, pipeline.completed);
      // A long capacity wait must not let the scheduler delete this still-active job's inputs.
      const jobDir = join(state.env.WORK_DIR, job.id);
      const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
      await utimes(jobDir, old, old);
      const { cleanWorkDirs } = await import('../../apps/api/src/workers/clean-work-dirs');
      await cleanWorkDirs(state.env.WORK_DIR);
      expect(existsSync(jobDir)).toBe(true);
      // Exceed the original lease duration: the real renewal must protect this waiting job.
      await new Promise(resolve => setTimeout(resolve, 3_500));
      const active = await db.prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(active).toMatchObject({ status: 'CLIP_SELECTION', attempt: 0 });
      expect(active.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
      expect(await db.recoverProcessingJob(job.id, 1)).toBe('skipped');
      expect(await queued.getState()).toBe('active');
      expect((await pipeline.queue.getJob(queued.id!))?.attemptsMade).toBe(0);
      const completed = await pipeline.completed;
      // BullMQ counts the successful completion itself as one attempt; there were no failed retries.
      expect(completed).toMatchObject({ attemptsMade: 1, attemptsStarted: 1 });
      expect(analyzeCalls).toBe(1);
      expect(captionCalls).toBe(2);
      const after = await db.prisma.processingJob.findUniqueOrThrow({ where: { id: job.id }, include: { clips: true } });
      expect(after).toMatchObject({ status: 'RENDERING', attempt: 0 });
      expect(after.clips).toHaveLength(1);
      expect(await db.prisma.usageRecord.count({ where: { jobId: job.id, kind: 'gemini_tokens' } })).toBe(1);
      expect(await db.prisma.outboxEvent.count({ where: { aggregateId: job.id, eventType: { in: ['job.retry', 'job.recover'] } } })).toBe(0);

      const render = delivery('render-capacity', 'clipforge.render');
      try {
        await render.worker.waitUntilReady();
        const renderJob = await render.queue.add('test', { jobId: job.id, clipId: after.clips[0].id }, { attempts: 3 });
        await waitForRefusal(renderRefused, render.completed);
        expect(await renderJob.getState()).toBe('active');
        expect((await render.queue.getJob(renderJob.id!))?.attemptsMade).toBe(0);
        expect(await db.recoverProcessingJob(job.id, 1)).toBe('skipped');
        expect(await render.completed).toMatchObject({ attemptsMade: 1, attemptsStarted: 1 });
        expect(renderCalls).toBe(2);
        expect(await db.prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'COMPLETED', attempt: 0 });
        expect(await db.prisma.generatedClip.findUniqueOrThrow({ where: { id: after.clips[0].id } })).toMatchObject({ status: 'READY' });
      } finally {
        await render.worker.close();
        await render.queue.close();
      }
    } finally {
      await pipeline.worker.close();
      await pipeline.queue.close();
    }
  }, 25_000);

  it('keeps retryable or recently cancelled work directories and cleans old completed work', async () => {
    const [failed, partial, cancelled, completed] = await Promise.all(Array.from({ length: 4 }, createJob));
    await db.transitionJob(failed.id, 'FAILED');
    for (const status of ['CLIP_SELECTION', 'RENDERING', 'VALIDATION', 'ASSET_STORAGE', 'PARTIALLY_COMPLETED'] as const) {
      await db.transitionJob(partial.id, status);
    }
    await db.transitionJob(cancelled.id, 'CANCELLED');
    await db.transitionJob(completed.id, 'CLIP_SELECTION');
    await db.transitionJob(completed.id, 'COMPLETED');

    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    await db.prisma.processingJob.updateMany({
      where: { id: { in: [failed.id, partial.id, completed.id] } }, data: { completedAt: old },
    });
    const paths = [failed, partial, cancelled, completed].map(job => join(state.env.WORK_DIR, job.id));
    for (const path of paths) {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'source.mp4'), 'input');
      await utimes(path, old, old);
    }
    const { cleanWorkDirs } = await import('../../apps/api/src/workers/clean-work-dirs');
    await cleanWorkDirs(state.env.WORK_DIR);
    expect(paths.slice(0, 3).every(existsSync)).toBe(true);
    expect(existsSync(paths[3])).toBe(false);
    // Manual retries can race cleanup, so retryable terminal states are never removed.
    await db.transitionJob(failed.id, 'RETRYING');
    await cleanWorkDirs(state.env.WORK_DIR);
    expect(existsSync(paths[0])).toBe(true);
  });

  it('stops a cancelled pipeline at captions without redoing analysis or writing a retry', async () => {
    const job = await createJob();
    const candidate = { start_time: 0, end_time: 15, target_duration: 15, hook: 'Hook', reason: 'Complete',
      transcript: 'hello world', content_category: 'educational', quality_score: 90, confidence: 0.9, visual_context: '', scores: {} };
    let analyses = 0, captions = 0, markBusy!: () => void;
    const refused = new Promise<void>(resolve => { markBusy = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/analyze')) {
        analyses++;
        return new Response(JSON.stringify({ plan: [{ candidate, duration_kind: 15, start_time: 0, end_time: 15, derived: false }],
          report: { provider: 'fixture', clips_planned: 1 }, variant_decisions: [], rejected_candidates: [], duplicates_dropped: [] }));
      }
      if (url.endsWith('/captions')) { captions++; markBusy(); return busy(); }
      throw new Error(`Unexpected service request: ${url}`);
    }));
    const pipeline = delivery('cancel-pipeline-capacity', 'clipforge.pipeline');
    try {
      await pipeline.worker.waitUntilReady();
      await pipeline.queue.add('test', { jobId: job.id }, { attempts: 3 });
      await waitForRefusal(refused, pipeline.completed);
      await db.transitionJob(job.id, 'CANCELLED');
      expect(await pipeline.completed).toMatchObject({ attemptsMade: 1, attemptsStarted: 1 });
      expect(analyses).toBe(1);
      expect(captions).toBe(1);
      expect(await db.prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'CANCELLED', attempt: 0, workerId: null });
      expect(await db.prisma.generatedClip.count({ where: { jobId: job.id } })).toBe(0);
      expect(await db.prisma.outboxEvent.count({ where: { aggregateId: job.id, eventType: { in: ['job.retry', 'job.recover'] } } })).toBe(0);
    } finally {
      await pipeline.worker.close();
      await pipeline.queue.close();
    }
  }, 12_000);

  it('acknowledges a cancelled job and does not start a render after a capacity wait', async () => {
    const job = await createJob();
    await db.transitionJob(job.id, 'CLIP_SELECTION');
    await db.transitionJob(job.id, 'RENDERING');
    const clip = await db.prisma.generatedClip.create({ data: {
      workspaceId, jobId: job.id, title: 'Clip', contentCategory: 'educational', qualityScore: 90,
      startSeconds: 0, endSeconds: 15, durationKind: 15,
    } });
    const assetsBefore = await db.prisma.mediaAsset.count({ where: { workspaceId, sourceVideoId: sourceId } });
    let calls = 0, markBusy!: () => void;
    const refused = new Promise<void>(resolve => { markBusy = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => { calls++; markBusy(); return busy(); }));
    const render = delivery('cancel-capacity', 'clipforge.render');
    try {
      await render.worker.waitUntilReady();
      await render.queue.add('test', { jobId: job.id, clipId: clip.id }, { attempts: 3 });
      await waitForRefusal(refused, render.completed);
      await db.transitionJob(job.id, 'CANCELLED');
      expect(await render.completed).toMatchObject({ attemptsMade: 1, attemptsStarted: 1 });
      expect(calls).toBe(1);
      expect(await db.prisma.processingJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'CANCELLED', attempt: 0, workerId: null });
      expect(await db.prisma.mediaAsset.count({ where: { workspaceId, sourceVideoId: sourceId } })).toBe(assetsBefore);
    } finally {
      await render.worker.close();
      await render.queue.close();
    }
  }, 12_000);
});
