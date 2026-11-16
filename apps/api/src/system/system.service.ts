import { randomUUID } from 'node:crypto';
import { boundedProbe, reportedServiceStatus } from '../common/health-probe';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigurationService, prisma } from '@clipforge/database';
import { env } from '../common/env';
import { RedisService } from '../common/services/redis.service';
import { QueueService } from '../queues/queue.service';
import { StorageService } from '../storage/storage.service';

export interface ComponentHealth {
  component: string;
  status: 'healthy' | 'degraded' | 'down' | 'unconfigured';
  message: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

@Injectable()
export class SystemService {
  private readonly logger = new Logger(SystemService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly queues: QueueService,
    private readonly storage: StorageService,
  ) {}

  async databaseHealth(): Promise<ComponentHealth> {
    const started = Date.now();
    try {
      await boundedProbe(() => prisma.$queryRaw`SELECT 1 FROM "ProcessingJob" LIMIT 1`, env.HEALTHCHECK_TIMEOUT_MS);
      return {
        component: 'postgres',
        status: 'healthy',
        message: 'Query succeeded',
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return { component: 'postgres', status: 'down', message: (error as Error).message };
    }
  }

  async redisHealth(): Promise<ComponentHealth> {
    const started = Date.now();
    try {
      const pong = await boundedProbe(() => this.redis.client.ping(), env.HEALTHCHECK_TIMEOUT_MS);
      return { component: 'redis', status: pong === 'PONG' ? 'healthy' : 'degraded', message: `PING -> ${pong}`, latencyMs: Date.now() - started };
    } catch (error) {
      return { component: 'redis', status: 'down', message: (error as Error).message };
    }
  }

  async storageHealth(): Promise<ComponentHealth> {
    const driver = this.storage.driver;
    const key = `health/${randomUUID()}.txt`;
    try {
      await boundedProbe(() => this.storage.putBuffer(key, Buffer.from('clipforge storage probe'), 'text/plain'), env.HEALTHCHECK_TIMEOUT_MS);
      const exists = await boundedProbe(() => this.storage.exists(key), env.HEALTHCHECK_TIMEOUT_MS);
      const publicCheck = await boundedProbe(() => this.storage.expectPublicHttps(), env.HEALTHCHECK_TIMEOUT_MS);
      return {
        component: 'storage',
        status: exists ? 'healthy' : 'degraded',
        message: `${driver} driver ${exists ? 'read/write OK' : 'write verification failed'}${publicCheck.ok ? '' : ` — ${publicCheck.reason}`}`,
        details: { driver, publicHttps: publicCheck.ok },
      };
    } catch (error) {
      return { component: 'storage', status: 'down', message: (error as Error).message, details: { driver } };
    } finally {
      await boundedProbe(() => this.storage.delete(key), env.HEALTHCHECK_TIMEOUT_MS).catch(() => undefined);
    }
  }

  async aiEngineHealth(): Promise<ComponentHealth> {
    const started = Date.now();
    try {
      const response = await fetch(`${env.AI_ENGINE_URL}/health`, { headers: { 'x-api-key': env.AI_ENGINE_API_KEY }, signal: AbortSignal.timeout(env.HEALTHCHECK_TIMEOUT_MS) });
      const body = (await response.json()) as { status?: string; apiKeyConfigured?: boolean; geminiConfigured?: boolean; whisperModel?: string; provider?: string; testMode?: boolean };
      const geminiOk = body.geminiConfigured === true && body.provider !== 'fixture' && body.testMode !== true;
      const status = reportedServiceStatus(response.ok, body);
      return {
        component: 'ai-engine',
        status: status === 'healthy' ? (geminiOk ? 'healthy' : 'unconfigured') : status,
        message: status === 'healthy' && geminiOk
          ? `Configured prerequisites (whisper=${body.whisperModel}); provider execution is checked by jobs`
          : `AI prerequisites unavailable (${body.status ?? 'invalid response'}, HTTP ${response.status})`,
        latencyMs: Date.now() - started,
        details: body as Record<string, unknown>,
      };
    } catch (error) {
      return { component: 'ai-engine', status: 'down', message: (error as Error).message };
    }
  }

  async videoProcessorHealth(): Promise<ComponentHealth> {
    const started = Date.now();
    try {
      const response = await fetch(`${env.VIDEO_PROCESSOR_URL}/health`, { headers: { 'x-api-key': env.VIDEO_PROCESSOR_API_KEY }, signal: AbortSignal.timeout(env.HEALTHCHECK_TIMEOUT_MS) });
      const body = (await response.json()) as { status?: string; apiKeyConfigured?: boolean; ffmpeg?: string; ffprobe?: string };
      return {
        component: 'video-processor',
        status: reportedServiceStatus(response.ok, body),
        message: reportedServiceStatus(response.ok, body) === 'healthy' ? `FFmpeg ${body.ffmpeg ?? 'unknown'}` : `Media processor unavailable (${body.status ?? 'invalid response'}, HTTP ${response.status})`,
        latencyMs: Date.now() - started,
        details: body as Record<string, unknown>,
      };
    } catch (error) {
      return { component: 'video-processor', status: 'down', message: (error as Error).message };
    }
  }

  integrationHealth(): ComponentHealth[] {
    const status = ConfigurationService.integrationStatus();
    return [
      {
        component: 'gemini',
        status: status.gemini ? 'healthy' : 'unconfigured',
        message: status.gemini ? 'GEMINI_API_KEY and both models are set' : 'Awaiting GEMINI_API_KEY, GEMINI_TEXT_MODEL and GEMINI_VISION_MODEL',
      },
      {
        component: 'youtube',
        status: status.youtube ? 'healthy' : 'unconfigured',
        message: status.youtube ? 'YouTube OAuth client is configured' : 'Awaiting YOUTUBE_CLIENT_ID / CLIENT_SECRET / REDIRECT_URI',
      },
      {
        component: 'instagram',
        status: status.instagram ? 'healthy' : 'unconfigured',
        message: status.instagram
          ? `Instagram app configured (Graph ${env.META_GRAPH_API_VERSION})`
          : 'Awaiting META_APP_ID / APP_SECRET / REDIRECT_URI / GRAPH_API_VERSION',
      },
    ];
  }

  /** Worker presence is derived from Redis heartbeats renewed by each worker. */
  async workers(): Promise<{ workers: Array<{ role: string; workerId: string; lastHeartbeatAgoSeconds: number; alive: boolean; concurrency?: number }> }> {
    const pattern = this.redis.key('worker', '*');
    let cursor = '0';
    let scans = 0;
    const workers = [];
    do {
      scans += 1;
      const [next, keys] = await boundedProbe(() => this.redis.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100), env.HEALTHCHECK_TIMEOUT_MS);
      cursor = next;
      if (!keys.length) continue;
      const values = await boundedProbe(() => this.redis.client.mget(...keys), env.HEALTHCHECK_TIMEOUT_MS);
      for (const raw of values) {
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw) as { role?: unknown; workerId?: unknown; concurrency?: number; updatedAt?: string };
          if (typeof parsed.role !== 'string' || typeof parsed.workerId !== 'string' || !parsed.updatedAt) continue;
          const age = (Date.now() - Date.parse(parsed.updatedAt)) / 1000;
          if (!Number.isFinite(age) || age < -5) continue;
          workers.push({ role: parsed.role.replace(/^worker:/, ''), workerId: parsed.workerId, concurrency: parsed.concurrency, lastHeartbeatAgoSeconds: Math.max(0, Math.round(age)), alive: age < 45 });
        } catch { /* Ignore corrupt heartbeat records, never abort the dependency report. */ }
      }
    } while (cursor !== '0' && scans < 100 && workers.length < 5000);
    return { workers: workers.sort((a, b) => a.role.localeCompare(b.role)) };
  }

  async readiness() {
    const [db, redis, storage, ai, vp, workers] = await Promise.all([
      this.databaseHealth(),
      this.redisHealth(),
      boundedProbe(() => this.storageHealth(), env.HEALTHCHECK_TIMEOUT_MS).catch(() => ({ component: 'storage', status: 'down' as const, message: 'Storage probe timed out', details: {} })),
      this.aiEngineHealth(),
      this.videoProcessorHealth(),
      boundedProbe(() => this.workers(), env.HEALTHCHECK_TIMEOUT_MS).catch(() => ({ workers: [] })),
    ]);
    const integration = this.integrationHealth();
    const blocking = [db, redis, storage].filter((c) => c.status !== 'healthy');
    const activeRoles = new Set(workers.workers.filter((worker) => worker.alive).map((worker) => worker.role));
    const processingWorkersReady = ['ai', 'render', 'recovery'].every((role) => activeRoles.has(role));
    const publishingWorkersReady = ['publish', 'scheduler', 'recovery'].every((role) => activeRoles.has(role));
    const processingBlockers = [ai, vp].filter((c) => c.status !== 'healthy');
    return {
      ready: blocking.length === 0,
      processingReady: blocking.length === 0 && processingBlockers.length === 0 && processingWorkersReady && integration.find((c) => c.component === 'gemini')?.status === 'healthy',
      publishingReady: blocking.length === 0 && publishingWorkersReady && integration.some((c) => ['youtube', 'instagram'].includes(c.component) && c.status === 'healthy'),
      components: { db, redis, storage, ai, vp, integration },
      workers: workers.workers,
    };
  }

  async health() {
    const [db, redis] = await Promise.all([this.databaseHealth(), this.redisHealth()]);
    const healthy = db.status === 'healthy' && redis.status === 'healthy';
    return { status: healthy ? 'ok' : 'degraded', uptimeSeconds: Math.round(process.uptime()), version: process.env.npm_package_version ?? '1.0.0', checks: [db, redis] };
  }

  async systemOverview(workspaceId: string) {
    const [readiness, depths, workers, counts] = await Promise.all([
      this.readiness(),
      this.queues.depths(),
      this.workers(),
      this.counts(workspaceId),
    ]);
    const healthEvents = await prisma.systemHealthEvent.findMany({ orderBy: { observedAt: 'desc' }, take: 20 });
    return {
      readiness,
      queues: depths,
      workers: workers.workers,
      counts,
      healthEvents: healthEvents.map((e) => ({
        id: e.id,
        component: e.component,
        severity: e.severity,
        status: e.status,
        message: e.message,
        observedAt: e.observedAt.toISOString(),
      })),
      storage: { driver: this.storage.driver, publicUrlConfigured: (await this.storage.expectPublicHttps()).ok },
      graphApiVersion: env.META_GRAPH_API_VERSION ?? null,
      timezone: env.TIMEZONE,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  async counts(workspaceId: string) {
    const [sources, clips, published, processing, failed, publishingFailed, pendingJobs] = await Promise.all([
      prisma.sourceVideo.count({ where: { workspaceId, deletedAt: null } }),
      prisma.generatedClip.count({ where: { workspaceId } }),
      prisma.publishedPost.count({ where: { workspaceId } }),
      prisma.processingJob.count({ where: { workspaceId, status: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED', 'PARTIALLY_COMPLETED'] } } }),
      prisma.processingJob.count({ where: { workspaceId, status: 'FAILED' } }),
      prisma.publishingJob.count({ where: { workspaceId, status: 'FAILED' } }),
      prisma.publishingJob.count({ where: { workspaceId, status: { in: ['PENDING', 'QUEUED', 'UPLOADING', 'AWAITING_PLATFORM'] } } }),
    ]);
    return { sources, clips, published, processing, failed, publishingFailed, pendingPublishingJobs: pendingJobs };
  }

  /** Dashboard: real database values only, no synthetic analytics. */
  async dashboard(workspaceId: string) {
    const counts = await this.counts(workspaceId);
    const [recentJobs, recentClips, recentActivity, publishedByPlatform, variantBreakdown] = await Promise.all([
      prisma.processingJob.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 6,
        include: { sourceVideo: { select: { originalFileName: true, durationSeconds: true } } },
      }),
      prisma.generatedClip.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 6 }),
      prisma.auditLog.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 12 }),
      prisma.publishedPost.groupBy({ by: ['platform'], where: { workspaceId }, _count: { _all: true } }),
      prisma.generatedClip.groupBy({ by: ['durationKind'], where: { workspaceId }, _count: { _all: true } }),
    ]);
    return {
      counts,
      publishedByPlatform: publishedByPlatform.map((p) => ({ platform: p.platform, count: p._count._all })),
      variantBreakdown: variantBreakdown.map((v) => ({ durationKind: v.durationKind, count: v._count._all })),
      recentJobs: recentJobs.map((job) => ({
        id: job.id,
        status: job.status,
        stage: job.stage,
        progressPercent: job.progressPercent,
        createdAt: job.createdAt.toISOString(),
        fileName: job.sourceVideo.originalFileName,
        durationSeconds: job.sourceVideo.durationSeconds,
      })),
      recentClips: recentClips.map((clip) => ({
        id: clip.id,
        title: clip.title,
        durationKind: clip.durationKind,
        qualityScore: clip.qualityScore,
        status: clip.status,
        createdAt: clip.createdAt.toISOString(),
      })),
      recentActivity: recentActivity.map((log) => ({
        id: log.id,
        action: log.action,
        summary: log.summary,
        createdAt: log.createdAt.toISOString(),
      })),
    };
  }

  async systemEvents(workspaceId: string | null, limit = 50) {
    return prisma.systemHealthEvent.findMany({
      where: workspaceId ? { OR: [{ workspaceId }, { workspaceId: null }] } : { workspaceId: null },
      orderBy: { observedAt: 'desc' },
      take: limit,
    });
  }
}
