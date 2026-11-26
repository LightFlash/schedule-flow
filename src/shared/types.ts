/**
 * 全局共享类型契约。
 * 主进程 / preload / 渲染层三端唯一数据源，禁止在各端重复定义同名字段。
 * 所有时间戳与时长单位统一为毫秒（number，Date.now() epoch）。
 */

// ===== 基础枚举 =====
export type TimingStatus = 'idle' | 'running' | 'paused';
export type PomodoroStatus = 'idle' | 'running' | 'paused';
export type PomodoroPhase = 'work' | 'break';
export type Granularity = 'day' | 'week' | 'month' | 'year';
export type PushChannel = 'serverchan' | 'pushplus';
export type ViewKey = 'pomodoro' | 'todo' | 'worktimer' | 'summary';

// ===== 多窗口契约 =====
/** 两个真实小窗的唯一标识；IPC payload 必须携带此 key。 */
export type MiniWindowKey = 'pomo' | 'todo';
/** 三窗口共用 index.html，用 query 区分渲染内容。 */
export type WindowType = 'main' | MiniWindowKey;
/** UI 模式唯一数据源在主进程 store，渲染层只做镜像。 */
export type UiMode = 'standard' | 'mini';

/** 单个小窗的几何 / 显示状态（设备无关像素，坐标允许负值以支持多显示器）。 */
export interface WindowGeometry {
  open: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  pinned: boolean;
}

/** 窗口状态快照：由主进程广播给所有渲染窗口。layoutVersion 用于一次性布局迁移。 */
export interface WindowState {
  mode: UiMode;
  layoutVersion?: number;
  windows: Record<MiniWindowKey, WindowGeometry>;
}

/** 运行时收窄：窗口 key 只允许 pomo / todo。 */
export function isMiniWindowKey(value: unknown): value is MiniWindowKey {
  return value === 'pomo' || value === 'todo';
}

// ===== 数据模型 =====
export interface Todo {
  id: string;
  title: string;
  notes: string;
  completed: boolean;
  createdAt: number;
  completedAt: number | null;
  accumulatedMs: number;
  lastTimingAt: number | null;
  timingStatus: TimingStatus;
}

export interface PomodoroConfig {
  workMinutes: number;
  breakMinutes: number;
  rounds: number;
}

/** 四类可推送事件：工作计时开始/停止、番茄工作轮结束/休息结束。 */
export type PushEventKey = 'workStart' | 'workStop' | 'pomodoroWorkEnd' | 'pomodoroBreakEnd';

/** 单个事件的推送配置：独立开关 + 可自定义标题/正文（含 `{var}` 占位符）。 */
export interface PushEventConfig {
  enabled: boolean;
  title: string;
  body: string;
}

/** 模板变量表：值统一字符串化后替换，缺失的 key 视为「未知变量」原样保留。 */
export type PushEventVars = Record<string, string | number | null | undefined>;

export interface PushConfig {
  serverChanKey: string;
  pushPlusToken: string;
  channels: PushChannel[];
  /** 按事件分类型的推送配置；老配置缺失时由 store.ensureShape 补默认值。 */
  events: Record<PushEventKey, PushEventConfig>;
}

export interface Settings {
  push: PushConfig;
  pomodoro: PomodoroConfig;
  autoMarkComplete: boolean;
  /** 退出程序时自动备份配置文件，默认开启。 */
  autoBackup: boolean;
}

export interface PomodoroRecord {
  id: string;
  finishedAt: number;
  round: number;
  workDurationMs: number;
}

// ===== 计时运行态（持久化，支持崩溃恢复）=====
export interface PomodoroRuntime {
  status: PomodoroStatus;
  phase: PomodoroPhase;
  currentRound: number;
  totalRounds: number;
  config: PomodoroConfig;
  phaseStartedAt: number | null;
  pausedRemainingMs: number;
}

/** 活动计时状态：idle 不在运行态里出现，任何 entry 只能是 running / paused。 */
export type ActiveTimingStatus = Exclude<TimingStatus, 'idle'>;

/**
 * 单条工作计时会话（持久化，支持崩溃恢复）。一个 todoId 最多一条。
 * 会话用时唯一公式：running → accumulatedBeforePauseMs + max(0, now - startedAt)；
 * paused → accumulatedBeforePauseMs。禁止用定时器累加。
 */
export interface WorkTimerEntry {
  todoId: string;
  status: ActiveTimingStatus;
  /** 本次 running 段起点；paused 时为 null。 */
  startedAt: number | null;
  /** 本次会话「暂停前」已累计毫秒；暂停期间冻结。 */
  accumulatedBeforePauseMs: number;
  /** 暂停时刻，仅诊断与恢复兜底，不参与结算算术。 */
  pauseStartedAt: number | null;
}

/** v2 运行态：多条计时并存的唯一权威数据源；数组顺序无业务含义（渲染按清单顺序）。 */
export interface WorkTimerRuntime {
  timers: WorkTimerEntry[];
}

/** v1.0.2 遗留的单计时运行态，仅在 store 迁移与恢复旧备份时读取。 */
export interface WorkTimerRuntimeV1 {
  activeTimerId: string | null;
  status: TimingStatus;
  startedAt: number | null;
  accumulatedBeforePauseMs: number;
  pauseStartedAt: number | null;
}

// ===== 持久化根对象 =====
export interface AppData {
  version: number;
  todos: Todo[];
  settings: Settings;
  pomodoroRecords: PomodoroRecord[];
  pomodoroRuntime: PomodoroRuntime;
  workTimerRuntime: WorkTimerRuntime;
  /** 窗口布局是设备相关偏好：可选字段，旧备份缺失时由 ensureShape 补齐。 */
  windows?: WindowState;
}

// ===== 渲染层视图态（由主进程 tick 推送）=====
export interface PomodoroViewState {
  status: PomodoroStatus;
  phase: PomodoroPhase;
  currentRound: number;
  totalRounds: number;
  remainingMs: number;
  totalPhaseMs: number;
  config: PomodoroConfig;
}

/** 单条进行中计时的视图数据（渲染层直接显示，不再自行推算时长）。 */
export interface WorkTimerEntryView {
  todoId: string;
  title: string;
  status: ActiveTimingStatus;
  /** 本次会话用时。 */
  sessionElapsedMs: number;
  /** 历史累计（不含本次）。 */
  accumulatedMs: number;
  /** 两者之和，供「累计 X」直接渲染。 */
  totalAccumulatedMs: number;
}

/** 工作计时视图态：进行中项数组，顺序与 TODO 清单一致。 */
export interface WorkTimerViewState {
  entries: WorkTimerEntryView[];
  totalSessionElapsedMs: number;
}

// ===== 汇总 =====
export interface SummaryItem {
  todoId: string;
  title: string;
  archivedAt: number;
  accumulatedMs: number;
  completed: boolean;
  notesPreview: string;
}

export interface Summary {
  granularity: Granularity;
  periodKey: string;
  periodStart: number;
  periodEnd: number;
  completedCount: number;
  totalWorkMs: number;
  completedPomodoroRounds: number;
  items: SummaryItem[];
}

// ===== IPC 通用返回 =====
export interface IpcResult<T = unknown> {
  ok: boolean;
  data?: T;
  message?: string;
}

export interface PushResult {
  channel: PushChannel;
  ok: boolean;
  message: string;
}

export interface ReminderPayload {
  phase: PomodoroPhase;
  title: string;
  message: string;
  /**
   * 触发本次提醒的推送事件；缺省时沿用「直接用 title/message 推送」的旧行为
   * （兼容手动提醒与历史调用方）。
   */
  event?: PushEventKey;
  /** 事件模板变量（round / breakMinutes / workMinutes 等）。 */
  vars?: PushEventVars;
}

// ===== IPC 载荷类型 =====
/** TODO 可更新字段（id 不可变，其余均可局部更新）。 */
export type TodoPatch = Partial<Omit<Todo, 'id'>>;

export interface TodoAddPayload {
  title: string;
}

export interface TodoUpdatePayload {
  id: string;
  patch: TodoPatch;
}

/** 调整工作项顺序：offset -1 上移 / 1 下移。 */
export interface TodoMovePayload {
  id: string;
  offset: -1 | 1;
}

/** 拖拽排序：提交拖拽后的完整新顺序（id 集合必须与现有清单一致）。 */
export interface TodoReorderPayload {
  ids: string[];
}

export interface IdPayload {
  id: string;
}

export interface SettingsSavePayload {
  settings: Settings;
}

/** 数据导入载荷：整份 AppData 由渲染层读取 JSON 后传入。 */
export interface DataImportPayload {
  data: AppData;
}

/** 自动备份开关载荷。 */
export interface AutoBackupSetPayload {
  enabled: boolean;
}

/** 小窗置顶开关载荷：由整体联动改为按 windowKey 独立控制。 */
export interface WindowPinnedPayload {
  windowKey: MiniWindowKey;
  pinned: boolean;
}

/** 单小窗开关载荷。 */
export interface WindowKeyPayload {
  windowKey: MiniWindowKey;
}

/** 单小窗几何调整载荷，bounds 只允许局部字段。 */
export interface MiniWindowBoundsPayload {
  windowKey: MiniWindowKey;
  bounds: Partial<Pick<WindowGeometry, 'x' | 'y' | 'width' | 'height'>>;
}

/** 开机自启动开关载荷（唯一数据源是 OS 登录项，不是 Settings）。 */
export interface AutoLaunchSetPayload {
  enabled: boolean;
}

/** 开机自启动状态：enabled 为操作系统登录项真实状态（开发模式回显请求值）。 */
export interface AutoLaunchState {
  enabled: boolean;
  /** 开发模式下跳过实际 OS 写入时的提示文案。 */
  message?: string;
}

/** 导出结果：JSON 文本 + 建议文件名。 */
export interface DataExportResult {
  json: string;
  fileName: string;
}

export interface TestPushPayload {
  settings?: Settings;
}

/** 工作计时命令统一载荷：所有命令都必须指明作用于哪一项。 */
export interface WorkTargetPayload {
  todoId: string;
}

export interface ConfigUpdatePayload {
  config: PomodoroConfig;
}

/** 250ms tick 事件载荷。 */
export interface TickPayload {
  pomodoro: PomodoroViewState;
  workTimer: WorkTimerViewState;
}

/** `data:changed` 事件载荷（仅作为通知，具体数据由渲染层重新拉取）。 */
export interface DataChangedPayload {
  reason?: string;
}

/** `pomodoro:allDone` 事件载荷。 */
export interface PomodoroAllDonePayload {
  message: string;
}

// ===== preload 暴露给渲染层的受控 API =====
export type IpcEventHandler = (payload: unknown) => void;

export interface ElectronApi {
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<IpcResult<T>>;
  on(channel: string, handler: IpcEventHandler): () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronApi;
  }
}
