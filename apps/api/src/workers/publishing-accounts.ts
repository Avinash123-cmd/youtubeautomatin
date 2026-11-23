import { prisma } from '@clipforge/database';

type PublishingPlatform = 'YOUTUBE' | 'INSTAGRAM';

/** Select at most one eligible account per requested platform, without loading the workspace's full account list. */
export async function eligiblePublishingAccounts(workspaceId: string, platforms: PublishingPlatform[]) {
  const rows = await Promise.all([...new Set(platforms)].map((platform) => prisma.connectedAccount.findFirst({
    where: { workspaceId, platform, status: 'CONNECTED', publishingEnabled: true },
    select: { id: true, platform: true, publishingConfig: true },
    orderBy: { id: 'asc' },
  })));
  return rows.filter((row): row is NonNullable<typeof row> => row !== null);
}
