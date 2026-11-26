/**
 * 强提醒编排：唤出窗口 → 全局置顶 + 任务栏闪烁 → 通知渲染层显示遮罩 → 后台推送。
 * 核心约束：本地提醒绝不等待网络；推送异常必须被吞掉；提醒持续到用户 confirm。
 */

import { BrowserWindow } from 'electron';
import { IpcEvent } from '@shared/ipcChannels';
import type { PushResult, ReminderPayload, Settings, UiMode } from '@shared/types';
import type { PushSender } from './pushService';

function emit(event: string, payload?: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(event, payload);
    }
  }
}

/** 是否至少有一个启用渠道填写了凭证。 */
function hasCredential(settings: Settings): boolean {
  const { push } = settings;
  return push.channels.some((channel) =>
    channel === 'serverchan'
      ? push.serverChanKey.trim().length > 0
      : push.pushPlusToken.trim().length > 0,
  );
}

export class ReminderService {
  private active = false;
  private pinnedRestorer: (() => void) | null = null;
  /** 由 index.ts 注入当前 mode，用于识别提醒期间的模式切换。 */
  private modeProvider: (() => UiMode) | null = null;
  /** mode 变化时按当前模式重放显隐（WindowManager.syncVisibilityToMode）。 */
  private modeVisibilityRestorer: (() => void) | null = null;
  /** 触发提醒前的显隐快照；同时记录当时的 mode，防止跨模式回放过期状态。 */
  private readonly visibilitySnapshot = new Map<BrowserWindow, boolean>();
  private snapshotMode: UiMode | null = null;

  constructor(private readonly push: PushSender) {}

  /**
   * 注入「恢复各小窗自身 pinned」回调：强提醒的 screen-saver 级置顶是全局的，
   * confirm() 复位后必须按 store 重放，否则用户原来的独立置顶会丢失。
   */
  setPinnedRestorer(restorer: () => void): void {
    this.pinnedRestorer = restorer;
  }

  /** 注入 mode 读取器；未注入时退化为「只回放显隐快照」的旧行为。 */
  setModeProvider(provider: () => UiMode): void {
    this.modeProvider = provider;
  }

  /** 注入 mode 变更后的显隐重放器（只做显隐，不写 mode）。 */
  setModeVisibilityRestorer(restorer: () => void): void {
    this.modeVisibilityRestorer = restorer;
  }

  /**
   * 触发提醒。本地动作同步完成；推送异步执行且结果/异常只记录，不影响提醒。
   */
  async trigger(payload: ReminderPayload, settings: Settings): Promise<void> {
    // 只在「非提醒中 → 提醒中」时抓快照：重复 trigger 不能覆盖原始显隐。
    if (!this.active) {
      this.snapshotVisibility();
      this.snapshotMode = this.modeProvider?.() ?? null;
    }
    this.active = true;
    this.activateWindow();

    const configured = hasCredential(settings);
    const viewPayload: ReminderPayload = configured
      ? payload
      : {
          ...payload,
          message: `${payload.message}\n\n（未配置推送凭证，本次仅本地强提醒；可在「设置」中填写 SendKey / Token）`,
        };
    emit(IpcEvent.REMINDER_SHOW, viewPayload);

    if (!configured) return;

    // fire-and-forget：即便推送卡住或抛错也绝不阻塞本地提醒。
    // 带 event 的提醒走事件模板（番茄轮次），否则退回旧的「直接用 payload 文案」。
    const request =
      payload.event !== undefined && typeof this.push.sendEvent === 'function'
        ? this.push.sendEvent(settings.push, payload.event, payload.vars ?? {})
        : this.push.sendPush(settings.push, payload.title, payload.message);
    void request
      .then((results: PushResult[]) => {
        const failed = results.filter((item) => !item.ok);
        if (failed.length > 0) {
          console.warn('[ReminderService] 推送未全部成功：', failed);
        }
      })
      .catch((error: unknown) => {
        console.warn('[ReminderService] 推送异常已被吞掉：', error);
      });
  }

  /** 用户确认后复位置顶/闪烁，并通知渲染层隐藏遮罩。幂等。 */
  confirm(): void {
    if (!this.active) return;
    this.active = false;
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      try {
        window.setAlwaysOnTop(false);
        window.flashFrame(false);
      } catch (error) {
        console.warn('[ReminderService] 复位窗口状态失败：', error);
      }
    }
    // 全局 screen-saver 置顶已复位。mode 未变才回放触发前快照；
    // 若提醒期间用户切了模式（例如小窗「切回标准」），快照已过期，
    // 改为按当前 mode 重放显隐，避免把新模式的窗口错误隐藏。
    const currentMode = this.modeProvider?.() ?? null;
    const modeChanged =
      currentMode !== null && this.snapshotMode !== null && currentMode !== this.snapshotMode;
    if (modeChanged && this.modeVisibilityRestorer) {
      this.modeVisibilityRestorer();
    } else {
      this.restoreVisibility();
    }
    this.snapshotMode = null;
    // pinnedRestorer 在显隐确定后再执行，看到的是最终状态。
    this.pinnedRestorer?.();
    emit(IpcEvent.REMINDER_HIDE);
  }

  /** 当前是否有待确认的提醒（供 IPC / 生命周期查询）。 */
  isActive(): boolean {
    return this.active;
  }

  /** 在 activateWindow() 的 show() 之前记录每个存活窗口的可见性。 */
  private snapshotVisibility(): void {
    this.visibilitySnapshot.clear();
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      this.visibilitySnapshot.set(window, window.isVisible());
    }
  }

  /** 只回收「触发前隐藏、期间仍存活」的窗口；原本可见的窗口不动。 */
  private restoreVisibility(): void {
    for (const [window, wasVisible] of this.visibilitySnapshot) {
      if (wasVisible || window.isDestroyed()) continue;
      try {
        window.hide();
      } catch (error) {
        console.warn('[ReminderService] 恢复窗口显隐失败：', error);
      }
    }
    this.visibilitySnapshot.clear();
  }

  private activateWindow(): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      try {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        window.setAlwaysOnTop(true, 'screen-saver');
        window.flashFrame(true);
      } catch (error) {
        // 窗口状态操作失败不能影响后续遮罩与推送。
        console.warn('[ReminderService] 激活窗口失败：', error);
      }
    }
  }
}
