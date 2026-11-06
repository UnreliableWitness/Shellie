import { ChevronDown12Regular, Shield16Regular } from '@fluentui/react-icons';
import {
  Fragment,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import {
  ENVIRONMENT_LABEL,
  ENVIRONMENTS,
  type Environment,
  type EnvironmentInfo,
  isGuarded,
} from '../../../shared/secrets';
import type { TaskView } from '../../../shared/types';
import { api, tryInvoke } from '../../api';
import { clock } from '../../format';
import { useStore } from '../../store';
import { joinAnd, tabNames, taskShortName } from './environment';

type Guarded = 'uat' | 'production';

/** Names in bold, joined as "a, b and c". */
function BoldList({ names }: { names: string[] }) {
  return (
    <>
      {names.map((n, i) => (
        <Fragment key={i}>
          {i > 0 && (i === names.length - 1 ? ' and ' : ', ')}
          <strong>{n}</strong>
        </Fragment>
      ))}
    </>
  );
}

/**
 * The confirm before every switch to UAT or Production (and before a task starts on one): where the values go,
 * for how long, the key names, and launch profiles whose own value wins over a stored one.
 */
export function EnvironmentConfirm({
  title,
  env,
  tabs,
  keys,
  overrides = [],
  minutes,
  busy = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  env: Guarded;
  /** How the tabs are named ("dev", "your shell"); empty: the tabs the developer opens. */
  tabs: string[];
  /** Null while unknown. */
  keys: string[] | null;
  overrides?: { profile: string; names: string[] }[];
  /** Null while unknown; the confirm stays disabled until the key names and the minutes are known. */
  minutes: number | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const id = useId();
  const label = ENVIRONMENT_LABEL[env];
  const where =
    tabs.length > 0 ? <BoldList names={tabs} /> : 'the tabs you open';
  return (
    <div
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      className={`env-confirm env-confirm-${env}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <h3 id={`${id}-title`} className="env-confirm-title">
        {title}
      </h3>
      <p id={`${id}-body`} className="env-confirm-body">
        {env === 'production' ? (
          <>
            These go into {where} for {minutes ?? '...'} minutes, then Shellie
            stops those tabs and switches back to Development.
          </>
        ) : (
          <>
            These go into {where} until you switch back. Agent tabs never get
            them.
          </>
        )}
      </p>
      <p className="mono env-confirm-keys">
        {keys === null
          ? '...'
          : keys.length > 0
            ? keys.join(' · ')
            : `No values stored for ${label}.`}
      </p>
      {overrides.map((o) => (
        <p key={o.profile} className="small text-warn env-confirm-override">
          {`launchSettings profile ${o.profile} sets ${o.names.join(', ')}; the profile's value wins`}
        </p>
      ))}
      <div className="env-confirm-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <span className="spacer" />
        <button
          type="button"
          className={`btn env-confirm-go env-confirm-go-${env}`}
          disabled={busy || keys === null || minutes === null}
          onClick={onConfirm}
        >
          {env === 'production'
            ? `Use Production for ${minutes ?? '...'} min`
            : 'Use UAT'}
        </button>
      </div>
    </div>
  );
}

/**
 * The task bar's "⛨ <Environment> ▾" chip: a menu of the four environments with the gaps in each, then a switch.
 * UAT and Production first show the confirm; agent tabs are never restarted.
 */
export function EnvironmentChip({ task }: { task: TaskView }) {
  const notify = useStore((s) => s.notify);
  const [at, setAt] = useState<{ right: number; top: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [asking, setAsking] = useState<Guarded | null>(null);
  const [info, setInfo] = useState<EnvironmentInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const env = task.environment;
  const label = ENVIRONMENT_LABEL[env];

  const close = (refocus: boolean) => {
    setMenuOpen(false);
    setAsking(null);
    setAt(null);
    if (refocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!at) return;
    // The confirm focuses Cancel, so a stray Enter never switches.
    const first = pop.current?.querySelector<HTMLElement>(
      menuOpen ? '[role="menuitemradio"]' : 'button',
    );
    first?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !trigger.current?.contains(t))
        close(false);
    };
    const onResize = () => close(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onResize);
    };
  }, [at, menuOpen, asking]);

  const open = () => {
    if (at) return close(false);
    const r = trigger.current?.getBoundingClientRect();
    setAt({
      right: r ? window.innerWidth - r.right : 8,
      top: r ? r.bottom + 2 : 40,
    });
    setMenuOpen(true);
    void tryInvoke(
      () => api().invoke('tasks:environmentInfo', task.id),
      notify,
    ).then((i) => {
      if (i) setInfo(i);
    });
  };

  const switchTo = async (next: Environment, confirmed: boolean) => {
    setBusy(true);
    await tryInvoke(
      () =>
        confirmed
          ? api().invoke('tasks:setEnvironment', task.id, next, true)
          : api().invoke('tasks:setEnvironment', task.id, next),
      notify,
    );
    setBusy(false);
    close(true);
  };

  const choose = (next: Environment) => {
    if (isGuarded(next)) {
      setMenuOpen(false);
      setAsking(next as Guarded);
      return;
    }
    if (next === env) return close(true);
    void switchTo(next, false);
  };

  const onMenuKey = (e: KeyboardEvent) => {
    const items = [
      ...(pop.current?.querySelectorAll<HTMLElement>(
        '[role="menuitemradio"]',
      ) ?? []),
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
    else if (e.key === 'Tab') close(false);
  };

  const names = info ? tabNames(info.tabs) : [];

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`btn btn-sm env-chip env-chip-${env}`}
        aria-label={`Secrets environment: ${label}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Which environment's secrets this task's tabs get"
        disabled={task.status !== 'ready' || busy}
        onClick={open}
      >
        <Shield16Regular aria-hidden="true" />
        {label}
        <ChevronDown12Regular aria-hidden="true" />
      </button>
      {at && menuOpen && (
        <div
          ref={pop}
          role="menu"
          aria-label="Secrets for this task"
          className="menu env-menu"
          style={{ right: at.right, top: at.top }}
          onKeyDown={onMenuKey}
        >
          <div className="env-menu-title small muted" aria-hidden="true">
            Secrets for this task
          </div>
          {ENVIRONMENTS.map((e) => {
            const v = info?.values[e];
            const gap = v && v.of > 0 && v.have < v.of;
            const until =
              e === 'production' &&
              env === 'production' &&
              task.environmentUntil
                ? clock(task.environmentUntil)
                : null;
            return (
              <button
                key={e}
                type="button"
                role="menuitemradio"
                aria-checked={e === env}
                tabIndex={-1}
                className={`menu-item env-menu-item env-menu-item-${e}`}
                onClick={() => choose(e)}
              >
                <span>
                  {ENVIRONMENT_LABEL[e]}
                  {gap && (
                    <span className="muted">{` · ${v.have} of ${v.of} values`}</span>
                  )}
                  {until && (
                    <span className="muted">{` · until ${until}`}</span>
                  )}
                </span>
              </button>
            );
          })}
          {info && (
            <div className="env-menu-note small muted">
              {names.length > 0
                ? `Restarts ${joinAnd(names)}; agent tabs keep running`
                : 'Tabs you open get the new values; agent tabs never do'}
            </div>
          )}
        </div>
      )}
      {at && asking && (
        <div
          ref={pop}
          className="env-confirm-pop"
          style={{ right: at.right, top: at.top }}
        >
          <EnvironmentConfirm
            title={`Switch ${taskShortName(task)} to ${ENVIRONMENT_LABEL[asking]}?`}
            env={asking}
            tabs={names}
            keys={info ? info.keys[asking] : null}
            overrides={info?.overrides[asking] ?? []}
            minutes={info?.productionMinutes ?? null}
            busy={busy}
            onCancel={() => close(true)}
            onConfirm={() => void switchTo(asking, true)}
          />
        </div>
      )}
    </>
  );
}
