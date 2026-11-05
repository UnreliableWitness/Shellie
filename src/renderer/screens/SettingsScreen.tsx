import { Search16Regular } from '@fluentui/react-icons';
import { useEffect, useRef, useState } from 'react';
import type { Repo } from '../../shared/types';
import { api, tryInvoke } from '../api';
import { SettingsSearchProvider } from '../components/settings/settingsSearch';
import { useScrollSpy } from '../components/settings/useScrollSpy';
import { PageHeader, Pivots } from '../components/ui';
import { activeConnection, type Screen, useStore } from '../store';
import { track } from '../telemetry';
import { ProjectScope } from './settings/ProjectScope';
import { RepoScope } from './settings/RepoScope';
import {
  CATEGORIES,
  isScope,
  SCOPE_LABEL,
  SCOPES,
  type Scope,
  SearchStatus,
  SearchTelemetry,
  SettingsTree,
} from './settings/scopeNav';
import { UserScope } from './settings/UserScope';

type SettingsLink = Extract<Screen, { kind: 'settings' }>;

const SCOPE_KEY = 'shellie.settings.scope';
const REPO_KEY = 'shellie.settings.repoId';
const CONNECTION_KEY = 'shellie.settings.connectionId';
function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // a per-viewer convenience only
  }
}

/**
 * Where a deep link opens: a repo or a `repo-*` (or the old `repos`) section is the Repository scope; a project
 * or a `project-*` (or the old `brains`) section is the Project scope.
 */
function linkScope(link: SettingsLink | null): Scope | null {
  if (!link) return null;
  if (link.repoId) return 'repo';
  if (link.connectionId) return 'project';
  if (link.section) {
    if (link.section === 'brains' || link.section.startsWith('project-'))
      return 'project';
    if (link.section === 'repos' || link.section.startsWith('repo-'))
      return 'repo';
    return 'user';
  }
  return link.scope ?? null;
}

function initialScope(link: SettingsLink | null): Scope {
  const stored = readPref(SCOPE_KEY);
  return linkScope(link) ?? (isScope(stored) ? stored : 'user');
}

/** The project a deep link asks for: its own, else that of the repo it opens. */
function linkConnection(
  link: SettingsLink | null,
  repos: Repo[],
): string | null {
  if (link?.connectionId) return link.connectionId;
  return repos.find((r) => r.id === link?.repoId)?.connectionId ?? null;
}

/** The repo a deep link asks for; without one (e.g. the old `repos` section) the remembered repo stays. */
function linkRepo(link: SettingsLink | null): string | null {
  return link?.repoId ?? null;
}

export function SettingsScreen() {
  const repos = useStore((s) => s.repos);
  const connections = useStore((s) => s.connections);
  const active = useStore(activeConnection);
  const go = useStore((s) => s.go);
  const notify = useStore((s) => s.notify);
  const link = useStore((s) =>
    s.screen.kind === 'settings' ? s.screen : null,
  );
  const section = link?.section;

  const [picked, setScope] = useState<Scope>(() => initialScope(link));
  const [repoId, setRepoId] = useState<string | null>(
    () => linkRepo(link) ?? readPref(REPO_KEY),
  );
  // Settings-local: picking a project here never switches the nav's project.
  const [connectionId, setConnectionId] = useState<string | null>(
    () => linkConnection(link, repos) ?? readPref(CONNECTION_KEY),
  );
  const [query, setQuery] = useState('');
  // A new deep link while the page is open picks its scope, project and repo again.
  const [seenLink, setSeenLink] = useState(link);
  if (link !== seenLink) {
    setSeenLink(link);
    const s = linkScope(link);
    if (s) setScope(s);
    const r = linkRepo(link);
    if (r) setRepoId(r);
    const c = linkConnection(link, repos);
    if (c) setConnectionId(c);
    if (link?.section || link?.repoId) setQuery('');
  }

  const connection =
    connections.find((c) => c.id === connectionId) ?? active ?? null;
  // Without a project there is no Project scope.
  const scope: Scope = picked === 'project' && !connection ? 'user' : picked;
  const scopes = SCOPES.filter((s) => s !== 'project' || connection);
  const linked = (r: Repo) => connections.some((c) => c.id === r.connectionId);
  const projectRepos = repos.filter(
    (r) => connection && r.connectionId === connection.id,
  );
  const looseRepos = repos.filter((r) => !linked(r));
  const shownRepos = [...projectRepos, ...looseRepos];
  const repo = shownRepos.find((r) => r.id === repoId) ?? shownRepos[0] ?? null;
  useEffect(() => writePref(SCOPE_KEY, picked), [picked]);
  useEffect(() => {
    if (repo) writePref(REPO_KEY, repo.id);
  }, [repo]);
  useEffect(() => {
    if (connection) writePref(CONNECTION_KEY, connection.id);
  }, [connection]);

  const switchScope = (next: Scope) => {
    if (next === scope) return;
    setScope(next);
    track('settings.scope', { scope: next });
  };

  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        e.key.toLowerCase() === 'f'
      ) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!section) return;
    const jump = () =>
      document.getElementById(section)?.scrollIntoView?.({ block: 'start' });
    jump();
    // Sections above the target load asynchronously and grow, so keep the
    // target in view while the layout settles, until the user takes over.
    const main = mainRef.current;
    let observer: ResizeObserver | undefined;
    if (main && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(jump);
      observer.observe(main);
      for (const child of Array.from(main.children)) observer.observe(child);
    }
    const stop = () => {
      observer?.disconnect();
      window.clearTimeout(timer);
      for (const ev of userEvents) window.removeEventListener(ev, stop, true);
    };
    const userEvents = ['wheel', 'pointerdown', 'keydown', 'touchstart'];
    for (const ev of userEvents) window.addEventListener(ev, stop, true);
    const timer = window.setTimeout(stop, 2000);
    return stop;
  }, [section, link]);

  const spyIds = CATEGORIES[scope].map((c) => c.id);
  const activeId = useScrollSpy(
    mainRef,
    spyIds,
    `${scope}|${query}|${connection?.id ?? ''}|${repo?.id ?? ''}`,
  );
  const repoOption = (r: Repo) => (
    <option key={r.id} value={r.id}>
      {r.name}
      {r.discovered ? ' (found in a task)' : ''}
    </option>
  );

  const addFolder = async () => {
    const folder = await tryInvoke(
      () => api().invoke('repos:pickFolder'),
      notify,
    );
    if (!folder) return;
    go({ kind: 'add-repo', from: 'settings', folder });
  };
  const addFolderButton = (
    <button type="button" className="btn" onClick={addFolder}>
      Add folder&hellip;
    </button>
  );

  return (
    <div className="page">
      <PageHeader title="Settings" />
      <SettingsSearchProvider query={query}>
        <SearchTelemetry scope={scope} />
        <div className="settings-page">
          <div className="settings-toolbar">
            <label className="settings-search">
              <Search16Regular aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                className="field"
                placeholder="Search settings"
                aria-label="Search settings"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setQuery('');
                }}
              />
            </label>
            <Pivots<Scope>
              label="Settings scope"
              items={scopes.map((s) => ({ key: s, label: SCOPE_LABEL[s] }))}
              selected={scope}
              onSelect={switchScope}
            />
            {scope !== 'user' && connection && (
              <select
                className="field"
                aria-label="Project"
                value={connection.id}
                onChange={(e) => setConnectionId(e.target.value)}
              >
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {`${c.name} / ${c.project}`}
                  </option>
                ))}
              </select>
            )}
            {scope === 'repo' && repo && (
              <>
                <select
                  className="field"
                  aria-label="Repository"
                  value={repo.id}
                  onChange={(e) => setRepoId(e.target.value)}
                >
                  {connection ? (
                    <>
                      {projectRepos.map(repoOption)}
                      {looseRepos.length > 0 && (
                        <optgroup label="No project">
                          {looseRepos.map(repoOption)}
                        </optgroup>
                      )}
                    </>
                  ) : (
                    looseRepos.map(repoOption)
                  )}
                </select>
                {addFolderButton}
              </>
            )}
          </div>
          <div className="settings-tree">
            <SettingsTree
              scope={scope}
              activeId={activeId}
              empty={scope === 'repo' && !repo}
            />
            <main className="settings-main" ref={mainRef}>
              <SearchStatus
                scope={scope}
                scopes={scopes}
                onSwitch={switchScope}
              />
              <div className="settings-scope" hidden={scope !== 'user'}>
                <UserScope />
              </div>
              {connection && (
                <div className="settings-scope" hidden={scope !== 'project'}>
                  <ProjectScope
                    key={connection.id}
                    connection={connection}
                    active={scope === 'project'}
                  />
                </div>
              )}
              <div className="settings-scope" hidden={scope !== 'repo'}>
                {repo ? (
                  <RepoScope
                    key={repo.id}
                    repo={repo}
                    active={scope === 'repo'}
                  />
                ) : (
                  <div className="list">
                    <div className="empty">
                      {repos.length
                        ? `No repositories in ${connection?.project ?? 'this project'} yet.`
                        : 'No repositories yet.'}{' '}
                      Add the folder of a git repository to start tasks in it.
                      <div style={{ marginTop: 8 }}>{addFolderButton}</div>
                    </div>
                  </div>
                )}
              </div>
            </main>
          </div>
        </div>
      </SettingsSearchProvider>
    </div>
  );
}
