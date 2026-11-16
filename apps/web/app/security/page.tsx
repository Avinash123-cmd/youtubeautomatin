'use client';

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { describeAuthError } from '@/lib/auth-messages';

type Overview = {
  telegram: { connected: boolean; displayName: string; username: string | null; linkedAt: string | null };
  lastLoginAt: string | null;
  sessions: { id: string; current: boolean; userAgent: string | null; lastSeenAt: string }[];
  history: { id: string; method: string; outcome: string; createdAt: string }[];
  events: { id: string; action: string; summary: string; createdAt: string }[];
};
export default function SecurityPage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const requestOtp = useMutation({ mutationFn: () => api<{ challengeId: string; delivered: boolean }>('/api/auth/security/otp/request', { method: 'POST' }) });
  const verifyOtp = useMutation({ mutationFn: () => api('/api/auth/security/otp/verify', { method: 'POST', body: { challengeId: requestOtp.data?.challengeId, code } }), onSuccess: () => router.replace('/login') });
  const overview = useQuery({ queryKey: ['bot-security'], queryFn: () => api<Overview>('/api/auth/security/overview') });
  const [link, setLink] = useState<string | null>(null);
  const connect = useMutation({ mutationFn: () => api<{ deepLink: string }>('/api/auth/security/telegram/link/start', { method: 'POST' }), onSuccess: data => setLink(data.deepLink) });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/api/auth/security/sessions/${id}`, { method: 'DELETE' }), onSuccess: () => overview.refetch() });
  const revokeAll = useMutation({ mutationFn: () => api('/api/auth/security/sessions/revoke-all', { method: 'POST', body: { keepCurrent: true } }), onSuccess: () => overview.refetch() });
  const error = overview.error ?? connect.error ?? revoke.error ?? revokeAll.error ?? requestOtp.error ?? verifyOtp.error;
  return <main className="mx-auto max-w-4xl space-y-6 p-5 sm:p-8">
    <header><h1 className="text-2xl font-semibold">Account security</h1><p className="mt-2 text-sm text-ink-soft">Telegram is your only sign-in provider. Your email is profile information, not an authentication method.</p></header>
    {error ? <div role="alert" className="rounded-xl bg-danger-soft p-4 text-danger">{describeAuthError(error).message}<button className="ml-3 underline" onClick={() => void overview.refetch()}>Retry</button></div> : null}
    {overview.isPending ? <p role="status">Loading security settings…</p> : null}
    {overview.data ? <>
      <section className="rounded-xl border border-line bg-white p-5"><h2 className="font-semibold">Telegram identity</h2><p className="mt-3">{overview.data.telegram.connected ? 'Verified bot connection' : 'No verified bot connection — link now to preserve future sign-in access.'}</p><p className="text-sm text-ink-soft">{overview.data.telegram.displayName} {overview.data.telegram.username ? `(@${overview.data.telegram.username})` : ''}</p><p className="mt-2 text-sm">Last successful authentication: {overview.data.lastLoginAt ? new Date(overview.data.lastLoginAt).toLocaleString() : 'Not recorded'}</p>
        {!overview.data.telegram.connected ? <button className="btn-primary mt-4" disabled={connect.isPending} onClick={() => connect.mutate()}>{connect.isPending ? 'Creating link…' : 'Connect Telegram'}</button> : <p className="mt-4 text-sm text-ink-soft">Disconnecting the only identity is blocked. For recovery or identity replacement, contact the operator for a separately verified migration; email alone cannot authorize it.</p>}
        {link ? <div className="mt-4"><a className="btn-primary" href={link} target="_blank" rel="noopener noreferrer">Open Telegram and press Start</a><button className="btn-secondary ml-3" onClick={() => void overview.refetch()}>Verify connection</button></div> : null}
      </section>
      <section className="rounded-xl border border-line bg-white p-5"><h2 className="font-semibold">Active sessions</h2><button className="btn-secondary mt-3" disabled={revokeAll.isPending} onClick={() => revokeAll.mutate()}>Revoke all other sessions</button><ul className="mt-4 divide-y divide-line">{overview.data.sessions.map(row => <li key={row.id} className="flex items-center justify-between gap-4 py-4"><div className="min-w-0"><p className="truncate text-sm">{row.userAgent ?? 'Unknown device'} {row.current ? '(current)' : ''}</p><p className="text-xs text-ink-soft">Last seen {new Date(row.lastSeenAt).toLocaleString()}</p></div>{!row.current ? <button className="btn-secondary shrink-0" disabled={revoke.isPending} onClick={() => revoke.mutate(row.id)}>Revoke</button> : null}</li>)}</ul></section>
      {overview.data.telegram.connected ? <section className="rounded-xl border border-line bg-white p-5"><h2 className="font-semibold">Optional Telegram security verification</h2><p className="mt-2 text-sm text-ink-soft">Verify a fresh code from your connected bot to sign out all devices, including this one. This code cannot sign you in.</p><button className="btn-secondary mt-3" disabled={requestOtp.isPending} onClick={() => requestOtp.mutate()}>{requestOtp.isPending ? 'Requesting…' : requestOtp.data ? 'Resend verification code' : 'Verify Telegram and revoke all sessions'}</button>{requestOtp.data?.delivered ? <form className="mt-4 flex flex-wrap gap-3" onSubmit={event => { event.preventDefault(); verifyOtp.mutate(); }}><label className="text-sm">Telegram verification code<input className="input mt-2" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} /></label><button className="btn-primary" disabled={code.length !== 6 || verifyOtp.isPending}>{verifyOtp.isPending ? 'Verifying…' : 'Confirm and sign out everywhere'}</button></form> : null}</section> : null}
      <section className="rounded-xl border border-line bg-white p-5"><h2 className="font-semibold">Login history</h2>{overview.data.history.length ? <ul className="mt-3 space-y-3 text-sm">{overview.data.history.map(row => <li key={row.id}>{row.method} · {row.outcome} · {new Date(row.createdAt).toLocaleString()}</li>)}</ul> : <p className="mt-3 text-sm text-ink-soft">No recorded authentication events.</p>}</section>
      <section className="rounded-xl border border-line bg-white p-5"><h2 className="font-semibold">Recent security events</h2><ul className="mt-3 space-y-3 text-sm">{overview.data.events.map(row => <li key={row.id}><p>{row.summary}</p><p className="text-xs text-ink-soft">{new Date(row.createdAt).toLocaleString()}</p></li>)}</ul></section>
    </> : null}
  </main>;
}
