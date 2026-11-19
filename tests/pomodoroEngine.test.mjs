import test from 'node:test';
import assert from 'node:assert/strict';
import { PomodoroEngine } from './.build/pomodoroEngine.mjs';
import { IpcEvent } from './.build/ipcChannels.mjs';
import { createDefaultData, installClock, makeStore } from './helpers/helpers.mjs';
import { FakeWindow } from './.build/electronStub.mjs';

const MIN = 60000;
const T0 = new Date(2026, 10, 19, 9, 0, 0).getTime();
const qa = globalThis.__qaElectron;

function setup({ config = { workMinutes: 1, breakMinutes: 1, rounds: 2 }, settings } = {}) {
  const defaults = createDefaultData();
  const store = makeStore({
    settings: settings ?? defaults.settings,
    pomodoroRuntime: {
      ...defaults.pomodoroRuntime,
      config,
      totalRounds: config.rounds,
      pausedRemainingMs: config.workMinutes * MIN,
    },
  });
  const reminders = [];
  const reminder = {
    trigger(payload, receivedSettings) {
      reminders.push({ payload, settings: receivedSettings });
      return Promise.resolve();
    },
  };
  const engine = new PomodoroEngine(store, reminder, () => ({
    status: 'idle',
    activeTodoId: null,
    activeTitle: '',
    sessionElapsedMs: 0,
    activeAccumulatedMs: 0,
  }));
  return { store, engine, reminders };
}

test('暂停/恢复剩余时间精确，多轮暂停不漂移', () => {
  const clock = installClock(T0);
  const { store, engine } = setup({ config: { workMinutes: 25, breakMinutes: 5, rounds: 4 } });
  try {
    engine.start();
    assert.equal(store.data.pomodoroRuntime.status, 'running');
    assert.equal(store.data.pomodoroRuntime.phaseStartedAt, T0);
    assert.equal(engine.getViewState().remainingMs, 25 * MIN);

    clock.advance(10 * MIN);
    assert.equal(engine.getViewState().remainingMs, 15 * MIN);
    engine.pause();
    assert.equal(store.data.pomodoroRuntime.status, 'paused');
    assert.equal(store.data.pomodoroRuntime.phaseStartedAt, null);
    assert.equal(store.data.pomodoroRuntime.pausedRemainingMs, 15 * MIN);

    clock.advance(60 * MIN);
    assert.equal(engine.getViewState().remainingMs, 15 * MIN, '暂停期间剩余时间不变');
    engine.resume();
    assert.equal(store.data.pomodoroRuntime.phaseStartedAt, T0 + 60 * MIN);

    clock.advance(5 * MIN);
    assert.equal(engine.getViewState().remainingMs, 10 * MIN);
    engine.pause();
    clock.advance(20 * MIN);
    engine.resume();
    assert.equal(engine.getViewState().remainingMs, 10 * MIN, '二次恢复依然精确');
    assert.equal(store.data.pomodoroRuntime.phaseStartedAt, T0 + 80 * MIN);
  } finally {
    clock.restore();
  }
});

test('到点：仅 work 写记录，阶段自动推进，提醒不阻塞计时，全部完成置 idle', () => {
  const clock = installClock(T0);
  qa.emitted.length = 0;
  qa.windows.length = 0;
  qa.windows.push(new FakeWindow()); // emit() 只向已存在的窗口广播
  const { store, engine, reminders } = setup();
  try {
    engine.start();
    clock.advance(1 * MIN);
    engine.tick();
    assert.equal(store.data.pomodoroRecords.length, 1);
    assert.deepEqual(
      {
        finishedAt: store.data.pomodoroRecords[0].finishedAt,
        round: store.data.pomodoroRecords[0].round,
        workDurationMs: store.data.pomodoroRecords[0].workDurationMs,
      },
      { finishedAt: T0 + MIN, round: 1, workDurationMs: MIN },
    );
    assert.equal(store.data.pomodoroRuntime.phase, 'break');
    assert.equal(store.data.pomodoroRuntime.status, 'running');
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0].payload.phase, 'work');

    engine.tick(); // 同一时刻再 tick 不应重复写记录
    assert.equal(store.data.pomodoroRecords.length, 1);

    clock.advance(1 * MIN);
    engine.tick();
    assert.equal(store.data.pomodoroRecords.length, 1, 'break 结束不写记录');
    assert.equal(store.data.pomodoroRuntime.phase, 'work');
    assert.equal(store.data.pomodoroRuntime.currentRound, 2);
    assert.equal(reminders.length, 2);
    assert.equal(reminders[1].payload.phase, 'break');

    clock.advance(1 * MIN);
    engine.tick();
    assert.equal(store.data.pomodoroRecords.length, 2);
    assert.equal(store.data.pomodoroRecords[1].round, 2);

    clock.advance(1 * MIN);
    engine.tick();
    assert.equal(store.data.pomodoroRuntime.status, 'idle', '最后一轮休息结束回到 idle');
    assert.equal(store.data.pomodoroRuntime.phase, 'work');
    assert.equal(store.data.pomodoroRuntime.phaseStartedAt, null);
    assert.equal(store.data.pomodoroRecords.length, 2);
    assert.equal(reminders.length, 4);
    assert.match(reminders[3].payload.title, /全部轮次完成/);
    assert.ok(
      qa.emitted.some((item) => item.event === IpcEvent.POMODORO_ALL_DONE),
      '必须广播 allDone 事件',
    );
  } finally {
    clock.restore();
  }
});

test('工作结束提醒中的下一轮轮次号正确', () => {
  const clock = installClock(T0);
  const { engine, reminders } = setup();
  try {
    engine.start();
    clock.advance(1 * MIN);
    engine.tick();
    assert.match(reminders[0].payload.message, /第 2 轮工作/);
  } finally {
    clock.restore();
  }
});

test('崩溃恢复：running 用真实经过时间，idle 同步设置默认参数', () => {
  const clock = installClock(T0);
  const settings = createDefaultData().settings;
  settings.pomodoro = { workMinutes: 30, breakMinutes: 10, rounds: 3 };
  const { store, engine } = setup({ settings });
  try {
    engine.restore({
      ...store.getAppData().pomodoroRuntime,
      status: 'running',
      phase: 'work',
      config: { workMinutes: 25, breakMinutes: 5, rounds: 4 },
      phaseStartedAt: T0 - 10 * MIN,
    });
    assert.equal(engine.getViewState().remainingMs, 15 * MIN, '按真实经过时间恢复');

    engine.reset();
    assert.equal(engine.getViewState().status, 'idle');
    engine.restore(store.getAppData().pomodoroRuntime);
    assert.equal(engine.getViewState().totalPhaseMs, 30 * MIN, '空闲时同步设置页默认参数');
    assert.equal(engine.getViewState().totalRounds, 3);
  } finally {
    clock.restore();
  }
});

test('非法配置被钳制；暂停态恢复非法时回到 idle', () => {
  const clock = installClock(T0);
  const { store, engine } = setup();
  try {
    engine.updateConfig({ workMinutes: 0, breakMinutes: 999, rounds: -3 });
    assert.deepEqual(store.data.pomodoroRuntime.config, { workMinutes: 1, breakMinutes: 120, rounds: 1 });
    assert.equal(engine.getViewState().remainingMs, 1 * MIN);

    store.savePomodoroRuntime({ ...store.data.pomodoroRuntime, status: 'paused', pausedRemainingMs: 0 });
    engine.restore(store.getAppData().pomodoroRuntime);
    assert.equal(store.data.pomodoroRuntime.status, 'idle');
  } finally {
    clock.restore();
  }
});
