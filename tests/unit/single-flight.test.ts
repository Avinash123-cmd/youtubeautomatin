import { describe, expect, it, vi } from 'vitest';
import { SingleFlight } from '../../apps/api/src/common/services/single-flight';

describe('scheduler per-task single flight', () => {
  it('skips overlap for one task without blocking another task', async () => {
    const flight = new SingleFlight();
    let release!: () => void;
    const first = flight.run('slow-scan', () => new Promise<void>(resolve => { release = resolve; }));
    const overlapping = vi.fn();
    expect(await flight.run('slow-scan', overlapping)).toBe(false);
    expect(overlapping).not.toHaveBeenCalled();
    expect(await flight.run('relay', async () => undefined)).toBe(true);
    release();
    expect(await first).toBe(true);
    expect(await flight.run('slow-scan', async () => undefined)).toBe(true);
  });

  it('releases a task after an exception so a later run can recover', async () => {
    const flight = new SingleFlight();
    await expect(flight.run('tokens', async () => { throw new Error('unavailable'); })).rejects.toThrow('unavailable');
    expect(await flight.run('tokens', async () => undefined)).toBe(true);
  });
});
