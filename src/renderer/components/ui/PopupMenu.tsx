// src/renderer/components/ui/PopupMenu.tsx
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/** A menu under an anchor button: outside click and Escape close it, arrows move between items. */
export function PopupMenu({
  label,
  anchor,
  open,
  onClose,
  align = 'end',
  children,
}: {
  label: string;
  /** Which edge of the anchor the menu lines up with. */
  align?: 'start' | 'end';
  anchor: HTMLElement | SVGElement | null;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const item = '[role^="menuitem"]:not(:disabled)';
    (
      ref.current?.querySelector<HTMLElement>(`${item}[aria-checked="true"]`) ??
      ref.current?.querySelector<HTMLElement>(item)
    )?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor?.contains(t)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onClose);
    };
  }, [open, anchor, onClose]);
  if (!open || !anchor) return null;
  const r = anchor.getBoundingClientRect();
  const onKey = (e: KeyboardEvent) => {
    const items = [
      ...(ref.current?.querySelectorAll<HTMLElement>(
        '[role^="menuitem"]:not(:disabled)',
      ) ?? []),
    ];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      e.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    };
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      anchor.focus();
    } else if (e.key === 'ArrowDown') move(i + 1);
    else if (e.key === 'ArrowUp') move(i < 0 ? -1 : i - 1);
    else if (e.key === 'Tab') onClose();
  };
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="menu popup-menu"
      style={{
        left: Math.max(
          4,
          align === 'start'
            ? Math.min(r.left, window.innerWidth - 244)
            : r.right - 240,
        ),
        top: r.bottom + 2,
      }}
      onKeyDown={onKey}
    >
      {children}
    </div>,
    document.body,
  );
}
