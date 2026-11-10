import { useState } from 'react';
import { local } from '../../localStorage';

const HIDDEN_KEY = 'shellie.brain.howto.hidden';

export const STEPS: { title: string; text: string }[] = [
  {
    title: '1 · You add',
    text: 'Drop a file or paste text. It is stored untouched under sources/.',
  },
  {
    title: '2 · Capture (auto)',
    text: 'The agent reads the source and writes or updates wiki pages.',
  },
  {
    title: '3 · Lint (auto)',
    text: 'After each successful capture: checks for broken links, contradictions and gaps.',
  },
  { title: '4 · Read', text: 'New and changed pages get a blue dot in Read.' },
];

const readHidden = (): boolean => {
  try {
    return local()?.getItem(HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
};

const writeHidden = (hidden: boolean) => {
  try {
    if (hidden) local()?.setItem(HIDDEN_KEY, '1');
    else local()?.removeItem(HIDDEN_KEY);
  } catch {
    // Only a convenience: the strip shows again next time.
  }
};

/** The four steps from adding a source to reading its pages; Hide collapses it to one button, remembered for every brain. */
export function HowItWorks() {
  const [hidden, setHidden] = useState(readHidden);
  const toggle = (next: boolean) => {
    writeHidden(next);
    setHidden(next);
  };
  if (hidden)
    return (
      <button
        type="button"
        className="link small brain-howto-show"
        onClick={() => toggle(false)}
      >
        How it works
      </button>
    );
  return (
    <section className="brain-card" aria-labelledby="brain-howto-h">
      <div className="brain-card-head">
        <h2 id="brain-howto-h">How it works</h2>
        <button
          type="button"
          className="link small brain-card-action"
          onClick={() => toggle(true)}
        >
          Hide
        </button>
      </div>
      <ol className="brain-howto">
        {STEPS.map((s) => (
          <li key={s.title}>
            <strong>{s.title}</strong>
            <span className="muted small">{s.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
