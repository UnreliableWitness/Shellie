import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { loadPlaces, savePlace } from './local';
import { scrollToAnchor } from './Markdown';

/** How far the page can scroll. */
const room = () => document.documentElement.scrollHeight - window.innerHeight;

/**
 * The place in a text: the fraction of it that scrolled past, kept on this phone per item. When the text is shown
 * (`ready`) the page goes to `anchor`, else back to the kept place (`resume`), else to the top. Returns the place.
 */
export function usePlace(
  id: string,
  ready: boolean,
  { resume, anchor }: { resume: boolean; anchor?: string },
): number {
  const [fraction, setFraction] = useState(() => loadPlaces()[id] ?? 0);
  const start = useRef({ resume, anchor, fraction });

  // The text is not there yet: the list's scroll position means nothing here.
  useLayoutEffect(() => {
    if (!ready) window.scrollTo(0, 0);
  }, [id, ready]);

  useLayoutEffect(() => {
    if (!ready) return;
    const from = start.current;
    if (from.anchor) scrollToAnchor('', from.anchor);
    else window.scrollTo(0, from.resume ? from.fraction * room() : 0);
  }, [id, ready]);

  useEffect(() => {
    if (!ready) return;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest: number | null = null;
    const save = () => {
      clearTimeout(timer);
      timer = undefined;
      if (latest !== null) savePlace(id, latest);
      latest = null;
    };
    const measure = () => {
      frame = 0;
      const max = room();
      // A text that fits the screen has no place to keep.
      if (max <= 0) return;
      latest = Math.min(1, Math.max(0, window.scrollY / max));
      setFraction(latest);
      timer ??= setTimeout(save, 400);
    };
    const onScroll = () => {
      frame ||= requestAnimationFrame(measure);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', save);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pagehide', save);
      cancelAnimationFrame(frame);
      save();
    };
  }, [id, ready]);

  return fraction;
}
