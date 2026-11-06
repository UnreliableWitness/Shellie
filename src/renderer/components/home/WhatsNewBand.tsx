import { useEffect, useState } from 'react';
import type { WhatsNew } from '../../../shared/ipc';
import { api, saveSettings, tryInvoke } from '../../api';
import { useStore } from '../../store';
import { track } from '../../telemetry';

/** Short notes shown at most; the rest are on GitHub. */
const MAX_NOTES = 8;

/**
 * Home's What's new card after an update (#126): the PR titles of the releases installed since the card was last
 * dismissed, with the full notes on GitHub. Stays until dismissed.
 */
export function WhatsNewBand() {
  const notify = useStore((s) => s.notify);
  const [card, setCard] = useState<WhatsNew | null>(null);

  useEffect(() => {
    let live = true;
    void api()
      .invoke('app:whatsNew')
      .then((c) => {
        if (!live || !c) return;
        setCard(c);
        track('whatsNew.shown', {
          releases: c.releases.length,
          fetched: c.fetched,
        });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (!card) return null;

  const dismiss = async () => {
    const saved = await tryInvoke(
      () => saveSettings({ whatsNewSeen: card.version }),
      notify,
    );
    if (!saved) return;
    track('whatsNew.dismissed');
    setCard(null);
  };
  const open = () => {
    track('whatsNew.opened');
    void tryInvoke(() => api().invoke('shell:openExternal', card.url), notify);
  };

  const several = card.releases.length > 1;
  let left = MAX_NOTES;
  const shown = card.releases.map((r) => {
    const items = r.items.slice(0, Math.max(left, 0));
    left -= items.length;
    return { ...r, items };
  });
  const total = card.releases.reduce((n, r) => n + r.items.length, 0);
  const hidden = total - Math.min(total, MAX_NOTES);

  return (
    <section aria-label="What's new" className="home-band whats-new-band">
      <div className="section-head">
        <h2 className="home-band-title">
          What's new in Shellie {card.version}
        </h2>
        <button type="button" className="link" onClick={() => void dismiss()}>
          Dismiss
        </button>
      </div>
      {total === 0 ? (
        <p className="muted small">
          Shellie was updated to {card.version}.{' '}
          {card.fetched
            ? 'This release has no notes here.'
            : 'The notes could not be loaded.'}
        </p>
      ) : (
        shown
          .filter((r) => r.items.length > 0)
          .map((r) => (
            <div key={r.version} className="whats-new-release">
              {several && <div className="muted small">{r.version}</div>}
              <ul className="whats-new-list">
                {r.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          ))
      )}
      <div className="whats-new-foot">
        {hidden > 0 && <span className="muted small">and {hidden} more</span>}
        <button type="button" className="link" onClick={open}>
          Release notes on GitHub
        </button>
      </div>
    </section>
  );
}
