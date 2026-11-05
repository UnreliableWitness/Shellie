/** The Settings screen's scopes, its category tree and its search status. */
import { useEffect, useRef } from 'react';
import { useSettingsSearch } from '../../components/settings/settingsSearch';
import { track } from '../../telemetry';
import { PROJECT_CATEGORIES } from './ProjectScope';
import { REPO_CATEGORIES } from './RepoScope';
import { USER_CATEGORIES } from './UserScope';

export type Scope = 'user' | 'project' | 'repo';

export const SCOPES: Scope[] = ['user', 'project', 'repo'];
export const SCOPE_LABEL: Record<Scope, string> = {
  user: 'User',
  project: 'Project',
  repo: 'Repository',
};
export const CATEGORIES = {
  user: USER_CATEGORIES,
  project: PROJECT_CATEGORIES,
  repo: REPO_CATEGORIES,
};
export const isScope = (s: string | null): s is Scope =>
  SCOPES.includes(s as Scope);

export function SearchTelemetry({ scope }: { scope: Scope }) {
  const search = useSettingsSearch();
  const active = search.query.trim() !== '';
  const results = useRef(0);
  results.current = active ? search.countIn(scope) : 0;
  // Keyed on the query only: a scope switch or late row registration does not send it again.
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(
      () => track('settings.search', { results: results.current }),
      1000,
    );
    return () => window.clearTimeout(timer);
  }, [active, search.query]);
  return null;
}

export function SettingsTree({
  scope,
  activeId,
  empty,
}: {
  scope: Scope;
  activeId: string | null;
  /** The scope shows no settings (no repo to show). */
  empty: boolean;
}) {
  const search = useSettingsSearch();
  const searching = search.query.trim() !== '';
  const categories = empty ? [] : CATEGORIES[scope];
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      {categories.map((c) => {
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

/** "N results in Repository" for each other scope, and the empty state, from the rows every scope registers. */
export function SearchStatus({
  scope,
  scopes,
  onSwitch,
}: {
  scope: Scope;
  scopes: Scope[];
  onSwitch: (s: Scope) => void;
}) {
  const search = useSettingsSearch();
  const query = search.query.trim();
  if (!query) return null;
  const here = search.countIn(scope);
  return (
    <>
      {scopes
        .filter((s) => s !== scope)
        .map((s) => {
          const there = search.countIn(s);
          if (there === 0) return null;
          return (
            <button
              key={s}
              type="button"
              className="link"
              onClick={() => onSwitch(s)}
            >
              {there} {there === 1 ? 'result' : 'results'} in {SCOPE_LABEL[s]}
            </button>
          );
        })}
      {here === 0 && (
        <div className="settings-empty">
          No settings match &ldquo;{query}&rdquo;
        </div>
      )}
    </>
  );
}
