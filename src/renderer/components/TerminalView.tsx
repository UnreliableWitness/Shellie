import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { RestartOptions } from '../../shared/ipc';
import type { LeakState } from '../../shared/secrets';
import type { TerminalFailure } from '../../shared/terminalFailure';
import type { ColorScheme } from '../../shared/theme';
import { api, tryInvoke } from '../api';
import { currentColorScheme } from '../colorScheme';
import { useStore } from '../store';
import { attachClipboardKeys, isMac } from '../terminalClipboard';
import { createLinkProvider } from '../terminalLinks';
import { registerTerminal } from '../terminalRegistry';
import { LeakNotice } from './secrets/LeakNotice';
import {
  followColorScheme,
  loadRenderer,
  terminalOptions,
  windowsBuild,
} from '../terminalSetup';

export function TerminalView({
  terminalId,
  taskId,
  workspaceId,
  active,
  resumes = false,
  autoStart = false,
}: {
  terminalId: string;
  taskId: string;
  /** The workspace the terminal runs in, for links; absent means the task's active home. */
  workspaceId?: string;
  active: boolean;
  /** Claude Code: Restart resumes the conversation, so the button says so. */
  resumes?: boolean;
  /** Started again by itself when first shown after an app relaunch (its process is gone, not exited). */
  autoStart?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  /** Fits the terminal to its box and tells the pty; a no-op while hidden. */
  const sendSize = useRef<() => void>(() => undefined);
  const notify = useStore((s) => s.notify);
  const [exitCode, setExitCode] = useState<number | null>(null);
  /** Why an agent tab stopped, when main could tell (#109). */
  const [failure, setFailure] = useState<TerminalFailure | null>(null);
  /** Main has no process for this terminal: the app was relaunched (or updated) since it started. */
  const [gone, setGone] = useState(false);
  /** Leak watch: stored values that showed up in this (agent) tab, and whether its input is paused. */
  const [leak, setLeak] = useState<LeakState | null>(null);
  const go = useStore((s) => s.go);
  const repoId = useStore((s) => s.tasks.find((t) => t.id === taskId)?.repoId);

  useEffect(() => {
    let live = true;
    const off = api().on('terminal:leak', ({ id, ...state }) => {
      if (id === terminalId) setLeak(state);
    });
    // Mounted after the leak (another page, a relaunch of the view): main keeps the tab's state.
    void api()
      .invoke('terminals:leak', terminalId)
      .then((state) => {
        if (live && state) setLeak((cur) => cur ?? state);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      off();
    };
  }, [terminalId]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const t = new Terminal(terminalOptions(null));
    const f = new FitAddon();
    t.loadAddon(f);
    attachClipboardKeys(t, isMac, navigator.clipboard);
    term.current = t;
    // Programs that asked for scheme reports (Claude Code's auto theme) hear of the switch and ask for the new colours.
    const report = (scheme: ColorScheme) =>
      void api()
        .invoke('terminals:reportScheme', terminalId, scheme)
        .catch(() => undefined);
    const offScheme = followColorScheme(t, report);
    const unregister = registerTerminal(terminalId, t);
    let live = true;
    let links: { dispose(): void } | null = null;

    sendSize.current = () => {
      // A hidden box has no layout: FitAddon would read its width and height as the literal "100%", fit to
      // 100 x 100 px (12 columns) and ConPTY would draw the prompt wrapped at that width for good (#70).
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      try {
        f.fit();
        void api().invoke('terminals:resize', terminalId, t.cols, t.rows);
      } catch {
        /* not opened yet */
      }
    };
    // Live chunks are queued until the buffer snapshot is written, so output is
    // neither lost nor duplicated. Chunks that arrived before main took the
    // snapshot are already in the buffer: skip the longest queued prefix that
    // the buffer ends with.
    let replayed = false;
    const queued: string[] = [];
    const offData = api().on('terminal:data', (e) => {
      if (e.id !== terminalId) return;
      if (replayed) t.write(e.data);
      else queued.push(e.data);
    });
    const offExit = api().on('terminal:exit', (e) => {
      if (e.id !== terminalId) return;
      setExitCode(e.exitCode);
      setFailure(e.failure ?? null);
    });
    const offReset = api().on('terminal:reset', (e) => {
      if (e.id !== terminalId) return;
      t.reset();
      setExitCode(null);
      setFailure(null);
      sendSize.current();
    });
    void api()
      .invoke('terminals:buffer', terminalId)
      .catch(() => null)
      .then((buf) => {
        if (!live) return;
        // Only a terminal main does not know has no buffer.
        if (buf === null) setGone(true);
        const snapshot = buf ?? '';
        if (snapshot) t.write(snapshot);
        let skip = 0;
        let joined = '';
        for (let k = 1; k <= queued.length; k++) {
          joined += queued[k - 1];
          if (snapshot.endsWith(joined)) skip = k;
        }
        for (const chunk of queued.slice(skip)) t.write(chunk);
        queued.length = 0;
        replayed = true;
        return api().invoke('terminals:isRunning', terminalId);
      })
      .then(async (running) => {
        if (!live || running !== false) return;
        setExitCode((c) => c ?? -1);
        // It exited before this view was mounted: show why, when main knows.
        const f = await api().invoke('terminals:failure', terminalId);
        if (live && f) setFailure((cur) => cur ?? f);
      })
      .catch(() => undefined);
    const onData = t.onData((data) => {
      void api().invoke('terminals:write', terminalId, data);
    });
    const observer = new ResizeObserver(() => sendSize.current());
    // Open once the ConPTY build is known. Output written before that is buffered by xterm.
    void windowsBuild().then((build) => {
      if (!live) return;
      if (build) t.options.windowsPty = terminalOptions(build).windowsPty;
      t.open(el);
      loadRenderer(t);
      links = t.registerLinkProvider(
        createLinkProvider(t, taskId, { workspaceId }),
      );
      observer.observe(el);
      sendSize.current();
      // xterm answers colour queries only once open; the scheme may also have changed while this view was not
      // mounted. Telling again is harmless.
      report(currentColorScheme());
    });

    return () => {
      live = false;
      observer.disconnect();
      onData.dispose();
      links?.dispose();
      offData();
      offExit();
      offReset();
      unregister();
      offScheme();
      t.dispose();
      term.current = null;
    };
  }, [terminalId, taskId, workspaceId]);

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        sendSize.current();
        term.current?.focus();
      });
    }
  }, [active]);

  const restart = async (options?: RestartOptions) => {
    // Reset first so a fast exit of the new process is not wiped afterwards.
    const previous = exitCode;
    const previousFailure = failure;
    term.current?.reset();
    setExitCode(null);
    setFailure(null);
    const ok = await tryInvoke(async () => {
      await (options
        ? api().invoke('terminals:restart', terminalId, options)
        : api().invoke('terminals:restart', terminalId));
      // The box did not change size, so the ResizeObserver stays quiet: tell the new process its size (#162).
      sendSize.current();
      return true;
    }, notify);
    if (!ok) {
      setExitCode((c) => c ?? previous);
      setFailure((f) => f ?? previousFailure);
    }
  };
  useEffect(() => {
    if (!active || !gone || !autoStart) return;
    setGone(false);
    void restart();
    // restart is recreated each render; this runs once per relaunch, when the tab is first shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, gone, autoStart]);
  const close = () =>
    tryInvoke(() => api().invoke('terminals:kill', terminalId), notify);

  return (
    <div className="termview" hidden={!active}>
      <div ref={host} className="termview-xterm" />
      <LeakNotice
        state={leak}
        onResume={() =>
          void tryInvoke(
            () => api().invoke('terminals:resume', terminalId),
            notify,
          )
        }
        onStop={() =>
          void tryInvoke(
            () => api().invoke('terminals:stop', terminalId),
            notify,
          )
        }
        onOpenSecrets={() =>
          go(repoId ? { kind: 'secrets', repoId } : { kind: 'secrets' })
        }
      />
      {exitCode !== null && (
        <div
          className={failure ? 'term-exit term-exit-failed' : 'term-exit'}
          role="status"
        >
          {failure && (
            <div className="term-exit-why">
              <strong>{failure.title}</strong>
              {failure.detail && (
                <code className="term-exit-detail">{failure.detail}</code>
              )}
              <span className="term-exit-hint">{failure.hint}</span>
            </div>
          )}
          <span className="term-exit-code">
            {exitCode === -1 ? 'Process ended' : `Exited with code ${exitCode}`}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => restart()}
          >
            {resumes ? 'Resume session' : 'Restart'}
          </button>
          {failure?.canSkipProjectConfig && (
            <button
              type="button"
              className="btn btn-sm"
              title="Starts OpenCode with OPENCODE_DISABLE_PROJECT_CONFIG=1: the repo's opencode.json and .opencode folder are skipped until the next Restart"
              onClick={() => restart({ withoutProjectConfig: true })}
            >
              Start without project config
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={close}
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}
