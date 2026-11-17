'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, formatDuration } from '@/lib/api';
import { Card, CardHeader, EmptyState, ErrorState, Skeleton } from '@/components/ui';

interface Analysis {
  transcript: { language: string; provider: string; model: string } | null;
  segments: Array<{ id: string; startSeconds: number; endSeconds: number; text: string; speakerLabel: string | null }>;
  segmentCount: number;
  candidates: Array<{ id: string; startSeconds: number; endSeconds: number; hook: string; reason: string; transcriptText: string; qualityScore: number; contentCategory: string }>;
  candidateCount: number;
}

export function JobAnalysis({ jobId, terminal }: { jobId: string; terminal: boolean }) {
  const [page, setPage] = useState(1);
  const result = useQuery({ queryKey: ['job-analysis', jobId, page],
    queryFn: () => api<Analysis>(`/api/jobs/${jobId}/analysis?page=${page}&pageSize=50`),
    refetchInterval: terminal ? false : 5000,
  });
  return <Card>
    <CardHeader title="Transcript and detected moments" description="Source timestamps and AI quality assessments—not predictions of virality." />
    {result.isLoading ? <Skeleton rows={4} /> : result.error ? <ErrorState message={result.error.message} onRetry={() => void result.refetch()} /> : result.data ? <div className="space-y-5 px-5 py-4">
      {result.data.transcript ? <p className="text-xs text-ink-soft">{result.data.transcript.language} · {result.data.transcript.provider} · {result.data.transcript.model}</p> : <EmptyState title="No transcript yet" description="The worker will save actual speech recognition results here. Failed or silent media does not produce a substitute transcript." />}
      <div className="max-h-80 space-y-3 overflow-auto" aria-label="Timestamped transcript">
        {result.data.segments.map(segment => <p key={segment.id} className="text-sm"><span className="font-mono text-xs text-ink-soft">{formatDuration(segment.startSeconds)}–{formatDuration(segment.endSeconds)} {segment.speakerLabel ?? ''}</span><br />{segment.text}</p>)}
      </div>
      <h3 className="font-medium">Detected moments ({result.data.candidateCount})</h3>
      {result.data.candidates.length ? result.data.candidates.map(candidate => <article key={candidate.id} className="space-y-2 rounded-lg border border-line p-3">
        <p className="text-xs text-ink-soft">{formatDuration(candidate.startSeconds)}–{formatDuration(candidate.endSeconds)} · Quality {candidate.qualityScore}/100 · {candidate.contentCategory}</p>
        <h4 className="font-medium">{candidate.hook}</h4><p className="text-sm">{candidate.reason}</p>
        <details className="text-sm"><summary className="cursor-pointer">Source speech</summary><p className="mt-2 whitespace-pre-wrap">{candidate.transcriptText}</p></details>
      </article>) : <p className="text-sm text-ink-soft">No candidates on this page. Only moments that pass source validation and the configured quality gate are stored.</p>}
      <div className="flex items-center gap-3 text-sm">
        <button type="button" className="btn-secondary" disabled={page <= 1 || result.isFetching} onClick={() => setPage(value => value - 1)}>Previous</button>
        <span>Page {page}</span>
        <button type="button" className="btn-secondary" disabled={page * 50 >= Math.max(result.data.segmentCount, result.data.candidateCount) || result.isFetching} onClick={() => setPage(value => value + 1)}>Next</button>
      </div>
    </div> : null}
  </Card>;
}
