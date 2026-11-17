'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { processingRequest } from '@/lib/processing-request';
import { useConfiguration } from '@/lib/hooks';
import { formatClock } from '@/lib/youtube';
import { Card, EmptyState, ErrorState, Field, Icon, PageHeader, Skeleton, StatusBadge } from '@/components/ui';

interface Source {
  id: string;
  originalFileName: string | null;
  status: string;
  kind: string;
  sizeBytes: number | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  mediaUrl: string | null;
  rejectionReason: string | null;
  youTubeReferenceUrl: string | null;
  sourceUrl: string | null;
  metadata: { thumbnailUrl?: string | null; title?: string | null; author?: string | null; videoId?: string | null } | null;
  createdAt: string;
}

const KIND_LABEL: Record<string, string> = { YOUTUBE: 'YouTube', UPLOAD: 'Upload', DIRECT_URL: 'Direct URL', STORAGE_PROVIDER: 'Storage' };

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
    refetchInterval: 20_000,
  });

  const process = useMutation({
    mutationFn: (source: Source) =>
      api<{ id: string }>('/api/jobs', { method: 'POST', body: processingRequest(source.id, configuration.data?.values ?? {}, [15, 30]) }),
    onSuccess: (job) => router.push(`/jobs/${job.id}`),
  });
  const canProcess = Boolean(configuration.data && !configuration.data.missingForProcessing.length);
  const total = sources.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / 20));

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Library"
        title="Video library"
        description="Every source in this workspace, whether it arrived as a YouTube link, an upload or an authorised direct URL."
        actions={
          <Link href="/create" className="btn-gradient">
            <Icon name="youtube" className="h-4 w-4" />
            Add a source
          </Link>
        }
      />

      <Card className="p-4">
        <form
          className="grid items-end gap-3 sm:grid-cols-[1fr_170px_160px_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(draft.trim());
            setPage(1);
          }}
        >
          <Field label="Search filenames">
            <input className="input" value={draft} maxLength={200} onChange={(event) => setDraft(event.target.value)} type="search" placeholder="Find a video…" />
          </Field>
          <Field label="Status">
            <select className="input" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
              <option value="">All statuses</option>
              {['INITIATED', 'UPLOADED', 'VALIDATED', 'REJECTED', 'ARCHIVED'].map((value) => (
                <option key={value} value={value}>{value.toLowerCase()}</option>
              ))}
            </select>
          </Field>
          <Field label="Sort">
            <select className="input" value={sort} onChange={(event) => { setSort(event.target.value); setPage(1); }}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="largest">Largest first</option>
            </select>
          </Field>
          <button type="submit" className="btn-secondary">Search</button>
        </form>
      </Card>

      {!canProcess ? (
        <p className="text-sm text-ink-soft">
          Processing requires saved workspace settings.{' '}
          <Link href="/settings" className="font-medium text-accent underline">Review configuration</Link>
        </p>
      ) : null}
      {configuration.error ? <ErrorState message={configuration.error.message} onRetry={() => void configuration.refetch()} /> : null}
      {process.error ? <ErrorState message={process.error.message} onRetry={() => process.reset()} /> : null}

      <Card>
        {sources.isLoading ? (
          <Skeleton rows={6} />
        ) : sources.error ? (
          <div className="p-5"><ErrorState message={sources.error.message} onRetry={() => void sources.refetch()} /></div>
        ) : !sources.data?.items.length ? (
          <EmptyState
            icon="film"
            title="No videos yet"
            description="Paste a YouTube link or upload footage to create your first project."
            action={<Link href="/create" className="btn-primary">Create a project</Link>}
          />
        ) : (
          <>
            <ul className="divide-y divide-line">
              {sources.data.items.map((source) => {
                const title = source.metadata?.title ?? source.originalFileName ?? 'Untitled source';
                const canGenerate = source.status === 'VALIDATED' || (source.kind === 'YOUTUBE' && source.status === 'INITIATED');
                return (
                  <li key={source.id} className="flex flex-wrap items-center gap-4 p-4 sm:p-5">
                    <div className="relative h-[62px] w-[110px] shrink-0 overflow-hidden rounded-xl bg-surface-sunken">
                      {source.metadata?.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={source.metadata.thumbnailUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
                      ) : (
                        <span className="grid h-full w-full place-items-center text-ink-faint"><Icon name="film" className="h-5 w-5" /></span>
                      )}
                      {source.durationSeconds ? (
                        <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 text-[10px] font-medium text-white">
                          {formatClock(source.durationSeconds)}
                        </span>
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold text-ink">{title}</p>
                        <span className="badge bg-surface-sunken text-ink-soft">{KIND_LABEL[source.kind] ?? source.kind}</span>
                      </div>
                      <p className="mt-1 text-xs text-ink-faint">
                        {source.metadata?.author ? `${source.metadata.author} · ` : ''}
                        {source.sizeBytes === null ? 'size pending' : `${(source.sizeBytes / 1048576).toFixed(1)} MiB`}
                        {source.width && source.height ? ` · ${source.width}×${source.height}` : ''}
                      </p>
                      {source.rejectionReason ? <p className="mt-2 text-xs text-danger">{source.rejectionReason}</p> : null}
                    </div>
                    <StatusBadge value={source.status} />
                    <div className="flex gap-2">
                      {source.mediaUrl ? (
                        <button type="button" className="btn-secondary !py-1.5 text-[13px]" onClick={() => setSelected(source)}>Preview</button>
                      ) : null}
                      {source.youTubeReferenceUrl ? (
                        <a href={source.youTubeReferenceUrl} target="_blank" rel="noreferrer" className="btn-secondary !py-1.5 text-[13px]" aria-label="Open the original on YouTube">
                          <Icon name="external" className="h-3.5 w-3.5" />
                        </a>
                      ) : null}
                      <button
                        type="button"
                        className="btn-primary !py-1.5 text-[13px]"
                        disabled={!canGenerate || !canProcess || process.isPending}
                        onClick={() => process.mutate(source)}
                      >
                        {process.isPending && process.variables?.id === source.id ? 'Queueing…' : 'Generate clips'}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line p-4 text-sm text-ink-soft">
              <p aria-live="polite">
                {total} video(s) · page {page} of {lastPage}{sources.isFetching ? ' · refreshing…' : ''}
              </p>
              <div className="flex gap-2">
                <button className="btn-secondary !py-1.5 text-[13px]" type="button" disabled={page === 1 || sources.isFetching} onClick={() => setPage((value) => value - 1)}>Previous</button>
                <button className="btn-secondary !py-1.5 text-[13px]" type="button" disabled={page >= lastPage || sources.isFetching} onClick={() => setPage((value) => value + 1)}>Next</button>
              </div>
            </div>
          </>
        )}
      </Card>

      <p className="text-xs leading-relaxed text-ink-faint">
        Generate clips uses your saved framing and caption settings and requests 15s and 30s candidates. Sources are processed once
        at a time; the API rejects a second active job for the same source.
      </p>

      {selected?.mediaUrl ? (
        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="truncate font-semibold">{selected.metadata?.title ?? selected.originalFileName ?? 'Source preview'}</h2>
            <button className="btn-secondary !py-1.5 text-[13px]" type="button" onClick={() => setSelected(null)}>Close preview</button>
          </div>
          <video className="max-h-[60vh] w-full rounded-xl2 bg-black" controls preload="metadata" src={selected.mediaUrl} aria-label="Source video preview" />
        </Card>
      ) : null}
    </div>
  );
}
