/** Compile with decorator metadata; serialize restarts until the previous child CLOSES. */
const { spawn } = require('node:child_process');
const path = require('node:path');

function supervise({ spawnProcess = spawn, log = console, finish = code => { process.exitCode = code; }, graceMs = 10000 } = {}) {
  const cwd = path.resolve(__dirname, '../apps/api');
  let server;
  let compiler;
  let stopping = false;
  let pending = false;
  let restartRequested = false;
  const timers = new Map();
  function stopChild(child, api = false) {
    if (!child || timers.has(child)) return;
    // IPC allows graceful app.close() on Windows too; SIGTERM there terminates immediately.
    if (api && child.connected) child.send({ type: 'clipforge:shutdown' }, error => { if (error) child.kill('SIGTERM'); });
    else child.kill('SIGTERM');
    timers.set(child, setTimeout(() => {
      log.error('[dev-api] Shutdown deadline exceeded; terminating only this workflow\'s child.');
      child.kill('SIGKILL');
    }, graceMs));
  }
  function closed(child) { clearTimeout(timers.get(child)); timers.delete(child); }
  function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    pending = false;
    finish(code);
    stopChild(compiler);
    stopChild(server, true);
  }
  function startServer() {
    if (stopping || server) return;
    restartRequested = false;
    const child = spawnProcess(process.execPath, ['dist/main.js'], { cwd, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env: process.env });
    server = child;
    child.on('error', error => { log.error('[dev-api] API spawn failed:', error.message); shutdown(1); });
    child.on('close', (code, signal) => {
      closed(child);
      server = undefined;
      if (stopping) return;
      if (restartRequested && pending) { pending = false; startServer(); }
      else {
        log.error(`[dev-api] API exited (code=${code}, signal=${signal}). Watcher stopped. Resolve the startup error and rerun npm run dev:api.`);
        shutdown(code || 1);
      }
    });
  }
  function compiled() {
    if (stopping) return;
    if (!server) startServer();
    else { pending = true; restartRequested = true; stopChild(server, true); }
  }
  compiler = spawnProcess(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json', '--watch', '--preserveWatchOutput', '--pretty', 'false'], { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  let buffer = '';
  compiler.stdout.on('data', chunk => {
    process.stdout.write(chunk);
    const lines = (buffer + chunk.toString()).split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) if (/Found 0 errors\. Watching for file changes\./.test(line)) compiled();
  });
  compiler.on('error', error => { log.error('[dev-api] Compiler failed:', error.message); shutdown(1); });
  compiler.on('close', code => { closed(compiler); compiler = undefined; if (!stopping) shutdown(code || 1); });
  return { shutdown };
}

if (require.main === module) {
  // Last-resort guard for a misconfigured deployment; production must execute compiled JS.
  if (process.env.NODE_ENV === 'production' || process.env.RENDER === 'true') {
    console.error('[fatal] Development watcher is forbidden in production/Render. Use npm run start:api from the repository root or npm run start:prod from apps/api.');
    process.exit(1);
  }
  if (process.argv.includes('--check')) process.exit(0);
  const workflow = supervise();
  process.on('SIGINT', () => workflow.shutdown());
  process.on('SIGTERM', () => workflow.shutdown());
}
module.exports = { supervise };
