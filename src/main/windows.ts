/**
 * 多窗口权威管理：3 个 BrowserWindow（main / pomo / todo）的生命周期全部收敛在此。
 * 启动只建主窗口（懒创建小窗，保持「启动 1 窗口」断言）；小窗关闭 = 隐藏不销毁；
 * 退出由托盘/系统触发，createAutoBackup 只在 index.ts 的 before-quit 调用一次。
 */

import { BrowserWindow, screen, shell } from 'electron';
import type { BrowserWindowConstructorOptions } from 'electron';
import { join } from 'node:path';
import { IpcEvent } from '@shared/ipcChannels';
import type { MiniWindowKey, WindowGeometry, WindowState, WindowType } from '@shared/types';
import type { StoreService } from './store';

type Bounds = Pick<WindowGeometry, 'x' | 'y' | 'width' | 'height'>;

const MINI_KEYS: readonly MiniWindowKey[] = ['pomo', 'todo'];
const MIN_WIDTH = 260;
const MIN_HEIGHT = 200;
const MAX_COORD = 100000;
const MAX_DIMENSION = 100000;
const PERSIST_DELAY_MS = 200;

const MINI_TITLES: Record<MiniWindowKey, string> = {
  pomo: '番茄钟',
  todo: 'TODO',
};

/** dev / 生产两种渲染入口，统一带 ?window= 标识。 */
export function loadWindowView(win: BrowserWindow, type: WindowType): void {
  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (rendererUrl) {
    void win.loadURL(`${rendererUrl}?window=${type}`);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { window: type } });
  }
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function intersects(a: Bounds, b: Bounds): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export class WindowManager {
  private mainWindow: BrowserWindow | null = null;
  private readonly miniWindows = new Map<MiniWindowKey, BrowserWindow>();
  private readonly persistTimers = new Map<MiniWindowKey, ReturnType<typeof setTimeout>>();

  /** index.ts 在托盘退出 / before-quit 时置位：为 true 后 close 不再拦截。 */
  quitRequested = false;
  /** index.ts 注入：每次状态广播后刷新托盘右键菜单（mini 模式多两个入口）。 */
  onStateChanged: ((state: WindowState) => void) | null = null;

  constructor(private readonly store: StoreService) {}

  // ===== 查询 =====

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  getMiniWindow(key: MiniWindowKey): BrowserWindow | null {
    return this.miniWindows.get(key) ?? null;
  }

  getState(): WindowState {
    return this.store.getWindowState();
  }

  /**
   * 启动时固定回到 standard：清掉上次退出残留的 mini 模式与 open 标记。
   * 只写 store 不广播（此时窗口尚未创建），托盘菜单随后按 standard 生成。
   */
  resetToStandardOnStartup(): void {
    this.store.setMode('standard');
    for (const key of MINI_KEYS) this.store.updateMiniWindow(key, { open: false });
  }

  /**
   * 按当前 mode 重放「应有显隐」，不写 mode。
   * 供强提醒 confirm 使用：提醒期间用户切了模式，触发时的显隐快照已过期，
   * 此时以新模式为准恢复互斥，避免标准模式零可见窗口 / 三窗同显。
   */
  syncVisibilityToMode(): void {
    if (this.getState().mode === 'standard') {
      this.showMainWindow();
      for (const key of MINI_KEYS) this.applyHide(key, false);
    } else {
      for (const key of MINI_KEYS) this.applyShow(key, false);
      this.hideMainWindow();
    }
    this.broadcastState();
  }

  // ===== 创建 =====

  /** 启动时调用；已存在且未销毁时直接复用。 */
  createMainWindow(): BrowserWindow {
    const existing = this.mainWindow;
    if (existing && !existing.isDestroyed()) return existing;

    const options = {
      width: 1180,
      height: 820,
      minWidth: 940,
      minHeight: 640,
      show: false,
      autoHideMenuBar: true,
      title: 'Schedule Flow',
      backgroundColor: '#F4F6FB',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
      windowType: 'main',
    } as BrowserWindowConstructorOptions & { windowType: WindowType };

    const win = new BrowserWindow(options);
    this.mainWindow = win;
    this.installZoomGuard(win);
    win.on('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });
    this.installCloseGuard(win);
    this.installExternalLinkGuard(win);
    loadWindowView(win, 'main');
    win.on('closed', () => {
      if (this.mainWindow === win) this.mainWindow = null;
    });
    return win;
  }

  /** 懒创建小窗：读取 store 中的 geometry / pinned 定位，复用已有实例。 */
  createMiniWindow(key: MiniWindowKey): BrowserWindow {
    const existing = this.miniWindows.get(key);
    if (existing && !existing.isDestroyed()) return existing;

    const geometry = this.store.getWindowState().windows[key];
    // 存储几何可能来自不同 DPI / 显示器组合（卸载重装不会清数据目录），
    // 创建时按当前显示器校正位置与尺寸，避免窗口跑出屏幕或比例失真。
    const bounds = this.normalizeBounds(geometry, {});
    const options = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      frame: false,
      show: false,
      autoHideMenuBar: true,
      title: `${MINI_TITLES[key]} · Schedule Flow`,
      backgroundColor: '#FFFFFF',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
      windowType: key,
    } as BrowserWindowConstructorOptions & { windowType: WindowType };

    const win = new BrowserWindow(options);
    this.miniWindows.set(key, win);
    this.installZoomGuard(win);
    this.installCloseGuard(win, key);
    this.installExternalLinkGuard(win);
    this.installGeometryListeners(key, win);
    loadWindowView(win, key);
    win.on('closed', () => {
      if (this.miniWindows.get(key) === win) this.miniWindows.delete(key);
    });
    win.setAlwaysOnTop(geometry.pinned);
    return win;
  }

  // ===== 显隐与模式切换 =====

  showMainWindow(): BrowserWindow {
    const win = this.createMainWindow();
    if (!win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    return win;
  }

  hideMainWindow(): void {
    const win = this.mainWindow;
    if (win && !win.isDestroyed()) win.hide();
  }

  showMini(key: MiniWindowKey): void {
    this.applyShow(key, true);
  }

  hideMini(key: MiniWindowKey): void {
    this.applyHide(key, true);
  }

  hideAllMini(): void {
    for (const key of MINI_KEYS) this.applyHide(key, false);
    this.broadcastState();
  }

  /** 进入极简：创建/显示两小窗 + 隐藏 main + 写 mode + 广播。 */
  enterMiniMode(): void {
    for (const key of MINI_KEYS) this.applyShow(key, false);
    this.hideMainWindow();
    this.store.setMode('mini');
    this.broadcastState();
  }

  /** 切回标准：关两小窗（隐藏 + open=false）+ 显示 main + 写 mode + 广播。 */
  exitMiniMode(): void {
    for (const key of MINI_KEYS) this.applyHide(key, false);
    this.showMainWindow();
    this.store.setMode('standard');
    this.broadcastState();
  }

  // ===== 单窗操作 =====

  /** 只设置目标小窗的置顶；不再遍历 getAllWindows 做整体联动。 */
  setMiniPinned(key: MiniWindowKey, pinned: boolean): void {
    const win = this.getMiniWindow(key);
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(pinned);
    this.store.updateMiniWindow(key, { pinned });
    this.broadcastState();
  }

  /** setBounds + clamp/多显示器回退 + 立即持久化。 */
  setMiniBounds(key: MiniWindowKey, patch: Partial<Bounds>): void {
    const current = this.store.getWindowState().windows[key];
    const target = this.normalizeBounds(current, patch);
    const win = this.getMiniWindow(key);
    if (win && !win.isDestroyed()) win.setBounds(target);
    this.store.updateMiniWindow(key, target);
    this.broadcastState();
  }

  /** 强提醒 confirm() 后按 store 重放各小窗自身 pinned，避免被 screen-saver 置顶污染。 */
  reapplyPinned(): void {
    const state = this.getState();
    for (const key of MINI_KEYS) {
      const win = this.getMiniWindow(key);
      if (win && !win.isDestroyed()) win.setAlwaysOnTop(state.windows[key].pinned);
    }
  }

  // ===== 托盘协调 =====

  /** 托盘左键：standard 切 main；mini 整体切两小窗显隐。 */
  toggleVisible(): void {
    const state = this.getState();
    if (state.mode === 'standard') {
      const win = this.mainWindow;
      if (win && !win.isDestroyed() && win.isVisible()) win.hide();
      else this.showMainWindow();
    } else {
      const anyVisible = MINI_KEYS.some((key) => {
        const win = this.getMiniWindow(key);
        return win !== null && !win.isDestroyed() && win.isVisible();
      });
      for (const key of MINI_KEYS) {
        if (anyVisible) this.applyHide(key, false);
        else this.applyShow(key, false);
      }
    }
    this.broadcastState();
  }

  /** 托盘右键「显示窗口」：按当前 mode 唤出对应窗口集合。 */
  showAllForCurrentMode(): void {
    if (this.getState().mode === 'standard') {
      this.showMainWindow();
    } else {
      for (const key of MINI_KEYS) this.applyShow(key, false);
    }
    this.broadcastState();
  }

  /** 向所有存活窗口广播窗口状态快照，并回调 index.ts 刷新托盘菜单。 */
  broadcastState(): void {
    const state = this.getState();
    const windows: BrowserWindow[] = [
      ...(this.mainWindow ? [this.mainWindow] : []),
      ...[...this.miniWindows.values()],
    ];
    for (const win of windows) {
      if (!win.isDestroyed()) win.webContents.send(IpcEvent.WINDOW_STATE_CHANGED, state);
    }
    this.onStateChanged?.(state);
  }

  // ===== 内部实现 =====

  private applyShow(key: MiniWindowKey, broadcast: boolean): void {
    const win = this.createMiniWindow(key);
    if (!win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    this.store.updateMiniWindow(key, { open: true });
    if (broadcast) this.broadcastState();
  }

  private applyHide(key: MiniWindowKey, broadcast: boolean): void {
    const win = this.getMiniWindow(key);
    if (win && !win.isDestroyed()) win.hide();
    this.store.updateMiniWindow(key, { open: false });
    if (broadcast) this.broadcastState();
  }

  private installCloseGuard(win: BrowserWindow, key?: MiniWindowKey): void {
    win.on('close', (event: { preventDefault: () => void }) => {
      if (this.quitRequested) return;
      event.preventDefault();
      win.hide();
      if (key) {
        this.persistBoundsNow(key, win);
        this.store.updateMiniWindow(key, { open: false });
        this.broadcastState();
      }
    });
  }

  private installExternalLinkGuard(win: BrowserWindow): void {
    win.webContents.setWindowOpenHandler((details: { url: string }) => {
      void shell.openExternal(details.url);
      return { action: 'deny' };
    });
  }

  /** moved / resize 200ms 尾节流写回；close 时立即补写最终 bounds。 */
  private installGeometryListeners(key: MiniWindowKey, win: BrowserWindow): void {
    const schedule = (): void => this.schedulePersistBounds(key, win);
    win.on('moved', schedule);
    win.on('resize', schedule);
    win.on('close', () => {
      const timer = this.persistTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        this.persistTimers.delete(key);
      }
      if (!win.isDestroyed()) this.persistBoundsNow(key, win);
    });
  }

  private schedulePersistBounds(key: MiniWindowKey, win: BrowserWindow): void {
    const existing = this.persistTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.persistTimers.delete(key);
      if (!win.isDestroyed()) {
        this.persistBoundsNow(key, win);
        // 同步镜像给渲染层，保证下一次缩放起点取到的 geometry 是最新的。
        this.broadcastState();
      }
    }, PERSIST_DELAY_MS);
    this.persistTimers.set(key, timer);
  }

  /** 禁用网页缩放（Ctrl+滚轮 / 双指捏合），并把历史遗留的缩放级别归一为 100%。 */
  private installZoomGuard(win: BrowserWindow): void {
    const contents = win.webContents;
    if (!contents || typeof contents.setZoomFactor !== 'function') return; // 测试 stub 兼容
    try {
      contents.setVisualZoomLevelLimits(1, 1);
    } catch {
      /* 忽略不支持的环境 */
    }
    try {
      contents.setZoomFactor(1);
    } catch {
      /* 忽略 */
    }
    contents.on('did-finish-load', () => {
      try {
        contents.setZoomFactor(1);
      } catch {
        /* 忽略 */
      }
    });
  }

  private persistBoundsNow(key: MiniWindowKey, win: BrowserWindow): void {
    const bounds = win.getBounds();
    this.store.updateMiniWindow(key, {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    });
  }

  /** 有限数兜底 + 尺寸下限 + 多显示器校验；目标完全不在任何显示器时回退工作区左上。 */
  private normalizeBounds(current: WindowGeometry, patch: Partial<Bounds>): Bounds {
    const raw = { ...current, ...patch };
    const candidate: Bounds = {
      x: clamp(finiteOr(raw.x, current.x), -MAX_COORD, MAX_COORD),
      y: clamp(finiteOr(raw.y, current.y), -MAX_COORD, MAX_COORD),
      width: clamp(finiteOr(raw.width, current.width), MIN_WIDTH, MAX_DIMENSION),
      height: clamp(finiteOr(raw.height, current.height), MIN_HEIGHT, MAX_DIMENSION),
    };
    const matched = screen.getDisplayMatching(candidate);
    const workArea = matched?.workArea;
    if (workArea && !intersects(candidate, workArea)) {
      const primaryWorkArea = screen.getPrimaryDisplay()?.workArea ?? workArea;
      candidate.x = primaryWorkArea.x;
      candidate.y = primaryWorkArea.y;
    }
    return candidate;
  }
}
