/** Fail before compilation if a cached install or edited manifest changes our compiler. */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function checkTypeScript(root = path.resolve(__dirname, '..')) {
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const manifest = read('package.json');
  const expected = manifest.devDependencies.typescript;
  if (!/^\d+\.\d+\.\d+$/.test(expected) || manifest.overrides?.typescript !== '$typescript') {
    throw new Error('Root TypeScript must be an exact version with an override referencing $typescript.');
  }
  const lock = read('package-lock.json');
  if (lock.packages[''].devDependencies.typescript !== expected) throw new Error('Root lockfile TypeScript pin differs from package.json.');
  const compilers = Object.entries(lock.packages).filter(([name]) => name.endsWith('/typescript'));
  if (!compilers.length || compilers.some(([, pkg]) => pkg.version !== expected)) throw new Error('Lockfile contains a missing or incompatible TypeScript compiler.');
  for (const workspace of ['.', ...manifest.workspaces]) {
    const file = workspace === '.' ? 'package.json' : `${workspace}/package.json`;
    const pkg = read(file);
    if (pkg.devDependencies?.typescript !== expected) throw new Error(`${file}: declare typescript ${expected} explicitly.`);
    const locked = lock.packages[workspace === '.' ? '' : workspace];
    if (locked?.devDependencies?.typescript !== expected) throw new Error(`${file}: regenerate the root package-lock.json.`);
    const from = createRequire(path.join(root, file));
    const actual = from('typescript').version;
    if (actual !== expected) throw new Error(`${pkg.name}: resolves TypeScript ${actual}, expected ${expected}.`);
    console.log(`[typescript] ${pkg.name}: ${actual}`);
  }
  return expected;
}
if (require.main === module) {
  try { checkTypeScript(); }
  catch (error) {
    console.error(`[fatal] Compiler consistency check failed: ${error.message}\nUse the committed root lockfile and npm ci --include=dev; do not install typescript@latest or use a global compiler.`);
    process.exitCode = 1;
  }
}
module.exports = { checkTypeScript };
