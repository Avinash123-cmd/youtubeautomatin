import { describe, expect, it } from 'vitest';
import { pollingInterval } from '../../apps/web/lib/polling';

describe('polling backoff', () => {
  it('backs off consecutive failures, even when a fetch temporarily clears the error, and resets on success', () => {
    const query = { state: { error: null as Error | null, errorUpdateCount: 0, dataUpdateCount: 0 } };
    expect(pollingInterval(5_000, query)).toBe(5_000);
    query.state.error = new Error('down'); query.state.errorUpdateCount = 1;
    expect(pollingInterval(5_000, query)).toBe(10_000);
    expect(pollingInterval(5_000, query)).toBe(10_000); // repeated option evaluation is not another failure
    query.state.error = null; // React Query clears the error while an initial-data refetch is in flight
    expect(pollingInterval(5_000, query)).toBe(10_000);
    query.state.error = new Error('still down'); query.state.errorUpdateCount = 2;
    expect(pollingInterval(5_000, query)).toBe(20_000);
    query.state.errorUpdateCount = 30;
    expect(pollingInterval(5_000, query)).toBe(120_000);
    query.state.error = null; query.state.dataUpdateCount = 1;
    expect(pollingInterval(5_000, query)).toBe(5_000);
    query.state.error = new Error('later outage'); query.state.errorUpdateCount = 31;
    expect(pollingInterval(5_000, query)).toBe(10_000);
  });

  it('tracks different queries independently', () => {
    const failing = { state: { error: new Error('down'), errorUpdateCount: 1, dataUpdateCount: 1 } };
    const healthy = { state: { error: null, errorUpdateCount: 0, dataUpdateCount: 1 } };
    expect(pollingInterval(10_000, failing)).toBe(20_000);
    expect(pollingInterval(10_000, healthy)).toBe(10_000);
  });
});
