/** Skip a new invocation while the same per-process maintenance task is still running. */
export class SingleFlight {
  private readonly running = new Set<string>();

  async run(key: string, action: () => Promise<unknown>): Promise<boolean> {
    if (this.running.has(key)) return false;
    this.running.add(key);
    try {
      await action();
      return true;
    } finally {
      this.running.delete(key);
    }
  }
}
