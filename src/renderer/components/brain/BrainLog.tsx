import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { useBrainChanged } from '../../hooks/useBrains';
import { MarkdownView } from '../docs/MarkdownView';

/** The brain's `log.md`, newest entry first as main writes it. */
export function BrainLog({ brainId }: { brainId: string }) {
  const [text, setText] = useState<string | null>(null);
  const load = useCallback(() => {
    api()
      .invoke('brain:read', brainId, 'log.md')
      .then(
        (r) => setText(r.text),
        () => setText(''),
      );
  }, [brainId]);
  useEffect(load, [load]);
  useBrainChanged(brainId, load);
  const asset = useCallback(
    (path: string) => api().invoke('brain:asset', brainId, path),
    [brainId],
  );
  if (text === null) return <p className="muted">Loading</p>;
  if (text.trim() === '') return <p className="muted">The log is empty.</p>;
  return (
    <div className="brain-doc">
      <MarkdownView
        asset={asset}
        path="log.md"
        text={text}
        onOpenDoc={() => undefined}
        onOpenFile={() => undefined}
      />
    </div>
  );
}
