import { useEffect, useState } from 'react';
import type { BrainView } from '../../../../shared/brain';
import { api } from '../../../api';

const CLAUDE: { id: string; label: string }[] = [
  { id: 'haiku', label: 'Haiku' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus' },
];

const DEFAULT = '';

/** The model name a Capture with value shows (Activity rows too): Opus, or an OpenCode `provider/model` as is. */
export const modelLabel = (model: string) =>
  CLAUDE.find((m) => m.id === model)?.label ?? model;

/**
 * Capture with: the model for this one add. The brain's own model is listed first-class as "(brain default)" and
 * stands for null; for an OpenCode brain the models `opencode models` lists.
 */
export function ModelPicker({
  brain,
  value,
  onChange,
  disabled,
}: {
  brain: BrainView;
  value: string | null;
  onChange(model: string | null): void;
  disabled?: boolean;
}) {
  const opencode = brain.options.agent === 'opencode';
  const [listed, setListed] = useState<string[]>([]);
  useEffect(() => {
    if (!opencode) return;
    let live = true;
    api()
      .invoke('agents:opencodeModels')
      .then(
        (m) => live && setListed(m ?? []),
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [opencode]);

  const own = opencode ? brain.options.opencodeModel : brain.options.model;
  const options = opencode
    ? [
        {
          id: DEFAULT,
          label: own
            ? `${own} (brain default)`
            : 'OpenCode default (brain default)',
        },
        ...listed.filter((m) => m !== own).map((m) => ({ id: m, label: m })),
      ]
    : [
        {
          id: DEFAULT,
          label: `${modelLabel(brain.options.model)} (brain default)`,
        },
        ...CLAUDE.filter((m) => m.id !== own),
      ];
  // A chosen model the list does not hold (yet) still shows.
  if (value && !options.some((o) => o.id === value))
    options.push({ id: value, label: modelLabel(value) });

  return (
    <label className="brain-composer-pick">
      <span>Capture with</span>
      <select
        className="field brain-pill"
        aria-label="Capture with"
        value={value ?? DEFAULT}
        disabled={disabled}
        onChange={(e) =>
          onChange(e.target.value === DEFAULT ? null : e.target.value)
        }
      >
        {options.map((o) => (
          <option key={o.id || 'default'} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
