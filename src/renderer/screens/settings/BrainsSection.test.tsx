import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentsDetected } from '../../../shared/agents';
import type { AdoWiki, BrainView } from '../../../shared/brain';
import type { Connection } from '../../../shared/types';
import { useStore } from '../../store';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { BrainsForConnection, CreateBrainForm } from './BrainsSection';

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
    agent: 'claude',
    opencodeModel: null,
  },
  templatesVersion: 7,
  health: null,
  jobs: [],
} as unknown as BrainView;

const detected = (claude: boolean, opencode: boolean): AgentsDetected => {
  const probe = (found: boolean) => ({ found, version: null, path: null });
  return {
    checkedAt: '2026-11-07T10:00:00.000Z',
    agents: {
      claude: probe(claude),
      copilot: probe(false),
      opencode: probe(opencode),
    },
    shell: { label: 'zsh' },
  };
};
const onOpenCode = (over: object = {}) =>
  ({
    ...brain,
    options: { ...brain.options, agent: 'opencode' },
    ...over,
  }) as unknown as BrainView;
const NEITHER =
  "Neither Claude Code nor OpenCode was found on this machine; the brain's jobs will fail until one is installed.";

beforeEach(() => useStore.setState({ connections: [conn] }));

describe('BrainsForConnection', () => {
  it('creates a brain with the picked wiki', async () => {
    const { calls, tracked } = installFakeApi({
      'brain:wikis': () => [wiki],
      'brain:wikiPages': () => [
        { path: '/Customers', gitItemPath: '/Customers.md', isParent: true },
      ],
      'brain:create': () => brain,
    });
    render(<BrainsForConnection connection={conn} />);
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
      agent: 'claude',
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
    render(<BrainsForConnection connection={conn} />);
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
    render(<BrainsForConnection connection={conn} />);
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
    render(<BrainsForConnection connection={conn} />);
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
    render(<BrainsForConnection connection={conn} />);
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
    render(<BrainsForConnection connection={conn} />);
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
    render(<BrainsForConnection connection={conn} />);
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
    render(<BrainsForConnection connection={conn} />);
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
    render(<BrainsForConnection connection={conn} />);
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
    render(<BrainsForConnection connection={conn} />);
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
    render(<BrainsForConnection connection={conn} />);
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
    render(<BrainsForConnection connection={conn} />);
    expect(await screen.findByLabelText('Archived brains')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        channel: 'brain:update',
        args: ['b1', { archived: false }],
      }),
    );
  });

  it('pre-selects Claude Code when it is found, labelling what was found', async () => {
    installFakeApi({ 'agents:detect': () => detected(true, true) });
    render(<BrainsForConnection connection={conn} />);
    const agent = await screen.findByLabelText('Agent');
    await waitFor(() => expect(agent).toHaveValue('claude'));
    expect(
      screen.getByRole('option', { name: 'Claude Code (found)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'OpenCode (found)' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(NEITHER)).not.toBeInTheDocument();
  });

  it('pre-selects OpenCode when only it is found', async () => {
    installFakeApi({ 'agents:detect': () => detected(false, true) });
    render(<BrainsForConnection connection={conn} />);
    const agent = await screen.findByLabelText('Agent');
    await waitFor(() => expect(agent).toHaveValue('opencode'));
    expect(
      screen.getByRole('option', { name: 'Claude Code (not found)' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(NEITHER)).not.toBeInTheDocument();
  });

  it('pre-selects Claude Code and says so when neither is found', async () => {
    installFakeApi({ 'agents:detect': () => detected(false, false) });
    render(<BrainsForConnection connection={conn} />);
    expect(await screen.findByText(NEITHER)).toBeInTheDocument();
    expect(screen.getByLabelText('Agent')).toHaveValue('claude');
  });

  it('creates a brain on the agent the user picked', async () => {
    const { calls } = installFakeApi({
      'agents:detect': () => detected(true, true),
      'brain:create': () => brain,
    });
    render(<BrainsForConnection connection={conn} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('Agent'), 'opencode');
    await user.click(screen.getByRole('button', { name: 'Create brain' }));
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'brain:create')?.args[0]).toEqual(
        expect.objectContaining({ agent: 'opencode' }),
      ),
    );
  });

  it('calls onCreated with the new brain', async () => {
    installFakeApi({ 'brain:create': () => brain });
    const onCreated = vi.fn();
    render(
      <CreateBrainForm connection={conn} focus={null} onCreated={onCreated} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Create brain' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(brain));
  });

  it('changes the agent on a card', async () => {
    const { calls, tracked } = installFakeApi({
      'brain:list': () => [brain],
      'brain:update': () => brain,
    });
    render(<BrainsForConnection connection={conn} />);
    const user = userEvent.setup();
    await screen.findByText('/data/brains/b1');
    const form = screen.getByRole('form', { name: 'New brain' });
    const [cardAgent] = screen
      .getAllByLabelText('Agent')
      .filter((el) => !form.contains(el));
    expect(cardAgent).toHaveValue('claude');
    await user.selectOptions(cardAgent, 'opencode');
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'brain:update')?.args).toEqual([
        'b1',
        { options: { agent: 'opencode' } },
      ]),
    );
    expect(tracked).toContainEqual(
      expect.objectContaining({
        name: 'settings.brain',
        props: { action: 'update', field: 'agent' },
      }),
    );
  });

  it('shows Claude models for Claude Code and listed models for OpenCode', async () => {
    const { calls } = installFakeApi({
      'brain:list': () => [onOpenCode()],
      'brain:update': () => brain,
      'agents:opencodeModels': () => ['opencode/big-pickle', 'ollama/qwen3:8b'],
    });
    render(<BrainsForConnection connection={conn} />);
    const user = userEvent.setup();
    const model = await screen.findByLabelText('Model');
    expect(
      await within(model).findByRole('option', { name: 'ollama/qwen3:8b' }),
    ).toBeInTheDocument();
    expect(
      within(model)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(["OpenCode's default", 'opencode/big-pickle', 'ollama/qwen3:8b']);
    expect(
      screen.getByText('Pictures are read only by models that can see images.'),
    ).toBeInTheDocument();
    await user.selectOptions(model, 'opencode/big-pickle');
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'brain:update')?.args).toEqual([
        'b1',
        { options: { opencodeModel: 'opencode/big-pickle' } },
      ]),
    );
  });

  it('uses a text field for the OpenCode model when the list cannot be read', async () => {
    const { calls } = installFakeApi({
      'brain:list': () => [onOpenCode()],
      'brain:update': () => brain,
      'agents:opencodeModels': () => null,
    });
    render(<BrainsForConnection connection={conn} />);
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByLabelText('Model').tagName).toBe('INPUT'),
    );
    const model = screen.getByLabelText('Model');
    await user.type(model, 'openrouter/anthropic/claude-sonnet-4.5');
    await user.tab();
    await waitFor(() =>
      expect(
        calls.filter((c) => c.channel === 'brain:update').at(-1)?.args,
      ).toEqual([
        'b1',
        {
          options: { opencodeModel: 'openrouter/anthropic/claude-sonnet-4.5' },
        },
      ]),
    );
  });

  it('does not save a typed OpenCode model that is not a plain provider/model', async () => {
    const { calls } = installFakeApi({
      'brain:list': () => [onOpenCode()],
      'brain:update': () => brain,
      'agents:opencodeModels': () => null,
    });
    render(<BrainsForConnection connection={conn} />);
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByLabelText('Model').tagName).toBe('INPUT'),
    );
    const model = screen.getByLabelText('Model');
    await user.type(model, 'a/b" & calc');
    await user.tab();
    expect(
      await screen.findByText('Use provider/model, without spaces or quotes'),
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.channel === 'brain:update')).toEqual([]);
    expect(model).toHaveValue('a/b" & calc');
  });

  it('keeps the Claude model select and no picture note for Claude Code', async () => {
    installFakeApi({ 'brain:list': () => [brain] });
    render(<BrainsForConnection connection={conn} />);
    expect((await screen.findByLabelText('Model')).tagName).toBe('SELECT');
    expect(
      screen.queryByText(
        'Pictures are read only by models that can see images.',
      ),
    ).not.toBeInTheDocument();
  });

  it('offers "Write long reads" only once the skills can write them', async () => {
    const label = 'Write long reads in the background, at most two a day';
    const { calls } = installFakeApi({
      'brain:list': () => [
        brain,
        {
          ...brain,
          id: 'b2',
          path: '/data/brains/b2',
          templatesVersion: 10,
          options: { ...brain.options, writeLongReads: false },
        },
      ],
      'brain:update': () => brain,
    });
    render(<BrainsForConnection connection={conn} />);
    await screen.findByText('/data/brains/b2');
    await userEvent.click(screen.getByLabelText(label));
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'brain:update')?.args).toEqual([
        'b2',
        { options: { writeLongReads: true } },
      ]),
    );
  });

  it('offers "Send to my phone" only with a phone connected, or to switch it off', async () => {
    const label = 'Send long reads and letters to my phone';
    const sending = {
      ...brain,
      id: 'b2',
      path: '/data/brains/b2',
      options: { ...brain.options, sendToPhone: true },
    };
    installFakeApi({ 'brain:list': () => [brain, sending] });
    const first = render(<BrainsForConnection connection={conn} />);
    await screen.findByText('/data/brains/b2');
    // Not connected: only the brain that has it on shows the switch.
    expect(screen.getAllByLabelText(label)).toHaveLength(1);
    expect(screen.getByLabelText(label)).toBeChecked();
    first.unmount();

    const { calls } = installFakeApi({
      'brain:list': () => [brain],
      'brain:update': () => brain,
      'reader:status': () => ({
        connected: true,
        url: 'https://reader.example',
        lastPush: null,
        refused: false,
      }),
    });
    render(<BrainsForConnection connection={conn} />);
    await userEvent.click(await screen.findByLabelText(label));
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'brain:update')?.args).toEqual([
        'b1',
        { options: { sendToPhone: true } },
      ]),
    );
  });

  it('hints "Update skills first" for an OpenCode brain below skills version 7', async () => {
    installFakeApi({
      'brain:list': () => [onOpenCode({ templatesVersion: 6 })],
    });
    render(<BrainsForConnection connection={conn} />);
    expect(await screen.findByText('Update skills first')).toBeInTheDocument();
  });

  it('has no hint for a ready OpenCode brain or a Claude one below version 7', async () => {
    installFakeApi({
      'brain:list': () => [
        onOpenCode({ templatesVersion: 7 }),
        { ...brain, id: 'b2', templatesVersion: 3 },
      ],
    });
    render(<BrainsForConnection connection={conn} />);
    await screen.findAllByText('/data/brains/b1');
    expect(screen.queryByText('Update skills first')).not.toBeInTheDocument();
  });
});
