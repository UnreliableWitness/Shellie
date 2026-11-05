import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdoWiki, BrainView } from '../../../shared/brain';
import type { Connection } from '../../../shared/types';
import { useStore } from '../../store';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { BrainsSection } from './BrainsSection';

const conn: Connection = {
  id: 'c1',
  name: 'acme-org',
  organizationUrl: 'https://dev.azure.com/acme-org',
  project: 'Acme',
  user: 'Dries',
  status: 'ok',
  checkedAt: '2026-10-14T10:00:00.000Z',
  userUniqueName: null,
  provider: 'azure-devops' as const,
  workItemOnStart: {
    moveToInProgress: true,
    assignToMe: true,
    stateOverrides: {},
  },
  writeTimeToAdo: false,
};

const wiki: AdoWiki = {
  id: 'w1',
  name: 'Acme.wiki',
  type: 'projectWiki',
  repositoryId: 'r1',
  version: 'wikiMaster',
  mappedPath: '/',
  gitUrl: 'https://example/_git/Acme.wiki',
};

const brain = {
  id: 'b1',
  name: 'Acme brain',
  connectionId: 'c1',
  project: 'Acme',
  path: '/data/brains/b1',
  wiki: null,
  options: {
    contextInTaskMd: true,
    addDirForClaude: true,
    syncAfterRefresh: false,
    weeklyDigest: false,
    dailyTokenCap: 500000,
    openBrainTerminalOnStart: false,
    model: 'sonnet',
  },
  health: null,
  jobs: [],
} as unknown as BrainView;

beforeEach(() => useStore.setState({ connections: [conn] }));

describe('BrainsSection', () => {
  it('creates a brain with the picked wiki', async () => {
    const { calls, tracked } = installFakeApi({
      'brain:wikis': () => [wiki],
      'brain:wikiPages': () => [
        { path: '/Customers', gitItemPath: '/Customers.md', isParent: true },
      ],
      'brain:create': () => brain,
    });
    render(<BrainsSection />);
    const user = userEvent.setup();
    expect(screen.getByLabelText('Name')).toHaveValue('Acme brain');
    await user.selectOptions(
      await screen.findByLabelText('Wiki'),
      'Acme.wiki (project wiki)',
    );
    await user.selectOptions(
      await screen.findByLabelText('Root page'),
      '/Customers',
    );
    await user.click(screen.getByRole('button', { name: 'Create brain' }));
    await waitFor(() =>
      expect(calls.map((c) => c.channel)).toContain('brain:create'),
    );
    const create = calls.find((c) => c.channel === 'brain:create');
    expect(create?.args[0]).toEqual({
      name: 'Acme brain',
      connectionId: 'c1',
      project: 'Acme',
      path: null,
      wiki: {
        wikiId: 'w1',
        wikiName: 'Acme.wiki',
        type: 'projectWiki',
        repositoryId: 'r1',
        gitUrl: wiki.gitUrl,
        version: 'wikiMaster',
        mappedPath: '/',
        rootPath: '/Customers',
      },
    });
    await waitFor(() =>
      expect(tracked).toContainEqual(
        expect.objectContaining({
          name: 'settings.brain',
          props: { action: 'create' },
        }),
      ),
    );
  });

  it('disables the wiki picker until the typed project settles', async () => {
    installFakeApi({ 'brain:wikis': () => [wiki] });
    render(<BrainsSection />);
    const user = userEvent.setup();
    const picker = await screen.findByLabelText('Wiki');
    await waitFor(() => expect(picker).toBeEnabled());
    await user.type(screen.getByLabelText('Project'), ' Two');
    expect(screen.getByLabelText('Wiki')).toBeDisabled();
    await waitFor(() => expect(screen.getByLabelText('Wiki')).toBeEnabled());
  });

  it('picks a folder and shows a wikis error', async () => {
    const { calls } = installFakeApi({
      'brain:wikis': () => {
        throw new Error('Missing Code scope');
      },
      'brain:pickFolder': () => '/my/folder',
      'brain:create': () => brain,
    });
    render(<BrainsSection />);
    const user = userEvent.setup();
    expect(await screen.findByText(/Missing Code scope/)).toBeInTheDocument();
    expect(screen.getByText('Default location')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Choose…' }));
    expect(await screen.findByText('/my/folder')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create brain' }));
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'brain:create')?.args[0]).toEqual(
        expect.objectContaining({ path: '/my/folder', wiki: null }),
      ),
    );
  });

  it('lists a brain and updates an option and the model', async () => {
    const { calls } = installFakeApi({
      'brain:list': () => [brain],
      'brain:update': () => brain,
    });
    render(<BrainsSection />);
    const user = userEvent.setup();
    expect(await screen.findByText('/data/brains/b1')).toBeInTheDocument();
    expect(screen.getByText('No wiki')).toBeInTheDocument();
    await user.click(
      screen.getByLabelText(
        'Run /sync after a wiki refresh that changed pages',
      ),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'brain:update')?.args).toEqual([
        'b1',
        { options: { syncAfterRefresh: true } },
      ]),
    );
    await user.selectOptions(screen.getByLabelText('Model'), 'opus');
    await waitFor(() =>
      expect(
        calls.filter((c) => c.channel === 'brain:update')[1]?.args,
      ).toEqual(['b1', { options: { model: 'opus' } }]),
    );
  });

  it('updates skills from the template diff', async () => {
    const { calls } = installFakeApi({
      'brain:list': () => [brain],
      'brain:templateDiff': () => [
        { path: 'a.md', status: 'changed' },
        { path: 'b.md', status: 'same' },
        { path: 'c.md', status: 'missing' },
      ],
    });
    render(<BrainsSection />);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Update skills' }),
    );
    expect(await screen.findByText('c.md')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'brain:updateTemplates')?.args,
      ).toEqual(['b1', ['a.md', 'c.md']]),
    );
  });

  it('deletes after confirming, optionally with the folder', async () => {
    const { calls } = installFakeApi({ 'brain:list': () => [brain] });
    render(<BrainsSection />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(screen.getByText('Delete this brain?')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Also delete the folder'));
    await user.click(screen.getByRole('button', { name: 'Delete brain' }));
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'brain:delete')?.args).toEqual([
        'b1',
        true,
      ]),
    );
  });

  it('opens the folder', async () => {
    const { calls } = installFakeApi({ 'brain:list': () => [brain] });
    render(<BrainsSection />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Open folder' }),
    );
    expect(calls.find((c) => c.channel === 'brain:openFolder')?.args).toEqual([
      'b1',
    ]);
  });

  it('sends one delete on a double click', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { calls } = installFakeApi({
      'brain:list': () => [brain],
      'brain:delete': () => gate as Promise<undefined>,
    });
    render(<BrainsSection />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    const confirm = screen.getByRole('button', { name: 'Delete brain' });
    await user.dblClick(confirm);
    expect(confirm).toBeDisabled();
    release();
    await waitFor(() =>
      expect(calls.filter((c) => c.channel === 'brain:delete')).toHaveLength(1),
    );
  });

  it('disables the toggles while an update is pending', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<BrainView>((r) => {
      release = () => r(brain);
    });
    installFakeApi({
      'brain:list': () => [brain],
      'brain:update': () => gate,
    });
    render(<BrainsSection />);
    const user = userEvent.setup();
    const toggle = await screen.findByLabelText(
      'Run /sync after a wiki refresh that changed pages',
    );
    await user.click(toggle);
    await waitFor(() => expect(toggle).toBeDisabled());
    expect(screen.getByLabelText('Model')).toBeDisabled();
    release();
    await waitFor(() => expect(toggle).toBeEnabled());
  });

  it('queries wikis once after the project field settles', async () => {
    const { calls } = installFakeApi({ 'brain:wikis': () => [wiki] });
    render(<BrainsSection />);
    await waitFor(() =>
      expect(calls.filter((c) => c.channel === 'brain:wikis')).toHaveLength(1),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({
        advanceTimers: (ms) => vi.advanceTimersByTime(ms),
      });
      const input = screen.getByLabelText('Project');
      await user.clear(input);
      await user.type(input, 'Foo');
      expect(calls.filter((c) => c.channel === 'brain:wikis')).toHaveLength(1);
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() =>
      expect(
        calls.filter((c) => c.channel === 'brain:wikis').map((c) => c.args[1]),
      ).toEqual(['Acme', 'Foo']),
    );
  });
});

describe('archiving', () => {
  it('archives from the card, and lists an archived brain apart with Restore', async () => {
    const { calls } = installFakeApi({ 'brain:list': () => [brain] });
    render(<BrainsSection />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Archive' }),
    );
    await waitFor(() =>
      expect(calls).toContainEqual({
        channel: 'brain:update',
        args: ['b1', { archived: true }],
      }),
    );
  });

  it('shows an archived brain under its own heading with Restore', async () => {
    const { calls } = installFakeApi({
      'brain:list': () => [{ ...brain, archived: true }],
    });
    render(<BrainsSection />);
    expect(await screen.findByLabelText('Archived brains')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        channel: 'brain:update',
        args: ['b1', { archived: false }],
      }),
    );
  });
});
