/**
 * 主进程入口：装配窗口管理器、服务与 IPC，启动时恢复计时运行态并驱动 250ms tick。
 * 主进程是唯一数据源；渲染层只通过 preload 暴露的 window.electronAPI 与之通信。
 *
 * 托盘常驻：任一窗口 X 只隐藏该窗口，主进程继续存活，计时 / 提醒不受影响。
 * 只有托盘菜单「退出程序」或系统级退出才真正 app.quit()；自动备份只在 before-quit 发生一次。
 */

import { app, Menu, nativeImage, Tray } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createId } from '@shared/time';
import { StoreService } from './store';
import { WindowManager } from './windows';
import { PomodoroEngine } from './timers/PomodoroEngine';
import { WorkTimerEngine } from './timers/WorkTimerEngine';
import { PushService } from './services/pushService';
import { ReminderService } from './services/reminderService';
import { SummaryService } from './services/summaryService';
import { IpcRegistry } from './services/ipc';

/**
 * 托盘图标：内联 32x32 PNG（蓝色圆角方块 + 白色时钟表盘）。
 * 内联 data URI 避免引入需要 electron-builder 资源打包的 ico/png 文件。
 */
const TRAY_ICON_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABSklEQVR4nM1XuwrCMBTNp3TJF/gDfohDIbOzP+DkIvgB4ubk4Ozs4NTVD3BL8YEPRNDIKa3EkuaWNjEeuFDSNOf0ntw8GNPAhYy4kGMuZMKFVI4jyceOmAlcyJgLefBAXA5wxCZy38TliPW0/+LPTZmIWO7Lr8mLGDNPE65uJCwgeRaNBHQHezWYntVkec0Cz2jzLqA3OqrN9qGqgHfo40XAcH4xEpoEoa9TASZyoNNPszChrghSAFJahaJPFerYQQqweU4JwLetBGBm20AJAKjqsApAebUVgDEaC0CNV2GXPmvZhDG8CUAF6NlCm1MBlAUgXKzvXz6D8HR9ubGAmoQ6ZqvbJyMQVaDVJKT8LQN/DvIiA63LkBMLEQUnCxG3LMU2OFuKm4hwvhnpdgTbjsvVEeRA4iP+4lAa/Fge9mIS/Gr2F5fTkNfzN8z3ti12NAYsAAAAAElFTkSuQmCC';

let tray: Tray | null = null;
/** 区分「点 X 隐藏」与「真正退出」，避免 close 事件阻止 app.quit()。 */
let isQuitting = false;
let pomodoroEngine: PomodoroEngine | null = null;
let storeService: StoreService | null = null;
let windowManager: WindowManager | null = null;

/**
 * 全新安装标记：放在安装目录，随卸载一起被删除。
 * 卸载重装后首次启动检测不到标记 → 重置设置 / 窗口布局 / 运行态 / 登录项，
 * 仅保留 TODO 与番茄钟工作数据；之后写入新标记，正常使用期间不再重置。
 */
const INSTALL_MARKER_NAME = 'schedule-flow-install-marker.json';

function resolveInstallMarkerPath(): string {
  return join(dirname(app.getPath('exe')), INSTALL_MARKER_NAME);
}

/** 仅打包版生效；开发模式的 exe 在 node_modules 里，永远不算全新安装。 */
function detectFreshInstall(): boolean {
  if (!app.isPackaged) return false;
  try {
    return !existsSync(resolveInstallMarkerPath());
  } catch {
    return false;
  }
}

function writeInstallMarker(): void {
  try {
    writeFileSync(
      resolveInstallMarkerPath(),
      JSON.stringify({ installId: createId(), version: app.getVersion() }),
      'utf-8',
    );
  } catch {
    /* 安装目录只读时跳过：下次启动仍会视为全新安装并重置一次，可接受 */
  }
}

/** 托盘右键「退出程序」：打标记后走正常 quit 流程，保留 before-quit 的停 tick + 自动备份。 */
function quitFromTray(): void {
  isQuitting = true;
  if (windowManager) windowManager.quitRequested = true;
  app.quit();
}

/** mini 模式多两个「显示单窗」入口，模式变化后重建右键菜单。 */
function buildTrayTemplate(): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [
    { label: '显示窗口', click: () => windowManager?.showAllForCurrentMode() },
  ];
  if (windowManager?.getState().mode === 'mini') {
    template.push({ label: '显示番茄钟窗', click: () => windowManager?.showMini('pomo') });
    template.push({ label: '显示 TODO 窗', click: () => windowManager?.showMini('todo') });
  }
  template.push({ type: 'separator' });
  template.push({ label: '退出程序', click: () => quitFromTray() });
  return template;
}

function refreshTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayTemplate()));
}

/** 创建系统托盘与右键菜单；模块级引用防止被 GC。 */
function createTray(): void {
  if (tray) return;
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URI);
  tray = new Tray(icon);
  tray.setToolTip('Schedule Flow');
  refreshTrayMenu();
  // 左键按当前 mode 切换对应窗口集合的显隐。
  tray.on('click', () => windowManager?.toggleVisible());
}

void app.whenReady().then(() => {
  const freshInstall = detectFreshInstall();
  const store = new StoreService();
  storeService = store;
  if (freshInstall) {
    store.resetNonPersonalState();
    // 上次安装写入的系统登录项在注册表里会残留，全新安装语义下一并清掉。
    try {
      app.setLoginItemSettings({ openAtLogin: false });
    } catch {
      /* 忽略 */
    }
  }
  const push = new PushService();
  const reminder = new ReminderService(push);
  const workTimer = new WorkTimerEngine(store);
  const pomodoro = new PomodoroEngine(store, reminder, () => workTimer.getViewState());
  pomodoroEngine = pomodoro;
  const summary = new SummaryService(store);

  // 崩溃 / 关闭恢复：按持久化的运行态还原真实经过时间。
  const snapshot = store.getAppData();
  pomodoro.restore(snapshot.pomodoroRuntime);
  workTimer.restore(snapshot.workTimerRuntime);

  const wm = new WindowManager(store);
  windowManager = wm;
  wm.onStateChanged = () => refreshTrayMenu();
  // 启动固定 standard：清掉上次退出残留的 mini 模式与 open 标记。
  // 不广播（store.setMode / updateMiniWindow 只写盘），此时窗口尚未创建；
  // 托盘菜单在建窗后按 standard 生成，不会出现小窗项。
  wm.resetToStandardOnStartup();

  new IpcRegistry(store, pomodoro, workTimer, summary, push, reminder, wm).registerAll();

  // 启动固定 standard：只建主窗口；两个小窗在首次进入极简模式时才创建。
  wm.createMainWindow();
  createTray();

  // 提醒相关回调：pin 重放 + mode 感知的显隐恢复。
  reminder.setPinnedRestorer(() => wm.reapplyPinned());
  reminder.setModeProvider(() => wm.getState().mode);
  reminder.setModeVisibilityRestorer(() => wm.syncVisibilityToMode());

  pomodoro.startTimerLoop();

  if (freshInstall) writeInstallMarker();

  app.on('activate', () => {
    // macOS 点击 Dock 图标时，按当前 mode 唤出对应窗口。
    wm.showAllForCurrentMode();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  if (windowManager) windowManager.quitRequested = true;
  pomodoroEngine?.stopTimerLoop();
  // 唯一自动备份调用点：窗口 close / window-all-closed 绝不触发。
  storeService?.createAutoBackup();
  tray?.destroy();
  tray = null;
});

app.on('window-all-closed', () => {
  // 隐藏到托盘不会触发 closed；真正退出时 quit 已在流程中，避免重复调用。
  if (process.platform !== 'darwin' && !isQuitting) app.quit();
});
