import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ComponentHealth } from './system.service';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentContext, Public, Roles } from '../common/decorators/auth.decorators';
import type { RequestContext } from '../common/guards/session-auth.guard';
import { SystemService } from './system.service';

@ApiTags('system')
// Operator-only surface: worker/queue internals are not member-facing data.
@Roles('OWNER', 'ADMIN')
@Controller('api/system')
export class SystemController {
  constructor(private readonly system: SystemService) {}

  @Get('live')
  @Public()
  @ApiOperation({ summary: 'Process liveness only, not dependency readiness' })
  live() { return { status: 'ok', service: 'clipforge-api' }; }

  @Get('health')
  @Public()
  @ApiOperation({ summary: 'Core readiness: PostgreSQL, Redis and storage (503 when unavailable)' })
  async health(@Res({ passthrough: true }) res: Response) {
    const health = await this.system.health();
    res.setHeader('Cache-Control', 'no-store');
    res.status(health.status === 'ok' ? 200 : 503);
    return { ...health, checks: health.checks.map(publicHealth) };
  }

  @Get('readiness')
  @Public()
  @ApiOperation({ summary: 'Sanitized dependency readiness; details require operator authentication' })
  async readiness(@Res({ passthrough: true }) res: Response) {
    const readiness = await this.system.readiness();
    const { db, redis, storage, ai, vp, integration } = readiness.components;
    res.setHeader('Cache-Control', 'no-store');
    res.status(readiness.ready ? 200 : 503);
    return {
      ready: readiness.ready, processingReady: readiness.processingReady, publishingReady: readiness.publishingReady,
      components: { db: publicHealth(db), redis: publicHealth(redis), storage: publicHealth(storage), ai: publicHealth(ai), vp: publicHealth(vp), integration: integration.map(publicHealth) },
      workers: readiness.workers.map(({ role, alive }) => ({ role, alive })),
    };
  }

  @Get('worker-status')
  workerStatus() {
    return this.system.workers();
  }

  @Get('queue-status')
  queueStatus(@CurrentContext() ctx: RequestContext) {
    void ctx;
    return this.system.systemOverview(ctx.workspaceId).then((o) => o.queues);
  }

  @Get('overview')
  overview(@CurrentContext() ctx: RequestContext) {
    return this.system.systemOverview(ctx.workspaceId);
  }

  @Get('events')
  events(@CurrentContext() ctx: RequestContext, @Query('limit') limit?: string) {
    return this.system.systemEvents(ctx.workspaceId, limit ? Number(limit) : 50);
  }
}

/** Public probes never include driver exceptions, hostnames, credentials, worker IDs or paths. */
function publicHealth(health: ComponentHealth) {
  return { component: health.component, status: health.status };
}
