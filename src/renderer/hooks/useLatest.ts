import { useEffect, useRef } from 'react';

/**
 * A ref that always holds the value of the last render. For a callback that outlives the render it was made in (a
 * command offered to the palette, a listener set up once): it calls the current function, not the one it closed over.
 */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}
