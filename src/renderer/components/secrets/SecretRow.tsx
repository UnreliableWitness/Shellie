import { Eye16Regular, MoreHorizontal16Regular } from '@fluentui/react-icons';
import { Fragment, useRef, useState } from 'react';
import {
  ENVIRONMENTS,
  type Environment,
  ENVIRONMENT_LABEL,
  type GivenTo,
  type SecretView,
  UNREADABLE_MASK,
} from '../../../shared/secrets';
import { api, tryInvoke } from '../../api';
import { useStore } from '../../store';
import { PopupMenu } from '../ui';

export const GIVEN_LABEL: Record<GivenTo, string> = {
  setup: 'Setup',
  run: 'Dev server',
  tests: 'Tests',
  shell: 'Your shell',
};
export const GIVEN_ORDER: GivenTo[] = ['setup', 'run', 'tests', 'shell'];

/** A name cut after each run of underscores, where a narrow column may break it (`ConnectionStrings__` `Db`). */
export function nameParts(name: string): string[] {
  return name.match(/[^_]*_+|[^_]+$/g) ?? [name];
}

/** "3 days ago" within a week, else "12 Oct". */
function changedLabel(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const days = Math.floor((now - t) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 7) return days === 1 ? 'yesterday' : `${days} days ago`;
  return new Date(t).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  });
}

/**
 * One secret: a mask and its source per environment, the tabs that get it, and when it changed. The plain value is
 * held in this row's state only while the eye is pressed, and cleared on release, leave and blur.
 */
export function SecretRow({
  secret,
  allRepos,
  onAdd,
  onEdit,
  onMove,
  onDelete,
}: {
  secret: SecretView;
  /** Tag the row as applying to every repository (shown while a repo is selected). */
  allRepos: boolean;
  onAdd: (env: Environment) => void;
  onEdit: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  const notify = useStore((s) => s.notify);
  const [shown, setShown] = useState<{
    env: Environment;
    value: string;
  } | null>(null);
  // The press that is current; a late answer to an older press is dropped.
  const press = useRef(0);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  const hold = async (env: Environment) => {
    const mine = ++press.current;
    const value = await tryInvoke(
      () => api().invoke('secrets:reveal', secret.id, env),
      notify,
    );
    if (value !== undefined && press.current === mine) setShown({ env, value });
  };
  const release = () => {
    press.current++;
    setShown(null);
  };

  const changed = ENVIRONMENTS.flatMap((e) => secret.values[e]?.changedAt ?? [])
    .sort()
    .at(-1);

  return (
    <tr>
      <td className="secret-name">
        <code>
          {nameParts(secret.name).map((part, i) => (
            <Fragment key={i}>
              {i > 0 && <wbr />}
              {part}
            </Fragment>
          ))}
        </code>
        {allRepos && <span className="secret-tag">all repos</span>}
      </td>
      {ENVIRONMENTS.map((env) => {
        const v = secret.values[env];
        if (!v)
          return (
            <td key={env}>
              <button
                type="button"
                className="secret-add"
                aria-label={`Add ${secret.name} ${ENVIRONMENT_LABEL[env]} value`}
                onClick={() => onAdd(env)}
              >
                add
              </button>
            </td>
          );
        const unreadable = v.mask === UNREADABLE_MASK;
        return (
          <td key={env} className={unreadable ? 'secret-bad' : undefined}>
            <div className="secret-value">
              {shown?.env === env ? (
                <code>{shown.value}</code>
              ) : (
                <code className="secret-mask">{v.mask}</code>
              )}
              {!unreadable && (
                <button
                  type="button"
                  className="ibtn secret-eye"
                  aria-label={`Hold to reveal ${secret.name} ${ENVIRONMENT_LABEL[env]}`}
                  title="Hold to reveal"
                  onPointerDown={() => void hold(env)}
                  onPointerUp={release}
                  onPointerLeave={release}
                  onPointerCancel={release}
                  onBlur={release}
                  onKeyDown={(e) => {
                    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
                      e.preventDefault();
                      void hold(env);
                    }
                  }}
                  onKeyUp={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') release();
                  }}
                >
                  <Eye16Regular />
                </button>
              )}
            </div>
            {v.source && <div className="secret-source">{v.source}</div>}
          </td>
        );
      })}
      <td>
        <div className="secret-chips">
          {GIVEN_ORDER.filter((g) => secret.givenTo.includes(g)).map((g) => (
            <span key={g} className="secret-chip">
              {GIVEN_LABEL[g]}
            </span>
          ))}
          <span
            className="secret-chip struck"
            title="Agent tabs never get secrets"
          >
            Agents
          </span>
        </div>
      </td>
      <td className="secret-changed">{changed ? changedLabel(changed) : ''}</td>
      <td>
        <button
          type="button"
          className="ibtn"
          aria-label={`Actions for ${secret.name}`}
          aria-haspopup="menu"
          onClick={(e) => setMenuAnchor(menuAnchor ? null : e.currentTarget)}
        >
          <MoreHorizontal16Regular />
        </button>
        <PopupMenu
          label={`${secret.name} actions`}
          anchor={menuAnchor}
          open={menuAnchor !== null}
          onClose={() => setMenuAnchor(null)}
        >
          {(
            [
              ['Edit', onEdit],
              ...(secret.scope === 'all'
                ? []
                : [['Move to All repositories', onMove] as const]),
              ['Delete', onDelete],
            ] as const
          ).map(([label, run]) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setMenuAnchor(null);
                run();
              }}
            >
              <span className="menu-title">{label}</span>
            </button>
          ))}
        </PopupMenu>
      </td>
    </tr>
  );
}
