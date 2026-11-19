/**
 * 真实多窗口端到端回归：三窗口生命周期、独立置顶、关闭拦截、切回标准、
 * 状态广播、托盘协调、退出唯一备份、bounds clamp / 多显示器回退、导入保留本地布局。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IpcCommand, IpcEvent } from './.build/ipcChannels.mjs';
import { resetElectronStub } from './.build/electronStub.mjs';
import {
  StoreService as RealStoreService,
  createDefaultData as createRealDefaultData,
} from './.build/store.mjs';

const STATE_CHANGED = IpcEvent.WINDOW_STATE_CHANGED;

test('多窗口端到端：九类断言', async (t) => {
  resetElectronStub();
  const qa = globalThis.__qaElectron;
  const previousUrl = process.env.ELECTRON_RENDERER_URL;
  const previousDirname = globalThis.__dirname;
  globalThis.__dirname = process.cwd();
  process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173';
  let beforeQuitFired = false;

  try {
    await import('./.build/mainIndex.mjs');
    // whenReady().then() 在微任务中装配窗口/托盘/IPC。
    await new Promise((resolve) => setImmediate(resolve));

    const invoke = async (command, payload) => {
      const handler = qa.handlers.get(command);
      assert.ok(handler, `未注册命令 ${command}`);
      return handler({}, payload);
    };
    const stateChanges = () => qa.emitted.filter((entry) => entry.event === STATE_CHANGED);
    const backupCount = () => qa.getPathCalls.filter((name) => name === 'userData').length;
    const windowOf = (type) => qa.windows.find((win) => win.windowType === type);
    const getState = async () => (await invoke(IpcCommand.WINDOW_GET_STATE)).data;

    const main = qa.windows[0];
    let pomo;
    let todo;

    await t.test('1. 懒创建：启动 1 窗，进极简后 3 窗且 main 隐藏', async () => {
      assert.equal(qa.windows.length, 1);
      assert.equal(main.windowType, 'main');
      assert.match(main.lastLoad.url, /[?&]window=main$/);

      const before = stateChanges().length;
      const result = await invoke(IpcCommand.WINDOW_ENTER_MINI);
      assert.equal(result.ok, true);
      assert.equal(qa.windows.length, 3);

      pomo = windowOf('pomo');
      todo = windowOf('todo');
      assert.ok(pomo, '番茄钟小窗必须被创建');
      assert.ok(todo, 'TODO 小窗必须被创建');
      assert.equal(main.isVisible(), false);
      assert.equal(pomo.isVisible(), true);
      assert.equal(todo.isVisible(), true);
      assert.match(pomo.lastLoad.url, /[?&]window=pomo$/);
      assert.match(todo.lastLoad.url, /[?&]window=todo$/);

      const state = await getState();
      assert.equal(state.mode, 'mini');
      assert.equal(state.windows.pomo.open, true);
      assert.equal(state.windows.todo.open, true);
      assert.equal(stateChanges().length - before, 3, '一次广播覆盖三个窗口');
    });

    await t.test('2. 独立置顶：只影响目标小窗', async () => {
      const before = stateChanges().length;
      const result = await invoke(IpcCommand.WINDOW_SET_PINNED, {
        windowKey: 'pomo',
        pinned: true,
      });
      assert.equal(result.ok, true);
      assert.equal(pomo.alwaysOnTop, true);
      assert.equal(todo.alwaysOnTop, false, 'TODO 小窗不得被联动置顶');
      assert.equal(main.alwaysOnTop, false, '主窗口不得被联动置顶');
      assert.equal(stateChanges().length - before, 3);

      const state = await getState();
      assert.equal(state.windows.pomo.pinned, true);
      assert.equal(state.windows.todo.pinned, false);

      const bad = await invoke(IpcCommand.WINDOW_SET_PINNED, { windowKey: 'main', pinned: true });
      assert.equal(bad.ok, false, 'windowKey 必须是 pomo / todo');
    });

    await t.test('3. 小窗 close 被拦截仅隐藏，进程不退出', async () => {
      const before = stateChanges().length;
      let prevented = false;
      pomo.emit('close', { preventDefault: () => { prevented = true; } });
      assert.equal(prevented, true);
      assert.equal(pomo.isVisible(), false);
      assert.equal(pomo.hiddenCount >= 1, true);
      assert.equal(qa.quitCalls, 0);
      assert.equal(stateChanges().length - before, 3);
      assert.equal((await getState()).windows.pomo.open, false);

      const reopened = await invoke(IpcCommand.MINI_WINDOW_OPEN, { windowKey: 'pomo' });
      assert.equal(reopened.ok, true);
      assert.equal(pomo.isVisible(), true);
      assert.equal((await getState()).windows.pomo.open, true);
      assert.equal(
        (await invoke(IpcCommand.MINI_WINDOW_CLOSE, { windowKey: 'bad' })).ok,
        false,
        '非法 windowKey 被拒绝',
      );
    });

    await t.test('4. exitMini 恢复标准模式：两小窗隐藏、main 显示', async () => {
      const before = stateChanges().length;
      const result = await invoke(IpcCommand.WINDOW_EXIT_MINI);
      assert.equal(result.ok, true);
      assert.equal(pomo.isVisible(), false);
      assert.equal(todo.isVisible(), false);
      assert.equal(main.isVisible(), true);
      assert.equal(stateChanges().length - before, 3);

      const state = await getState();
      assert.equal(state.mode, 'standard');
      assert.equal(state.windows.pomo.open, false);
      assert.equal(state.windows.todo.open, false);
    });

    await t.test('5. WINDOW_STATE_CHANGED 载荷含 mode + 两小窗 geometry', () => {
      const entries = stateChanges();
      assert.ok(entries.length > 0);
      const payload = entries.at(-1).payload;
      assert.equal(payload.mode, 'standard');
      assert.ok(payload.windows.pomo && payload.windows.todo);
      assert.equal(typeof payload.windows.pomo.width, 'number');
      assert.equal(typeof payload.windows.todo.pinned, 'boolean');
      // pomo 的独立置顶跨模式切换保留。
      assert.equal(payload.windows.pomo.pinned, true);
      assert.equal(payload.windows.todo.pinned, false);
    });

    await t.test('6. 托盘协调：standard 切 main，mini 整体切两小窗', async () => {
      qa.tray.emit('click');
      assert.equal(main.isVisible(), false);
      qa.tray.emit('click');
      assert.equal(main.isVisible(), true);

      await invoke(IpcCommand.WINDOW_ENTER_MINI);
      assert.equal(pomo.isVisible(), true);
      assert.equal(todo.isVisible(), true);

      qa.tray.emit('click');
      assert.equal(pomo.isVisible(), false);
      assert.equal(todo.isVisible(), false);
      assert.equal(main.isVisible(), false, 'mini 模式托盘不显示 main');
      qa.tray.emit('click');
      assert.equal(pomo.isVisible(), true);
      assert.equal(todo.isVisible(), true);

      const menu = qa.menuTemplates.at(-1);
      const labels = menu.filter((item) => item.type !== 'separator').map((item) => item.label);
      assert.deepEqual(labels, ['显示窗口', '显示番茄钟窗', '显示 TODO 窗', '退出程序']);

      qa.tray.emit('click'); // 整体隐藏
      menu.find((item) => item.label === '显示 TODO 窗').click();
      assert.equal(todo.isVisible(), true);
      qa.tray.emit('click'); // 整体隐藏
      menu.find((item) => item.label === '显示窗口').click();
      assert.equal(pomo.isVisible(), true);
      assert.equal(todo.isVisible(), true);
    });

    await t.test('7. bounds clamp：非法值拒绝、过小尺寸抬升、越界回退工作区', async () => {
      const invalid = await invoke(IpcCommand.MINI_WINDOW_SET_BOUNDS, {
        windowKey: 'pomo',
        bounds: { width: Number.NaN },
      });
      assert.equal(invalid.ok, false);
      assert.match(invalid.message, /窗口尺寸参数无效/);

      const invalidKey = await invoke(IpcCommand.MINI_WINDOW_SET_BOUNDS, {
        windowKey: 'bad',
        bounds: { width: 300 },
      });
      assert.equal(invalidKey.ok, false);

      const tiny = await invoke(IpcCommand.MINI_WINDOW_SET_BOUNDS, {
        windowKey: 'pomo',
        bounds: { width: 10, height: 10 },
      });
      assert.equal(tiny.ok, true);
      const tinyBounds = pomo.getBounds();
      assert.equal(tinyBounds.width, 260);
      assert.equal(tinyBounds.height, 200);

      const far = await invoke(IpcCommand.MINI_WINDOW_SET_BOUNDS, {
        windowKey: 'pomo',
        bounds: { x: 50000, y: -50000, width: 300, height: 240 },
      });
      assert.equal(far.ok, true);
      const farBounds = pomo.getBounds();
      assert.deepEqual(
        { x: farBounds.x, y: farBounds.y, width: farBounds.width, height: farBounds.height },
        { x: 0, y: 0, width: 300, height: 240 },
        '完全不在显示器内的窗口回退到主工作区左上',
      );
      const state = await getState();
      assert.equal(state.windows.pomo.width, 300);
      assert.equal(state.windows.pomo.height, 240);
    });

    await t.test('8. 退出：备份恰好一次，三窗 close 不再被拦截', async () => {
      assert.equal(backupCount(), 0, '窗口操作与托盘切换不得触发备份');
      const exitItem = qa.menuTemplates.at(-1).find((item) => item.label === '退出程序');
      exitItem.click();
      assert.equal(qa.quitCalls, 1);
      assert.equal(backupCount(), 0, 'app.quit 本身不备份');

      for (const handler of qa.appEvents.get('before-quit') ?? []) handler();
      beforeQuitFired = true;
      assert.equal(backupCount(), 1, 'before-quit 自动备份恰好一次');

      for (const win of qa.windows) {
        let prevented = false;
        win.emit('close', { preventDefault: () => { prevented = true; } });
        assert.equal(prevented, false, '退出流程中 close 不应再被拦截');
      }
      for (const handler of qa.appEvents.get('window-all-closed') ?? []) handler();
      assert.equal(qa.quitCalls, 1, 'window-all-closed 不重复 quit');
    });

    await t.test('9. 导入不覆盖本地窗口布局，且旧备份缺 windows 仍合法', async () => {
      const local = new RealStoreService();
      const localBefore = local.getWindowState();
      const backup = createRealDefaultData();
      backup.windows = {
        mode: 'mini',
        windows: {
          pomo: { open: true, x: 999, y: 999, width: 600, height: 600, pinned: true },
          todo: { open: true, x: 888, y: 888, width: 600, height: 600, pinned: true },
        },
      };
      local.replaceAppData(backup);
      assert.deepEqual(local.getWindowState(), localBefore, '导入不得覆盖设备相关布局');

      const legacy = createRealDefaultData();
      delete legacy.windows;
      const result = await invoke(IpcCommand.DATA_IMPORT, { data: legacy });
      assert.equal(result.ok, true, 'windows 是可选字段，旧备份仍视为合法');
      const state = await getState();
      assert.equal(state.mode, 'mini', '导入后本地 mode 保持不变');
      assert.equal(state.windows.pomo.width, 300, '导入后本地 pomo 布局保持不变');
    });
  } finally {
    // 250ms tick 定时器必须清理，否则测试进程无法退出（幂等保护备份计数）。
    if (!beforeQuitFired) {
      for (const handler of qa.appEvents.get('before-quit') ?? []) handler();
    }
    if (previousUrl === undefined) delete process.env.ELECTRON_RENDERER_URL;
    else process.env.ELECTRON_RENDERER_URL = previousUrl;
    if (previousDirname === undefined) delete globalThis.__dirname;
    else globalThis.__dirname = previousDirname;
  }
});
