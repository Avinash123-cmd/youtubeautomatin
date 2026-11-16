/**
 * Loads .env for local/container runs. In production the platform injects real
 * environment variables; .env is only used where an operator placed it.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Both src/ (tsx) and dist/ (node) live three levels below the repository root.
// Do not let an unrelated working directory silently select a different .env.
const candidates = [resolve(__dirname, '../../../.env')];
for (const candidate of candidates) {
  if (existsSync(candidate)) {
    // Node >= 20.12 provides this natively; it never overrides existing vars.
    (process as unknown as { loadEnvFile: (path: string) => void }).loadEnvFile(candidate);
    break;
  }
}
