import { useEffect, useRef, useState } from 'react';
import type { BrainSearchHit } from '../../../shared/brain';
import { api } from '../../api';
import { trackBrain } from './brainActions';

const DEBOUNCE_MS = 150;
export const SEARCH_MIN = 2;

/** The matching line with the match emphasised. */
function Emphasised({ text, query }: { text: string; query: string }) {
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  );
}

/**
 * A search over the brain's text. `onResults` says whether results are showing (the caller hides its lists);
 * Enter opens the first hit, a click any hit; Esc clears.
 */
export function BrainSearch({
  brainId,
  onOpen,
  onActive,
}: {
  brainId: string;
  onOpen: (path: string, anchor?: string) => void;
  onActive: (active: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  // The hits and the query they answer: a slow answer for an earlier query never shows for a later one.
  const [result, setResult] = useState<{ q: string; hits: BrainSearchHit[] }>({
    q: '',
    hits: [],
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const q = query.trim();
  // The query as it is now: an answer for an earlier one is dropped, not stored.
  const latest = useRef(q);
  latest.current = q;
  const active = q.length >= SEARCH_MIN;
  const hits = result.q === q ? result.hits : [];
  const pending = active && result.q !== q;

  useEffect(() => {
    onActive(active);
  }, [active, onActive]);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!active) return;
    timer.current = setTimeout(() => {
      trackBrain('search');
      const asked = q;
      api()
        .invoke('brain:search', brainId, asked)
        .then(
          (found) => {
            if (latest.current === asked) setResult({ q: asked, hits: found });
          },
          () => {
            if (latest.current === asked) setResult({ q: asked, hits: [] });
          },
        );
    }, DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [brainId, q, active]);

  const openHit = (h: BrainSearchHit) => onOpen(h.path, h.anchor ?? undefined);

  return (
    <div className="brain-search">
      <input
        className="field"
        type="search"
        aria-label="Search the brain"
        placeholder="Search pages and sources"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setQuery('');
          else if (e.key === 'Enter' && hits[0]) openHit(hits[0]);
        }}
      />
      {active && (
        <ul className="list brain-hits" aria-label="Search results">
          {pending && <li className="muted small">Searching…</li>}
          {!pending && hits.length === 0 && (
            <li className="muted small">Nothing holds “{q}”.</li>
          )}
          {hits.map((h) => (
            <li key={`${h.path}:${h.line}`}>
              <button
                type="button"
                className="brain-hit"
                onClick={() => openHit(h)}
              >
                <span className="brain-hit-title">
                  {h.title} <span className="tag tag-muted">{h.kind}</span>
                </span>
                <span className="small brain-hit-text">
                  <Emphasised text={h.text} query={q} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
