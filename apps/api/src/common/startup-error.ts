const MESSAGES = {
  postgres: 'PostgreSQL startup check failed or timed out. Check DATABASE_URL, credentials/TLS, network and applied Prisma migrations. Apply reviewed migrations with npm run db:deploy after backup; never reset production.',
  redis: 'Redis startup check failed or timed out. Check REDIS_URL, credentials, rediss:// for TLS-only services, firewall and service availability.',
  storage: 'Storage startup check failed or timed out. For local storage check STORAGE_LOCAL_ROOT, write permissions and persistent disk mount; for S3 check bucket/region/endpoint, credentials, network and PutObject/GetObject/DeleteObject permissions.',
} as const;

/** Carries operator guidance only: no raw driver exception/cause or credentials. */
export class StartupDependencyError extends Error {
  constructor(readonly dependency: keyof typeof MESSAGES) { super(MESSAGES[dependency]); this.name = 'StartupDependencyError'; }
}
export function startupFailureMessage(error: unknown): string {
  return error instanceof StartupDependencyError ? error.message : 'API failed to start. Check validated environment and PostgreSQL, Redis and storage startup checks. Raw driver errors are suppressed to protect credentials.';
}
