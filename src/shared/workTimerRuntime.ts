/**
 * 工作计时运行态纯函数工具（无 Electron / React 依赖，主进程与测试共用）。
 *
 * 唯一职责：
 * 1. 把任意来源（旧版本 config.json、导入的旧备份、被外部改坏的脏数据）
 *    净化成 v2 的 `{ timers: WorkTimerEntry[] }`；
 * 2. 提供会话用时公式与按 todoId 查找。
 *
 * 迁移入口只有一个：`StoreService.ensureShape()` 调用 `normalizeWorkTimerRuntime`，
 * 引擎内部也复用同一函数做读取兜底，禁止在别处再写一份迁移逻辑。
 */

import type {
  ActiveTimingStatus,
  TimingStatus,
  WorkTimerEntry,
  WorkTimerRuntime,
} from './types';

/** 空运行态（新建常量，避免调用方共享同一个可变对象）。 */
export function emptyWorkTimerRuntime(): WorkTimerRuntime {
  return { timers: [] };
}

/** 合法的 activity 状态；其余值一律视为非法。 */
function toActiveStatus(value: unknown): ActiveTimingStatus | null {
  return value === 'running' || value === 'paused' ? value : null;
}

/** 有限数字才接受；其它（undefined / NaN / 字符串）回退到 fallback。 */
function toFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value;
}

/** 时间戳：只接受有限正数，否则为 null（零点与负值都无意义）。 */
function toTimestamp(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * 净化单条 entry；结构非法（缺 todoId / 状态不合法）返回 null 表示丢弃该条。
 * 注意：running 缺 startedAt 时**保留**条目（startedAt 置 null），由引擎 restore 决定丢弃，
 * 这样「结构净化」与「业务校验」职责分离，迁移不会吞掉信息。
 */
function sanitizeEntry(raw: unknown): WorkTimerEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as Partial<Record<keyof WorkTimerEntry, unknown>>;
  const todoId = typeof source.todoId === 'string' ? source.todoId.trim() : '';
  if (todoId.length === 0) return null;
  const status = toActiveStatus(source.status);
  if (status === null) return null;
  const accumulatedBeforePauseMs = Math.max(
    0,
    toFiniteNumber(source.accumulatedBeforePauseMs, 0),
  );
  if (status === 'running') {
    return {
      todoId,
      status,
      startedAt: toTimestamp(source.startedAt),
      accumulatedBeforePauseMs,
      pauseStartedAt: null,
    };
  }
  return {
    todoId,
    status,
    startedAt: null,
    accumulatedBeforePauseMs,
    pauseStartedAt: toTimestamp(source.pauseStartedAt),
  };
}

/** v1 单计时运行态 → 0 或 1 条 entry；累计值原样保留。 */
function fromLegacyRuntime(raw: Record<string, unknown>): WorkTimerRuntime {
  const activeTimerId = typeof raw.activeTimerId === 'string' ? raw.activeTimerId.trim() : '';
  const status = toActiveStatus(raw.status);
  // idle / 空 activeTimerId / 缺失字段：v1 本来就没有计时，等价于空 v2。
  if (activeTimerId.length === 0 || status === null) return emptyWorkTimerRuntime();
  const entry = sanitizeEntry({
    todoId: activeTimerId,
    status,
    startedAt: raw.startedAt,
    accumulatedBeforePauseMs: raw.accumulatedBeforePauseMs,
    pauseStartedAt: raw.pauseStartedAt,
  });
  return entry === null ? emptyWorkTimerRuntime() : { timers: [entry] };
}

/**
 * 运行态归一化（v1 → v2 + 结构净化 + 按 todoId 去重）。
 * - 有 `timers` 数组 → 逐条净化（这是 v2 的结构判定，与 version 号无关）；
 * - 否则视为 v1 单计时结构 → 转 0 或 1 条；
 * - 其它（null / 非对象 / 空对象）→ 空运行态。
 */
export function normalizeWorkTimerRuntime(raw: unknown): WorkTimerRuntime {
  if (typeof raw !== 'object' || raw === null) return emptyWorkTimerRuntime();
  const source = raw as Record<string, unknown>;

  if (Array.isArray(source.timers)) {
    const seen = new Set<string>();
    const timers: WorkTimerEntry[] = [];
    for (const item of source.timers) {
      const entry = sanitizeEntry(item);
      if (entry === null) continue;
      // 不变式：一个工作项最多一条计时，重复项保留首次出现的。
      if (seen.has(entry.todoId)) continue;
      seen.add(entry.todoId);
      timers.push(entry);
    }
    return { timers };
  }

  return fromLegacyRuntime(source);
}

/** 按 todoId 查找进行中的计时条目。 */
export function findWorkTimerEntry(
  runtime: WorkTimerRuntime,
  todoId: string,
): WorkTimerEntry | undefined {
  return runtime.timers.find((entry) => entry.todoId === todoId);
}

/**
 * 会话用时（不含历史累计）。
 * running → accumulatedBeforePauseMs + max(0, now - startedAt)；paused → accumulatedBeforePauseMs。
 * 时间戳异常（未来时间 / null）只做「负数归零」，绝不截断已计时间。
 */
export function sessionElapsedMsOf(entry: WorkTimerEntry, now: number): number {
  if (entry.status === 'running' && entry.startedAt !== null) {
    return Math.max(0, entry.accumulatedBeforePauseMs + Math.max(0, now - entry.startedAt));
  }
  return Math.max(0, entry.accumulatedBeforePauseMs);
}

/** 单条 entry 的镜像状态（供 Todo.timingStatus 对齐使用）。 */
export function timingStatusOf(entry: WorkTimerEntry | undefined): TimingStatus {
  return entry === undefined ? 'idle' : entry.status;
}
