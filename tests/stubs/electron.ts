/**
 * QA-only Electron stub. Bundled into the modules under test by tests/run.mjs,
 * so no Electron runtime / display is required.
 * State is shared through globalThis because esbuild creates one copy per bundle.
 */
interface EmittedEvent {
  event: string;
  payload: unknown;
}

type EventHandler = (...args: unknown[]) => void;

interface StubState {
  emitted: EmittedEvent[];
  handlers: Map<string, (event: unknown, payload?: unknown) => Promise<unknown> | unknown>;
  windows: FakeWindow[];
  appEvents: Map<string, EventHandler[]>;
  loginItem: { openAtLogin: boolean };
  isPackaged: boolean;
  quitCalls: number;
  tray: FakeTray | null;
  trayIconUri: string;
  menuTemplates: Array<Array<Record<string, unknown>>>;
  getPathCalls: string[];
}

interface StubBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface StubWindowOptions extends Partial<StubBounds> {
  windowType?: string;
}

const PRIMARY_WORK_AREA: StubBounds = { x: 0, y: 0, width: 1920, height: 1080 };

const globalRef = globalThis as unknown as {
  __qaElectron?: StubState;
  __qaStoreSeed?: Record<string, unknown>;
};
export const state: StubState =
  globalRef.__qaElectron ??
  (globalRef.__qaElectron = {
    emitted: [],
    handlers: new Map(),
    windows: [],
    appEvents: new Map(),
    loginItem: { openAtLogin: false },
    isPackaged: false,
    quitCalls: 0,
    tray: null,
    trayIconUri: '',
    menuTemplates: [],
    getPathCalls: [],
  });

export class FakeWindow {
  readonly webContents = {
    send: (event: string, payload: unknown): void => {
      state.emitted.push({ event, payload });
    },
    setWindowOpenHandler: (_handler: (details: { url: string }) => unknown): void => undefined,
    setZoomFactor: (_factor: number): void => undefined,
    setVisualZoomLevelLimits: (_min: number, _max: number): void => undefined,
    on: (_event: string, _handler: (event?: unknown) => void): void => undefined,
  };
  readonly events = new Map<string, EventHandler[]>();
  readonly windowType: string;
  bounds: StubBounds;
  lastLoad: { url?: string; file?: string; query?: unknown } | null = null;
  destroyed = false;
  minimized = false;
  alwaysOnTop = false;
  flashing = false;
  visible = false;
  hiddenCount = 0;
  focusCount = 0;

  constructor(options?: StubWindowOptions) {
    this.windowType = options?.windowType ?? 'main';
    this.bounds = {
      x: options?.x ?? 0,
      y: options?.y ?? 0,
      width: options?.width ?? 800,
      height: options?.height ?? 600,
    };
  }

  on(event: string, handler: EventHandler): void {
    const list = this.events.get(event) ?? [];
    list.push(handler);
    this.events.set(event, list);
  }

  /** QA helper: fire a registered window event with an optional argument. */
  emit(event: string, arg?: unknown): void {
    for (const handler of this.events.get(event) ?? []) handler(arg);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  isVisible(): boolean {
    return this.visible;
  }
  restore(): void {
    this.minimized = false;
  }
  show(): void {
    this.visible = true;
  }
  hide(): void {
    this.visible = false;
    this.hiddenCount += 1;
  }
  focus(): void {
    this.focusCount += 1;
  }
  async loadURL(url: string): Promise<void> {
    this.lastLoad = { url };
    return undefined;
  }
  async loadFile(file: string, options?: { query?: unknown }): Promise<void> {
    this.lastLoad = { file, query: options?.query };
    return undefined;
  }
  getBounds(): StubBounds {
    return { ...this.bounds };
  }
  setBounds(patch: Partial<StubBounds>): void {
    this.bounds = { ...this.bounds, ...patch };
  }
  setAlwaysOnTop(value: boolean): void {
    this.alwaysOnTop = value;
  }
  flashFrame(value: boolean): void {
    this.flashing = value;
  }
}

/** BrowserWindow 构造时登记到 getAllWindows()；FakeWindow 本身保持纯手工登记。 */
class StubBrowserWindow extends FakeWindow {
  constructor(options?: StubWindowOptions) {
    super(options);
    state.windows.push(this);
  }
}

export const BrowserWindow = Object.assign(StubBrowserWindow, {
  getAllWindows: (): FakeWindow[] => state.windows,
});

/** 多显示器 clamp 断言用：固定工作区，超范围矩形回退到 (0,0)。 */
export const screen = {
  getDisplayMatching: (_bounds: StubBounds): { workArea: StubBounds } => ({
    workArea: { ...PRIMARY_WORK_AREA },
  }),
  getPrimaryDisplay: (): { workArea: StubBounds } => ({ workArea: { ...PRIMARY_WORK_AREA } }),
};

export class FakeTray {
  readonly events = new Map<string, EventHandler[]>();
  tooltip = '';
  menu: unknown = null;
  destroyed = false;

  constructor(_icon: unknown) {
    state.tray = this;
  }

  on(event: string, handler: EventHandler): void {
    const list = this.events.get(event) ?? [];
    list.push(handler);
    this.events.set(event, list);
  }

  emit(event: string): void {
    for (const handler of this.events.get(event) ?? []) handler();
  }

  setToolTip(value: string): void {
    this.tooltip = value;
  }

  setContextMenu(menu: unknown): void {
    this.menu = menu;
  }

  destroy(): void {
    this.destroyed = true;
    state.tray = null;
  }
}

export const Tray = FakeTray;

export const Menu = {
  buildFromTemplate: (template: Array<Record<string, unknown>>): { template: typeof template } => {
    state.menuTemplates.push(template);
    return { template };
  },
};

export const nativeImage = {
  createFromDataURL: (uri: string): { uri: string } => {
    state.trayIconUri = uri;
    return { uri };
  },
};

export const ipcMain = {
  handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown): void => {
    state.handlers.set(channel, handler);
  },
};

export const contextBridge = { exposeInMainWorld: (): void => undefined };
export const ipcRenderer = {
  invoke: async (): Promise<unknown> => undefined,
  on: (): void => undefined,
  removeListener: (): void => undefined,
};
export const app = {
  whenReady: async (): Promise<void> => undefined,
  on: (event: string, handler: EventHandler): void => {
    const list = state.appEvents.get(event) ?? [];
    list.push(handler);
    state.appEvents.set(event, list);
  },
  quit: (): void => {
    state.quitCalls += 1;
  },
  getPath: (name: string): string => {
    state.getPathCalls.push(name);
    return './.tmp/qa-userdata';
  },
  get isPackaged(): boolean {
    return state.isPackaged;
  },
  getLoginItemSettings: (): { openAtLogin: boolean } => ({ openAtLogin: state.loginItem.openAtLogin }),
  setLoginItemSettings: (settings: { openAtLogin: boolean }): void => {
    state.loginItem.openAtLogin = settings.openAtLogin;
  },
};
export const shell = { openExternal: async (): Promise<void> => undefined };

export function resetElectronStub(): void {
  state.emitted.length = 0;
  state.handlers.clear();
  state.windows.length = 0;
  state.appEvents.clear();
  state.loginItem.openAtLogin = false;
  state.isPackaged = false;
  state.quitCalls = 0;
  state.tray = null;
  state.trayIconUri = '';
  state.menuTemplates.length = 0;
  state.getPathCalls.length = 0;
  delete globalRef.__qaStoreSeed;
}
