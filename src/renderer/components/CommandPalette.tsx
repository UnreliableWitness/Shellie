import { Search16Regular } from '@fluentui/react-icons';
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { rank } from '../commands/match';
import { useAllCommands } from '../commands/registry';
import { shortcutLabel } from '../commands/shortcut';
import { type Command, GROUP_ORDER, GROUP_TITLE } from '../commands/types';
import { useStore } from '../store';
import { track } from '../telemetry';
import { modKey } from './ui';

/**
 * The palette while it is on screen. It is its own component so that following every store change
 * (`useAllCommands`) costs nothing while the palette is closed.
 */
function Palette() {
  const close = useStore((s) => s.setPaletteOpen);
  const commands = useAllCommands();
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => rank(query, commands), [query, commands]);
  // The list can shrink under the selection (a task finished, a tab closed).
  const selected = Math.min(at, shown.length - 1);
  const filtering = query.trim() !== '';

  // Focus goes back to where it was: the terminal, most of the time. Read while rendering, before the field takes it.
  const [before] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    track('palette.open');
    return () => before?.focus?.();
  }, [before]);

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [selected, shown]);

  const run = (command: Command | undefined) => {
    if (!command) return;
    close(false);
    command.run();
    track('palette.run', { command: command.id });
  };

  const onKey = (e: KeyboardEvent) => {
    // Nothing behind the palette may see its keys: not the terminal, not another shortcut.
    e.stopPropagation();
    const move = (to: number) => {
      e.preventDefault();
      if (shown.length) setAt((to + shown.length) % shown.length);
    };
    if (e.key === 'Escape') {
      e.preventDefault();
      close(false);
    } else if (e.key === 'ArrowDown') move(selected + 1);
    else if (e.key === 'ArrowUp') move(selected - 1);
    else if (e.key === 'Enter') {
      e.preventDefault();
      run(shown[selected]);
    }
  };

  const row = (command: Command) => {
    const i = shown.indexOf(command);
    return (
      <div
        key={command.id}
        id={`palette-${i}`}
        role="option"
        aria-selected={i === selected}
        className="palette-row"
        onMouseMove={() => setAt(i)}
        // The field keeps the focus, so the click is not lost to a blur.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => run(command)}
      >
        <span className="palette-title">{command.title}</span>
        {command.note ? (
          <span
            className={
              command.noteTone === 'accent'
                ? 'palette-note is-accent'
                : 'palette-note'
            }
          >
            {command.note}
          </span>
        ) : (
          command.shortcut && (
            <span className="palette-note mono">
              {shortcutLabel(command.shortcut, modKey)}
            </span>
          )
        )}
      </div>
    );
  };

  return (
    <div
      className="palette-backdrop"
      data-testid="palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close(false);
      }}
    >
      <div
        role="dialog"
        aria-label="Go to or run"
        aria-modal="true"
        className="palette"
        onKeyDown={onKey}
      >
        <div className="palette-field">
          <Search16Regular aria-hidden="true" />
          <input
            autoFocus
            type="text"
            role="combobox"
            aria-label="Go to or run"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={
              shown.length ? `palette-${selected}` : undefined
            }
            placeholder="Go to a place, a task, or run a command"
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setAt(0);
            }}
          />
        </div>
        <div
          ref={list}
          id="palette-list"
          role="listbox"
          aria-label="Commands"
          className="palette-list"
        >
          {shown.length === 0 && <div className="palette-empty">No match</div>}
          {filtering
            ? shown.map(row)
            : GROUP_ORDER.map((g) => {
                const group = shown.filter((c) => c.group === g);
                if (group.length === 0) return null;
                return (
                  <div key={g} role="group" aria-label={GROUP_TITLE[g]}>
                    <div className="palette-group" aria-hidden="true">
                      {GROUP_TITLE[g]}
                    </div>
                    {group.map(row)}
                  </div>
                );
              })}
        </div>
        <div className="palette-foot">
          Up and Down to move · Enter to open · Esc to close
        </div>
      </div>
    </div>
  );
}

/** The command palette: every place and action by typing. Mounted once; open is one piece of state. */
export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  return open ? <Palette /> : null;
}
