'use client';

/**
 * Account security: second factor, linked Telegram chat, active devices, sign-in history, recovery
 * codes.
 *
 * Everything here is driven by `GET /api/auth/security/overview` — the page never assumes a channel
 * works. If SMTP is not configured the email option is disabled with the reason, because enabling a
 * factor that cannot deliver locks the account out of itself.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge, Card, CardHeader, EmptyState, ErrorState, Section, Skeleton, Toast } from '@/components/ui';
import {
  useGenerateRecoveryCodes,
  useLoginHistory,
  useLogout,
  useRevokeAllSessions,
  useRevokeSession,
  useSecurityOverview,
  useSetOtpMode,
  useStartTelegramConnection,
  useUnlinkTelegram,
  type SecurityOverview,
} from '@/lib/hooks';

const MODES: { value: SecurityOverview['otpMode']; label: string; hint: string }[] = [
  { value: 'OFF', label: 'Password only', hint: 'No second factor. Fastest, weakest.' },
  { value: 'EMAIL', label: 'Email code', hint: 'A six-digit code is emailed at every sign-in.' },
  { value: 'TELEGRAM', label: 'Telegram code', hint: 'The code arrives in your linked Telegram chat.' },
  { value: 'DUAL', label: 'Email + Telegram', hint: 'Both codes are required. Slower, strongest.' },
];

const OUTCOME_TONE: Record<string, 'positive' | 'danger' | 'caution' | 'neutral'> = {
  SUCCESS: 'positive',
  FAILED_PASSWORD: 'danger',
  OTP_FAILED: 'danger',
  BLOCKED: 'danger',
  OTP_CHALLENGE: 'caution',
};

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function SecurityPage() {
  const router = useRouter();
  const logout = useLogout();
  const overview = useSecurityOverview();
  const history = useLoginHistory();
  const setMode = useSetOtpMode();
  const revoke = useRevokeSession();
  const revokeAll = useRevokeAllSessions();
  const generate = useGenerateRecoveryCodes();
  const connection = useStartTelegramConnection();
  const unlink = useUnlinkTelegram();


  const [notice, setNotice] = useState<string | null>(null);

  if (overview.isLoading) {
    return (
      <Card>
        <Skeleton rows={10} />
      </Card>
    );
  }
  if (overview.error) return <ErrorState message={overview.error.message} onRetry={() => void overview.refetch()} />;
  const data = overview.data!;

  const channelReason = (mode: SecurityOverview['otpMode']): string | null => {
    if ((mode === 'EMAIL' || mode === 'DUAL') && !data.channels.email) {
      return 'Email is not configured on this deployment (SMTP_HOST / SMTP_FROM are unset on the API).';
    }
    if ((mode === 'TELEGRAM' || mode === 'DUAL') && !data.channels.telegram) {
      return 'Link a Telegram chat first — Telegram codes have nowhere to go.';
    }
    return null;
  };

  return (
    <div className="space-y-5">
      <Section
        as="h1"
        title="Security"
        description="How this account proves who it is: second factor, linked chat, signed-in devices, and what would still work if you lost both email and Telegram."
      />
      {notice ? <Toast tone="positive" onClose={() => setNotice(null)}>{notice}</Toast> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Two-step verification"
            description="A password alone opens a session only when this is off."
            action={<Badge tone={data.otpMode === 'OFF' ? 'neutral' : 'positive'}>{data.otpMode === 'OFF' ? 'Off' : data.otpMode}</Badge>}
          />
          <div className="space-y-2">
            {MODES.map((mode) => {
              const reason = channelReason(mode.value);
              const disabled = Boolean(reason) || setMode.isPending || mode.value === data.otpMode;
              return (
                <button
                  key={mode.value}
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    setMode.mutate(mode.value, {
                      onSuccess: () => setNotice(`Second factor set to ${mode.label}.`),
                    })
                  }
                  className={`w-full rounded-lg border px-3 py-2.5 text-left transition ${
                    mode.value === data.otpMode ? 'border-accent bg-accent-soft' : 'border-line hover:border-ink-faint'
                  } ${disabled && mode.value !== data.otpMode ? 'cursor-not-allowed opacity-60' : ''}`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-[13.5px] font-medium text-ink">{mode.label}</span>
                    {mode.value === data.otpMode ? <span className="text-[11px] font-semibold uppercase tracking-wide text-accent">Current</span> : null}
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-soft">{reason ?? mode.hint}</span>
                </button>
              );
            })}
          </div>
          {setMode.error ? (
            <p role="alert" className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
              {setMode.error.message}
            </p>
          ) : null}
          <p className="mt-3 text-[11.5px] leading-relaxed text-ink-faint">
            Codes expire after {Math.round(data.policies.otpTtlSeconds / 60)} min, allow {data.policies.maxAttempts} attempts, and can be
            resent after {data.policies.resendCooldownSeconds}s. Codes are stored hashed — nobody, including an operator, can read them.
          </p>
        </Card>

        <Card>
          <CardHeader
            title="Telegram"
            description="Where sign-in codes and job notifications go."
            action={<Badge tone={data.telegram.linked ? 'positive' : 'neutral'}>{data.telegram.linked ? 'Telegram Connected ✓' : connection.data ? 'Connection pending' : 'Not connected'}</Badge>}
          />
          {data.telegram.linked ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-line bg-surface-muted px-3 py-2.5">
                <p className="text-[12px] uppercase tracking-wide text-ink-faint">Chat</p>
                <p className="font-mono text-[13px] text-ink">{data.telegram.chatId}</p>
                {data.telegram.linkedAt ? <p className="mt-1 text-[11.5px] text-ink-faint">Linked {formatWhen(data.telegram.linkedAt)}</p> : null}
              </div>
              <button
                type="button"
                className="btn-secondary"
                disabled={unlink.isPending}
                onClick={() => unlink.mutate(undefined, { onSuccess: () => setNotice('Telegram unlinked.') })}
              >
                {unlink.isPending ? 'Unlinking…' : 'Disconnect Telegram'}
              </button>
              <p className="text-[11.5px] leading-relaxed text-ink-faint">
                Unlinking downgrades a Telegram or dual policy rather than locking you out.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-ink-soft">Connect your private Telegram chat before enabling codes. Open the bot and press Start; a bot cannot contact you before you do.</p>
              <button type="button" className="btn-secondary" disabled={connection.isPending} onClick={() => connection.mutate()}>
                {connection.isPending ? 'Preparing link…' : 'Connect Telegram'}
              </button>
              {connection.data ? <div className="space-y-2 rounded-lg border border-line p-3">
                <p role="status" className="text-sm">Connection pending</p>
                <a className="btn-primary" href={connection.data.deepLink} target="_blank" rel="noopener noreferrer">Open Telegram bot</a>
                <p className="text-xs text-ink-faint">Expires {formatWhen(connection.data.expiresAt)}. Never share this one-time link.</p>
                <button type="button" className="btn-secondary" onClick={() => void overview.refetch()}>Verify Telegram</button>
              </div> : null}
              {connection.error ? <p role="alert" className="text-sm text-danger">{connection.error.message}</p> : null}
            </div>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Active sessions"
          description="Every device holding a valid session cookie for this account."
          action={
            <button
              type="button"
              className="btn-secondary"
              disabled={revokeAll.isPending}
              onClick={() =>
                revokeAll.mutate(true, {
                  onSuccess: (result) => {
                    setNotice(result.revoked === 0 ? 'No other sessions to revoke.' : `Signed out ${result.revoked} other session(s).`);
                    void overview.refetch();
                  },
                })
              }
            >
              {revokeAll.isPending ? 'Working…' : 'Sign out everywhere else'}
            </button>
          }
        />
        {data.sessions.length === 0 ? (
          <EmptyState title="No sessions" description="Signing in again will create one." />
        ) : (
          <ul className="divide-y divide-line">
            {data.sessions.map((item) => (
              <li key={item.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
                    {item.device}
                    {item.current ? <Badge tone="positive">This device</Badge> : null}
                  </p>
                  <p className="mt-0.5 text-[12px] text-ink-soft">
                    {item.ipAddress ?? 'unknown ip'} · last seen {formatWhen(item.lastSeenAt)}
                  </p>
                  <p className="text-[11.5px] text-ink-faint">Started {formatWhen(item.createdAt)} · expires {formatWhen(item.expiresAt)}</p>
                </div>
                {item.current ? (
                  <button
                    type="button"
                    className="text-[12.5px] text-ink-soft hover:text-ink hover:underline"
                    disabled={logout.isPending}
                    onClick={() => logout.mutate(undefined, { onSuccess: () => router.replace('/login') })}
                  >
                    {logout.isPending ? 'Signing out…' : 'Sign out'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="text-[12.5px] font-medium text-danger hover:underline"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(item.id, { onSuccess: () => setNotice('Session revoked.') })}
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Sign-in history" description="The last 20 attempts on this account." />
          {history.isLoading ? (
            <Skeleton rows={5} />
          ) : history.error ? (
            <ErrorState message={history.error.message} onRetry={() => void history.refetch()} />
          ) : (history.data?.length ?? 0) === 0 ? (
            <EmptyState title="Nothing recorded yet" description="Sign-ins appear here as they happen." />
          ) : (
            <ul className="divide-y divide-line">
              {history.data!.map((event) => (
                <li key={event.id} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 text-[13px] text-ink">
                      <Badge tone={OUTCOME_TONE[event.outcome] ?? 'neutral'}>{event.outcome.replace(/_/g, ' ').toLowerCase()}</Badge>
                      <span className="text-ink-soft">{event.method.toLowerCase()}</span>
                      {event.suspicious ? <Badge tone="danger">new device</Badge> : null}
                    </p>
                    <p className="mt-0.5 text-[11.5px] text-ink-faint">
                      {event.device} · {event.ipAddress ?? 'unknown ip'}
                      {event.detail ? ` · ${event.detail}` : ''}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11.5px] text-ink-faint">{formatWhen(event.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Recovery codes"
            description="Ten single-use codes for when you lose email and Telegram both."
            action={<Badge tone={data.recoveryCodes.remaining > 0 ? 'positive' : 'caution'}>{data.recoveryCodes.remaining} left</Badge>}
          />
          <button
            type="button"
            className="btn-secondary"
            disabled={generate.isPending}
            onClick={() => generate.mutate(undefined, { onSuccess: () => setNotice('New recovery codes generated.') })}
          >
            {generate.isPending ? 'Generating…' : data.recoveryCodes.remaining > 0 ? 'Replace codes' : 'Generate codes'}
          </button>
          {generate.data ? (
            <div className="mt-3 rounded-lg border border-caution/30 bg-caution-soft px-3 py-2.5">
              <p className="text-[12px] font-semibold text-caution">Copy these now — they are shown once and stored hashed.</p>
              <div className="mt-2 grid grid-cols-2 gap-1 font-mono text-[12.5px] text-ink">
                {generate.data.codes.map((code) => (
                  <span key={code}>{code}</span>
                ))}
              </div>
            </div>
          ) : null}
          {generate.error ? (
            <p role="alert" className="mt-2 text-[12.5px] text-danger">
              {generate.error.message}
            </p>
          ) : null}
          <p className="mt-3 text-[11.5px] leading-relaxed text-ink-faint">
            Using a recovery code at{' '}
            <Link href="/login" className="underline hover:text-ink-soft">
              sign-in
            </Link>{' '}
            resets the password and signs out every device.
          </p>
        </Card>
      </div>
    </div>
  );
}
