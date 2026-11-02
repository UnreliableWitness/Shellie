import { Search16Regular } from '@fluentui/react-icons';
import { useEffect, useRef, useState } from 'react';
import { api, tryInvoke } from '../api';
import {
  matchesQuery,
  SettingsSearchProvider,
  useSettingsSearch,
} from '../components/settings/settingsSearch';
import { useScrollSpy } from '../components/settings/useScrollSpy';
import { PageHeader, Pivots } from '../components/ui';
import { type Screen, useStore } from '../store';
import { track } from '../telemetry';
import { REPO_CATEGORIES, RepoScope } from './settings/RepoScope';
import { USER_CATEGORIES, UserScope } from './settings/UserScope';

type Scope = 'user' | 'repo';
type SettingsLink = Extract<Screen, { kind: 'settings' }>;

const SCOPE_KEY = 'shellie.settings.scope';
const REPO_KEY = 'shellie.settings.repoId';
const SCOPE_LABEL: Record<Scope, string> = {
  user: 'User',
  repo: 'Repository',
};
const other = (s: Scope): Scope => (s === 'user' ? 'repo' : 'user');

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

/** Where a deep link opens: a repo or a `repo-*` (or the old `repos`) section is the Repository scope. */
function linkScope(link: SettingsLink | null): Scope | null {
  if (!link) return null;
  if (link.repoId) return 'repo';
  if (link.section)
    return link.section === 'repos' || link.section.startsWith('repo-')
      ? 'repo'
      : 'user';
  return link.scope ?? null;
}

function initialScope(link: SettingsLink | null): Scope {
  const stored = readPref(SCOPE_KEY);
  return (
    linkScope(link) ??
    (stored === 'repo' || stored === 'user' ? stored : 'user')
  );
}

/** The repo a deep link asks for; the old `repos` section opens the first repo. */
function linkRepo(link: SettingsLink | null, firstRepo: string | null) {
  if (link?.repoId) return link.repoId;
  if (link?.section === 'repos') return firstRepo;
  return null;
}

function SearchTelemetry({ scope }: { scope: Scope }) {
  const search = useSettingsSearch();
  const active = search.query.trim() !== '';
  const results = active ? search.countOther(other(scope)) : 0;
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(
      () => track('settings.search', { results }),
      1000,
    );
    return () => window.clearTimeout(timer);
  }, [active, search.query, results]);
  return null;
}

function SettingsTree({
  scope,
  activeId,
}: {
  scope: Scope;
  activeId: string | null;
}) {
  const search = useSettingsSearch();
  const go = useStore((s) => s.go);
  const repos = useStore((s) => s.repos);
  const searching = search.query.trim() !== '';
  const categories =
    scope === 'user' ? USER_CATEGORIES : repos.length ? REPO_CATEGORIES : [];
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      {categories.map((c) => {
        if (c.id === 'secrets') {
          if (
            searching &&
            !matchesQuery(search.query, [c.title, ...c.keywords])
          )
            return null;
          return (
            <a
              key={c.id}
              href="#secrets"
              onClick={(e) => {
                e.preventDefault();
                go({ kind: 'secrets' });
              }}
            >
              {c.title}
            </a>
          );
        }
        if (searching && search.categoryCount(c.id).matching === 0) return null;
        return (
          <a
            key={c.id}
            href={`#${c.id}`}
            className={activeId === c.id ? 'active' : undefined}
            aria-current={activeId === c.id ? 'true' : undefined}
            onClick={(e) => {
              e.preventDefault();
              document
                .getElementById(c.id)
                ?.scrollIntoView?.({ block: 'start' });
            }}
          >
            {c.title}
          </a>
        );
      })}
    </nav>
  );
}

/** "N results in Repository" and the empty state, from the rows both scopes register. */
function SearchStatus({
  scope,
  onSwitch,
}: {
  scope: Scope;
  onSwitch: (s: Scope) => void;
}) {
  const search = useSettingsSearch();
  const query = search.query.trim();
  if (!query) return null;
  const here = search.countOther(other(scope));
  const there = search.countOther(scope);
  return (
    <>
      {there > 0 && (
        <button
          type="button"
          className="link"
          onClick={() => onSwitch(other(scope))}
        >
          {there} {there === 1 ? 'result' : 'results'} in{' '}
          {SCOPE_LABEL[other(scope)]}
        </button>
      )}
      {here === 0 && (
        <div className="settings-empty">
          No settings match &ldquo;{query}&rdquo;
        </div>
      )}
    </>
  );
}

export function SettingsScreen() {
  const repos = useStore((s) => s.repos);
  const go = useStore((s) => s.go);
  const notify = useStore((s) => s.notify);
  const link = useStore((s) =>
    s.screen.kind === 'settings' ? s.screen : null,
  );
  const section = link?.section;

  const [scope, setScope] = useState<Scope>(() => initialScope(link));
  const [repoId, setRepoId] = useState<string | null>(
    () => linkRepo(link, repos[0]?.id ?? null) ?? readPref(REPO_KEY),
  );
  const [query, setQuery] = useState('');
  // A new deep link while the page is open picks its scope and repo again.
  const [seenLink, setSeenLink] = useState(link);
  if (link !== seenLink) {
    setSeenLink(link);
    const s = linkScope(link);
    if (s) setScope(s);
    const r = linkRepo(link, repos[0]?.id ?? null);
    if (r) setRepoId(r);
    if (link?.section || link?.repoId) setQuery('');
  }

  const repo = repos.find((r) => r.id === repoId) ?? repos[0] ?? null;
  useEffect(() => writePref(SCOPE_KEY, scope), [scope]);
  useEffect(() => {
    if (repo) writePref(REPO_KEY, repo.id);
  }, [repo]);

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

  const spyIds = (scope === 'user' ? USER_CATEGORIES : REPO_CATEGORIES)
    .map((c) => c.id)
    .filter((id) => id !== 'secrets');
  const activeId = useScrollSpy(
    mainRef,
    spyIds,
    `${scope}|${query}|${repo?.id ?? ''}`,
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
              items={[
                { key: 'user', label: SCOPE_LABEL.user },
                { key: 'repo', label: SCOPE_LABEL.repo },
              ]}
              selected={scope}
              onSelect={switchScope}
            />
            {scope === 'repo' && repo && (
              <>
                <select
                  className="field"
                  aria-label="Repository"
                  value={repo.id}
                  onChange={(e) => setRepoId(e.target.value)}
                >
                  {repos.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                      {r.discovered ? ' (found in a task)' : ''}
                    </option>
                  ))}
                </select>
                {addFolderButton}
              </>
            )}
          </div>
          <div className="settings-tree">
            <SettingsTree scope={scope} activeId={activeId} />
            <main className="settings-main" ref={mainRef}>
              <SearchStatus scope={scope} onSwitch={switchScope} />
              <div className="settings-scope" hidden={scope !== 'user'}>
                <UserScope />
              </div>
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
                      No repositories yet. Add the folder of a git repository to
                      start tasks in it.
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
