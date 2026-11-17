import 'reflect-metadata';
import { expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ generatedClip: { findFirst: vi.fn() }, publishingJob: { findFirst: vi.fn() }, clipMetadata: { update: vi.fn() } }));
vi.mock('@clipforge/database', () => ({ prisma: db, appendAuditLog: vi.fn() }));
import { ClipsService } from '../../apps/api/src/clips/clips.service';
import type { RequestContext } from '../../apps/api/src/common/guards/session-auth.guard';
it('records user editing time but never overwrites immutable generated output', async () => {
  db.generatedClip.findFirst.mockResolvedValue({ id: 'clip-a' });
  db.publishingJob.findFirst.mockResolvedValue(null);
  db.clipMetadata.update.mockResolvedValue({ platform: 'YOUTUBE' });
  const service = new ClipsService();
  await service.updateMetadata('clip-a', { platform: 'YOUTUBE', title: 'Edited by owner' }, { workspaceId: 'workspace-a' } as RequestContext);
  const args = db.clipMetadata.update.mock.calls[0][0];
  expect(args.data.title).toBe('Edited by owner'); expect(args.data.editedAt).toBeInstanceOf(Date);
  expect(args.data).not.toHaveProperty('originalAiOutput');
  expect(db.generatedClip.findFirst).toHaveBeenCalledWith({ where: { id: 'clip-a', workspaceId: 'workspace-a' } });
});
