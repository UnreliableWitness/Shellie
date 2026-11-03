const TIMING =
  /^((?:\d+:)?\d{1,2}:\d{2})\.\d{3}\s+-->\s+(?:\d+:)?\d{1,2}:\d{2}\.\d{3}/;

function toSeconds(stamp: string): number {
  const parts = stamp.split(':').map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
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
    .replace(/^﻿/, '')
    .split(/\r?\n\s*\r?\n/)
    .map((b) => b.split(/\r?\n/));

  const out: string[] = [];
  let lastHeading = -Infinity;
  let prevSpeaker: string | null | undefined;
  let prevText = '';
  let canMerge = false;

  for (const lines of blocks) {
    const i = lines.findIndex((l) => TIMING.test(l));
    if (i < 0) continue; // header, NOTE, STYLE, REGION
    const start = toSeconds(TIMING.exec(lines[i])![1]);
    const raw = lines
      .slice(i + 1)
      .join(' ')
      .trim();
    const voice = /^<v(?:\.[^\s>]*)?\s+([^>]+)>/.exec(raw);
    const speaker = voice ? voice[1].trim() : null;
    const body = raw
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!body) continue;
    if (body === prevText) continue; // overlapping duplicate

    const heading = start - lastHeading >= 60;
    if (heading) {
      lastHeading = start;
      out.push(`## ${hms(start)}`);
      canMerge = false;
    }
    if (canMerge && speaker === prevSpeaker && speaker !== null) {
      out[out.length - 1] += ` ${body}`;
    } else if (canMerge && speaker === null && prevSpeaker === null) {
      out[out.length - 1] += ` ${body}`;
    } else {
      out.push(speaker ? `**${speaker}:** ${body}` : body);
    }
    canMerge = true;
    prevSpeaker = speaker;
    prevText = body;
  }
  return out.join('\n\n') + (out.length ? '\n' : '');
}
