import { type ReactNode, useState } from 'react';
import {
  bookReady,
  writeReady,
  type BrainOptions,
  type BrainView,
} from '../../../shared/brain';
import { plural } from '../../../shared/text';
import { api, tryInvoke } from '../../api';
import { eur } from '../../format';
import { useStore } from '../../store';
import { trackBrain } from './brainActions';

type Switchable = Extract<
  keyof BrainOptions,
  'syncAfterRefresh' | 'weeklyDigest' | 'writeLongReads'
>;

/** One line of the card: what runs, its tag, and when (or a switch). */
function Row({
  label,
  tag,
  children,
}: {
  label: string;
  tag?: 'auto' | 'on' | 'off' | 'running';
  children: ReactNode;
}) {
  return (
    <li className="brain-auto-row">
      <span>{label}</span>
      {tag && (
        <span
          className={
            tag === 'off'
              ? 'tag tag-warn'
              : tag === 'running'
                ? 'tag tag-muted'
                : 'tag tag-green'
          }
        >
          {tag}
        </span>
      )}
      <span className="brain-auto-value small muted">{children}</span>
    </li>
  );
}

/** What runs without a click, each line matching what the code does; the optional runs switch in place. */
export function AutoRuns({ brain }: { brain: BrainView }) {
  const notify = useStore((s) => s.notify);
  const [busy, setBusy] = useState(false);
  const h = brain.health;
  const o = brain.options;
  const pass = brain.picturePass;

  const toggle = async (key: Switchable, value: boolean) => {
    trackBrain('option');
    setBusy(true);
    await tryInvoke(
      () =>
        api().invoke('brain:update', brain.id, { options: { [key]: value } }),
      notify,
    );
    setBusy(false);
  };
  const resume = () => {
    trackBrain('resume');
    void tryInvoke(() => api().invoke('brain:resumeQueue', brain.id), notify);
  };
  const toggleRow = (key: Switchable, label: string) => (
    <Row label={label} tag={o[key] ? 'on' : 'off'}>
      <label className="switch">
        <input
          type="checkbox"
          role="switch"
          aria-label={label}
          checked={o[key]}
          disabled={busy}
          onChange={(e) => void toggle(key, e.target.checked)}
        />
      </label>
    </Row>
  );

  return (
    <section className="brain-card" aria-labelledby="brain-auto-h">
      <h2 id="brain-auto-h">What runs by itself</h2>
      <ul className="brain-auto">
        <Row label="Capture after you add" tag="auto">
          always
        </Row>
        <Row label="Lint after each capture" tag="auto">
          after each successful capture
        </Row>
        {brain.wiki && (
          <Row label="Refresh the DevOps wiki" tag="auto">
            when older than a day, while Shellie is open
            {o.contextInTaskMd && ' · at task start'}
          </Row>
        )}
        {brain.wiki && toggleRow('syncAfterRefresh', 'Sync after a refresh')}
        {toggleRow('weeklyDigest', 'Weekly digest')}
        {pass && pass.finishedAt === null && pass.total > 0 && (
          <Row label="Picture check for earlier sources" tag="running">
            {plural(pass.total, 'source')} captured before Shellie checked
            pictures. Re-evaluating them in the background, {pass.done.length}{' '}
            of {pass.total} done.
          </Row>
        )}
        {bookReady(brain) && (
          <Row label="Arrange the brain as a book" tag="auto">
            once, in the background, when a brain has pages and no book yet
          </Row>
        )}
        {writeReady(brain) && toggleRow('writeLongReads', 'Write long reads')}
        <Row label="Daily token cap">
          {h
            ? `${h.tokensToday.toLocaleString('en-US')} of ${o.dailyTokenCap.toLocaleString('en-US')} tokens · ${eur(h.costEurToday)} today`
            : `${o.dailyTokenCap.toLocaleString('en-US')} tokens`}
          {h?.queuePaused === 'cap' && (
            <>
              {' '}
              <span className="tag tag-warn">paused</span>{' '}
              <button type="button" className="btn btn-sm" onClick={resume}>
                Resume
              </button>
            </>
          )}
        </Row>
      </ul>
    </section>
  );
}
