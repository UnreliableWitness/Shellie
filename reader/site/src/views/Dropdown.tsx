import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export type DropdownItem = {
  label: string;
  /** Marks the one that is chosen now (a brain). */
  current?: boolean;
  onSelect: () => void;
};

/** A button that opens a short list of actions under it. Closes on a choice, Escape, or a tap elsewhere. */
export function Dropdown({
  label,
  children,
  items,
  className = '',
}: {
  /** The button's accessible name. */
  label: string;
  /** What the button shows. */
  children: ReactNode;
  items: DropdownItem[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={`dropdown ${className}`} ref={root}>
      <button
        type="button"
        ref={button}
        className="bar-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {children}
      </button>
      {open && (
        <div className="dropdown-list" id={id} role="menu" aria-label={label}>
          {items.map((item, i) => (
            <button
              key={i}
              type="button"
              role="menuitem"
              aria-current={item.current ? 'true' : undefined}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
