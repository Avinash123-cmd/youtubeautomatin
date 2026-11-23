export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly missingConfiguration?: string[],
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
let csrfRequest: Promise<string> | null = null;

/**
 * A deployed dashboard can fail in ways a local one cannot: the API origin in the build-time
 * rewrite is wrong, the API is down, or the proxy in front of it returns its own 502/504 page.
 * Those are infrastructure errors, not "you are logged out", and the UI must say so — otherwise
 * the user stares at a spinner or a login form that can never succeed.
 */
function unreachable(detail: string, status = 0): ApiError {
  return new ApiError(`The dashboard cannot reach the API. ${detail}`, status, 'BACKEND_UNREACHABLE');
}

export function isBackendUnreachable(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'BACKEND_UNREACHABLE';
}

async function fetchAnonymousCsrf(): Promise<string> {
  let response: Response;
  try {
    response = await fetch('/api/auth/csrf', { credentials: 'include', cache: 'no-store' });
  } catch (cause) {
    throw unreachable((cause as Error)?.message ?? 'The network request failed.');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string; requestId?: string } } | null;
    throw new ApiError(payload?.error?.message ?? 'Unable to obtain a CSRF token', response.status, payload?.error?.code ?? 'CSRF_FAILED', undefined, undefined, payload?.error?.requestId ?? response.headers.get('x-request-id') ?? undefined);
  }
  const body = (await response.json()) as { csrfToken: string };
  if (!body || typeof body !== 'object' || typeof body.csrfToken !== 'string' || !body.csrfToken) throw new ApiError('Invalid CSRF response from API', 502, 'CSRF_FAILED');
  return body.csrfToken;
}

async function ensureCsrf(): Promise<string> {
  if (csrfToken) return csrfToken;
  // One anonymous cookie/token pair for concurrent first mutations, not a race of GETs.
  if (!csrfRequest) csrfRequest = fetchAnonymousCsrf().then((token) => { csrfToken ??= token; return csrfToken; }).finally(() => { csrfRequest = null; });
  return csrfRequest;
}

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method)) headers['x-csrf-token'] = await ensureCsrf();

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'include',
      cache: 'no-store',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (cause) {
    if ((cause as Error)?.name === 'AbortError') throw cause;
    throw unreachable((cause as Error)?.message ?? 'The network request failed.');
  }

  const text = await response.text();
  const payload = text ? safeJson(text) : {};
  if (!response.ok) {
    const error = payload !== null && typeof payload === 'object' ? (payload as { error?: { code?: string; message?: string; missingConfiguration?: string[]; details?: unknown; requestId?: string } }).error : undefined;
    // A 5xx with no `error` envelope did not come from the API — a rewrite/proxy produced it
    // (Next answers 500 on ECONNREFUSED, Vercel answers 502/504). Say "unreachable", not "failed".
    if (!error && response.status >= 500) {
      throw unreachable(`The API origin did not answer; the proxy returned HTTP ${response.status}.`, response.status);
    }
    if (response.status === 401 || (response.status === 403 && error?.code === 'CSRF_FAILED')) setCsrfToken(null);
    throw new ApiError(
      error?.message ?? `Request failed with HTTP ${response.status}`,
      response.status,
      error?.code ?? 'REQUEST_FAILED',
      error?.missingConfiguration,
      error?.details,
      error?.requestId ?? response.headers.get('x-request-id') ?? undefined,
    );
  }
  return payload as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export interface UploadProgress {
  phase: 'initiating' | 'uploading' | 'validating' | 'done';
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
}

export interface UploadCompletion {
  sourceVideoId: string;
  uploadId?: string | null;
  parts?: Array<{ partNumber: number; etag: string }>;
}

export interface UploadedSource {
  id: string;
  status: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
}

/** The bytes are uploaded, but the video processor is temporarily unavailable. */
export class UploadValidationPendingError extends ApiError {
  constructor(cause: ApiError, readonly completion: UploadCompletion) {
    super(cause.message, cause.status, cause.code, cause.missingConfiguration, cause.details, cause.requestId);
    this.name = 'UploadValidationPendingError';
  }
}

/** Chunked upload through the API with the rights declaration sent at completion. */
export interface BrandAssetResult {
  kind: 'LOGO' | 'INTRO' | 'OUTRO';
  storageKey: string;
  sizeBytes: number;
  mimeType: string;
}

/** Uploads a logo / intro / outro file and returns the storage key to save on the brand profile. */
export async function uploadBrandAsset(file: File, kind: BrandAssetResult['kind']): Promise<BrandAssetResult> {
  const form = new FormData();
  form.append('file', file, file.name);
  const csrf = await ensureCsrf();
  const response = await fetch(`/api/brand-assets?kind=${kind}`, {
    method: 'POST',
    body: form,
    credentials: 'include',
    headers: { 'x-csrf-token': csrf },
  });
  const text = await response.text();
  const payload = safeJson(text) as { error?: { message?: string; code?: string } } & BrandAssetResult;
  if (!response.ok) {
    throw new ApiError(payload.error?.message ?? `Upload failed with HTTP ${response.status}`, response.status, payload.error?.code ?? 'UPLOAD_FAILED');
  }
  return payload;
}

export async function completeSourceUpload(completion: UploadCompletion, rightsStatement: string): Promise<UploadedSource> {
  try {
    return await api<UploadedSource>('/api/sources/upload/complete', {
      method: 'POST',
      body: { ...completion, rightsDeclaration: { accepted: true, statement: rightsStatement } },
    });
  } catch (error) {
    // Only this explicit response guarantees validation did not finish. A network
    // timeout or proxy error may have occurred after the server completed it.
    if (error instanceof ApiError && error.status === 503 && error.code === 'VIDEO_PROCESSOR_UNAVAILABLE') {
      throw new UploadValidationPendingError(error, completion);
    }
    throw error;
  }
}

export async function uploadSource(
  file: File,
  options: { youTubeReferenceUrl?: string; rightsStatement: string; onProgress?: (progress: UploadProgress) => void },
): Promise<UploadedSource> {
  options.onProgress?.({ phase: 'initiating', uploadedBytes: 0, totalBytes: file.size, percent: 0 });
  const initiation = await api<{
    sourceVideoId: string;
    partSizeBytes: number;
    driver: 'local' | 's3';
    parts: Array<{ partNumber: number; url: string }>;
    uploadId: string | null;
    maxFileSizeBytes: number;
  }>('/api/sources/upload/initiate', {
    method: 'POST',
    body: {
      fileName: file.name,
      mimeType: file.type || 'video/mp4',
      sizeBytes: file.size,
      ...(options.youTubeReferenceUrl ? { youTubeReferenceUrl: options.youTubeReferenceUrl } : {}),
    },
  });

  if (file.size > initiation.maxFileSizeBytes) {
    throw new ApiError('The selected file exceeds the workspace upload limit.', 413, 'VALIDATION_FAILED');
  }

  const partSize = initiation.partSizeBytes;
  let uploaded = 0;
  const completedParts: Array<{ partNumber: number; etag: string }> = [];
  for (let index = 0; index * partSize < file.size; index += 1) {
    const chunk = file.slice(index * partSize, Math.min((index + 1) * partSize, file.size));
    const partNumber = index + 1;
    const part = initiation.parts.find((candidate) => candidate.partNumber === partNumber);
    if (!part) throw new ApiError(`The server did not prepare upload part ${partNumber}.`, 500, 'UPLOAD_FAILED');

    let response: Response;
    if (initiation.driver === 's3') {
      try {
        response = await fetch(part.url, { method: 'PUT', body: chunk, credentials: 'omit' });
      } catch {
        throw new ApiError(`Part ${partNumber} could not reach object storage. Check the bucket CORS rules and network access.`, 0, 'UPLOAD_FAILED');
      }
    } else {
      const form = new FormData();
      form.append('chunk', chunk, 'part.bin');
      const csrf = await ensureCsrf();
      response = await fetch(part.url, {
        method: 'POST',
        body: form,
        credentials: 'include',
        headers: { 'x-csrf-token': csrf },
      });
    }
    if (!response.ok) {
      const body = await response.text();
      throw new ApiError(`Chunk ${index + 1} failed: ${body.slice(0, 300)}`, response.status, 'UPLOAD_FAILED');
    }
    if (initiation.driver === 's3') {
      const etag = response.headers.get('etag');
      if (!etag) {
        throw new ApiError('Object storage did not return the ETag required to finish the upload. Expose the ETag response header in bucket CORS.', 502, 'UPLOAD_FAILED');
      }
      completedParts.push({ partNumber, etag });
    }
    uploaded += chunk.size;
    options.onProgress?.({ phase: 'uploading', uploadedBytes: uploaded, totalBytes: file.size, percent: Math.round((uploaded / file.size) * 100) });
  }

  options.onProgress?.({ phase: 'validating', uploadedBytes: file.size, totalBytes: file.size, percent: 100 });
  const completion: UploadCompletion = {
    sourceVideoId: initiation.sourceVideoId,
    ...(initiation.driver === 's3' ? { uploadId: initiation.uploadId, parts: completedParts } : {}),
  };
  const result = await completeSourceUpload(completion, options.rightsStatement);
  options.onProgress?.({ phase: 'done', uploadedBytes: file.size, totalBytes: file.size, percent: 100 });
  return result;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '\u2014';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '\u2014';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '\u2014';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
