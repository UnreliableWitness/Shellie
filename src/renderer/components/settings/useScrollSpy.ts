import { type RefObject, useEffect, useState } from 'react';

/**
 * The id of the last element (by position) whose top has scrolled to the container's top.
 * Binds again and recomputes whenever `ids` or `refresh` change (e.g. the search query or the
 * scope), so a container that was not mounted yet, or content that was filtered, is picked up.
 */
export function useScrollSpy(
  container: RefObject<HTMLElement | null>,
  ids: string[],
  refresh?: unknown,
): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  const key = ids.join('|');
  const el = container.current;
  useEffect(() => {
    const target = container.current;
    const list = key ? key.split('|') : [];
    if (!target) {
      setActive(list[0] ?? null);
      return;
    }
    const update = () => {
      const top = target.getBoundingClientRect().top;
      let current: string | null = list[0] ?? null;
      for (const id of list) {
        const node = target.querySelector<HTMLElement>(`[id="${id}"]`);
        if (!node || node.closest('[hidden]')) continue;
        if (node.getBoundingClientRect().top - top <= 16) current = id;
      }
      setActive(current);
    };
    update();
    target.addEventListener('scroll', update, { passive: true });
    return () => target.removeEventListener('scroll', update);
  }, [container, key, refresh, el]);
  return active;
}
