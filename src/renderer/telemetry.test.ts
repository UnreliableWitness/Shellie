import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installErrorTracking, isBenignResizeObserverError } from './telemetry';

describe('installErrorTracking', () => {
  const track = vi.fn();
  let original: typeof window.shellie;

  beforeEach(() => {
    original = window.shellie;
    (window as { shellie: unknown }).shellie = { track };
    track.mockReset();
  });

  afterEach(() => {
    (window as { shellie: unknown }).shellie = original;
  });

  function fire(target: EventTarget, message: string, error?: Error): void {
    target.dispatchEvent(new ErrorEvent('error', { message, error }));
  }

  it('ignores the harmless ResizeObserver loop notice', () => {
    const target = new EventTarget();
    installErrorTracking(target as unknown as Window);
    fire(
      target,
      'ResizeObserver loop completed with undelivered notifications.',
    );
    fire(target, 'ResizeObserver loop limit exceeded');
    expect(track).not.toHaveBeenCalled();
  });

  it('reports an ordinary error', () => {
    const target = new EventTarget();
    installErrorTracking(target as unknown as Window);
    fire(target, 'boom', new TypeError('boom'));
    expect(track).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'exception',
        errorType: 'TypeError',
        message: 'boom',
        props: { source: 'window.onerror' },
      }),
    );
  });
});

describe('isBenignResizeObserverError', () => {
  it('matches only the ResizeObserver loop wording', () => {
    expect(
      isBenignResizeObserverError(
        'ResizeObserver loop completed with undelivered notifications.',
      ),
    ).toBe(true);
    expect(
      isBenignResizeObserverError('ResizeObserver loop limit exceeded'),
    ).toBe(true);
    expect(isBenignResizeObserverError('TypeError: x is undefined')).toBe(
      false,
    );
    expect(isBenignResizeObserverError(undefined)).toBe(false);
  });
});
