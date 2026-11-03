import { useEffect, useId, useState } from 'react';
import type { AdoWiki, AdoWikiPage, BrainWiki } from '../../../shared/brain';
import { api } from '../../api';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const wikiLabel = (w: AdoWiki) =>
  `${w.name} (${w.type === 'projectWiki' ? 'project wiki' : 'code wiki'})`;

const depthOf = (path: string) =>
  Math.max(0, path.split('/').filter(Boolean).length - 1);

/** Choose a wiki of the project and the page to mirror from ("Whole wiki" or one page and its children). */
export function WikiRootPicker({
  connectionId,
  project: rawProject,
  value,
  onChange,
  disabled = false,
}: {
  connectionId: string;
  project: string;
  value: BrainWiki | null;
  onChange: (wiki: BrainWiki | null) => void;
  /** While the project is still being typed: its wikis are not the ones shown. */
  disabled?: boolean;
}) {
  const id = useId();
  const project = rawProject.trim();
  const [wikis, setWikis] = useState<AdoWiki[] | null>(null);
  const [wikisError, setWikisError] = useState<string | null>(null);
  const [pages, setPages] = useState<AdoWikiPage[] | null>(null);
  const [pagesError, setPagesError] = useState<string | null>(null);
  const wikiId = value?.wikiId ?? null;

  useEffect(() => {
    let live = true;
    setWikis(null);
    setWikisError(null);
    if (!project) return;
    api()
      .invoke('brain:wikis', connectionId, project)
      .then(
        (w) => live && setWikis(w),
        (e) => live && setWikisError(message(e)),
      );
    return () => {
      live = false;
    };
  }, [connectionId, project]);

  useEffect(() => {
    let live = true;
    setPages(null);
    setPagesError(null);
    if (!wikiId) return;
    api()
      .invoke('brain:wikiPages', connectionId, project, wikiId)
      .then(
        (p) => live && setPages(p),
        (e) => live && setPagesError(message(e)),
      );
    return () => {
      live = false;
    };
  }, [connectionId, project, wikiId]);

  const choose = (w: AdoWiki, rootPath: string) =>
    onChange({
      wikiId: w.id,
      wikiName: w.name,
      type: w.type,
      repositoryId: w.repositoryId,
      gitUrl: w.gitUrl,
      version: w.version,
      mappedPath: w.mappedPath,
      rootPath,
    });

  const selected = wikis?.find((w) => w.id === wikiId) ?? null;

  return (
    <div className="wiki-picker">
      <label htmlFor={`${id}-wiki`}>Wiki</label>
      <select
        id={`${id}-wiki`}
        className="field"
        value={wikiId ?? ''}
        disabled={disabled || (wikis === null && !value)}
        onChange={(e) => {
          const w = wikis?.find((x) => x.id === e.target.value);
          if (w) choose(w, '/');
          else onChange(null);
        }}
      >
        <option value="">None</option>
        {value && !selected ? (
          <option value={value.wikiId}>{value.wikiName}</option>
        ) : null}
        {(wikis ?? []).map((w) => (
          <option key={w.id} value={w.id}>
            {wikiLabel(w)}
          </option>
        ))}
      </select>
      {wikis === null && !wikisError && project ? (
        <div className="small muted">Loading wikis…</div>
      ) : null}
      {wikisError ? (
        <div className="small conn-status-bad" role="alert">
          Could not load wikis: {wikisError}
        </div>
      ) : null}
      {selected ? (
        <>
          <label htmlFor={`${id}-page`}>Root page</label>
          <select
            id={`${id}-page`}
            className="field"
            value={value?.rootPath ?? '/'}
            disabled={disabled}
            onChange={(e) => choose(selected, e.target.value)}
          >
            <option value="/">Whole wiki</option>
            {(pages ?? []).map((p) => (
              <option key={p.path} value={p.path}>
                {'  '.repeat(depthOf(p.path))}
                {p.path}
              </option>
            ))}
          </select>
          {pages === null && !pagesError ? (
            <div className="small muted">Loading pages…</div>
          ) : null}
          {pagesError ? (
            <div className="small conn-status-bad" role="alert">
              Could not load pages: {pagesError}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
