#!/usr/bin/env node
// Native Node dotenv parsing: quoted values/comments work and injected variables win.
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawn } = require('node:child_process');
const root = resolve(__dirname, '..');
const [service, rawPort] = process.argv.slice(2);
const port = Number(rawPort);
if (!['ai-engine', 'video-processor'].includes(service) || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Usage: run-service.sh <ai-engine|video-processor> <port 1..65535>');
  process.exit(64);
}
const envFile = resolve(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const localPython = resolve(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = process.env.PYTHON_BIN || (existsSync(localPython) ? localPython : 'python3');
const child = spawn(python, ['-m', 'uvicorn', 'app.main:app', '--app-dir', resolve(root, 'services', service), '--host', '0.0.0.0', '--port', String(port)], { cwd: root, env: process.env, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.once('error', () => { console.error('Could not start Python; configure PYTHON_BIN or create .venv.'); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143); });
