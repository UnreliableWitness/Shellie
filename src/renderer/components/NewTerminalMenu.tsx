import { Add16Regular } from '@fluentui/react-icons';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { RepoMark } from './RepoMark';
import type { NewTerminal } from '../../shared/types';

/** What the + menu can open; the shell is named after the platform's shell by main. */
const NEW_TERMINALS: {
  def: NewTerminal;
  title: string;
  note?: string;
}[] = [
  { def: { kind: 'claude', label: 'Claude Code' }, title: 'Claude Code' },
  { def: { kind: 'shell', label: 'shell' }, title: 'Shell' },
  { def: { kind: 'copilot', label: 'Copilot CLI' }, title: 'Copilot CLI' },
  { def: { kind: 'opencode', label: 'OpenCode' }, title: 'OpenCode' },
];

/**
 * The + button of the terminal row: a menu of terminal types. It is fixed-positioned under the button,
 * because the tab row clips its overflow.
 */
export function NewTerminalMenu({
  disabled,
  workspaces = [],
  brain,
  onOpen,
  onOpenBrain,
}: {
  disabled?: boolean;
  /** With more than one, choosing a terminal type asks for the repo to open it in. */
  workspaces?: { id: string; name: string; color?: number | null }[];
  onOpen: (def: NewTerminal) => void;
  /** The task's brain: adds a "Brain terminal" entry, which runs in the brain folder and is not a task terminal. */
  brain?: { id: string; name: string };
  onOpenBrain?: () => void;
}) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const [choosing, setChoosing] = useState<NewTerminal | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = (refocus: boolean) => {
    setAt(null);
    setChoosing(null);
    if (refocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!at) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !trigger.current?.contains(t))
        setAt(null);
    };
    const onResize = () => setAt(null);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onResize);
    };
  }, [at, choosing]);

  const onKey = (e: KeyboardEvent) => {
    const items = [
      ...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
        []),
    ];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      e.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    };
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'ArrowDown') move(i + 1);
    else if (e.key === 'ArrowUp') move(i < 0 ? -1 : i - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(-1);
    else if (e.key === 'Tab') setAt(null);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="btn btn-subtle btn-sm tab-add"
        aria-label="New terminal"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        title="New terminal"
        disabled={disabled}
        onClick={() => {
          if (at) return close(false);
          setChoosing(null);
          const r = trigger.current?.getBoundingClientRect();
          if (r) setAt({ left: r.left, top: r.bottom + 2 });
        }}
      >
        <Add16Regular />
      </button>
      {at && (
        <div
          ref={menu}
          role="menu"
          aria-label="New terminal"
          className="menu terminal-menu"
          style={{ left: at.left, top: at.top }}
          onKeyDown={onKey}
        >
          {choosing &&
            workspaces.map((w) => (
              <button
                key={w.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="menu-item"
                onClick={() => {
                  close(false);
                  onOpen({ ...choosing, workspaceId: w.id });
                }}
              >
                <span className="menu-title">
                  <RepoMark color={w.color ?? null} />
                  {w.name}
                </span>
              </button>
            ))}
          {!choosing &&
            NEW_TERMINALS.map((t) => (
              <button
                key={t.def.kind}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="menu-item"
                onClick={() => {
                  if (workspaces.length > 1) return setChoosing(t.def);
                  close(false);
                  onOpen(t.def);
                }}
              >
                <span className="menu-title">{t.title}</span>
                {t.note && <span className="small muted">{t.note}</span>}
              </button>
            ))}
          {!choosing && brain && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="menu-item"
              onClick={() => {
                close(false);
                onOpenBrain?.();
              }}
            >
              <span className="menu-title">Brain terminal</span>
              <span className="small muted">{brain.name}</span>
            </button>
          )}
        </div>
      )}
    </>
  );
}
