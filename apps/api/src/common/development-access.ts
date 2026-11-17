import { ServiceUnavailableException, ForbiddenException } from '@nestjs/common';
import { developmentAuthBypassEnabled } from '@clipforge/shared-types';
import { prisma } from '@clipforge/database';
import type { Request } from 'express';
import type { AuthenticatedSession } from '../auth/session.service';

/** No session or identity is created. Only an explicitly selected local sandbox membership is used. */
export async function developmentAccess(request: Request): Promise<(AuthenticatedSession & { developmentBypass: true }) | null> {
  if (!developmentAuthBypassEnabled(process.env)) return null;
  const path = request.path.replace(/\/+$/, '') || '/';
  // Auth/webhooks/security never inherit the development principal (except session-info).
  const readable = request.method === 'GET' && (
    path === '/api/auth/session' || /^\/api\/(dashboard|sources|jobs|clips|accounts|publishing|usage|system|notifications)(\/|$)/.test(path)
    || /^\/api\/(configuration|activity|brand-profiles)(\/|$)/.test(path) || /^\/media\/(sources|clips)\//.test(path));
  const writable = ['POST', 'PATCH'].includes(request.method) && /^\/api\/(sources|jobs|clips)(\/|$)/.test(path);
  if (!readable && !writable) return null;
  let local = false;
  try { local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL ?? '').hostname); } catch { /* fail closed */ }
  const userId = process.env.AUTH_BYPASS_USER_ID;
  const workspaceId = process.env.AUTH_BYPASS_WORKSPACE_ID;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!local || !uuid.test(userId ?? '') || !uuid.test(workspaceId ?? '')) {
    throw new ServiceUnavailableException({ code: 'DEV_ACCESS_NOT_CONFIGURED', message: 'Development access requires a loopback PostgreSQL database and explicit AUTH_BYPASS_USER_ID / AUTH_BYPASS_WORKSPACE_ID for an existing sandbox membership.' });
  }
  const member = await prisma.workspaceMember.findFirst({
    where: { userId, workspaceId, workspace: { deletedAt: null, slug: { startsWith: 'dev-auth-bypass-' } }, user: { status: 'ACTIVE', deletedAt: null } },
    include: { user: true, workspace: true },
  });
  if (!member) throw new ServiceUnavailableException({ code: 'DEV_ACCESS_NOT_CONFIGURED', message: 'Select an active existing membership in a dedicated workspace with slug dev-auth-bypass-*. No accounts or sessions are created automatically.' });
  if (writable && path === '/api/jobs' && request.body?.configuration?.autoPublish !== false) {
    throw new ForbiddenException({ code: 'DEV_ACCESS_RESTRICTED', message: 'Development bypass requires autoPublish=false. Publishing always requires a real login.' });
  }
  if (writable && /^\/api\/jobs\/[^/]+\/retry$/.test(path)) {
    const jobId = path.split('/')[3];
    const job = await prisma.processingJob.findFirst({ where: { id: jobId, workspaceId: member.workspaceId }, select: { configuration: true } });
    const configuration = job?.configuration;
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) || configuration.autoPublish !== false) {
      throw new ForbiddenException({ code: 'DEV_ACCESS_RESTRICTED', message: 'Only non-publishing sandbox jobs can be retried without login.' });
    }
  }
  return {
    developmentBypass: true, sessionId: '', userId: member.userId,
    email: member.user.email, displayName: member.user.displayName, role: member.role,
    workspaceId: member.workspaceId, workspaceName: member.workspace.name,
    workspaceSlug: member.workspace.slug, workspaceTimezone: member.workspace.timezone,
  };
}
