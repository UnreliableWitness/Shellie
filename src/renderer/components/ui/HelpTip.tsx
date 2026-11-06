// src/renderer/components/ui/HelpTip.tsx
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

const POP_WIDTH = 320;
const CLOSE_DELAY_MS = 120;

/**
 * A small `?` button that explains something in a popover. Opens on hover, focus and
 * click; closes on leave, blur and Escape. It is its own button, so it can sit next to
 * another button without nesting.
 */
export function HelpTip({
  label,
  children,
  onOpen,
}: {
  label: string;
  children: ReactNode;
  /** Fires once each time the popover opens. */
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const timer = useRef<number>(0);
  const id = useId();
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  // Mirrors `open` synchronously so one opening never fires onOpen twice.
  const openRef = useRef(false);
  const close = useCallback(() => {
    openRef.current = false;
    setOpen(false);
  }, []);

  const show = useCallback(() => {
    window.clearTimeout(timer.current);
    if (!openRef.current) {
      openRef.current = true;
      setOpen(true);
      onOpenRef.current?.();
    }
  }, []);
  // Leaving the button for the popover must not flicker it shut, hence the short delay.
  const hideSoon = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => close(), CLOSE_DELAY_MS);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Focus first: focusing the button opens the tip, so close last.
      btn.current?.focus();
      close();
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  const r = open ? btn.current?.getBoundingClientRect() : undefined;
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="helptip"
        aria-label={`Help: ${label}`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={(e) => {
          e.stopPropagation();
          show();
        }}
        onMouseEnter={show}
        onMouseLeave={hideSoon}
        onFocus={show}
        onBlur={(e) => {
          if (!pop.current?.contains(e.relatedTarget as Node | null)) close();
        }}
      >
        ?
      </button>
      {open &&
        r &&
        createPortal(
          <div
            ref={pop}
            id={id}
            role="tooltip"
            className="helptip-pop"
            style={{
              left: Math.max(
                4,
                Math.min(r.left, window.innerWidth - POP_WIDTH - 4),
              ),
              top: r.bottom + 4,
            }}
            onMouseEnter={show}
            onMouseLeave={hideSoon}
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
