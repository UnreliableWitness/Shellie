import path from 'node:path';
import { app, BrowserWindow, type NativeImage } from 'electron';
import type { ColorScheme } from '../shared/theme';
import { sleep } from './async';
import { splashBackground } from './windowChrome';

const SPLASH_MIN_MS = 1200;
const SPLASH_FADE_MS = 200;
/** Each step stays on screen at least this long: boot is faster than reading, so steps are queued and paced. */
const SPLASH_STEP_MS = 350;
/** Longest the handoff waits for the splash to show at all, so a splash that never paints cannot block boot. */
export const SPLASH_CAP_MS = 8000;

export type SplashWindowLike = {
  isDestroyed(): boolean;
  webContents: {
    send(channel: string, ...args: unknown[]): void;
    once(event: 'did-finish-load', fn: () => void): void;
  };
  close(): void;
  once(event: 'ready-to-show' | 'closed', fn: () => void): void;
};

/** Reports boot steps to the splash window and gates the handoff on the minimum animation time. */
export class SplashReporter {
  private failed = false;
  private pageReady = false;
  private queue: string[] = [];
  private pacing: ReturnType<typeof setTimeout> | null = null;
  private failMessage: string | null = null;
  private release: (() => void) | null = null;
  private readonly minMs: number;
  private readonly fadeMs: number;
  private readonly stepMs: number;
  private readonly gate: Promise<void>;

  constructor(
    private readonly win: SplashWindowLike | null,
    opts: {
      minMs?: number;
      fadeMs?: number;
      capMs?: number;
      stepMs?: number;
    } = {},
  ) {
    this.minMs = opts.minMs ?? SPLASH_MIN_MS;
    this.fadeMs = opts.fadeMs ?? SPLASH_FADE_MS;
    this.stepMs = opts.stepMs ?? SPLASH_STEP_MS;
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
    if (!this.active) {
      this.open();
      return;
    }
    const cap = setTimeout(() => this.open(), opts.capMs ?? SPLASH_CAP_MS);
    win!.once('ready-to-show', () => {
      clearTimeout(cap);
      setTimeout(() => this.open(), this.minMs);
    });
    win!.once('closed', () => {
      clearTimeout(cap);
      this.open();
    });
    // ipcRenderer.on does not buffer: replay what was reported before the page listened.
    win!.webContents.once('did-finish-load', () => {
      this.pageReady = true;
      this.pump();
      if (this.failMessage !== null) this.send('splash:fail', this.failMessage);
    });
  }

  get active(): boolean {
    return this.win !== null && !this.win.isDestroyed();
  }

  private open(): void {
    if (!this.failed) this.release?.();
  }

  private send(channel: string, ...args: unknown[]): void {
    if (this.active) this.win!.webContents.send(channel, ...args);
  }

  /** Sends queued steps one at a time, each held for stepMs. */
  private pump(): void {
    if (this.pacing !== null || this.queue.length === 0) return;
    this.send('splash:step', this.queue.shift()!);
    this.pacing = setTimeout(() => {
      this.pacing = null;
      this.pump();
    }, this.stepMs);
  }

  step(label: string): void {
    this.queue.push(label);
    if (this.pageReady) this.pump();
  }

  /** Shows the failure; done() never resolves afterwards, so the splash stays until Quit. */
  fail(message: string): void {
    this.failed = true;
    this.failMessage = message;
    this.queue = [];
    if (this.pageReady) this.send('splash:fail', message);
  }

  skip(): void {
    this.open();
  }

  done(): Promise<void> {
    return this.active ? this.gate : Promise.resolve();
  }

  fadeOut(): Promise<void> {
    if (!this.active) return Promise.resolve();
    this.send('splash:done');
    return sleep(this.fadeMs);
  }

  close(): void {
    if (this.active) this.win!.close();
  }
}

/** Chromium's net::ERR_ABORTED: a navigation that was replaced, not a failure. */
const ERR_ABORTED = -3;

/** `icon` is set on Windows and Linux only (macOS takes the app bundle icon). */
export function createSplashWindow(
  icon: NativeImage | undefined,
  scheme: ColorScheme,
): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 300,
    frame: false,
    resizable: false,
    center: true,
    show: false,
    alwaysOnTop: false,
    backgroundColor: splashBackground(scheme),
    title: 'Shellie',
    ...(icon ? { icon } : {}),
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'splashPreload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  // A splash that cannot load or whose renderer dies is destroyed; its 'closed' releases the handoff.
  const drop = () => {
    if (!win.isDestroyed()) win.destroy();
  };
  win.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== ERR_ABORTED) drop();
  });
  win.webContents.on('render-process-gone', drop);
  const hash = `v=${encodeURIComponent(app.getVersion())}`;
  const loading = SPLASH_WINDOW_VITE_DEV_SERVER_URL
    ? win.loadURL(`${SPLASH_WINDOW_VITE_DEV_SERVER_URL}/splash.html#${hash}`)
    : win.loadFile(
        path.join(
          __dirname,
          `../renderer/${SPLASH_WINDOW_VITE_NAME}/splash.html`,
        ),
        { hash },
      );
  loading.catch(drop);
  return win;
}
