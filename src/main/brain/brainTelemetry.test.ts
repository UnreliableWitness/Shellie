import { describe, expect, it } from 'vitest';
import { AdoError } from '../services/AdoClient';
import { joinOutcome } from './brainTelemetry';
import { NoConnectionError } from './share/join';

describe('joinOutcome', () => {
  it('names a missing connection, a refused access and anything else', () => {
    expect(joinOutcome(new NoConnectionError('Acme'))).toBe('noConnection');
    expect(joinOutcome(new AdoError('unauthorized', 'clone', 'no', 401))).toBe(
      'denied',
    );
    expect(joinOutcome(new AdoError('not-found', 'x', 'gone', 404))).toBe(
      'failed',
    );
    expect(joinOutcome(new Error('boom'))).toBe('failed');
  });
});
