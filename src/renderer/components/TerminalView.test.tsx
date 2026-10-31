import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { installFakeApi } from '../test-helpers/fakeApi';
import { TerminalView } from './TerminalView';

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    modes = {};
    loadAddon() {}
    cols = 80;
    rows = 24;
    open() {}
    write() {}
    reset() {}
    focus() {}
    paste() {}
    attachCustomKeyEventHandler() {}
    dispose() {}
    onData() {
      return { dispose() {} };
    }
    registerLinkProvider() {
      return { dispose() {} };
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock('../terminalSetup', () => ({
  followColorScheme: () => () => undefined,
  loadRenderer: () => undefined,
  terminalOptions: () => ({}),
  windowsBuild: async () => null,
}));

class NoResize {
  observe() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoResize as never;

/** A terminal main does not know: the app was relaunched since it started. */
const relaunched = () =>
  installFakeApi({
    'terminals:buffer': () => null,
    'terminals:isRunning': () => false,
    'terminals:restart': () => undefined,
  });

const restarts = (calls: { channel: string }[]) =>
  calls.filter((c) => c.channel === 'terminals:restart').length;

describe('TerminalView after an app relaunch', () => {
  it('starts an autoStart terminal again when it is shown', async () => {
    const { calls } = relaunched();
    const { rerender } = render(
      <TerminalView terminalId="t1" taskId="a" active={false} autoStart />,
    );
    expect(await screen.findByText('Process ended')).toBeInTheDocument();
    expect(restarts(calls)).toBe(0);
    rerender(<TerminalView terminalId="t1" taskId="a" active autoStart />);
    await waitFor(() => expect(restarts(calls)).toBe(1));
    expect(screen.queryByText('Process ended')).not.toBeInTheDocument();
  });

  it('sizes the restarted process to the view (#162)', async () => {
    const { calls } = relaunched();
    const width = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(800);
    const height = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockReturnValue(600);
    try {
      render(<TerminalView terminalId="t1" taskId="a" active />);
      const resizes = () =>
        calls
          .filter((c) => c.channel === 'terminals:resize')
          .map((c) => c.args);
      // Let the sizing on open and on being shown settle (main did not know the terminal then).
      await screen.findByRole('button', { name: 'Restart' });
      await new Promise((r) => setTimeout(r, 50));
      const before = resizes().length;
      screen.getByRole('button', { name: 'Restart' }).click();
      await waitFor(() => expect(restarts(calls)).toBe(1));
      await waitFor(() =>
        expect(resizes().slice(before)).toEqual([['t1', 80, 24]]),
      );
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
  });

  it('leaves other terminals for the user to restart', async () => {
    const { calls } = relaunched();
    render(<TerminalView terminalId="t1" taskId="a" active />);
    expect(
      await screen.findByRole('button', { name: 'Restart' }),
    ).toBeInTheDocument();
    expect(restarts(calls)).toBe(0);
  });

  it('does not restart a terminal whose process exited in this run', async () => {
    const { calls } = installFakeApi({
      'terminals:buffer': () => 'bye',
      'terminals:isRunning': () => false,
      'terminals:restart': () => undefined,
    });
    render(
      <TerminalView terminalId="t1" taskId="a" active autoStart resumes />,
    );
    expect(
      await screen.findByRole('button', { name: 'Resume session' }),
    ).toBeInTheDocument();
    expect(restarts(calls)).toBe(0);
  });
});

describe('TerminalView reset by main', () => {
  it('clears the exit bar and sizes the new process (#105)', async () => {
    const { calls, emit } = installFakeApi({
      'terminals:buffer': () => '',
      'terminals:isRunning': () => true,
      'terminals:resize': () => undefined,
    });
    const width = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(800);
    const height = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockReturnValue(600);
    try {
      render(<TerminalView terminalId="t1" taskId="a" active resumes />);
      const resizes = () =>
        calls.filter((c) => c.channel === 'terminals:resize').length;
      // Let the sizing on open and on being shown settle.
      await waitFor(() => expect(resizes()).toBeGreaterThan(0));
      await new Promise((r) => setTimeout(r, 50));
      const before = resizes();
      emit('terminal:exit', { id: 't1', exitCode: 1 });
      expect(
        await screen.findByRole('button', { name: 'Resume session' }),
      ).toBeInTheDocument();
      emit('terminal:reset', { id: 't2' });
      emit('terminal:reset', { id: 't1' });
      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: 'Resume session' }),
        ).not.toBeInTheDocument(),
      );
      expect(resizes()).toBe(before + 1);
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
  });
});

describe('TerminalView sizing', () => {
  const resizes = (calls: { channel: string }[]) =>
    calls.filter((c) => c.channel === 'terminals:resize').length;
  const running = () =>
    installFakeApi({
      'terminals:buffer': () => '',
      'terminals:isRunning': () => true,
      'terminals:resize': () => undefined,
    });

  it('does not size the pty while the terminal is hidden (#70)', async () => {
    const { calls } = running();
    // jsdom has no layout: every box is 0 x 0, like a display:none one.
    render(<TerminalView terminalId="t1" taskId="a" active={false} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(resizes(calls)).toBe(0);
  });

  it('sizes the pty once the terminal has a box', async () => {
    const { calls } = running();
    const width = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(800);
    const height = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockReturnValue(600);
    try {
      render(<TerminalView terminalId="t1" taskId="a" active />);
      await waitFor(() => expect(resizes(calls)).toBeGreaterThan(0));
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
  });
});

describe('TerminalView when an agent fails to start (#109)', () => {
  const invalidConfig = {
    reason: 'invalid-config' as const,
    title: 'OpenCode could not read its configuration',
    detail: 'Expected object | undefined, got "Read, Glob" tools',
    file: 'C:\\repo\\.opencode\\agents\\wiki.md',
    hint: 'Fix or remove wiki.md, then Restart.',
    canSkipProjectConfig: true,
  };

  it('says what happened and offers to start OpenCode without the project config', async () => {
    const { calls, emit } = installFakeApi({
      'terminals:buffer': () => '',
      'terminals:isRunning': () => true,
      'terminals:restart': () => undefined,
    });
    render(<TerminalView terminalId="t1" taskId="a" active />);
    await waitFor(() =>
      expect(calls.some((c) => c.channel === 'terminals:isRunning')).toBe(true),
    );
    emit('terminal:exit', { id: 't1', exitCode: 1, failure: invalidConfig });
    expect(
      await screen.findByText('OpenCode could not read its configuration'),
    ).toBeInTheDocument();
    expect(screen.getByText(/got "Read, Glob" tools/)).toBeInTheDocument();
    expect(screen.getByText(/Fix or remove wiki\.md/)).toBeInTheDocument();
    expect(screen.getByText(/Exited with code 1/)).toBeInTheDocument();
    screen
      .getByRole('button', { name: 'Start without project config' })
      .click();
    await waitFor(() =>
      expect(
        calls
          .filter((c) => c.channel === 'terminals:restart')
          .map((c) => c.args),
      ).toEqual([['t1', { withoutProjectConfig: true }]]),
    );
    await waitFor(() =>
      expect(
        screen.queryByText('OpenCode could not read its configuration'),
      ).not.toBeInTheDocument(),
    );
  });

  it('shows the failure of a tab that exited before the view was shown', async () => {
    installFakeApi({
      'terminals:buffer': () => 'zsh:1: command not found: opencode',
      'terminals:isRunning': () => false,
      'terminals:failure': () => ({
        reason: 'missing-cli',
        title: 'OpenCode is not installed or not on PATH',
        hint: 'Install OpenCode, then Restart.',
      }),
    });
    render(<TerminalView terminalId="t1" taskId="a" active />);
    expect(
      await screen.findByText('OpenCode is not installed or not on PATH'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Start without project config' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument();
  });
});

describe('TerminalView leak watch', () => {
  it('shows the notice main reports, restores it on mount, and resumes a paused tab', async () => {
    const fake = installFakeApi({
      'terminals:isRunning': () => true,
      'terminals:leak': () => ({ names: ['STRIPE_SECRET_KEY'], paused: false }),
      'terminals:resume': () => undefined,
      'terminals:stop': () => undefined,
    });
    render(<TerminalView terminalId="t1" taskId="task" active />);
    await screen.findByText(/A secret value showed up in this tab/);
    act(() =>
      fake.emit('terminal:leak', {
        id: 't1',
        names: ['STRIPE_SECRET_KEY', 'DB_PASSWORD'],
        paused: true,
      }),
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'A Production secret appeared',
    );
    // Another tab's leak is not this tab's.
    act(() =>
      fake.emit('terminal:leak', { id: 'other', names: ['X'], paused: false }),
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    screen.getByRole('button', { name: 'Resume' }).click();
    await waitFor(() =>
      expect(fake.calls.some((c) => c.channel === 'terminals:resume')).toBe(
        true,
      ),
    );
    screen.getByRole('button', { name: 'Stop' }).click();
    await waitFor(() =>
      expect(
        fake.calls.find((c) => c.channel === 'terminals:stop')?.args,
      ).toEqual(['t1']),
    );
  });
});
