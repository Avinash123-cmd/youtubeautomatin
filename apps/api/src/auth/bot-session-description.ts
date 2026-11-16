import { UnauthorizedException } from '@nestjs/common';
import { prisma, ConfigurationService } from '@clipforge/database';

/** Preserve the existing workspace/readiness session contract without loading retired providers. */
export async function describeBotSession(context: { userId: string; workspaceId: string }) {
    const membership = await prisma.workspaceMember.findFirst({
      where: { userId: context.userId, workspaceId: context.workspaceId },
      include: { user: true, workspace: true },
    });
    if (!membership) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Session workspace no longer accessible' });

    const configService = new ConfigurationService(context.workspaceId);
    // NB: a successful resolution still carries a `missing: []` property, so readiness must be
    // tracked with an explicit flag rather than by testing for the presence of the property.
    const processing = await configService
      .requireForProcessing()
      .then(() => ({ ready: true, missing: [] as string[] }))
      .catch((e: Error & { missing?: string[] }) => ({ ready: false, missing: e.missing ?? (['unknown'] as string[]) }));
    const publishing = await configService
      .requireForPublishing()
      .then(() => ({ ready: true, missing: [] as string[] }))
      .catch((e: Error & { missing?: string[] }) => ({ ready: false, missing: e.missing ?? (['unknown'] as string[]) }));
    const integration = ConfigurationService.integrationStatus();

    return {
      user: {
        id: membership.user.id,
        // Telegram OIDC has no email claim. The required legacy email column gets a reserved
        // .invalid alias, which must never be presented as a reachable address.
        email: membership.user.email.endsWith('@users.telegram.invalid') ? '' : membership.user.email,
        displayName: membership.user.displayName,
        role: membership.role,
        avatarUrl: membership.user.avatarUrl,
        authMethods: membership.user.telegramUserId && membership.user.telegramLinkedAt ? ['TELEGRAM_BOT'] : [],
      },
      workspace: {
        id: membership.workspace.id,
        name: membership.workspace.name,
        slug: membership.workspace.slug,
        timezone: membership.workspace.timezone,
      },
      configuration: {
        processingReady: processing.ready,
        publishingReady: publishing.ready,
        missing: Array.from(new Set([...processing.missing, ...publishing.missing])),
      },
      integrations: integration,
    };
}
