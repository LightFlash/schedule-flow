/**
 * One-command QA runner (zero new dependencies):
 *   node tests/run.mjs
 *
 * Bundles the REAL TypeScript sources with the already-installed esbuild
 * (a transitive dependency of electron-vite), replacing `electron` and
 * `electron-store` with local stubs, then runs all node:test suites.
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, '..');
const buildDir = path.join(testsDir, '.build');
fs.mkdirSync(buildDir, { recursive: true });

const entryPoints = {
  time: path.join(root, 'src/shared/time.ts'),
  ipcChannels: path.join(root, 'src/shared/ipcChannels.ts'),
  workTimerRuntime: path.join(root, 'src/shared/workTimerRuntime.ts'),
  store: path.join(root, 'src/main/store.ts'),
  windows: path.join(root, 'src/main/windows.ts'),
  summaryService: path.join(root, 'src/main/services/summaryService.ts'),
  workTimerEngine: path.join(root, 'src/main/timers/WorkTimerEngine.ts'),
  pomodoroEngine: path.join(root, 'src/main/timers/PomodoroEngine.ts'),
  pushService: path.join(root, 'src/main/services/pushService.ts'),
  reminderService: path.join(root, 'src/main/services/reminderService.ts'),
  ipc: path.join(root, 'src/main/services/ipc.ts'),
  mainIndex: path.join(root, 'src/main/index.ts'),
  electronStub: path.join(testsDir, 'stubs/electron.ts'),
};

await build({
  entryPoints,
  outdir: buildDir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  alias: {
    '@shared': path.join(root, 'src/shared'),
    electron: path.join(testsDir, 'stubs/electron.ts'),
    'electron-store': path.join(testsDir, 'stubs/electronStore.ts'),
  },
  logLevel: 'warning',
});

const testFiles = fs
  .readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => path.join(testsDir, name));

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
  cwd: root,
});
process.exit(result.status ?? 1);
