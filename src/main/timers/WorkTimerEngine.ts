/**
 * 工作计时引擎（主进程权威，支持多任务并发计时）。
 *
 * 每条 entry 独立状态机：idle → running ⇄ paused → idle，互不影响。
 * 权威数据只在 runtime（时间戳），`Todo.timingStatus` 是镜像，每次状态转换同步写入。
 * 不变式：`todo.timingStatus !== 'idle'` ⟺ runtime 中存在该 todoId 的 entry 且状态一致。
 *
 * 会话用时只由 `startedAt / accumulatedBeforePauseMs` 推导（见 shared/workTimerRuntime），
 * 任何情况下都不靠定时器累加，因此崩溃恢复后按 Date.now() 真实经过时间自然补齐。
 */

import {
  emptyWorkTimerRuntime,
  findWorkTimerEntry,
  normalizeWorkTimerRuntime,
  sessionElapsedMsOf,
  timingStatusOf,
} from '@shared/workTimerRuntime';
import { formatPushTime } from '@shared/pushTemplate';
import { formatDuration } from '@shared/time';
import type {
  IpcResult,
  PushEventKey,
  PushEventVars,
  PushResult,
  TimingStatus,
  Todo,
  WorkTimerEntry,
  WorkTimerEntryView,
  WorkTimerRuntime,
  WorkTimerRuntimeV1,
  WorkTimerViewState,
} from '@shared/types';
import type { StoreService } from '../store';
import type { PushSender } from '../services/pushService';

/** 结算结果摘要：既用于写回 TODO，也用于拼装 workStop 推送模板变量。 */
interface SettledSummary {
  task: string;
  sessionMs: number;
  totalMs: number;
}

export class WorkTimerEngine {
  /**
   * @param store 主进程唯一数据源
   * @param push 事件推送（可选）：未注入时引擎完全不发推送，计时逻辑不变。
   */
  constructor(
    private readonly store: StoreService,
    private readonly push: PushSender | null = null,
  ) {}

  /**
   * 开始 / 继续指定工作项。
   * - 无 entry：新建一条并「新开置顶」（仅 idle → running 的首次开始才置顶）；
   * - paused：等价于继续，累计保留，**不置顶**；
   * - running：幂等空操作，不重置 startedAt、不产生第二条会话。
   */
  start(todoId: string): IpcResult<string> {
    const todo = this.store.getTodos().find((item) => item.id === todoId);
    if (!todo) return { ok: false, message: '工作项不存在或已被删除' };
    if (todo.completed) return { ok: false, message: '已完成的工作项不可计时' };

    const runtime = this.readRuntime();
    const existing = findWorkTimerEntry(runtime, todoId);
    if (existing !== undefined && existing.status === 'running') {
      return { ok: true, message: '该项正在计时中' };
    }
    if (existing !== undefined && existing.status === 'paused') {
      this.resume(todoId);
      return { ok: true, message: '已继续计时' };
    }

    const now = Date.now();
    const entry: WorkTimerEntry = {
      todoId,
      status: 'running',
      startedAt: now,
      accumulatedBeforePauseMs: 0,
      pauseStartedAt: null,
    };
    this.saveRuntime({ timers: [...runtime.timers, entry] });
    this.store.updateTodo(todoId, { timingStatus: 'running' });
    // 新开计时自动置顶（移到计时区块最上方），其它项相对顺序不变。
    this.store.moveTodoToTimerBlockTop(todoId);
    // 只有 idle → running 的「首次开始」推送；暂停后继续（resume 分支）不发。
    this.notifyEvent('workStart', { task: todo.title, time: formatPushTime(now) });
    return { ok: true, message: '已开始计时' };
  }

  /** 暂停指定项；非 running（含目标已消失）幂等成功，不影响其它计时。 */
  pause(todoId: string): IpcResult<void> {
    const runtime = this.readRuntime();
    const entry = findWorkTimerEntry(runtime, todoId);
    if (entry === undefined || entry.status !== 'running') return { ok: true };
    if (!this.hasTodo(todoId)) {
      // 悬空 entry：静默清理，避免留下永远无法结算的运行态。
      this.saveRuntime({ timers: runtime.timers.filter((item) => item.todoId !== todoId) });
      return { ok: true };
    }

    const now = Date.now();
    const paused: WorkTimerEntry = {
      ...entry,
      status: 'paused',
      startedAt: null,
      accumulatedBeforePauseMs: Math.max(0, sessionElapsedMsOf(entry, now)),
      pauseStartedAt: now,
    };
    this.saveRuntime(this.replaceEntry(runtime, paused));
    this.store.updateTodo(todoId, { timingStatus: 'paused' });
    return { ok: true };
  }

  /** 继续指定项；非 paused（含目标已消失）幂等成功，不改变清单顺序。 */
  resume(todoId: string): IpcResult<void> {
    const runtime = this.readRuntime();
    const entry = findWorkTimerEntry(runtime, todoId);
    if (entry === undefined || entry.status !== 'paused') return { ok: true };
    if (!this.hasTodo(todoId)) {
      this.saveRuntime({ timers: runtime.timers.filter((item) => item.todoId !== todoId) });
      return { ok: true };
    }

    const resumed: WorkTimerEntry = {
      ...entry,
      status: 'running',
      startedAt: Date.now(),
      pauseStartedAt: null,
    };
    this.saveRuntime(this.replaceEntry(runtime, resumed));
    this.store.updateTodo(todoId, { timingStatus: 'running' });
    return { ok: true };
  }

  /** 停止指定项并结算：累计用时写回 TODO，清空该项运行态；其它计时完全不受影响。 */
  stop(todoId: string): IpcResult<void> {
    const runtime = this.readRuntime();
    const entry = findWorkTimerEntry(runtime, todoId);
    if (entry === undefined) return { ok: true };

    this.saveRuntime({ timers: runtime.timers.filter((item) => item.todoId !== todoId) });
    const now = Date.now();
    this.notifyWorkStop(this.settle(entry, now), now);
    return { ok: true };
  }

  /** 全部停止：逐条结算，返回实际结算条数（0 = 本来没有计时）。 */
  stopAll(): IpcResult<number> {
    const runtime = this.readRuntime();
    const entries = runtime.timers;
    if (entries.length === 0) return { ok: true, data: 0 };

    // 先一次性清空运行态，再逐条结算：即使中途某条目标已消失，也不会残留运行态。
    this.saveRuntime(emptyWorkTimerRuntime());
    const now = Date.now();
    for (const entry of entries) {
      // 每条都算一次 workStop：全部停止是用户显式终止，与单项停止语义一致。
      this.notifyWorkStop(this.settle(entry, now), now);
    }
    return { ok: true, data: entries.length };
  }

  /**
   * 供 250ms tick 与首屏共用的视图态：按 TODO 清单顺序输出进行中项。
   * runtime 中指向已删除工作项的条目不会出现在视图里（restore 会清理）。
   */
  getViewState(): WorkTimerViewState {
    const runtime = this.readRuntime();
    const todos = this.store.getTodos();
    const now = Date.now();
    const byTodoId = new Map(runtime.timers.map((entry) => [entry.todoId, entry]));
    const entries: WorkTimerEntryView[] = [];
    let totalSessionElapsedMs = 0;

    for (const todo of todos) {
      const entry = byTodoId.get(todo.id);
      if (entry === undefined) continue;
      const sessionElapsedMs = sessionElapsedMsOf(entry, now);
      entries.push({
        todoId: todo.id,
        title: todo.title,
        status: entry.status,
        sessionElapsedMs,
        accumulatedMs: todo.accumulatedMs,
        totalAccumulatedMs: todo.accumulatedMs + sessionElapsedMs,
      });
      totalSessionElapsedMs += sessionElapsedMs;
    }

    return { entries, totalSessionElapsedMs };
  }

  /**
   * 启动恢复 / 导入恢复（幂等）：逐条校验，坏条目只丢自己，不牵连其它。
   * - 悬空 todoId、已完成工作项、running 缺 startedAt → 丢弃该条；
   * - running 用真实经过时间（含程序关闭期间），未来时间戳收敛为 now；
   * - paused 用暂停前累计值，缺 pauseStartedAt 时补 now；
   * - 最后按清单顺序重排 runtime，并把 `Todo.timingStatus` 全量对齐。
   */
  restore(raw: WorkTimerRuntime | WorkTimerRuntimeV1 | null): void {
    const runtime = normalizeWorkTimerRuntime(raw);
    const todos = this.store.getTodos();
    const byTodoId = new Map(todos.map((todo) => [todo.id, todo]));
    const now = Date.now();
    const seen = new Set<string>();
    const kept: WorkTimerEntry[] = [];

    for (const entry of runtime.timers) {
      const todo = byTodoId.get(entry.todoId);
      if (todo === undefined || todo.completed) continue;
      if (seen.has(entry.todoId)) continue;

      if (entry.status === 'running') {
        // 校验通过后才登记去重键：坏条目不算「已占用」，将来放宽去重时不会误丢合法条目。
        if (entry.startedAt === null) continue;
        seen.add(entry.todoId);
        kept.push({
          ...entry,
          startedAt: Math.min(entry.startedAt, now),
          accumulatedBeforePauseMs: Math.max(0, entry.accumulatedBeforePauseMs),
          pauseStartedAt: null,
        });
      } else {
        seen.add(entry.todoId);
        kept.push({
          ...entry,
          startedAt: null,
          accumulatedBeforePauseMs: Math.max(0, entry.accumulatedBeforePauseMs),
          pauseStartedAt: entry.pauseStartedAt ?? now,
        });
      }
    }

    // 顺序与清单对齐（runtime 顺序无业务含义，仅保持稳定便于调试）。
    const orderIndex = new Map(todos.map((todo, index) => [todo.id, index]));
    kept.sort(
      (left, right) => (orderIndex.get(left.todoId) ?? 0) - (orderIndex.get(right.todoId) ?? 0),
    );
    this.saveRuntime({ timers: kept });

    const keptByTodoId = new Map(kept.map((entry) => [entry.todoId, entry]));
    for (const todo of todos) {
      const want: TimingStatus = timingStatusOf(keptByTodoId.get(todo.id));
      if (todo.timingStatus !== want) this.store.updateTodo(todo.id, { timingStatus: want });
    }
  }

  // ===== 内部工具 =====

  /** 读取运行态并归一化：即使 config.json 被外部改坏也不会让引擎崩掉。 */
  private readRuntime(): WorkTimerRuntime {
    return normalizeWorkTimerRuntime(this.store.getAppData().workTimerRuntime);
  }

  private saveRuntime(runtime: WorkTimerRuntime): void {
    this.store.saveWorkTimerRuntime({ timers: runtime.timers.map((entry) => ({ ...entry })) });
  }

  private replaceEntry(runtime: WorkTimerRuntime, next: WorkTimerEntry): WorkTimerRuntime {
    return {
      timers: runtime.timers.map((entry) => (entry.todoId === next.todoId ? next : entry)),
    };
  }

  private hasTodo(todoId: string): boolean {
    return this.store.getTodos().some((todo) => todo.id === todoId);
  }

  /**
   * 单条结算：`accumulatedMs += 本次会话`、写 `lastTimingAt`、`timingStatus=idle`；
   * autoMarkComplete 只对触发结算的这一项生效并沉底。
   * 返回本次/累计用时摘要（供 workStop 推送），目标已消失时返回 null。
   */
  private settle(entry: WorkTimerEntry, now: number): SettledSummary | null {
    const todo: Todo | undefined = this.store
      .getTodos()
      .find((item) => item.id === entry.todoId);
    if (todo === undefined) return null;

    const sessionMs = sessionElapsedMsOf(entry, now);
    const totalMs = todo.accumulatedMs + sessionMs;
    const autoMarkComplete = this.store.getSettings().autoMarkComplete;
    this.store.updateTodo(todo.id, {
      accumulatedMs: todo.accumulatedMs + sessionMs,
      lastTimingAt: now,
      timingStatus: 'idle',
      ...(autoMarkComplete ? { completed: true, completedAt: now } : {}),
    });
    // 开启 autoMarkComplete 时停止即完成，与勾选完成行为一致地沉底。
    if (autoMarkComplete) this.store.moveTodoToEnd(todo.id);
    return { task: todo.title, sessionMs, totalMs };
  }

  /**
   * 统一的 workStop 推送入口：单项停止 / 全部停止 / 勾选完成（IPC 里调用 stop）
   * 三条路径都经由 settle → notifyWorkStop，文案与变量口径完全一致。
   */
  private notifyWorkStop(settled: SettledSummary | null, now: number): void {
    if (settled === null) return;
    this.notifyEvent('workStop', {
      task: settled.task,
      session: formatDuration(settled.sessionMs),
      total: formatDuration(settled.totalMs),
      time: formatPushTime(now),
    });
  }

  /**
   * fire-and-forget 推送：绝不同步等待网络，也绝不因推送异常影响计时。
   * 事件未启用 / 未配置渠道由 PushService.sendEvent 直接返回空数组，这里不重复判断。
   */
  private notifyEvent(event: PushEventKey, vars: PushEventVars): void {
    if (this.push === null) return;
    const sendEvent = this.push.sendEvent;
    if (typeof sendEvent !== 'function') return;
    try {
      const settings = this.store.getSettings();
      void sendEvent
        .call(this.push, settings.push, event, vars)
        .then((results: PushResult[]) => {
          const failed = results.filter((item) => !item.ok);
          if (failed.length > 0) {
            console.warn('[WorkTimerEngine] 推送未全部成功：', failed);
          }
        })
        .catch((error: unknown) => {
          console.warn('[WorkTimerEngine] 推送异常已被吞掉：', error);
        });
    } catch (error) {
      // 同步抛出（例如设置读取失败）同样不影响计时。
      console.warn('[WorkTimerEngine] 推送调用失败已被吞掉：', error);
    }
  }
}
