const TIMING =
  /^((?:\d+:)?\d{1,2}:\d{2})\.(\d{3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2})\.(\d{3})/;

function toSeconds(stamp: string, ms: string): number {
  const parts = stamp.split(':').map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0) + Number(ms) / 1000;
}

type Segment = { speaker: string | null; text: string };

function clean(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits a cue payload into one segment per `<v Speaker>` run. */
function segmentsOf(raw: string): Segment[] {
  const out: Segment[] = [];
  for (const part of raw.split(/(?=<v[\s.])/)) {
    const voice = /^<v(?:\.[^\s>]*)?\s+([^>]+)>/.exec(part);
    const text = clean(part);
    if (text) out.push({ speaker: voice ? voice[1].trim() : null, text });
  }
  return out;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function hms(total: number): string {
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

/** Converts WebVTT to markdown: a time heading per minute, one line per speaker turn. */
export function vttToMarkdown(text: string): string {
  const blocks = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n\s*\r?\n/)
    .map((b) => b.split(/\r?\n/));

  const out: string[] = [];
  let lastHeading = -Infinity;
  let prev: Segment | null = null; // last emitted line, for merging
  let prevSegs: Segment[] = [];
  let prevEnd = -Infinity;

  for (const lines of blocks) {
    const i = lines.findIndex((l) => TIMING.test(l));
    if (i < 0) continue; // header, NOTE, STYLE, REGION
    const m = TIMING.exec(lines[i])!;
    const start = toSeconds(m[1], m[2]);
    const end = toSeconds(m[3], m[4]);
    const overlaps = start < prevEnd;
    const segs = segmentsOf(lines.slice(i + 1).join(' ')).filter(
      (s) =>
        !(
          overlaps &&
          prevSegs.some((p) => p.speaker === s.speaker && p.text === s.text)
        ),
    );
    prevSegs = segmentsOf(lines.slice(i + 1).join(' '));
    prevEnd = end;
    if (segs.length === 0) continue;

    const whole = Math.floor(start);
    if (start - lastHeading >= 60) {
      lastHeading = whole;
      out.push(`## ${hms(whole)}`);
      prev = null;
    }
    for (const seg of segs) {
      if (prev && seg.speaker !== null && seg.speaker === prev.speaker) {
        out[out.length - 1] += ` ${seg.text}`;
      } else {
        out.push(seg.speaker ? `**${seg.speaker}:** ${seg.text}` : seg.text);
      }
      prev = seg;
    }
  }
  return out.join('\n\n') + (out.length ? '\n' : '');
}
