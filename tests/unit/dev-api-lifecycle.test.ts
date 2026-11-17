import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
const { supervise } = createRequire(import.meta.url)('../../scripts/dev-api.cjs');
class Child extends EventEmitter {
  stdout = new EventEmitter();
  connected = true;
  kill = vi.fn();
  send = vi.fn();
}
afterEach(() => vi.useRealTimers());
function harness() {
  vi.useFakeTimers();
  const children: Child[] = [];
  const spawnProcess = vi.fn(() => { const child = new Child(); children.push(child); return child; });
  const finish = vi.fn();
  const log = { error: vi.fn() };
  const workflow = supervise({ spawnProcess, finish, log, graceMs: 100 });
  const compile = () => children[0].stdout.emit('data', 'Found 0 errors. Watching for file changes.\n');
  return { children, finish, log, workflow, compile };
}
it('serializes repeated compile events until the old child closes, not merely exits', () => {
  const h = harness(); h.compile(); h.compile(); h.compile();
  expect(h.children).toHaveLength(2);
  expect(h.children[1].send).toHaveBeenCalledTimes(1);
  h.children[1].emit('exit', 0); expect(h.children).toHaveLength(2);
  h.children[1].emit('close', 0); expect(h.children).toHaveLength(3);
  h.workflow.shutdown(); h.children[2].emit('close', 0); h.children[0].emit('close', 0);
});
it('fails the workflow when the API exits with a bind/startup failure; does not respawn', () => {
  const h = harness(); h.compile(); h.children[1].emit('close', 1);
  expect(h.finish).toHaveBeenCalledWith(1);
  expect(h.children[0].kill).toHaveBeenCalledWith('SIGTERM');
  h.compile(); expect(h.children).toHaveLength(2);
  h.children[0].emit('close', 0);
});
it('gracefully shuts down only owned children using IPC before bounded force termination', () => {
  const h = harness(); h.compile(); h.workflow.shutdown(); h.workflow.shutdown();
  expect(h.children[1].send).toHaveBeenCalledWith({ type: 'clipforge:shutdown' }, expect.any(Function));
  vi.advanceTimersByTime(101);
  expect(h.children[1].kill).toHaveBeenCalledWith('SIGKILL');
  h.children[1].emit('close', 0); h.children[0].emit('close', 0);
  expect(h.children).toHaveLength(2);
});
