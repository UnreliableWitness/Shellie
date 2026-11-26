import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BrainJob } from '../../../../shared/brain';
import { plural } from '../../../../shared/text';
import { BrainGraph } from '../BrainGraph';
import { BrainPage } from '../BrainPage';
import type { BrainPages } from '../BrainWiki';
import { newPathsSince } from '../newPaths';
import { GRAPH_MAX_NODES } from '../pageGraph';
import { useBrainNav } from '../useBrainNav';
import type { SkyLabel, SkyScene } from './SkyScene';
import {
  SKY_TYPE_COLOR,
  skyFacts,
  skyLayout,
  skyMatches,
  type Sky,
  type Star,
} from './skyLayout';

/** The page panel's width, which the scene keeps its middle clear of. */
const PANEL_PX = 460;
/** Pages kept in the trail. */
const TRAIL = 7;

type SceneModule = { SkyScene: typeof SkyScene };
const loadSkyScene = (): Promise<SceneModule> => import('./SkyScene');

function reducedMotion() {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Whether a key press belongs to something the user is typing in or operating. */
function busy(target: EventTarget | null, also = ''): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(
      `input, textarea, select, [contenteditable="true"], .brain-page-body${also}`,
    ) !== null || document.querySelector('.brain-lightbox') !== null
  );
}

function StarRow({ star, onOpen }: { star: Star; onOpen(path: string): void }) {
  return (
    <li>
      <button
        type="button"
        className="sky-row"
        onClick={() => onOpen(star.path)}
      >
        <span
          className="sky-dot"
          style={{ background: SKY_TYPE_COLOR[star.type] }}
          aria-hidden="true"
        />
        <span className="sky-row-title">{star.title}</span>
      </button>
    </li>
  );
}

/**
 * The Explore view: the brain as a sky to fly through (`SkyScene`, loaded only when the view is first shown),
 * with the open page beside it, a search that lights the matching stars, and a trail of the pages visited. A
 * machine without WebGL gets the flat map with the same panel, search and trail.
 */
export function BrainSky({
  brainId,
  brainName,
  pages,
  since,
  active,
  jobs,
  skillsReady,
  onOpenInRead,
  loadScene = loadSkyScene,
}: {
  brainId: string;
  brainName: string;
  /** The brain's pages, sources, log and book, loaded once by the screen. */
  pages: BrainPages;
  since: string | null;
  /** Whether Explore is the view in front: the scene runs only then. */
  active: boolean;
  jobs?: BrainJob[];
  skillsReady?: boolean;
  /** Read the page (or the long read) in the Read view. */
  onOpenInRead(path: string): void;
  /** How the scene is made; a test gives one that draws nothing. */
  loadScene?: () => Promise<SceneModule>;
}) {
  const { rows, sources, log, book, loaded } = pages;
  const nav = useBrainNav('sky');
  const [today] = useState(() => Date.now());
  const newPaths = useMemo(
    () => newPathsSince(log, rows, since),
    [log, rows, since],
  );
  const sky = useMemo(
    () => skyLayout(rows, book, newPaths, today),
    [rows, book, newPaths, today],
  );
  const facts = useMemo(() => skyFacts(sky), [sky]);
  const indexOf = useMemo(
    () => new Map(sky.stars.map((s, i) => [s.path, i])),
    [sky],
  );

  const [query, setQuery] = useState('');
  const found = useMemo(
    () => (query.trim() ? skyMatches(rows, sky, query) : null),
    [rows, sky, query],
  );
  const [hovered, setHovered] = useState<number | null>(null);
  const [candidate, setCandidate] = useState<number | null>(null);
  const [trail, setTrail] = useState<string[]>([]);
  const shown = nav.current?.path ?? null;
  const selected = shown === null ? null : (indexOf.get(shown) ?? null);

  const [scene, setScene] = useState<SkyScene | null>(null);
  /** No WebGL, or it was lost for good: the flat map takes over. */
  const [flat, setFlat] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const labelBox = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const wanted = useRef(false);

  const open = useCallback(
    (path: string, anchor?: string) => {
      // Long reads and letters are read in the Read view; the sky holds the wiki's pages.
      if (path.startsWith('reads/')) return onOpenInRead(path);
      setQuery('');
      setCandidate(null);
      nav.open(path, anchor);
    },
    [nav, onOpenInRead],
  );
  const openRef = useRef(open);
  openRef.current = open;
  const skyRef = useRef<Sky>(sky);
  skyRef.current = sky;
  const lit = useRef({ selected, hovered, candidate });
  lit.current = { selected, hovered, candidate };

  /** The scene's names, written straight to the page: a frame is no reason for React to render. */
  const placeLabels = useCallback((labels: SkyLabel[]) => {
    const box = labelBox.current;
    if (!box) return;
    while (box.children.length < labels.length)
      box.appendChild(document.createElement('div'));
    const current = skyRef.current;
    const { selected: sel, hovered: hov, candidate: cand } = lit.current;
    for (let i = 0; i < box.children.length; i++) {
      const el = box.children[i] as HTMLElement;
      const label = labels[i];
      if (!label) {
        el.hidden = true;
        continue;
      }
      let text = '';
      let cls = 'sky-label';
      if (label.kind === 'chapter') {
        const c = current.clusters[label.index];
        text = c
          ? `${c.number ? `${String(c.number).padStart(2, '0')}  ` : ''}${c.title}`
          : '';
        cls += ' sky-label-chapter';
      } else {
        text = current.stars[label.index]?.title ?? '';
        cls += ' sky-label-page';
        if (label.index === (sel ?? hov)) cls += ' is-main';
        if (label.index === cand) cls += ' is-candidate';
      }
      if (el.textContent !== text) el.textContent = text;
      if (el.className !== cls) el.className = cls;
      el.hidden = false;
      el.style.opacity = String(label.alpha);
      el.style.transform = `translate(${label.x.toFixed(1)}px, ${label.y.toFixed(1)}px)`;
    }
  }, []);

  // The scene is made the first time the view is in front, and lives until the brain page goes: another view in
  // front pauses it (below), so the camera and the selection are there on the way back.
  const made = useRef<SkyScene | null>(null);
  const gone = useRef(false);
  useEffect(() => {
    if (!active || wanted.current) return;
    wanted.current = true;
    loadScene().then(
      ({ SkyScene: Scene }) => {
        if (gone.current || !host.current) return;
        try {
          made.current = new Scene(
            host.current,
            {
              onPick: (star) => {
                const s = skyRef.current.stars[star];
                if (s) openRef.current(s.path);
              },
              onHover: setHovered,
              onLabels: placeLabels,
              onLost: () => setFlat(true),
            },
            { reducedMotion: reducedMotion() },
          );
          made.current.setPanelWidth(PANEL_PX);
          setScene(made.current);
        } catch {
          setFlat(true);
        }
      },
      () => setFlat(true),
    );
  }, [active, loadScene, placeLabels]);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      made.current?.dispose();
      made.current = null;
    };
  }, []);
  // Without graphics the flat map takes over, and the scene goes.
  useEffect(() => {
    if (!flat || !made.current) return;
    made.current.dispose();
    made.current = null;
    setScene(null);
  }, [flat]);

  useEffect(() => scene?.setRunning(active), [scene, active]);

  // The first sky waits for the pages, so the flight in shows the real brain; a later one keeps the camera.
  const first = useRef(true);
  useEffect(() => {
    if (!scene || !loaded) return;
    scene.setSky(sky, first.current ? undefined : { camera: true });
    first.current = false;
  }, [scene, sky, loaded]);

  const matchSet = useMemo(() => (found ? new Set(found) : null), [found]);
  useEffect(() => {
    scene?.setFocus({ selected, hovered, candidate, matches: matchSet });
  }, [scene, sky, selected, hovered, candidate, matchSet]);

  // The camera follows what is open; a source leaves it where it is.
  const flown = useRef<string | null>(null);
  useEffect(() => {
    if (!scene || flown.current === shown) return;
    const before = flown.current;
    flown.current = shown;
    if (selected !== null) scene.flyToStar(selected);
    else if (shown === null && before !== null) scene.flyToOverview();
  }, [scene, shown, selected]);

  useEffect(() => {
    if (shown === null || !indexOf.has(shown)) return;
    setTrail((t) =>
      t[t.length - 1] === shown
        ? t
        : [...t.filter((p) => p !== shown), shown].slice(-TRAIL),
    );
  }, [shown, indexOf]);

  // A page that left the brain while it was open: back to the brain at a glance.
  useEffect(() => {
    if (
      loaded &&
      shown !== null &&
      !rows.some((r) => r.path === shown) &&
      !sources.some((s) => s.path === shown) &&
      shown.startsWith('wiki/')
    )
      nav.home();
  }, [loaded, shown, rows, sources, nav]);

  const search = (text: string) => {
    setQuery(text);
    if (!text.trim()) return;
    setCandidate(null);
    // A search looks at the whole brain.
    if (nav.current) nav.home();
    else scene?.flyToOverview();
  };

  const neighbours = useMemo(
    () =>
      selected === null
        ? []
        : [...sky.stars[selected].links].sort(
            (a, b) => sky.stars[b].links.length - sky.stars[a].links.length,
          ),
    [sky, selected],
  );
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey) return;
      const mod = e.metaKey || e.ctrlKey;
      if (
        (e.key === '/' && !mod && !busy(e.target)) ||
        (e.key.toLowerCase() === 'k' && mod && !e.shiftKey)
      ) {
        e.preventDefault();
        searchBox.current?.focus();
        return;
      }
      if (mod || busy(e.target)) return;
      if (e.key === 'Escape') {
        if (query) setQuery('');
        else if (nav.current) nav.home();
        setCandidate(null);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        if (!neighbours.length) return;
        e.preventDefault();
        const at = candidate === null ? -1 : neighbours.indexOf(candidate);
        const step = e.key === 'ArrowRight' ? 1 : at < 0 ? 0 : -1;
        setCandidate(
          neighbours[(at + step + neighbours.length) % neighbours.length],
        );
      } else if (
        e.key === 'Enter' &&
        candidate !== null &&
        !busy(e.target, ', button, a')
      ) {
        e.preventDefault();
        open(sky.stars[candidate].path);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, query, nav, neighbours, candidate, open, sky]);

  const hidden = sky.total - sky.stars.length;
  const byLinks = useMemo(
    () =>
      [...sky.stars]
        .sort((a, b) => b.links.length - a.links.length)
        .slice(0, 5),
    [sky],
  );
  const fresh = useMemo(
    () => sky.stars.filter((s) => s.isNew).slice(0, 5),
    [sky],
  );
  const title = (path: string) => sky.stars[indexOf.get(path)!]?.title ?? path;

  return (
    <div className="sky">
      {flat ? (
        <div className="sky-flat">
          <p className="muted small">
            The 3D view is not available on this machine; this is the flat map.
            {rows.length > GRAPH_MAX_NODES &&
              ` ${plural(rows.length - GRAPH_MAX_NODES, 'page')} with fewer links are not drawn.`}
          </p>
          <BrainGraph
            rows={rows}
            newPaths={newPaths}
            onOpen={open}
            focus={shown}
            matches={
              found ? new Set(found.map((i) => sky.stars[i].path)) : null
            }
            height={520}
          />
        </div>
      ) : (
        <>
          <div
            ref={host}
            className={`sky-scene${hovered === null ? '' : ' is-over'}`}
            role="application"
            aria-label="The brain as a sky of pages. Drag to turn, scroll to zoom, click a star to open its page. The panel lists the pages for the keyboard."
          />
          <div ref={labelBox} className="sky-labels" aria-hidden="true" />
        </>
      )}
      <div className="sky-top">
        <label className="sky-search">
          <input
            ref={searchBox}
            type="search"
            aria-label="Find a page"
            placeholder="Find a page"
            value={query}
            onChange={(e) => search(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && found?.length) {
                e.currentTarget.blur();
                open(sky.stars[found[0]].path);
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                if (query) setQuery('');
                else e.currentTarget.blur();
              }
            }}
          />
          {found && (
            <span className="sky-found small" role="status">
              {found.length} found
            </span>
          )}
        </label>
        {trail.length > 1 && (
          <nav className="sky-trail" aria-label="Trail">
            {trail.map((path) => (
              <button
                key={path}
                type="button"
                className="sky-trail-step"
                aria-current={path === shown ? 'true' : undefined}
                onClick={() => open(path)}
              >
                {title(path)}
              </button>
            ))}
          </nav>
        )}
      </div>
      <aside
        className="sky-panel"
        aria-label={nav.current ? 'Page' : 'The brain at a glance'}
      >
        {nav.current ? (
          <>
            <div className="sky-panel-page">
              <BrainPage
                brainId={brainId}
                path={nav.current.path}
                anchor={nav.current.anchor}
                rows={rows}
                sources={sources}
                canBack={nav.canBack}
                canForward={nav.canForward}
                onOpen={open}
                onBack={nav.back}
                onForward={nav.forward}
                jobs={jobs}
                skillsReady={skillsReady}
              />
            </div>
            <div className="sky-panel-foot">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onOpenInRead(nav.current!.path)}
              >
                Open in Read
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={nav.home}
              >
                Whole brain
              </button>
            </div>
          </>
        ) : (
          <div className="sky-glance">
            <div className="muted small">{brainName}</div>
            <h2>
              {plural(facts.pages, 'page')} in{' '}
              {plural(sky.clusters.length, 'cluster')}
            </h2>
            {hidden > 0 && (
              <p className="muted small">
                {plural(hidden, 'page')} with fewer links are not drawn.
              </p>
            )}
            <p className="muted">
              Each star is a page and each cluster a chapter, in the order of
              the book. Bigger is more linked, brighter is fresher. Click a star
              to fly to it and read it here.
            </p>
            <dl className="sky-facts">
              <dt>Links</dt>
              <dd>{facts.links}</dd>
              <dt>Changed in 14 days</dt>
              <dd>{facts.changed14}</dd>
              <dt>Untouched for 4 months</dt>
              <dd>{facts.untouched120}</dd>
            </dl>
            {fresh.length > 0 && (
              <>
                <h3 id="sky-new">New</h3>
                <ul aria-labelledby="sky-new">
                  {fresh.map((s) => (
                    <StarRow key={s.path} star={s} onOpen={open} />
                  ))}
                </ul>
              </>
            )}
            {byLinks.length > 0 && (
              <>
                <h3 id="sky-most">Most linked</h3>
                <ul aria-labelledby="sky-most">
                  {byLinks.map((s) => (
                    <StarRow key={s.path} star={s} onOpen={open} />
                  ))}
                </ul>
              </>
            )}
            <p className="muted small sky-keys">
              <kbd>/</kbd> find · <kbd>←</kbd> <kbd>→</kbd> pick a linked page ·{' '}
              <kbd>Enter</kbd> go · <kbd>Esc</kbd> back
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}
