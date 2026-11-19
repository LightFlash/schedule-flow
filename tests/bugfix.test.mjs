/**
 * QA 回传 Bug 回归：
 * BUG-1 强提醒触发/确认后严格恢复触发前显隐（mini / standard 两态）；
 * BUG-2 上次退出残留 mini 模式时，启动强制 standard 且只建主窗。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserWindow, resetElectronStub } from './.build/electronStub.mjs';
import { ReminderService } from './.build/reminderService.mjs';
import { StoreService, createDefaultData } from './.build/store.mjs';
import { WindowManager } from './.build/windows.mjs';
import { makeStore } from './helpers/helpers.mjs';
import { IpcCommand, IpcEvent } from './.build/ipcChannels.mjs';

const REMINDER_PAYLOAD = { phase: 'work', title: '该休息了', message: '起身活动一下' };

/** 构造三窗口并按给定显隐初始化；返回窗口数组。 */
function setupWindows(visibility) {
  const entries = [
    ['main', visibility.main],
    ['pomo', visibility.pomo],
    ['todo', visibility.todo],
  ];
  return entries.map(([windowType, visible]) => {
    const win = new BrowserWindow({ windowType });
    if (visible) win.show();
    else win.hide();
    return win;
  });
}

function visibilityOf(windows) {
  return windows.map((win) => win.isVisible());
}

test('BUG-1a：mini 模式强提醒 confirm 后 main 恢复隐藏、两小窗保持可见', async () => {
  resetElectronStub();
  const qa = globalThis.__qaElectron;
  const windows = setupWindows({ main: false, pomo: true, todo: true });
  assert.deepEqual(visibilityOf(windows), [false, true, true]);

  const service = new ReminderService({ sendPush: async () => [] });
  let restorerSaw = null;
  service.setPinnedRestorer(() => {
    restorerSaw = visibilityOf(windows);
  });

  await service.trigger(REMINDER_PAYLOAD, createDefaultData().settings);
  assert.deepEqual(visibilityOf(windows), [true, true, true], '提醒期间应强行唤出全部窗口');

  // 提醒中重复触发不能把已污染的状态误当作原始快照。
  await service.trigger(REMINDER_PAYLOAD, createDefaultData().settings);
  service.confirm();

  assert.deepEqual(visibilityOf(windows), [false, true, true], 'confirm 后必须严格回放触发前显隐');
  assert.deepEqual(restorerSaw, [false, true, true], '置顶恢复回调应看到最终显隐状态');
  assert.equal(service.isActive(), false);
  assert.ok(qa.emitted.some((entry) => entry.event === IpcEvent.REMINDER_SHOW));
  assert.ok(qa.emitted.some((entry) => entry.event === IpcEvent.REMINDER_HIDE));
  assert.equal(qa.quitCalls, 0);
});

test('BUG-1b：standard 模式已隐藏的小窗不会被提醒残留弹出', async () => {
  resetElectronStub();
  const windows = setupWindows({ main: true, pomo: false, todo: false });

  const service = new ReminderService({ sendPush: async () => [] });
  await service.trigger(REMINDER_PAYLOAD, createDefaultData().settings);
  assert.deepEqual(visibilityOf(windows), [true, true, true]);
  service.confirm();

  assert.deepEqual(visibilityOf(windows), [true, false, false], '标准模式不应残留三窗同显');

  // 无待确认提醒时 confirm 幂等，不改动显隐。
  service.confirm();
  assert.deepEqual(visibilityOf(windows), [true, false, false]);
});

test('BUG-1c：提醒期间被销毁的窗口不阻断其余窗口显隐回放', async () => {
  resetElectronStub();
  const windows = setupWindows({ main: false, pomo: true, todo: true });
  const service = new ReminderService({ sendPush: async () => [] });
  await service.trigger(REMINDER_PAYLOAD, createDefaultData().settings);

  windows[0].destroyed = true;
  service.confirm();
  assert.equal(windows[1].isVisible(), true);
  assert.equal(windows[2].isVisible(), true);
});

test('KI-1：提醒期间切换模式后，confirm 按当前模式重放显隐而非过期快照', async () => {
  resetElectronStub();
  const previousDirname = globalThis.__dirname;
  globalThis.__dirname = process.cwd();
  try {
    const store = makeStore();
    const wm = new WindowManager(store);
    const service = new ReminderService({ sendPush: async () => [] });
    service.setModeProvider(() => wm.getState().mode);
    service.setModeVisibilityRestorer(() => wm.syncVisibilityToMode());

    wm.createMainWindow();
    wm.enterMiniMode();
    const qa = globalThis.__qaElectron;
    const main = wm.getMainWindow();
    const pomo = wm.getMiniWindow('pomo');
    const todo = wm.getMiniWindow('todo');
    assert.equal(qa.windows.length, 3);
    assert.deepEqual([main, pomo, todo].map((w) => w.isVisible()), [false, true, true]);

    await service.trigger(REMINDER_PAYLOAD, createDefaultData().settings);
    assert.deepEqual([main, pomo, todo].map((w) => w.isVisible()), [true, true, true]);

    // 用户在小窗点「切回标准模式」：mode 与显隐都已变化。
    wm.exitMiniMode();
    assert.equal(wm.getState().mode, 'standard');
    assert.deepEqual([main, pomo, todo].map((w) => w.isVisible()), [true, false, false]);

    service.confirm();
    assert.equal(main.isVisible(), true, '新模式下主窗不能被过期快照隐藏');
    assert.equal(pomo.isVisible(), false);
    assert.equal(todo.isVisible(), false);
    assert.equal(wm.getState().mode, 'standard');

    // 反向：提醒期间 mode 改为 mini，confirm 应按 mini 重放（main 隐藏、小窗显示）。
    await service.trigger(REMINDER_PAYLOAD, createDefaultData().settings);
    store.setMode('mini');
    service.confirm();
    assert.deepEqual([main, pomo, todo].map((w) => w.isVisible()), [false, true, true]);

    // syncVisibilityToMode 只做显隐，不写 mode。
    const modeBefore = wm.getState().mode;
    wm.syncVisibilityToMode();
    assert.equal(wm.getState().mode, modeBefore);
    assert.equal(store.data.windows.mode, 'mini');
  } finally {
    if (previousDirname === undefined) delete globalThis.__dirname;
    else globalThis.__dirname = previousDirname;
  }
});

test('BUG-2：持久化为 mini 时启动重置 standard，只建主窗且托盘无小窗项', async () => {
  resetElectronStub();
  const qa = globalThis.__qaElectron;
  const previousUrl = process.env.ELECTRON_RENDERER_URL;
  const previousDirname = globalThis.__dirname;

  const persisted = createDefaultData();
  persisted.windows.mode = 'mini';
  persisted.windows.windows.pomo.open = true;
  persisted.windows.windows.todo.open = true;
  globalThis.__qaStoreSeed = { windows: persisted.windows };

  globalThis.__dirname = process.cwd();
  process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173';
  let beforeQuitFired = false;
  try {
    await import('./.build/mainIndex.mjs');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(qa.windows.length, 1, '启动只建主窗');
    assert.equal(qa.windows[0].windowType, 'main');
    const labels = qa.menuTemplates[0]
      .filter((item) => item.type !== 'separator')
      .map((item) => item.label);
    assert.deepEqual(labels, ['显示窗口', '退出程序'], '托盘菜单不得残留 mini 项');

    const state = await qa.handlers.get(IpcCommand.WINDOW_GET_STATE)({});
    assert.equal(state.ok, true);
    assert.equal(state.data.mode, 'standard');
    assert.equal(state.data.windows.pomo.open, false, '残留 open 标记也要清掉');
    assert.equal(state.data.windows.todo.open, false);

    // 托盘左键走 standard 分支：只切 main，不创建小窗。
    qa.windows[0].emit('ready-to-show');
    assert.equal(qa.windows[0].isVisible(), true);
    qa.tray.emit('click');
    assert.equal(qa.windows[0].isVisible(), false);
    assert.equal(qa.windows.length, 1);
    qa.tray.emit('click');
    assert.equal(qa.windows[0].isVisible(), true);
    assert.equal(qa.windows.length, 1);
  } finally {
    if (!beforeQuitFired) {
      for (const handler of qa.appEvents.get('before-quit') ?? []) handler();
    }
    if (previousUrl === undefined) delete process.env.ELECTRON_RENDERER_URL;
    else process.env.ELECTRON_RENDERER_URL = previousUrl;
    if (previousDirname === undefined) delete globalThis.__dirname;
    else globalThis.__dirname = previousDirname;
    delete globalThis.__qaStoreSeed;
  }
});

test('迁移：无布局版本标记的旧几何整体重置为新默认；带当前版本标记的自定义几何保留', () => {
  resetElectronStub();

  // 场景一：旧数据（用户拖过 462×474 / 506×403，且无 layoutVersion）→ 启动整体重置。
  const legacy = createDefaultData();
  legacy.windows.windows.pomo = { open: true, x: 755, y: 443, width: 462, height: 474, pinned: false };
  legacy.windows.windows.todo = { open: true, x: 256, y: 458, width: 506, height: 403, pinned: true };
  legacy.windows.mode = 'mini';
  delete legacy.windows.layoutVersion; // 旧版本数据没有布局版本标记
  globalThis.__qaStoreSeed = { windows: legacy.windows };
  try {
    const store = new StoreService();
    const state = store.getWindowState();
    assert.equal(state.mode, 'standard', '布局重置时模式一并回到 standard');
    assert.equal(state.windows.pomo.width, 280, '旧几何应整体重置为新默认');
    assert.equal(state.windows.pomo.height, 340);
    assert.equal(state.windows.todo.width, 300);
    assert.equal(state.windows.todo.height, 380);
    assert.equal(state.windows.todo.pinned, false, '重置后置顶状态也应回到默认');
  } finally {
    delete globalThis.__qaStoreSeed;
  }

  // 场景二：带当前 layoutVersion 的自定义几何 → 完整保留。
  const customized = createDefaultData();
  customized.windows.windows.pomo.width = 460;
  customized.windows.windows.pomo.height = 500;
  customized.windows.layoutVersion = 3;
  globalThis.__qaStoreSeed = { windows: customized.windows };
  try {
    const store = new StoreService();
    const state = store.getWindowState();
    assert.equal(state.windows.pomo.width, 460, '版本内手动调整过的尺寸不能被覆盖');
    assert.equal(state.windows.pomo.height, 500);
    assert.equal(state.layoutVersion, 3);
  } finally {
    delete globalThis.__qaStoreSeed;
  }
});
