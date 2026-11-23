/** Error backoff shared by polling queries. React Query already suspends intervals
 * in background tabs and shares a query cache within a tab. */
interface PollQuery {
  state: { error: unknown; errorUpdateCount: number; dataUpdateCount: number };
}

interface FailureHistory {
  lastErrorCount: number;
  lastDataCount: number;
  consecutive: number;
}

const failures = new WeakMap<object, FailureHistory>();

/** Double after each failed poll, up to two minutes; reset only on a success. */
export function pollingInterval(baseMs: number, query: PollQuery): number {
  const state = query.state;
  let history = failures.get(query);
  if (history && history.lastDataCount !== state.dataUpdateCount) {
    failures.delete(query);
    history = undefined;
  }
  if (!history && state.error) {
    history = { lastErrorCount: state.errorUpdateCount, lastDataCount: state.dataUpdateCount, consecutive: 1 };
    failures.set(query, history);
  } else if (history && state.errorUpdateCount > history.lastErrorCount) {
    history.consecutive += state.errorUpdateCount - history.lastErrorCount;
    history.lastErrorCount = state.errorUpdateCount;
  }
  // An initial retry clears state.error while fetching; retain history until an
  // actual success rather than resetting backoff on every new request.
  return history ? Math.min(Math.max(baseMs, 120_000), baseMs * 2 ** Math.min(history.consecutive, 16)) : baseMs;
}
