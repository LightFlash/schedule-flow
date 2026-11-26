/**
 * 番茄钟引擎（主进程权威）。
 * 状态机 idle → running ⇄ paused → idle；阶段 work ⇄ break。
 * 一切判定基于 phaseStartedAt 绝对时间戳，不受渲染层重载 / 掉帧影响；
 * 每 250ms tick 推送视图态，到点时先记录再推进阶段，提醒不阻塞计时。
 */

import { BrowserWindow } from 'electron';
import { IpcEvent } from '@shared/ipcChannels';
import { formatPushTime } from '@shared/pushTemplate';
import { createId, minutesToMs } from '@shared/time';
import type {
  PomodoroConfig,
  PomodoroPhase,
  PomodoroRuntime,
  PomodoroViewState,
  ReminderPayload,
  TickPayload,
  WorkTimerViewState,
} from '@shared/types';
import type { StoreService } from '../store';
import type { ReminderService } from '../services/reminderService';

const TICK_INTERVAL_MS = 250;

function emit(event: string, payload?: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(event, payload);
    }
  }
}

function clampConfig(config: PomodoroConfig): PomodoroConfig {
  const clamp = (value: number, fallback: number, min: number, max: number): number => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, Math.round(numeric)));
  };
  return {
    workMinutes: clamp(config.workMinutes, 25, 1, 240),
    breakMinutes: clamp(config.breakMinutes, 5, 1, 120),
    rounds: clamp(config.rounds, 4, 1, 20),
  };
}

export class PomodoroEngine {
  private tickTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: StoreService,
    private readonly reminder: ReminderService,
    private readonly getWorkTimerState: () => WorkTimerViewState,
  ) {}

  /** 启动全局 250ms tick 循环（主进程唯一循环）。 */
  startTimerLoop(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  stopTimerLoop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  /** 启动：idle 从头开始，paused 继续剩余时间，running 时忽略。 */
  start(): void {
    const runtime = this.store.getAppData().pomodoroRuntime;
    if (runtime.status === 'running') return;
    if (runtime.status === 'paused') {
      this.resume();
      return;
    }
    this.store.savePomodoroRuntime({
      ...runtime,
      status: 'running',
      phase: runtime.phase,
      currentRound: Math.min(Math.max(1, runtime.currentRound), runtime.totalRounds),
      phaseStartedAt: Date.now(),
      pausedRemainingMs: 0,
    });
  }

  pause(): void {
    const runtime = this.store.getAppData().pomodoroRuntime;
    if (runtime.status !== 'running' || runtime.phaseStartedAt === null) return;
    const remainingMs = Math.max(
      0,
      runtime.phaseStartedAt + this.phaseDurationMs(runtime) - Date.now(),
    );
    this.store.savePomodoroRuntime({
      ...runtime,
      status: 'paused',
      phaseStartedAt: null,
      pausedRemainingMs: remainingMs,
    });
  }

  resume(): void {
    const runtime = this.store.getAppData().pomodoroRuntime;
    if (runtime.status !== 'paused') return;
    const durationMs = this.phaseDurationMs(runtime);
    const elapsedMs = Math.min(durationMs, Math.max(0, durationMs - runtime.pausedRemainingMs));
    // 反推 startedAt，使剩余时间与暂停前严格一致（不因暂停产生漂移）。
    this.store.savePomodoroRuntime({
      ...runtime,
      status: 'running',
      phaseStartedAt: Date.now() - elapsedMs,
      pausedRemainingMs: 0,
    });
  }

  reset(): void {
    const config = clampConfig(this.store.getAppData().pomodoroRuntime.config);
    this.store.savePomodoroRuntime({
      status: 'idle',
      phase: 'work',
      currentRound: 1,
      totalRounds: config.rounds,
      config,
      phaseStartedAt: null,
      pausedRemainingMs: 0,
    });
  }

  /** 更新默认参数：运行中不打断当前阶段；非运行状态直接重置到新配置。 */
  updateConfig(config: PomodoroConfig): void {
    const normalized = clampConfig(config);
    const runtime = this.store.getAppData().pomodoroRuntime;
    if (runtime.status === 'running') {
      this.store.savePomodoroRuntime({
        ...runtime,
        config: normalized,
        totalRounds: normalized.rounds,
        currentRound: Math.min(runtime.currentRound, normalized.rounds),
      });
      return;
    }
    this.store.savePomodoroRuntime({
      status: 'idle',
      phase: 'work',
      currentRound: 1,
      totalRounds: normalized.rounds,
      config: normalized,
      phaseStartedAt: null,
      pausedRemainingMs: minutesToMs(normalized.workMinutes),
    });
  }

  /** 供渲染层订阅的组合视图态。 */
  getViewState(): PomodoroViewState {
    const runtime = this.store.getAppData().pomodoroRuntime;
    const totalPhaseMs = this.phaseDurationMs(runtime);
    let remainingMs: number;
    if (runtime.status === 'running' && runtime.phaseStartedAt !== null) {
      remainingMs = runtime.phaseStartedAt + totalPhaseMs - Date.now();
    } else if (runtime.status === 'paused') {
      remainingMs = runtime.pausedRemainingMs;
    } else {
      remainingMs = totalPhaseMs;
    }
    return {
      status: runtime.status,
      phase: runtime.phase,
      currentRound: runtime.currentRound,
      totalRounds: runtime.totalRounds,
      remainingMs: Math.max(0, remainingMs),
      totalPhaseMs,
      config: { ...runtime.config },
    };
  }

  /**
   * 启动恢复：运行态已由 store 持久化，这里只做一致性校验与修正。
   * 若恢复前为 running，真实经过时间由 phaseStartedAt 自动体现，首个 tick 可能立即到点。
   */
  restore(runtime: PomodoroRuntime): void {
    const settings = this.store.getSettings();
    let next: PomodoroRuntime = { ...runtime, config: clampConfig(runtime.config) };
    next.totalRounds = next.config.rounds;
    next.currentRound = Math.min(Math.max(1, next.currentRound), next.totalRounds);

    if (next.status === 'running' && next.phaseStartedAt === null) {
      next = { ...next, status: 'idle', phase: 'work', currentRound: 1, pausedRemainingMs: 0 };
    }
    if (next.status === 'paused' && next.pausedRemainingMs <= 0) {
      next = { ...next, status: 'idle', phase: 'work', currentRound: 1, pausedRemainingMs: 0 };
    }
    if (next.status === 'idle') {
      // 空闲时同步设置页里的最新默认参数。
      next = {
        ...next,
        config: clampConfig(settings.pomodoro),
        totalRounds: settings.pomodoro.rounds,
        currentRound: 1,
        phase: 'work',
        phaseStartedAt: null,
        pausedRemainingMs: minutesToMs(settings.pomodoro.workMinutes),
      };
    }
    this.store.savePomodoroRuntime(next);
  }

  /** 单次 tick：先判定是否到点，再推送视图态。 */
  private tick(): void {
    const runtime = this.store.getAppData().pomodoroRuntime;
    if (
      runtime.status === 'running' &&
      runtime.phaseStartedAt !== null &&
      Date.now() - runtime.phaseStartedAt >= this.phaseDurationMs(runtime)
    ) {
      this.onPhaseEnd();
    }
    const payload: TickPayload = {
      pomodoro: this.getViewState(),
      workTimer: this.getWorkTimerState(),
    };
    emit(IpcEvent.TICK, payload);
  }

  /** 阶段结束：记录工作轮次 → 自动推进阶段 → 触发提醒（可触发全部完成提示）。 */
  private onPhaseEnd(): void {
    const previous = this.store.getAppData().pomodoroRuntime;
    if (previous.status !== 'running' || previous.phaseStartedAt === null) return;

    const now = Date.now();
    const durationMs = this.phaseDurationMs(previous);
    if (previous.phase === 'work') {
      this.store.addPomodoroRecord({
        id: createId(),
        finishedAt: now,
        round: previous.currentRound,
        workDurationMs: durationMs,
      });
    }

    const allDone = previous.phase === 'break' && previous.currentRound >= previous.totalRounds;
    const nextPhase: PomodoroPhase = previous.phase === 'work' ? 'break' : 'work';
    const nextRound =
      previous.phase === 'break' && !allDone
        ? Math.min(previous.currentRound + 1, previous.totalRounds)
        : previous.currentRound;

    const nextRuntime: PomodoroRuntime = allDone
      ? {
          ...previous,
          status: 'idle',
          phase: 'work',
          currentRound: 1,
          phaseStartedAt: null,
          pausedRemainingMs: durationMs,
        }
      : {
          ...previous,
          status: 'running',
          phase: nextPhase,
          currentRound: nextRound,
          phaseStartedAt: now,
          pausedRemainingMs: 0,
        };
    this.store.savePomodoroRuntime(nextRuntime);

    // 提醒（含推送）在后台进行，不阻塞计时推进。
    void this.reminder.trigger(
      this.buildReminderPayload(previous, nextRound, allDone, now),
      this.store.getSettings(),
    );

    if (allDone) {
      emit(IpcEvent.POMODORO_ALL_DONE, { message: `已完成 ${previous.totalRounds} 轮专注，好好休息一下！` });
    }
  }

  /**
   * 组装提醒载荷：本地强提醒文案（title/message）保持原样，
   * 另附 `event` + `vars` 供推送层渲染用户自定义模板。
   * - 工作轮结束 → pomodoroWorkEnd，`{round}` = 刚完成的轮次；
   * - 休息结束（含最后一轮全部完成） → pomodoroBreakEnd，`{round}` = 即将开始的轮次。
   */
  private buildReminderPayload(
    previous: PomodoroRuntime,
    nextRound: number,
    allDone: boolean,
    now: number,
  ): ReminderPayload {
    const commonVars = {
      breakMinutes: previous.config.breakMinutes,
      workMinutes: previous.config.workMinutes,
      time: formatPushTime(now),
    };
    if (previous.phase === 'work') {
      // work 结束时 nextRound 仍等于当前轮；文案需单独推进到"即将开始"的轮次。
      const upcomingRound = Math.min(previous.currentRound + 1, previous.totalRounds);
      const message =
        upcomingRound > previous.currentRound
          ? `休息 ${previous.config.breakMinutes} 分钟后继续第 ${upcomingRound} 轮工作。`
          : `休息 ${previous.config.breakMinutes} 分钟后完成本轮，全部专注即将结束。`;
      return {
        phase: 'work',
        title: `第 ${previous.currentRound} 轮工作结束，休息一下`,
        message,
        event: 'pomodoroWorkEnd',
        vars: { ...commonVars, round: previous.currentRound },
      };
    }
    if (allDone) {
      return {
        phase: 'break',
        title: '全部轮次完成！',
        message: `已完成 ${previous.totalRounds} 轮专注，记得起身活动一下。`,
        event: 'pomodoroBreakEnd',
        vars: { ...commonVars, round: previous.totalRounds },
      };
    }
    return {
      phase: 'break',
      title: '休息结束，继续专注',
      message: `第 ${nextRound} 轮工作 ${previous.config.workMinutes} 分钟，开始吧。`,
      event: 'pomodoroBreakEnd',
      vars: { ...commonVars, round: nextRound },
    };
  }

  private phaseDurationMs(runtime: PomodoroRuntime): number {
    const minutes = runtime.phase === 'work' ? runtime.config.workMinutes : runtime.config.breakMinutes;
    return minutesToMs(minutes);
  }
}
