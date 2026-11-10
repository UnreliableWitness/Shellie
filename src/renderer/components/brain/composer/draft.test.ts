import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../store';
import { EMPTY_DRAFT, draftIsEmpty, useComposerDraft } from './draft';
import { DRAFT_KEY } from './draftStorage';

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ brainDrafts: {} });
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const file = {
  name: 'a.pdf',
  path: '/dl/a.pdf',
  bytes: 10,
  type: 'doc' as const,
  ownNote: null,
};

describe('useComposerDraft', () => {
  it('keeps the draft across a remount', () => {
    const a = renderHook(() => useComposerDraft('b1'));
    act(() => a.result.current.update({ text: 'hello' }));
    a.unmount();
    const b = renderHook(() => useComposerDraft('b1'));
    expect(b.result.current.draft.text).toBe('hello');
    expect(b.result.current.isEmpty).toBe(false);
  });

  it('keeps one draft per brain', () => {
    const a = renderHook(() => useComposerDraft('b1'));
    const b = renderHook(() => useComposerDraft('b2'));
    act(() => a.result.current.update({ files: [file], model: 'opus' }));
    expect(b.result.current.draft).toEqual(EMPTY_DRAFT);
    expect(a.result.current.draft.files).toEqual([file]);
  });

  it('comes back from local storage after a reload, on the brain model', () => {
    const a = renderHook(() => useComposerDraft('b1'));
    act(() =>
      a.result.current.update((d) => ({
        ...d,
        title: 'T',
        note: 'N',
        model: 'opus',
        files: [file],
      })),
    );
    act(() => vi.advanceTimersByTime(400));
    useStore.setState({ brainDrafts: {} });
    const b = renderHook(() => useComposerDraft('b1'));
    expect(b.result.current.draft).toEqual({
      ...EMPTY_DRAFT,
      title: 'T',
      note: 'N',
      files: [file],
    });
  });

  it('starts empty when what was stored is not a draft', () => {
    localStorage.setItem(DRAFT_KEY('b1'), '{"text": 3');
    expect(
      renderHook(() => useComposerDraft('b1')).result.current.draft,
    ).toEqual(EMPTY_DRAFT);
    localStorage.setItem(DRAFT_KEY('b1'), '{"text": 3}');
    useStore.setState({ brainDrafts: {} });
    expect(
      renderHook(() => useComposerDraft('b1')).result.current.draft,
    ).toEqual(EMPTY_DRAFT);
  });

  it('clear empties the draft and forgets it', () => {
    const a = renderHook(() => useComposerDraft('b1'));
    act(() => a.result.current.update({ text: 'x' }));
    act(() => vi.advanceTimersByTime(400));
    expect(localStorage.getItem(DRAFT_KEY('b1'))).not.toBeNull();
    act(() => a.result.current.clear());
    expect(a.result.current.draft).toEqual(EMPTY_DRAFT);
    act(() => vi.advanceTimersByTime(400));
    expect(localStorage.getItem(DRAFT_KEY('b1'))).toBeNull();
  });

  it('keeps working when local storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const a = renderHook(() => useComposerDraft('b1'));
    act(() => a.result.current.update({ text: 'x' }));
    act(() => vi.advanceTimersByTime(400));
    expect(a.result.current.draft.text).toBe('x');
    vi.restoreAllMocks();
  });
});

describe('draftIsEmpty', () => {
  it('is empty with only spaces and a model', () => {
    expect(draftIsEmpty({ ...EMPTY_DRAFT, text: '  \n', model: 'opus' })).toBe(
      true,
    );
    expect(draftIsEmpty({ ...EMPTY_DRAFT, note: 'n' })).toBe(false);
  });
});
