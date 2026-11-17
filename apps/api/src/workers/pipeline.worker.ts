import type { Job } from 'bullmq';
import { deferContendedJob, currentLeaseOwner, withLeaseScope } from './lease-contention';
/**
 * Pipeline worker — owns stages PROBING → TRANSCRIBING → AI_ANALYSIS →
 * CLIP_SELECTION → RENDERING hand-off.
 *
 * Durability: every stage transition is a committed database row before the work
 * starts, so a crash resumes from the last successful stage and never re-does
 * expensive work silently.
 */
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { extname } from 'node:path';
import { prisma, transitionJob, transitionJobInTransaction, updateJobProgress, JobLeaseLostError, acquireJobLease, writeOutbox, releaseJobLease, appendAuditLog } from '@clipforge/database';
import { PIPELINE_STATES } from '@clipforge/shared-types';
import type { Prisma } from '@prisma/client';
import { env } from '../common/env';
import { AppConfigService } from '../common/services/config.service';
import { estimateCostUsd } from '../common/services/usage-cost';
import { StorageService } from '../storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { createRuntime, createWorker, wireShutdown, startLeaseRenewal } from './base';
import { aiEngine, videoProcessor, ServiceCallError } from './services-client';
import { YoutubeImportService } from '../sources/youtube/youtube-import.service';
import { ingestYouTubeSource } from '../sources/youtube/ingest';
import { YoutubeIngestError } from '../sources/youtube/ytdlp';
import { sourceObjectKey } from '../sources/source-key';
import { PipelineAbortError } from './pipeline-errors';

const runtime = createRuntime('ai', env.WORKER_CONCURRENCY_AI);
const storage = new StorageService();
const appConfig = new AppConfigService();
const youtubeImport = new YoutubeImportService();
const notifications = new NotificationsService();

interface JobConfiguration {
  framingMode: 'face_track' | 'center_crop' | 'manual' | 'background_blur';
  framingFallback: 'center_crop' | 'background_blur' | 'fail';
  subtitlePresetId: string;
  subtitleLanguage: string;
  contentLanguages: string[];
  targetDurations: number[];
  maxClips: number;
  minQualityScore: number;
  autoPublish: boolean;
  platforms: Array<'YOUTUBE' | 'INSTAGRAM'>;
  brandProfileId?: string;
  manualOffsetX?: number;
  resolved?: Record<string, unknown>;
  subtitlePresetStyle?: Record<string, unknown>;
}

async function handler(job: Job<{ jobId: string; resumeFrom?: string }>): Promise<void> {
  return withLeaseScope(runtime.workerId, () => handleLeased(job));
}

async function handleLeased(job: Job<{ jobId: string; resumeFrom?: string }>): Promise<void> {
  const jobId = job.data.jobId;
  const resumeFrom = job.data.resumeFrom;
  const leased = await acquireJobLease(jobId, currentLeaseOwner(runtime.workerId), env.JOB_LEASE_SECONDS);
  if (!leased) {
    const current = await prisma.processingJob.findUnique({ where: { id: jobId }, select: { status: true } });
    return deferContendedJob(job, current?.status ?? null);
  }
  const stopRenewal = startLeaseRenewal(jobId, currentLeaseOwner(runtime.workerId), runtime.logger);
  try {
    await runPipeline(jobId, resumeFrom);
  } finally {
    stopRenewal();
    await releaseJobLease(jobId, currentLeaseOwner(runtime.workerId)).catch(() => undefined);
  }
}

async function runPipeline(jobId: string, resumeFrom?: string): Promise<void> {
  const job = await prisma.processingJob.findUnique({
    where: { id: jobId },
    include: { sourceVideo: true, stages: true },
  });
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (['CANCELLED', 'COMPLETED', 'FAILED', 'PARTIALLY_COMPLETED'].includes(job.status)) {
    runtime.logger.info(`job ${jobId} is ${job.status}; nothing to do`);
    return;
  }

  const configuration = job.configuration as unknown as JobConfiguration;
  const workDir = join(env.WORK_DIR, jobId);
  await mkdir(workDir, { recursive: true });
  const sourcePath = join(workDir, `source-${job.sourceVideoId}.mp4`);

  try {
    // Resolve configuration again at execution time: a job must never run with
    // stale limits if the workspace configuration was changed or removed.
    const liveConfig = await appConfig.resolveForProcessing(job.workspaceId);

    const completedStages = new Set(job.stages.filter((stage) => stage.status === 'SUCCEEDED').map((stage) => stage.stage));

    // ------------------------------- PROBING ---------------------------------
    if (!completedStages.has('PROBING')) {
      await transitionJob(jobId, 'PROBING', {
        workerId: currentLeaseOwner(runtime.workerId), expectedLeaseOwner: currentLeaseOwner(runtime.workerId),
        progressPercent: 5,
        progressDetail: 'Inspecting source media with ffprobe',
        leaseSeconds: env.JOB_LEASE_SECONDS,
      });
      // Two ways a source arrives here: already in storage (upload / direct URL), or as a pasted
      // YouTube URL whose media has never been fetched. The second one is ingested now, inside the
      // lease, so a crash resumes from storageKey instead of downloading twice.
      if (!job.sourceVideo.storageKey) {
        if (job.sourceVideo.kind !== 'YOUTUBE') {
          throw new PipelineAbortError('SOURCE_NOT_STORED', 'Source has no stored object', { retryable: false });
        }
        await ingestYouTube(jobId, job.workspaceId, job.sourceVideo, workDir);
        const stored = await prisma.sourceVideo.findUnique({ where: { id: job.sourceVideoId }, select: { storageKey: true } });
        if (!stored?.storageKey) throw new PipelineAbortError('INGEST_NOT_STORED', 'YouTube ingest did not store the media', { retryable: true });
        await storage.downloadToFile(stored.storageKey, sourcePath);
      } else {
        await storage.downloadToFile(job.sourceVideo.storageKey, sourcePath);
      }
      void notifications.notify({
        workspaceId: job.workspaceId,
        category: 'SOURCE_DOWNLOADED',
        dedupeKey: `job:${jobId}:source-downloaded`,
        summary: 'Source video is on the worker',
        details: [['Source', job.sourceVideo.originalFileName ?? job.sourceVideoId], ['Kind', job.sourceVideo.kind]],
        jobId,
      });
      const probe = await videoProcessor.probe(sourcePath);
      await prisma.sourceVideo.update({
        where: { id: job.sourceVideoId },
        data: {
          durationSeconds: probe.duration_seconds,
          width: probe.width,
          height: probe.height,
          frameRate: probe.frame_rate,
          probeResult: probe as unknown as Prisma.InputJsonValue,
        },
      });
      await transitionJob(jobId, 'TRANSCRIBING', {
        workerId: currentLeaseOwner(runtime.workerId), expectedLeaseOwner: currentLeaseOwner(runtime.workerId),
        progressPercent: 12,
        progressDetail: `Probed ${probe.width}x${probe.height}, ${probe.duration_seconds.toFixed(1)}s`,
        leaseSeconds: env.JOB_LEASE_SECONDS,
      });
      void notifications.notify({
        workspaceId: job.workspaceId,
        category: 'SOURCE_DETECTED',
        dedupeKey: `job:${jobId}:source-detected`,
        summary: 'Video source detected and validated',
        details: [
          ['Resolution', `${probe.width}×${probe.height}`],
          ['Duration', `${(probe.duration_seconds / 60).toFixed(1)} min`],
          ['Frame rate', `${probe.frame_rate} fps`],
        ],
        jobId,
      });
    }

    // ----------------------------- TRANSCRIBING ------------------------------
    let transcript = await prisma.transcript.findFirst({
      where: { jobId },
      include: { segments: { orderBy: { sequence: 'asc' } } },
    });
    if (!transcript) {
      await ensureStatus(jobId, 'TRANSCRIBING');
      void notifications.notify({
        workspaceId: job.workspaceId,
        category: 'AI_STARTED',
        dedupeKey: `job:${jobId}:ai-started`,
        summary: 'AI processing started (transcription)',
        details: [['Model', liveConfig.aiTextModel], ['Language', configuration.subtitleLanguage]],
        jobId,
      });
      const result = await aiEngine.transcribe({
        job_id: jobId,
        video_path: sourcePath,
        language: configuration.subtitleLanguage,
      });
      const transcription = result.transcription;
      transcript = await prisma.transcript.create({
        data: {
          workspaceId: job.workspaceId,
          sourceVideoId: job.sourceVideoId,
          jobId,
          language: transcription.language,
          languageProbability: transcription.language_probability,
          provider: transcription.provider,
          model: transcription.model,
          wordTimestamps: transcription.word_timestamps,
          durationSeconds: transcription.duration_seconds,
          fullText: transcription.full_text,
          metadata: { words: transcription.segments.reduce((acc, s) => acc + s.words.length, 0) } as Prisma.InputJsonValue,
          segments: {
            create: transcription.segments.map((segment) => ({
              sequence: segment.sequence,
              startSeconds: segment.start,
              endSeconds: segment.end,
              text: segment.text,
              speakerLabel: null,
              avgLogprob: segment.avg_logprob,
              noSpeechProb: segment.no_speech_prob,
              words: segment.words as unknown as Prisma.InputJsonValue,
            })),
          },
        },
        include: { segments: { orderBy: { sequence: 'asc' } } },
      });
      const transcriptionMetadata = { model: transcription.model, provider: transcription.provider };
      await prisma.usageRecord.create({
        data: {
          workspaceId: job.workspaceId,
          jobId,
          kind: 'transcription_seconds',
          quantity: transcription.duration_seconds,
          unit: 'seconds',
          metadata: transcriptionMetadata,
          costUsd: estimateCostUsd('transcription_seconds', transcription.duration_seconds, transcriptionMetadata),
        },
      });
      await transitionJob(jobId, 'AI_ANALYSIS', {
        workerId: currentLeaseOwner(runtime.workerId), expectedLeaseOwner: currentLeaseOwner(runtime.workerId),
        progressPercent: 30,
        progressDetail: `${transcription.segments.length} transcript segments (${transcription.language})`,
        leaseSeconds: env.JOB_LEASE_SECONDS,
      });
    } else {
      await ensureStatus(jobId, 'AI_ANALYSIS');
    }

    // A retry that already planned clips belongs at the rendering stage. Re-running analysis pays
    // for the same model calls again; re-running selection deletes the clip rows that in-flight
    // render jobs still reference, which surfaced as "Clip … not found" on the next attempt.
    const plannedClips = await prisma.generatedClip.findMany({
      where: { jobId },
      select: { id: true, status: true },
    });
    // Stage rows are reset to PENDING whenever a stage is re-entered, so "did selection run?" is
    // answered by the resume point plus the clips it left behind — not by the stage table.
    const resumeRank = Math.max(stageRank(job.status), resumeFrom ? stageRank(resumeFrom) : -1);
    if (resumeRank >= stageRank('RENDERING') && plannedClips.length > 0) {
      const pending = plannedClips.filter((clip) => clip.status !== 'READY');
      await ensureStatus(jobId, 'RENDERING');
      await prisma.$transaction(async (tx) => {
        for (const clip of pending.length > 0 ? pending : plannedClips.slice(0, 1)) {
          if (clip.status !== 'READY') {
            await tx.generatedClip.update({ where: { id: clip.id }, data: { status: 'PLANNED' } });
          }
          await writeOutbox(tx, {
            aggregateType: 'GeneratedClip',
            aggregateId: clip.id,
            eventType: 'clip.render',
            queue: 'clipforge.render',
            payload: { clipId: clip.id, jobId },
          });
        }
      });
      runtime.logger.info(
        `job ${jobId} resumed at RENDERING: re-queued ${pending.length || 1} of ${plannedClips.length} clip(s)`,
      );
      return;
    }

    // ------------------------------ AI_ANALYSIS ------------------------------
    const transcriptPayload = {
      language: transcript.language,
      language_probability: transcript.languageProbability,
      duration_seconds: transcript.durationSeconds ?? job.sourceVideo.durationSeconds ?? 0,
      provider: transcript.provider,
      model: transcript.model,
      word_timestamps: transcript.wordTimestamps,
      full_text: transcript.fullText,
      segments: transcript.segments.map((segment) => ({
        sequence: segment.sequence,
        start: segment.startSeconds,
        end: segment.endSeconds,
        text: segment.text,
        words: segment.words as unknown as Array<{ word: string; start: number; end: number; probability: number }>,
        avg_logprob: segment.avgLogprob,
        no_speech_prob: segment.noSpeechProb,
      })),
    };

    const analysis = await aiEngine.analyze({
      job_id: jobId,
      video_path: sourcePath,
      text_model: liveConfig.aiTextModel,
      vision_model: liveConfig.aiVisionModel,
      target_durations: configuration.targetDurations,
      max_candidates: liveConfig.maxCandidatesPerCall,
      max_clips: Math.min(configuration.maxClips, liveConfig.maxOutputClips),
      min_quality_score: configuration.minQualityScore,
      duplicate_threshold: liveConfig.duplicateThreshold,
      language: configuration.subtitleLanguage,
      enable_vision: true,
      transcript: transcriptPayload,
    });

    // Text and vision calls are priced separately: vision batches dominate prompt tokens, and
    // lumping them together hides which stage is expensive.
    const usage = analysis.report.usage as
      | {
          total_tokens?: number;
          text?: { prompt_tokens?: number; candidate_tokens?: number; total_tokens?: number };
          vision?: { prompt_tokens?: number; candidate_tokens?: number; total_tokens?: number; calls?: number };
        }
      | undefined;
    const textTokens = usage?.text?.total_tokens ?? 0;
    if (textTokens > 0) {
      const metadata = {
        model: liveConfig.aiTextModel,
        promptTokens: usage?.text?.prompt_tokens ?? 0,
        candidateTokens: usage?.text?.candidate_tokens ?? 0,
      };
      await prisma.usageRecord.create({
        data: {
          workspaceId: job.workspaceId,
          jobId,
          kind: 'gemini_tokens',
          quantity: textTokens,
          unit: 'tokens',
          metadata,
          costUsd: estimateCostUsd('gemini_tokens', textTokens, metadata),
        },
      });
    }
    const visionTokens = usage?.vision?.total_tokens ?? 0;
    if (visionTokens > 0) {
      const metadata = {
        model: liveConfig.aiVisionModel,
        promptTokens: usage?.vision?.prompt_tokens ?? 0,
        candidateTokens: usage?.vision?.candidate_tokens ?? 0,
        calls: usage?.vision?.calls ?? 0,
      };
      await prisma.usageRecord.create({
        data: {
          workspaceId: job.workspaceId,
          jobId,
          kind: 'gemini_vision_tokens',
          quantity: visionTokens,
          unit: 'tokens',
          metadata,
          costUsd: estimateCostUsd('gemini_vision_tokens', visionTokens, metadata),
        },
      });
    }

    void notifications.notify({
      workspaceId: job.workspaceId,
      category: 'AI_COMPLETED',
      dedupeKey: `job:${jobId}:ai-completed`,
      summary: 'AI processing completed: transcript and highlight analysis are stored',
      details: [
        ['Highlights found', analysis.plan.length],
        ['Vision calls', usage?.vision?.calls ?? 0],
        ['Text tokens', textTokens],
      ],
      jobId,
    });

    // ----------------------------- CLIP_SELECTION -----------------------------
    await ensureStatus(jobId, 'CLIP_SELECTION');
    await prisma.highlightCandidate.deleteMany({ where: { jobId } });
    await prisma.generatedClip.deleteMany({ where: { jobId } });

    if (analysis.plan.length === 0) {
      const explanation =
        (analysis.report.explanation as string | undefined) ??
        'No candidate met the configured quality threshold after validation and duplicate suppression.';
      await transitionJob(jobId, 'COMPLETED', {
        progressPercent: 100,
        progressDetail: `No clips produced: ${explanation}`.slice(0, 500),
        resultSummary: {
          outcome: 'NO_QUALITY_CANDIDATES',
          explanation,
          report: analysis.report,
          variantDecisions: analysis.variant_decisions,
        } as Prisma.InputJsonValue,
        workerId: currentLeaseOwner(runtime.workerId), expectedLeaseOwner: currentLeaseOwner(runtime.workerId),
      });
      await appendAuditLog({
        workspaceId: job.workspaceId,
        userId: job.createdById,
        action: 'JOB_STAGE_CHANGED',
        targetType: 'ProcessingJob',
        targetId: jobId,
        summary: `Job finished with no clips: ${explanation}`.slice(0, 400),
      });
      return;
    }

    const brandProfile = configuration.brandProfileId
      ? await prisma.brandProfile.findFirst({ where: { id: configuration.brandProfileId, workspaceId: job.workspaceId } })
      : await prisma.brandProfile.findFirst({ where: { workspaceId: job.workspaceId, isDefault: true } });

    const captionResponse = await aiEngine.captions({
      model: liveConfig.aiTextModel,
      brand_voice: brandProfile?.brandVoice ?? null,
      audience: brandProfile?.audienceDescription ?? null,
      language: configuration.subtitleLanguage,
      source_context: transcript.fullText.slice(0, 4000),
      clips: analysis.plan.map((entry, index) => ({
        clip_id: `${jobId}-${index}`,
        transcript: entry.candidate.transcript,
        hook: String(entry.candidate.hook ?? ''),
        content_category: String(entry.candidate.content_category ?? 'educational'),
      })),
    });

    const clipIds: string[] = [];
    let metadataFailures = 0;
    for (const [index, entry] of analysis.plan.entries()) {
      const candidate = entry.candidate as unknown as {
        start_time: number;
        end_time: number;
        target_duration: number;
        hook: string;
        reason: string;
        transcript: string;
        content_category: string;
        quality_score: number;
        confidence: number;
        visual_context: string;
        scores: Record<string, number>;
      };

      const highlight = await prisma.highlightCandidate.create({
        data: {
          workspaceId: job.workspaceId,
          jobId,
          transcriptId: transcript.id,
          startSeconds: candidate.start_time,
          endSeconds: candidate.end_time,
          targetDuration: candidate.target_duration,
          hook: candidate.hook,
          reason: candidate.reason,
          transcriptText: candidate.transcript,
          contentCategory: candidate.content_category,
          qualityScore: candidate.quality_score,
          confidence: candidate.confidence,
          visualContext: entry.visual_context ?? candidate.visual_context,
          scores: candidate.scores as unknown as Prisma.InputJsonValue,
          status: 'ACCEPTED',
          modelMetadata: { derived: entry.derived, derivationNote: entry.derivation_note ?? null },
        },
      });

      const clip = await prisma.generatedClip.create({
        data: {
          workspaceId: job.workspaceId,
          jobId,
          candidateId: highlight.id,
          title: `${candidate.hook || candidate.transcript.slice(0, 60)}`.slice(0, 120),
          contentCategory: candidate.content_category,
          qualityScore: candidate.quality_score,
          status: 'PLANNED',
          startSeconds: entry.start_time,
          endSeconds: entry.end_time,
          durationKind: entry.duration_kind,
        },
      });
      clipIds.push(clip.id);

      const metadata = captionResponse.results.find((result) => result.clipId === `${jobId}-${index}`);
      if (metadata?.ok && metadata.metadata) {
        const yt = metadata.metadata.youtube ?? {};
        const ig = metadata.metadata.instagram ?? {};
        await prisma.clipMetadata.createMany({
          data: [
            {
              clipId: clip.id,
              platform: 'YOUTUBE',
              originalAiOutput: yt as Prisma.InputJsonValue,
              title: String(yt.title ?? clip.title).slice(0, 100),
              description: String(yt.description ?? '').slice(0, 5000),
              hashtags: (yt.hashtags ?? []) as string[],
              tags: (yt.tags ?? []) as string[],
              language: configuration.subtitleLanguage,
              brandVoice: brandProfile?.brandVoice ?? null,
              model: String(metadata.metadata.model ?? liveConfig.aiTextModel),
              reviewStatus: 'DRAFT',
            },
            {
              clipId: clip.id,
              platform: 'INSTAGRAM',
              originalAiOutput: ig as Prisma.InputJsonValue,
              title: null,
              description: String(ig.caption ?? '').slice(0, 5000),
              hashtags: (ig.hashtags ?? []) as string[],
              tags: [],
              language: configuration.subtitleLanguage,
              brandVoice: brandProfile?.brandVoice ?? null,
              model: String(metadata.metadata.model ?? liveConfig.aiTextModel),
              reviewStatus: 'DRAFT',
            },
          ],
        });
      } else {
        runtime.logger.warn(`caption generation failed for clip ${clip.id}: ${metadata?.error ?? 'unknown'}`);
        metadataFailures += 1;
      }
    }

    // Only claim captions are ready if they actually are: a partially failed caption call is
    // reported as such rather than as success.
    if (clipIds.length > 0) {
      void notifications.notify({
        workspaceId: job.workspaceId,
        category: 'METADATA_COMPLETED',
        dedupeKey: `job:${jobId}:metadata-completed`,
        summary:
          metadataFailures === 0
            ? `Captions and hashtags generated for ${clipIds.length} clip(s)`
            : `Captions generated for ${clipIds.length - metadataFailures} of ${clipIds.length} clip(s)`,
        details: [
          ['Clips', clipIds.length],
          ['Failed', metadataFailures],
          ['Platforms', configuration.platforms.join(', ') || 'none selected'],
        ],
        jobId,
      });
    }

    // ------------------------------- RENDERING --------------------------------
    await prisma.$transaction(async (tx) => {
      await transitionJobInTransaction(tx, jobId, 'RENDERING', {
      workerId: currentLeaseOwner(runtime.workerId), expectedLeaseOwner: currentLeaseOwner(runtime.workerId),
      progressPercent: 45,
      progressDetail: `${clipIds.length} clip(s) queued for vertical rendering`,
      resultSummary: {
        report: analysis.report,
        variantDecisions: analysis.variant_decisions,
        rejectedCandidates: analysis.rejected_candidates.length,
        duplicatesDropped: analysis.duplicates_dropped.length,
      } as Prisma.InputJsonValue,
      leaseSeconds: env.JOB_LEASE_SECONDS,
    });
      for (const clipId of clipIds) {
        await writeOutbox(tx, {
          aggregateType: 'GeneratedClip',
          aggregateId: clipId,
          eventType: 'clip.render',
          queue: 'clipforge.render',
          payload: { clipId, jobId },
        });
      }
    });
  } catch (error) {
    if (error instanceof JobLeaseLostError) throw error;
    const serviceError = error instanceof ServiceCallError ? error : null;
    const abort = error instanceof PipelineAbortError ? error : null;
    const retryable = abort ? abort.options.retryable : serviceError ? serviceError.retryable : true;
    const message = error instanceof Error ? error.message : String(error);
    const attempt = job.attempt;
    const exhausted = !retryable || attempt >= job.maxAttempts;

    // A missing binary or a disabled feature is not a failure of this job: park it where an
    // operator will see exactly what to configure, and keep the retry budget intact.
    if (abort?.options.needsConfiguration) {
      void notifications.notify({
        workspaceId: job.workspaceId,
        category: 'WORKFLOW_FAILED',
        dedupeKey: `job:${jobId}:needs-configuration`,
        summary: 'Workflow paused: configuration required',
        details: [
          ['Code', abort.code],
          ['What to fix', message.slice(0, 400)],
        ],
        jobId,
      });
      await transitionJob(jobId, 'NEEDS_CONFIGURATION', {
        errorCode: abort.code,
        errorMessage: message.slice(0, 1800),
        errorDetails: { stage: job.stage, ...(abort.options.details ?? {}) } as Prisma.InputJsonValue,
        progressDetail: `Configuration required: ${message}`.slice(0, 400),
        workerId: currentLeaseOwner(runtime.workerId),
        expectedLeaseOwner: currentLeaseOwner(runtime.workerId),
      });
      return;
    }

    // Two different facts, two different messages: a quota refusal is actionable by the operator
    // (top up, raise limits) while a permanent failure needs someone to look at the job.
    if (/QUOTA|RATE_LIMIT|429|RESOURCE_EXHAUSTED/i.test(`${serviceError?.code ?? ''} ${message}`)) {
      void notifications.notify({
        workspaceId: job.workspaceId,
        category: 'QUOTA_ERROR',
        dedupeKey: `job:${jobId}:quota:${job.stage}:${attempt}`,
        summary: `API quota or rate limit reached during ${job.stage}`,
        details: [
          ['Service', serviceError?.service ?? 'pipeline'],
          ['Code', serviceError?.code ?? 'unknown'],
          ['Message', message.slice(0, 300)],
        ],
        jobId,
      });
    }
    if (exhausted) {
      void notifications.notify({
        workspaceId: job.workspaceId,
        category: 'WORKFLOW_FAILED',
        dedupeKey: `job:${jobId}:failed`,
        summary: `Workflow failed at ${job.stage}`,
        details: [
          ['Code', serviceError?.code ?? 'PIPELINE_ERROR'],
          ['Reason', message.slice(0, 400)],
          ['Attempts', `${attempt} of ${job.maxAttempts}`],
          ['Retryable', retryable ? 'yes' : 'no — needs a human'],
        ],
        jobId,
      });
    }
    await transitionJob(jobId, exhausted ? 'FAILED' : 'RETRYING', {
      errorCode: abort?.code ?? serviceError?.code ?? 'PIPELINE_ERROR',
      errorMessage: message.slice(0, 1800),
      errorDetails: { stage: job.stage, retryable, attempt } as Prisma.InputJsonValue,
      progressDetail: exhausted ? `Failed: ${message}`.slice(0, 400) : `Retrying: ${message}`.slice(0, 400),
      ...(!exhausted ? { enqueue: {
        queue: 'clipforge.pipeline', eventType: 'job.retry', payload: { jobId },
        availableAt: new Date(Date.now() + 15_000 * Math.max(1, attempt)),
      } } : {}),
      workerId: currentLeaseOwner(runtime.workerId), expectedLeaseOwner: currentLeaseOwner(runtime.workerId),
    });
    throw error;
  }
}

/** Position of a state on the linear pipeline; control states (RETRYING…) return -1. */
function stageRank(state: string): number {
  return PIPELINE_STATES.indexOf(state as never);
}

async function ensureStatus(jobId: string, expected: string): Promise<void> {
  const job = await prisma.processingJob.findUnique({ where: { id: jobId }, select: { status: true } });
  if (!job) throw new Error(`Job ${jobId} disappeared`);
  if (['CANCELLED', 'FAILED', 'COMPLETED', 'PARTIALLY_COMPLETED'].includes(job.status)) {
    throw new Error(`Job ${jobId} is ${job.status}; aborting stage`);
  }
  if (job.status === expected) return;
  // Retries only ever move forward. Dragging a job back to an earlier stage is not a legal
  // transition (RENDERING -> AI_ANALYSIS threw IllegalTransitionError and masked the real
  // failure), and re-running completed work would pay for the same analysis twice.
  const current = stageRank(job.status);
  const wanted = stageRank(expected);
  if (current >= 0 && wanted >= 0 && current > wanted) {
    runtime.logger.info(`job ${jobId} is already at ${job.status}; not rewinding to ${expected}`);
    return;
  }
  await transitionJob(jobId, expected as never, { workerId: currentLeaseOwner(runtime.workerId), expectedLeaseOwner: currentLeaseOwner(runtime.workerId), leaseSeconds: env.JOB_LEASE_SECONDS });
}


/**
 * Downloads a pasted YouTube URL, probes it, enforces the workspace limits and stores it exactly
 * like an upload would be stored. Progress is written to the job so the dashboard can show it.
 */
interface IngestSourceRow {
  id: string;
  workspaceId: string;
  sourceUrl: string | null;
  youTubeReferenceUrl: string | null;
  youTubeReferenceId: string | null;
  sourceMetadata: unknown;
  originalFileName: string | null;
}

async function ingestYouTube(jobId: string, workspaceId: string, source: IngestSourceRow, workDir: string): Promise<void> {
  let lastWrite = 0;
  let lastPercent = -1;

  // Still inside PROBING: a state transition here would be a self-transition and a no-op.
  await updateJobProgress(jobId, {
    expectedLeaseOwner: currentLeaseOwner(runtime.workerId),
    progressPercent: 5,
    progressDetail: 'Downloading source from YouTube',
    leaseSeconds: env.JOB_LEASE_SECONDS,
  });

  let ingested: Awaited<ReturnType<typeof ingestYouTubeSource>>;
  try {
    ingested = await ingestYouTubeSource({
      source,
      destinationBase: join(workDir, `youtube-${source.id}`),
      service: youtubeImport,
      onProgress: (percent, detail) => {
        const now = Date.now();
        // One write every 3s (or every 5 percentage points) instead of per progress line.
        if (now - lastWrite < 3000 && percent - lastPercent < 5) return;
        lastWrite = now;
        lastPercent = percent;
        void updateJobProgress(jobId, {
          expectedLeaseOwner: currentLeaseOwner(runtime.workerId),
          progressPercent: Math.min(9, 4 + Math.round(percent / 20)),
          progressDetail: detail,
          leaseSeconds: env.JOB_LEASE_SECONDS,
        }).catch(() => undefined);
      },
    });
  } catch (error) {
    if (error instanceof YoutubeIngestError) {
      throw new PipelineAbortError(error.code, error.message, {
        retryable: error.retryable,
        needsConfiguration: error.needsConfiguration,
      });
    }
    throw error;
  }

  const liveConfig = await appConfig.resolveForProcessing(workspaceId);
  const probe = await videoProcessor.probe(ingested.path);
  if (!Number.isFinite(probe.duration_seconds) || probe.duration_seconds <= 0) {
    throw new PipelineAbortError('INGEST_UNREADABLE_MEDIA', 'The downloaded file has no readable duration', { retryable: false });
  }
  if (probe.duration_seconds > liveConfig.maxDurationSeconds) {
    await prisma.sourceVideo.update({
      where: { id: source.id },
      data: { status: 'REJECTED', rejectionReason: `Source is ${Math.round(probe.duration_seconds)}s, above the configured maximum of ${liveConfig.maxDurationSeconds}s` },
    });
    throw new PipelineAbortError(
      'SOURCE_TOO_LONG',
      `Source is ${Math.round(probe.duration_seconds)}s but the workspace maximum is ${liveConfig.maxDurationSeconds}s`,
      { retryable: false },
    );
  }
  if (ingested.sizeBytes > liveConfig.maxFileSizeBytes) {
    await prisma.sourceVideo.update({
      where: { id: source.id },
      data: { status: 'REJECTED', rejectionReason: `Source is ${ingested.sizeBytes} bytes, above the configured maximum of ${liveConfig.maxFileSizeBytes} bytes` },
    });
    throw new PipelineAbortError(
      'SOURCE_TOO_LARGE',
      `Source is ${(ingested.sizeBytes / 1024 / 1024).toFixed(1)} MB but the workspace maximum is ${(liveConfig.maxFileSizeBytes / 1024 / 1024).toFixed(1)} MB`,
      { retryable: false },
    );
  }

  // The container is whatever yt-dlp actually produced (usually mp4 after merging, but a
  // single-stream source can stay webm). The stored object must not claim a container it is not.
  const extension = extname(ingested.path).toLowerCase();
  const contentType = extension === '.webm' ? 'video/webm' : extension === '.mkv' ? 'video/x-matroska' : extension === '.mov' ? 'video/quicktime' : 'video/mp4';
  const key = sourceObjectKey(workspaceId, source.id, `source${extension || '.mp4'}`);
  await storage.putFile(key, ingested.path, contentType);
  // The download is no longer needed: PROBING re-materialises the stored object under a stable
  // name for the transcription stage, so keeping both would double the work-disk usage.
  await rm(ingested.path, { force: true });
  const previousMetadata = (source.sourceMetadata as Record<string, unknown> | null) ?? {};
  await prisma.sourceVideo.update({
    where: { id: source.id },
    data: {
      status: 'VALIDATED',
      storageKey: key,
      sizeBytes: BigInt(ingested.sizeBytes),
      detectedMimeType: contentType,
      durationSeconds: probe.duration_seconds,
      width: probe.width,
      height: probe.height,
      frameRate: probe.frame_rate,
      probeResult: probe as unknown as Prisma.InputJsonValue,
      ingestedAt: new Date(),
      sourceMetadata: {
        ...previousMetadata,
        ingestedAt: new Date().toISOString(),
        title: ingested.info?.title ?? previousMetadata.title ?? null,
        author: ingested.info?.uploader ?? previousMetadata.author ?? null,
        durationSeconds: probe.duration_seconds,
        width: probe.width,
        height: probe.height,
        frameRate: probe.frame_rate,
        sizeBytes: ingested.sizeBytes,
        thumbnailUrl: ingested.info?.thumbnailUrl ?? previousMetadata.thumbnailUrl ?? null,
      } as Prisma.InputJsonValue,
    },
  });
  void notifications.notify({
    workspaceId,
    category: 'SOURCE_DETECTED',
    dedupeKey: `job:${jobId}:youtube-ingested`,
    summary: 'YouTube source downloaded and validated',
    details: [
      ['Video', ingested.info?.title ?? source.originalFileName ?? source.id],
      ['Duration', `${(probe.duration_seconds / 60).toFixed(1)} min`],
      ['Resolution', `${probe.width}×${probe.height}`],
      ['Size', `${(ingested.sizeBytes / 1024 / 1024).toFixed(1)} MB`],
    ],
    jobId,
  });
}

async function main() {
  const worker = createWorker('clipforge.pipeline', runtime, handler, env.WORKER_CONCURRENCY_AI);
  wireShutdown(runtime, [worker]);
  runtime.logger.info(`pipeline worker ready (concurrency=${env.WORKER_CONCURRENCY_AI})`);
}

void main();
