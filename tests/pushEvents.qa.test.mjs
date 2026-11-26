/**
 * v1.0.4 事件推送 —— QA 独立回归（与 tests/pushEvents.test.mjs 无重复断言）。
 *
 * 关注点：
 * - 模板注入安全：变量值含 `$&` / `$1` / `$$` / `{task}` / 换行 / 中文标点 / 原型属性名时不得被二次替换；
 * - 渲染函数复用同一全局正则不得残留 lastIndex；
 * - PushService.sendEvent 的「禁发矩阵」与「渲染后再判空标题」；
 * - 工作计时 workStart 边界（resume / 重复 start / stopAll 后再 start）与 workStop 变量口径；
 * - stopAll 两路计时各一次、不重复；
 * - 推送 reject / 同步抛错时计时数据与返回值不受影响，且不产生 unhandledRejection；
 * - 同步性证明：start/stop 返回时推送 Promise 仍处于 pending（未 await 网络）；
 * - 老配置迁移：ensureShape 补默认 → saveSettings 落盘 → 模拟重启回读不丢用户模板。
 *
 * 全部推送均走 mock 或 stubFetch，绝不发起真实网络请求。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultPushEvents,
  normalizePushEvents,
  renderPushTemplate,
} from './.build/pushTemplate.mjs';
import { PushService } from './.build/pushService.mjs';
import { ReminderService } from './.build/reminderService.mjs';
import { WorkTimerEngine } from './.build/workTimerEngine.mjs';
import { StoreService, createDefaultData } from './.build/store.mjs';
import { IpcRegistry } from './.build/ipc.mjs';
import { IpcCommand } from './.build/ipcChannels.mjs';
import { resetElectronStub } from './.build/electronStub.mjs';
import { installClock, makeStore, makeTodo } from './helpers/helpers.mjs';

const MIN = 60000;
const T0 = new Date(2026, 10, 19, 9, 0, 0).getTime();

/** 记录事件推送调用（纯内存 mock）。 */
function recordingPush() {
  const calls = [];
  return {
    calls,
    sendPush: async (_config, title, desp) => {
      calls.push({ kind: 'push', title, desp });
      return [];
    },
    async sendEvent(_config, event, vars) {
      calls.push({ kind: 'event', event, vars });
      return [];
    },
  };
}

/** 只计数、可断言请求体的 fetch 替身。 */
function stubFetch(handler) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return handler(url, init);
  };
  return {
    requests,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const jsonResponse = (body, ok = true) => ({ ok, json: async () => body });

/** 基础推送配置；events 已含 4 类默认事件。 */
function basePushConfig(overrides = {}) {
  const base = createDefaultData().settings.push;
  return { ...base, serverChanKey: 'SCT-qa', channels: ['serverchan'], ...overrides };
}

// ===== a. 模板注入 / 特殊字符 =====

test('a-1 模板注入：变量值含 $& / $1 / $$ 时原样输出，不触发 replace 的替换模式', () => {
  // 若实现使用字符串替换模式，值里的 `$&` 会被替换成「匹配到的占位符本身」。
  const rendered = renderPushTemplate('前缀[{task}]后缀', { task: '$& $1 $$ $` $\'' });
  assert.equal(rendered, "前缀[$& $1 $$ $` $']后缀");
  assert.equal(rendered.includes('{task}'), false, '值里的 $& 不得把 {task} 复活');
});

test('a-2 模板注入：变量值里再含 {task} 时不会被二次展开', () => {
  assert.equal(
    renderPushTemplate('{task}|{note}', { task: '写周报', note: '{task} 未替换' }),
    '写周报|{task} 未替换',
  );
  // 全角花括号与中文标点不是占位符语法，必须原样保留。
  assert.equal(
    renderPushTemplate('｛task｝、中文标点：，。！？', { task: 'A' }),
    '｛task｝、中文标点：，。！？',
  );
});

test('a-3 模板注入：换行与制表符在变量值中保留，未知变量原样残留', () => {
  const out = renderPushTemplate('「{task}」\n{session}\t{oops}', {
    task: '第一行\n第二行',
    session: '3分钟',
  });
  assert.equal(out, '「第一行\n第二行」\n3分钟\t{oops}');
});

test('a-4 原型链属性名（toString / constructor / __proto__）视为未知变量，原样保留', () => {
  assert.equal(
    renderPushTemplate('[{toString}][{constructor}][{__proto__}][{hasOwnProperty}]', {}),
    '[{toString}][{constructor}][{__proto__}][{hasOwnProperty}]',
  );
});

test('a-5 同一全局正则被反复调用不残留 lastIndex，重复占位符全部替换', () => {
  assert.deepEqual(
    [
      renderPushTemplate('{a}{a}{a}', { a: '1' }),
      renderPushTemplate('{a}', { a: '2' }),
      renderPushTemplate('{a}{a}', { a: '3' }),
    ],
    ['111', '2', '33'],
  );
});

test('a-6 端到端：特殊字符经 sendEvent 渲染 + 渠道编码后仍正确，未知变量原样进请求体', async () => {
  const ctx = stubFetch(async () => jsonResponse({ code: 0 }));
  try {
    const config = basePushConfig({
      events: {
        ...createDefaultPushEvents(),
        workStop: {
          enabled: true,
          title: '结束 $& {task}',
          body: '正文 {session}\n保留 {typo} 与 100% 符号',
        },
      },
    });
    const results = await new PushService().sendEvent(config, 'workStop', {
      task: 'A$&B',
      session: '3分钟',
    });
    assert.deepEqual(results.map((item) => item.ok), [true]);
    assert.equal(ctx.requests.length, 1);
    const sent = new URLSearchParams(ctx.requests[0].init.body);
    assert.equal(sent.get('title'), '结束 $& A$&B');
    assert.equal(sent.get('desp'), '正文 3分钟\n保留 {typo} 与 100% 符号');
  } finally {
    ctx.restore();
  }
});

// ===== e. 禁发矩阵（fetch 计数）=====

test('e-1 禁发矩阵：事件禁用 / 事件缺失 / 无渠道 / 无凭证 → fetch 0 次；完整配置 → 1 次', async () => {
  const ctx = stubFetch(async () => jsonResponse({ code: 0 }));
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    const service = new PushService();

    // 1) 事件禁用
    const disabled = basePushConfig({
      events: { ...createDefaultPushEvents(), workStop: { enabled: false, title: 't', body: 'b' } },
    });
    assert.deepEqual(await service.sendEvent(disabled, 'workStop', {}), []);
    assert.equal(ctx.requests.length, 0, '事件禁用不得产生网络请求');

    // 2) 事件缺失（老配置未补全）
    const partial = basePushConfig({
      events: { workStart: createDefaultPushEvents().workStart },
    });
    assert.deepEqual(await service.sendEvent(partial, 'workStop', {}), []);
    assert.equal(ctx.requests.length, 0, '缺失该事件不得产生网络请求');

    // 3) 已启用但没有任何渠道
    const noChannel = basePushConfig({ channels: [] });
    assert.deepEqual(await service.sendEvent(noChannel, 'workStop', {}), []);
    assert.equal(ctx.requests.length, 0, '没有渠道不得产生网络请求');

    // 4) 已启用且勾选渠道，但凭证为空 → 不发请求，返回 ok:false 结果
    const noCredential = basePushConfig({ serverChanKey: '' });
    const skipped = await service.sendEvent(noCredential, 'workStop', {});
    assert.equal(ctx.requests.length, 0, '凭证为空不得产生网络请求');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].ok, false);

    // 5) 正向对照：启用 + 有凭证 → 恰好 1 次
    const okConfig = basePushConfig();
    const sent = await service.sendEvent(okConfig, 'workStop', { task: 'A' });
    assert.equal(ctx.requests.length, 1);
    assert.deepEqual(sent.map((item) => item.ok), [true]);
  } finally {
    console.warn = originalWarn;
    ctx.restore();
  }
});

test('e-2 用户清空 body 时只发标题：正文为空串，不被默认模板复活', async () => {
  const ctx = stubFetch(async () => jsonResponse({ code: 0 }));
  try {
    // normalizePushEvents 必须保留空串（而不是回退默认正文）。
    const events = normalizePushEvents({
      workStop: { enabled: true, title: '只看标题', body: '' },
    });
    assert.equal(events.workStop.body, '');

    await new PushService().sendEvent(basePushConfig({ events }), 'workStop', { task: 'A' });
    const sent = new URLSearchParams(ctx.requests[0].init.body);
    assert.equal(sent.get('title'), '只看标题');
    assert.equal(sent.get('desp'), '', '清空正文 = 只发标题，不得回落默认文案');
  } finally {
    ctx.restore();
  }
});

test('e-3 标题渲染后为空才退化：纯空变量标题 → 事件中文名', async () => {
  const ctx = stubFetch(async () => jsonResponse({ code: 0 }));
  try {
    const config = basePushConfig({
      events: {
        ...createDefaultPushEvents(),
        workStart: { enabled: true, title: '{task}', body: 'body' },
      },
    });
    // task 为空串 → 渲染后标题为 '' → 退化（证明判空发生在渲染之后）
    await new PushService().sendEvent(config, 'workStart', { task: '' });
    assert.equal(new URLSearchParams(ctx.requests[0].init.body).get('title'), '工作开始');

    // 未知变量保留下来（渲染结果非空）→ 不退化为中文名
    await new PushService().sendEvent(config, 'workStart', {});
    assert.equal(new URLSearchParams(ctx.requests[1].init.body).get('title'), '{task}');
  } finally {
    ctx.restore();
  }
});

// ===== b. workStart 边界 =====

test('b-1 workStart 边界：idle→running 首发；resume / 重复 start / 已完成项均不发；stopAll 后再 start 再发一次', () => {
  const clock = installClock(T0);
  try {
    const store = makeStore({
      todos: [makeTodo({ id: 'A', title: '写周报' }), makeTodo({ id: 'D', title: '已完结', completed: true })],
    });
    const push = recordingPush();
    const engine = new WorkTimerEngine(store, push);
    const starts = () => push.calls.filter((item) => item.event === 'workStart');

    engine.start('A');
    assert.equal(starts().length, 1, 'idle→running 必须发一次');

    // 暂停后两种「继续」路径（start 内部 resume 分支 / 显式 resume）都不得再发。
    clock.advance(2 * MIN);
    engine.pause('A');
    engine.start('A');
    assert.equal(starts().length, 1, 'paused 经 start 继续不得发');
    engine.pause('A');
    engine.resume('A');
    assert.equal(starts().length, 1, '显式 resume 不得发');

    // 已在运行时的重复 start 是幂等空操作。
    engine.start('A');
    assert.equal(starts().length, 1, '重复 start 不得发');

    // 已完成工作项：拒绝计时，也不发推送。
    assert.equal(engine.start('D').ok, false);
    assert.equal(starts().length, 1);

    // 停止后再开始：属于新会话，必须再发一次。
    engine.stop('A');
    engine.start('A');
    assert.equal(starts().length, 2, 'stop → start 属于新会话，应再发一次');

    // 全部停止后再开始：同样属于新会话。
    engine.stopAll();
    engine.start('A');
    assert.equal(starts().length, 3, 'stopAll → start 应再发一次');
  } finally {
    clock.restore();
  }
});

// ===== c. workStop 变量准确性 =====

test('c-1 workStop 变量：本次 3 分钟 + 历史 9 分钟 = 累计 12 分钟，time 为结束时刻', () => {
  const clock = installClock(T0);
  try {
    const store = makeStore({
      todos: [makeTodo({ id: 'A', title: '写周报', accumulatedMs: 9 * MIN })],
    });
    const push = recordingPush();
    const engine = new WorkTimerEngine(store, push);

    engine.start('A'); // 09:00
    clock.advance(3 * MIN); // 09:03
    engine.stop('A');

    const stops = push.calls.filter((item) => item.event === 'workStop');
    assert.equal(stops.length, 1);
    assert.deepEqual(stops[0].vars, {
      task: '写周报',
      session: '3分钟',
      total: '12分钟',
      time: '09:03',
    });
    assert.equal(store.data.todos[0].accumulatedMs, 12 * MIN, '累计写回 = 9 + 3 分钟');
    assert.equal(store.data.todos[0].timingStatus, 'idle');
  } finally {
    clock.restore();
  }
});

// ===== d. stopAll 去重 =====

test('d-1 两个计时项 stopAll：每个任务各 1 次 workStop（共 2 次），后续 stop/stopAll 不叠加', () => {
  const clock = installClock(T0);
  try {
    const store = makeStore({
      todos: [
        makeTodo({ id: 'A', title: '写周报' }),
        makeTodo({ id: 'B', title: '修 Bug' }),
        makeTodo({ id: 'C', title: '未计时' }),
      ],
    });
    const push = recordingPush();
    const engine = new WorkTimerEngine(store, push);

    engine.start('A');
    clock.advance(3 * MIN);
    engine.start('B');
    clock.advance(2 * MIN);

    assert.equal(engine.stopAll().data, 2);
    const stops = push.calls.filter((item) => item.event === 'workStop');
    assert.equal(stops.length, 2, '两个计时项 → 共 2 次 workStop');
    const counts = stops.reduce((map, item) => map.set(item.vars.task, (map.get(item.vars.task) ?? 0) + 1), new Map());
    assert.equal(counts.get('写周报'), 1, '每个任务只能收到 1 次');
    assert.equal(counts.get('修 Bug'), 1, '每个任务只能收到 1 次');
    assert.equal(counts.has('未计时'), false, '没有计时的任务不得收到 workStop');

    // 幂等复入：不得重复推送。
    engine.stopAll();
    engine.stop('A');
    engine.stop('B');
    assert.equal(push.calls.filter((item) => item.event === 'workStop').length, 2);
    assert.equal(push.calls.filter((item) => item.event === 'workStart').length, 2, '每项各一次 workStart');
  } finally {
    clock.restore();
  }
});

// ===== f. 推送异常隔离 + 同步性 =====

test('f-1 推送 reject / 同步抛错：start/stop 返回值与计时数据不受影响，且无 unhandledRejection', async () => {
  const clock = installClock(T0);
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  const originalWarn = console.warn;
  process.on('unhandledRejection', onUnhandled);
  console.warn = () => undefined;
  try {
    // 1) sendEvent 返回 rejected Promise
    const store = makeStore({ todos: [makeTodo({ id: 'A', title: '写周报' })] });
    const engine = new WorkTimerEngine(store, {
      sendPush: async () => [],
      sendEvent: () => Promise.reject(new Error('network exploded')),
    });
    assert.deepEqual(engine.start('A'), { ok: true, message: '已开始计时' });
    clock.advance(6 * MIN);
    assert.deepEqual(engine.stop('A'), { ok: true });
    assert.equal(store.data.todos[0].accumulatedMs, 6 * MIN, '结算数据不受推送异常影响');
    assert.equal(store.data.todos[0].timingStatus, 'idle');

    // 2) sendEvent 同步抛错
    const store2 = makeStore({ todos: [makeTodo({ id: 'B', title: '修 Bug' })] });
    const engine2 = new WorkTimerEngine(store2, {
      sendPush: async () => [],
      sendEvent: () => {
        throw new Error('sync blow up');
      },
    });
    assert.equal(engine2.start('B').ok, true);
    clock.advance(2 * MIN);
    assert.equal(engine2.stop('B').ok, true);
    assert.equal(store2.data.todos[0].accumulatedMs, 2 * MIN);

    // 3) 未注入 / 无 sendEvent 的旧桩：行为与纯计时一致
    const store3 = makeStore({ todos: [makeTodo({ id: 'C', title: '旧桩' })] });
    const engine3 = new WorkTimerEngine(store3, { sendPush: async () => [] });
    engine3.start('C');
    engine3.stop('C');
    assert.equal(store3.data.todos[0].timingStatus, 'idle');

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], '推送 reject 必须被引擎吞掉，不得逃逸成 unhandledRejection');
  } finally {
    console.warn = originalWarn;
    process.off('unhandledRejection', onUnhandled);
    clock.restore();
  }
});

test('f-2 同步性证明：start/stop 返回时推送 Promise 仍 pending（不等网络）', async () => {
  const clock = installClock(T0);
  try {
    const pending = [];
    const store = makeStore({ todos: [makeTodo({ id: 'A', title: '写周报' })] });
    const engine = new WorkTimerEngine(store, {
      sendPush: async () => [],
      sendEvent: () => {
        let settle;
        const promise = new Promise((resolve, reject) => {
          settle = { resolve, reject };
        });
        pending.push(settle);
        return promise;
      },
    });

    engine.start('A');
    assert.equal(pending.length, 1, '推送已发起（同步调用）');
    assert.equal(store.data.workTimerRuntime.timers[0].status, 'running', 'start 返回时计时已生效');

    clock.advance(4 * MIN);
    engine.stop('A');
    assert.equal(pending.length, 2, 'stop 也发起推送');
    assert.equal(store.data.workTimerRuntime.timers.length, 0, 'stop 返回时运行态已清空（未等待推送）');
    assert.equal(store.data.todos[0].accumulatedMs, 4 * MIN, '结算已完成');
    assert.equal(pending[1].resolve !== undefined, true);

    // 收尾：让挂起的 Promise 落地，确认不会二次回调 / 抛错。
    pending.forEach((settle) => settle.resolve([]));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.data.todos[0].accumulatedMs, 4 * MIN, '推送落地后数据不再变化');
  } finally {
    clock.restore();
  }
});

// ===== g. 老配置迁移（真实 StoreService）=====

test('g-1 老配置（无 events）→ ensureShape 补默认 → saveSettings 落盘 → 模拟重启回读不丢自定义模板', () => {
  resetElectronStub();
  // 模拟 v1.0.3 的持久化文件：settings.push 完全没有 events 字段。
  globalThis.__qaStoreSeed = {
    settings: {
      push: { serverChanKey: 'SCT-legacy', pushPlusToken: '', channels: ['serverchan'] },
      pomodoro: { workMinutes: 30, breakMinutes: 10, rounds: 3 },
      autoMarkComplete: true,
      autoBackup: false,
    },
  };
  try {
    const store = new StoreService();
    const initial = store.getSettings();
    assert.deepEqual(initial.push.events, createDefaultPushEvents(), 'ensureShape 补齐 4 类默认模板');
    assert.equal(initial.push.serverChanKey, 'SCT-legacy', '老凭证保留');

    // 用户编辑「番茄-工作轮结束」与「工作结束」并保存。
    const custom = {
      ...initial.push.events,
      workStop: { enabled: false, title: '下班 {task}', body: '本次 {session}，累计 {total}' },
      pomodoroWorkEnd: { enabled: true, title: '第 {round} 轮完成', body: '休息 {breakMinutes} 分钟' },
    };
    store.saveSettings({ ...initial, push: { ...initial.push, events: custom } });

    // 直接看「磁盘」上的持久化快照（私有字段在 JS 运行时就是普通属性）。
    const persisted = JSON.parse(JSON.stringify(store.store.store));
    assert.deepEqual(persisted.settings.push.events.workStop, custom.workStop);
    assert.equal(persisted.settings.push.serverChanKey, 'SCT-legacy');

    // 模拟重启：用持久化快照重新构造 StoreService，再走一遍 ensureShape。
    resetElectronStub();
    globalThis.__qaStoreSeed = persisted;
    const restarted = new StoreService();
    const reread = restarted.getSettings();
    assert.deepEqual(reread.push.events.workStop, custom.workStop, '自定义模板重启后仍在');
    assert.deepEqual(reread.push.events.pomodoroWorkEnd, custom.pomodoroWorkEnd);
    assert.equal(reread.push.events.workStop.enabled, false, '用户关掉的开关不得被默认值翻回 true');
    assert.deepEqual(reread.push.events.workStart, createDefaultPushEvents().workStart, '未填事件仍是默认');
    assert.deepEqual(reread.pomodoro, { workMinutes: 30, breakMinutes: 10, rounds: 3 });
    assert.equal(reread.autoMarkComplete, true);
    assert.equal(reread.autoBackup, false);
  } finally {
    delete globalThis.__qaStoreSeed;
  }
});

test('g-2 saveSettings 第二条写入路径：events 传空对象 / 缺字段时逐字段补默认且不覆盖已填内容', () => {
  resetElectronStub();
  try {
    const store = new StoreService();
    const base = store.getSettings();

    // 空对象 → 4 类事件全部补默认
    store.saveSettings({ ...base, push: { ...base.push, events: {} } });
    assert.deepEqual(store.getSettings().push.events, createDefaultPushEvents());

    // 只有部分字段 → 缺的字段补默认，已填的保留（含空串）
    store.saveSettings({
      ...base,
      push: {
        ...base.push,
        events: {
          pomodoroBreakEnd: { title: '休息结束啦', body: '' },
        },
      },
    });
    const events = store.getSettings().push.events;
    assert.deepEqual(events.pomodoroBreakEnd, {
      enabled: createDefaultPushEvents().pomodoroBreakEnd.enabled,
      title: '休息结束啦',
      body: '',
    });
    assert.deepEqual(events.workStart, createDefaultPushEvents().workStart);

    // 完全不给 events（旧渲染层草稿）→ 补齐默认，不抛错
    store.saveSettings({
      push: { serverChanKey: 'SCT-x', pushPlusToken: '', channels: [] },
      pomodoro: base.pomodoro,
      autoMarkComplete: false,
      autoBackup: true,
    });
    assert.deepEqual(store.getSettings().push.events, createDefaultPushEvents());
    assert.equal(store.getSettings().push.serverChanKey, 'SCT-x');
  } finally {
    delete globalThis.__qaStoreSeed;
  }
});

// ===== 设置落盘链路（绕过 React，验证 IPC → store 全链路）=====

test('g-3 IPC SETTINGS_SAVE 全链路：草稿里的 4 类事件原样落盘，缺 events 的旧草稿补齐默认', async () => {
  resetElectronStub();
  const qa = globalThis.__qaElectron;
  try {
    const store = new StoreService();
    const workTimer = new WorkTimerEngine(store);
    new IpcRegistry(
      store,
      { getViewState: () => ({ status: 'idle' }), updateConfig: () => undefined },
      workTimer,
      {},
      { sendTest: async () => [] },
      {},
      {},
    ).registerAll();
    const save = qa.handlers.get(IpcCommand.SETTINGS_SAVE);

    const base = store.getSettings();
    const draft = {
      ...base,
      push: {
        ...base.push,
        serverChanKey: 'SCT-ui',
        channels: ['serverchan'],
        events: {
          ...base.push.events,
          workStart: { enabled: true, title: '开工：{task}', body: '开始于 {time}' },
          workStop: { enabled: false, title: '收工：{task}', body: '' },
        },
      },
      autoMarkComplete: true,
    };
    const saved = await save({}, { settings: draft });
    assert.equal(saved.ok, true);

    const stored = store.getSettings();
    assert.deepEqual(stored.push.events.workStart, { enabled: true, title: '开工：{task}', body: '开始于 {time}' });
    assert.deepEqual(stored.push.events.workStop, { enabled: false, title: '收工：{task}', body: '' });
    assert.deepEqual(stored.push.events.pomodoroWorkEnd, createDefaultPushEvents().pomodoroWorkEnd);
    assert.equal(stored.push.serverChanKey, 'SCT-ui');
    assert.equal(stored.autoMarkComplete, true);

    // 旧渲染层草稿（完全没有 events 字段）走同一入口：不报错且补齐默认。
    const legacy = { ...stored, push: { serverChanKey: 'SCT-old-ui', pushPlusToken: '', channels: [] } };
    assert.equal((await save({}, { settings: legacy })).ok, true);
    assert.deepEqual(store.getSettings().push.events, createDefaultPushEvents());
    assert.equal(store.getSettings().push.serverChanKey, 'SCT-old-ui');

    // events 传入非对象脏数据：不抛错，逐字段回落默认值。
    const dirty = { ...stored, push: { ...stored.push, events: 'not-an-object' } };
    assert.equal((await save({}, { settings: dirty })).ok, true);
    assert.deepEqual(store.getSettings().push.events, createDefaultPushEvents());
  } finally {
    delete globalThis.__qaStoreSeed;
  }
});

test('g-4 测试推送不套事件模板：事件全部禁用时仍按通道发送固定测试文案', async () => {
  resetElectronStub();
  const ctx = stubFetch(async () => jsonResponse({ code: 0 }));
  const qa = globalThis.__qaElectron;
  try {
    const store = new StoreService();
    const allOff = Object.fromEntries(
      Object.entries(createDefaultPushEvents()).map(([key, value]) => [key, { ...value, enabled: false }]),
    );
    const push = new PushService();
    new IpcRegistry(
      store,
      { getViewState: () => ({ status: 'idle' }), updateConfig: () => undefined },
      new WorkTimerEngine(store),
      {},
      push,
      {},
      {},
    ).registerAll();

    const draft = {
      ...store.getSettings(),
      push: { ...store.getSettings().push, serverChanKey: 'SCT-t', channels: ['serverchan'], events: allOff },
    };
    const result = await qa.handlers.get(IpcCommand.SETTINGS_TEST_PUSH)({}, { settings: draft });
    assert.equal(result.ok, true);
    assert.equal(ctx.requests.length, 1, '测试推送应真的发一次请求');
    const sent = new URLSearchParams(ctx.requests[0].init.body);
    assert.equal(sent.get('title'), 'Schedule Flow 测试推送', '不得套用任何事件模板');
    assert.equal(sent.get('desp').includes('测试推送仅验证通道'), true);
  } finally {
    ctx.restore();
  }
});

// ===== 提醒接线兜底（独立于工程师用例的分支）=====

test('提醒兜底：payload 带 event 但 push 桩没有 sendEvent 时退回 sendPush', async () => {
  resetElectronStub();
  const calls = [];
  const push = {
    sendPush: async (_config, title, desp) => {
      calls.push({ kind: 'push', title, desp });
      return [];
    },
  };
  const settings = createDefaultData().settings;
  settings.push = { ...settings.push, serverChanKey: 'SCT-test', channels: ['serverchan'] };
  const service = new ReminderService(push);

  await service.trigger(
    { phase: 'work', title: '第 1 轮结束', message: '休息一下', event: 'pomodoroWorkEnd', vars: { round: 1 } },
    settings,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'push', '桩无 sendEvent 时必须退回直发，不能静默丢推送');
  assert.equal(calls[0].title, '第 1 轮结束');
  service.confirm();
});
