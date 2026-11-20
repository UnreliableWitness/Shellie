import { useEffect, useState } from 'react';

/** Step 3: minutes without keyboard or mouse (1 to 120), with the fixed rules as text. */
export function IdleStep({
  minutes,
  onMinutes,
}: {
  minutes: number;
  onMinutes: (m: number) => void;
}) {
  const [text, setText] = useState(String(minutes));
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setText(String(minutes)), [minutes]);
  const commit = () => {
    const n = Number(text);
    if (!/^\d+$/.test(text.trim()) || n < 1 || n > 120) {
      setProblem('Use a whole number of minutes from 1 to 120.');
      return;
    }
    setProblem(null);
    if (n !== minutes) onMinutes(n);
  };
  return (
    <>
      <div className="dream-idle">
        <label htmlFor="dream-idle">After</label>
        <input
          id="dream-idle"
          className="field dream-minutes"
          aria-label="Minutes idle"
          inputMode="numeric"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
        />
        <span>minutes without keyboard or mouse, by day or by night</span>
      </div>
      {problem && (
        <p role="alert" className="small text-red">
          {problem}
        </p>
      )}
      <p className="muted small">
        Only on mains power, one dream at a time, and never while one of your
        task agents is working. A dream that is running when you come back
        finishes on its own.
      </p>
    </>
  );
}
