'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { BackendDown } from '@/components/backend-down';
import { Card, Field } from '@/components/ui';
import { describeAuthError, validateCredentials } from '@/lib/auth-messages';
import { useForgotPassword, useResetPassword, useSession } from '@/lib/hooks';

export default function ForgotPasswordPage() {
  const router = useRouter();
  const session = useSession();
  const forgot = useForgotPassword();
  const reset = useResetPassword();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [requested, setRequested] = useState(false);
  const [touched, setTouched] = useState(false);
  const credentialErrors = useMemo(() => validateCredentials(email, password, 'register'), [email, password]);

  useEffect(() => {
    if (session.data?.authenticated) router.replace('/');
  }, [session.data?.authenticated, router]);

  if (session.error) return <BackendDown message={session.error.message} onRetry={() => void session.refetch()} />;

  const requestReset = (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!email.trim() || credentialErrors.email) return;
    forgot.mutate(email.trim(), { onSuccess: () => setRequested(true) });
  };

  const finishReset = (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!/^\d{6}$/.test(code) || credentialErrors.password) return;
    reset.mutate({ email: email.trim(), code, newPassword: password }, { onSuccess: () => router.replace('/login?passwordReset=1') });
  };

  return (
    <div className="flex min-h-[100dvh] flex-col bg-surface-muted lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <aside className="relative hidden overflow-hidden bg-ink px-10 py-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="pointer-events-none absolute inset-0 opacity-[0.16]" style={{ backgroundImage: 'radial-gradient(circle at 20% 15%, #6b7bff 0, transparent 45%), radial-gradient(circle at 85% 80%, #22d3a7 0, transparent 40%)' }} />
        <div className="relative">
          <div className="flex items-center gap-2.5"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-sm font-bold text-ink">CF</span><span className="text-[15px] font-semibold tracking-tight">ClipForge AI</span></div>
          <h1 className="mt-14 max-w-[15ch] text-[34px] font-semibold leading-[1.1] tracking-tight">Back to making your next great cut.</h1>
          <p className="mt-4 max-w-[38ch] text-[14px] leading-relaxed text-white/70">Reset access with a short-lived verification code. Every existing session is revoked after a successful reset.</p>
        </div>
        <p className="relative text-[11px] text-white/40">Verification codes expire and can only be used once.</p>
      </aside>

      <main className="flex flex-1 items-center justify-center px-4 py-8 sm:px-8 sm:py-12">
        <div className="w-full max-w-[440px]">
          <div className="mb-6 flex items-center gap-2.5 lg:hidden"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-ink text-sm font-bold text-white">CF</span><span className="text-[15px] font-semibold text-ink">ClipForge AI</span></div>
          <Card className="p-5 sm:p-6">
            <div className="mb-5"><h2 className="text-[20px] font-semibold tracking-tight text-ink">Reset your password</h2><p className="mt-1 text-[13px] text-ink-soft">We’ll send a one-time code to your recovery channel.</p></div>

            {!requested ? (
              <form onSubmit={requestReset} className="space-y-3.5" noValidate>
                <Field label="Email" required>
                  <input className="input" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(event) => setEmail(event.target.value)} onBlur={() => setTouched(true)} aria-invalid={touched && Boolean(credentialErrors.email)} required />
                  {touched && credentialErrors.email ? <p className="mt-1 text-[12px] text-danger">{credentialErrors.email}</p> : null}
                </Field>
                {forgot.error ? <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5 text-[12.5px] text-danger">{describeAuthError(forgot.error).message}</div> : null}
                <button className="btn-primary w-full" type="submit" disabled={forgot.isPending}>{forgot.isPending ? 'Sending code…' : 'Send reset code'}</button>
              </form>
            ) : (
              <form onSubmit={finishReset} className="space-y-3.5" noValidate>
                <p role="status" className="rounded-lg bg-positive-soft px-3.5 py-3 text-[12.5px] leading-relaxed text-positive">If an account can be recovered with that address, a code has been sent. Check your inbox or linked Telegram channel.</p>
                <Field label="Six-digit code" hint="The code expires shortly and works once." required>
                  <input className="input font-mono tracking-[0.3em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} aria-invalid={touched && code.length > 0 && code.length !== 6} required />
                </Field>
                <Field label="New password" hint="At least 12 characters with upper, lower and a digit." required>
                  <input className="input" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} onBlur={() => setTouched(true)} aria-invalid={touched && Boolean(credentialErrors.password)} required />
                  {touched && credentialErrors.password ? <p className="mt-1 text-[12px] text-danger">{credentialErrors.password}</p> : null}
                </Field>
                {reset.error ? <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2.5 text-[12.5px] text-danger">{describeAuthError(reset.error).message}</div> : null}
                <button className="btn-primary w-full" type="submit" disabled={reset.isPending}>{reset.isPending ? 'Resetting password…' : 'Set new password'}</button>
                <button type="button" className="w-full text-[12px] font-medium text-accent hover:underline" onClick={() => { setRequested(false); setCode(''); reset.reset(); }}>Use a different email</button>
              </form>
            )}
            <div className="mt-4 border-t border-line pt-3.5 text-center text-[12.5px] text-ink-faint"><Link href="/login" className="font-medium text-accent hover:underline">Back to sign in</Link></div>
          </Card>
        </div>
      </main>
    </div>
  );
}
