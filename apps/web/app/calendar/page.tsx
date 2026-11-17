'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Card, CardHeader, EmptyState, ErrorState, Section, Skeleton, StatusBadge } from '@/components/ui';
import { usePublishingCalendar } from '@/lib/hooks';
import { localDateKey, monthWindow } from '@/lib/calendar';

export default function CalendarPage() {
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [page, setPage] = useState(1);
  const window = monthWindow(month.getFullYear(), month.getMonth());
  const calendar = usePublishingCalendar(window.from, window.to, page);
  const changeMonth = (delta: number) => { setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1)); setPage(1); };
  const jobs = calendar.data?.items ?? [];
  const label = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return <div className="space-y-6">
    <Section as="h1" title="Content calendar" description={`Your persisted publishing schedule · times in ${timezone}. Scheduling is available from each clip's publish dialog.`} />
    <Card>
      <CardHeader title={label} description="Only explicitly scheduled jobs appear here. Immediate publishes remain in Publishing history." action={<div className="flex gap-2"><button className="btn-secondary" aria-label="Previous month" onClick={() => changeMonth(-1)}>←</button><button className="btn-secondary" onClick={() => { setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1)); setPage(1); }}>Today</button><button className="btn-secondary" aria-label="Next month" onClick={() => changeMonth(1)}>→</button></div>} />
      {calendar.isLoading ? <Skeleton rows={6} /> : calendar.error ? <ErrorState message={calendar.error.message} onRetry={() => void calendar.refetch()} /> : <>
        <div className="overflow-x-auto p-3 sm:p-5"><div className="min-w-[700px]">
          <div className="grid grid-cols-7 pb-3 text-center text-xs font-semibold uppercase tracking-wide text-ink-faint">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => <div key={day}>{day}</div>)}</div>
          <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-line bg-line">
            {Array.from({ length: window.offset }, (_, i) => <div key={`empty-${i}`} className="min-h-32 bg-surface-muted" aria-hidden="true" />)}
            {Array.from({ length: window.days }, (_, i) => {
              const date = new Date(month.getFullYear(), month.getMonth(), i + 1);
              const dayJobs = jobs.filter(job => job.scheduledFor && localDateKey(new Date(job.scheduledFor)) === localDateKey(date));
              const today = localDateKey(date) === localDateKey(new Date());
              return <div key={i} className="min-h-32 bg-white p-2"><time dateTime={localDateKey(date)} className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${today ? 'bg-accent text-white' : 'text-ink-soft'}`}>{i + 1}</time>
                <ul className="mt-2 space-y-2">{dayJobs.map(job => <li key={job.id} className="rounded-lg border border-line bg-surface-muted p-2"><Link href="/publishing" className="block text-xs font-semibold text-ink hover:text-accent">{job.clip.title}</Link><p className="my-1 text-[11px] text-ink-soft">{new Date(job.scheduledFor!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {job.platform}</p><p className="mb-1 truncate text-[11px] text-ink-faint">{job.account.displayName}</p><StatusBadge value={job.status} /></li>)}</ul>
              </div>;
            })}
          </div>
        </div></div>
        {calendar.data?.total === 0 ? <EmptyState title="A clear month, ready for your next idea" description="Schedule a rendered clip to see its publishing time here. No sample events are shown." action={<Link className="btn-primary" href="/clips">Browse clips</Link>} /> : null}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line p-4 text-xs text-ink-soft"><span>{calendar.data?.total ?? 0} scheduled jobs · Page {page} of {Math.max(1, Math.ceil((calendar.data?.total ?? 0) / 100))}. {calendar.data && calendar.data.total > 100 ? 'The calendar shows this page only.' : ''}</span><div className="flex gap-2"><button className="btn-secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>Previous page</button><button className="btn-secondary" disabled={page * 100 >= (calendar.data?.total ?? 0)} onClick={() => setPage(page + 1)}>Next page</button></div></div>
      </>}
    </Card>
  </div>;
}
