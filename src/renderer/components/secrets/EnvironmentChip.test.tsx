import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EnvironmentInfo } from '../../../shared/secrets';
import type { TaskView } from '../../../shared/types';
import { useStore } from '../../store';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { EnvironmentBand } from './EnvironmentBand';
import { EnvironmentChip } from './EnvironmentChip';

const NOW = Date.parse('2026-10-23T10:00:00Z');

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1',
  repoId: 'r1',
  name: '',
  workItem: {
    id: '51077',
    type: 'Bug',
    title: 'Refund fails for split payments',
    url: null,
    project: null,
  },
  slug: '51077-refund',
  branch: 'bugfix/51077-refund',
  worktreePath: '/w/51077-refund',
  baseRef: 'origin/main',
  baseSha: null,
  openPeriods: [],
  time: null,
  status: 'ready',
  setup: {
    copy: true,
    commands: [],
    startClaude: true,
    openShell: true,
    openCopilot: false,
    summary: null,
  },
  terminals: [
    { id: 'c1', kind: 'claude', label: 'Claude Code' },
    { id: 's1', kind: 'shell', label: 'PowerShell' },
    { id: 'd1', kind: 'run', label: 'dev', command: 'dotnet run' },
  ],
  createdAt: '2026-10-23T09:00:00Z',
  finishedAt: null,
  usageSyncedAt: null,
  usageSyncError: null,
  usageCommentId: null,
  summary: null,
  pullRequest: null,
  closedTerminals: [],
  reopen: null,
  extraWorkspaces: [],
  detachedPaths: [],
  homeDropped: false,
  connectionId: null,
  mainCheckoutEdits: [],
  environment: 'development',
  environmentUntil: null,
  pendingCleanup: [],
  worktreeMissing: false,
  ...over,
});

const info: EnvironmentInfo = {
  values: {
    development: { have: 5, of: 5 },
    test: { have: 3, of: 5 },
    uat: { have: 5, of: 5 },
    production: { have: 5, of: 5 },
  },
  tabs: [
    { id: 'd1', label: 'dev', kind: 'run' },
    { id: 's1', label: 'PowerShell', kind: 'shell' },
  ],
  keys: {
    development: ['DB'],
    test: ['DB'],
    uat: ['DB'],
    production: ['STRIPE_SECRET_KEY', 'ConnectionStrings__Db'],
  },
  overrides: {
    development: [],
    test: [],
    uat: [],
    production: [{ profile: 'Prd', names: ['ConnectionStrings__Db'] }],
  },
  productionMinutes: 60,
};

beforeEach(() => useStore.setState({ notices: [] }));

async function openMenu(t: TaskView = task()) {
  const api = installFakeApi({
    'tasks:environmentInfo': () => info,
    'tasks:setEnvironment': (_id, env) => task({ environment: env }),
  });
  render(<EnvironmentChip task={t} />);
  await userEvent.click(
    screen.getByRole('button', {
      name: `Secrets environment: ${t.environment === 'production' ? 'Production' : t.environment === 'uat' ? 'UAT' : t.environment === 'test' ? 'Test' : 'Development'}`,
    }),
  );
  const menu = await screen.findByRole('menu', {
    name: 'Secrets for this task',
  });
  return { ...api, menu };
}

describe('EnvironmentChip', () => {
  it('lists the four environments with the gaps and what a switch restarts', async () => {
    const { menu } = await openMenu();
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual([
      'Development',
      'Test · 3 of 5 values',
      'UAT',
      'Production',
    ]);
    expect(items[0]).toHaveAttribute('aria-checked', 'true');
    expect(menu).toHaveTextContent(
      'Restarts dev and your shell; agent tabs keep running',
    );
  });

  it('shows until when Production ends', async () => {
    const until = new Date(NOW + 47 * 60_000);
    const { menu } = await openMenu(
      task({
        environment: 'production',
        environmentUntil: until.toISOString(),
      }),
    );
    const hm = until.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    expect(
      within(menu).getByRole('menuitemradio', { checked: true }),
    ).toHaveTextContent(`Production · until ${hm}`);
  });

  it('switches to Test straight away, without a confirm', async () => {
    const { calls } = await openMenu();
    await userEvent.click(screen.getByRole('menuitemradio', { name: /^Test/ }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        channel: 'tasks:setEnvironment',
        args: ['t1', 'test'],
      }),
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('asks before Production: the tabs, the key names and a profile that wins, then confirms', async () => {
    const { calls } = await openMenu();
    await userEvent.click(
      screen.getByRole('menuitemradio', { name: 'Production' }),
    );
    const card = screen.getByRole('alertdialog', {
      name: 'Switch 51077 to Production?',
    });
    expect(card).toHaveTextContent(
      'These go into dev and your shell for 60 minutes, then Shellie stops those tabs and switches back to Development.',
    );
    expect(card).toHaveTextContent('STRIPE_SECRET_KEY · ConnectionStrings__Db');
    expect(card).toHaveTextContent(
      "launchSettings profile Prd sets ConnectionStrings__Db; the profile's value wins",
    );
    expect(calls.some((c) => c.channel === 'tasks:setEnvironment')).toBe(false);
    await userEvent.click(
      within(card).getByRole('button', { name: 'Use Production for 60 min' }),
    );
    await waitFor(() =>
      expect(calls).toContainEqual({
        channel: 'tasks:setEnvironment',
        args: ['t1', 'production', true],
      }),
    );
  });

  it('keeps the confirm disabled until the key names have loaded', async () => {
    let loaded!: (i: EnvironmentInfo) => void;
    installFakeApi({
      'tasks:environmentInfo': () =>
        new Promise<EnvironmentInfo>((r) => (loaded = r)),
    });
    render(<EnvironmentChip task={task()} />);
    await userEvent.click(
      screen.getByRole('button', { name: 'Secrets environment: Development' }),
    );
    await userEvent.click(
      screen.getByRole('menuitemradio', { name: 'Production' }),
    );
    const go = screen.getByRole('button', { name: /^Use Production/ });
    expect(go).toBeDisabled();
    loaded(info);
    await waitFor(() => expect(go).toBeEnabled());
    expect(go).toHaveTextContent('Use Production for 60 min');
  });

  it('sends nothing when the confirm is cancelled', async () => {
    const { calls } = await openMenu();
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'UAT' }));
    const card = screen.getByRole('alertdialog', {
      name: 'Switch 51077 to UAT?',
    });
    await userEvent.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(calls.some((c) => c.channel === 'tasks:setEnvironment')).toBe(false);
  });
});

describe('EnvironmentBand', () => {
  it('shows nothing on Development or Test', () => {
    installFakeApi();
    const { container, rerender } = render(<EnvironmentBand task={task()} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<EnvironmentBand task={task({ environment: 'test' })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is amber on UAT', async () => {
    installFakeApi({ 'tasks:environmentInfo': () => info });
    render(<EnvironmentBand task={task({ environment: 'uat' })} />);
    const band = screen.getByRole('status');
    expect(band).toHaveClass('env-band', 'env-band-uat');
    await waitFor(() =>
      expect(band).toHaveTextContent('UAT secrets in dev and your shell'),
    );
    expect(band).toHaveTextContent('Agents never get them');
  });

  it('lists only the running tabs that hold secrets, as main says, and follows exits', async () => {
    let tabs: EnvironmentInfo['tabs'] = [
      { id: 'd1', label: 'dev', kind: 'run' },
      { id: 'a1', label: 'agent · test', kind: 'run' },
    ];
    const { emit } = installFakeApi({
      'tasks:environmentInfo': () => ({ ...info, tabs }),
    });
    render(
      <EnvironmentBand
        task={task({
          environment: 'uat',
          terminals: [
            ...task().terminals,
            { id: 'a1', kind: 'run', label: 'agent · test', command: 'x' },
          ],
        })}
      />,
    );
    const band = screen.getByRole('status');
    await waitFor(() =>
      expect(band).toHaveTextContent('UAT secrets in dev and agent · test'),
    );
    expect(band).not.toHaveTextContent('your shell');
    tabs = [{ id: 'd1', label: 'dev', kind: 'run' }];
    emit('terminal:exit', { id: 'a1', exitCode: 0 });
    await waitFor(() => expect(band).toHaveTextContent('UAT secrets in dev'));
    expect(band).not.toHaveTextContent('agent · test');
  });

  it('is red on Production, with the minutes left, and goes back to Development', async () => {
    const { calls } = installFakeApi({
      'tasks:setEnvironment': (_id, env) => task({ environment: env }),
      'tasks:environmentInfo': () => info,
    });
    render(
      <EnvironmentBand
        task={task({
          environment: 'production',
          environmentUntil: new Date(NOW + 47 * 60_000).toISOString(),
        })}
        now={() => NOW}
      />,
    );
    const band = screen.getByRole('status');
    expect(band).toHaveClass('env-band', 'env-band-production');
    await waitFor(() =>
      expect(band).toHaveTextContent(
        'Production secrets in dev and your shell · 47 min left',
      ),
    );
    await userEvent.click(
      within(band).getByRole('button', { name: 'Back to Development' }),
    );
    await waitFor(() =>
      expect(calls).toContainEqual({
        channel: 'tasks:setEnvironment',
        args: ['t1', 'development'],
      }),
    );
  });
});
