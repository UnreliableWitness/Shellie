import { type ReactNode, useEffect, useState } from 'react';
import type { ThemeChoice } from '../../../shared/theme';
import type { AppSettings } from '../../../shared/usage';
import { api, saveSettings, tryInvoke } from '../../api';
import { AgentsSection } from '../../components/AgentsSection';
import { BudgetSection } from '../../components/BudgetSection';
import { ConnectionsSection } from '../../components/ConnectionsSection';
import { CostSection } from '../../components/CostSection';
import { CostServerSection } from '../../components/CostServerSection';
import { EditorSection } from '../../components/EditorSection';
import { useSettingsSearch } from '../../components/settings/settingsSearch';
import { TimeSection } from '../../components/TimeSection';
import { MindMark } from '../../components/ui';
import { useStore } from '../../store';

export type SettingsCategoryInfo = {
  id: string;
  title: string;
  /** Search text for a category that is still one block rather than rows (until Tasks 6-8). */
  keywords: string[];
};

/** The User scope's categories, in tree order. `secrets` opens the Secrets page (until Task 7). */
export const USER_CATEGORIES: SettingsCategoryInfo[] = [
  {
    id: 'ado',
    title: 'Connections',
    keywords: [
      'Azure DevOps',
      'organization',
      'project',
      'personal access token',
      'PAT',
      'Update token',
      'tracker',
    ],
  },
  { id: 'secrets', title: 'Secrets', keywords: ['env', 'environment'] },
  {
    id: 'editor',
    title: 'Editor',
    keywords: ['Default editor', 'VS Code', 'Visual Studio', 'Look again'],
  },
  {
    id: 'terminals',
    title: 'Agents and terminals',
    keywords: [
      'Default terminals',
      'Claude Code',
      'Copilot CLI',
      'OpenCode',
      'shell',
      'agents',
    ],
  },
  {
    id: 'cost',
    title: 'AI cost and invoicing',
    keywords: ['Usage receiver port', 'rates', 'write cost', 'Azure DevOps'],
  },
  {
    id: 'time',
    title: 'Time tracking',
    keywords: [
      'Working hours start',
      'Working hours end',
      'Idle minutes',
      'days',
      'Completed Work',
    ],
  },
  {
    id: 'budgets',
    title: 'Budgets',
    keywords: [
      'Claude budget',
      'Copilot budget',
      'monthly',
      'month start day',
      'alerts',
    ],
  },
  {
    id: 'cost-server',
    title: 'Cost server',
    keywords: ['Server address', 'Email', 'Company key', 'connect'],
  },
  {
    id: 'appearance',
    title: 'Appearance',
    keywords: [
      'Theme',
      'light',
      'dark',
      'Show splash on start',
      'Send anonymous usage and error data',
      'telemetry',
      'Notify when an agent finishes its turn',
    ],
  },
  { id: 'about', title: 'About', keywords: ['version', 'Get started'] },
];

/**
 * An existing section as one searchable block (category granularity) until Tasks 6-8 turn it into
 * rows: it registers itself with the search and hides while the query does not match it.
 */
function SectionBlock({
  info,
  children,
}: {
  info: SettingsCategoryInfo;
  children: ReactNode;
}) {
  const search = useSettingsSearch();
  const texts = [info.title, ...info.keywords];
  const textKey = texts.join('\u0000');
  const { register } = search;
  useEffect(
    () => register(`${info.id}-block`, 'user', texts, info.id),
    [register, info.id, textKey],
  );
  return <div hidden={!search.matches(texts)}>{children}</div>;
}

function AppearanceSection() {
  const notify = useStore((s) => s.notify);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    let live = true;
    void tryInvoke(() => api().invoke('settings:get'), notify).then((s) => {
      if (live && s) setSettings(s);
    });
    return () => {
      live = false;
    };
  }, [notify]);

  const toggle = async (
    patch: Partial<
      Pick<
        AppSettings,
        'showSplash' | 'sendTelemetry' | 'notifyOnDone' | 'theme'
      >
    >,
  ) => {
    if (!settings) return;
    const saved = await tryInvoke(() => saveSettings(patch), notify);
    if (saved) setSettings(saved);
  };

  return (
    <section id="appearance" className="section">
      <div className="section-head">
        <h2>Appearance</h2>
      </div>
      <div className="list">
        <div className="list-row">
          <label>
            Theme{' '}
            <select
              className="field"
              aria-label="Theme"
              value={settings?.theme ?? 'system'}
              disabled={!settings}
              onChange={(e) =>
                void toggle({ theme: e.target.value as ThemeChoice })
              }
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </div>
        <div className="list-row">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings?.showSplash ?? true}
              disabled={!settings}
              onChange={(e) => void toggle({ showSplash: e.target.checked })}
            />{' '}
            Show splash on start
          </label>
        </div>
        <div className="list-row">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings?.sendTelemetry ?? true}
              disabled={!settings}
              onChange={(e) => void toggle({ sendTelemetry: e.target.checked })}
            />{' '}
            Send anonymous usage and error data
          </label>
        </div>
        <div className="list-row">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings?.notifyOnDone ?? true}
              disabled={!settings}
              onChange={(e) => void toggle({ notifyOnDone: e.target.checked })}
            />{' '}
            Notify when an agent finishes its turn
          </label>
        </div>
      </div>
    </section>
  );
}

function AboutSection() {
  const [version, setVersion] = useState('');
  const go = useStore((s) => s.go);
  const notify = useStore((s) => s.notify);

  const getStarted = async () => {
    const saved = await tryInvoke(
      () =>
        saveSettings((f) => ({
          onboarding: { ...f.onboarding, dismissedAt: null },
        })),
      notify,
    );
    if (saved) go({ kind: 'get-started' });
  };

  useEffect(() => {
    let live = true;
    api()
      .invoke('app:info')
      .then((i) => {
        if (live) setVersion(i.version);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  return (
    <section id="about" aria-label="About" className="section">
      <div className="section-head">
        <h2>About</h2>
      </div>
      <div className="card about">
        <MindMark size={40} />
        <div>
          <div className="about-name">Shellie</div>
          <div className="muted">
            Development tasks as isolated workspaces, with AI cost per task
          </div>
          <div className="small muted">
            General Systems Vehicle (accounting division)
          </div>
          {version && <div className="mono small muted">v{version}</div>}
          <button
            type="button"
            className="link"
            onClick={() => void getStarted()}
          >
            Get started
          </button>
        </div>
      </div>
    </section>
  );
}

const SECTIONS: Record<string, () => ReactNode> = {
  ado: () => <ConnectionsSection />,
  editor: () => <EditorSection />,
  terminals: () => <AgentsSection />,
  cost: () => <CostSection />,
  time: () => <TimeSection />,
  budgets: () => <BudgetSection />,
  'cost-server': () => <CostServerSection />,
  appearance: () => <AppearanceSection />,
  about: () => <AboutSection />,
};

/** The app-wide settings. Each existing section keeps its own `id` for deep links and the tree. */
export function UserScope() {
  return (
    <>
      {USER_CATEGORIES.filter((c) => SECTIONS[c.id]).map((c) => (
        <SectionBlock key={c.id} info={c}>
          {SECTIONS[c.id]()}
        </SectionBlock>
      ))}
    </>
  );
}
