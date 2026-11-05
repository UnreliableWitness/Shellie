import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BrainView } from '../../../../shared/brain';
import type { Connection, Repo } from '../../../../shared/types';
import { useStore } from '../../../store';
import { installFakeApi } from '../../../test-helpers/fakeApi';
import { ProjectScope } from '../ProjectScope';

const conn: Connection = {
  id: 'c1',
  name: 'unreliablewitness',
  organizationUrl: 'https://dev.azure.com/unreliablewitness',
  project: 'Shellie',
  user: 'Dries Hoebeke',
  status: 'ok',
  checkedAt: '2026-10-14T10:00:00.000Z',
  userUniqueName: 'dries@example.com',
  provider: 'azure-devops' as const,
  workItemOnStart: {
    moveToInProgress: true,
    assignToMe: true,
    stateOverrides: {},
  },
  writeTimeToAdo: false,
};
const sibling: Connection = {
  ...conn,
  id: 'c2',
  name: 'unreliablewitness/Webshop',
  project: 'Webshop',
};
const other: Connection = {
  ...conn,
  id: 'c3',
  name: 'client',
  organizationUrl: 'https://dev.azure.com/client',
  project: 'Portal',
};

const repo = (id: string, connectionId: string | null): Repo => ({
  id,
  name: id,
  path: `/src/${id}`,
  baseBranch: 'main',
  connectionId,
  configFound: true,
  discovered: false,
  overrides: {},
  workItemOnStart: {
    moveToInProgress: true,
    assignToMe: true,
    stateOverrides: {},
  },
});

const brain = (
  id: string,
  name: string,
  connectionId: string,
  archived = false,
): BrainView =>
  ({
    id,
    name,
    connectionId,
    project: 'Shellie',
    path: `/data/brains/${id}`,
    wiki: null,
    archived,
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
  }) as unknown as BrainView;

const row = (id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`No row ${id}`);
  return el;
};

beforeEach(() => {
  useStore.setState({
    repos: [],
    tasks: [],
    connections: [conn, sibling, other],
    notices: [],
    screen: { kind: 'settings', scope: 'project', connectionId: 'c1' },
  });
});

describe('ProjectScope categories', () => {
  it('saves the default on the connection', async () => {
    const { calls } = installFakeApi({
      'workItems:types': () => [
        {
          name: 'Task',
          color: null,
          icon: null,
          states: [
            { name: 'To Do', color: null, category: 'Proposed' },
            { name: 'Doing', color: null, category: 'InProgress' },
          ],
        },
      ],
    });
    render(<ProjectScope connection={conn} active />);
    const move = row('project-workitems-move');
    expect(move).not.toHaveAttribute('data-modified');
    await userEvent.click(
      within(move).getByRole('checkbox', {
        name: 'Move the work item to In Progress on start',
      }),
    );
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'connections:update')?.args,
      ).toEqual([
        'c1',
        {
          workItemOnStart: {
            moveToInProgress: false,
            assignToMe: true,
            stateOverrides: {},
          },
        },
      ]),
    );
    await waitFor(() =>
      expect(
        useStore.getState().connections.find((c) => c.id === 'c1')
          ?.workItemOnStart.moveToInProgress,
      ).toBe(false),
    );
    await userEvent.selectOptions(
      await screen.findByLabelText('In Progress state for Task'),
      'Doing',
    );
    await waitFor(() =>
      expect(
        calls.filter((c) => c.channel === 'workItems:types')[0]?.args,
      ).toEqual(['c1']),
    );
  });

  it('time write-back saves with connections:update', async () => {
    const { calls } = installFakeApi();
    render(<ProjectScope connection={conn} active />);
    const time = row('project-time-ado');
    expect(time).not.toHaveAttribute('data-modified');
    await userEvent.click(
      within(time).getByRole('checkbox', {
        name: 'Write booked time to Azure DevOps',
      }),
    );
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'connections:update')?.args,
      ).toEqual(['c1', { writeTimeToAdo: true }]),
    );
    await waitFor(() =>
      expect(
        useStore.getState().connections.find((c) => c.id === 'c1')
          ?.writeTimeToAdo,
      ).toBe(true),
    );
  });

  it('time write-back Reset saves false', async () => {
    const { calls } = installFakeApi();
    const on = { ...conn, writeTimeToAdo: true };
    useStore.setState({ connections: [on, sibling, other] });
    render(<ProjectScope connection={on} active />);
    const time = row('project-time-ado');
    expect(time).toHaveAttribute('data-modified', 'true');
    await userEvent.click(
      within(time).getByRole('button', {
        name: 'More actions for Write booked time to Azure DevOps',
      }),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Reset' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'connections:update')?.args,
      ).toEqual(['c1', { writeTimeToAdo: false }]),
    );
  });

  it('remove confirms with repo and brain counts and calls connections:remove', async () => {
    const { calls } = installFakeApi({
      'brain:list': () => [
        brain('b1', 'Shellie brain', 'c1'),
        brain('b2', 'Old brain', 'c1', true),
        brain('b3', 'Webshop brain', 'c2'),
      ],
      'connections:remove': () => undefined,
      'connections:list': () => [sibling, other],
      'repos:list': () => [repo('r3', null)],
    });
    useStore.setState({
      repos: [repo('r1', 'c1'), repo('r2', 'c1'), repo('r3', 'c2')],
    });
    render(<ProjectScope connection={conn} active />);
    await screen.findByText('Shellie brain');
    await userEvent.click(
      within(row('project-danger-remove')).getByRole('button', {
        name: 'Remove project',
      }),
    );
    expect(
      screen.getByText('2 repositories will be unlinked and 1 brain archived.'),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.channel === 'connections:remove')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({
        kind: 'settings',
        scope: 'user',
        section: 'ado',
      }),
    );
    expect(calls.find((c) => c.channel === 'connections:remove')?.args).toEqual(
      ['c1'],
    );
    expect(useStore.getState().connections).toEqual([sibling, other]);
    expect(useStore.getState().repos).toEqual([repo('r3', null)]);
  });

  it('token row names the organization’s project count and updates them all', async () => {
    const { calls } = installFakeApi({
      'connections:save': (input) => ({ ...conn, id: input.id ?? 'x' }),
      'connections:list': () => [conn, sibling, other],
    });
    render(<ProjectScope connection={conn} active />);
    const token = row('project-conn-token');
    expect(token).toHaveTextContent(
      'One token for all 2 projects of unreliablewitness',
    );
    await userEvent.click(
      within(token).getByRole('button', { name: 'Update token' }),
    );
    await userEvent.type(
      within(token).getByLabelText('New personal access token'),
      'secret',
    );
    await userEvent.click(
      within(token).getByRole('button', { name: 'Save token' }),
    );
    await waitFor(() =>
      expect(
        calls
          .filter((c) => c.channel === 'connections:save')
          .map((c) => (c.args[0] as { id: string }).id),
      ).toEqual(['c1', 'c2']),
    );
    await waitFor(() =>
      expect(within(token).queryByLabelText('New personal access token')).toBe(
        null,
      ),
    );
  });

  it('status row shows the status and verifies', async () => {
    const { calls } = installFakeApi({
      'connections:verify': () => conn,
      'connections:list': () => [conn, sibling, other],
    });
    render(<ProjectScope connection={conn} active />);
    const status = row('project-conn-status');
    expect(status).toHaveTextContent('Connected as Dries Hoebeke');
    await userEvent.click(
      within(status).getByRole('button', { name: 'Verify' }),
    );
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'connections:verify')?.args,
      ).toEqual(['c1']),
    );
  });

  it('identity row shows who I am there', () => {
    installFakeApi();
    render(<ProjectScope connection={conn} active />);
    const identity = row('project-conn-identity');
    expect(identity).toHaveTextContent('Dries Hoebeke');
    expect(identity).toHaveTextContent('dries@example.com');
  });

  it('brains category lists only this connection’s brains', async () => {
    installFakeApi({
      'brain:list': () => [
        brain('b1', 'Shellie brain', 'c1'),
        brain('b2', 'Old brain', 'c1', true),
        brain('b3', 'Webshop brain', 'c2'),
      ],
    });
    render(<ProjectScope connection={conn} active />);
    const brains = row('project-brains-list');
    expect(
      await within(brains).findByText('Shellie brain'),
    ).toBeInTheDocument();
    expect(
      within(within(brains).getByLabelText('Archived brains')).getByText(
        'Old brain',
      ),
    ).toBeInTheDocument();
    expect(within(brains).queryByText('Webshop brain')).toBeNull();
    expect(
      within(brains).getByRole('button', { name: 'Create brain' }),
    ).toBeInTheDocument();
  });
});
