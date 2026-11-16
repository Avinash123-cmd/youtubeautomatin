'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { BackendDown } from '@/components/backend-down';
import { Card, Field } from '@/components/ui';
import { describeAuthError, validateCredentials } from '@/lib/auth-messages';
import { useRegister, useSession, useSignInProviders } from '@/lib/hooks';

export default function RegisterPage() {
  const router = useRouter();
  const session = useSession();
  const providers = useSignInProviders();
  const register = useRegister();
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
    if (Object.keys(errors).length || displayName.trim().length < 2) return;
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
