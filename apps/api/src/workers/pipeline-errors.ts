/**
 * Errors the pipeline worker can classify without guessing.
 *
 * `needsConfiguration` means the job must stop in NEEDS_CONFIGURATION and wait for an operator
 * (missing binary, disabled feature, source outside limits). `retryable` decides between RETRYING
 * and FAILED for everything else. Anything thrown as a plain Error keeps the historical behaviour:
 * retryable until the attempt budget is exhausted.
 */
export class PipelineAbortError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly options: { retryable: boolean; needsConfiguration?: boolean; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = 'PipelineAbortError';
  }
}
