import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkTimerEngine } from './.build/workTimerEngine.mjs';
import { IpcRegistry } from './.build/ipc.mjs';
import { IpcCommand } from './.build/ipcChannels.mjs';
import { createDefaultData, installClock, makeStore, makeTodo } from './helpers/helpers.mjs';

const MIN = 60000;
const T0 = new Date(2026, 10, 19, 9, 0, 0).getTime();
const qa = globalThis.__qaElectron;

test('多轮暂停/继续无漂移，停止时正确累加并写入 lastTimingAt', () => {
  const clock = installClock(T0);
  const store = makeStore({ todos: [makeTodo({ id: 'A', accumulatedMs: 2 * MIN })] });
  const engine = new WorkTimerEngine(store);
  try {
    assert.equal(engine.start('A').ok, true);
    assert.equal(store.data.workTimerRuntime.startedAt, T0);
    assert.equal(store.data.todos[0].timingStatus, 'running');

    clock.advance(10 * MIN);
    engine.pause();
    assert.equal(store.data.workTimerRuntime.accumulatedBeforePauseMs, 10 * MIN);
    assert.equal(store.data.workTimerRuntime.startedAt, null);
    assert.equal(store.data.todos[0].timingStatus, 'paused');

    clock.advance(30 * MIN); // 暂停的 30 分钟不计入
    assert.equal(engine.getViewState().sessionElapsedMs, 10 * MIN);
    engine.resume();
    assert.equal(store.data.workTimerRuntime.startedAt, T0 + 40 * MIN);

    clock.advance(5 * MIN);
    engine.pause();
    assert.equal(store.data.workTimerRuntime.accumulatedBeforePauseMs, 15 * MIN);
    clock.advance(60 * MIN);
    engine.resume();
    clock.advance(3 * MIN);

    engine.stop();
    assert.equal(store.data.todos[0].accumulatedMs, 2 * MIN + 18 * MIN);
    assert.equal(store.data.todos[0].lastTimingAt, T0 + 108 * MIN);
    assert.equal(store.data.todos[0].timingStatus, 'idle');
    assert.deepEqual(store.data.workTimerRuntime, {
      activeTimerId: null,
      status: 'idle',
      startedAt: null,
      accumulatedBeforePauseMs: 0,
      pauseStartedAt: null,
    });
  } finally {
    clock.restore();
  }
});

test('互斥：另一项开始时返回 ok:false，且不改变当前计时', () => {
  const clock = installClock(T0);
  const store = makeStore({
    todos: [makeTodo({ id: 'A' }), makeTodo({ id: 'B', title: '工作项 B' })],
  });
  const engine = new WorkTimerEngine(store);
  try {
    assert.equal(engine.start('A').ok, true);
    clock.advance(1 * MIN);
    const refused = engine.start('B');
    assert.equal(refused.ok, false);
    assert.match(refused.message, /请先停止当前计时/);
    assert.equal(store.data.workTimerRuntime.activeTimerId, 'A');
    assert.equal(store.data.todos[1].timingStatus, 'idle');

    const duplicate = engine.start('A');
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.message, /正在计时中/);

    engine.stop();
    assert.equal(engine.start('B').ok, true);
    assert.equal(store.data.workTimerRuntime.activeTimerId, 'B');
  } finally {
    clock.restore();
  }
});

test('暂停后再次 start 同一项等价于继续', () => {
  const clock = installClock(T0);
  const store = makeStore({ todos: [makeTodo({ id: 'A' })] });
  const engine = new WorkTimerEngine(store);
  try {
    engine.start('A');
    clock.advance(4 * MIN);
    engine.pause();
    clock.advance(20 * MIN);
    const resumed = engine.start('A');
    assert.deepEqual(resumed, { ok: true, message: '已继续计时' });
    clock.advance(1 * MIN);
    assert.equal(engine.getViewState().sessionElapsedMs, 5 * MIN);
  } finally {
    clock.restore();
  }
});

test('停止时 autoMarkComplete 生效；默认关闭时不勾选完成', () => {
  const clock = installClock(T0);
  const settings = createDefaultData().settings;
  const store = makeStore({ todos: [makeTodo({ id: 'A' })], settings });
  const engine = new WorkTimerEngine(store);
  try {
    engine.start('A');
    engine.stop();
    assert.equal(store.data.todos[0].completed, false, '默认不自动完成');
    assert.equal(store.data.todos[0].completedAt, null);

    store.data.settings.autoMarkComplete = true;
    engine.start('A');
    clock.advance(2 * MIN);
    engine.stop();
    assert.equal(store.data.todos[0].completed, true);
    assert.equal(store.data.todos[0].completedAt, T0 + 2 * MIN);
    assert.equal(store.data.todos[0].accumulatedMs, 2 * MIN);
  } finally {
    clock.restore();
  }
});

test('边界：0 时长、空闲时暂停/停止均不产生负数或异常', () => {
  const clock = installClock(T0);
  const store = makeStore({ todos: [makeTodo({ id: 'A' })] });
  const engine = new WorkTimerEngine(store);
  try {
    engine.pause();
    engine.stop();
    assert.equal(store.data.workTimerRuntime.status, 'idle');

    engine.start('A');
    engine.stop();
    assert.equal(store.data.todos[0].accumulatedMs, 0);
    assert.equal(store.data.todos[0].lastTimingAt, T0);
    assert.equal(engine.getViewState().sessionElapsedMs, 0);

    const missing = engine.start('不存在');
    assert.equal(missing.ok, false);
    assert.match(missing.message, /工作项不存在/);
  } finally {
    clock.restore();
  }
});

test('崩溃恢复：running 按真实经过时间，paused 用暂停前累计', () => {
  const clock = installClock(T0);
  try {
    const running = makeStore({
      todos: [makeTodo({ id: 'A', timingStatus: 'running' })],
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
    assert.equal(engineA.getViewState().sessionElapsedMs, 15 * MIN);
    assert.equal(running.data.workTimerRuntime.status, 'running');

    const paused = makeStore({
      todos: [makeTodo({ id: 'A', timingStatus: 'paused' })],
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
    assert.equal(engineB.getViewState().sessionElapsedMs, 7 * MIN, '暂停的 30 分钟不计入');
  } finally {
    clock.restore();
  }
});

test('崩溃恢复：悬空 activeTimerId / running 缺 startedAt 时安全复位', () => {
  const clock = installClock(T0);
  try {
    const dangling = makeStore({
      todos: [makeTodo({ id: 'A', timingStatus: 'running' })],
      workTimerRuntime: {
        activeTimerId: '已删除',
        status: 'running',
        startedAt: T0 - MIN,
        accumulatedBeforePauseMs: 0,
        pauseStartedAt: null,
      },
    });
    new WorkTimerEngine(dangling).restore(dangling.getAppData().workTimerRuntime);
    assert.equal(dangling.data.workTimerRuntime.activeTimerId, null);
    assert.equal(dangling.data.todos[0].timingStatus, 'idle');

    const malformed = makeStore({
      todos: [makeTodo({ id: 'A', timingStatus: 'paused' })],
      workTimerRuntime: {
        activeTimerId: 'A',
        status: 'running',
        startedAt: null,
        accumulatedBeforePauseMs: 3 * MIN,
        pauseStartedAt: null,
      },
    });
    new WorkTimerEngine(malformed).restore(malformed.getAppData().workTimerRuntime);
    assert.equal(malformed.data.workTimerRuntime.status, 'idle');
    assert.equal(malformed.data.todos[0].timingStatus, 'idle');
  } finally {
    clock.restore();
  }
});

test('删除正在计时的 TODO：IPC 先停止并累加，再删除，不留悬空运行态', async () => {
  const clock = installClock(T0);
  qa.handlers.clear();
  const store = makeStore({ todos: [makeTodo({ id: 'A' })] });
  const workTimer = new WorkTimerEngine(store);
  const registry = new IpcRegistry(store, {}, workTimer, {}, {}, {});
  let stopCalls = 0;
  const originalStop = workTimer.stop.bind(workTimer);
  workTimer.stop = () => {
    stopCalls += 1;
    originalStop();
  };
  try {
    registry.registerAll();
    workTimer.start('A');
    clock.advance(6 * MIN);
    const handler = qa.handlers.get(IpcCommand.TODO_DELETE);
    assert.ok(handler, 'todo:delete 必须已注册');
    const result = await handler({}, { id: 'A' });
    assert.equal(result.ok, true);
    assert.equal(store.data.todos.length, 0);
    assert.equal(store.data.workTimerRuntime.activeTimerId, null);
    assert.equal(store.data.workTimerRuntime.status, 'idle');
    assert.equal(stopCalls, 1, '删除前必须先调用 workTimer.stop()');
  } finally {
    clock.restore();
  }
});
