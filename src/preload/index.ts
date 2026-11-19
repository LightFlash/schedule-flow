/**
 * 预加载脚本：通过 contextBridge 暴露受控的 window.electronAPI。
 * 仅允许 DESIGN.md 定义的命令与事件通道，渲染层无法直接访问 ipcRenderer / Node。
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IpcCommand, IpcEvent } from '@shared/ipcChannels';
import type { ElectronApi, IpcEventHandler, IpcResult } from '@shared/types';

const allowedCommands = new Set<string>(Object.values(IpcCommand));
const allowedEvents = new Set<string>(Object.values(IpcEvent));

const api: ElectronApi = {
  async invoke<T>(channel: string, payload?: unknown): Promise<IpcResult<T>> {
    if (!allowedCommands.has(channel)) {
      return { ok: false, message: `未授权的 IPC 命令：${channel}` };
    }
    return (await ipcRenderer.invoke(channel, payload)) as IpcResult<T>;
  },

  on(channel: string, handler: IpcEventHandler): () => void {
    if (!allowedEvents.has(channel)) {
      return () => undefined;
    }
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      handler(payload);
    };
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
