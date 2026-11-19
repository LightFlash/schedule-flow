/**
 * 全新安装语义：卸载重装后首次启动（安装标记缺失）时，
 * 设置 / 窗口布局 / 计时运行态 / 登录项回到初始状态，仅保留工作数据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetElectronStub } from './.build/electronStub.mjs';
import { StoreService, createDefaultData } from './.build/store.mjs';
import { makeTodo } from './helpers/helpers.mjs';

test('resetNonPersonalState：工作数据保留，设置/布局/运行态回到初始状态', () => {
  resetElectronStub();
  const seeded = createDefaultData();
  seeded.todos = [makeTodo({ id: 'A', title: '我的工作项' })];
  seeded.pomodoroRecords = [{ marker: 'kept' }];
  seeded.settings.push.serverChanKey = 'SCT-old-key';
  seeded.settings.push.pushPlusToken = 'ppt-old-token';
  seeded.settings.pomodoro.workMinutes = 45;
  seeded.settings.autoBackup = false;
  seeded.pomodoroRuntime.config.breakMinutes = 15;
  seeded.workTimerRuntime.activeTimerId = 'A';
  seeded.windows.windows.pomo = { open: true, x: 900, y: 700, width: 500, height: 500, pinned: true };
  globalThis.__qaStoreSeed = {
    todos: seeded.todos,
    pomodoroRecords: seeded.pomodoroRecords,
    settings: seeded.settings,
    pomodoroRuntime: seeded.pomodoroRuntime,
    workTimerRuntime: seeded.workTimerRuntime,
    windows: seeded.windows,
  };
  try {
    const store = new StoreService();
    store.resetNonPersonalState();
    const data = store.getAppData();

    // 个人工作数据保留
    assert.equal(data.todos.length, 1, 'TODO 清单必须保留');
    assert.equal(data.todos[0].id, 'A');
    assert.equal(data.todos[0].title, '我的工作项');
    assert.deepEqual(data.pomodoroRecords, [{ marker: 'kept' }], '番茄钟记录必须保留');

    // 非个人状态回到初始
    assert.equal(data.settings.push.serverChanKey, '', '推送密钥应重置');
    assert.equal(data.settings.push.pushPlusToken, '');
    assert.equal(data.settings.pomodoro.workMinutes, 25);
    assert.equal(data.settings.autoBackup, true);
    assert.equal(data.pomodoroRuntime.config.breakMinutes, 5, '计时运行态应重置');
    assert.equal(data.workTimerRuntime.activeTimerId, null);
    assert.equal(data.windows.mode, 'standard');
    assert.equal(data.windows.windows.pomo.width, 280, '窗口布局应重置为新默认');
    assert.equal(data.windows.windows.pomo.pinned, false);
    assert.equal(data.windows.windows.todo.x, 324);
  } finally {
    delete globalThis.__qaStoreSeed;
  }
});

test('标记存在（非全新安装）时不应触发重置：StoreService 正常读取原状态', () => {
  resetElectronStub();
  const seeded = createDefaultData();
  seeded.settings.push.serverChanKey = 'SCT-keep';
  seeded.windows.windows.pomo.width = 500;
  globalThis.__qaStoreSeed = {
    settings: seeded.settings,
    windows: seeded.windows,
  };
  try {
    const store = new StoreService();
    const data = store.getAppData();
    assert.equal(data.settings.push.serverChanKey, 'SCT-keep', '正常启动不得清掉设置');
    assert.equal(data.windows.windows.pomo.width, 500, '正常启动不得重置布局');
  } finally {
    delete globalThis.__qaStoreSeed;
  }
});
