import { describe, expect, it } from 'vitest';
import { findStatusComment, parseStatus, renderStatus } from './state.mjs';

const bot = 'shellie-agents[bot]';
const state = {
  v: 1,
  state: 'needs-info',
  lastSeenCommentId: 42,
  triageRounds: 1,
  askedAt: '2026-10-26T08:00:00.000Z',
  tokens: 1200,
};

describe('status block', () => {
  it('round-trips through render and parse', () => {
    const body = renderStatus(state, '**Waiting for the reporter.**');
    expect(body.startsWith('**Waiting for the reporter.**')).toBe(true);
    expect(parseStatus(body)).toEqual(state);
  });

  it('survives a value that contains the comment terminator', () => {
    const s = { ...state, spec: { problem: 'breaks on --> arrows' } };
    expect(parseStatus(renderStatus(s, 'x'))).toEqual(s);
  });

  it('keeps negative numbers intact', () => {
    const s = { ...state, lastSeenCommentId: -1 };
    expect(parseStatus(renderStatus(s, 'x'))).toEqual(s);
  });

  it('returns null for a body without a marker or with broken JSON', () => {
    expect(parseStatus('just a comment')).toBeNull();
    expect(parseStatus('<!-- shellie-agent {"v":1, -->')).toBeNull();
  });

  it('trusts only the latest marker comment by the bot', () => {
    const forged = {
      id: 3,
      user: { login: 'mallory' },
      body: renderStatus({ ...state, state: 'ready' }, 'x'),
      created_at: '',
    };
    const older = {
      id: 1,
      user: { login: bot },
      body: renderStatus({ ...state, triageRounds: 0 }, 'x'),
      created_at: '',
    };
    const newer = {
      id: 2,
      user: { login: bot },
      body: renderStatus(state, 'x'),
      created_at: '',
    };
    const plain = {
      id: 4,
      user: { login: bot },
      body: 'Questions for you',
      created_at: '',
    };
    expect(findStatusComment([older, newer, forged, plain], bot)?.id).toBe(2);
    expect(findStatusComment([forged], bot)).toBeNull();
  });
});
