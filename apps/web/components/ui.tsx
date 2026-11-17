'use client';

import clsx from 'clsx';
import type { ReactNode } from 'react';

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('card', className)}>{children}</div>;
}

export function CardHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
        {description ? <p className="mt-0.5 text-[13px] leading-relaxed text-ink-soft">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0 whitespace-nowrap">{action}</div> : null}
    </div>
  );
}

const badgeTones: Record<string, string> = {
  neutral: 'bg-surface-sunken text-ink-soft',
  accent: 'bg-accent-soft text-accent-strong',
  positive: 'bg-positive-soft text-positive',
  caution: 'bg-caution-soft text-caution',
  danger: 'bg-danger-soft text-danger',
};

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: keyof typeof badgeTones;
  className?: string;
}) {
  return <span className={clsx('badge', badgeTones[tone], className)}>{children}</span>;
}

const statusTones: Record<string, keyof typeof badgeTones> = {
  COMPLETED: 'positive',
  PUBLISHED: 'positive',
  READY: 'positive',
  healthy: 'positive',
  CONNECTED: 'positive',
  VALID: 'positive',
  VALIDATED: 'positive',
  RUNNING: 'accent',
  QUEUED: 'accent',
  PENDING: 'accent',
  PROBING: 'accent',
  TRANSCRIBING: 'accent',
  AI_ANALYSIS: 'accent',
  CLIP_SELECTION: 'accent',
  RENDERING: 'accent',
  VALIDATION: 'accent',
  ASSET_STORAGE: 'accent',
  PUBLISHING_QUEUED: 'accent',
  PUBLISHING: 'accent',
  UPLOADING: 'accent',
  AWAITING_PLATFORM: 'accent',
  INITIATED: 'caution',
  RETRYING: 'caution',
  PARTIALLY_COMPLETED: 'caution',
  PARTIALLY_PUBLISHED: 'caution',
  NEEDS_CONFIGURATION: 'caution',
  degraded: 'caution',
  unconfigured: 'caution',
  EXPIRING_SOON: 'caution',
  QUEUED_PUBLISH: 'accent',
  FAILED: 'danger',
  RENDER_FAILED: 'danger',
  PUBLISH_FAILED: 'danger',
  REJECTED: 'danger',
  down: 'danger',
  ERROR: 'danger',
  EXPIRED: 'danger',
  CANCELLED: 'neutral',
  ARCHIVED: 'neutral',
};

const statusDot: Record<string, string> = {
  positive: 'bg-positive',
  accent: 'bg-accent',
  caution: 'bg-caution',
  danger: 'bg-danger',
  neutral: 'bg-ink-faint',
};

export function StatusBadge({ value }: { value: string | null | undefined }) {
  const raw = typeof value === 'string' && value.length > 0 ? value : 'unknown';
  const tone = statusTones[raw] ?? 'neutral';
  return (
    <Badge tone={tone}>
      <span aria-hidden="true" className={clsx('h-1.5 w-1.5 rounded-full', statusDot[tone])} />
      {raw.replaceAll('_', ' ').toLowerCase()}
    </Badge>
  );
}

export function ProgressBar({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'positive' | 'danger' }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={clsx('h-full rounded-full transition-all duration-700 ease-out', {
          'bg-brand-gradient': tone === 'accent',
          'bg-positive': tone === 'positive',
          'bg-danger': tone === 'danger',
        })}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone,
  icon,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'default' | 'danger' | 'positive' | 'caution';
  icon?: IconName;
}) {
  return (
    <Card className="card-hover px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-ink-soft">{label}</p>
        {icon ? (
          <span className={clsx('grid h-8 w-8 shrink-0 place-items-center rounded-xl', {
            'bg-accent-soft text-accent': !tone || tone === 'default',
            'bg-danger-soft text-danger': tone === 'danger',
            'bg-positive-soft text-positive': tone === 'positive',
            'bg-caution-soft text-caution': tone === 'caution',
          })}>
            <Icon name={icon} className="h-4 w-4" />
          </span>
        ) : null}
      </div>
      <p
        className={clsx('mt-1 text-[26px] font-semibold leading-tight tracking-tight', {
          'text-ink': !tone || tone === 'default',
          'text-danger': tone === 'danger',
          'text-positive': tone === 'positive',
          'text-caution': tone === 'caution',
        })}
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs leading-relaxed text-ink-faint">{hint}</p> : null}
    </Card>
  );
}

export function Field({ label, hint, children, required }: { label: string; hint?: string; children: ReactNode; required?: boolean }) {
  return (
    <label className="block">
      <span className="label">
        {label}
        {required ? <span className="ml-0.5 text-danger">*</span> : null}
      </span>
      <div className="mt-1.5">{children}</div>
      {hint ? <p className="mt-1 hint">{hint}</p> : null}
    </label>
  );
}

export function EmptyState({ title, description, action, icon = 'inbox' }: { title: string; description: string; action?: ReactNode; icon?: IconName }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <div className="mb-1 grid h-11 w-11 place-items-center rounded-2xl bg-accent-soft text-accent">
        <Icon name={icon} className="h-5 w-5" />
      </div>
      <p className="text-sm font-semibold text-ink">{title}</p>
      <p className="max-w-sm text-[13px] leading-relaxed text-ink-soft">{description}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry, code, missing }: { message: string; onRetry?: () => void; code?: string; missing?: string[] }) {
  return (
    <div role="alert" className="rounded-xl2 border border-danger/25 bg-danger-soft px-4 py-3 text-sm">
      <p className="font-medium text-danger">{code ? `${code}: ` : ''}{message}</p>
      {missing && missing.length > 0 ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[13px] text-danger">
          {missing.map((key) => (
            <li key={key}>
              <code className="rounded bg-white/70 px-1 py-0.5 font-mono text-xs">{key}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {onRetry ? (
        <button type="button" onClick={onRetry} className="btn-secondary mt-3 !py-1.5 text-[13px]">
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-5" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="skeleton h-9" />
      ))}
    </div>
  );
}

export function Toast({ tone = 'neutral', children, onClose }: { tone?: 'neutral' | 'positive' | 'danger'; children: ReactNode; onClose?: () => void }) {
  return (
    <div
      className={clsx('animate-fade-up fixed bottom-5 right-5 z-50 flex max-w-sm items-start gap-3 rounded-xl2 border px-4 py-3 text-sm shadow-pop', {
        'border-line bg-white text-ink': tone === 'neutral',
        'border-positive/30 bg-positive-soft text-positive': tone === 'positive',
        'border-danger/30 bg-danger-soft text-danger': tone === 'danger',
      })}
      role="status"
    >
      <span className="flex-1">{children}</span>
      {onClose ? (
        <button type="button" onClick={onClose} className="text-ink-faint hover:text-ink" aria-label="Dismiss">
          ×
        </button>
      ) : null}
    </div>
  );
}

export function Section({
  title,
  description,
  children,
  action,
  as: Heading = 'h2',
  actionClassName,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
  action?: ReactNode;
  /** The first Section on a page is that page's document heading (`h1`); the rest stay `h2`. */
  as?: 'h1' | 'h2';
  actionClassName?: string;
}) {
  const headingClass =
    Heading === 'h1'
      ? 'text-[21px] font-semibold leading-tight tracking-tight text-ink sm:text-[24px]'
      : 'text-[17px] font-semibold tracking-tight text-ink';
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <Heading className={headingClass}>{title}</Heading>
          {description ? <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed text-ink-soft">{description}</p> : null}
        </div>
        {action ? <div className={clsx('shrink-0', actionClassName)}>{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {eyebrow ? <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">{eyebrow}</p> : null}
        <h1 className="mt-1.5 text-[24px] font-semibold leading-tight tracking-tight text-ink sm:text-[28px]">{title}</h1>
        {description ? <p className="mt-2 max-w-[68ch] text-sm leading-relaxed text-ink-soft">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Chip({
  active = false,
  onClick,
  children,
  className,
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  const classes = clsx('chip', active && 'chip-active', className);
  if (!onClick) return <span className={classes}>{children}</span>;
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={classes}>
      {children}
    </button>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{label}</p>
        {description ? <p className="mt-0.5 text-xs leading-relaxed text-ink-faint">{description}</p> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50',
          checked ? 'bg-accent' : 'bg-line-strong',
        )}
      >
        <span
          aria-hidden="true"
          className={clsx('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', checked ? 'left-[22px]' : 'left-0.5')}
        />
      </button>
    </div>
  );
}

export function Steps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
      {steps.map((step, index) => {
        const state = index < current ? 'done' : index === current ? 'active' : 'todo';
        return (
          <li key={step} className="flex items-center gap-2">
            <span
              className={clsx('grid h-6 w-6 place-items-center rounded-full text-[11px] font-semibold ring-1', {
                'bg-accent text-white ring-accent': state === 'active',
                'bg-positive-soft text-positive ring-positive/30': state === 'done',
                'bg-white text-ink-faint ring-line-strong': state === 'todo',
              })}
            >
              {state === 'done' ? <Icon name="check" className="h-3 w-3" /> : index + 1}
            </span>
            <span className={clsx('font-medium', state === 'todo' ? 'text-ink-faint' : 'text-ink')}>{step}</span>
            {index < steps.length - 1 ? <span aria-hidden="true" className="mx-1 hidden h-px w-8 bg-line-strong sm:block" /> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={clsx('h-4 w-4 animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export type IconName =
  | 'youtube' | 'instagram' | 'sparkles' | 'upload' | 'link' | 'scissors' | 'captions' | 'clock'
  | 'check' | 'arrow-right' | 'play' | 'film' | 'shield' | 'plus' | 'external' | 'inbox' | 'chart' | 'calendar';

const ICON_PATHS: Record<IconName, ReactNode> = {
  youtube: <><rect x="2.5" y="5.5" width="19" height="13" rx="4" /><path d="M10.5 9.5l4.5 2.5-4.5 2.5z" /></>,
  instagram: <><rect x="3.5" y="3.5" width="17" height="17" rx="5" /><circle cx="12" cy="12" r="3.6" /><path d="M16.8 7.3h.01" /></>,
  sparkles: <><path d="M12 3.5l1.6 4.1 4.1 1.6-4.1 1.6L12 15l-1.6-4.2L6.3 9.2l4.1-1.6z" /><path d="M18 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /></>,
  upload: <><path d="M12 16V4.5" /><path d="M7.5 9L12 4.5 16.5 9" /><path d="M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15" /></>,
  link: <><path d="M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1" /><path d="M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1" /></>,
  scissors: <><circle cx="6.5" cy="6.5" r="2.5" /><circle cx="6.5" cy="17.5" r="2.5" /><path d="M8.5 8.5L20 19M8.5 15.5L20 5" /></>,
  captions: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M9 10.5a2.5 2.5 0 1 0 0 3M16.5 10.5a2.5 2.5 0 1 0 0 3" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  check: <path d="M4.5 12.5l5 5 10-11" />,
  'arrow-right': <><path d="M4.5 12h15" /><path d="M13.5 6l6 6-6 6" /></>,
  play: <path d="M7 4.5l13 7.5-13 7.5z" />,
  film: <><rect x="3" y="4.5" width="18" height="15" rx="3" /><path d="M7.5 4.5v15M16.5 4.5v15M3 12h18" /></>,
  shield: <><path d="M12 3.5l7.5 3v5.5c0 4.6-3.1 7.7-7.5 8.5-4.4-.8-7.5-3.9-7.5-8.5V6.5z" /><path d="M9 12l2 2 4-4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  external: <><path d="M14 4.5h5.5V10" /><path d="M19.5 4.5L11 13" /><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V8A1.5 1.5 0 0 1 6 6.5h4" /></>,
  inbox: <><path d="M3.5 12.5l2.6-7A1.5 1.5 0 0 1 7.5 4.5h9a1.5 1.5 0 0 1 1.4 1l2.6 7" /><path d="M3.5 12.5h5l1 2.5h5l1-2.5h5V18a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 18z" /></>,
  chart: <><path d="M4 19.5V10M9.5 19.5V5M15 19.5v-7M20.5 19.5V8" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={clsx('h-5 w-5', className)}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}
