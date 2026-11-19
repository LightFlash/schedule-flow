/**
 * 渲染层 Zustand store：数据缓存 + UI 状态 + 全部 actions。
 * 视图态由主进程 250ms tick 推送；所有写操作经 bridge 回到主进程，
 * 并通过 data:changed 事件刷新缓存（渲染层本身不是数据源）。
 */

import { create } from 'zustand';
import { minutesToMs } from '@shared/time';
import type {
  AppData,
  Granularity,
  MiniWindowKey,
  PomodoroConfig,
  PomodoroViewState,
  ReminderPayload,
  Settings,
  Summary,
  Todo,
  TodoPatch,
  UiMode,
  ViewKey,
  WindowGeometry,
  WindowState,
  WorkTimerViewState,
} from '@shared/types';
import { bridge } from '../api/bridge';

export type ToastSeverity = 'success' | 'error' | 'info' | 'warning';
export type { UiMode, MiniWindowKey } from '@shared/types';

/** 小窗状态镜像：shape 与主进程 WindowGeometry 完全对齐。 */
export type MiniWindowState = WindowGeometry;

export interface ToastState {
  message: string;
  severity: ToastSeverity;
}

/** 单个小窗的显示/几何/置顶镜像（open 默认 false，真实值由主进程下发）。 */

const defaultConfig: PomodoroConfig = { workMinutes: 25, breakMinutes: 5, rounds: 4 };

const idlePomodoro: PomodoroViewState = {
  status: 'idle',
  phase: 'work',
  currentRound: 1,
  totalRounds: 4,
  remainingMs: minutesToMs(25),
  totalPhaseMs: minutesToMs(25),
  config: { ...defaultConfig },
};

const idleWorkTimer: WorkTimerViewState = {
  status: 'idle',
  activeTodoId: null,
  activeTitle: '',
  sessionElapsedMs: 0,
  activeAccumulatedMs: 0,
};

const defaultMiniWindows: Record<MiniWindowKey, MiniWindowState> = {
  pomo: { open: false, x: 24, y: 24, width: 280, height: 340, pinned: false },
  todo: { open: false, x: 324, y: 24, width: 300, height: 380, pinned: false },
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface AppState {
  // 数据缓存
  todos: Todo[];
  settings: Settings;
  pomodoro: PomodoroViewState;
  workTimer: WorkTimerViewState;
  summary: Summary | null;
  summaryGranularity: Granularity;
  // UI 状态
  reminder: ReminderPayload | null;
  activeView: ViewKey;
  settingsOpen: boolean;
  dataManagerOpen: boolean;
  mode: UiMode;
  miniWindows: Record<MiniWindowKey, MiniWindowState>;
  allDoneNotice: boolean;
  toast: ToastState | null;
  initialized: boolean;

  // 生命周期与数据
  initialize: () => Promise<void>;
  refreshData: () => Promise<void>;
  setActiveView: (view: ViewKey) => void;
  openSettings: () => void;
  closeSettings: () => void;
  openDataManager: () => void;
  closeDataManager: () => void;
  showToast: (message: string, severity?: ToastSeverity) => void;
  clearToast: () => void;
  dismissAllDoneNotice: () => void;

  // UI 模式与极简浮层
  setMode: (mode: UiMode) => void;
  setMiniWindow: (win: MiniWindowKey, patch: Partial<MiniWindowState>) => void;
  closeMiniWindow: (win: MiniWindowKey) => void;
  reopenMiniWindow: (win: MiniWindowKey) => void;
  toggleMiniPin: (win: MiniWindowKey) => void;

  // 数据管理
  exportData: () => Promise<void>;
  importData: (file: File) => Promise<void>;
  setAutoBackup: (enabled: boolean) => Promise<void>;

  // TODO
  addTodo: (title: string) => Promise<void>;
  updateTodo: (id: string, patch: TodoPatch) => Promise<void>;
  toggleTodo: (id: string) => Promise<void>;
  moveTodo: (id: string, offset: -1 | 1) => Promise<void>;
  reorderTodos: (ids: string[]) => Promise<void>;
  deleteTodo: (id: string) => Promise<void>;

  // 设置
  saveSettings: (settings: Settings) => Promise<void>;

  // 番茄钟
  startPomodoro: () => Promise<void>;
  pausePomodoro: () => Promise<void>;
  resumePomodoro: () => Promise<void>;
  resetPomodoro: () => Promise<void>;
  updatePomodoroConfig: (config: PomodoroConfig) => Promise<void>;

  // 工作计时
  startWork: (todoId: string) => Promise<boolean>;
  stopWork: () => Promise<void>;
  pauseWork: () => Promise<void>;
  resumeWork: () => Promise<void>;

  // 汇总与提醒
  loadSummary: (granularity: Granularity) => Promise<void>;
  confirmReminder: () => Promise<void>;
}

let subscribed = false;

/** 主进程是窗口状态唯一数据源；渲染层只做镜像，不本地决定渲染分支。 */
function applyWindowState(state: WindowState): void {
  useAppStore.setState({ mode: state.mode, miniWindows: state.windows });
}

/** 订阅主进程推送事件；整个应用生命周期只订阅一次（兼容 React StrictMode 双调用）。 */
function subscribeEvents(): void {
  if (subscribed) return;
  subscribed = true;

  bridge.onTick((payload) => {
    useAppStore.setState({ pomodoro: payload.pomodoro, workTimer: payload.workTimer });
  });
  bridge.onDataChanged(() => {
    void useAppStore.getState().refreshData();
  });
  bridge.onReminderShow((payload) => {
    useAppStore.setState({ reminder: payload });
  });
  bridge.onReminderHide(() => {
    useAppStore.setState({ reminder: null });
  });
  bridge.onPomodoroAllDone(() => {
    useAppStore.setState({ allDoneNotice: true });
  });
  bridge.onWindowStateChanged((state) => {
    applyWindowState(state);
  });
}

export const useAppStore = create<AppState>()((set, get) => ({
  todos: [],
  settings: {
    push: { serverChanKey: '', pushPlusToken: '', channels: [] },
    pomodoro: { ...defaultConfig },
    autoMarkComplete: false,
    autoBackup: true,
  },
  pomodoro: { ...idlePomodoro, config: { ...defaultConfig } },
  workTimer: { ...idleWorkTimer },
  summary: null,
  summaryGranularity: 'week',
  reminder: null,
  activeView: 'pomodoro',
  settingsOpen: false,
  dataManagerOpen: false,
  mode: 'standard',
  miniWindows: {
    pomo: { ...defaultMiniWindows.pomo },
    todo: { ...defaultMiniWindows.todo },
  },
  allDoneNotice: false,
  toast: null,
  initialized: false,

  async initialize() {
    if (get().initialized) return;
    subscribeEvents();
    try {
      const data = await bridge.getData();
      const windowState = await bridge.getWindowState();
      set({
        todos: data.todos,
        settings: data.settings,
        pomodoro: {
          ...idlePomodoro,
          config: { ...data.settings.pomodoro },
          totalRounds: data.settings.pomodoro.rounds,
          remainingMs: minutesToMs(data.settings.pomodoro.workMinutes),
          totalPhaseMs: minutesToMs(data.settings.pomodoro.workMinutes),
        },
        mode: windowState.mode,
        miniWindows: windowState.windows,
        initialized: true,
      });
    } catch (error) {
      set({ initialized: true });
      get().showToast(`初始化失败：${describeError(error)}`, 'error');
    }
  },

  async refreshData() {
    try {
      const data = await bridge.getData();
      set({ todos: data.todos, settings: data.settings });
      if (get().activeView === 'summary') {
        await get().loadSummary(get().summaryGranularity);
      }
    } catch (error) {
      get().showToast(`刷新数据失败：${describeError(error)}`, 'error');
    }
  },

  setActiveView(view) {
    set({ activeView: view });
    if (view === 'summary') void get().loadSummary(get().summaryGranularity);
  },

  openSettings() {
    set({ settingsOpen: true });
  },

  closeSettings() {
    set({ settingsOpen: false });
  },

  openDataManager() {
    set({ dataManagerOpen: true });
  },

  closeDataManager() {
    set({ dataManagerOpen: false });
  },

  showToast(message, severity = 'info') {
    set({ toast: { message, severity } });
  },

  clearToast() {
    set({ toast: null });
  },

  dismissAllDoneNotice() {
    set({ allDoneNotice: false });
  },

  setMode(mode) {
    // 不再本地切渲染分支：主进程权威，广播 WINDOW_STATE_CHANGED 后回写镜像。
    const action = mode === 'mini' ? bridge.enterMini() : bridge.exitMini();
    void action
      .then(() => {
        get().showToast(
          mode === 'mini' ? '已进入极简模式：两个独立小窗' : '已切回标准模式',
          'info',
        );
      })
      .catch((error) => get().showToast(describeError(error), 'error'));
  },

  setMiniWindow(win, patch) {
    // 仅供已废弃的 MiniDesktop 本地镜像使用；真实几何请走 bridge.setMiniBounds。
    const current = get().miniWindows[win];
    set({ miniWindows: { ...get().miniWindows, [win]: { ...current, ...patch } } });
  },

  closeMiniWindow(win) {
    void bridge
      .closeMini(win)
      .then(() => get().showToast(win === 'pomo' ? '番茄钟小窗已关闭' : 'TODO 小窗已关闭', 'info'))
      .catch((error) => get().showToast(describeError(error), 'error'));
  },

  reopenMiniWindow(win) {
    void bridge
      .openMini(win)
      .then(() =>
        get().showToast(win === 'pomo' ? '番茄钟小窗已重新打开' : 'TODO 小窗已重新打开', 'info'),
      )
      .catch((error) => get().showToast(describeError(error), 'error'));
  },

  toggleMiniPin(win) {
    // 独立置顶：只改目标小窗，pinned 镜像由 WINDOW_STATE_CHANGED 回写。
    const next = !get().miniWindows[win].pinned;
    void bridge
      .setPinned(win, next)
      .then(() => {
        get().showToast(next ? '此小窗已开启始终置顶' : '此小窗已取消始终置顶', 'success');
      })
      .catch((error) => get().showToast(describeError(error), 'error'));
  },

  async exportData() {
    try {
      const result = await bridge.exportData();
      const blob = new Blob([result.json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      get().showToast(`已导出备份：${result.fileName}`, 'success');
    } catch (error) {
      get().showToast(`导出失败：${describeError(error)}`, 'error');
    }
  },

  async importData(file) {
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as AppData).todos)) {
        throw new Error('备份文件不是有效的 Schedule Flow 数据');
      }
      await bridge.importData(parsed as AppData);
      await get().refreshData();
      get().showToast(`已导入 ${(parsed as AppData).todos.length} 个工作项（覆盖当前数据）`, 'success');
    } catch (error) {
      get().showToast(`导入失败：${describeError(error)}`, 'error');
    }
  },

  async setAutoBackup(enabled) {
    try {
      await bridge.setAutoBackup(enabled);
      await get().refreshData();
      get().showToast(enabled ? '自动备份已开启：退出时保留带日期副本' : '自动备份已关闭', 'success');
    } catch (error) {
      get().showToast(describeError(error), 'error');
    }
  },

  async addTodo(title) {
    try {
      await bridge.addTodo(title);
      await get().refreshData();
      get().showToast('已添加工作项', 'success');
    } catch (error) {
      get().showToast(describeError(error), 'error');
    }
  },

  async updateTodo(id, patch) {
    try {
      await bridge.updateTodo(id, patch);
      await get().refreshData();
    } catch (error) {
      get().showToast(describeError(error), 'error');
    }
  },

  async toggleTodo(id) {
    try {
      await bridge.toggleTodo(id);
      await get().refreshData();
    } catch (error) {
      get().showToast(describeError(error), 'error');
    }
  },

  async moveTodo(id, offset) {
    try {
      await bridge.moveTodo(id, offset);
      await get().refreshData();
    } catch (error) {
      get().showToast(describeError(error), 'error');
    }
  },

  async reorderTodos(ids) {
    try {
      await bridge.reorderTodos(ids);
      await get().refreshData();
    } catch (error) {
      get().showToast(describeError(error), 'error');
    }
  },

  async deleteTodo(id) {
    try {
      await bridge.deleteTodo(id);
      await get().refreshData();
      get().showToast('已删除工作项', 'success');
    } catch (error) {
      get().showToast(describeError(error), 'error');
    }
  },

  async saveSettings(settings) {
    try {
      await bridge.saveSettings(settings);
      await get().refreshData();
      get().showToast('设置已保存', 'success');
    } catch (error) {
      get().showToast(describeError(error), 'error');
    }
  },

  async startPomodoro() {
    try {
      await bridge.startPomodoro();
    } catch (error) {
      get().showToast(describeError(error), 'error');
    }
  },

  async pausePomodoro() {
    try {
      await bridge.pausePomodoro();
    } catch (error) {
      get().showToast(describeError(error), 'error');
    }
  },

  async resumePomodoro() {
    try {
      await bridge.resumePomodoro();
    } catch (error) {
      get().showToast(describeError(error), 'error');
    }
  },

  async resetPomodoro() {
    try {
      await bridge.resetPomodoro();
      get().showToast('番茄钟已重置', 'info');
    } catch (error) {
      get().showToast(describeError(error), 'error');
    }
  },

  async updatePomodoroConfig(config) {
    try {
      await bridge.updatePomodoroConfig(config);
    } catch (error) {
      get().showToast(describeError(error), 'error');
    }
  },

  async startWork(todoId) {
    try {
      await bridge.startWork(todoId);
      await get().refreshData();
      get().showToast('已开始计时', 'success');
      return true;
    } catch (error) {
      const message = describeError(error);
      // 单一计时互斥：由渲染层确认后先停当前项，再启动新项（共享知识 3）。
      if (message.includes('请先停止当前计时')) {
        const agreed = window.confirm('已有工作项正在计时。是否停止当前项并开始新项？');
        if (!agreed) return false;
        try {
          await bridge.stopWork();
          await bridge.startWork(todoId);
          await get().refreshData();
          get().showToast('已切换计时对象', 'success');
          return true;
        } catch (switchError) {
          get().showToast(describeError(switchError), 'error');
          return false;
        }
      }
      get().showToast(message, 'error');
      return false;
    }
  },

  async stopWork() {
    try {
      await bridge.stopWork();
      await get().refreshData();
      get().showToast('计时已停止，用时已累计', 'success');
    } catch (error) {
      get().showToast(describeError(error), 'error');
    }
  },

  async pauseWork() {
    try {
      await bridge.pauseWork();
      await get().refreshData();
    } catch (error) {
      get().showToast(describeError(error), 'error');
    }
  },

  async resumeWork() {
    try {
      await bridge.resumeWork();
      await get().refreshData();
    } catch (error) {
      get().showToast(describeError(error), 'error');
    }
  },

  async loadSummary(granularity) {
    set({ summaryGranularity: granularity });
    try {
      const summary = await bridge.loadSummary(granularity);
      set({ summary });
    } catch (error) {
      get().showToast(`加载汇总失败：${describeError(error)}`, 'error');
    }
  },

  async confirmReminder() {
    set({ reminder: null });
    try {
      await bridge.confirmReminder();
    } catch (error) {
      get().showToast(describeError(error), 'error');
    }
  },
}));
