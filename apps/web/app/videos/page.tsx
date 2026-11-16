'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { processingRequest } from '@/lib/processing-request';
import { useConfiguration } from '@/lib/hooks';
import { Card, EmptyState, ErrorState, Field, Section, Skeleton, StatusBadge } from '@/components/ui';

interface Source {
  id: string; originalFileName: string | null; status: string; kind: string;
  sizeBytes: number | null; durationSeconds: number | null; width: number | null; height: number | null;
  mediaUrl: string | null; rejectionReason: string | null; createdAt: string;
}

export default function VideosPage() {
  const router = useRouter();
  const configuration = useConfiguration();
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Source | null>(null);
  const sources = useQuery({
    queryKey: ['sources', search, status, sort, page],
    queryFn: ({ signal }) => {
      const query = new URLSearchParams({ page: String(page), pageSize: '20', sort });
      if (search) query.set('search', search);
      if (status) query.set('status', status);
      return api<{ items: Source[]; total: number; page: number; pageSize: number }>(`/api/sources?${query}`, { signal });
    },
    refetchInterval: 20000,
  });
  const process = useMutation({
    mutationFn: (source: Source) => api<{ id: string }>('/api/jobs', { method: 'POST', body: processingRequest(source.id, configuration.data?.values ?? {}, [15, 30]) }),
    onSuccess: (job) => router.push(`/jobs/${job.id}`),
  });
  const canProcess = Boolean(configuration.data && !configuration.data.missingForProcessing.length);

  return <div className="space-y-5">
    <Section as="h1" title="Video library" description="Your workspace sources, validation results and reusable footage." action={<Link href="/create" className="btn-primary">Upload video</Link>} />
    <Card className="p-4">
      <form className="grid items-end gap-3 sm:grid-cols-[1fr_180px_160px_auto]" onSubmit={(event) => { event.preventDefault(); setSearch(draft.trim()); setPage(1); }}>
        <Field label="Search filenames"><input className="input" value={draft} maxLength={200} onChange={(event) => setDraft(event.target.value)} type="search" placeholder="Find a video…" /></Field>
        <Field label="Validation status"><select className="input" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">All statuses</option>{['INITIATED', 'UPLOADED', 'VALIDATED', 'REJECTED', 'ARCHIVED'].map((value) => <option key={value} value={value}>{value.toLowerCase()}</option>)}</select></Field>
        <Field label="Sort"><select className="input" value={sort} onChange={(event) => { setSort(event.target.value); setPage(1); }}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="largest">Largest first</option></select></Field>
        <button type="submit" className="btn-secondary">Search</button>
      </form>
    </Card>
    {!canProcess ? <p className="text-sm text-ink-soft">Processing requires saved workspace settings. <Link href="/settings" className="text-accent underline">Review configuration</Link></p> : null}
    {configuration.error ? <ErrorState message={configuration.error.message} onRetry={() => void configuration.refetch()} /> : null}
    {process.error ? <ErrorState message={process.error.message} onRetry={() => process.reset()} /> : null}
    <Card>
      {sources.isLoading ? <Skeleton rows={6} /> : sources.error ? <div className="p-5"><ErrorState message={sources.error.message} onRetry={() => void sources.refetch()} /></div> : !sources.data?.items.length ? <EmptyState title="No videos found" description="Upload footage or change the search and filters." /> : <>
        <ul className="divide-y divide-line">{sources.data.items.map((source) => <li key={source.id} className="flex flex-wrap items-center justify-between gap-4 p-5">
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-ink">{source.originalFileName ?? 'Imported source'}</p><p className="mt-1 text-xs text-ink-faint">{source.durationSeconds === null ? 'Duration unavailable' : `${source.durationSeconds.toFixed(1)}s`} · {source.sizeBytes === null ? 'Size unavailable' : `${(source.sizeBytes / 1048576).toFixed(1)} MiB`} · {source.width && source.height ? `${source.width}×${source.height}` : 'Resolution unavailable'}</p>{source.rejectionReason ? <p className="mt-2 text-xs text-danger">{source.rejectionReason}</p> : null}</div>
          <StatusBadge value={source.status} />
          <div className="flex gap-2">{source.mediaUrl ? <button type="button" className="btn-secondary" onClick={() => setSelected(source)}>Preview</button> : null}<button type="button" className="btn-secondary" disabled={source.status !== 'VALIDATED' || !canProcess || process.isPending} onClick={() => process.mutate(source)}>{process.isPending && process.variables?.id === source.id ? 'Queueing…' : 'Generate clips'}</button></div>
        </li>)}</ul>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line p-4 text-sm text-ink-soft"><p aria-live="polite">{sources.data.total} video(s) · page {page} of {Math.max(1, Math.ceil(sources.data.total / 20))}{sources.isFetching ? ' · refreshing…' : ''}</p><div className="flex gap-2"><button className="btn-secondary" type="button" disabled={page === 1 || sources.isFetching} onClick={() => setPage((value) => value - 1)}>Previous</button><button className="btn-secondary" type="button" disabled={page * 20 >= sources.data.total || sources.isFetching} onClick={() => setPage((value) => value + 1)}>Next</button></div></div>
      </>}
    </Card>
    <p className="text-xs text-ink-faint">Generate clips uses saved framing/caption settings, requests 15s and 30s candidates, and never automatically publishes. Active-job conflicts are checked by the API.</p>
    {selected?.mediaUrl ? <Card className="p-5"><div className="mb-3 flex items-center justify-between gap-3"><h2 className="truncate font-semibold">{selected.originalFileName ?? 'Source preview'}</h2><button className="btn-secondary" type="button" onClick={() => setSelected(null)}>Close preview</button></div><video className="max-h-[60vh] w-full rounded-lg bg-black" controls preload="metadata" src={selected.mediaUrl} aria-label="Source video preview" /></Card> : null}
  </div>;
}
