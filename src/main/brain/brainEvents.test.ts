import { describe, expect, it, vi } from 'vitest';
import { broadcastEvent, jobEvents } from './brainEvents';

function deps() {
  return { send: vi.fn(), filesChanged: vi.fn() };
}

describe('broadcastEvent', () => {
  it('counts a brain change as changed files and sends it', () => {
    const d = deps();
    broadcastEvent(d, 'brain:changed', { brainId: 'b1' });
    expect(d.filesChanged).toHaveBeenCalledWith('b1');
    expect(d.send).toHaveBeenCalledWith('brain:changed', { brainId: 'b1' });
  });

  it('only sends other events', () => {
    const d = deps();
    broadcastEvent(d, 'review:changed', { taskId: 't1' });
    expect(d.filesChanged).not.toHaveBeenCalled();
    expect(d.send).toHaveBeenCalledWith('review:changed', { taskId: 't1' });
  });
});

describe('jobEvents', () => {
  it('sends a job status change to the window without dropping what was read', () => {
    const d = deps();
    const ev = jobEvents(d);
    // Queued, held, released, running: each is one status change.
    for (let i = 0; i < 4; i++) ev.changed('b1');
    expect(d.send).toHaveBeenCalledTimes(4);
    expect(d.send).toHaveBeenCalledWith('brain:changed', { brainId: 'b1' });
    expect(d.filesChanged).not.toHaveBeenCalled();
  });

  it('counts an ended job as changed files', () => {
    const d = deps();
    jobEvents(d).ended({ brainId: 'b1' });
    expect(d.filesChanged).toHaveBeenCalledWith('b1');
    expect(d.send).not.toHaveBeenCalled();
  });
});
