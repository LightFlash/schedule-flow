/**
 * 主进程唯一数据源封装：electron-store（底层 conf，临时文件 + rename 原子替换）。
 * 所有写操作在此收敛，业务数据变更后向所有窗口广播 DATA_CHANGED。
 * 窗口布局（windows）同属权威数据，但 mode/geometry 变更不触发业务刷新广播，
 * 由 WindowManager 通过 WINDOW_STATE_CHANGED 单独同步。
 */

import { app, BrowserWindow } from 'electron';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Store from 'electron-store';
import { IpcEvent } from '@shared/ipcChannels';
import { createDefaultPushEvents, normalizePushEvents } from '@shared/pushTemplate';
import { createId } from '@shared/time';
import { emptyWorkTimerRuntime, normalizeWorkTimerRuntime } from '@shared/workTimerRuntime';
import type { DataExportResult } from '@shared/types';
import type {
  AppData,
  MiniWindowKey,
  PomodoroConfig,
  PomodoroRecord,
  PomodoroRuntime,
  PushChannel,
  Settings,
  Todo,
  TodoPatch,
  UiMode,
  WindowGeometry,
  WindowState,
  WorkTimerRuntime,
} from '@shared/types';

/** electron-store 的泛型约束为 Record<string, any>，交叉索引签名以满足约束。 */
type StoreShape = AppData & Record<string, unknown>;

/** 小窗最小尺寸与脏数据边界；坐标允许负值以覆盖多显示器负坐标工作区。 */
const MIN_WINDOW_WIDTH = 260;
const MIN_WINDOW_HEIGHT = 200;
const MAX_COORD = 100000;
const MAX_DIMENSION = 100000;

/**
 * 布局版本：旧数据（无标记或版本更低）在首次启动时整体重置为当前默认布局。
 * 版本内用户手动调整过的 geometry / pinned / open 一律尊重，不再覆盖。
 */
const LAYOUT_VERSION = 3;

/** 返回一份全新的默认数据结构。 */
export function createDefaultData(): AppData {
  const pomodoroConfig: PomodoroConfig = { workMinutes: 25, breakMinutes: 5, rounds: 4 };
  return {
    version: 1,
    todos: [],
    settings: {
      push: {
        serverChanKey: '',
        pushPlusToken: '',
        channels: [],
        events: createDefaultPushEvents(),
      },
      pomodoro: { ...pomodoroConfig },
      autoMarkComplete: false,
      autoBackup: true,
    },
    pomodoroRecords: [],
    pomodoroRuntime: {
      status: 'idle',
      phase: 'work',
      currentRound: 1,
      totalRounds: pomodoroConfig.rounds,
      config: { ...pomodoroConfig },
      phaseStartedAt: null,
      pausedRemainingMs: 0,
    },
    workTimerRuntime: emptyWorkTimerRuntime(),
    windows: {
      mode: 'standard',
      layoutVersion: LAYOUT_VERSION,
      windows: {
        pomo: { open: false, x: 24, y: 24, width: 280, height: 340, pinned: false },
        todo: { open: false, x: 324, y: 24, width: 300, height: 380, pinned: false },
      },
    },
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function isWindowState(value: unknown): value is WindowState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Partial<WindowState>;
  return (
    (state.mode === 'standard' || state.mode === 'mini') &&
    typeof state.windows === 'object' &&
    state.windows !== null
  );
}

/** 兼容旧配置：补齐缺失字段，并把有限数/范围非法值收敛到安全区间。 */
function normalizeWindowGeometry(
  raw: Partial<WindowGeometry> | undefined,
  fallback: WindowGeometry,
): WindowGeometry {
  return {
    open: typeof raw?.open === 'boolean' ? raw.open : fallback.open,
    x: clampNumber(raw?.x, fallback.x, -MAX_COORD, MAX_COORD),
    y: clampNumber(raw?.y, fallback.y, -MAX_COORD, MAX_COORD),
    width: clampNumber(raw?.width, fallback.width, MIN_WINDOW_WIDTH, MAX_DIMENSION),
    height: clampNumber(raw?.height, fallback.height, MIN_WINDOW_HEIGHT, MAX_DIMENSION),
    pinned: typeof raw?.pinned === 'boolean' ? raw.pinned : fallback.pinned,
  };
}

/**
 * @param raw 当前 store 里的值（可能是旧结构 / 脏数据）
 * @param fallback createDefaultData() 的默认值
 * @param override 导入恢复时传入的「本地布局覆盖」，优先于 raw
 */
function normalizeWindowState(
  raw: unknown,
  fallback: WindowState,
  override?: WindowState,
): WindowState {
  const source = override ?? (isWindowState(raw) ? raw : fallback);
  // 布局版本不匹配（旧数据 / 无标记）时一次性重置为默认布局并打上当前版本。
  if (source.layoutVersion !== LAYOUT_VERSION) {
    return {
      mode: 'standard',
      layoutVersion: LAYOUT_VERSION,
      windows: {
        pomo: { ...fallback.windows.pomo },
        todo: { ...fallback.windows.todo },
      },
    };
  }
  return {
    mode: source.mode === 'mini' ? 'mini' : 'standard',
    layoutVersion: source.layoutVersion,
    windows: {
      pomo: normalizeWindowGeometry(source.windows?.pomo, fallback.windows.pomo),
      todo: normalizeWindowGeometry(source.windows?.todo, fallback.windows.todo),
    },
  };
}

export class StoreService {
  private readonly store: Store<StoreShape>;

  constructor() {
    this.store = new Store<StoreShape>({
      name: 'config',
      defaults: createDefaultData() as StoreShape,
    });
    this.ensureShape();
  }

  /**
   * 兼容性兜底：外部文件缺字段 / 旧版本结构时，用默认值补齐并回写。
   * 崩溃恢复依赖运行态字段存在，此步骤保证后续逻辑不会读到 undefined。
   */
  private ensureShape(localWindows?: WindowState): void {
    const defaults = createDefaultData();
    const current = this.store.store as unknown as Partial<AppData>;
    const merged: AppData = {
      version: typeof current.version === 'number' ? current.version : defaults.version,
      todos: Array.isArray(current.todos) ? current.todos : defaults.todos,
      settings: {
        push: {
          serverChanKey:
            typeof current.settings?.push?.serverChanKey === 'string'
              ? current.settings.push.serverChanKey
              : defaults.settings.push.serverChanKey,
          pushPlusToken:
            typeof current.settings?.push?.pushPlusToken === 'string'
              ? current.settings.push.pushPlusToken
              : defaults.settings.push.pushPlusToken,
          channels: Array.isArray(current.settings?.push?.channels)
            ? current.settings.push.channels.filter(
                (channel): channel is PushChannel =>
                  channel === 'serverchan' || channel === 'pushplus',
              )
            : defaults.settings.push.channels,
          // 老配置（v1.0.3 及以前）没有 events 字段：整体落到默认模板；
          // 已有配置只补缺失字段，用户填写过的标题/正文/开关一律保留。
          events: normalizePushEvents(current.settings?.push?.events),
        },
        pomodoro: {
          workMinutes: clampNumber(
            current.settings?.pomodoro?.workMinutes,
            defaults.settings.pomodoro.workMinutes,
            1,
            240,
          ),
          breakMinutes: clampNumber(
            current.settings?.pomodoro?.breakMinutes,
            defaults.settings.pomodoro.breakMinutes,
            1,
            120,
          ),
          rounds: clampNumber(
            current.settings?.pomodoro?.rounds,
            defaults.settings.pomodoro.rounds,
            1,
            20,
          ),
        },
        autoMarkComplete:
          typeof current.settings?.autoMarkComplete === 'boolean'
            ? current.settings.autoMarkComplete
            : defaults.settings.autoMarkComplete,
        autoBackup:
          typeof current.settings?.autoBackup === 'boolean'
            ? current.settings.autoBackup
            : defaults.settings.autoBackup,
      },
      pomodoroRecords: Array.isArray(current.pomodoroRecords)
        ? current.pomodoroRecords
        : defaults.pomodoroRecords,
      pomodoroRuntime: {
        ...defaults.pomodoroRuntime,
        ...(current.pomodoroRuntime ?? {}),
        config: {
          ...defaults.pomodoroRuntime.config,
          ...(current.pomodoroRuntime?.config ?? {}),
        },
      },
      // 运行态唯一迁移入口：v1 单计时 → v2 多条计时，累计值原样保留。
      workTimerRuntime: normalizeWorkTimerRuntime(current.workTimerRuntime),
      windows: normalizeWindowState(
        current.windows,
        defaults.windows as WindowState,
        localWindows,
      ),
    };
    if (JSON.stringify(merged) !== JSON.stringify(current)) {
      this.store.store = merged as StoreShape;
    }
  }

  /** 返回深拷贝快照，避免调用方直接修改内存中的 store。 */
  getAppData(): AppData {
    return clone(this.store.store) as AppData;
  }

  getTodos(): Todo[] {
    return clone(this.store.get('todos'));
  }

  getSettings(): Settings {
    return clone(this.store.get('settings'));
  }

  addTodo(rawTitle: string): Todo {
    const title = rawTitle.trim();
    if (title.length === 0) throw new Error('工作项标题不能为空');
    const now = Date.now();
    const todo: Todo = {
      id: createId(),
      title,
      notes: '',
      completed: false,
      createdAt: now,
      completedAt: null,
      accumulatedMs: 0,
      lastTimingAt: null,
      timingStatus: 'idle',
    };
    // 新任务插到「全部进行中计时项」与其余任务之间，保证计时区块完整；
    // 无计时任务时放最顶（P1-3）。
    const todos = [...this.store.get('todos')];
    let lastActiveIndex = -1;
    todos.forEach((item, index) => {
      if (item.timingStatus !== 'idle') lastActiveIndex = index;
    });
    const insertAt = lastActiveIndex >= 0 ? lastActiveIndex + 1 : 0;
    todos.splice(insertAt, 0, todo);
    this.store.set('todos', todos);
    this.persistAndBroadcast();
    return todo;
  }

  updateTodo(id: string, patch: TodoPatch): Todo {
    const todos = this.store.get('todos');
    const index = todos.findIndex((todo) => todo.id === id);
    if (index < 0) throw new Error('工作项不存在或已被删除');
    const updated: Todo = { ...todos[index], ...patch, id };
    const next = [...todos];
    next[index] = updated;
    this.store.set('todos', next);
    this.persistAndBroadcast();
    return updated;
  }

  deleteTodo(id: string): void {
    const next = this.store.get('todos').filter((todo) => todo.id !== id);
    this.store.set('todos', next);
    this.persistAndBroadcast();
  }

  /** 调整工作项顺序：offset -1 上移 / 1 下移；越界静默忽略。 */
  moveTodo(id: string, offset: -1 | 1): void {
    const todos = this.store.get('todos');
    const index = todos.findIndex((todo) => todo.id === id);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= todos.length) return;
    const next = [...todos];
    [next[index], next[target]] = [next[target], next[index]];
    this.store.set('todos', next);
    this.persistAndBroadcast();
  }

  /** 完成后自动沉底：把指定工作项移到清单末尾。 */
  moveTodoToEnd(id: string): void {
    const todos = this.store.get('todos');
    const index = todos.findIndex((todo) => todo.id === id);
    if (index < 0 || index === todos.length - 1) return;
    const next = [...todos];
    const [item] = next.splice(index, 1);
    next.push(item);
    this.store.set('todos', next);
    this.persistAndBroadcast();
  }

  /**
   * 新开计时置顶：把指定工作项移到「计时区块」顶部，即第一个非 idle 项之前；
   * 没有其它计时项时移到清单最顶（index 0）。暂停 / 继续 / 重复 start 均不调用此方法。
   * 注意：调用方需先把该项 `timingStatus` 置为 running，自身因此不算「其它计时项」。
   */
  moveTodoToTimerBlockTop(id: string): void {
    const todos = this.store.get('todos');
    const index = todos.findIndex((todo) => todo.id === id);
    if (index < 0) return;
    const next = [...todos];
    const [item] = next.splice(index, 1);
    const firstActiveIndex = next.findIndex((todo) => todo.timingStatus !== 'idle');
    const insertAt = firstActiveIndex >= 0 ? firstActiveIndex : 0;
    if (insertAt === index) return;
    next.splice(insertAt, 0, item);
    this.store.set('todos', next);
    this.persistAndBroadcast();
  }

  /** 取消完成后归位：移到未完成区的末尾（第一个已完成项之前）。 */
  moveTodoToUncompletedEnd(id: string): void {
    const todos = this.store.get('todos');
    const index = todos.findIndex((todo) => todo.id === id);
    if (index < 0) return;
    const next = [...todos];
    const [item] = next.splice(index, 1);
    const firstCompleted = next.findIndex((todo) => todo.completed);
    if (firstCompleted < 0) next.push(item);
    else next.splice(firstCompleted, 0, item);
    this.store.set('todos', next);
    this.persistAndBroadcast();
  }

  /**
   * 排序：按提交的 id 顺序重排这些项的相对位置，未列入的项（如隔天完成的折叠项）
   * 保持原有相对位置；id 重复 / 未知 / 空数组时拒绝。
   */
  reorderTodos(ids: string[]): void {
    const todos = this.store.get('todos');
    if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length) {
      throw new Error('排序数据不合法');
    }
    const byId = new Map(todos.map((todo) => [todo.id, todo]));
    if (ids.some((id) => !byId.has(id))) {
      throw new Error('排序数据与清单不一致');
    }
    const listed = new Set(ids);
    let cursor = 0;
    const next = todos.map((todo) => (listed.has(todo.id) ? byId.get(ids[cursor++]) as (typeof todos)[number] : todo));
    this.store.set('todos', next);
    this.persistAndBroadcast();
  }

  toggleTodo(id: string): Todo {
    const todos = this.store.get('todos');
    const target = todos.find((todo) => todo.id === id);
    if (!target) throw new Error('工作项不存在或已被删除');
    const now = Date.now();
    const completed = !target.completed;
    return this.updateTodo(id, {
      completed,
      completedAt: completed ? now : null,
    });
  }

  saveSettings(input: Settings): Settings {
    const normalized: Settings = {
      push: {
        serverChanKey: typeof input?.push?.serverChanKey === 'string' ? input.push.serverChanKey : '',
        pushPlusToken: typeof input?.push?.pushPlusToken === 'string' ? input.push.pushPlusToken : '',
        channels: Array.isArray(input?.push?.channels)
          ? input.push.channels.filter(
              (channel): channel is PushChannel =>
                channel === 'serverchan' || channel === 'pushplus',
            )
          : [],
        // 事件配置逐字段补全：界面传来的草稿可能来自旧数据（缺 events / 少某个事件）。
        events: normalizePushEvents(input?.push?.events),
      },
      pomodoro: {
        workMinutes: clampNumber(input?.pomodoro?.workMinutes, 25, 1, 240),
        breakMinutes: clampNumber(input?.pomodoro?.breakMinutes, 5, 1, 120),
        rounds: clampNumber(input?.pomodoro?.rounds, 4, 1, 20),
      },
      autoMarkComplete: Boolean(input?.autoMarkComplete),
      autoBackup: typeof input?.autoBackup === 'boolean' ? input.autoBackup : true,
    };
    this.store.set('settings', normalized);
    this.persistAndBroadcast();
    return clone(normalized);
  }

  /**
   * 整份替换应用数据（导入恢复）。先用默认结构补齐旧备份缺失字段，
   * 再原子写回并广播；窗口布局是设备相关偏好，保留本地值不被备份覆盖。
   */
  replaceAppData(data: AppData): void {
    const localWindows = clone(this.getWindowState());
    this.store.store = clone(data) as StoreShape;
    this.ensureShape(localWindows);
    this.persistAndBroadcast();
  }

  /** 导出当前全量数据为格式化 JSON，并给出带真实日期的建议文件名。 */
  exportData(): DataExportResult {
    const json = JSON.stringify(this.getAppData(), null, 2);
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    return { json, fileName: `scheduleflow-backup-${stamp}.json` };
  }

  /**
   * 退出前自动备份：把 electron-store 的 config.json 复制到
   * userData/backups/config-YYYYMMDD-HHmm.json。开关关闭或源文件不存在时静默跳过。
   * 唯一调用点是 before-quit，窗口 close / window-all-closed 绝不调用。
   */
  createAutoBackup(): void {
    if (!this.getSettings().autoBackup) return;
    try {
      const userData = app.getPath('userData');
      const source = join(userData, 'config.json');
      if (!existsSync(source)) return;
      const now = new Date();
      const pad = (value: number): string => String(value).padStart(2, '0');
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
      const backupDir = join(userData, 'backups');
      mkdirSync(backupDir, { recursive: true });
      copyFileSync(source, join(backupDir, `config-${stamp}.json`));
    } catch {
      // 备份失败不能阻断退出流程。
    }
  }

  // ===== 窗口状态（主进程唯一数据源）=====

  /** 返回补齐/规范化后的窗口状态快照。 */
  getWindowState(): WindowState {
    const raw = this.store.get('windows');
    return normalizeWindowState(raw, createDefaultData().windows as WindowState);
  }

  /** 只写 mode，不触发业务 DATA_CHANGED；广播由 WindowManager 负责。 */
  setMode(mode: UiMode): void {
    const state = this.getWindowState();
    state.mode = mode === 'mini' ? 'mini' : 'standard';
    this.store.set('windows', state);
  }

  /** 局部更新某个小窗的 geometry / open / pinned，立即写回但不广播业务刷新。 */
  updateMiniWindow(key: MiniWindowKey, patch: Partial<WindowGeometry>): void {
    const state = this.getWindowState();
    state.windows[key] = { ...state.windows[key], ...patch };
    this.store.set('windows', state);
  }

  addPomodoroRecord(record: PomodoroRecord): void {
    // 限制历史记录上限，避免长期使用后配置文件无限膨胀。
    const records = [...this.store.get('pomodoroRecords'), record].slice(-5000);
    this.store.set('pomodoroRecords', records);
    this.persistAndBroadcast();
  }

  savePomodoroRuntime(runtime: PomodoroRuntime): void {
    this.store.set('pomodoroRuntime', clone(runtime));
    this.persistAndBroadcast();
  }

  saveWorkTimerRuntime(runtime: WorkTimerRuntime): void {
    this.store.set('workTimerRuntime', clone(runtime));
    this.persistAndBroadcast();
  }

  /** 通知所有窗口重新拉取业务数据；electron-store 自身已完成原子持久化。 */
  private persistAndBroadcast(): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IpcEvent.DATA_CHANGED, { reason: 'store' });
      }
    }
  }
}
