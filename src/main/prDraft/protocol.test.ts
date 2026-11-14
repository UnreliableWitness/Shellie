import { describe, expect, it } from 'vitest';
import type { Turn } from '../brain/sessionDigest';
import { sessionDigest } from '../brain/sessionDigest';
import {
  PR_MARK_CLOSE,
  PR_MARK_OPEN,
  betweenMarks,
  prRequestLine,
  readReply,
  withoutPrRequests,
} from './protocol';

const line = prRequestLine('.shellie/pr-request-1.md');
const dev = (text: string): Turn => ({ who: 'Developer', text });
const claude = (text: string): Turn => ({ who: 'Claude', text });
const agent = (text: string): Turn => ({ who: 'Agent', text });
const marked = (s: string) => `Here:\n${PR_MARK_OPEN}\n${s}\n${PR_MARK_CLOSE}`;

describe('withoutPrRequests', () => {
  it("drops Shellie's request and the agent's answer, for both agents", () => {
    const turns = [
      dev('Fix the login bug'),
      claude('Fixed.'),
      dev(line),
      claude('Reading the request.'),
      claude(marked('## What changed')),
      dev('Also explain the pull request flow'),
      agent('Sure.'),
      dev(line),
      agent(marked('x')),
    ];
    expect(withoutPrRequests(turns)).toEqual([
      dev('Fix the login bug'),
      claude('Fixed.'),
      dev('Also explain the pull request flow'),
      agent('Sure.'),
    ]);
  });

  it('keeps it out of the lessons digest', () => {
    const digest = sessionDigest('T', [
      withoutPrRequests([
        dev('Work'),
        claude('Done'),
        dev(line),
        claude(marked('secret sauce')),
      ]),
    ]);
    expect(digest).not.toContain('secret sauce');
    expect(digest).not.toContain('Shellie: write');
  });
});

describe('betweenMarks', () => {
  it('takes the text between the markers, trimmed', () => {
    expect(betweenMarks(marked(' ## What changed\n- a '))).toBe(
      '## What changed\n- a',
    );
  });
  it('is null without both markers or with nothing between them', () => {
    expect(betweenMarks('no markers')).toBeNull();
    expect(betweenMarks(`${PR_MARK_OPEN} only`)).toBeNull();
    expect(betweenMarks(`${PR_MARK_OPEN}\n\n${PR_MARK_CLOSE}`)).toBeNull();
  });
});

describe('readReply', () => {
  it('is pending until the request line is in the session', () => {
    expect(readReply([dev('Work'), claude('Done')], line)).toEqual({
      kind: 'pending',
    });
  });
  it('is pending when nothing came after the line yet', () => {
    expect(readReply([dev(line)], line)).toEqual({ kind: 'pending' });
  });
  it('finds the marked reply in any agent turn after the line', () => {
    expect(
      readReply([dev(line), agent('Reading.'), agent(marked('Text'))], line),
    ).toEqual({
      kind: 'reply',
      text: 'Text',
    });
  });
  it('is unmarked when the agent answered without the markers', () => {
    expect(readReply([dev(line), claude('Which base branch?')], line)).toEqual({
      kind: 'unmarked',
    });
  });
  it('looks after the latest request line only', () => {
    const turns = [dev(line), claude(marked('Old')), dev(line)];
    expect(readReply(turns, line)).toEqual({ kind: 'pending' });
  });
});
