'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { setCsrfToken } from '@/lib/api';
import { describeAuthError } from '@/lib/auth-messages';
import { botLoginView, shouldPollBotLogin, botLoginPhase } from '../../lib/bot-login-state';
import { botProvidersResponseSchema, botLoginStatusResponseSchema } from '@clipforge/validation';
import { loadBotProviders, loadBotStatus, createBotChallenge, completeBotLogin } from '@/lib/bot-auth-api';
import { ApiError } from '@/lib/api';
import { useSession } from '@/lib/hooks';


export default function LoginPage() {
  const router = useRouter();
  const session = useSession();
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const providers = useQuery({ queryKey: ['bot-provider'], queryFn: ({ signal }) => loadBotProviders(signal), retry: false });
  // Also validate cached/hydrated data: a stale cache must not crash before refetch completes.
  const parsedProviders = botProvidersResponseSchema.safeParse(providers.data);
  const provider = parsedProviders.success ? parsedProviders.data.telegram : undefined;
  const status = useQuery({ queryKey: ['bot-login-status'], queryFn: ({ signal }) => loadBotStatus(signal), enabled: Boolean(provider?.enabled) && !session.isPending && !session.data?.authenticated && !providers.error, retry: false, refetchOnWindowFocus: false, refetchInterval: query => shouldPollBotLogin(query.state.data, Date.now(), Boolean(query.state.error), session.data?.authenticated === true) ? 2500 : false });
  const parsedStatus = botLoginStatusResponseSchema.safeParse(status.data);
  const loginStatus = parsedStatus.success ? parsedStatus.data : undefined;
  const create = useMutation({ mutationFn: createBotChallenge, onSuccess: async data => { setDeepLink(data.deepLink); await status.refetch(); } });
  const complete = useMutation({ mutationFn: completeBotLogin, onSuccess: async data => { setCsrfToken(data.csrfToken); const restored = await session.refetch(); if (restored.error) throw restored.error; if (!restored.data?.authenticated) throw new ApiError('The API did not restore the new session. Check browser cookies and the API proxy.', 502, 'SESSION_NOT_RESTORED'); router.replace('/'); } });

  useEffect(() => { if (session.data?.authenticated) router.replace('/'); }, [session.data?.authenticated, router]);
  const clockExpiry = loginStatus && 'expiresAt' in loginStatus ? loginStatus.expiresAt : undefined;
  useEffect(() => {
    if (!clockExpiry || session.data?.authenticated) return;
    const deadline = Date.parse(clockExpiry);
    const timer = setInterval(() => { const tick = Date.now(); setNow(tick); if (tick >= deadline) clearInterval(timer); }, 1000);
    return () => clearInterval(timer);
  }, [clockExpiry, session.data?.authenticated]);
  const { remaining, expired, waiting } = botLoginView(loginStatus, now);
  const cacheError = (providers.data !== undefined && !parsedProviders.success) || (status.data !== undefined && !parsedStatus.success) ? new ApiError('The cached authentication response is incompatible. Retry to reload it from the updated backend.', 502, 'AUTH_CONTRACT_MISMATCH') : null;
  const error = create.error ?? complete.error ?? status.error ?? providers.error ?? session.error ?? cacheError;
  const failure = error ? describeAuthError(error) : null;
  const phase = botLoginPhase({ status: loginStatus, creating: create.isPending, completing: complete.isPending, authenticated: session.data?.authenticated === true, failed: Boolean(error) }, now);

  return (
    <main className="relative flex min-h-[100dvh] overflow-hidden bg-[#090e24] text-white">
      <div aria-hidden="true" className="pointer-events-none absolute -left-32 top-12 h-96 w-96 rounded-full bg-purple-600/20 blur-3xl motion-safe:animate-pulse" />
      <div aria-hidden="true" className="pointer-events-none absolute -right-24 bottom-0 h-96 w-96 rounded-full bg-indigo-600/20 blur-3xl" />
      <div className="relative mx-auto grid w-full max-w-7xl items-center gap-12 px-5 py-10 sm:px-10 lg:grid-cols-[1.15fr_1fr] lg:gap-20 lg:py-20">
        <section className="min-w-0">
          <a href="/login" className="inline-flex items-center gap-3 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-purple-300"><span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-purple-400 to-indigo-600 font-bold shadow-lg">CF</span><span className="text-xl font-semibold tracking-tight">ClipForge AI</span></a>
          <p className="mt-10 text-xs font-semibold uppercase tracking-[.25em] text-purple-300">Create more. Edit less.</p>
          <h1 className="mt-4 text-4xl font-semibold leading-tight tracking-tight sm:text-6xl">Long videos in.<br /><span className="bg-gradient-to-r from-purple-300 to-indigo-200 bg-clip-text text-transparent">Viral clips out.</span></h1>
          <p className="mt-5 max-w-lg text-base leading-relaxed text-slate-300">Transform podcasts, webinars and long-form videos into engaging vertical clips with AI.</p>
          <ul className="mt-7 space-y-3 text-sm text-slate-200">{['AI-powered highlight detection', 'Automatic captions', 'Smart clip generation', 'YouTube and Instagram publishing', 'Telegram-powered secure authentication'].map(text => <li key={text} className="flex items-center gap-3"><span aria-hidden="true" className="text-purple-300">✓</span>{text}</li>)}</ul>
          <div role="img" aria-label="One long video becomes three vertical clips" className="mt-9 flex max-w-md items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 sm:gap-5">
            <div className="flex aspect-video min-w-0 flex-1 items-center justify-center rounded-lg border border-purple-300/30 bg-gradient-to-br from-indigo-900 to-purple-900 text-xs text-purple-100">▶ Long video</div><span aria-hidden="true" className="text-purple-300">→</span>
            <div className="flex gap-2">{[1, 2, 3].map(i => <div key={i} className="flex h-20 w-9 items-center justify-center rounded-md border border-white/20 bg-gradient-to-b from-purple-500/50 to-indigo-800 text-xs">▶</div>)}</div>
          </div>
        </section>

        <section data-auth-state={phase} aria-labelledby="login-title" className="min-w-0 rounded-3xl bg-white p-6 text-slate-900 shadow-2xl sm:p-10">
          <div className="mb-6 inline-flex rounded-full bg-purple-50 px-3 py-1 text-xs font-medium text-purple-700">One account. Secured by Telegram.</div>
          <h2 id="login-title" className="text-3xl font-semibold tracking-tight">Welcome back.</h2>
          <p className="mt-3 text-sm leading-relaxed text-slate-500">Securely sign in using your Telegram account.</p>

          {providers.isPending || status.isLoading || session.isPending ? <p role="status" className="mt-6 text-sm text-slate-500">Checking authentication…</p> : null}
          {failure ? <div role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"><p className="font-semibold">{failure.title}</p><p className="mt-1 break-words">{failure.message}</p><button type="button" className="mt-3 underline" onClick={() => { create.reset(); complete.reset(); void status.refetch(); void providers.refetch(); void session.refetch(); }}>Retry connection</button></div> : null}
          {provider && !provider.enabled ? <p role="alert" className="mt-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-900">Telegram sign-in is unavailable. {provider.missing.length ? `Ask the operator to configure ${provider.missing.join(', ')}.` : 'The API did not supply configuration details. Ask the operator to check the Telegram bot configuration.'}</p> : null}

          {!waiting ? <button type="button" disabled={!provider?.enabled || Boolean(providers.error) || Boolean(session.error) || Boolean(status.error) || Boolean(cacheError) || create.isPending || session.isPending || status.isLoading} onClick={() => { complete.reset(); create.mutate(); }} className="mt-7 flex min-h-12 w-full items-center justify-center rounded-xl bg-[#229ED9] px-4 py-3 font-semibold text-white transition hover:bg-[#168ac0] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-600 disabled:cursor-not-allowed disabled:opacity-50">{create.isPending ? 'Creating secure login…' : expired ? 'Generate a new login link' : 'Continue with Telegram'}</button> : null}
          {waiting ? <div className="mt-6 space-y-4">
            {deepLink ? <a href={deepLink} target="_blank" rel="noopener noreferrer" className="flex min-h-12 items-center justify-center rounded-xl bg-[#229ED9] px-4 py-3 font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sky-600">Open Telegram ↗</a> : <p className="text-sm text-slate-500">Your login is still pending. Return to the Telegram window you opened, or generate a new link below.</p>}
            <p role="status" aria-live="polite" className="text-center text-sm text-slate-600">{loginStatus?.state === 'VERIFYING' ? 'Telegram confirmed. Check the account below.' : 'Waiting for you to press Start in Telegram…'}</p>
            <p className="text-center font-mono text-sm text-slate-400">Expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</p>
            {loginStatus?.state === 'VERIFYING' ? <div className="rounded-xl bg-purple-50 p-4 text-sm text-purple-950"><p>Sign in as <strong>{loginStatus.identity?.displayName}</strong>{loginStatus.identity?.username ? ` (@${loginStatus.identity.username})` : ''}?</p><p className="mt-1 text-xs">Only continue if this is your Telegram account.</p><button type="button" disabled={complete.isPending || create.isPending || Boolean(status.error) || Boolean(cacheError)} onClick={() => complete.mutate()} className="mt-3 min-h-11 w-full rounded-lg bg-purple-700 px-4 py-2 font-semibold text-white disabled:opacity-50">{complete.isPending ? 'Signing in…' : 'Confirm and sign in'}</button></div> : null}
            <button type="button" disabled={create.isPending || complete.isPending} onClick={() => { complete.reset(); create.mutate(); }} className="min-h-11 w-full text-sm font-medium text-purple-700 underline">{create.isPending ? 'Regenerating…' : 'Generate a new link'}</button>
          </div> : null}
          {expired ? <p role="status" className="mt-4 text-sm text-amber-700">This login link expired. Generate a new one to continue.</p> : null}
          <ol className="mt-8 grid grid-cols-3 gap-3 border-t border-slate-100 pt-6 text-center text-xs text-slate-500">{['Open Telegram', 'Press Start', 'Return to ClipForge'].map((text, i) => <li key={text}><span className="mx-auto mb-2 flex h-7 w-7 items-center justify-center rounded-full bg-purple-50 font-semibold text-purple-700">{i + 1}</span>{text}</li>)}</ol>
          <p className="mt-7 text-center text-xs leading-relaxed text-slate-400">We never ask for your Telegram password or verification codes. Never share a login link. Existing accounts must be linked before migrating.</p>
        </section>
      </div>
    </main>
  );
}
