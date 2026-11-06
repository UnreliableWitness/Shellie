import { useLayoutEffect, useRef, useState } from 'react';

const REFERENCE_EUR = 50;
const R = 24;
const STROKE = 7;
const C = 2 * Math.PI * R;
/** Radius of the hole inside the ring, in viewBox units. */
const RING_INNER_R = R - STROKE / 2;
/** A monospace glyph is at most this wide per font size unit (Cascadia, Consolas, SF Mono, Menlo). */
const GLYPH = 0.62;
/** Widest the value line and the caption may be, chosen so both stay inside the hole at their heights. */
const VALUE_W = 32;
const CAPTION_W = 28;
/** Gap between segments, in viewBox units of arc length. */
const GAP = 0.8;
const clamp = (n: number) =>
  Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
const round = (n: number) => Math.round(n * 1000) / 1000;

/** The largest font size (viewBox units, up to `max`) at which `text` is at most `width` wide. */
const fitFontSize = (text: string, width: number, max: number) =>
  Math.min(max, width / (Math.max(1, text.length) * GLYPH));

/** A centred line of SVG text that shrinks itself when the real font renders it wider than `width`. */
function FitText({
  text,
  width,
  max,
  y,
  className,
  part,
}: {
  text: string;
  width: number;
  max: number;
  y: (size: number) => number;
  className: string;
  part: string;
}) {
  const ref = useRef<SVGTextElement>(null);
  const estimate = fitFontSize(text, width, max);
  const [size, setSize] = useState(estimate);
  useLayoutEffect(() => {
    setSize(estimate);
  }, [estimate]);
  useLayoutEffect(() => {
    const el = ref.current;
    // jsdom has no text layout; the estimate alone then decides.
    const w =
      el && typeof el.getComputedTextLength === 'function'
        ? el.getComputedTextLength()
        : 0;
    if (w > width) setSize((s) => (s * width) / w);
  }, [size, width, text]);
  return (
    <text
      ref={ref}
      data-part={part}
      className={className}
      x="32"
      y={y(size)}
      textAnchor="middle"
      fontSize={size}
    >
      {text}
    </text>
  );
}

export function RingGauge({
  value,
  max,
  size = 18,
  segments,
  label,
  center,
}: {
  value: number;
  max?: number;
  size?: number;
  segments?: { value: number; color: string; title?: string }[];
  label?: string;
  /** Text in the hole: a value line and an optional smaller caption under it, both sized to fit. */
  center?: { value: string; caption?: string };
}) {
  const scale = max ?? REFERENCE_EUR;
  const a11y = label
    ? { role: 'img', 'aria-label': label }
    : { 'aria-hidden': true as const };
  const drawn = segments?.filter((s) => clamp(s.value / scale) > 0).length ?? 0;
  const gap = drawn > 1 ? GAP : 0;
  let offset = 0;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className="ring"
      data-inner-r={RING_INNER_R}
      {...a11y}
    >
      <circle
        cx="32"
        cy="32"
        r={R}
        fill="none"
        stroke="var(--line-strong)"
        strokeWidth={STROKE}
      />
      {segments ? (
        segments.map((s, i) => {
          const f = round(clamp(s.value / scale));
          const len = Math.max(0, f * C - gap);
          const el = (
            <circle
              key={i}
              data-part="segment"
              data-fraction={f}
              cx="32"
              cy="32"
              r={R}
              fill="none"
              stroke={s.color}
              strokeWidth={STROKE}
              strokeDasharray={`${len} ${C}`}
              strokeDashoffset={-(offset * C + gap / 2)}
              transform="rotate(-90 32 32)"
            >
              {s.title && <title>{s.title}</title>}
            </circle>
          );
          offset += f;
          return el;
        })
      ) : (
        <circle
          data-part="arc"
          data-fraction={round(clamp(value / scale))}
          cx="32"
          cy="32"
          r={R}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={STROKE}
          strokeDasharray={`${round(clamp(value / scale)) * C} ${C}`}
          transform="rotate(-90 32 32)"
        />
      )}
      {center && (
        <g className="ring-center">
          <FitText
            part="center-value"
            className="ring-value"
            text={center.value}
            width={VALUE_W}
            max={9}
            // Baseline so the line's middle sits at the centre, or a little above it with a caption.
            y={(fs) => 32 + fs * 0.35 - (center.caption ? 3 : 0)}
          />
          {center.caption && (
            <FitText
              part="center-caption"
              className="ring-caption"
              text={center.caption}
              width={CAPTION_W}
              max={4.2}
              y={(fs) => 32 + 4 + fs}
            />
          )}
        </g>
      )}
    </svg>
  );
}
