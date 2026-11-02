import type { Repo } from '../../../shared/types';
import { AgentsCategory } from './repo/AgentsCategory';
import { ChangesCategory } from './repo/ChangesCategory';
import { DangerCategory } from './repo/DangerCategory';
import { GeneralCategory } from './repo/GeneralCategory';
import { RepoEditorCategory } from './repo/RepoEditorCategory';
import { RepoHeader } from './repo/RepoHeader';
import { RunCategory } from './repo/RunCategory';
import { SecretsEnvCategory } from './repo/SecretsEnvCategory';
import { SetupCategory } from './repo/SetupCategory';
import { useRepoSettings } from './repo/useRepoSettings';
import { WorkItemsCategory } from './repo/WorkItemsCategory';
import type { SettingsCategoryInfo } from './UserScope';

/** The Repository scope's categories, in tree order. */
export const REPO_CATEGORIES: SettingsCategoryInfo[] = [
  { id: 'repo-secrets', title: 'Secrets & env' },
  { id: 'repo-general', title: 'General' },
  { id: 'repo-setup', title: 'Setup' },
  { id: 'repo-agents', title: 'Agents' },
  { id: 'repo-run', title: 'Run' },
  { id: 'repo-workitems', title: 'Work items on start' },
  { id: 'repo-editor', title: 'Editor' },
  { id: 'repo-changes', title: 'Changes' },
  { id: 'repo-danger', title: 'Danger zone' },
];

const title = (id: string) =>
  REPO_CATEGORIES.find((c) => c.id === id)?.title ?? id;

/** One repo's settings. `active` is false while the scope is mounted hidden (for search counts). */
export function RepoScope({ repo, active }: { repo: Repo; active: boolean }) {
  const settings = useRepoSettings(repo.id, active);

  return (
    <>
      <RepoHeader repo={repo} settings={settings} />
      <SecretsEnvCategory
        repo={repo}
        settings={settings}
        active={active}
        title={title('repo-secrets')}
      />
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
