import { describe, expect, it, vi } from 'vitest';
vi.mock('../../apps/api/src/common/env', () => ({ env: { APP_URL: 'https://clipforge.example', TELEGRAM_WEBHOOK_URL: 'https://clipforge.example/api/auth/telegram/webhook', TELEGRAM_WEBHOOK_SECRET: 'test-only-secret' } }));
vi.mock('@clipforge/database', async original => ({ ...await original<typeof import('@clipforge/database')>(), ConfigurationService: { set: vi.fn() } }));
import { NotificationsService } from '../../apps/api/src/notifications/notifications.service';
describe('shared identity bot webhook destination', () => {
  it('never sends the deployment webhook secret to a tenant-chosen URL', async () => {
    const client = { setWebhook: vi.fn() };
    const service = new NotificationsService({ client: client as never });
    expect(await service.registerWebhook('workspace', { webhookUrl: 'https://attacker.example/webhook' }, 'owner')).toMatchObject({ ok: false });
    expect(client.setWebhook).not.toHaveBeenCalled();
  });
  it('does not let a workspace owner discard pending authentication updates', async () => {
    const client = { setWebhook: vi.fn() };
    const service = new NotificationsService({ client: client as never });
    expect(await service.registerWebhook('workspace', { dropPendingUpdates: true }, 'owner')).toMatchObject({ ok: false });
    expect(client.setWebhook).not.toHaveBeenCalled();
  });
  it('registers only the deployment-configured endpoint', async () => {
    const client = { setWebhook: vi.fn().mockResolvedValue({ ok: true }) };
    expect(await new NotificationsService({ client: client as never }).registerWebhook('workspace', {}, 'owner')).toMatchObject({ ok: true });
    expect(client.setWebhook).toHaveBeenCalledWith({ url: 'https://clipforge.example/api/auth/telegram/webhook', secretToken: 'test-only-secret', dropPendingUpdates: undefined });
  });
});
