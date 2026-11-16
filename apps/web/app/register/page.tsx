'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { BackendDown } from '@/components/backend-down';
import { GoogleSignInButton } from '@/components/google-button';
import { signInWithGoogle } from '@/lib/firebase-client';
import { Card, Field } from '@/components/ui';
import { describeAuthError, validateCredentials } from '@/lib/auth-messages';
import { useFirebaseLogin, useRegister, useSession, useSignInProviders } from '@/lib/hooks';

export default function RegisterPage() {
  const router = useRouter();
  const session = useSession();
  const providers = useSignInProviders();
  const register = useRegister();
  const firebase = useFirebaseLogin();
  const [providerError, setProviderError] = useState<string | null>(null);
  const [confirmPassword, setConfirmPassword] = useState('');
  const canRegister = session.data?.selfRegistrationEnabled === true || providers.data?.selfRegistrationEnabled === true;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [touched, setTouched] = useState(false);
  const errors = useMemo(() => validateCredentials(email, password, 'register'), [email, password]);

  useEffect(() => {
    if (session.data?.authenticated) router.replace('/');
  }, [session.data?.authenticated, router]);

  if (session.error) return <BackendDown message={session.error.message} onRetry={() => void session.refetch()} />;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length || password !== confirmPassword || displayName.trim().length < 2) return;
    register.mutate(
      { email: email.trim(), password, displayName: displayName.trim(), ...(workspaceName.trim() ? { workspaceName: workspaceName.trim() } : {}) },
      { onSuccess: () => router.replace('/') },
    );
  };

  return (
    <div className="flex min-h-[100dvh] flex-col bg-surface-muted lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <aside className="relative hidden overflow-hidden bg-ink px-10 py-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="pointer-events-none absolute inset-0 opacity-[0.16]" style={{ backgroundImage: 'radial-gradient(circle at 20% 15%, #6b7bff 0, transparent 45%), radial-gradient(circle at 85% 80%, #22d3a7 0, transparent 40%)' }} />
        <div className="relative">
          <div className="flex items-center gap-2.5"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-sm font-bold text-ink">CF</span><span className="text-[15px] font-semibold tracking-tight">ClipForge AI</span></div>
          <h1 className="mt-14 max-w-[15ch] text-[34px] font-semibold leading-[1.1] tracking-tight">A sharper way to repurpose video.</h1>
          <p className="mt-4 max-w-[38ch] text-[14px] leading-relaxed text-white/70">Create a workspace for your video pipeline, collaborators, and publishing schedule.</p>
        </div>
        <p className="relative text-[11px] text-white/40">Your account is protected by verified identities and server-managed sessions.</p>
      </aside>

      <main className="flex flex-1 items-center justify-center px-4 py-8 sm:px-8 sm:py-12">
        <div className="w-full max-w-[440px]">
          <div className="mb-6 flex items-center gap-2.5 lg:hidden"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-ink text-sm font-bold text-white">CF</span><span className="text-[15px] font-semibold text-ink">ClipForge AI</span></div>
          <Card className="p-5 sm:p-6">
            <div className="mb-5"><h2 className="text-[20px] font-semibold tracking-tight text-ink">Create your account</h2><p className="mt-1 text-[13px] text-ink-soft">Set up your workspace and start creating.</p></div>
            <div className="mb-5 space-y-3">
              <GoogleSignInButton disabled={!providers.data?.firebase.enabled} pending={firebase.isPending} onClick={() => {
                const config = providers.data?.firebase.config;
                if (!config) return;
                setProviderError(null);
                void signInWithGoogle(config).then((idToken) => firebase.mutate({ idToken }, { onSuccess: (result) => { if ('otpRequired' in result) window.location.assign('/login?stepUp=1'); else router.replace('/'); } })).catch(() => setProviderError('Google sign-in could not be completed. Please retry.'));
              }} />
              <a href={providers.data?.telegram.enabled ? '/api/auth/telegram' : undefined} aria-disabled={!providers.data?.telegram.enabled} className="flex w-full items-center justify-center gap-2 rounded-lg border border-line px-4 py-2.5 text-sm font-medium aria-disabled:opacity-50">
                <svg viewBox="0 0 24 24" className="h-5 w-5 text-[#229ED9]" fill="currentColor" aria-hidden="true"><path d="M21.8 3.4 18.6 20c-.2 1.2-.9 1.5-1.9.9l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.4-5 9.1-8.2c.4-.4-.1-.6-.6-.2L6.1 13.8l-4.8-1.5c-1-.3-1.1-1 .2-1.5L20.3 3c.9-.3 1.7.2 1.5.4Z" /></svg>
                Continue with Telegram
              </a>
              {!providers.data?.telegram.enabled ? <p className="text-xs text-ink-faint">Telegram requires administrator configuration.</p> : null}
              {providerError || firebase.error ? <p role="alert" className="text-sm text-danger">{providerError ?? 'Google sign-in failed. Please retry.'}</p> : null}
              <p className="text-center text-[11px] tracking-widest text-ink-faint">OR CONTINUE WITH EMAIL</p>
            </div>
            {!canRegister ? (
              <div role="status" className="rounded-lg bg-caution-soft px-3.5 py-3 text-[13px] leading-relaxed text-caution">Self-service registration is disabled for this deployment. Ask an administrator to invite you.</div>
            ) : (
              <form onSubmit={submit} className="space-y-3.5" noValidate>
                <Field label="Your name" required>
                  <input className="input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" aria-invalid={touched && displayName.trim().length < 2} required />
                  {touched && displayName.trim().length < 2 ? <p className="mt-1 text-[12px] text-danger">Enter at least two characters.</p> : null}
                </Field>
                <Field label="Workspace name" hint="Optional; you can use your name and change it later.">
                  <input className="input" value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} autoComplete="organization" />
                </Field>
                <Field label="Email" required>
                  <input className="input" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(event) => setEmail(event.target.value)} onBlur={() => setTouched(true)} aria-invalid={touched && Boolean(errors.email)} required />
                  {touched && errors.email ? <p className="mt-1 text-[12px] text-danger">{errors.email}</p> : null}
                </Field>
                <Field label="Password" hint="At least 12 characters with upper, lower and a digit." required>
                  <input className="input" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} onBlur={() => setTouched(true)} aria-invalid={touched && Boolean(errors.password)} required />
                  {touched && errors.password ? <p className="mt-1 text-[12px] text-danger">{errors.password}</p> : null}
                </Field>
                <Field label="Confirm password" required>
                  <input className="input" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} aria-invalid={touched && password !== confirmPassword} required />
                  {touched && password !== confirmPassword ? <p className="mt-1 text-xs text-danger">Passwords must match.</p> : null}
                </Field>
                {register.error ? <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5 text-[12.5px] text-danger">{describeAuthError(register.error).message}</div> : null}
                <button className="btn-primary w-full" type="submit" disabled={register.isPending}>
                  {register.isPending ? <span className="flex items-center justify-center gap-2"><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden="true" />Creating account…</span> : 'Create account'}
                </button>
              </form>
            )}
            <div className="mt-4 border-t border-line pt-3.5 text-center text-[12.5px] text-ink-faint">Already have an account? <Link href="/login" className="font-medium text-accent hover:underline">Sign in</Link></div>
          </Card>
        </div>
      </main>
    </div>
  );
}
