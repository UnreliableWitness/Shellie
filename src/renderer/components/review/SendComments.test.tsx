import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewComment } from '../../../shared/review';
import type { TaskView } from '../../../shared/types';
import { useStore } from '../../store';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { registerTerminal } from '../../terminalRegistry';
import { SendComments } from './SendComments';

const c = (
  id: string,
  status: ReviewComment['status'],
  path = 'src/a.ts',
): ReviewComment => ({
  id,
  workspaceId: 'home',
  path,
  side: 'after',
  startLine: 1,
  endLine: 1,
  snippet: 'x',
  contextBefore: '',
  contextAfter: '',
  text: `note ${id}`,
  status,
  createdAt: '2026-10-17T10:00:00.000Z',
  sentAt: null,
  resolvedAt: null,
});
const task = (terminals: { id: string; kind: string; label: string }[]) =>
  ({
    id: 't1',
    terminals,
    extraWorkspaces: [],
    homeDropped: false,
  }) as unknown as TaskView;

beforeEach(() => localStorage.clear());

describe('SendComments', () => {
  it('pastes the open comments into the Claude tab, marks them sent, and reports the count', async () => {
    const paste = vi.fn();
    const off = registerTerminal('cl', {
      paste,
      focus: vi.fn(),
      modes: { bracketedPasteMode: true },
    } as never);
    const onSent = vi.fn();
    const { calls, tracked } = installFakeApi({
      'terminals:isRunning': () => true,
      'review:markSent': () => ({ version: 1, viewed: {}, comments: [] }),
    });
    render(
      <SendComments
        task={task([
          { id: 'sh', kind: 'shell', label: 'zsh' },
          { id: 'cl', kind: 'claude', label: 'Claude Code' },
        ])}
        comments={[c('a', 'open'), c('b', 'sent'), c('d', 'open')]}
        repoName={() => 'web'}
        multiRepo={false}
        onSent={onSent}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Send 2 comments to Claude Code' }),
    );
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(paste.mock.calls[0][0]).toContain('1. src/a.ts:1');
    expect(paste.mock.calls[0][0]).toContain('note d');
    expect(paste.mock.calls[0][0]).not.toContain('note b');
    expect(calls.find((x) => x.channel === 'review:markSent')?.args).toEqual([
      't1',
      ['a', 'd'],
    ]);
    expect(tracked).toContainEqual({
      type: 'event',
      name: 'review.commentsSent',
      props: { count: 2 },
    });
    off();
  });

  it('sends a base-side comment on a renamed file at its old path, repo-prefixed', async () => {
    const paste = vi.fn();
    const off = registerTerminal('cl', {
      paste,
      focus: vi.fn(),
      modes: { bracketedPasteMode: true },
    } as never);
    installFakeApi({
      'terminals:isRunning': () => true,
      'review:markSent': () => ({ version: 1, viewed: {}, comments: [] }),
    });
    render(
      <SendComments
        task={task([{ id: 'cl', kind: 'claude', label: 'Claude Code' }])}
        comments={[
          {
            ...c('a', 'open', 'src/new.ts'),
            oldPath: 'src/old.ts',
            side: 'before',
            startLine: 30,
            endLine: 30,
          },
        ]}
        repoName={() => 'web'}
        multiRepo
        onSent={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Send 1 comment to Claude Code' }),
    );
    await waitFor(() => expect(paste).toHaveBeenCalled());
    expect(paste.mock.calls[0][0]).toContain(
      '1. web/src/old.ts:30 (removed line, base version; now web/src/new.ts)',
    );
    off();
  });

  it('prefixes the repo name in a multi-repo task and flattens without bracketed paste', async () => {
    const paste = vi.fn();
    const off = registerTerminal('cp', {
      paste,
      focus: vi.fn(),
      modes: { bracketedPasteMode: false },
    } as never);
    installFakeApi({
      'terminals:isRunning': () => true,
      'review:markSent': () => ({ version: 1, viewed: {}, comments: [] }),
    });
    render(
      <SendComments
        task={task([{ id: 'cp', kind: 'copilot', label: 'Copilot CLI' }])}
        comments={[c('a', 'open')]}
        repoName={() => 'web'}
        multiRepo
        onSent={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Send 1 comment to Copilot CLI' }),
    );
    await waitFor(() => expect(paste).toHaveBeenCalled());
    expect(paste.mock.calls[0][0]).toContain('web/src/a.ts:1');
    expect(paste.mock.calls[0][0]).not.toContain('\n');
    off();
  });

  it('is disabled without an agent tab and hidden without open comments', () => {
    installFakeApi();
    const { rerender } = render(
      <SendComments
        task={task([{ id: 'sh', kind: 'shell', label: 'zsh' }])}
        comments={[c('a', 'open')]}
        repoName={() => ''}
        multiRepo={false}
        onSent={vi.fn()}
      />,
    );
    const off = screen.getByRole('button', {
      name: 'Send 1 comment',
    }) as HTMLButtonElement;
    expect(off.disabled).toBe(true);
    expect(off.title).toBe('Open an agent tab first');
    rerender(
      <SendComments
        task={task([{ id: 'cl', kind: 'claude', label: 'Claude Code' }])}
        comments={[c('a', 'sent')]}
        repoName={() => ''}
        multiRepo={false}
        onSent={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('warns when the target terminal is not running', async () => {
    installFakeApi({ 'terminals:isRunning': () => false });
    useStore.setState({ notices: [] });
    render(
      <SendComments
        task={task([{ id: 'cl', kind: 'claude', label: 'Claude Code' }])}
        comments={[c('a', 'open')]}
        repoName={() => ''}
        multiRepo={false}
        onSent={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Send 1 comment to Claude Code' }),
    );
    await waitFor(() =>
      expect(useStore.getState().notices).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          message: 'Claude Code is not running',
        }),
      ),
    );
  });

  it('pastes once on a double click', async () => {
    const paste = vi.fn();
    const off = registerTerminal('cl', {
      paste,
      focus: vi.fn(),
      modes: { bracketedPasteMode: true },
    } as never);
    const onSent = vi.fn();
    const { calls } = installFakeApi({
      'terminals:isRunning': () => true,
      'review:markSent': () => ({ version: 1, viewed: {}, comments: [] }),
    });
    render(
      <SendComments
        task={task([{ id: 'cl', kind: 'claude', label: 'Claude Code' }])}
        comments={[c('a', 'open')]}
        repoName={() => ''}
        multiRepo={false}
        onSent={onSent}
      />,
    );
    const b = screen.getByRole('button', {
      name: 'Send 1 comment to Claude Code',
    });
    fireEvent.click(b);
    fireEvent.click(b);
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(paste).toHaveBeenCalledTimes(1);
    expect(calls.filter((x) => x.channel === 'review:markSent')).toHaveLength(
      1,
    );
    off();
  });
});
