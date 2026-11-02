import { type RefObject, useEffect, useState } from 'react';

/** The id of the last element (by position) whose top has scrolled to the container's top. */
export function useScrollSpy(
  container: RefObject<HTMLElement | null>,
  ids: string[],
): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  const key = ids.join('|');
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const list = key ? key.split('|') : [];
    const update = () => {
      const top = el.getBoundingClientRect().top;
      let current: string | null = list[0] ?? null;
      for (const id of list) {
        const target = el.querySelector<HTMLElement>(`[id="${id}"]`);
        if (target && target.getBoundingClientRect().top - top <= 16)
          current = id;
      }
      setActive(current);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    return () => el.removeEventListener('scroll', update);
  }, [container, key]);
  return active;
}
