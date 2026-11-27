import { useEffect, useMemo, useRef, useState } from 'react';
import type { BrainBook, BrainPageRow } from '../../../../shared/brain';
import { plural } from '../../../../shared/text';
import type { SkyScene } from './SkyScene';
import { skyFacts, skyLayout } from './skyLayout';
import { skyTheme } from './skyTheme';
import { useColorScheme } from '../../../colorScheme';

type SceneModule = { SkyScene: typeof SkyScene };
const loadSkyScene = (): Promise<SceneModule> => import('./SkyScene');
const NOTHING = () => undefined;

/**
 * The brain's sky as a window on the Read view's front page: the same stars as Explore, drifting, not steered. A
 * click anywhere on it opens Explore. Without graphics the window stays dark and still opens Explore (which then
 * shows its flat map).
 */
export function SkyPreview({
  rows,
  book,
  newPaths,
  active,
  onExplore,
  loadScene = loadSkyScene,
}: {
  rows: BrainPageRow[];
  book: BrainBook | null;
  newPaths: ReadonlySet<string>;
  /** Whether the Read view is in front: the sky draws only then. */
  active: boolean;
  onExplore: () => void;
  /** Tests pass a scene that draws nothing. */
  loadScene?: () => Promise<SceneModule>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<SkyScene | null>(null);
  const sky = useMemo(
    () => skyLayout(rows, book, newPaths, Date.now()),
    [rows, book, newPaths],
  );
  const facts = skyFacts(sky);

  useEffect(() => {
    let gone = false;
    let made: SkyScene | null = null;
    loadScene().then(
      ({ SkyScene: Scene }) => {
        if (gone || !host.current) return;
        try {
          made = new Scene(
            host.current,
            {
              onPick: NOTHING,
              onHover: NOTHING,
              onLabels: NOTHING,
              onLost: () => {
                made?.dispose();
                made = null;
                setScene(null);
              },
            },
            {
              reducedMotion:
                typeof window.matchMedia === 'function' &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches,
              theme: skyTheme(host.current),
            },
          );
          setScene(made);
        } catch {
          // No graphics: the dark window alone.
        }
      },
      () => undefined,
    );
    return () => {
      gone = true;
      made?.dispose();
    };
  }, [loadScene]);
  useEffect(() => scene?.setRunning(active), [scene, active]);
  // The sky follows the app's theme, also when it changes while the page is open.
  const scheme = useColorScheme();
  useEffect(() => scene?.setTheme(skyTheme(host.current)), [scene, scheme]);
  const first = useRef(true);
  useEffect(() => {
    if (!scene || rows.length === 0) return;
    scene.setSky(sky, first.current ? undefined : { camera: true });
    first.current = false;
  }, [scene, sky, rows.length]);

  if (rows.length === 0) return null;
  return (
    <div className="sky-preview">
      <div className="small">
        <b>{plural(facts.pages, 'page')}</b> · {plural(facts.links, 'link')}
      </div>
      <button
        type="button"
        className="sky-preview-box"
        aria-label="Explore the brain"
        onClick={onExplore}
      >
        {/* The scene's own pointer handling is off here: the window is one button. */}
        <div ref={host} className="sky-preview-scene" aria-hidden="true" />
        <span className="sky-preview-cue">Explore ›</span>
      </button>
    </div>
  );
}
