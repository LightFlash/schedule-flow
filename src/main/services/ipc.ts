/**
 * IPC 路由：把渲染层命令分发到 store / 引擎 / 服务 / WindowManager。
 * 所有命令统一返回 IpcResult<T> = { ok, data?, message? }，异常在此收敛为 ok:false。
 */

import { app, ipcMain } from 'electron';
import { IpcCommand } from '@shared/ipcChannels';
import { isMiniWindowKey } from '@shared/types';
import type {
  AppData,
  AutoBackupSetPayload,
  AutoLaunchSetPayload,
  AutoLaunchState,
  ConfigUpdatePayload,
  DataImportPayload,
  Granularity,
  IdPayload,
  IpcResult,
  MiniWindowBoundsPayload,
  PushResult,
  Settings,
  SettingsSavePayload,
  StartWorkPayload,
  TestPushPayload,
  TodoAddPayload,
  TodoMovePayload,
  TodoUpdatePayload,
  WindowKeyPayload,
  WindowPinnedPayload,
  WindowState,
} from '@shared/types';
import type { StoreService } from '../store';
import type { WindowManager } from '../windows';
import type { PomodoroEngine } from '../timers/PomodoroEngine';
import type { WorkTimerEngine } from '../timers/WorkTimerEngine';
import type { PushService } from './pushService';
import type { ReminderService } from './reminderService';
import type { SummaryService } from './summaryService';

function ok<T>(data?: T): IpcResult<T> {
  return { ok: true, data };
}

function fail<T = never>(message: string): IpcResult<T> {
  return { ok: false, message };
}

function payloadOf<T>(payload: unknown): T {
  return payload as T;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const GRANULARITIES: Granularity[] = ['day', 'week', 'month', 'year'];

/** 导入文件的基本结构校验；windows 为可选字段（旧备份兼容）。 */
function isAppData(value: unknown): value is AppData {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Partial<AppData>;
  return (
    Array.isArray(data.todos) &&
    Array.isArray(data.pomodoroRecords) &&
    typeof data.settings === 'object' &&
    data.settings !== null &&
    typeof data.pomodoroRuntime === 'object' &&
    data.pomodoroRuntime !== null &&
    typeof data.workTimerRuntime === 'object' &&
    data.workTimerRuntime !== null
  );
}

export class IpcRegistry {
  constructor(
    private readonly store: StoreService,
    private readonly pomodoro: PomodoroEngine,
    private readonly workTimer: WorkTimerEngine,
    private readonly summary: SummaryService,
    private readonly push: PushService,
    private readonly reminder: ReminderService,
    private readonly windowManager: WindowManager,
  ) {}

  registerAll(): void {
    // ===== 数据 =====
    this.handle(IpcCommand.GET_DATA, () => ok(this.store.getAppData()));

    this.handle(IpcCommand.TODO_ADD, (raw) => {
      const { title } = payloadOf<TodoAddPayload>(raw);
      if (typeof title !== 'string' || title.trim().length === 0) {
        return fail('工作项标题不能为空');
      }
      return ok(this.store.addTodo(title));
    });

    this.handle(IpcCommand.TODO_UPDATE, (raw) => {
      const { id, patch } = payloadOf<TodoUpdatePayload>(raw);
      if (typeof id !== 'string' || !patch) return fail('参数不完整');
      return ok(this.store.updateTodo(id, patch));
    });

    this.handle(IpcCommand.TODO_DELETE, (raw) => {
      const { id } = payloadOf<IdPayload>(raw);
      if (typeof id !== 'string') return fail('参数不完整');
      // 删除正在计时的项前先停止，避免留下悬空 activeTimerId。
      if (this.workTimer.getViewState().activeTodoId === id) this.workTimer.stop();
      this.store.deleteTodo(id);
      return ok<void>();
    });

    this.handle(IpcCommand.TODO_TOGGLE, (raw) => {
      const { id } = payloadOf<IdPayload>(raw);
      if (typeof id !== 'string') return fail('参数不完整');
      const todo = this.store.getTodos().find((item) => item.id === id);
      if (!todo) return fail('工作项不存在或已被删除');
      // 勾选完成时若该项正在计时：先结算并停止计时（autoMarkComplete 可能已把项置为完成）。
      if (!todo.completed && this.workTimer.getViewState().activeTodoId === id) {
        this.workTimer.stop();
      }
      // 以最新状态计算勾选结果，避免 stop() 已置 completed 后 toggle 又把它翻回去。
      const fresh = this.store.getTodos().find((item) => item.id === id);
      const nowCompleted = !(fresh?.completed ?? todo.completed);
      const updated = nowCompleted
        ? this.store.updateTodo(id, { completed: true, completedAt: fresh?.completedAt ?? Date.now() })
        : this.store.updateTodo(id, { completed: false, completedAt: null });
      // 完成的任务自动沉底。
      if (nowCompleted) this.store.moveTodoToEnd(id);
      return ok(updated);
    });

    this.handle(IpcCommand.TODO_MOVE, (raw) => {
      const { id, offset } = payloadOf<TodoMovePayload>(raw ?? {});
      if (typeof id !== 'string' || (offset !== -1 && offset !== 1)) return fail('参数不完整');
      this.store.moveTodo(id, offset);
      return ok<void>();
    });

    this.handle(IpcCommand.SETTINGS_SAVE, (raw) => {
      const { settings } = payloadOf<SettingsSavePayload>(raw);
      if (!settings) return fail('参数不完整');
      const saved = this.store.saveSettings(settings);
      // 空闲状态下立即应用新的番茄默认参数。
      if (this.pomodoro.getViewState().status === 'idle') {
        this.pomodoro.updateConfig(saved.pomodoro);
      }
      return ok<Settings>(saved);
    });

    this.handle(IpcCommand.SETTINGS_TEST_PUSH, async (raw) => {
      const { settings } = payloadOf<TestPushPayload>(raw ?? {});
      const config: Settings = settings ?? this.store.getSettings();
      const results: PushResult[] = await this.push.sendTest(config.push);
      return ok<PushResult[]>(results);
    });

    // ===== 数据备份与导入 =====
    this.handle(IpcCommand.DATA_EXPORT, () => ok(this.store.exportData()));

    this.handle(IpcCommand.DATA_IMPORT, (raw) => {
      const { data } = payloadOf<DataImportPayload>(raw ?? {});
      if (!isAppData(data)) return fail('备份文件格式不正确');
      this.store.replaceAppData(data);
      // 用导入的运行态重建引擎内存状态，否则下一次 tick 会用旧状态覆盖导入结果。
      this.pomodoro.restore(data.pomodoroRuntime);
      this.workTimer.restore(data.workTimerRuntime);
      return ok<void>();
    });

    this.handle(IpcCommand.AUTO_BACKUP_SET, (raw) => {
      const { enabled } = payloadOf<AutoBackupSetPayload>(raw ?? {});
      if (typeof enabled !== 'boolean') return fail('参数不完整');
      const settings = this.store.getSettings();
      this.store.saveSettings({ ...settings, autoBackup: enabled });
      return ok<void>();
    });

    // ===== 窗口（模式级）=====
    this.handle(IpcCommand.WINDOW_GET_STATE, () =>
      ok<WindowState>(this.windowManager.getState()),
    );

    this.handle(IpcCommand.WINDOW_ENTER_MINI, () => {
      this.windowManager.enterMiniMode();
      return ok<void>();
    });

    this.handle(IpcCommand.WINDOW_EXIT_MINI, () => {
      this.windowManager.exitMiniMode();
      return ok<void>();
    });

    this.handle(IpcCommand.WINDOW_SET_PINNED, (raw) => {
      const { windowKey, pinned } = payloadOf<WindowPinnedPayload>(raw ?? {});
      if (!isMiniWindowKey(windowKey) || typeof pinned !== 'boolean') return fail('参数不完整');
      // 仅对目标小窗置顶；原 getAllWindows 遍历是整体联动的根源。
      this.windowManager.setMiniPinned(windowKey, pinned);
      return ok<void>();
    });

    // ===== 窗口（单个小窗级）=====
    this.handle(IpcCommand.MINI_WINDOW_CLOSE, (raw) => {
      const { windowKey } = payloadOf<WindowKeyPayload>(raw ?? {});
      if (!isMiniWindowKey(windowKey)) return fail('无效的窗口标识');
      this.windowManager.hideMini(windowKey);
      return ok<void>();
    });

    this.handle(IpcCommand.MINI_WINDOW_OPEN, (raw) => {
      const { windowKey } = payloadOf<WindowKeyPayload>(raw ?? {});
      if (!isMiniWindowKey(windowKey)) return fail('无效的窗口标识');
      this.windowManager.showMini(windowKey);
      return ok<void>();
    });

    this.handle(IpcCommand.MINI_WINDOW_SET_BOUNDS, (raw) => {
      const { windowKey, bounds } = payloadOf<MiniWindowBoundsPayload>(raw ?? {});
      if (!isMiniWindowKey(windowKey) || typeof bounds !== 'object' || bounds === null) {
        return fail('参数不完整');
      }
      for (const value of Object.values(bounds)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return fail('窗口尺寸参数无效');
      }
      this.windowManager.setMiniBounds(windowKey, bounds);
      return ok<void>();
    });

    // 开机自启动：OS 登录项是唯一数据源；开发态跳过实际写入，避免污染 electron.exe 启动项。
    this.handle(IpcCommand.AUTO_LAUNCH_GET, () => {
      const settings = app.getLoginItemSettings();
      return ok<AutoLaunchState>({ enabled: settings.openAtLogin });
    });

    this.handle(IpcCommand.AUTO_LAUNCH_SET, (raw) => {
      const { enabled } = payloadOf<AutoLaunchSetPayload>(raw ?? {});
      if (typeof enabled !== 'boolean') return fail('参数不完整');
      if (!app.isPackaged) {
        return ok<AutoLaunchState>({
          enabled,
          message: '开发模式下未写入系统启动项（仅打包版生效）',
        });
      }
      app.setLoginItemSettings({ openAtLogin: enabled });
      // 回读 OS 状态，保证界面显示的是真实登录项而非一厢情愿的写入结果。
      const actual = app.getLoginItemSettings().openAtLogin;
      return ok<AutoLaunchState>({ enabled: actual });
    });

    // ===== 番茄钟 =====
    this.handle(IpcCommand.POMODORO_START, () => {
      this.pomodoro.start();
      return ok<void>();
    });
    this.handle(IpcCommand.POMODORO_PAUSE, () => {
      this.pomodoro.pause();
      return ok<void>();
    });
    this.handle(IpcCommand.POMODORO_RESUME, () => {
      this.pomodoro.resume();
      return ok<void>();
    });
    this.handle(IpcCommand.POMODORO_RESET, () => {
      this.pomodoro.reset();
      return ok<void>();
    });
    this.handle(IpcCommand.POMODORO_CONFIG, (raw) => {
      const { config } = payloadOf<ConfigUpdatePayload>(raw);
      if (!config) return fail('参数不完整');
      this.pomodoro.updateConfig(config);
      return ok<void>();
    });

    // ===== 工作计时 =====
    this.handle(IpcCommand.WORK_START, (raw) => {
      const { todoId } = payloadOf<StartWorkPayload>(raw);
      if (typeof todoId !== 'string') return fail('参数不完整');
      return this.workTimer.start(todoId);
    });
    this.handle(IpcCommand.WORK_STOP, () => {
      this.workTimer.stop();
      return ok<void>();
    });
    this.handle(IpcCommand.WORK_PAUSE, () => {
      this.workTimer.pause();
      return ok<void>();
    });
    this.handle(IpcCommand.WORK_RESUME, () => {
      this.workTimer.resume();
      return ok<void>();
    });

    // ===== 汇总与提醒 =====
    this.handle(IpcCommand.SUMMARY_GET, (raw) => {
      const granularity = payloadOf<Granularity>(raw);
      if (!GRANULARITIES.includes(granularity)) return fail('不支持的汇总粒度');
      return ok(this.summary.buildSummary(granularity));
    });
    this.handle(IpcCommand.REMINDER_CONFIRM, () => {
      this.reminder.confirm();
      return ok<void>();
    });
  }

  /** 注册单个命令，并把同步/异步异常统一转换为 IpcResult。 */
  private handle<T>(
    channel: string,
    handler: (payload: unknown) => IpcResult<T> | Promise<IpcResult<T>>,
  ): void {
    ipcMain.handle(channel, async (_event, payload: unknown): Promise<IpcResult<T>> => {
      try {
        return await handler(payload);
      } catch (error) {
        return fail<T>(describeError(error));
      }
    });
  }
}
