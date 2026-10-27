import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SecretView, SecretsStatus } from '../../shared/secrets';
import type { Repo } from '../../shared/types';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';
import { SecretsScreen } from './SecretsScreen';

const repo = (id: string, name: string) => ({ id, name }) as Repo;
const stripe: SecretView = {
  id: 's1',
  scope: { repoId: 'r1' },
  name: 'STRIPE_SECRET_KEY',
  givenTo: ['setup', 'run'],
  values: {
    development: {
      mask: 'sk_test_••••3f9a',
      source: '.env.local',
      changedAt: new Date().toISOString(),
    },
  },
};
const openai: SecretView = {
  id: 's2',
  scope: 'all',
  name: 'OPENAI_API_KEY',
  givenTo: ['run'],
  values: {
    production: {
      mask: 'sk-••••',
      source: null,
      changedAt: '2026-10-01T00:00:00Z',
    },
  },
};

beforeEach(() =>
  useStore.setState({
    repos: [repo('r1', 'webshop'), repo('r2', 'payments-api')],
    notices: [],
    screen: { kind: 'secrets', repoId: 'r1' },
  }),
);

const list = (scope: string) =>
  scope === 'all' ? [openai] : scope === 'r1' ? [stripe, openai] : [openai];

describe('Secrets page', () => {
  it('shows masks and sources, gaps with add, and all-repos secrets tagged', async () => {
    installFakeApi({ 'secrets:list': list });
    render(<SecretsScreen repoId="r1" />);
    expect(await screen.findByText('STRIPE_SECRET_KEY')).toBeInTheDocument();
    expect(screen.getByText('sk_test_••••3f9a')).toBeInTheDocument();
    expect(screen.getByText('.env.local')).toBeInTheDocument();
    expect(screen.getByText('all repos')).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: /^Add .* value/ }).length,
    ).toBeGreaterThan(0);
  });

  it('strikes the Agents chip on every row', async () => {
    installFakeApi({ 'secrets:list': list });
    render(<SecretsScreen repoId="r1" />);
    await screen.findByText('STRIPE_SECRET_KEY');
    const chips = screen.getAllByText('Agents');
    expect(chips).toHaveLength(2);
    for (const c of chips) expect(c).toHaveClass('struck');
  });

  it('shows the plaintext only while the eye is held', async () => {
    installFakeApi({
      'secrets:list': list,
      'secrets:reveal': () => 'sk_test_PLAINTEXT',
    });
    render(<SecretsScreen repoId="r1" />);
    await screen.findByText('STRIPE_SECRET_KEY');
    expect(document.body.textContent).not.toContain('PLAINTEXT');
    const eye = screen.getByRole('button', {
      name: 'Hold to reveal STRIPE_SECRET_KEY Development',
    });
    fireEvent.pointerDown(eye);
    expect(await screen.findByText('sk_test_PLAINTEXT')).toBeInTheDocument();
    fireEvent.pointerUp(eye);
    expect(screen.queryByText('sk_test_PLAINTEXT')).toBeNull();
    expect(document.body.textContent).not.toContain('PLAINTEXT');
  });

  it('clears on leave, and a release before the answer shows nothing', async () => {
    let resolve: (v: string) => void = () => {};
    installFakeApi({
      'secrets:list': list,
      'secrets:reveal': () => new Promise<string>((r) => (resolve = r)),
    });
    render(<SecretsScreen repoId="r1" />);
    await screen.findByText('STRIPE_SECRET_KEY');
    const eye = screen.getByRole('button', {
      name: 'Hold to reveal STRIPE_SECRET_KEY Development',
    });
    fireEvent.pointerDown(eye);
    fireEvent.pointerLeave(eye);
    await act(async () => resolve('sk_test_PLAINTEXT'));
    expect(document.body.textContent).not.toContain('PLAINTEXT');
  });

  it('reveals with a held key', async () => {
    installFakeApi({
      'secrets:list': list,
      'secrets:reveal': () => 'sk_test_PLAINTEXT',
    });
    render(<SecretsScreen repoId="r1" />);
    await screen.findByText('STRIPE_SECRET_KEY');
    const eye = screen.getByRole('button', {
      name: 'Hold to reveal STRIPE_SECRET_KEY Development',
    });
    fireEvent.keyDown(eye, { key: ' ' });
    expect(await screen.findByText('sk_test_PLAINTEXT')).toBeInTheDocument();
    fireEvent.keyUp(eye, { key: ' ' });
    expect(screen.queryByText('sk_test_PLAINTEXT')).toBeNull();
  });

  it('adds a secret with the typed values', async () => {
    const { calls } = installFakeApi({
      'secrets:list': list,
      'secrets:save': (i) => ({ ...stripe, name: i.name }),
    });
    const user = userEvent.setup();
    render(<SecretsScreen repoId="r1" />);
    await screen.findByText('STRIPE_SECRET_KEY');
    await user.click(screen.getByRole('button', { name: '+ Add secret' }));
    await user.type(screen.getByLabelText('Name'), 'API_KEY');
    await user.type(screen.getByLabelText('Development value'), 'dev-1');
    await user.type(screen.getByLabelText('Production value'), 'prod-1');
    await user.click(screen.getByRole('checkbox', { name: 'Tests' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'secrets:save')?.args[0]).toEqual({
        scope: { repoId: 'r1' },
        name: 'API_KEY',
        givenTo: ['setup', 'run', 'tests'],
        values: {
          development: { value: 'dev-1' },
          production: { value: 'prod-1' },
        },
      }),
    );
  });

  it('shows the error of a refused save and keeps the form', async () => {
    installFakeApi({
      'secrets:list': list,
      'secrets:save': () => {
        throw new Error('The secret is not valid');
      },
    });
    const user = userEvent.setup();
    render(<SecretsScreen repoId="r1" />);
    await screen.findByText('STRIPE_SECRET_KEY');
    await user.click(screen.getByRole('button', { name: '+ Add secret' }));
    await user.type(screen.getByLabelText('Name'), '1 bad');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The secret is not valid',
    );
    expect(screen.getByLabelText('Name')).toHaveValue('1 bad');
  });

  it('asks before deleting', async () => {
    const { calls } = installFakeApi({ 'secrets:list': list });
    const user = userEvent.setup();
    render(<SecretsScreen repoId="r1" />);
    await screen.findByText('STRIPE_SECRET_KEY');
    await user.click(
      screen.getByRole('button', { name: 'Actions for STRIPE_SECRET_KEY' }),
    );
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(calls.some((c) => c.channel === 'secrets:delete')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Delete secret' }));
    await waitFor(() =>
      expect(calls.find((c) => c.channel === 'secrets:delete')?.args).toEqual([
        's1',
      ]),
    );
  });

  it('moves a secret to All repositories', async () => {
    const { calls } = installFakeApi({
      'secrets:list': list,
      'secrets:save': () => stripe,
    });
    const user = userEvent.setup();
    render(<SecretsScreen repoId="r1" />);
    await screen.findByText('STRIPE_SECRET_KEY');
    await user.click(
      screen.getByRole('button', { name: 'Actions for STRIPE_SECRET_KEY' }),
    );
    await user.click(
      screen.getByRole('menuitem', { name: 'Move to All repositories' }),
    );
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'secrets:save')?.args[0],
      ).toMatchObject({
        id: 's1',
        scope: 'all',
        values: {},
      }),
    );
  });

  it('renders the status panel: green, amber with reasons, nothing', async () => {
    const status = (s: SecretsStatus) => ({
      'secrets:list': list,
      'secrets:status': () => s,
    });
    const green = installFakeApi(
      status({
        state: 'protected',
        reasons: [],
        given: ['setup', 'run'],
        secrets: 2,
      }),
    );
    const { unmount } = render(<SecretsScreen repoId="r1" />);
    expect(await screen.findByText(/webshop is protected/)).toBeInTheDocument();
    expect(
      screen.getByText(/2 secrets reach the Setup and Dev server tabs only/),
    ).toBeInTheDocument();
    expect(green.calls.some((c) => c.channel === 'secrets:status')).toBe(true);
    unmount();
    installFakeApi(
      status({
        state: 'attention',
        reasons: [
          { kind: 'copy', files: ['.env'], count: 4 },
          { kind: 'tracked', files: ['appsettings.json'] },
          { kind: 'worktrees', taskIds: ['t1'] },
        ],
        given: [],
        secrets: 1,
      }),
    );
    const second = render(<SecretsScreen repoId="r1" />);
    expect(await screen.findByText(/still copies/)).toBeInTheDocument();
    expect(screen.getByText(/appsettings\.json/)).toBeInTheDocument();
    expect(screen.getByText(/committed in 1 file/)).toBeInTheDocument();
    expect(screen.getByText(/1 open task still has/)).toBeInTheDocument();
    second.unmount();
    installFakeApi({ 'secrets:list': list });
    render(<SecretsScreen repoId="r1" />);
    await screen.findByText('STRIPE_SECRET_KEY');
    expect(screen.queryByText(/is protected/)).toBeNull();
    expect(screen.queryByText(/still copies/)).toBeNull();
  });

  it('cleans the old worktrees from the card and reloads', async () => {
    let dirty = true;
    const api = installFakeApi({
      'secrets:list': list,
      'secrets:status': () =>
        dirty
          ? {
              state: 'attention',
              reasons: [{ kind: 'worktrees', taskIds: ['t1', 't2'] }],
              given: [],
              secrets: 1,
            }
          : { state: 'protected', reasons: [], given: ['run'], secrets: 1 },
      'secrets:cleanWorktrees': () => {
        dirty = false;
        return ['t1', 't2'];
      },
    });
    const user = userEvent.setup();
    render(<SecretsScreen repoId="r1" />);
    await user.click(
      await screen.findByRole('button', { name: 'Clean 2 worktrees' }),
    );
    expect(
      api.calls.find((c) => c.channel === 'secrets:cleanWorktrees')?.args,
    ).toEqual(['r1']);
    expect(await screen.findByText(/webshop is protected/)).toBeInTheDocument();
  });

  it('offers to move values for a copy: file and never edits tracked files', async () => {
    installFakeApi({
      'secrets:list': list,
      'secrets:status': () => ({
        state: 'attention',
        reasons: [{ kind: 'copy', files: ['.env'], count: 4 }],
        given: [],
        secrets: 1,
      }),
    });
    const user = userEvent.setup();
    render(<SecretsScreen repoId="r1" />);
    await user.click(
      await screen.findByRole('button', {
        name: 'Move 4 values into Shellie…',
      }),
    );
    expect(useStore.getState().screen).toEqual({
      kind: 'secrets-import',
      repoId: 'r1',
    });
  });

  it('shows an amber card when git could not check the repo', async () => {
    installFakeApi({
      'secrets:list': list,
      'secrets:status': () => ({
        state: 'attention',
        reasons: [{ kind: 'unchecked' }],
        given: [],
        secrets: 1,
      }),
    });
    render(<SecretsScreen repoId="r1" />);
    expect(
      await screen.findByText("Shellie couldn't check webshop with git"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/is protected/)).toBeNull();
  });

  it('reloads on secrets:changed', async () => {
    let rows = [stripe, openai];
    const api = installFakeApi({ 'secrets:list': () => rows });
    render(<SecretsScreen repoId="r1" />);
    await screen.findByText('STRIPE_SECRET_KEY');
    rows = [openai];
    act(() => api.emit('secrets:changed', null));
    await waitFor(() =>
      expect(screen.queryByText('STRIPE_SECRET_KEY')).toBeNull(),
    );
  });

  it('opens the import screen for the repo', async () => {
    installFakeApi({ 'secrets:list': list });
    const user = userEvent.setup();
    render(<SecretsScreen repoId="r1" />);
    await screen.findByText('STRIPE_SECRET_KEY');
    await user.click(screen.getByRole('button', { name: /Import from \.env/ }));
    expect(useStore.getState().screen).toEqual({
      kind: 'secrets-import',
      repoId: 'r1',
    });
  });

  it('clears a revealed value on blur and on pointercancel', async () => {
    installFakeApi({
      'secrets:list': list,
      'secrets:reveal': () => 'sk_test_PLAINTEXT',
    });
    render(<SecretsScreen repoId="r1" />);
    await screen.findByText('STRIPE_SECRET_KEY');
    const eye = screen.getByRole('button', {
      name: 'Hold to reveal STRIPE_SECRET_KEY Development',
    });
    for (const end of [fireEvent.blur, fireEvent.pointerCancel]) {
      fireEvent.pointerDown(eye);
      expect(await screen.findByText('sk_test_PLAINTEXT')).toBeInTheDocument();
      end(eye);
      expect(document.body.textContent).not.toContain('PLAINTEXT');
    }
  });

  it('shows the rows and status of the scope last clicked, not a slow earlier one', async () => {
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((r) => (releaseA = r));
    let aSlow = false;
    let statusSlow = false;
    const aRow = { ...stripe, id: 'a', name: 'A_ONLY' };
    const bRow = {
      ...stripe,
      id: 'b',
      name: 'B_ONLY',
      scope: { repoId: 'r2' },
    };
    installFakeApi({
      'secrets:list': async (scope) => {
        if (scope === 'r1') {
          // Only the first request (the page's own scope list) is slow.
          if (!aSlow) {
            aSlow = true;
            await gateA;
          }
          return [aRow];
        }
        return scope === 'r2' ? [bRow] : [];
      },
      'secrets:status': async (id) => {
        if (id === 'r1' && !statusSlow) {
          statusSlow = true;
          await gateA;
        }
        return { state: 'protected', reasons: [], given: [], secrets: 1 };
      },
    });
    const user = userEvent.setup();
    render(<SecretsScreen repoId="r1" />);
    await user.click(screen.getByRole('button', { name: /payments-api/ }));
    expect(await screen.findByText('B_ONLY')).toBeInTheDocument();
    expect(
      await screen.findByText(/payments-api is protected/),
    ).toBeInTheDocument();
    await act(async () => releaseA());
    expect(screen.queryByText('A_ONLY')).toBeNull();
    expect(screen.queryByText(/webshop is protected/)).toBeNull();
    expect(screen.getByText('B_ONLY')).toBeInTheDocument();
  });

  it('removes one environment value with null', async () => {
    const { calls } = installFakeApi({
      'secrets:list': list,
      'secrets:save': () => stripe,
    });
    const user = userEvent.setup();
    render(<SecretsScreen repoId="r1" />);
    await screen.findByText('STRIPE_SECRET_KEY');
    await user.click(
      screen.getByRole('button', { name: 'Actions for STRIPE_SECRET_KEY' }),
    );
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(
      screen.queryByRole('button', { name: 'Remove Test value' }),
    ).toBeNull();
    await user.click(
      screen.getByRole('button', { name: 'Remove Development value' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.channel === 'secrets:save')?.args[0],
      ).toMatchObject({
        id: 's1',
        values: { development: null },
      }),
    );
  });
});

describe('Secrets pages scrolling (#167)', () => {
  it.each(['secrets', 'import'])(
    'scrolls .%s inside the content area, so the nav and header stay put',
    (name) => {
      const css = readFileSync(
        path.join(__dirname, '..', 'styles', 'secrets.css'),
        'utf8',
      );
      const rule = new RegExp(`\\.${name} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
      expect(rule).toContain('overflow: auto;');
      expect(rule).toContain('min-height: 0;');
    },
  );
});
