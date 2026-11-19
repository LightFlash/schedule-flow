/**
 * 渲染层 IPC 桥接：类型化封装 window.electronAPI，统一解包 IpcResult。
 * 命令失败时抛错，由 store / UI 捕获后给出友好提示。
 */

import { IpcCommand, IpcEvent } from '@shared/ipcChannels';
import type {
  AppData,
  AutoBackupSetPayload,
  AutoLaunchSetPayload,
  AutoLaunchState,
  ConfigUpdatePayload,
  DataExportResult,
  DataImportPayload,
  ElectronApi,
  Granularity,
  IdPayload,
  IpcResult,
  MiniWindowBoundsPayload,
  MiniWindowKey,
  PomodoroAllDonePayload,
  PomodoroConfig,
  PushResult,
  ReminderPayload,
  Settings,
  Summary,
  TickPayload,
  Todo,
  TodoAddPayload,
  TodoMovePayload,
  TodoPatch,
  TodoUpdatePayload,
  WindowKeyPayload,
  WindowPinnedPayload,
  WindowState,
} from '@shared/types';

function getApi(): ElectronApi {
  const api = window.electronAPI;
  if (!api) throw new Error('IPC 桥接未就绪，请在 Electron 桌面环境中运行');
  return api;
}

/** 解包 IpcResult；失败时抛出异常。 */
export async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const result: IpcResult<T> = await getApi().invoke<T>(channel, payload);
  if (!result.ok) throw new Error(result.message || '操作失败，请稍后重试');
  return result.data as T;
}

/** 订阅主进程事件，返回取消订阅函数。 */
export function onEvent<T>(channel: string, handler: (payload: T) => void): () => void {
  return getApi().on(channel, (payload: unknown) => handler(payload as T));
}

export const bridge = {
  // 数据
  getData: (): Promise<AppData> => invoke<AppData>(IpcCommand.GET_DATA),
  addTodo: (title: string): Promise<Todo> =>
    invoke<Todo>(IpcCommand.TODO_ADD, { title } satisfies TodoAddPayload),
  updateTodo: (id: string, patch: TodoPatch): Promise<Todo> =>
    invoke<Todo>(IpcCommand.TODO_UPDATE, { id, patch } satisfies TodoUpdatePayload),
  deleteTodo: (id: string): Promise<void> =>
    invoke<void>(IpcCommand.TODO_DELETE, { id } satisfies IdPayload),
  toggleTodo: (id: string): Promise<Todo> =>
    invoke<Todo>(IpcCommand.TODO_TOGGLE, { id } satisfies IdPayload),
  moveTodo: (id: string, offset: -1 | 1): Promise<void> =>
    invoke<void>(IpcCommand.TODO_MOVE, { id, offset } satisfies TodoMovePayload),
  saveSettings: (settings: Settings): Promise<Settings> =>
    invoke<Settings>(IpcCommand.SETTINGS_SAVE, { settings }),
  testPush: (settings: Settings): Promise<PushResult[]> =>
    invoke<PushResult[]>(IpcCommand.SETTINGS_TEST_PUSH, { settings }),
  exportData: (): Promise<DataExportResult> => invoke<DataExportResult>(IpcCommand.DATA_EXPORT),
  importData: (data: AppData): Promise<void> =>
    invoke<void>(IpcCommand.DATA_IMPORT, { data } satisfies DataImportPayload),
  setAutoBackup: (enabled: boolean): Promise<void> =>
    invoke<void>(IpcCommand.AUTO_BACKUP_SET, { enabled } satisfies AutoBackupSetPayload),

  // 窗口（主进程权威）
  getWindowState: (): Promise<WindowState> => invoke<WindowState>(IpcCommand.WINDOW_GET_STATE),
  enterMini: (): Promise<void> => invoke<void>(IpcCommand.WINDOW_ENTER_MINI),
  exitMini: (): Promise<void> => invoke<void>(IpcCommand.WINDOW_EXIT_MINI),
  closeMini: (key: MiniWindowKey): Promise<void> =>
    invoke<void>(IpcCommand.MINI_WINDOW_CLOSE, { windowKey: key } satisfies WindowKeyPayload),
  openMini: (key: MiniWindowKey): Promise<void> =>
    invoke<void>(IpcCommand.MINI_WINDOW_OPEN, { windowKey: key } satisfies WindowKeyPayload),
  setMiniBounds: (key: MiniWindowKey, bounds: MiniWindowBoundsPayload['bounds']): Promise<void> =>
    invoke<void>(IpcCommand.MINI_WINDOW_SET_BOUNDS, {
      windowKey: key,
      bounds,
    } satisfies MiniWindowBoundsPayload),
  /** 独立置顶：payload 必须带 windowKey，不再整体联动。 */
  setPinned: (key: MiniWindowKey, pinned: boolean): Promise<void> =>
    invoke<void>(IpcCommand.WINDOW_SET_PINNED, {
      windowKey: key,
      pinned,
    } satisfies WindowPinnedPayload),
  getAutoLaunch: (): Promise<AutoLaunchState> => invoke<AutoLaunchState>(IpcCommand.AUTO_LAUNCH_GET),
  setAutoLaunch: (enabled: boolean): Promise<AutoLaunchState> =>
    invoke<AutoLaunchState>(IpcCommand.AUTO_LAUNCH_SET, {
      enabled,
    } satisfies AutoLaunchSetPayload),

  // 番茄钟
  startPomodoro: (): Promise<void> => invoke<void>(IpcCommand.POMODORO_START),
  pausePomodoro: (): Promise<void> => invoke<void>(IpcCommand.POMODORO_PAUSE),
  resumePomodoro: (): Promise<void> => invoke<void>(IpcCommand.POMODORO_RESUME),
  resetPomodoro: (): Promise<void> => invoke<void>(IpcCommand.POMODORO_RESET),
  updatePomodoroConfig: (config: PomodoroConfig): Promise<void> =>
    invoke<void>(IpcCommand.POMODORO_CONFIG, { config } satisfies ConfigUpdatePayload),

  // 工作计时
  startWork: (todoId: string): Promise<string> =>
    invoke<string>(IpcCommand.WORK_START, { todoId }),
  stopWork: (): Promise<void> => invoke<void>(IpcCommand.WORK_STOP),
  pauseWork: (): Promise<void> => invoke<void>(IpcCommand.WORK_PAUSE),
  resumeWork: (): Promise<void> => invoke<void>(IpcCommand.WORK_RESUME),

  // 汇总与提醒
  loadSummary: (granularity: Granularity): Promise<Summary> =>
    invoke<Summary>(IpcCommand.SUMMARY_GET, granularity),
  confirmReminder: (): Promise<void> => invoke<void>(IpcCommand.REMINDER_CONFIRM),

  // 事件
  onTick: (handler: (payload: TickPayload) => void): (() => void) =>
    onEvent<TickPayload>(IpcEvent.TICK, handler),
  onDataChanged: (handler: () => void): (() => void) =>
    onEvent<void>(IpcEvent.DATA_CHANGED, () => handler()),
  onReminderShow: (handler: (payload: ReminderPayload) => void): (() => void) =>
    onEvent<ReminderPayload>(IpcEvent.REMINDER_SHOW, handler),
  onReminderHide: (handler: () => void): (() => void) =>
    onEvent<void>(IpcEvent.REMINDER_HIDE, () => handler()),
  onPomodoroAllDone: (handler: () => void): (() => void) =>
    onEvent<PomodoroAllDonePayload>(IpcEvent.POMODORO_ALL_DONE, () => handler()),
  onWindowStateChanged: (handler: (state: WindowState) => void): (() => void) =>
    onEvent<WindowState>(IpcEvent.WINDOW_STATE_CHANGED, handler),
};
