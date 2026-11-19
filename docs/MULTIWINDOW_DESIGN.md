# Schedule Flow · 真实多窗口增量重构设计

| 项目 | 内容 |
| --- | --- |
| 文档语言 | 中文 |
| 文档类型 | 增量重构系统设计（供工程师直接实现） |
| 项目根目录 | `C:/Users/LighFlash/WorkBuddy/2026-11-19-09-33-32/scheduleflow` |
| 上游 | team-lead 任务说明（用户已拍板需求） |
| 基线 | 现有单 BrowserWindow + DOM 浮层假窗口实现 |
| 技术栈 | Electron 33 + React 18 + MUI 6 + Zustand 5 + electron-vite 2（无新增第三方依赖） |
| 约束 | 最小变更；不改计时核心（PomodoroEngine / WorkTimerEngine 不加方法）；复用 `compact` 视图与现有托盘逻辑 |

> 目标：把「极简模式」从 **单窗口内的 DOM 浮层**（`MiniDesktop.tsx`）改为 **两个真正独立的系统窗口**，主进程权威架构、托盘常驻、每个小窗独立置顶、切回标准模式、跨重启恢复窗口布局。

---

## 1. 实现方案总览

### 1.1 核心难点与对策

| 难点 | 对策 |
| --- | --- |
| 真实多窗口 + 主进程权威 | 保留 3 个 `BrowserWindow` 实例于主进程，统一由新增的 `WindowManager` 管理；渲染层仍是纯视图，所有窗口生命周期动作走 IPC |
| 三个窗口共用一套 renderer 产物 | 不新增 HTML 入口，沿用唯一 `index.html`；用 **URL query `?window=main\|pomo\|todo`** 区分窗口类型，渲染层读 `window.location.search` 决定渲染内容 |
| 假窗口的 drag/resize 语义迁移 | 拖动改用原生 `-webkit-app-region: drag`（frameless 系统级拖动，流畅）；右下角缩放改为主进程 `setBounds`（手动 handle + IPC） |
| 计时/提醒/数据不被多窗口干扰 | 计时循环仍在主进程唯一（`startTimerLoop()` 只调一次）；`TICK`/`DATA_CHANGED` 本就广播 `getAllWindows()`，天然支持多窗口；提醒遮罩只在 main 窗口渲染，避免重复弹窗 |
| 布局跨重启恢复 | 窗口 geometry/pinned/open 存入 `StoreService`（electron-store），监听 `moved`/`resize` 节流写回 |
| 关闭任一窗口不退出 | 三个窗口 `close` 事件统一 `preventDefault + hide()`；只有托盘「退出程序」/系统退出走 `before-quit`，备份只在此发生一次 |

### 1.2 窗口模型

- **窗口数量**：3 个 `BrowserWindow`——`mainWindow`（标准模式主界面）、`pomoWindow`、`todoWindow`（frameless 自绘标题栏）。
- **懒创建**：启动时只创建 `mainWindow`；进入极简模式时才创建两个小窗（创建后长期复用，关闭=隐藏，不 destroy）。这样既省资源，又让现有 `tray.test.mjs` 的「启动只有 1 个窗口」断言继续成立。
- **主窗口与小窗互斥显示**：标准模式显示 `mainWindow`、隐藏两小窗；极简模式隐藏 `mainWindow`、显示两小窗。这与既有「切回标准 = 关闭两小窗 + 显示主窗口」的语义一致。
- **窗口类型标识**：`WindowType = 'main' | 'pomo' | 'todo'`，`pomo`/`todo` 即 `MiniWindowKey`。

### 1.3 URL 与渲染分流

统一辅助函数（主进程，`index.ts` 或 `windows.ts` 内）：

```ts
// dev: http://localhost:5173?window=pomo
// prod: loadFile(index.html, { query: { window: 'pomo' } })
function loadWindowView(win: BrowserWindow, type: WindowType): void {
  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (rendererUrl) {
    void win.loadURL(`${rendererUrl}?window=${type}`);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { window: type } });
  }
}
```

渲染层读取（新增 `src/renderer/windowKind.ts`，**不 import electron**）：

```ts
export function detectWindowType(): WindowType {
  const raw = new URLSearchParams(window.location.search).get('window');
  return raw === 'pomo' || raw === 'todo' ? raw : 'main';
}
```

`App.tsx` 分流：

- `window === 'pomo'` → `<MiniWindowShell windowKey="pomo"><PomodoroView compact /></MiniWindowShell>`
- `window === 'todo'` → `<MiniWindowShell windowKey="todo"><TodoView compact /></MiniWindowShell>`
- `window === 'main'` → 原标准布局 `<Layout>…</Layout>`

全局浮层（SettingsDialog / DataManagerDialog / ReminderOverlay / allDone Dialog / Snackbar）**只在 main 窗口挂载**；小窗不挂载提醒/设置弹窗，避免重复提醒与重复初始化副作用。`initialize()` / `subscribeEvents()` 公共初始化保留在 `App`，各窗口各自独立 bundle，各自订阅一次（现有 `subscribed` 模块标志在每窗口实例中各自生效，不冲突）。

### 1.4 架构分层（不变）

```
Renderer(main)  → App → Layout + 4 views + 全局浮层
Renderer(pomo)  → App → MiniWindowShell + PomodoroView compact
Renderer(todo)  → App → MiniWindowShell + TodoView compact
        │  window.electronAPI.invoke / on  (preload contextBridge)
Main(权威) → IpcRegistry → WindowManager(新) + StoreService + PomodoroEngine/WorkTimerEngine + 服务
```

---

## 2. 窗口生命周期

### 2.1 WindowManager（新增 `src/main/windows.ts`）

集中承载所有窗口操作，避免 `index.ts` 膨胀；`index.ts` 仅负责装配与托盘/全局事件编排。

```ts
export class WindowManager {
  constructor(private readonly store: StoreService) {}

  // 窗口引用
  readonly mainWindow: BrowserWindow | null;
  getMiniWindow(key: MiniWindowKey): BrowserWindow | null;

  createMainWindow(): void;             // 启动时调用
  createMiniWindow(key: MiniWindowKey): void;  // 懒创建，读 store geometry 定位
  showMini(key: MiniWindowKey): void;    // 不存在则 create，存在则 show+focus
  hideMini(key: MiniWindowKey): void;    // hide + persist(open=false)
  hideAllMini(): void;

  enterMiniMode(): void;                // 创建/显示两小窗 + 隐藏 main + store.setMode('mini') + 广播
  exitMiniMode(): void;                 // 隐藏两小窗 + 显示 main + store.setMode('standard') + 广播

  setMiniPinned(key: MiniWindowKey, pinned: boolean): void; // setAlwaysOnTop + persist + 广播
  setMiniBounds(key: MiniWindowKey, bounds: Partial<Rect>): void; // setBounds + 持久化 + clamp

  getState(): WindowState;              // 读 store
  /** 供托盘：按当前 mode 显示/隐藏目标窗口集合。 */
  toggleVisible(): void;
  showAllForCurrentMode(): void;
  broadcastState(): void;               // webContents.send(WINDOW_STATE_CHANGED, getState())
}
```

### 2.2 生命周期规则

| 事件 | 处理 |
| --- | --- |
| 启动 `whenReady` | `createMainWindow()` → `createTray()` → `startTimerLoop()`；小窗不创建（懒创建） |
| 点击 Layout「极简模式」 | `bridge.enterMini()` → `windowManager.enterMiniMode()` |
| 极简模式关闭某小窗（红点） | `bridge.closeMini(key)` → `hideMini(key)`（不 destroy，open=false，可再从托盘恢复） |
| 小窗「切回标准」 | `bridge.exitMini()` → `exitMiniMode()` |
| 小窗置顶按钮 | `bridge.setPinned(key, pinned)` → 仅目标小窗 `setAlwaysOnTop` |
| 小窗拖动 | 原生 `app-region: drag`；`moved` 事件节流 200ms → `setMiniBounds` 持久化 |
| 小窗缩放 | 右下角 handle + bridge.setMiniBounds → `setBounds` + 持久化 |
| 任一窗口 `close` | `if (!isQuitting) { event.preventDefault(); win.hide(); }`；小窗额外 persist(open=false) |
| 托盘左键 | `windowManager.toggleVisible()`：standard→切 main；mini→切两小窗整体显隐 |
| 托盘右键「显示窗口」 | `windowManager.showAllForCurrentMode()` |
| 托盘右键「退出程序」 | `isQuitting=true; app.quit()` |
| `before-quit` | `isQuitting=true`；`stopTimerLoop()`；`createAutoBackup()`（**唯一一次**）；`tray.destroy()` |
| `window-all-closed` | 仅 `!isQuitting && darwin!==platform` 时 `app.quit()`（隐藏不触发 closed，正常逻辑不进入） |

> 关键：`app.quit()` 触发 `before-quit` 时 `isQuitting` 已为 true，各窗口 `close` 不再拦截，窗口得以真正关闭；`createAutoBackup()` 只在 `before-quit` 调用，绝不放进窗口 `close`/`window-all-closed`，杜绝多窗口重复备份。

---

## 3. IPC 通道与函数签名

### 3.1 契约数量变化

- 命令：**24 → 30**（新增 6 个；`WINDOW_SET_PINNED` 保留名字但改 payload）。
- 事件：**5 → 6**（新增 `WINDOW_STATE_CHANGED`）。
- `tests/ipcContract.test.mjs`：`commands.length===24`→`30`，`events.length===5`→`6`，`qa.handlers.size===24`→`30`，并更新 key 排序列表；三端一致断言仍要求每个命令在 `ipc.ts` 注册、在 `bridge.ts` 调用，每个事件在主进程 `send`、在 `bridge` 订阅。

### 3.2 `src/shared/ipcChannels.ts`

新增命令常量（值遵循 `域:动作`）：

```ts
WINDOW_GET_STATE:      'window:getState',
WINDOW_ENTER_MINI:     'window:enterMini',
WINDOW_EXIT_MINI:      'window:exitMini',
MINI_WINDOW_CLOSE:     'miniWindow:close',
MINI_WINDOW_OPEN:      'miniWindow:open',
MINI_WINDOW_SET_BOUNDS:'miniWindow:setBounds',
// WINDOW_SET_PINNED 保留 'window:setPinned'，payload 改带 windowKey
```

新增事件：

```ts
WINDOW_STATE_CHANGED: 'window:stateChanged',
```

### 3.3 `src/shared/types.ts` 新增/修改类型

```ts
export type MiniWindowKey = 'pomo' | 'todo';
export type WindowType = 'main' | MiniWindowKey;
export type UiMode = 'standard' | 'mini';

export interface WindowGeometry {
  open: boolean; x: number; y: number; width: number; height: number; pinned: boolean;
}
export interface WindowState {
  mode: UiMode;
  windows: Record<MiniWindowKey, WindowGeometry>;
}

export interface WindowKeyPayload { windowKey: MiniWindowKey }
// 修改原 WindowPinnedPayload：由 { pinned } 改为：
export interface WindowPinnedPayload { windowKey: MiniWindowKey; pinned: boolean }
export interface MiniWindowBoundsPayload {
  windowKey: MiniWindowKey;
  bounds: Partial<Pick<WindowGeometry, 'x' | 'y' | 'width' | 'height'>>;
}

// AppData 新增字段（可选读取，兼容旧备份）：
windows?: WindowState;
```

### 3.4 `src/main/services/ipc.ts`

- 构造函数新增参数 `windowManager: WindowManager`（放最后一位，减少现有测试构造参数改动量）。
- 新增 handler（均经现有 `this.handle()` 统一包裹 `IpcResult`）：

| 命令 | payload | 返回 | 行为 |
| --- | --- | --- | --- |
| `WINDOW_GET_STATE` | 无 | `WindowState` | `ok(windowManager.getState())` |
| `WINDOW_ENTER_MINI` | 无 | `void` | `enterMiniMode()` |
| `WINDOW_EXIT_MINI` | 无 | `void` | `exitMiniMode()` |
| `MINI_WINDOW_CLOSE` | `WindowKeyPayload` | `void` | 校验 key∈{pomo,todo}，否则 `fail('无效的窗口标识')`；`hideMini(key)` |
| `MINI_WINDOW_OPEN` | `WindowKeyPayload` | `void` | 同上校验；`showMini(key)` |
| `MINI_WINDOW_SET_BOUNDS` | `MiniWindowBoundsPayload` | `void` | 校验 key + bounds 为有限数；`setMiniBounds` |
| `WINDOW_SET_PINNED`（改） | `WindowPinnedPayload` | `void` | 校验 key + `typeof pinned==='boolean'`；**仅** `setMiniPinned(key,pinned)`，不再遍历所有窗口 |

> 注意：`WINDOW_SET_PINNED` 原实现对 `BrowserWindow.getAllWindows()` 全部设置，是「整体联动」根源，必须改为只针对 `windowKey` 对应的小窗。

### 3.5 `src/renderer/api/bridge.ts`

```ts
getWindowState: () => invoke<WindowState>(IpcCommand.WINDOW_GET_STATE),
enterMini:      () => invoke<void>(IpcCommand.WINDOW_ENTER_MINI),
exitMini:       () => invoke<void>(IpcCommand.WINDOW_EXIT_MINI),
closeMini:      (key: MiniWindowKey) => invoke<void>(IpcCommand.MINI_WINDOW_CLOSE, { windowKey: key } satisfies WindowKeyPayload),
openMini:       (key: MiniWindowKey) => invoke<void>(IpcCommand.MINI_WINDOW_OPEN, { windowKey: key } satisfies WindowKeyPayload),
setMiniBounds:  (key: MiniWindowKey, bounds: MiniWindowBoundsPayload['bounds']) => invoke<void>(IpcCommand.MINI_WINDOW_SET_BOUNDS, { windowKey: key, bounds } satisfies MiniWindowBoundsPayload),
setPinned:      (key: MiniWindowKey, pinned: boolean) => invoke<void>(IpcCommand.WINDOW_SET_PINNED, { windowKey: key, pinned } satisfies WindowPinnedPayload), // 改签名
onWindowStateChanged: (h: (s: WindowState) => void) => onEvent<WindowState>(IpcEvent.WINDOW_STATE_CHANGED, h),
```

`preload/index.ts` 无需改动（白名单来自 `Object.values(IpcCommand/IpcEvent)`，自动覆盖新通道）。

### 3.6 托盘命令协调

托盘在主进程，直接调 `windowManager`，不新增 IPC。右键菜单改为按 mode 动态生成：

```ts
const template = [
  { label: '显示窗口', click: () => wm.showAllForCurrentMode() },
  { label: '显示番茄钟窗', click: () => wm.showMini('pomo') },   // mini 模式下可见
  { label: '显示 TODO 窗', click: () => wm.showMini('todo') },   // mini 模式下可见
  { type: 'separator' },
  { label: '退出程序', click: () => quitFromTray() },
];
```

---

## 4. 状态与数据同步

### 4.1 唯一数据源与订阅

- 计时引擎、store、提醒/推送服务仍只在主进程；`startTimerLoop()` 仍只调用一次，多窗口不产生多计时循环。
- `PomodoroEngine.emit()` 与 `StoreService.persistAndBroadcast()` 已用 `BrowserWindow.getAllWindows()` 广播，天然覆盖 3 窗口，**无需改引擎**。
- 每个渲染窗口独立订阅 `TICK/DATA_CHANGED/REMINDER_*` 等事件；`useAppStore.subscribeEvents()` 的模块级 `subscribed` 标志在每个窗口 bundle 内各自为 false→true，不会出现单窗口重复订阅。
- 提醒强提示（置顶+闪烁）由主进程 `ReminderService` 处理，与窗口数量无关；`ReminderOverlay` 只在 main 窗口渲染，避免三个窗口同时弹遮罩。

### 4.2 窗口状态持久化（`StoreService`）

在 `AppData` 加 `windows?: WindowState`，并新增方法：

```ts
getWindowState(): WindowState;                         // 缺省时回退默认并补齐
setMode(mode: UiMode): void;                           // 写 mode + persist（不触发 DATA_CHANGED 业务刷新）
updateMiniWindow(key: MiniWindowKey, patch: Partial<WindowGeometry>): void; // 写 geometry + persist
```

- `createDefaultData()` 增加 `windows`：`mode:'standard'`，两小窗默认 `{open:false, x:24|432, y:24, width:392, height:470, pinned:false}`（沿用现有 `defaultMiniWindows` 值）。
- `ensureShape()` 兼容旧配置/旧备份：缺 `windows` 用默认补齐；对 x/y/width/height 做有限数与范围 clamp（宽高 ≥ 260/200，坐标允许负值以支持多显示器，但限制在 ±100000 防脏数据）。
- `replaceAppData()`（导入恢复）：**保留本地 `windows`**，不用备份里的布局覆盖——窗口布局是设备相关偏好，不应跨设备同步。实现：写回前 `const localWindows = this.store.get('windows')`，合并覆盖 `data.windows`。
- `isAppData()`（ipc.ts 导入校验）：`windows` 为可选字段，缺失仍视为合法。

### 4.3 写回时机与节流

- `WindowManager` 监听小窗 `moved`（拖动结束）与 `resize` 事件，用模块级 `Map<key, Timeout>` 做 200ms 尾节流，取 `win.getBounds()` 写 `updateMiniWindow`；`setMiniBounds`/`setMiniPinned`/`hideMini`/`enter|exitMiniMode` 立即写。
- 主窗口 geometry 不持久化（沿用现有固定尺寸），避免与既有行为冲突。

### 4.4 Zustand store（`useAppStore.ts`）

- `miniWindows: Record<MiniWindowKey, MiniWindowState>` 保留，语义改为**主进程窗口状态的镜像**；shape 与 `WindowGeometry` 对齐（默认 open=false）。
- 初始化 `initialize()`：`bridge.getWindowState()` 拉取一次，写入 `miniWindows`；并订阅 `bridge.onWindowStateChanged()` 同步（放入 `subscribeEvents`，仍只订阅一次）。
- `toggleMiniPin(key)` 改为**独立置顶**：`const next = !miniWindows[key].pinned; bridge.setPinned(key,next)`；删除原来同时改 pomo+todo 的联动代码。
- `closeMiniWindow(key)` / `openMiniWindow(key)`：改为先 `bridge.closeMini/openMini`，成功后由 `WINDOW_STATE_CHANGED` 回写，不再仅本地 `setMiniWindow`。
- `setMode(mode)`：不再自行切换渲染；改为调用 `bridge.enterMini()/exitMini()`，由主进程广播回写 `mode`。`App.tsx` 不再按 `mode` 决定渲染主体（改按 window type）。
- `Layout.tsx`「极简模式」按钮 `setMode('mini')` 调用链保持，底层已换成 IPC。

---

## 5. 文件清单

### 新增

| 文件 | 改动要点 |
| --- | --- |
| `src/shared/windowKind.ts` | `detectWindowType()` 读 `location.search`，返回 `WindowType`；不依赖 electron |
| `src/main/windows.ts` | `WindowManager` 类：3 窗口生命周期、懒创建、显隐协调、置顶、bounds、持久化、状态广播、moved/resize 节流 |
| `src/renderer/components/MiniWindowShell.tsx` | 真实小窗外壳：自绘标题栏（红黄绿圆点/置顶/切标准/关闭）+ `children` 内容区 + 右下角缩放 handle；拖动用 `WebkitAppRegion:'drag'`，按钮 `no-drag`；置顶/关闭/切标准/缩放全部走 bridge |
| `tests/multiWindow.test.mjs` | 新增：多窗口生命周期、独立置顶、退出只备份一次、托盘协调、bounds 持久化断言 |

### 修改

| 文件 | 改动要点 |
| --- | --- |
| `src/shared/ipcChannels.ts` | +6 命令 +1 事件；`channels` 数量变化 |
| `src/shared/types.ts` | +`WindowType/MiniWindowKey/UiMode/WindowGeometry/WindowState/WindowKeyPayload/MiniWindowBoundsPayload`；改 `WindowPinnedPayload`；`AppData.windows?` |
| `src/main/index.ts` | 装配 `WindowManager`；托盘改调 wm；三个窗口 close 拦截；`loadWindowView` 带 query；`before-quit/window-all-closed` 保持备份唯一；`IpcRegistry` 传 wm |
| `src/main/services/ipc.ts` | 构造参数 +`windowManager`；新增 6 handler；`WINDOW_SET_PINNED` 改为单窗口置顶；导入校验兼容 `windows` 可选 |
| `src/main/store.ts` | `AppData.windows` 默认值、`ensureShape` 补齐/clamp、`getWindowState/setMode/updateMiniWindow`、`replaceAppData` 保留本地布局 |
| `src/renderer/api/bridge.ts` | +7 方法、`setPinned` 改签名、+`onWindowStateChanged` |
| `src/renderer/App.tsx` | 按 `detectWindowType()` 分流；main 挂载全局浮层，小窗只挂 `MiniWindowShell` |
| `src/renderer/store/useAppStore.ts` | 窗口状态镜像、`toggleMiniPin` 独立、close/open/setMode 走 bridge、订阅 `WINDOW_STATE_CHANGED` |
| `src/renderer/components/Layout.tsx` | 按钮文案/提示更新为「打开两个独立小窗」；调用链不变（`setMode('mini')`） |
| `src/renderer/components/MiniDesktop.tsx` | 保留文件但 **App 不再引用**（可标记废弃/后续删除）；`compact` 视图继续复用 |
| `tests/stubs/electron.ts` | `FakeWindow` 支持 `windowType/getBounds/setBounds/alwaysOnTop` 记录与 `moved/resize` 发射；`loadFile` 接收第二参 query |
| `tests/ipcContract.test.mjs` | 命令数 30、事件数 6、key 列表、handler 数 30 |
| `tests/tray.test.mjs` | 兼容懒创建（启动仍 1 窗口）；补充 mini 模式托盘协调断言（可放 multiWindow.test） |
| `tests/helpers/helpers.mjs` | `makeStore()` 增加 window 状态相关方法（供 IpcRegistry/WM 测试） |

> `PomodoroEngine.ts` / `WorkTimerEngine.ts` / `preload/index.ts` / `electron.vite.config.ts` / `index.html` **不改**。

---

## 6. 任务分解（有序，含依赖）

| 任务 | 名称 | 主要文件 | 依赖 | 优先级 |
| --- | --- | --- | --- | --- |
| T01 | 契约与状态基座 | `shared/ipcChannels.ts`、`shared/types.ts`、`shared/windowKind.ts`、`main/store.ts` | — | P0 |
| T02 | 主进程窗口管理与 IPC/托盘集成 | `main/windows.ts`、`main/index.ts`、`main/services/ipc.ts` | T01 | P0 |
| T03 | 渲染层窗口分流与小窗外壳 | `renderer/App.tsx`、`renderer/components/MiniWindowShell.tsx`、`renderer/store/useAppStore.ts`、`renderer/components/Layout.tsx`、`renderer/api/bridge.ts` | T01 | P0 |
| T04 | 测试层扩展 | `tests/stubs/electron.ts`、`tests/ipcContract.test.mjs`、`tests/helpers/helpers.mjs`、`tests/multiWindow.test.mjs` | T01 | P0 |
| T05 | 端到端联调与边界加固 | 上述全部 + `docs/MULTIWINDOW_DESIGN.md` 自检收尾 | T02,T03,T04 | P1 |

> T02/T03/T04 只依赖 T01，可并行开发；T05 统一联调（多屏 clamp、节流、提醒去重、备份唯一、dev/自启场景）。

---

## 7. 共享约定

1. **窗口类型标识**统一用 `WindowType = 'main' | 'pomo' | 'todo'`，小窗 key 用 `MiniWindowKey = 'pomo' | 'todo'`；禁止散落 `'pomo'/'todo'/'main'` 魔法字符串以外的别名（如 `pomodoro`、`mini-a`）。
2. **IPC 通道字符串只在 `shared/ipcChannels.ts` 定义**；preload 白名单来自常量，测试会扫描魔法字符串。
3. **所有命令返回 `IpcResult<T>={ok,data?,message?}`**；失败信息用中文，主进程 `this.handle` 统一包裹异常。
4. **payload 一律具名对象**：窗口相关命令必带 `windowKey`，便携校验 `windowKey∈{'pomo','todo'}`。
5. **单位**：坐标/尺寸为设备无关像素（DIP）；时间为毫秒 epoch；与现有约定一致。
6. **命名规范**：命令 `WINDOW_*`（模式级）/ `MINI_WINDOW_*`（单小窗级）；bridge 方法 `enterMini/exitMini/closeMini/openMini/setMiniPinned(setPinned)/setMiniBounds/getWindowState/onWindowStateChanged`。
7. ** mode 唯一数据源是主进程 store**，渲染层 `mode` 只是镜像，不得本地决定渲染分支。

---

## 8. 边界与风险

| 风险 | 处理 |
| --- | --- |
| frameless 拖不动 | 标题栏 `WebkitAppRegion:'drag'`，所有按钮/交互 `WebkitAppRegion:'no-drag'`；不要用假窗口那种「叠 no-drag 透明面」的 hack（真实窗口会被吞事件） |
| frameless 无法系统缩放 | 右下角自绘 handle + `bridge.setMiniBounds` → 主进程 `setBounds`；`minWidth:260,minHeight:200` 由主进程拦截 clamp |
| 多显示器边界 | geometry 坐标允许负值；`setMiniBounds` 时用 `screen.getDisplayMatching(bounds)` 校验目标至少部分落在某显示器，否则回退到主显示器工作区左上，避免窗口「消失」 |
| 关闭多窗口重复备份 | `createAutoBackup()` 仅在 `before-quit` 一次；窗口 `close`/`window-all-closed` 不调用 |
| `app.quit()` 被误触发 | 所有窗口 `close` 在 `!isQuitting` 时 `preventDefault+hide`；托盘退出先置 `isQuitting=true` |
| 开机自启启动到哪种窗口 | 固定 standard：启动只建主窗口，不读 mode 自动进极简（登录项不携带模式信息，行为可预测） |
| dev 模式多窗口 | `ELECTRON_RENDERER_URL` 后拼 `?window=`；HMR 下三窗口各自热更新，注意 `WindowManager` 不要在 reload 时重复创建小窗（用 `getMiniWindow` 复用） |
| 置顶层级冲突 | 小窗各自 `setAlwaysOnTop` 互不影响；强提醒的 `screen-saver` 级置顶由 `ReminderService` 统一，退出提醒后恢复各窗自身 pinned 状态（在 `reminder:hide` 时按 store 重放 `setAlwaysOnTop`） |
| Electron 33 兼容 | `loadFile(path,{query})`、`screen.getDisplayMatching`、`setBounds`、`app-region` 均在 33 可用；`contextIsolation:true/webPreferences` 三窗一致；每窗都要 `setWindowOpenHandler` 外链拦截 |
| 提醒/设置弹窗重复 | 只在 main 窗口挂载全局浮层；小窗 App 跳过这些组件 |
| 旧备份兼容 | `windows?` 可选；`ensureShape` 补齐；导入不覆盖本地窗口布局 |

---

## 9. 测试策略

### 9.1 stub 扩展（`tests/stubs/electron.ts`）

- `FakeWindow` 增加：`windowType: WindowType`（构造 options 可读）、`bounds={x,y,width,height}`、`getBounds()/setBounds(b)`、`emit('moved')/emit('resize')`（透到 `events`），`setAlwaysOnTop` 已存在可复用 `alwaysOnTop`。
- `loadFile(_file, _opts?)` 接受第二参（query），记录到 `state` 以便断言 `window=pomo/todo`。
- `StubBrowserWindow` 构造时把 `options` 上的自定义字段（如 `windowType`）挂到实例；`state.windows` 已是数组，天然支持多实例。
- `resetElectronStub()` 清空新增字段（windows 数组已清）。
- `screen.getDisplayMatching` stub：返回一个 `{ workArea }`，便于 clamp 测试。

### 9.2 既有测试更新

- `ipcContract.test.mjs`：命令 30 / 事件 6 / handler 30；新增 key（`WINDOW_GET_STATE` 等 6 + `WINDOW_STATE_CHANGED`）加入排序列表；三端一致与无魔法字符串断言保持。
- `tray.test.mjs`：启动仍 1 窗口（懒创建），原有断言保持；补充退出流程 `before-quit` 只触发一次备份的计数断言（stub `getPathCalls`/copy 计数）。

### 9.3 新增 `tests/multiWindow.test.mjs` 断言

1. `enterMini()` 后 `state.windows.length===3`，main 隐藏、两小窗可见且 `windowType` 正确。
2. `setPinned('pomo',true)` 后仅 pomo 的 `alwaysOnTop===true`，todo 保持 false（独立置顶）。
3. 小窗 `close` 事件被拦截（prevented=true）且仅 `hide`，`quitCalls===0`。
4. `exitMini()` 后两小窗隐藏、main 显示、store.mode==='standard'。
5. `WINDOW_STATE_CHANGED` 事件在 enter/exit/pin/close 时各广播一次，payload 含 mode + windows。
6. 托盘 toggle 在 mini 模式切换小窗显隐、在 standard 模式切换 main。
7. 退出：`quitFromTray()` → `quitCalls===1`，`before-quit` 后 `createAutoBackup` 恰好 1 次，三窗 `close` 不再被拦截。
8. `setMiniBounds` 经 clamp：非法 NaN/超小尺寸被拒绝或修正，超过显示器范围回退 workArea。
9. 导入数据不覆盖本地 `windows` 布局。

---

## IS_PASS 方案自检

| # | 需求/约束 | 设计满足 | 证据 |
| --- | --- | --- | --- |
| 1 | 两个真正独立系统窗口 | ✅ | 3 个 BrowserWindow，frameless，可任意摆放/移动/缩放/置顶/关闭 |
| 2 | 脱离主程序摆放 | ✅ | 极简模式隐藏 main，两小窗为顶级系统窗口 |
| 3 | 托盘常驻、关闭不退出 | ✅ | 三窗 close→hide；托盘保留并协调；仅退出菜单 app.quit |
| 4 | 右键「显示窗口」「退出程序」、左键切换 | ✅ | 动态菜单 + `toggleVisible()` |
| 5 | 退出触发自动备份一次 | ✅ | `before-quit` 唯一调用点 |
| 6 | 切回标准：关两小窗、显主窗、mode=standard | ✅ | `exitMiniMode()` |
| 7 | 小窗独立置顶 | ✅ | `WINDOW_SET_PINNED` 带 windowKey，只设目标窗 |
| 8 | 复用 compact 视图 / 不改计时核心 | ✅ | `MiniWindowShell` 内嵌 `<PomodoroView compact/>`/`<TodoView compact/>`；引擎零改动 |
| 9 | 最小变更、无新依赖 | ✅ | 新增 4 文件，复用 store/tray/bridge 架构，依赖不变 |
| 10 | 主进程唯一数据源 | ✅ | 窗口状态入 StoreService；渲染层只镜像 |
| 11 | 多窗口不重复计时/提醒 | ✅ | 单计时循环；广播机制复用；提醒浮层仅 main |
| 12 | 跨重启恢复布局 | ✅ | geometry/pinned 持久化 + ensureShape 兼容 |
| 13 | 契约测试可更新 | ✅ | 明确 24→30、5→6、handler 数 |
| 14 | Electron 33 / Windows frameless drag-resize | ✅ | app-region drag + 手动 setBounds + clamp |
