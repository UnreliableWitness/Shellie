import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ENVIRONMENTS,
  type Environment,
  type ImportCandidate,
  type ImportCell,
  type ImportPlan,
  type ImportRequest,
  type ImportRow,
} from '../../shared/secrets';
import type { Repo } from '../../shared/types';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';
import { SecretsImportScreen } from './SecretsImportScreen';

const cand = (
  key: string,
  source: string,
  mask = '••••',
  tracked = false,
): ImportCandidate => ({ key, source, mask, tracked });

const row = (
  name: string,
  cells: Partial<Record<Environment, Partial<ImportCell>>>,
  over: Partial<ImportRow> = {},
): ImportRow => ({
  name,
  secretLike: true,
  unassigned: [],
  cells: Object.fromEntries(
    ENVIRONMENTS.map((e) => [
      e,
      {
        candidates: [],
        state: 'missing',
        ...(cells[e]?.candidates ? { state: 'new' } : {}),
        ...cells[e],
      } as ImportCell,
    ]),
  ) as Record<Environment, ImportCell>,
  ...over,
});

const plan: ImportPlan = {
  rows: [
    row('STRIPE_SECRET_KEY', {
      development: {
        candidates: [cand('k-dev', '.env', 'sk_test_••••91c2')],
      },
      uat: { candidates: [cand('k-uat', '.env.uat', 'sk_test_••••a71e')] },
      production: {
        candidates: [
          cand('k-prod', '.env.production.local', 'sk_live_••••0b3d'),
        ],
      },
    }),
    row('ConnectionStrings__Db', {
      development: { candidates: [cand('k-db-dev', 'user secrets')] },
      uat: {
        candidates: [
          cand('k-db-uat1', 'launch profile Uat'),
          cand('k-db-uat2', 'appsettings.Uat.json', '••••', true),
        ],
      },
    }),
    row(
      'ASPNETCORE_URLS',
      { development: { candidates: [cand('k-urls', '.env', '••••5001')] } },
      { secretLike: false },
    ),
    row(
      'API_KEY',
      {},
      { unassigned: [cand('k-api', 'launch profile Staging2')] },
    ),
  ],
  sources: [
    { path: '.env', tracked: false, removable: true },
    { path: '.env.uat', tracked: false, removable: true },
    { path: '.env.production.local', tracked: false, removable: true },
    { path: 'appsettings.Uat.json', tracked: true, removable: false },
    { path: 'user secrets', tracked: false, removable: false },
    { path: 'launch profile Uat', tracked: false, removable: false },
    { path: 'launch profile Staging2', tracked: false, removable: false },
  ],
  skipped: 0,
};

beforeEach(() =>
  useStore.setState({
    repos: [{ id: 'r1', name: 'payments-api' } as Repo],
    notices: [],
    screen: { kind: 'secrets-import', repoId: 'r1' },
  }),
);

function setup(p: ImportPlan = plan) {
  const sent: ImportRequest[] = [];
  const api = installFakeApi({
    'secrets:forget': () => undefined,
    'secrets:importPlan': () => p,
    'secrets:import': (req) => {
      sent.push(req);
      return {
        values: req.picks.length,
        worktreesRewritten: 0,
        filesChanged: [],
      };
    },
  });
  const view = render(<SecretsImportScreen repoId="r1" />);
  return { sent, api, view };
}

const rowOf = (name: string) => screen.getByText(name).closest('tr')!;

describe('Import page', () => {
  it('lists every source, with a committed-in-git badge for tracked ones', async () => {
    setup();
    await screen.findByText('Found in payments-api');
    const chips = screen.getByRole('list', { name: 'Sources' });
    expect(within(chips).getByText('.env.production.local')).toBeVisible();
    const tracked = within(chips).getByText('appsettings.Uat.json');
    expect(
      within(tracked.closest('li')!).getByText('committed in git'),
    ).toBeVisible();
  });

  it('pre-ticks secret-like rows and leaves plain settings unticked', async () => {
    setup();
    await screen.findByText('STRIPE_SECRET_KEY');
    expect(
      screen.getByRole('checkbox', { name: 'Import STRIPE_SECRET_KEY' }),
    ).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: 'Import ASPNETCORE_URLS' }),
    ).not.toBeChecked();
  });

  it('shows not found gaps, conflict radios and the masked values', async () => {
    setup();
    await screen.findByText('STRIPE_SECRET_KEY');
    expect(screen.getByText('sk_live_••••0b3d')).toBeVisible();
    const db = rowOf('ConnectionStrings__Db');
    // Production is a gap; Test offers the Development value.
    expect(within(db).getAllByText('not found')).toHaveLength(1);
    expect(
      within(db).getByRole('button', { name: 'same as Development?' }),
    ).toBeVisible();
    expect(
      within(rowOf('ASPNETCORE_URLS')).getAllByText('not found'),
    ).toHaveLength(3);
    expect(within(db).getByText('2 values')).toBeVisible();
    expect(
      within(db).getByRole('radio', { name: /launch profile Uat/ }),
    ).toBeChecked();
  });

  it('sends exactly the picked keys, never a value', async () => {
    const user = userEvent.setup();
    const { sent } = setup();
    await screen.findByText('STRIPE_SECRET_KEY');
    // Pick the other UAT source, link Test to Development, drop the unassigned one on UAT.
    await user.click(
      within(rowOf('ConnectionStrings__Db')).getByRole('radio', {
        name: /appsettings\.Uat\.json/,
      }),
    );
    await user.click(
      within(rowOf('STRIPE_SECRET_KEY')).getByRole('button', {
        name: 'same as Development?',
      }),
    );
    const lane = screen.getByRole('region', { name: 'Unassigned' });
    await user.click(within(lane).getByRole('button', { name: 'UAT' }));
    expect(
      screen.getByText(
        '7 values in 4 environments · encrypted on this machine · Production values ask before every use',
      ),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Import 7 values' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    const req = sent[0]!;
    expect(req.repoId).toBe('r1');
    expect(req.rewriteWorktreeCopies).toBe(true);
    expect(req.removeFromMainCheckout).toEqual([]);
    expect(req.picks).toEqual(
      expect.arrayContaining([
        { name: 'STRIPE_SECRET_KEY', env: 'development', key: 'k-dev' },
        { name: 'STRIPE_SECRET_KEY', env: 'test', key: 'k-dev' },
        { name: 'STRIPE_SECRET_KEY', env: 'uat', key: 'k-uat' },
        { name: 'STRIPE_SECRET_KEY', env: 'production', key: 'k-prod' },
        { name: 'ConnectionStrings__Db', env: 'development', key: 'k-db-dev' },
        { name: 'ConnectionStrings__Db', env: 'uat', key: 'k-db-uat2' },
        { name: 'API_KEY', env: 'uat', key: 'k-api' },
      ]),
    );
    expect(req.picks).toHaveLength(7);
    for (const p of req.picks)
      expect(Object.keys(p).sort()).toEqual(['env', 'key', 'name']);
    await waitFor(() =>
      expect(useStore.getState().screen).toEqual({
        kind: 'secrets',
        repoId: 'r1',
      }),
    );
  });

  it('offers removal from the main checkout only for .env-style files, off by default', async () => {
    const user = userEvent.setup();
    const { sent } = setup();
    await screen.findByText('STRIPE_SECRET_KEY');
    const remove = screen.getByRole('group', {
      name: /Remove the imported keys from the main checkout/,
    });
    const boxes = within(remove).getAllByRole('checkbox');
    expect(boxes.map((b) => b.getAttribute('aria-label'))).toEqual([
      '.env',
      '.env.uat',
      '.env.production.local',
    ]);
    for (const b of boxes) expect(b).not.toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: /Rewrite the copies/ }),
    ).toBeChecked();
    await user.click(within(remove).getByRole('checkbox', { name: '.env' }));
    await user.click(
      screen.getByRole('button', { name: /^Import \d+ values$/ }),
    );
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.removeFromMainCheckout).toEqual(['.env']);
  });

  it('skips an unassigned value', async () => {
    const user = userEvent.setup();
    const { sent } = setup();
    await screen.findByText('STRIPE_SECRET_KEY');
    const lane = screen.getByRole('region', { name: 'Unassigned' });
    await user.click(within(lane).getByRole('button', { name: 'Skip' }));
    await user.click(
      screen.getByRole('button', { name: /^Import \d+ values$/ }),
    );
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.picks.some((p) => p.name === 'API_KEY')).toBe(false);
  });

  it('shows the shellie run note and the skipped count', async () => {
    setup({ ...plan, skipped: 2 });
    await screen.findByText('STRIPE_SECRET_KEY');
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'P' &&
          el.textContent ===
            'Agents run the dev server through shellie run; tests run directly in the agent tab, without secrets.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        "2 values skipped (names Shellie can't use as environment variables)",
      ),
    ).toBeVisible();
  });

  it('hides rows that are stored already on re-discovery, and shows changed ones with the old source', async () => {
    const user = userEvent.setup();
    setup({
      ...plan,
      rows: [
        row('OLD', {
          development: { candidates: [cand('k1', '.env')], state: 'same' },
        }),
        row('MOVED', {
          development: {
            candidates: [cand('k2', '.env.local')],
            state: 'changed',
            was: '.env',
          },
        }),
      ],
    });
    await screen.findByText('MOVED');
    expect(screen.queryByText('OLD')).toBeNull();
    expect(
      within(rowOf('MOVED')).getByText('changed · was .env'),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show 1 unchanged' }));
    expect(screen.getByText('OLD')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Import 1 value' }),
    ).toBeVisible();
  });

  it('keeps a stored Test value instead of offering Development for it', async () => {
    setup({
      ...plan,
      rows: [
        row('DB', {
          development: { candidates: [cand('k-dev', '.env')] },
          test: { stored: true },
        }),
      ],
    });
    const db = (await screen.findByText('DB')).closest('tr')!;
    expect(within(db).getByText('kept')).toBeVisible();
    expect(
      within(db).queryByRole('button', { name: /same as Development/ }),
    ).toBeNull();
  });

  it('shows both sources of a changed cell and picks the new value by default', async () => {
    const user = userEvent.setup();
    const { sent } = setup({
      ...plan,
      rows: [
        row('DB', {
          development: {
            state: 'changed',
            was: '.env',
            candidates: [
              { ...cand('k-old', '.env'), matchesStored: true },
              cand('k-new', '.env.local'),
            ],
          },
        }),
      ],
    });
    const db = (await screen.findByText('DB')).closest('tr')!;
    expect(
      within(db).getByRole('radio', { name: /\.env\.local/ }),
    ).toBeChecked();
    expect(
      within(db).getByRole('radio', { name: /stored already/ }),
    ).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Import 1 value' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.picks).toEqual([
      { name: 'DB', env: 'development', key: 'k-new' },
    ]);
  });

  it('asks main to forget the found values when the page closes', async () => {
    const { api, view } = setup();
    await screen.findByText('STRIPE_SECRET_KEY');
    view.unmount();
    expect(api.calls.at(-1)).toEqual({
      channel: 'secrets:forget',
      args: ['r1'],
    });
  });

  it('ticks nothing for a plain-only .env and says there is nothing to import', async () => {
    setup({
      rows: [
        row(
          'PORT',
          { development: { candidates: [cand('k-port', '.env')] } },
          { secretLike: false },
        ),
        row(
          'LOG_LEVEL',
          { development: { candidates: [cand('k-log', '.env')] } },
          { secretLike: false },
        ),
      ],
      sources: [{ path: '.env', tracked: false, removable: true }],
      skipped: 0,
    });
    await screen.findByText('PORT');
    for (const b of screen.getAllByRole('checkbox', { name: /^Import / }))
      expect(b).not.toBeChecked();
    expect(screen.getByText('Nothing to import')).toBeVisible();
    expect(screen.getByRole('button', { name: /^Import/ })).toBeDisabled();
  });

  it('puts no plaintext value in the page', async () => {
    const { api } = setup();
    await screen.findByText('STRIPE_SECRET_KEY');
    expect(api.calls.map((c) => c.channel)).toEqual(['secrets:importPlan']);
    expect(document.body.innerHTML).not.toMatch(/sk_(test|live)_[^•]/);
  });

  it('names two picked names that differ only in case on the page, never in a notice, and holds the import', async () => {
    const { sent } = setup({
      ...plan,
      rows: [
        row('ApiKey', {
          development: { candidates: [cand('k1', '.env', '••••1')] },
        }),
        row('APIKEY', {
          development: { candidates: [cand('k2', '.env.local', '••••2')] },
        }),
      ],
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('ApiKey and APIKEY differ only in case');
    const go = screen.getByRole('button', { name: /^Import/ });
    expect(go).toBeDisabled();
    await userEvent.click(within(rowOf('APIKEY')).getByRole('checkbox'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: /^Import/ }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(
      useStore.getState().notices.some((n) => /ApiKey/.test(n.message)),
    ).toBe(false);
  });

  it('goes back to the Secrets page on Cancel', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText('STRIPE_SECRET_KEY');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useStore.getState().screen).toEqual({
      kind: 'secrets',
      repoId: 'r1',
    });
  });
});
