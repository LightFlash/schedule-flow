import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkTimerEngine } from './.build/workTimerEngine.mjs';
import { IpcRegistry } from './.build/ipc.mjs';
import { IpcCommand } from './.build/ipcChannels.mjs';
import { createDefaultData, installClock, makeRuntime, makeStore, makeTodo } from './helpers/helpers.mjs';

const MIN = 60000;
const T0 = new Date(2026, 10, 19, 9, 0, 0).getTime();
const qa = globalThis.__qaElectron;

test('多轮暂停/继续无漂移，停止时正确累加并写入 lastTimingAt', () => {
  const clock = installClock(T0);
  const store = makeStore({ todos: [makeTodo({ id: 'A', accumulatedMs: 2 * MIN })] });
  const engine = new WorkTimerEngine(store);
  try {
    assert.equal(engine.start('A').ok, true);
    assert.deepEqual(store.data.workTimerRuntime.timers, [
      {
        todoId: 'A',
        status: 'running',
        startedAt: T0,
        accumulatedBeforePauseMs: 0,
        pauseStartedAt: null,
      },
    ]);
    assert.equal(store.data.todos[0].timingStatus, 'running');

    clock.advance(10 * MIN);
    assert.equal(engine.pause('A').ok, true);
    const paused = store.data.workTimerRuntime.timers[0];
    assert.equal(paused.status, 'paused');
    assert.equal(paused.accumulatedBeforePauseMs, 10 * MIN);
    assert.equal(paused.startedAt, null);
    assert.equal(paused.pauseStartedAt, T0 + 10 * MIN);
    assert.equal(store.data.todos[0].timingStatus, 'paused');

    clock.advance(30 * MIN); // 暂停的 30 分钟不计入
    assert.equal(engine.getViewState().entries[0].sessionElapsedMs, 10 * MIN);
    assert.equal(engine.resume('A').ok, true);
    assert.equal(store.data.workTimerRuntime.timers[0].startedAt, T0 + 40 * MIN);

    clock.advance(5 * MIN);
    engine.pause('A');
    assert.equal(store.data.workTimerRuntime.timers[0].accumulatedBeforePauseMs, 15 * MIN);
    clock.advance(60 * MIN);
    engine.resume('A');
    clock.advance(3 * MIN);

    engine.stop('A');
    assert.equal(store.data.todos[0].accumulatedMs, 2 * MIN + 18 * MIN);
    assert.equal(store.data.todos[0].lastTimingAt, T0 + 108 * MIN);
    assert.equal(store.data.todos[0].timingStatus, 'idle');
    assert.deepEqual(store.data.workTimerRuntime, { timers: [] });
  } finally {
    clock.restore();
  }
});

test('并发：A 计时中可再开始 B，两项各自独立（不再互斥拒绝）', () => {
  const clock = installClock(T0);
  const store = makeStore({
    todos: [makeTodo({ id: 'A' }), makeTodo({ id: 'B', title: '工作项 B' })],
  });
  const engine = new WorkTimerEngine(store);
  const todoById = (id) => store.data.todos.find((todo) => todo.id === id);
  const entryById = (id) =>
    store.data.workTimerRuntime.timers.find((entry) => entry.todoId === id);
  try {
    assert.equal(engine.start('A').ok, true);
    clock.advance(1 * MIN);
    assert.equal(engine.start('B').ok, true, 'B 可与 A 同时计时');
    assert.equal(store.data.workTimerRuntime.timers.length, 2);
    assert.deepEqual(
      store.data.workTimerRuntime.timers.map((entry) => entry.todoId).sort(),
      ['A', 'B'],
    );
    assert.equal(todoById('A').timingStatus, 'running');
    assert.equal(todoById('B').timingStatus, 'running');
    assert.deepEqual(store.data.todos.map((todo) => todo.id), ['B', 'A'], '新开的 B 置顶');

    // 重复 start 同一项：幂等空操作，不重置 startedAt、不产生第二条 entry。
    const duplicate = engine.start('A');
    assert.equal(duplicate.ok, true);
    assert.match(duplicate.message, /正在计时中/);
    assert.equal(store.data.workTimerRuntime.timers.length, 2);
    assert.equal(entryById('A').startedAt, T0);

    clock.advance(1 * MIN);
    // 卡片顺序 = 清单顺序：B（后开始但已置顶）在前。
    const entries = engine.getViewState().entries;
    assert.deepEqual(entries.map((entry) => entry.todoId), ['B', 'A']);
    assert.equal(entries[0].sessionElapsedMs, 1 * MIN);
    assert.equal(entries[1].sessionElapsedMs, 2 * MIN);
    assert.equal(engine.getViewState().totalSessionElapsedMs, 3 * MIN);

    // 暂停 A 不影响 B。
    engine.pause('A');
    assert.equal(todoById('A').timingStatus, 'paused');
    assert.equal(todoById('B').timingStatus, 'running');
    clock.advance(2 * MIN);
    const afterPause = engine.getViewState().entries;
    assert.deepEqual(afterPause.map((entry) => entry.todoId), ['B', 'A'], '暂停不改变顺序');
    assert.equal(afterPause[0].sessionElapsedMs, 3 * MIN, 'B 继续增长');
    assert.equal(afterPause[1].sessionElapsedMs, 2 * MIN, 'A 暂停后冻结');

    // 继续 A：各自从冻结值继续推进。
    engine.resume('A');
    clock.advance(1 * MIN);
    const afterResume = engine.getViewState().entries;
    assert.equal(afterResume[0].sessionElapsedMs, 4 * MIN);
    assert.equal(afterResume[1].sessionElapsedMs, 3 * MIN);
  } finally {
    clock.restore();
  }
});

test('暂停后再次 start 同一项等价于继续，且不改变清单顺序', () => {
  const clock = installClock(T0);
  const store = makeStore({
    todos: [makeTodo({ id: 'A' }), makeTodo({ id: 'B' }), makeTodo({ id: 'C' })],
  });
  const engine = new WorkTimerEngine(store);
  try {
    engine.start('A');
    clock.advance(4 * MIN);
    engine.pause('A');
    clock.advance(20 * MIN);
    const orderBefore = store.data.todos.map((todo) => todo.id);
    const resumed = engine.start('A');
    assert.deepEqual(resumed, { ok: true, message: '已继续计时' });
    assert.deepEqual(store.data.todos.map((todo) => todo.id), orderBefore, '继续不置顶');
    clock.advance(1 * MIN);
    assert.equal(engine.getViewState().entries[0].sessionElapsedMs, 5 * MIN);
  } finally {
    clock.restore();
  }
});

test('停止只结算目标项；autoMarkComplete 开启时只对触发项生效', () => {
  const clock = installClock(T0);
  const settings = createDefaultData().settings;
  const store = makeStore({
    todos: [makeTodo({ id: 'A' }), makeTodo({ id: 'B', title: '工作项 B' })],
    settings,
  });
  const engine = new WorkTimerEngine(store);
  const todoById = (id) => store.data.todos.find((todo) => todo.id === id);
  try {
    engine.start('A');
    engine.start('B');
    clock.advance(2 * MIN);
    engine.stop('A');
    assert.equal(todoById('A').completed, false, '默认不自动完成');
    assert.equal(todoById('A').completedAt, null);
    assert.equal(todoById('A').accumulatedMs, 2 * MIN);
    assert.equal(todoById('A').timingStatus, 'idle');
    assert.equal(todoById('B').accumulatedMs, 0, 'B 未被结算');
    assert.equal(todoById('B').timingStatus, 'running', 'B 仍在计时');
    assert.deepEqual(
      store.data.workTimerRuntime.timers.map((entry) => entry.todoId),
      ['B'],
    );

    store.data.settings.autoMarkComplete = true;
    clock.advance(1 * MIN);
    engine.stop('B');
    assert.equal(todoById('B').completed, true);
    assert.equal(todoById('B').completedAt, T0 + 3 * MIN);
    assert.equal(todoById('B').accumulatedMs, 3 * MIN);
    assert.equal(todoById('A').completed, false, 'autoMarkComplete 不牵连其它项');
    assert.deepEqual(store.data.todos.map((todo) => todo.id), ['A', 'B'], '完成的 B 沉底');
  } finally {
    clock.restore();
  }
});

test('边界：idle 项 pause/resume/stop 与不存在 todoId 的 pause 均幂等 ok', () => {
  const clock = installClock(T0);
  const store = makeStore({ todos: [makeTodo({ id: 'A' }), makeTodo({ id: 'B', title: '已完成', completed: true, completedAt: T0 })] });
  const engine = new WorkTimerEngine(store);
  try {
    assert.equal(engine.pause('A').ok, true);
    assert.equal(engine.resume('A').ok, true);
    assert.equal(engine.stop('A').ok, true);
    assert.equal(engine.pause('不存在').ok, true);
    assert.deepEqual(store.data.workTimerRuntime, { timers: [] });

    engine.start('A');
    engine.stop('A');
    assert.equal(store.data.todos[0].accumulatedMs, 0);
    assert.equal(store.data.todos[0].lastTimingAt, T0);
    assert.equal(engine.getViewState().entries.length, 0);

    const missing = engine.start('不存在');
    assert.equal(missing.ok, false);
    assert.match(missing.message, /工作项不存在/);

    const completed = engine.start('B');
    assert.equal(completed.ok, false, '已完成项不可计时');
    assert.match(completed.message, /已完成的工作项不可计时/);
  } finally {
    clock.restore();
  }
});

test('崩溃恢复：running 按真实经过时间，paused 用暂停前累计（v1 单条亦兼容）', () => {
  const clock = installClock(T0);
  try {
    const running = makeStore({
      todos: [makeTodo({ id: 'A' })],
      workTimerRuntime: {
        activeTimerId: 'A',
        status: 'running',
        startedAt: T0 - 10 * MIN,
        accumulatedBeforePauseMs: 5 * MIN,
        pauseStartedAt: null,
      },
    });
    const engineA = new WorkTimerEngine(running);
    engineA.restore(running.getAppData().workTimerRuntime);
    assert.equal(running.data.workTimerRuntime.timers.length, 1, 'v1 单条迁移为一条 entry');
    assert.equal(engineA.getViewState().entries[0].sessionElapsedMs, 15 * MIN);
    assert.equal(running.data.todos[0].timingStatus, 'running');

    const paused = makeStore({
      todos: [makeTodo({ id: 'A' })],
      workTimerRuntime: {
        activeTimerId: 'A',
        status: 'paused',
        startedAt: null,
        accumulatedBeforePauseMs: 7 * MIN,
        pauseStartedAt: T0 - 30 * MIN,
      },
    });
    const engineB = new WorkTimerEngine(paused);
    engineB.restore(paused.getAppData().workTimerRuntime);
    assert.equal(engineB.getViewState().entries[0].sessionElapsedMs, 7 * MIN, '暂停的 30 分钟不计入');
    assert.equal(paused.data.todos[0].timingStatus, 'paused');
  } finally {
    clock.restore();
  }
});

test('崩溃恢复：坏条目只丢自己，其它条目照常恢复', () => {
  const clock = installClock(T0);
  try {
    const dangling = makeStore({
      todos: [makeTodo({ id: 'A' }), makeTodo({ id: 'B', title: '工作项 B' })],
      workTimerRuntime: makeRuntime([
        { todoId: '已删除', status: 'running', startedAt: T0 - MIN },
        { todoId: 'A', status: 'running', startedAt: T0 - 2 * MIN },
      ]),
    });
    const engineA = new WorkTimerEngine(dangling);
    engineA.restore(dangling.getAppData().workTimerRuntime);
    assert.deepEqual(
      dangling.data.workTimerRuntime.timers.map((entry) => entry.todoId),
      ['A'],
      '悬空条目被丢弃，A 保留',
    );
    assert.equal(engineA.getViewState().entries[0].sessionElapsedMs, 2 * MIN);
    assert.equal(dangling.data.todos[1].timingStatus, 'idle');

    const malformed = makeStore({
      todos: [makeTodo({ id: 'A' }), makeTodo({ id: 'B', title: '工作项 B' })],
      workTimerRuntime: makeRuntime([
        { todoId: 'A', status: 'running', startedAt: null, accumulatedBeforePauseMs: 3 * MIN },
        { todoId: 'B', status: 'paused', accumulatedBeforePauseMs: 4 * MIN, pauseStartedAt: T0 - MIN },
      ]),
    });
    const engineB = new WorkTimerEngine(malformed);
    engineB.restore(malformed.getAppData().workTimerRuntime);
    assert.deepEqual(
      malformed.data.workTimerRuntime.timers.map((entry) => entry.todoId),
      ['B'],
      'running 缺 startedAt 只丢该条',
    );
    assert.equal(malformed.data.todos[0].timingStatus, 'idle');
    assert.equal(malformed.data.todos[1].timingStatus, 'paused');
  } finally {
    clock.restore();
  }
});

test('删除正在计时的 TODO：IPC 只停止该项并累加，其它计时不受影响', async () => {
  const clock = installClock(T0);
  qa.handlers.clear();
  const store = makeStore({
    todos: [makeTodo({ id: 'A' }), makeTodo({ id: 'B', title: '工作项 B' })],
  });
  const workTimer = new WorkTimerEngine(store);
  const registry = new IpcRegistry(store, {}, workTimer, {}, {}, {});
  const stoppedIds = [];
  const originalStop = workTimer.stop.bind(workTimer);
  workTimer.stop = (todoId) => {
    stoppedIds.push(todoId);
    return originalStop(todoId);
  };
  try {
    registry.registerAll();
    workTimer.start('A');
    workTimer.start('B');
    clock.advance(6 * MIN);
    const handler = qa.handlers.get(IpcCommand.TODO_DELETE);
    assert.ok(handler, 'todo:delete 必须已注册');
    const result = await handler({}, { id: 'A' });
    assert.equal(result.ok, true);
    assert.deepEqual(stoppedIds, ['A'], '只对目标项调用 stop(id)');
    assert.deepEqual(
      store.data.todos.map((todo) => todo.id),
      ['B'],
    );
    assert.deepEqual(
      store.data.workTimerRuntime.timers.map((entry) => entry.todoId),
      ['B'],
      'B 的计时保留',
    );
    assert.equal(store.data.todos[0].timingStatus, 'running');
  } finally {
    clock.restore();
  }
});
