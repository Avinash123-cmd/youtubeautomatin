'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RIGHTS_DECLARATIONS as RIGHTS } from '@/lib/source-rights';
import { processingConfiguration } from '@/lib/processing-request';
import { api, completeSourceUpload, uploadSource, ApiError, UploadValidationPendingError, type UploadCompletion, type UploadProgress } from '@/lib/api';
import { useAccounts, useConfiguration } from '@/lib/hooks';
import { formatClock, parseYouTubeId, youtubeThumbnail, type YouTubeImportStatus, type YouTubeInspectResponse } from '@/lib/youtube';
import { Card, CardHeader, Chip, ErrorState, Field, Icon, PageHeader, Spinner, Steps, Toggle } from '@/components/ui';

type Mode = 'youtube' | 'upload' | 'url';

const MODES: Array<{ id: Mode; label: string; icon: 'youtube' | 'upload' | 'link'; hint: string }> = [
  { id: 'youtube', label: 'YouTube link', icon: 'youtube', hint: 'Paste a URL — the pipeline downloads and analyses it' },
  { id: 'upload', label: 'Upload a file', icon: 'upload', hint: 'MP4, MOV, WebM or MKV from your own device' },
  { id: 'url', label: 'Direct media URL', icon: 'link', hint: 'A public HTTPS MP4/WebM you are authorised to use' },
];

export default function CreatePage() {
  const router = useRouter();
  const client = useQueryClient();
  const configuration = useConfiguration();

  const [mode, setMode] = useState<Mode>('youtube');
  const [targetDurations, setTargetDurations] = useState<Array<15 | 30>>([15, 30]);
  const [rights, setRights] = useState('');
  const [rightsNote, setRightsNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [debouncedUrl, setDebouncedUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadPhase, setUploadPhase] = useState<UploadProgress['phase'] | null>(null);
  // Keep completion data only in this page, and only for the selected file.
  const [pendingUpload, setPendingUpload] = useState<{ file: File; completion: UploadCompletion } | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [autoPublish, setAutoPublish] = useState(false);
  const [publishPlatforms, setPublishPlatforms] = useState<Array<'YOUTUBE' | 'INSTAGRAM'>>([]);
  const accounts = useAccounts();

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedUrl(youtubeUrl.trim()), 450);
    return () => clearTimeout(timer);
  }, [youtubeUrl]);

  const importStatus = useQuery({
    queryKey: ['youtube-import-status'],
    queryFn: ({ signal }) => api<YouTubeImportStatus>('/api/sources/youtube/status', { signal }),
    retry: false,
    staleTime: 60_000,
  });

  const videoId = useMemo(() => parseYouTubeId(debouncedUrl), [debouncedUrl]);
  // The API requires an absolute https URL; the user may paste "youtu.be/xyz" or a shortened link.
  // Everything downstream uses the canonical watch URL, never the raw input.
  const canonicalYoutubeUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : '';
  const preview = useQuery({
    queryKey: ['youtube-preview', videoId],
    queryFn: ({ signal }) =>
      api<YouTubeInspectResponse>('/api/sources/youtube/inspect', {
        method: 'POST',
        body: { url: canonicalYoutubeUrl },
        signal,
      }),
    enabled: mode === 'youtube' && Boolean(videoId),
    retry: false,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  // Publishing is only offered for accounts that are connected *and* explicitly enabled for
  // automatic publishing; the API enforces the same rule and fails closed.
  // The server summary covers every account page, so later pages cannot hide an eligible platform.
  const eligiblePlatforms = useMemo(() => accounts.data?.eligiblePublishingPlatforms ?? [], [accounts.data]);

  useEffect(() => {
    if (!autoPublish) return;
    setPublishPlatforms((current) => {
      const allowed = current.filter((platform) => eligiblePlatforms.includes(platform));
      return allowed.length > 0 ? allowed : eligiblePlatforms;
    });
  }, [autoPublish, eligiblePlatforms]);

  const missing = configuration.data?.missingForProcessing ?? [];
  const configurationReady = Boolean(configuration.data) && missing.length === 0 && !configuration.error;
  const rightsStatement = rights ? `${rights}${rightsNote.trim() ? ` — ${rightsNote.trim()}` : ''}` : '';

  const createJob = async (sourceVideoId: string) => {
    if (!rightsStatement) throw new Error('A rights declaration is mandatory');
    if (!targetDurations.length) throw new Error('Select at least one clip length');
    if (!configuration.data) throw new Error('Workspace configuration is still loading');
    // Validated locally before any network call so an invalid request never reaches the API.
    if (autoPublish && publishPlatforms.length === 0) throw new Error('Select at least one connected platform for automatic publishing');
    const request = {
      sourceVideoId,
      configuration: processingConfiguration(configuration.data.values, targetDurations, {
        autoPublish: autoPublish && eligiblePlatforms.length > 0,
        platforms: publishPlatforms,
      }),
    };
    return api<{ id: string }>('/api/jobs', { method: 'POST', body: request });
  };

  const youtubeJob = useMutation({
    mutationFn: async () => {
      const source = await api<{ id: string }>('/api/sources/youtube', {
        method: 'POST',
        body: { url: canonicalYoutubeUrl, rightsDeclaration: { accepted: true, statement: rightsStatement } },
      });
      return createJob(source.id);
    },
    onSuccess: (job) => {
      void client.invalidateQueries({ queryKey: ['jobs'] });
      void client.invalidateQueries({ queryKey: ['sources'] });
      void client.invalidateQueries({ queryKey: ['dashboard'] });
      router.push(`/jobs/${job.id}`);
    },
    onError: (mutationError: Error) => setError(describeFailure(mutationError)),
  });

  const uploadJob = useMutation({
    mutationFn: async (selectedFile: File) => {
      let source;
      if (pendingUpload?.file === selectedFile) {
        setUploadPhase('validating');
        source = await completeSourceUpload(pendingUpload.completion, rightsStatement);
      } else {
        source = await uploadSource(selectedFile, {
          rightsStatement,
          onProgress: (progress) => {
            setUploadPercent(progress.percent);
            setUploadPhase(progress.phase);
          },
        });
      }
      setPendingUpload(null);
      return createJob(source.id);
    },
    onSuccess: (job) => {
      setUploadPercent(0);
      setUploadPhase(null);
      void client.invalidateQueries({ queryKey: ['jobs'] });
      router.push(`/jobs/${job.id}`);
    },
    onError: (mutationError: Error, selectedFile) => {
      setUploadPercent(0);
      setUploadPhase(null);
      if (mutationError instanceof UploadValidationPendingError) {
        setPendingUpload({ file: selectedFile, completion: mutationError.completion });
        setError(`${describeFailure(mutationError)} The file is already uploaded; retry validation on this page without uploading it again.`);
      } else {
        setPendingUpload(null);
        setError(describeFailure(mutationError));
      }
    },
  });

  const urlJob = useMutation({
    mutationFn: async () => {
      const source = await api<{ id: string }>('/api/sources/import', {
        method: 'POST',
        body: { url: sourceUrl.trim(), rightsDeclaration: { accepted: true, statement: rightsStatement } },
      });
      return createJob(source.id);
    },
    onSuccess: (job) => router.push(`/jobs/${job.id}`),
    onError: (mutationError: Error) => setError(describeFailure(mutationError)),
  });

  const pending = youtubeJob.isPending || uploadJob.isPending || urlJob.isPending;
  // When the status probe itself failed, assume enabled: the server still refuses with an
  // actionable 428, which is better than a permanently disabled button on a flaky network.
  const importEnabled = importStatus.data ? importStatus.data.enabled : true;
  const youtubeReady = Boolean(videoId) && preview.data?.availability === 'AVAILABLE' && importEnabled;
  const canSubmit =
    configurationReady &&
    Boolean(rights) &&
    targetDurations.length > 0 &&
    !pending &&
    (mode === 'youtube' ? youtubeReady : mode === 'upload' ? Boolean(file) : Boolean(sourceUrl.trim()));

  const submit = () => {
    setError(null);
    if (mode === 'youtube') youtubeJob.mutate();
    else if (mode === 'upload' && file) uploadJob.mutate(file);
    else urlJob.mutate();
  };

  const settings = configuration.data?.values ?? {};
  const currentStep = mode === 'youtube' ? (youtubeReady && rights ? 1 : 0) : rights ? 1 : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="New project"
        title="Paste a link. Get publish-ready clips."
        description="The pipeline downloads the source, transcribes the speech, finds the strongest moments and renders captioned vertical clips. Review them before anything is published."
        actions={
          <Link href="/settings" className="btn-secondary">
            <Icon name="shield" className="h-4 w-4" />
            Processing settings
          </Link>
        }
      />

      <Steps steps={['Choose a source', 'Confirm rights', 'Generate clips']} current={currentStep} />

      {missing.length > 0 ? (
        <ErrorState
          code="CONFIGURATION_REQUIRED"
          message="Processing cannot start until these settings are saved."
          missing={missing}
        />
      ) : null}
      {configuration.error ? (
        <ErrorState message={configuration.error.message} onRetry={() => void configuration.refetch()} />
      ) : null}
      {error ? <ErrorState message={error} /> : null}
      {importStatus.data && !importStatus.data.enabled ? (
        <div className="rounded-xl2 border border-caution/30 bg-caution-soft px-4 py-3 text-sm text-caution">
          <p className="font-medium">YouTube import is disabled on this deployment.</p>
          <p className="mt-1">
            Set <code className="kbd">YOUTUBE_IMPORT_ENABLED=true</code> and install yt-dlp on the API host, or use the upload tab.
          </p>
        </div>
      ) : null}
      {importStatus.data?.enabled && !importStatus.data.tool.available ? (
        <div className="rounded-xl2 border border-caution/30 bg-caution-soft px-4 py-3 text-sm text-caution">
          <p className="font-medium">yt-dlp is not available on the API host.</p>
          <p className="mt-1">{importStatus.data.tool.reason ?? 'Install it with pip install yt-dlp, or set YTDLP_PATH.'}</p>
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr]">
        <div className="space-y-5">
          <Card className="overflow-hidden">
            <div className="flex gap-1 border-b border-line bg-surface-muted/60 p-1.5">
              {MODES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    setMode(option.id);
                    setError(null);
                  }}
                  aria-pressed={mode === option.id}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-xl px-2 py-2.5 text-[13px] font-semibold transition ${
                    mode === option.id ? 'bg-white text-ink shadow-card' : 'text-ink-soft hover:text-ink'
                  }`}
                >
                  <Icon name={option.icon} className={`h-4 w-4 ${option.id === 'youtube' ? 'text-[#FF0033]' : ''}`} />
                  <span className="hidden sm:inline">{option.label}</span>
                  <span className="sm:hidden">{option.label.split(' ')[0]}</span>
                </button>
              ))}
            </div>

            {mode === 'youtube' ? (
              <div className="space-y-4 px-5 py-5">
                <div>
                  <label htmlFor="youtube-url" className="label">
                    YouTube video URL
                  </label>
                  <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
                    <div className="relative flex-1">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#FF0033]">
                        <Icon name="youtube" className="h-5 w-5" />
                      </span>
                      <input
                        id="youtube-url"
                        className="input pl-10"
                        placeholder="https://www.youtube.com/watch?v=…"
                        value={youtubeUrl}
                        inputMode="url"
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => {
                          setYoutubeUrl(event.target.value);
                          setError(null);
                        }}
                      />
                    </div>
                  </div>
                  <p className="mt-1.5 hint">
                    Watch, share, Shorts, live and embed links are all accepted. Only the video named by the id is fetched — playlists are never expanded.
                  </p>
                </div>

                {youtubeUrl && !videoId ? (
                  <p className="text-[13px] text-caution">That does not look like a single YouTube video link.</p>
                ) : null}

                {preview.isPending && videoId ? (
                  <div className="flex items-center gap-3 rounded-xl2 border border-line bg-surface-muted px-4 py-3 text-[13px] text-ink-soft">
                    <Spinner /> Looking up the video…
                  </div>
                ) : null}

                {preview.error ? (
                  <ErrorState message={preview.error.message} onRetry={() => void preview.refetch()} />
                ) : null}

                {preview.data && videoId ? (
                  <div className="cf-rise overflow-hidden rounded-xl2 border border-line">
                    <div className="flex flex-col gap-3 p-3 sm:flex-row">
                      {/* Thumbnails are served by i.ytimg.com, allowed explicitly in the CSP img-src. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={preview.data.thumbnailUrl ?? preview.data.metadata?.thumbnailUrl ?? youtubeThumbnail(videoId)}
                        alt=""
                        width={168}
                        height={94}
                        loading="lazy"
                        className="h-[94px] w-full shrink-0 rounded-lg bg-surface-sunken object-cover sm:w-[168px]"
                      />
                      <div className="min-w-0 flex-1">
                        {preview.data.availability === 'AVAILABLE' ? (
                          <>
                            <p className="line-clamp-2 text-sm font-semibold leading-snug text-ink">
                              {preview.data.metadata?.snippet.title ?? 'YouTube video'}
                            </p>
                            <p className="mt-1 truncate text-[13px] text-ink-soft">{preview.data.metadata?.snippet.channelTitle}</p>
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-faint">
                              <span className="badge bg-positive-soft text-positive">Ready to ingest</span>
                              <span className="font-mono">{videoId}</span>
                              {preview.data.metadata?.durationSeconds ? <span>· {formatClock(preview.data.metadata.durationSeconds)}</span> : null}
                            </div>
                          </>
                        ) : (
                          <p className="text-sm text-danger">YouTube reports this video as unavailable, private or removed.</p>
                        )}
                      </div>
                    </div>
                    <p className="border-t border-line bg-surface-muted px-3 py-2 text-xs leading-relaxed text-ink-soft">{preview.data.message}</p>
                  </div>
                ) : null}
              </div>
            ) : null}

            {mode === 'upload' ? (
              <div className="space-y-4 px-5 py-5">
                <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl2 border border-dashed border-line-strong bg-surface-muted px-5 py-10 text-center transition hover:border-accent/60 hover:bg-accent-soft/30">
                  <span className="grid h-11 w-11 place-items-center rounded-2xl bg-white text-accent shadow-card">
                    <Icon name="upload" className="h-5 w-5" />
                  </span>
                  <span className="mt-3 text-sm font-semibold text-ink">{file ? file.name : 'Choose a video file'}</span>
                  <span className="mt-1 text-xs text-ink-faint">
                    {file ? `${(file.size / 1024 / 1024).toFixed(1)} MB selected` : 'MP4, MOV, WebM or MKV — validated with FFprobe before processing'}
                  </span>
                  <input
                    type="file"
                    accept="video/*"
                    className="sr-only"
                    disabled={pending}
                    onChange={(event) => {
                      setFile(event.target.files?.[0] ?? null);
                      setPendingUpload(null);
                      setUploadPercent(0);
                      setUploadPhase(null);
                      setError(null);
                    }}
                  />
                </label>
                {uploadPercent > 0 && uploadPercent < 100 ? (
                  <div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
                      <div className="h-full rounded-full bg-brand-gradient transition-all" style={{ width: `${uploadPercent}%` }} />
                    </div>
                    <p className="mt-1 text-xs text-ink-soft">Uploading… {uploadPercent}%</p>
                  </div>
                ) : uploadJob.isPending && uploadPhase === 'validating' ? (
                  <p className="text-xs text-ink-soft">Inspecting the uploaded video…</p>
                ) : null}
              </div>
            ) : null}

            {mode === 'url' ? (
              <div className="space-y-4 px-5 py-5">
                <Field label="Direct media URL" required hint="Public HTTPS MP4/WebM. Private ranges and redirects to internal hosts are blocked (SSRF protection).">
                  <input
                    className="input"
                    placeholder="https://cdn.example.com/episode-12.mp4"
                    value={sourceUrl}
                    onChange={(event) => {
                      setSourceUrl(event.target.value);
                      setError(null);
                    }}
                  />
                </Field>
              </div>
            ) : null}
          </Card>

          <Card>
            <CardHeader title="Rights declaration" description="Required for every source, and recorded in the audit log with your account and IP." />
            <div className="space-y-4 px-5 py-5">
              <div className="space-y-2">
                {RIGHTS.map((option) => (
                  <label
                    key={option.value}
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 text-[13px] transition ${
                      rights === option.value ? 'border-accent bg-accent-soft/60 text-ink' : 'border-line text-ink-soft hover:border-accent/40'
                    }`}
                  >
                    <input
                      type="radio"
                      name="rights"
                      className="mt-0.5"
                      value={option.value}
                      checked={rights === option.value}
                      onChange={() => setRights(option.value)}
                    />
                    <span>{option.value}</span>
                  </label>
                ))}
              </div>
              <Field label="Note (optional)" hint="Licence id, client name or contract reference — stored with the declaration.">
                <textarea
                  className="input min-h-[64px]"
                  maxLength={800}
                  value={rightsNote}
                  onChange={(event) => setRightsNote(event.target.value)}
                />
              </Field>
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card className="lg:sticky lg:top-[76px]">
            <CardHeader title="Clip settings" description="Applied to this job. Workspace defaults come from Settings." />
            <div className="space-y-5 px-5 py-5">
              <div>
                <p className="label">Clip lengths</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {([15, 30] as const).map((duration) => (
                    <Chip
                      key={duration}
                      active={targetDurations.includes(duration)}
                      onClick={() =>
                        setTargetDurations((current) =>
                          current.includes(duration) ? current.filter((value) => value !== duration) : [...current, duration].sort((a, b) => a - b),
                        )
                      }
                    >
                      <Icon name="scissors" className="h-3.5 w-3.5" />
                      {duration}s clips
                    </Chip>
                  ))}
                </div>
                <p className="mt-1.5 hint">15s variants are produced only where the moment stands on its own.</p>
              </div>

              <dl className="space-y-2 rounded-xl2 bg-surface-muted px-4 py-3 text-[13px]">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-soft">Max clips</dt>
                  <dd className="font-medium text-ink">{String(settings['ai.max_output_clips'] ?? '—')}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-soft">Quality floor</dt>
                  <dd className="font-medium text-ink">{String(settings['ai.min_quality_score'] ?? '—')} / 100</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-soft">Captions</dt>
                  <dd className="font-medium text-ink">{String(settings['subtitles.preset_id'] ?? '—')}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-soft">Framing</dt>
                  <dd className="font-medium text-ink">{String(settings['render.framing_mode'] ?? '—')}</dd>
                </div>
              </dl>

              <div className="rounded-xl2 border border-line px-4 py-3">
                <Toggle
                  checked={autoPublish}
                  onChange={setAutoPublish}
                  disabled={eligiblePlatforms.length === 0}
                  label="Publish automatically when ready"
                  description={
                    eligiblePlatforms.length === 0
                      ? 'Connect a YouTube channel or Instagram account with publishing enabled to unlock this.'
                      : 'Each rendered clip is published with its AI caption as soon as it is validated. You can still review it afterwards.'
                  }
                />
                {autoPublish && eligiblePlatforms.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {eligiblePlatforms.map((platform) => (
                      <Chip
                        key={platform}
                        active={publishPlatforms.includes(platform)}
                        onClick={() =>
                          setPublishPlatforms((current) =>
                            current.includes(platform) ? current.filter((value) => value !== platform) : [...current, platform],
                          )
                        }
                      >
                        <Icon name={platform === 'YOUTUBE' ? 'youtube' : 'instagram'} className="h-3.5 w-3.5" />
                        {platform === 'YOUTUBE' ? 'YouTube Shorts' : 'Instagram Reels'}
                      </Chip>
                    ))}
                  </div>
                ) : null}
                {eligiblePlatforms.length === 0 ? (
                  <Link href="/accounts" className="mt-2 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
                    Connect an account <Icon name="arrow-right" className="h-3.5 w-3.5" />
                  </Link>
                ) : null}
              </div>

              <button type="button" className="btn-gradient w-full" disabled={!canSubmit} onClick={submit}>
                {pending ? <Spinner /> : <Icon name="sparkles" className="h-4 w-4" />}
                {pending
                  ? mode === 'upload'
                    ? uploadPhase === 'validating' ? 'Inspecting…' : 'Uploading…'
                    : 'Starting project…'
                  : mode === 'upload' && pendingUpload?.file === file
                    ? 'Retry validation'
                    : 'Generate clips'}
              </button>
              <p className="text-center text-[11px] leading-relaxed text-ink-faint">
                {autoPublish && publishPlatforms.length > 0
                  ? `Clips will publish to ${publishPlatforms.map((platform) => (platform === 'YOUTUBE' ? 'YouTube Shorts' : 'Instagram Reels')).join(' and ')} once rendering and validation succeed.`
                  : 'Processing uses your saved AI, caption and render settings. Nothing is published without an explicit action.'}
              </p>
            </div>
          </Card>

          <Card className="p-4">
            <p className="text-[13px] font-semibold text-ink">What happens next</p>
            <ol className="mt-2 space-y-2 text-[13px] text-ink-soft">
              {[
                'Source is downloaded and probed (duration, codecs, resolution).',
                'Speech is transcribed with word-level timestamps.',
                'AI scores candidate moments and drops duplicates.',
                'Captioned 9:16 clips are rendered and stored.',
              ].map((step, index) => (
                <li key={step} className="flex gap-2.5">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">{index + 1}</span>
                  {step}
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </div>
  );
}

/** A 428 from the API is actionable: show which setting is missing instead of a bare message. */
function describeFailure(error: Error): string {
  if (error instanceof ApiError && error.missingConfiguration?.length) {
    return `${error.message} Missing: ${error.missingConfiguration.join(', ')}`;
  }
  return error.message;
}
