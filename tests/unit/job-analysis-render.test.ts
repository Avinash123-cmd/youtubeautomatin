import { beforeEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const state = vi.hoisted(() => ({ data: null as unknown, error: null as Error | null, options: {} as Record<string, any> }));
vi.mock('@tanstack/react-query', () => ({ useQuery: (options: Record<string, unknown>) => { state.options = options; return { data: state.data, error: state.error, isLoading: false, refetch: vi.fn() }; } }));
import { JobAnalysis } from '../../apps/web/components/job-analysis';
beforeEach(() => { state.data = { transcript: null, segments: [], segmentCount: 0, candidates: [], candidateCount: 0 }; state.error = null; });
const render = (terminal = false) => renderToStaticMarkup(createElement(JobAnalysis, { jobId: 'owned-job', terminal }));
it('renders empty results honestly and polls only a live job', () => {
  expect(render()).toContain('No transcript yet');
  const query = { state: { error: null as Error | null, errorUpdateCount: 0, dataUpdateCount: 1 } };
  expect(state.options.refetchInterval(query)).toBe(5000);
  query.state.error = new Error('down'); query.state.errorUpdateCount = 1;
  expect(state.options.refetchInterval(query)).toBe(10000);
  render(true); expect(state.options.refetchInterval).toBe(false);
  expect(state.options.queryKey).toEqual(['job-analysis', 'owned-job', 1]);
});
it('renders actual API transcript, reason and score rather than placeholder results', () => {
  state.data = { transcript: { language: 'en', provider: 'faster-whisper', model: 'configured-model' }, segments: [{ id: 's1', startSeconds: 1, endSeconds: 3, text: 'Source words & context', speakerLabel: null }], segmentCount: 1, candidates: [{ id: 'c1', startSeconds: 1, endSeconds: 16, hook: 'Source hook', reason: 'Complete explanation', transcriptText: 'Source words', qualityScore: 82, contentCategory: 'educational' }], candidateCount: 1 };
  const html = render(true);
  expect(html).toContain('Source words &amp; context'); expect(html).toContain('Complete explanation'); expect(html).toContain('Quality 82/100');
});
it('surfaces API failure with retry rather than presenting fake transcript', () => {
  state.error = new Error('Backend unavailable');
  expect(render()).toContain('Backend unavailable'); expect(render()).not.toContain('Source hook');
});
