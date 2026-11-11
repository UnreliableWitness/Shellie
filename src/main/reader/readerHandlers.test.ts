import { describe, expect, it, vi } from 'vitest';
import type { ReaderStatus } from '../../shared/reader';
import { createReaderHandlers } from './readerHandlers';

const on: ReaderStatus = {
  connected: true,
  url: 'https://reader.example',
  lastPush: null,
  refused: false,
};
const mark = { hash: 'h1', at: '2026-11-11T09:00:00.000Z', read: true };

const reader = () => ({
  status: vi.fn(() => on),
  connect: vi.fn(async () => on),
  disconnect: vi.fn(async () => on),
  link: vi.fn(() => 'https://reader.example/#secret'),
  sendNow: vi.fn(async () => on),
  marks: vi.fn(async (_id: string, local: Record<string, typeof mark>) => ({
    ...local,
    'reads/phone.md': mark,
  })),
});

describe('reader handlers', () => {
  it('pass through to the sync', async () => {
    const r = reader();
    const h = createReaderHandlers(r);
    expect(await h['reader:status']()).toBe(on);
    await h['reader:connect']('https://reader.example', 'code');
    expect(r.connect).toHaveBeenCalledWith('https://reader.example', 'code');
    await h['reader:disconnect'](true);
    expect(r.disconnect).toHaveBeenCalledWith(true);
    expect(await h['reader:link']()).toBe('https://reader.example/#secret');
    expect(await h['reader:send']()).toBe(on);
    expect(await h['reader:marks']('b1', { 'reads/a.md': mark })).toEqual({
      'reads/a.md': mark,
      'reads/phone.md': mark,
    });
  });

  it('marks that are not marks count as none; anything but true is not "anyway"', async () => {
    const r = reader();
    const h = createReaderHandlers(r);
    await h['reader:marks']('b1', { 'reads/a.md': { hash: 1 } } as never);
    expect(r.marks).toHaveBeenCalledWith('b1', {});
    await h['reader:disconnect']('yes' as never);
    expect(r.disconnect).toHaveBeenCalledWith(false);
  });

  it('without a reader nothing is connected and the marks stay the view own', async () => {
    const h = createReaderHandlers(undefined);
    expect(await h['reader:status']()).toEqual({
      connected: false,
      url: null,
      lastPush: null,
      refused: false,
    });
    expect(await h['reader:link']()).toBeNull();
    expect(await h['reader:marks']('b1', { 'reads/a.md': mark })).toEqual({
      'reads/a.md': mark,
    });
    await expect(h['reader:send']()).rejects.toThrow(/not available/);
  });
});
