/** Nest needs TypeScript's emitDecoratorMetadata; tsx/esbuild intentionally omits it.
 * Compile every edit with tsc and only restart after a successful compilation.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const cwd = path.resolve(__dirname, '../apps/api');
let server;
let stopping = false;
let pending = false;
function startServer() {
  if (stopping) return;
  server = spawn(process.execPath, ['dist/main.js'], { cwd, stdio: 'inherit', env: process.env });
  server.on('exit', () => { server = undefined; if (pending && !stopping) { pending = false; startServer(); } });
}
function restart() {
  if (stopping) return;
  if (server) { pending = true; server.kill('SIGTERM'); }
  else startServer();
}
const compiler = spawn(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json', '--watch', '--preserveWatchOutput', '--pretty', 'false'], { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
let buffer = '';
compiler.stdout.on('data', chunk => {
  process.stdout.write(chunk);
  buffer += chunk.toString();
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop();
  for (const line of lines) if (/Found 0 errors\. Watching for file changes\./.test(line)) restart();
});
function shutdown() {
  if (stopping) return;
  stopping = true;
  compiler.kill('SIGTERM');
  server?.kill('SIGTERM');
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
compiler.on('error', error => { console.error(error); shutdown(); process.exitCode = 1; });
compiler.on('exit', code => { shutdown(); if (code) process.exitCode = code; });
