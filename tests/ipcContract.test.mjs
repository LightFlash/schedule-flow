import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IpcCommand, IpcEvent } from './.build/ipcChannels.mjs';
import { IpcRegistry } from './.build/ipc.mjs';
import { installClock, makeStore } from './helpers/helpers.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testsDir, '..');
const src = (relative) => fs.readFileSync(path.join(root, 'src', relative), 'utf8');
const qa = globalThis.__qaElectron;

const commands = Object.values(IpcCommand);
const events = Object.values(IpcEvent);
const mainFiles = [
  'main/index.ts',
  'main/store.ts',
  'main/windows.ts',
  'main/services/ipc.ts',
  'main/services/pushService.ts',
  'main/services/reminderService.ts',
  'main/services/summaryService.ts',
  'main/timers/PomodoroEngine.ts',
  'main/timers/WorkTimerEngine.ts',
];

test('通道常量：34 命令 / 6 事件，值唯一', () => {
  assert.equal(commands.length, 34);
  assert.equal(events.length, 6);
  assert.equal(new Set(commands).size, 34);
  assert.equal(new Set(events).size, 6);
  assert.deepEqual(Object.keys(IpcCommand).sort(), [
    'APP_VERSION',
    'AUTO_BACKUP_SET',
    'AUTO_LAUNCH_GET',
    'AUTO_LAUNCH_SET',
    'DATA_EXPORT',
    'DATA_IMPORT',
    'GET_DATA',
    'MINI_WINDOW_CLOSE',
    'MINI_WINDOW_OPEN',
    'MINI_WINDOW_SET_BOUNDS',
    'POMODORO_CONFIG',
    'POMODORO_PAUSE',
    'POMODORO_RESET',
    'POMODORO_RESUME',
    'POMODORO_START',
    'REMINDER_CONFIRM',
    'SETTINGS_SAVE',
    'SETTINGS_TEST_PUSH',
    'SUMMARY_GET',
    'TODO_ADD',
    'TODO_DELETE',
    'TODO_MOVE',
    'TODO_REORDER',
    'TODO_TOGGLE',
    'TODO_UPDATE',
    'WINDOW_ENTER_MINI',
    'WINDOW_EXIT_MINI',
    'WINDOW_GET_STATE',
    'WINDOW_SET_PINNED',
    'WORK_PAUSE',
    'WORK_RESUME',
    'WORK_START',
    'WORK_STOP',
    'WORK_STOP_ALL',
  ]);
});

test('命令三端一致：常量 = main 注册 = bridge 调用', () => {
  const ipcSource = src('main/services/ipc.ts');
  const bridgeSource = src('renderer/api/bridge.ts');
  const registered = [...ipcSource.matchAll(/this\.handle\(IpcCommand\.([A-Z_]+)/g)].map((m) => m[1]);
  const invoked = [...bridgeSource.matchAll(/IpcCommand\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual(registered.sort(), Object.keys(IpcCommand).sort());
  assert.deepEqual(invoked.sort(), Object.keys(IpcCommand).sort());
});

test('事件三端一致：常量 = main 发送 = bridge 订阅', () => {
  const mainSources = mainFiles.map(src).join('\n');
  const bridgeSource = src('renderer/api/bridge.ts');
  const sent = [...mainSources.matchAll(/IpcEvent\.([A-Z_]+)/g)].map((m) => m[1]);
  const subscribed = [...bridgeSource.matchAll(/onEvent<[^>]+>\(IpcEvent\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(sent)].sort(), Object.keys(IpcEvent).sort());
  assert.deepEqual(subscribed.sort(), Object.keys(IpcEvent).sort());
});

test('通道字符串无散落魔法值；preload 白名单来自常量', () => {
  const allSourceFiles = [...mainFiles, 'preload/index.ts', 'renderer/api/bridge.ts', 'renderer/store/useAppStore.ts'];
  const concatenation = allSourceFiles.map(src).join('\n');
  for (const channel of [...commands, ...events]) {
    assert.ok(!concatenation.includes(`'${channel}'`), `通道 ${channel} 不应在 shared/ipcChannels.ts 之外出现`);
    assert.ok(!concatenation.includes(`"${channel}"`), `通道 ${channel} 不应在 shared/ipcChannels.ts 之外出现`);
  }
  const preload = src('preload/index.ts');
  assert.match(preload, /Object\.values\(IpcCommand\)/);
  assert.match(preload, /Object\.values\(IpcEvent\)/);
  assert.match(preload, /contextBridge\.exposeInMainWorld/);
});

test('渲染层不直接 import electron', () => {
  const rendererFiles = [
    'renderer/App.tsx',
    'renderer/main.tsx',
    'renderer/api/bridge.ts',
    'renderer/store/useAppStore.ts',
    'renderer/views/PomodoroView.tsx',
    'renderer/views/TodoView.tsx',
    'renderer/views/WorkTimerView.tsx',
    'renderer/views/SummaryView.tsx',
    'renderer/components/Layout.tsx',
    'renderer/components/SettingsDialog.tsx',
    'renderer/components/ReminderOverlay.tsx',
  ];
  for (const file of rendererFiles) {
    const source = src(file);
    assert.ok(!/from\s+['"]electron['"]/.test(source), `${file} 不得直接依赖 electron`);
  }
});

test('运行时：IpcRegistry 恰好注册 34 个命令，且非法汇总粒度被拒绝', async () => {
  const clock = installClock(new Date(2026, 10, 19).getTime());
  qa.handlers.clear();
  const store = makeStore();
  try {
    new IpcRegistry(
      store,
      {},
      {},
      { buildSummary: (granularity) => ({ granularity }) },
      {},
      {},
      {
        getState: () => ({ mode: 'standard', windows: {} }),
      },
    ).registerAll();
    assert.equal(qa.handlers.size, 34);
    for (const channel of commands) {
      assert.ok(qa.handlers.has(channel), `未注册命令 ${channel}`);
    }

    const bad = await qa.handlers.get(IpcCommand.SUMMARY_GET)({}, 'hour');
    assert.equal(bad.ok, false);
    assert.match(bad.message, /不支持的汇总粒度/);

    const good = await qa.handlers.get(IpcCommand.SUMMARY_GET)({}, 'week');
    assert.equal(good.ok, true);
    assert.equal(good.data.granularity, 'week');

    const invalidTodo = await qa.handlers.get(IpcCommand.TODO_ADD)({}, { title: '   ' });
    assert.equal(invalidTodo.ok, false);
  } finally {
    clock.restore();
  }
});
