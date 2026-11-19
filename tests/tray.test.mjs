/** 关闭到托盘：X 只隐藏，左键切换，右键菜单退出才真正 quit 并保留 before-quit 备份。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetElectronStub } from './.build/electronStub.mjs';

test('close 隐藏到托盘；托盘左键切换；退出菜单才退出且 before-quit 允许窗口关闭', async () => {
  resetElectronStub();
  const qa = globalThis.__qaElectron;
  const previousUrl = process.env.ELECTRON_RENDERER_URL;
  // ESM 测试环境没有 Electron CJS 的 __dirname，仅用于拼接 preload 路径。
  const previousDirname = globalThis.__dirname;
  globalThis.__dirname = process.cwd();
  process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173';

  try {
    await import('./.build/mainIndex.mjs');
    // whenReady().then() 在微任务中装配窗口与托盘。
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(qa.windows.length, 1);
    const win = qa.windows[0];
    assert.ok(qa.tray, '托盘实例必须被模块级引用保持');
    assert.match(qa.trayIconUri, /^data:image\/png;base64,/, '托盘图标必须是内联 PNG data URI');
    assert.equal(qa.tray.tooltip, 'Schedule Flow');

    const template = qa.menuTemplates[0];
    assert.deepEqual(
      template.filter((item) => item.type !== 'separator').map((item) => item.label),
      ['显示窗口', '退出程序'],
    );

    win.emit('ready-to-show');
    assert.equal(win.isVisible(), true);

    // 点窗口 X：阻止默认关闭并隐藏，进程不退出（计时循环仍在主进程）。
    let prevented = false;
    win.emit('close', { preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(win.isVisible(), false);
    assert.equal(win.hiddenCount, 1);
    assert.equal(qa.quitCalls, 0);

    // 托盘左键：隐藏 -> 显示 -> 隐藏。
    qa.tray.emit('click');
    assert.equal(win.isVisible(), true);
    assert.ok(win.focusCount > 0);
    qa.tray.emit('click');
    assert.equal(win.isVisible(), false);

    // 右键菜单「显示窗口」重新唤出。
    template[0].click();
    assert.equal(win.isVisible(), true);
    assert.equal(qa.quitCalls, 0);

    // 右键菜单「退出程序」才真正退出。
    const backupCount = () => qa.getPathCalls.filter((name) => name === 'userData').length;
    assert.equal(backupCount(), 0, '窗口 close / 托盘切换不得触发自动备份');
    template[2].click();
    assert.equal(qa.quitCalls, 1);
    assert.equal(backupCount(), 0, 'app.quit 本身不备份，只由 before-quit 触发');

    // before-quit：停 tick、自动备份、销毁托盘，并标记允许窗口真正关闭。
    for (const handler of qa.appEvents.get('before-quit') ?? []) handler();
    assert.equal(backupCount(), 1, 'before-quit 中自动备份恰好一次');
    assert.equal(qa.tray, null);
    prevented = false;
    win.emit('close', { preventDefault: () => { prevented = true; } });
    assert.equal(prevented, false, '退出流程中 close 不应再被拦截');

    // window-all-closed 不重复触发第二次 quit。
    for (const handler of qa.appEvents.get('window-all-closed') ?? []) handler();
    assert.equal(qa.quitCalls, 1);
  } finally {
    if (previousUrl === undefined) delete process.env.ELECTRON_RENDERER_URL;
    else process.env.ELECTRON_RENDERER_URL = previousUrl;
    if (previousDirname === undefined) delete globalThis.__dirname;
    else globalThis.__dirname = previousDirname;
    // 确保 250ms tick 定时器被清理，不阻塞测试进程退出。
    for (const handler of qa.appEvents.get('before-quit') ?? []) handler();
  }
});
