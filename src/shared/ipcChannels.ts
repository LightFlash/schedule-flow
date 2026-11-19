/**
 * IPC 通道常量。所有通道字符串只在此处定义，禁止在其它文件散落魔法字符串。
 * 命令：renderer -> main（ipcRenderer.invoke / ipcMain.handle）
 * 事件：main -> renderer（webContents.send / ipcRenderer.on）
 */

export const IpcCommand = {
  // 数据
  GET_DATA: 'data:get',
  TODO_ADD: 'todo:add',
  TODO_UPDATE: 'todo:update',
  TODO_DELETE: 'todo:delete',
  TODO_TOGGLE: 'todo:toggle',
  TODO_MOVE: 'todo:move',
  SETTINGS_SAVE: 'settings:save',
  SETTINGS_TEST_PUSH: 'settings:testPush',
  DATA_EXPORT: 'data:export',
  DATA_IMPORT: 'data:import',
  AUTO_BACKUP_SET: 'autoBackup:set',
  // 窗口（模式级）
  WINDOW_SET_PINNED: 'window:setPinned',
  WINDOW_GET_STATE: 'window:getState',
  WINDOW_ENTER_MINI: 'window:enterMini',
  WINDOW_EXIT_MINI: 'window:exitMini',
  // 窗口（单个小窗级）
  MINI_WINDOW_CLOSE: 'miniWindow:close',
  MINI_WINDOW_OPEN: 'miniWindow:open',
  MINI_WINDOW_SET_BOUNDS: 'miniWindow:setBounds',
  // 开机自启动（OS 登录项，不写入 config.json）
  AUTO_LAUNCH_GET: 'autoLaunch:get',
  AUTO_LAUNCH_SET: 'autoLaunch:set',
  // 番茄钟
  POMODORO_START: 'pomodoro:start',
  POMODORO_PAUSE: 'pomodoro:pause',
  POMODORO_RESUME: 'pomodoro:resume',
  POMODORO_RESET: 'pomodoro:reset',
  POMODORO_CONFIG: 'pomodoro:updateConfig',
  // 工作计时
  WORK_START: 'workTimer:start',
  WORK_STOP: 'workTimer:stop',
  WORK_PAUSE: 'workTimer:pause',
  WORK_RESUME: 'workTimer:resume',
  // 汇总与提醒
  SUMMARY_GET: 'summary:get',
  REMINDER_CONFIRM: 'reminder:confirm',
} as const;

export const IpcEvent = {
  TICK: 'timer:tick',
  DATA_CHANGED: 'data:changed',
  REMINDER_SHOW: 'reminder:show',
  REMINDER_HIDE: 'reminder:hide',
  POMODORO_ALL_DONE: 'pomodoro:allDone',
  WINDOW_STATE_CHANGED: 'window:stateChanged',
} as const;

export type IpcCommandValue = (typeof IpcCommand)[keyof typeof IpcCommand];
export type IpcEventValue = (typeof IpcEvent)[keyof typeof IpcEvent];
