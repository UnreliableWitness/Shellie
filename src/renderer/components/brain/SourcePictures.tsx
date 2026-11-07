import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BrainJob,
  PictureCounts,
  PictureRow,
  PictureStatus,
  SourcePictures as SourcePicturesData,
} from '../../../shared/brain';
import { plural } from '../../../shared/text';
import { api, tryInvoke } from '../../api';
import { useBrainChanged } from '../../hooks/useBrains';
import { useStore } from '../../store';
import { trackBrain } from './brainActions';
import { sourceLabel } from './recent';

/** The wiki mirror's pictures, one set for all its pages (main's MIRROR_SOURCE). */
export const MIRROR_PICTURES = 'sources/wiki';

/** Rows shown before Show all. */
const FIRST_ROWS = 5;

/** Each status as its tag and the counts line name it, with its colour token. */
const STATUS: Record<
  PictureStatus,
  { label: string; tone: 'green' | 'muted' | 'warn' | 'red' }
> = {
  described: { label: 'described', tone: 'green' },
  skipped: { label: 'nothing to record', tone: 'muted' },
  missing: { label: 'not interpreted', tone: 'warn' },
  dropped: { label: 'never reached Claude', tone: 'red' },
  accepted: { label: 'accepted', tone: 'muted' },
};
const ORDER: PictureStatus[] = [
  'described',
  'skipped',
  'missing',
  'dropped',
  'accepted',
];

const isActive = (j: BrainJob) =>
  j.status === 'queued' || j.status === 'running';

/** Pictures a person still has to act on: not interpreted, or never reached Claude and not accepted. */
export const pictureGaps = (c: PictureCounts) => c.missing + c.dropped;

/** Pictures Claude could look at, and how many of them it described or marked as carrying nothing. */
export const interpreted = (c: PictureCounts) => ({
  done: c.described + c.skipped,
  of: c.described + c.skipped + c.missing,
});

/** A source's pictures, fetched when `source` is set and again when the brain changes; null until loaded or on error. */
export function useSourcePictures(
  brainId: string,
  source: string | null,
): SourcePicturesData | null {
  const [pictures, setPictures] = useState<SourcePicturesData | null>(null);
  // Only the answer for the source shown lands.
  const shown = useRef(source);
  shown.current = source;
  const load = useCallback(() => {
    if (!source) return;
    api()
      .invoke('brain:pictures', brainId, source)
      .then(
        (p) => {
          if (shown.current === source) setPictures(p);
        },
        () => {
          if (shown.current === source) setPictures(null);
        },
      );
  }, [brainId, source]);
  useEffect(() => {
    setPictures(null);
    load();
  }, [load]);
  useBrainChanged(brainId, load);
  return pictures;
}

/**
 * A source's Pictures panel: the counts per status with a bar, one row per picture (thumbnail, label and alt, the
 * pages describing it, the skip or drop reason and fix, its tag), Re-evaluate for the ones not interpreted and
 * Fine, I know on each drop not accepted yet.
 */
export function SourcePictures({
  brainId,
  pictures,
  jobs,
  onOpen,
  onView,
  titleOf = sourceLabel,
}: {
  brainId: string;
  pictures: SourcePicturesData;
  /** The brain's jobs: a pictures job for the source in flight disables Re-evaluate. */
  jobs: BrainJob[];
  onOpen: (path: string) => void;
  /** Opens a thumbnail at full size. */
  onView?: (src: string, alt: string) => void;
  /** A describing page's name for its link. */
  titleOf?: (path: string) => string;
}) {
  const notify = useStore((s) => s.notify);
  const [all, setAll] = useState(false);
  const { source, counts, rows } = pictures;
  const reevaluating = jobs.some(
    (j) => j.kind === 'pictures' && j.source === source && isActive(j),
  );
  const reevaluate = () => {
    trackBrain('reevaluate');
    void tryInvoke(
      () => api().invoke('brain:run', brainId, 'pictures', source),
      notify,
    );
  };
  const accept = (where: string) => {
    trackBrain('accept-drop');
    void tryInvoke(
      () => api().invoke('brain:acceptDrop', brainId, source, where),
      notify,
    );
  };
  const present = ORDER.filter((s) => counts[s] > 0);
  const parts = present.map((s) => `${counts[s]} ${STATUS[s].label}`);
  if (counts.tiny > 0)
    parts.push(`plus ${counts.tiny} tiny images not looked at`);
  const shown = all ? rows : rows.slice(0, FIRST_ROWS);

  return (
    <section className="brain-pictures" aria-labelledby="brain-pictures-h">
      <div className="brain-pictures-head">
        <h3 id="brain-pictures-h">Pictures</h3>
        <span className="muted small" aria-label="Counts">
          {parts.join(' · ')}
        </span>
        {counts.missing > 0 && (
          <button
            type="button"
            className="btn btn-sm brain-card-action"
            disabled={reevaluating}
            onClick={reevaluate}
          >
            {reevaluating
              ? 'Re-evaluating…'
              : `Re-evaluate ${plural(counts.missing, 'picture')}`}
          </button>
        )}
      </div>
      {counts.total > 0 && (
        <>
          <div className="brain-pictures-bar" aria-hidden>
            {present.map((s) => (
              <span
                key={s}
                className={`tone-${STATUS[s].tone}`}
                style={{ flexGrow: counts[s] }}
              />
            ))}
          </div>
          <ul className="brain-pictures-legend muted small" aria-hidden>
            {present.map((s) => (
              <li key={s} className={`tone-${STATUS[s].tone}`}>
                {s === 'described' ? 'described in the wiki' : STATUS[s].label}
              </li>
            ))}
          </ul>
          <ul className="list brain-pictures-rows" aria-label="Pictures">
            {shown.map((r, i) => (
              <PictureLine
                key={`${r.path ?? r.where ?? ''}:${i}`}
                brainId={brainId}
                row={r}
                onOpen={onOpen}
                onView={onView}
                onAccept={accept}
                titleOf={titleOf}
              />
            ))}
          </ul>
          {!all && rows.length > FIRST_ROWS && (
            <button
              type="button"
              className="btn btn-ghost btn-sm brain-pictures-all"
              onClick={() => setAll(true)}
            >
              Show all {rows.length}
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** What a row says under its label: the pages describing it, the skip reason, or the drop reason and fix. */
function detailOf(r: PictureRow): string | null {
  if (r.status === 'skipped')
    return r.reason ? `Nothing to record: ${r.reason}` : 'Nothing to record';
  if (r.status === 'missing') return 'No wiki page cites it yet.';
  if (r.status === 'dropped' || r.status === 'accepted') {
    const head = r.status === 'dropped' ? 'Never reached Claude' : 'Accepted';
    return [
      r.reason ? `${head}: ${r.reason}.` : `${head}.`,
      r.fix ? `${r.fix}.` : null,
    ]
      .filter(Boolean)
      .join(' ');
  }
  return null;
}

/** The format a drop's reason names (`EMF converts on Windows only`), for its placeholder box. */
const formatOf = (reason: string | null) =>
  reason?.match(/^([A-Z0-9]{2,5})\b/)?.[1] ?? '';

function PictureLine({
  brainId,
  row,
  onOpen,
  onView,
  onAccept,
  titleOf,
}: {
  brainId: string;
  row: PictureRow;
  onOpen: (path: string) => void;
  onView?: (src: string, alt: string) => void;
  onAccept: (where: string) => void;
  titleOf: (path: string) => string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!row.path) return;
    let live = true;
    api()
      .invoke('brain:asset', brainId, row.path)
      .then(
        (s) => {
          if (live) setSrc(s);
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [brainId, row.path]);
  const name = row.alt ? `${row.label} · ${row.alt}` : row.label;
  const detail = detailOf(row);
  const status = STATUS[row.status];
  return (
    <li className="list-row brain-picture">
      {row.path ? (
        <button
          type="button"
          className="brain-picture-thumb"
          aria-label={`View ${name}`}
          disabled={!src}
          onClick={() => src && onView?.(src, name)}
        >
          {src && <img src={src} alt={name} />}
        </button>
      ) : (
        <span className="brain-picture-thumb is-drop" aria-hidden>
          {formatOf(row.reason)}
        </span>
      )}
      <div className="grow">
        <span>
          <strong>{row.label}</strong>
          {row.alt && <span className="muted"> · {row.alt}</span>}
        </span>
        {row.status === 'described' && row.pages.length > 0 && (
          <span className="small">
            Described on{' '}
            {row.pages.map((p, i) => (
              <span key={p}>
                {i > 0 && ', '}
                <button
                  type="button"
                  className="link"
                  title={p}
                  onClick={() => onOpen(p)}
                >
                  {titleOf(p)}
                </button>
              </span>
            ))}
          </span>
        )}
        {detail && (
          <span
            className={
              row.status === 'skipped' || row.status === 'accepted'
                ? 'small muted'
                : 'small'
            }
          >
            {detail}
          </span>
        )}
      </div>
      {row.status === 'dropped' && row.where && (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => onAccept(row.where!)}
        >
          Fine, I know
        </button>
      )}
      <span className={`tag tag-${status.tone}`}>{status.label}</span>
    </li>
  );
}

/**
 * The picture line under a just-added source in the inbox and the task tab: while its re-evaluation runs, how many
 * pictures are interpreted and how many are being re-evaluated; once idle and complete, a green tag. Nothing while
 * the capture itself runs (Waiting to capture shows it) or when Claude had no picture to look at.
 */
export function AddedPictures({
  brainId,
  path,
  jobs,
}: {
  brainId: string;
  path: string;
  jobs: BrainJob[];
}) {
  const pictures = useSourcePictures(brainId, path);
  if (!pictures) return null;
  const c = pictures.counts;
  const { done, of } = interpreted(c);
  if (of === 0) return null;
  const inFlight = (kind: BrainJob['kind']) =>
    jobs.some((j) => j.kind === kind && j.source === path && isActive(j));
  if (inFlight('capture')) return null;
  if (inFlight('pictures'))
    return (
      <span className="muted small">
        Capture done · {done} of {plural(of, 'picture')} interpreted ·
        re-evaluating {plural(c.missing, 'picture')}…
      </span>
    );
  if (c.missing === 0)
    return (
      <span className="tag tag-green">
        all {plural(of, 'picture')} interpreted
      </span>
    );
  return (
    <span className="muted small">
      {done} of {plural(of, 'picture')} interpreted
    </span>
  );
}
