import type { Repo } from '../../../shared/types';
import {
  SettingRow,
  SettingsCategory,
} from '../../components/settings/SettingRow';
import { useStore } from '../../store';
import { AgentsCategory } from './repo/AgentsCategory';
import { ChangesCategory } from './repo/ChangesCategory';
import { DangerCategory } from './repo/DangerCategory';
import { GeneralCategory } from './repo/GeneralCategory';
import { RepoEditorCategory } from './repo/RepoEditorCategory';
import { RepoHeader } from './repo/RepoHeader';
import { RunCategory } from './repo/RunCategory';
import { SetupCategory } from './repo/SetupCategory';
import { useRepoSettings } from './repo/useRepoSettings';
import { WorkItemsCategory } from './repo/WorkItemsCategory';
import type { SettingsCategoryInfo } from './UserScope';

/** The Repository scope's categories, in tree order. */
export const REPO_CATEGORIES: SettingsCategoryInfo[] = [
  { id: 'repo-secrets', title: 'Secrets & env', keywords: [] },
  { id: 'repo-general', title: 'General', keywords: [] },
  { id: 'repo-setup', title: 'Setup', keywords: [] },
  { id: 'repo-agents', title: 'Agents', keywords: [] },
  { id: 'repo-run', title: 'Run', keywords: [] },
  { id: 'repo-workitems', title: 'Work items on start', keywords: [] },
  { id: 'repo-editor', title: 'Editor', keywords: [] },
  { id: 'repo-changes', title: 'Changes', keywords: [] },
  { id: 'repo-danger', title: 'Danger zone', keywords: [] },
];

const title = (id: string) =>
  REPO_CATEGORIES.find((c) => c.id === id)?.title ?? id;

/** One repo's settings. `active` is false while the scope is mounted hidden (for search counts). */
export function RepoScope({ repo, active }: { repo: Repo; active: boolean }) {
  const go = useStore((s) => s.go);
  const settings = useRepoSettings(repo.id, active);

  return (
    <>
      <RepoHeader repo={repo} settings={settings} />
      <SettingsCategory id="repo-secrets" title={title('repo-secrets')}>
        <SettingRow
          id="repo-secrets-manage"
          scope="repo"
          category="Secrets & env"
          title="Secrets"
          description="Values Shellie puts in this repo's env files and terminals, per environment."
          keywords={['env', 'environment', 'import']}
        >
          <button
            type="button"
            className="btn"
            onClick={() => go({ kind: 'secrets', repoId: repo.id })}
          >
            Manage secrets&hellip;
          </button>
        </SettingRow>
      </SettingsCategory>
      <GeneralCategory
        repo={repo}
        settings={settings}
        title={title('repo-general')}
      />
      <SetupCategory settings={settings} title={title('repo-setup')} />
      <AgentsCategory repo={repo} title={title('repo-agents')} />
      <RunCategory settings={settings} title={title('repo-run')} />
      <WorkItemsCategory
        repo={repo}
        active={active}
        title={title('repo-workitems')}
      />
      <RepoEditorCategory
        repo={repo}
        active={active}
        title={title('repo-editor')}
      />
      <ChangesCategory settings={settings} title={title('repo-changes')} />
      <DangerCategory repo={repo} title={title('repo-danger')} />
    </>
  );
}
