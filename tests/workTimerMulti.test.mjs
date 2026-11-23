/**
 * 工作计时多开（并发计时）+ 新开置顶 专项回归。
 *
 * 覆盖设计文档第 10 节列出的 8 类用例：
 * 1. 两项独立暂停 / 继续互不影响；2. 并发 stop 只结算目标项；3. 新开置顶顺序；
 * 4. 勾选完成只停该项；5. 重启恢复多项（含坏条目）；6. v1 → v2 迁移不丢累计；
 * 7. stopAll 结算全部；8. 幂等边界。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetElectronStub } from './.build/electronStub.mjs';
import { IpcCommand } from './.build/ipcChannels.mjs';
import { IpcRegistry } from './.build/ipc.mjs';
import { StoreService, createDefaultData } from './.build/store.mjs';
import { WorkTimerEngine } from './.build/workTimerEngine.mjs';
import { installClock, makeRuntime, makeStore, makeTodo } from './helpers/helpers.mjs';

const MIN = 60000;
const T0 = new Date(2026, 10, 19, 9, 0, 0).getTime();
const qa = globalThis.__qaElectron;

const ids = (store) => store.data.todos.map((todo) => todo.id);
const todoById = (store, id) => store.data.todos.find((todo) => todo.id === id);
const entryIds = (store) => store.data.workTimerRuntime.timers.map((entry) => entry.todoId);

test('并发两项：暂停 A 后 A 冻结、B 继续增长；继续 A 后各自推进', () => {
  const clock = installClock(T0);
  const store = makeStore({
    todos: [makeTodo({ id: 'A' }), makeTodo({ id: 'B', title: '工作项 B' })],
  });
  const engine = new WorkTimerEngine(store);
  try {
    engine.start('A');
    clock.advance(2 * MIN);
    engine.start('B');

    // 暂停 A（B 完全不受影响）
    engine.pause('A');
    const frozen = engine.getViewState().entries.find((entry) => entry.todoId === 'A');
    assert.equal(frozen.sessionElapsedMs, 2 * MIN);
    clock.advance(3 * MIN);
    const afterPause = engine.getViewState().entries;
    const aPaused = afterPause.find((entry) => entry.todoId === 'A');
    const bRunning = afterPause.find((entry) => entry.todoId === 'B');
    assert.equal(aPaused.status, 'paused');
    assert.equal(aPaused.sessionElapsedMs, 2 * MIN, '暂停期间 A 不增长');
    assert.equal(bRunning.status, 'running');
    assert.equal(bRunning.sessionElapsedMs, 3 * MIN, 'B 正常推进');

    // 继续 A：从冻结值继续，B 的进度与新起点都不变。
    engine.resume('A');
    clock.advance(1 * MIN);
    const afterResume = engine.getViewState().entries;
    assert.equal(afterResume.find((entry) => entry.todoId === 'A').sessionElapsedMs, 3 * MIN);
    assert.equal(afterResume.find((entry) => entry.todoId === 'B').sessionElapsedMs, 4 * MIN);
    assert.equal(entryIds(store).length, 2);
  } finally {
    clock.restore();
  }
});

test('并发 stop：只结算目标项并移除该 entry，其它项继续 running', () => {
  const clock = installClock(T0);
  const store = makeStore({
    todos: [
      makeTodo({ id: 'A', accumulatedMs: 1 * MIN }),
      makeTodo({ id: 'B', title: '工作项 B' }),
    ],
  });
  const engine = new WorkTimerEngine(store);
  try {
    engine.start('A');
    clock.advance(2 * MIN);
    engine.start('B');
    clock.advance(1 * MIN);

    engine.stop('A');
    assert.equal(todoById(store, 'A').accumulatedMs, 4 * MIN, 'A 本次 3 分钟结算进 1 分钟累计');
    assert.equal(todoById(store, 'A').lastTimingAt, T0 + 3 * MIN);
    assert.equal(todoById(store, 'A').timingStatus, 'idle');
    assert.deepEqual(entryIds(store), ['B'], 'A 的 entry 被移除');
    assert.equal(todoById(store, 'B').accumulatedMs, 0, 'B 未被结算');
    assert.equal(todoById(store, 'B').lastTimingAt, null);
    assert.equal(todoById(store, 'B').timingStatus, 'running');
  } finally {
    clock.restore();
  }
});

test('新开置顶：start 依次把项移到计时区块顶部，暂停/继续不改变顺序', () => {
  const clock = installClock(T0);
  const store = makeStore({
    todos: [
      makeTodo({ id: 'A', title: '任务一' }),
      makeTodo({ id: 'B', title: '任务二' }),
      makeTodo({ id: 'C', title: '任务三' }),
    ],
  });
  const engine = new WorkTimerEngine(store);
  try {
    engine.start('A');
    assert.deepEqual(ids(store), ['A', 'B', 'C'], 'A 已在顶部，顺序不变');

    engine.start('C');
    assert.deepEqual(ids(store), ['C', 'A', 'B'], 'C 置顶，其余相对顺序不变');

    // 暂停 / 继续 / 重复 start 都不改变顺序。
    engine.pause('C');
    assert.deepEqual(ids(store), ['C', 'A', 'B']);
    engine.resume('C');
    assert.deepEqual(ids(store), ['C', 'A', 'B']);
    engine.start('C');
    assert.deepEqual(ids(store), ['C', 'A', 'B']);
    assert.equal(entryIds(store).length, 2, '重复 start 不产生第二条会话');
  } finally {
    clock.restore();
  }
});

test('勾选完成只停该项：A、B 并发计时，完成 A 后 B 仍 running', async () => {
  const clock = installClock(T0);
  resetElectronStub();
  qa.handlers.clear();
  const store = makeStore({
    todos: [makeTodo({ id: 'A' }), makeTodo({ id: 'B', title: '工作项 B' })],
  });
  const engine = new WorkTimerEngine(store);
  new IpcRegistry(store, {}, engine, {}, {}, {}).registerAll();
  try {
    engine.start('A');
    engine.start('B');
    clock.advance(5 * MIN);

    const result = await qa.handlers.get(IpcCommand.TODO_TOGGLE)({}, { id: 'A' });
    assert.equal(result.ok, true);
    assert.equal(result.data.completed, true);
    assert.deepEqual(entryIds(store), ['B'], '只剩 B 的计时');
    assert.equal(todoById(store, 'B').timingStatus, 'running');
    assert.equal(todoById(store, 'A').accumulatedMs, 5 * MIN, 'A 的用时已结算');
    assert.equal(store.data.todos.at(-1).id, 'A', '完成的 A 沉底');
  } finally {
    clock.restore();
  }
});

test('重启恢复多项：running + paused 各自按真实时间恢复，坏条目只丢自己', () => {
  const clock = installClock(T0);
  try {
    const store = makeStore({
      todos: [
        makeTodo({ id: 'A' }),
        makeTodo({ id: 'B', title: '工作项 B' }),
        makeTodo({ id: 'C', title: '工作项 C' }),
      ],
      workTimerRuntime: makeRuntime([
        { todoId: 'A', status: 'running', startedAt: T0 - 10 * MIN, accumulatedBeforePauseMs: 5 * MIN },
        { todoId: 'B', status: 'paused', accumulatedBeforePauseMs: 7 * MIN, pauseStartedAt: T0 - 30 * MIN },
        { todoId: '已删除', status: 'running', startedAt: T0 - MIN },
      ]),
    });
    const engine = new WorkTimerEngine(store);
    engine.restore(store.getAppData().workTimerRuntime);

    assert.deepEqual(entryIds(store), ['A', 'B'], '悬空条目被丢弃，其余保留');
    const entries = engine.getViewState().entries;
    assert.equal(entries[0].sessionElapsedMs, 15 * MIN, 'running：10 分钟真实经过 + 5 分钟暂停前累计');
    assert.equal(entries[1].sessionElapsedMs, 7 * MIN, 'paused：只取暂停前累计');
    assert.equal(entries[1].status, 'paused');
    assert.equal(todoById(store, 'C').timingStatus, 'idle');
    assert.equal(engine.getViewState().totalSessionElapsedMs, 22 * MIN);

    // 幂等：重复 restore 不会重置已恢复的时间。
    clock.advance(1 * MIN);
    engine.restore(store.getAppData().workTimerRuntime);
    assert.equal(engine.getViewState().entries[0].sessionElapsedMs, 16 * MIN);
  } finally {
    clock.restore();
  }
});

test('v1 → v2 迁移不丢累计：running 用真实经过时间，paused 取暂停前累计', () => {
  const clock = installClock(T0);
  try {
    // running：v1 单条 → 1 条 entry，5 分钟暂停前累计 + 10 分钟真实经过 = 15 分钟。
    resetElectronStub();
    globalThis.__qaStoreSeed = {
      todos: [makeTodo({ id: 'A' })],
      workTimerRuntime: {
        activeTimerId: 'A',
        status: 'running',
        startedAt: T0 - 10 * MIN,
        accumulatedBeforePauseMs: 5 * MIN,
        pauseStartedAt: null,
      },
    };
    const runningStore = new StoreService();
    const runningEngine = new WorkTimerEngine(runningStore);
    assert.equal(runningStore.getAppData().workTimerRuntime.timers.length, 1, 'ensureShape 完成 v1→v2');
    runningEngine.restore(runningStore.getAppData().workTimerRuntime);
    assert.equal(runningEngine.getViewState().entries[0].sessionElapsedMs, 15 * MIN);
    assert.equal(runningStore.getTodos()[0].timingStatus, 'running');

    // paused：开始时刻已不可用，只能用暂停前累计，暂停的 30 分钟不计入。
    resetElectronStub();
    globalThis.__qaStoreSeed = {
      todos: [makeTodo({ id: 'A' })],
      workTimerRuntime: {
        activeTimerId: 'A',
        status: 'paused',
        startedAt: null,
        accumulatedBeforePauseMs: 9 * MIN,
        pauseStartedAt: T0 - 30 * MIN,
      },
    };
    const pausedStore = new StoreService();
    const pausedEngine = new WorkTimerEngine(pausedStore);
    assert.equal(pausedStore.getAppData().workTimerRuntime.timers.length, 1);
    pausedEngine.restore(pausedStore.getAppData().workTimerRuntime);
    assert.equal(pausedEngine.getViewState().entries[0].sessionElapsedMs, 9 * MIN);
    assert.equal(pausedStore.getTodos()[0].timingStatus, 'paused');
  } finally {
    delete globalThis.__qaStoreSeed;
    clock.restore();
  }
});

test('迁移：v1 idle / 空 activeTimerId 归一化为空 timers，不产生假计时', () => {
  resetElectronStub();
  try {
    globalThis.__qaStoreSeed = {
      todos: [makeTodo({ id: 'A' })],
      workTimerRuntime: {
        activeTimerId: null,
        status: 'idle',
        startedAt: null,
        accumulatedBeforePauseMs: 0,
        pauseStartedAt: null,
      },
    };
    const store = new StoreService();
    assert.deepEqual(store.getAppData().workTimerRuntime, { timers: [] });
  } finally {
    delete globalThis.__qaStoreSeed;
  }
});

test('stopAll：全部结算、timers 清空、返回条数正确，重复调用返回 0', async () => {
  const clock = installClock(T0);
  resetElectronStub();
  qa.handlers.clear();
  const store = makeStore({
    todos: [
      makeTodo({ id: 'A', accumulatedMs: 1 * MIN }),
      makeTodo({ id: 'B', title: '工作项 B' }),
      makeTodo({ id: 'C', title: '工作项 C' }),
    ],
  });
  const engine = new WorkTimerEngine(store);
  new IpcRegistry(store, {}, engine, {}, {}, {}).registerAll();
  try {
    engine.start('A');
    clock.advance(2 * MIN);
    engine.start('B');
    clock.advance(1 * MIN);

    const result = await qa.handlers.get(IpcCommand.WORK_STOP_ALL)({}, undefined);
    assert.equal(result.ok, true);
    assert.equal(result.data, 2, '返回结算条数');
    assert.deepEqual(store.data.workTimerRuntime, { timers: [] });
    assert.equal(todoById(store, 'A').accumulatedMs, 4 * MIN);
    assert.equal(todoById(store, 'B').accumulatedMs, 1 * MIN);
    assert.equal(todoById(store, 'C').accumulatedMs, 0);
    for (const id of ['A', 'B', 'C']) {
      assert.equal(todoById(store, id).timingStatus, 'idle');
    }
    assert.equal(todoById(store, 'A').lastTimingAt, T0 + 3 * MIN);
    assert.equal(todoById(store, 'B').lastTimingAt, T0 + 3 * MIN);

    const again = await qa.handlers.get(IpcCommand.WORK_STOP_ALL)({}, undefined);
    assert.equal(again.ok, true);
    assert.equal(again.data, 0, '本来没有计时时返回 0');
  } finally {
    clock.restore();
  }
});

test('边界：非法载荷拒绝、幂等操作 ok、已完成项不可计时', async () => {
  const clock = installClock(T0);
  resetElectronStub();
  qa.handlers.clear();
  const store = makeStore({
    todos: [makeTodo({ id: 'A' }), makeTodo({ id: 'B', title: '已完成', completed: true, completedAt: T0 })],
  });
  const engine = new WorkTimerEngine(store);
  new IpcRegistry(store, {}, engine, {}, {}, {}).registerAll();
  const invoke = (channel, payload) => qa.handlers.get(channel)({}, payload);
  try {
    for (const channel of [
      IpcCommand.WORK_START,
      IpcCommand.WORK_PAUSE,
      IpcCommand.WORK_RESUME,
      IpcCommand.WORK_STOP,
    ]) {
      const result = await invoke(channel, {});
      assert.equal(result.ok, false, `${channel} 缺 todoId 必须拒绝`);
      assert.match(result.message, /参数不完整/);
    }

    // 幂等：idle 项 pause/resume/stop、不存在 todoId 的 pause 均成功且无副作用。
    for (const [channel, todoId] of [
      [IpcCommand.WORK_PAUSE, 'A'],
      [IpcCommand.WORK_RESUME, 'A'],
      [IpcCommand.WORK_STOP, 'A'],
      [IpcCommand.WORK_PAUSE, '不存在'],
    ]) {
      const result = await invoke(channel, { todoId });
      assert.equal(result.ok, true, `${channel}(${todoId}) 应幂等成功`);
    }
    assert.deepEqual(store.data.workTimerRuntime, { timers: [] });

    // 已完成项不可开始计时。
    const completed = await invoke(IpcCommand.WORK_START, { todoId: 'B' });
    assert.equal(completed.ok, false);
    assert.match(completed.message, /已完成的工作项不可计时/);

    // 不存在的工作项：ok:false 且给出明确文案。
    const missing = await invoke(IpcCommand.WORK_START, { todoId: '不存在' });
    assert.equal(missing.ok, false);
    assert.match(missing.message, /工作项不存在/);

    // 同一项重复 start：幂等成功，不产生第二条 entry。
    assert.equal((await invoke(IpcCommand.WORK_START, { todoId: 'A' })).ok, true);
    const duplicate = await invoke(IpcCommand.WORK_START, { todoId: 'A' });
    assert.equal(duplicate.ok, true);
    assert.match(duplicate.message, /正在计时中/);
    assert.equal(store.data.workTimerRuntime.timers.length, 1);
  } finally {
    clock.restore();
  }
});

test('数据导入：旧备份（v1 运行态）经 replaceAppData + restore 后仍按真实时间恢复', async () => {
  const clock = installClock(T0);
  resetElectronStub();
  qa.handlers.clear();
  const store = new StoreService();
  const engine = new WorkTimerEngine(store);
  // 番茄钟引擎用最小桩：导入会同时恢复两侧运行态。
  new IpcRegistry(store, { restore: () => undefined }, engine, {}, {}, {}).registerAll();
  try {
    const backup = createDefaultData();
    backup.todos = [makeTodo({ id: 'A' })];
    // 旧版本导出的备份仍是 v1 单计时结构。
    backup.workTimerRuntime = {
      activeTimerId: 'A',
      status: 'running',
      startedAt: T0 - 6 * MIN,
      accumulatedBeforePauseMs: 4 * MIN,
      pauseStartedAt: null,
    };

    const imported = await qa.handlers.get(IpcCommand.DATA_IMPORT)({}, { data: backup });
    assert.equal(imported.ok, true);
    assert.equal(
      store.getAppData().workTimerRuntime.timers.length,
      1,
      '导入后运行态已迁移为 v2',
    );
    assert.equal(engine.getViewState().entries[0].sessionElapsedMs, 10 * MIN);
    assert.equal(store.getTodos()[0].timingStatus, 'running');
  } finally {
    clock.restore();
  }
});
