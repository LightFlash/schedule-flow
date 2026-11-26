/**
 * v1.0.4 事件推送回归：
 * - 模板渲染：变量替换 / 未知变量原样保留 / 空值转空串 / 非字符串模板兜底；
 * - PushService.sendEvent：事件禁用不发、启用后按模板渲染走原渠道，异常吞掉；
 * - 工作计时：workStart 只在 idle→running 首发一次（暂停后继续不发），
 *   workStop 在 stop / stopAll / 勾选完成三条路径各发一次且变量正确；
 * - 配置兼容：settings 缺 events 时 ensureShape 补默认且不覆盖已有 JSON，
 *   老配置（无 events 字段）保存回读不丢原有凭证与番茄参数；
 * - 提醒接线：带 event 的提醒走事件模板，不带 event 的旧载荷仍走 sendPush。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PUSH_EVENT_KEYS,
  createDefaultPushEvents,
  formatPushTime,
  normalizePushEvents,
  renderPushTemplate,
} from './.build/pushTemplate.mjs';
import { PushService } from './.build/pushService.mjs';
import { ReminderService } from './.build/reminderService.mjs';
import { PomodoroEngine } from './.build/pomodoroEngine.mjs';
import { WorkTimerEngine } from './.build/workTimerEngine.mjs';
import { StoreService, createDefaultData } from './.build/store.mjs';
import { IpcRegistry } from './.build/ipc.mjs';
import { IpcCommand } from './.build/ipcChannels.mjs';
import { resetElectronStub } from './.build/electronStub.mjs';
import { installClock, makeStore, makeTodo } from './helpers/helpers.mjs';

const MIN = 60000;
const T0 = new Date(2026, 10, 19, 9, 0, 0).getTime();
const qa = globalThis.__qaElectron;

/** 记录所有事件推送（mock，绝不发起真实网络请求）。 */
function recordingPush() {
  const calls = [];
  return {
    calls,
    sendPush: async (config, title, desp) => {
      calls.push({ kind: 'push', title, desp });
      return [];
    },
    async sendEvent(config, event, vars) {
      calls.push({ kind: 'event', event, vars });
      return [];
    },
  };
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => handler(...args);
  return () => {
    globalThis.fetch = original;
  };
}

const jsonResponse = (body, ok = true) => ({ ok, json: async () => body });

/** 只开 Server酱渠道的合法配置（测试不发真实请求，仅用于构造请求体）。 */
function configWithEvents(events, overrides = {}) {
  const base = createDefaultData().settings.push;
  return {
    ...base,
    serverChanKey: 'SCT-test',
    channels: ['serverchan'],
    events: { ...base.events, ...events },
    ...overrides,
  };
}

// ===== 模板渲染 =====

test('模板渲染：已知变量替换、未知变量原样保留、空值转空串', () => {
  assert.equal(
    renderPushTemplate('「{task}」本次 {session}，累计 {total}', {
      task: '写周报',
      session: '12分钟',
      total: 90,
    }),
    '「写周报」本次 12分钟，累计 90',
  );
  assert.equal(renderPushTemplate('第 {round} 轮', { round: 3 }), '第 3 轮');

  // 未知变量原样保留，便于用户发现拼错的变量名。
  assert.equal(renderPushTemplate('{unknown} 与 {task}', { task: 'A' }), '{unknown} 与 A');
  assert.equal(renderPushTemplate('没有变量 {a b}'), '没有变量 {a b}');

  // 已知变量但值为空 → 空串；null / undefined 同样按空串处理。
  assert.equal(renderPushTemplate('[{empty}]', { empty: '' }), '[]');
  assert.equal(renderPushTemplate('[{missing}]', { missing: null }), '[]');
  assert.equal(renderPushTemplate('[{undef}]', { undef: undefined }), '[]');

  // 异常输入不抛错。
  assert.equal(renderPushTemplate(null, {}), '');
  assert.equal(renderPushTemplate(undefined), '');
  assert.equal(renderPushTemplate('纯文本', {}), '纯文本');
});

test('默认事件模板与变量提示：4 类事件齐备，默认开关符合规划', () => {
  const defaults = createDefaultPushEvents();
  assert.deepEqual([...PUSH_EVENT_KEYS], [
    'workStart',
    'workStop',
    'pomodoroWorkEnd',
    'pomodoroBreakEnd',
  ]);
  assert.equal(defaults.workStart.enabled, false, '工作开始默认关闭');
  assert.equal(defaults.workStop.enabled, true);
  assert.equal(defaults.pomodoroWorkEnd.enabled, true);
  assert.equal(defaults.pomodoroBreakEnd.enabled, true);

  // 渲染默认模板不该留下未替换的已知变量。
  assert.equal(
    renderPushTemplate(defaults.workStop.body, {
      task: '写周报',
      session: '12分钟',
      total: '1小时2分钟',
      time: '09:30',
    }),
    '「写周报」本次用时 12分钟，累计 1小时2分钟\n结束时间 09:30',
  );
  assert.equal(
    renderPushTemplate(defaults.pomodoroWorkEnd.body, { round: 2, breakMinutes: 5 }),
    '已完成第 2 个番茄，休息 5 分钟。',
  );

  // 每次调用返回全新对象，互不污染。
  const a = createDefaultPushEvents();
  a.workStop.title = '被改过';
  assert.notEqual(createDefaultPushEvents().workStop.title, '被改过');
});

test('normalizePushEvents：缺失事件补默认，已有内容（含空串）一律保留', () => {
  const merged = normalizePushEvents({
    workStop: { enabled: false, title: '', body: '自定义正文' },
  });
  assert.deepEqual(merged.workStop, { enabled: false, title: '', body: '自定义正文' });
  assert.deepEqual(merged.workStart, createDefaultPushEvents().workStart);
  assert.deepEqual(merged.pomodoroBreakEnd, createDefaultPushEvents().pomodoroBreakEnd);

  // 脏数据（非对象 / 字段类型不符）逐字段回退默认值。
  const dirty = normalizePushEvents({ workStart: 'oops', workStop: { enabled: 'yes', title: 1 } });
  assert.deepEqual(dirty.workStart, createDefaultPushEvents().workStart);
  assert.deepEqual(dirty.workStop, createDefaultPushEvents().workStop);
  assert.deepEqual(normalizePushEvents(null), createDefaultPushEvents());
  assert.deepEqual(normalizePushEvents(undefined), createDefaultPushEvents());
});

test('formatPushTime：本地 HH:mm，非法时间戳退化为当前时间格式', () => {
  assert.equal(formatPushTime(new Date(2026, 10, 19, 9, 5, 0).getTime()), '09:05');
  assert.equal(formatPushTime(new Date(2026, 10, 19, 23, 59, 0).getTime()), '23:59');
  assert.match(formatPushTime(0), /^\d{2}:\d{2}$/);
  assert.match(formatPushTime(Number.NaN), /^\d{2}:\d{2}$/);
});

// ===== PushService.sendEvent =====

test('sendEvent：事件禁用 / 配置缺失时返回空数组且不发请求', async () => {
  let calls = 0;
  const restore = stubFetch(() => {
    calls += 1;
    return jsonResponse({ code: 0 });
  });
  try {
    const service = new PushService();
    const disabled = configWithEvents({
      workStart: { ...createDefaultPushEvents().workStart, enabled: false },
    });
    assert.deepEqual(await service.sendEvent(disabled, 'workStart', { task: 'A' }), []);

    const missing = { ...disabled };
    delete missing.events;
    assert.deepEqual(await service.sendEvent(missing, 'workStop', { task: 'A' }), []);

    const partial = { ...disabled, events: { workStop: createDefaultPushEvents().workStop } };
    assert.deepEqual(await service.sendEvent(partial, 'pomodoroWorkEnd', {}), [], '缺失该事件不发');

    assert.equal(calls, 0, '禁用 / 缺失事件不得产生任何网络请求');
  } finally {
    restore();
  }
});

test('sendEvent：启用后按模板渲染标题正文，空标题退化为事件名', async () => {
  const requests = [];
  const restore = stubFetch(async (url, init) => {
    requests.push({ url, init });
    return jsonResponse({ code: 0 });
  });
  try {
    const service = new PushService();
    const config = configWithEvents({});
    const results = await service.sendEvent(config, 'workStop', {
      task: '写周报',
      session: '12分钟',
      total: '1小时2分钟',
      time: '09:30',
    });
    assert.deepEqual(results.map((item) => item.ok), [true]);
    const body = new URLSearchParams(requests[0].init.body);
    assert.equal(body.get('title'), '工作结束：写周报');
    assert.equal(body.get('desp'), '「写周报」本次用时 12分钟，累计 1小时2分钟\n结束时间 09:30');

    // 用户把标题清空：退化为事件中文名，不向渠道发送空标题。
    const blank = configWithEvents({
      pomodoroBreakEnd: { enabled: true, title: '   ', body: '休息结束' },
    });
    await service.sendEvent(blank, 'pomodoroBreakEnd', {});
    assert.equal(new URLSearchParams(requests[1].init.body).get('title'), '番茄-休息结束');
  } finally {
    restore();
  }
});

test('sendEvent：网络异常被吞成空数组，不向调用方抛出', async () => {
  const originalWarn = console.warn;
  console.warn = () => undefined;
  const restore = stubFetch(async () => {
    throw new Error('network down');
  });
  try {
    const config = configWithEvents({
      workStart: { ...createDefaultPushEvents().workStart, enabled: true },
    });
    const results = await new PushService().sendEvent(config, 'workStart', {
      task: 'A',
      time: '09:00',
    });
    // 渠道失败被 sendPush 收敛为 ok:false 的结果，绝不会 throw。
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
  } finally {
    restore();
    console.warn = originalWarn;
  }
});

// ===== 工作计时接线 =====

test('workStart 仅首次开始推送：暂停后继续 / 重复 start 均不再发', () => {
  const clock = installClock(T0);
  try {
    const store = makeStore({ todos: [makeTodo({ id: 'A', title: '写周报' })] });
    const push = recordingPush();
    const engine = new WorkTimerEngine(store, push);

    engine.start('A');
    const starts = push.calls.filter((item) => item.event === 'workStart');
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0].vars, { task: '写周报', time: '09:00' });

    clock.advance(10 * MIN);
    engine.pause('A');
    engine.start('A'); // paused → 继续，不算「开始工作」
    engine.resume('A'); // 显式继续
    engine.start('A'); // 已在计时中，幂等空操作
    assert.equal(
      push.calls.filter((item) => item.event === 'workStart').length,
      1,
      '暂停后继续不得重复推送工作开始',
    );
  } finally {
    clock.restore();
  }
});

test('workStop：单项停止推送一次，变量为本次/累计用时与结束时刻', () => {
  const clock = installClock(T0);
  try {
    const store = makeStore({
      todos: [makeTodo({ id: 'A', title: '写周报', accumulatedMs: 5 * MIN })],
    });
    const push = recordingPush();
    const engine = new WorkTimerEngine(store, push);

    engine.start('A');
    clock.advance(10 * MIN);
    engine.stop('A');

    const stops = push.calls.filter((item) => item.event === 'workStop');
    assert.equal(stops.length, 1);
    assert.deepEqual(stops[0].vars, {
      task: '写周报',
      session: '10分钟',
      total: '15分钟',
      time: '09:10',
    });

    // 对早已 idle 的项重复 stop：幂等，不再推送。
    engine.stop('A');
    assert.equal(push.calls.filter((item) => item.event === 'workStop').length, 1);
  } finally {
    clock.restore();
  }
});

test('workStop：stopAll 对每条进行中的计时各推送一次', () => {
  const clock = installClock(T0);
  try {
    const store = makeStore({
      todos: [
        makeTodo({ id: 'A', title: '写周报' }),
        makeTodo({ id: 'B', title: '修 Bug' }),
      ],
    });
    const push = recordingPush();
    const engine = new WorkTimerEngine(store, push);

    engine.start('A');
    clock.advance(3 * MIN);
    engine.start('B');
    clock.advance(2 * MIN);
    const result = engine.stopAll();
    assert.equal(result.data, 2);

    const stops = push.calls.filter((item) => item.event === 'workStop');
    assert.equal(stops.length, 2, '全部停止 = 每条各一次 workStop');
    const byTask = new Map(stops.map((item) => [item.vars.task, item.vars]));
    assert.equal(byTask.get('写周报').session, '5分钟');
    assert.equal(byTask.get('修 Bug').session, '2分钟');
    assert.equal(byTask.get('写周报').time, '09:05');

    engine.stopAll(); // 没有进行中的计时 → 不推送
    assert.equal(push.calls.filter((item) => item.event === 'workStop').length, 2);
  } finally {
    clock.restore();
  }
});

test('workStop：勾选完成触发停止时推送一次，取消勾选不推送', async () => {
  resetElectronStub();
  qa.handlers.clear();
  const clock = installClock(T0);
  globalThis.__qaStoreSeed = { todos: [makeTodo({ id: 'A', title: '写周报' })] };
  try {
    const store = new StoreService();
    const push = recordingPush();
    const engine = new WorkTimerEngine(store, push);
    new IpcRegistry(store, {}, engine, {}, {}, {}).registerAll();

    engine.start('A');
    clock.advance(4 * MIN);
    await qa.handlers.get(IpcCommand.TODO_TOGGLE)({}, { id: 'A' });

    const stops = push.calls.filter((item) => item.event === 'workStop');
    assert.equal(stops.length, 1, '勾选完成必须推送一次工作结束');
    assert.equal(stops[0].vars.task, '写周报');
    assert.equal(stops[0].vars.session, '4分钟');
    assert.equal(store.getTodos()[0].completed, true);

    // 取消勾选不会再触发 stop。
    await qa.handlers.get(IpcCommand.TODO_TOGGLE)({}, { id: 'A' });
    assert.equal(push.calls.filter((item) => item.event === 'workStop').length, 1);
  } finally {
    clock.restore();
    delete globalThis.__qaStoreSeed;
  }
});

test('推送异常不影响计时：sendEvent 拒绝 / 抛错时引擎照常结算', () => {
  const clock = installClock(T0);
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    const store = makeStore({ todos: [makeTodo({ id: 'A', title: '写周报' })] });
    const engine = new WorkTimerEngine(store, {
      sendPush: async () => [],
      sendEvent: async () => {
        throw new Error('push exploded');
      },
    });
    engine.start('A');
    clock.advance(6 * MIN);
    assert.equal(engine.stop('A').ok, true);
    assert.equal(store.data.todos[0].accumulatedMs, 6 * MIN, '结算不受推送异常影响');
    assert.equal(store.data.todos[0].timingStatus, 'idle');

    // 未注入 push 时引擎行为与之前完全一致。
    const plainStore = makeStore({ todos: [makeTodo({ id: 'A' })] });
    const plainEngine = new WorkTimerEngine(plainStore);
    plainEngine.start('A');
    plainEngine.stop('A');
    assert.equal(plainStore.data.todos[0].timingStatus, 'idle');
  } finally {
    clock.restore();
    console.warn = originalWarn;
  }
});

// ===== 番茄提醒接线 =====

test('番茄提醒：工作轮 / 休息结束分别带 pomodoroWorkEnd 与 pomodoroBreakEnd 变量', () => {
  resetElectronStub();
  const clock = installClock(T0);
  try {
    const defaults = createDefaultData();
    const config = { workMinutes: 1, breakMinutes: 5, rounds: 2 };
    const store = makeStore({
      pomodoroRuntime: {
        ...defaults.pomodoroRuntime,
        config,
        totalRounds: config.rounds,
        pausedRemainingMs: config.workMinutes * MIN,
      },
    });
    const reminders = [];
    const reminder = {
      trigger(payload, settings) {
        reminders.push({ payload, settings });
        return Promise.resolve();
      },
    };
    qa.windows.length = 0;
    const engine = new PomodoroEngine(store, reminder, () => ({
      entries: [],
      totalSessionElapsedMs: 0,
    }));

    engine.start();
    clock.advance(1 * MIN);
    engine.tick();
    assert.equal(reminders[0].payload.event, 'pomodoroWorkEnd');
    assert.deepEqual(reminders[0].payload.vars, {
      breakMinutes: 5,
      workMinutes: 1,
      time: '09:01',
      round: 1,
    });

    clock.advance(5 * MIN);
    engine.tick();
    assert.equal(reminders[1].payload.event, 'pomodoroBreakEnd');
    assert.equal(reminders[1].payload.vars.round, 2, '休息结束后 {round} 是即将开始的轮次');
    assert.equal(reminders[1].payload.vars.breakMinutes, 5);
  } finally {
    clock.restore();
  }
});

test('ReminderService：带 event 走事件模板，旧载荷（无 event）仍直发 title/message', async () => {
  resetElectronStub();
  const calls = [];
  const push = {
    sendPush: async (config, title, desp) => {
      calls.push({ kind: 'push', title, desp });
      return [];
    },
    sendEvent: async (config, event, vars) => {
      calls.push({ kind: 'event', event, vars });
      return [];
    },
  };
  const settings = createDefaultData().settings;
  settings.push = { ...settings.push, serverChanKey: 'SCT-test', channels: ['serverchan'] };
  const service = new ReminderService(push);

  await service.trigger(
    { phase: 'work', title: '第 1 轮工作结束', message: '休息一下', event: 'pomodoroWorkEnd', vars: { round: 1 } },
    settings,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'event');
  assert.equal(calls[0].event, 'pomodoroWorkEnd');
  assert.deepEqual(calls[0].vars, { round: 1 });
  service.confirm();

  await service.trigger({ phase: 'break', title: '休息结束', message: '继续专注' }, settings);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].kind, 'push', '无 event 的旧载荷沿用直发文案');
  assert.equal(calls[1].title, '休息结束');
  service.confirm();
});

// ===== 配置兼容 =====

test('ensureShape：缺 events 时补默认，已有自定义事件内容不覆盖', () => {
  resetElectronStub();
  const seeded = createDefaultData();
  seeded.settings.push = {
    serverChanKey: 'SCT-keep',
    pushPlusToken: '',
    channels: ['serverchan'],
    events: {
      workStop: { enabled: false, title: '自定义标题', body: '自定义正文 {task}' },
    },
  };
  globalThis.__qaStoreSeed = { settings: seeded.settings };
  try {
    const store = new StoreService();
    const push = store.getSettings().push;
    assert.equal(push.serverChanKey, 'SCT-keep', '原凭证不丢');
    assert.deepEqual(push.channels, ['serverchan']);
    assert.deepEqual(push.events.workStop, {
      enabled: false,
      title: '自定义标题',
      body: '自定义正文 {task}',
    });
    assert.deepEqual(push.events.workStart, createDefaultPushEvents().workStart);
    assert.deepEqual(push.events.pomodoroWorkEnd, createDefaultPushEvents().pomodoroWorkEnd);
    assert.deepEqual(push.events.pomodoroBreakEnd, createDefaultPushEvents().pomodoroBreakEnd);
  } finally {
    delete globalThis.__qaStoreSeed;
  }
});

test('老配置（无 events 字段）保存回读：凭证/番茄参数不丢，事件配置补齐', () => {
  resetElectronStub();
  globalThis.__qaStoreSeed = {
    settings: {
      push: { serverChanKey: 'SCT-legacy', pushPlusToken: 'token-legacy', channels: ['serverchan', 'pushplus'] },
      pomodoro: { workMinutes: 30, breakMinutes: 10, rounds: 3 },
      autoMarkComplete: true,
      autoBackup: false,
    },
  };
  try {
    const store = new StoreService();
    const initial = store.getSettings();
    assert.deepEqual(initial.push.events, createDefaultPushEvents(), '老配置补齐默认事件模板');

    // 用户在设置里改了「工作结束」文案后保存。
    const draft = {
      ...initial,
      push: {
        ...initial.push,
        events: {
          ...initial.push.events,
          workStop: { enabled: true, title: '下班提醒', body: '{task} 已累计 {total}' },
        },
      },
    };
    store.saveSettings(draft);

    const reread = store.getSettings();
    assert.equal(reread.push.serverChanKey, 'SCT-legacy');
    assert.equal(reread.push.pushPlusToken, 'token-legacy');
    assert.deepEqual(reread.push.channels, ['serverchan', 'pushplus']);
    assert.deepEqual(reread.push.events.workStop, {
      enabled: true,
      title: '下班提醒',
      body: '{task} 已累计 {total}',
    });
    assert.deepEqual(reread.push.events.workStart, createDefaultPushEvents().workStart);
    assert.deepEqual(reread.pomodoro, { workMinutes: 30, breakMinutes: 10, rounds: 3 });
    assert.equal(reread.autoMarkComplete, true);
    assert.equal(reread.autoBackup, false);

    // 再次保存一份「没有 events 字段」的旧结构草稿：不崩、补齐默认、原凭证保留。
    store.saveSettings({
      push: { serverChanKey: 'SCT-again', pushPlusToken: '', channels: [] },
      pomodoro: reread.pomodoro,
      autoMarkComplete: false,
      autoBackup: true,
    });
    const last = store.getSettings();
    assert.equal(last.push.serverChanKey, 'SCT-again');
    assert.deepEqual(last.push.events, createDefaultPushEvents());
  } finally {
    delete globalThis.__qaStoreSeed;
  }
});
