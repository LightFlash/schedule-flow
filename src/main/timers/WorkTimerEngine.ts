/**
 * 工作计时引擎（主进程权威）。
 * 状态机 idle → running ⇄ paused → idle；全局单一 activeTimerId 保证同一时刻仅一项计时。
 * running 以 startedAt（与暂停前累计）为准，paused 以 accumulatedBeforePauseMs 为准；
 * 每次状态转换立即持久化，崩溃后按 Date.now() 真实经过时间恢复。
 */

import type { IpcResult, WorkTimerRuntime, WorkTimerViewState } from '@shared/types';
import type { StoreService } from '../store';

function emptyRuntime(): WorkTimerRuntime {
  return {
    activeTimerId: null,
    status: 'idle',
    startedAt: null,
    accumulatedBeforePauseMs: 0,
    pauseStartedAt: null,
  };
}

export class WorkTimerEngine {
  constructor(private readonly store: StoreService) {}

  /** 开始 / 继续指定工作项。若已有其它计时项，返回 ok:false 交渲染层确认先停后启。 */
  start(todoId: string): IpcResult<string> {
    const todos = this.store.getTodos();
    const todo = todos.find((item) => item.id === todoId);
    if (!todo) return { ok: false, message: '工作项不存在或已被删除' };

    const runtime = this.store.getAppData().workTimerRuntime;
    if (runtime.activeTimerId !== null && runtime.activeTimerId !== todoId) {
      return { ok: false, message: '请先停止当前计时' };
    }
    if (runtime.activeTimerId === todoId && runtime.status === 'running') {
      return { ok: false, message: '该项正在计时中' };
    }
    if (runtime.activeTimerId === todoId && runtime.status === 'paused') {
      this.resume();
      return { ok: true, message: '已继续计时' };
    }

    this.store.saveWorkTimerRuntime({
      activeTimerId: todoId,
      status: 'running',
      startedAt: Date.now(),
      accumulatedBeforePauseMs: 0,
      pauseStartedAt: null,
    });
    this.store.updateTodo(todoId, { timingStatus: 'running' });
    // 开始计时的工作项自动置顶，方便随时看到当前专注对象。
    this.store.moveTodoToTop(todoId);
    return { ok: true, message: '已开始计时' };
  }

  /** 停止：本次时长累加到 TODO，最后计时时间写为当前时刻，清空运行态。 */
  stop(): void {
    const runtime = this.store.getAppData().workTimerRuntime;
    if (runtime.activeTimerId === null) {
      this.store.saveWorkTimerRuntime(emptyRuntime());
      return;
    }

    const sessionMs = this.sessionElapsedMs(runtime);
    const now = Date.now();
    const autoMarkComplete = this.store.getSettings().autoMarkComplete;
    const todo = this.store.getTodos().find((item) => item.id === runtime.activeTimerId);

    if (todo) {
      const patch = {
        accumulatedMs: todo.accumulatedMs + sessionMs,
        lastTimingAt: now,
        timingStatus: 'idle' as const,
        ...(autoMarkComplete ? { completed: true, completedAt: now } : {}),
      };
      this.store.updateTodo(todo.id, patch);
      // 开启 autoMarkComplete 停止即完成时，同样自动沉底，与勾选完成行为一致。
      if (autoMarkComplete) this.store.moveTodoToEnd(todo.id);
    }

    this.store.saveWorkTimerRuntime(emptyRuntime());
  }

  pause(): void {
    const runtime = this.store.getAppData().workTimerRuntime;
    if (runtime.status !== 'running' || runtime.startedAt === null || runtime.activeTimerId === null) {
      return;
    }
    const now = Date.now();
    this.store.saveWorkTimerRuntime({
      ...runtime,
      status: 'paused',
      startedAt: null,
      accumulatedBeforePauseMs:
        runtime.accumulatedBeforePauseMs + Math.max(0, now - runtime.startedAt),
      pauseStartedAt: now,
    });
    this.store.updateTodo(runtime.activeTimerId, { timingStatus: 'paused' });
  }

  resume(): void {
    const runtime = this.store.getAppData().workTimerRuntime;
    if (runtime.status !== 'paused' || runtime.activeTimerId === null) return;
    this.store.saveWorkTimerRuntime({
      ...runtime,
      status: 'running',
      startedAt: Date.now(),
      pauseStartedAt: null,
    });
    this.store.updateTodo(runtime.activeTimerId, { timingStatus: 'running' });
  }

  /** 供 250ms tick 使用的视图态。 */
  getViewState(): WorkTimerViewState {
    const runtime = this.store.getAppData().workTimerRuntime;
    const todos = this.store.getTodos();
    const todo = todos.find((item) => item.id === runtime.activeTimerId);
    return {
      status: runtime.status,
      activeTodoId: runtime.activeTimerId,
      activeTitle: runtime.activeTimerId === null ? '' : todo?.title ?? '（工作项已删除）',
      sessionElapsedMs: this.sessionElapsedMs(runtime),
      activeAccumulatedMs: todo?.accumulatedMs ?? 0,
    };
  }

  /**
   * 启动恢复：校验运行态合法性；running 场景由 startedAt 直接得到真实经过时间，
   * paused 场景使用暂停前累计值。非法或指向已删工作项的运行态被重置为空闲。
   */
  restore(runtime: WorkTimerRuntime): void {
    const todos = this.store.getTodos();
    const hasTodo = runtime.activeTimerId !== null && todos.some((t) => t.id === runtime.activeTimerId);
    const runningWithoutStart = runtime.status === 'running' && runtime.startedAt === null;

    if (!hasTodo || runningWithoutStart) {
      for (const todo of todos) {
        if (todo.timingStatus !== 'idle') this.store.updateTodo(todo.id, { timingStatus: 'idle' });
      }
      this.store.saveWorkTimerRuntime(emptyRuntime());
      return;
    }

    const next: WorkTimerRuntime = {
      ...runtime,
      accumulatedBeforePauseMs: Math.max(0, runtime.accumulatedBeforePauseMs),
      pauseStartedAt: runtime.status === 'paused' ? runtime.pauseStartedAt ?? Date.now() : null,
    };
    this.store.saveWorkTimerRuntime(next);
    this.store.updateTodo(runtime.activeTimerId as string, { timingStatus: next.status });
  }

  /** 本次会话已计时毫秒（不含历史累计）；沿用绝对时间戳，不依赖定时器累加。 */
  private sessionElapsedMs(runtime: WorkTimerRuntime): number {
    if (runtime.status === 'running' && runtime.startedAt !== null) {
      return Math.max(0, runtime.accumulatedBeforePauseMs + (Date.now() - runtime.startedAt));
    }
    if (runtime.status === 'paused') {
      return Math.max(0, runtime.accumulatedBeforePauseMs);
    }
    return 0;
  }
}
