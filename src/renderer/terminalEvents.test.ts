import { describe, expect, it, vi } from 'vitest';
import { installFakeApi } from './test-helpers/fakeApi';
import { onTerminalEvent } from './terminalEvents';

describe('onTerminalEvent', () => {
  it('routes each event to its terminal over one bridge listener', () => {
    const api = installFakeApi();
    const on = vi.spyOn(window.shellie!, 'on');
    const a = vi.fn();
    const b = vi.fn();
    const offA = onTerminalEvent('terminal:data', 'a', a);
    const offB = onTerminalEvent('terminal:data', 'b', b);
    expect(on).toHaveBeenCalledTimes(1);
    api.emit('terminal:data', { id: 'a', data: 'x' });
    expect(a).toHaveBeenCalledWith({ id: 'a', data: 'x' });
    expect(b).not.toHaveBeenCalled();
    offA();
    api.emit('terminal:data', { id: 'a', data: 'y' });
    expect(a).toHaveBeenCalledTimes(1);
    offB();
    // The last handler gone, the bridge listener goes too; a new one subscribes again.
    const c = vi.fn();
    const offC = onTerminalEvent('terminal:data', 'a', c);
    expect(on).toHaveBeenCalledTimes(2);
    api.emit('terminal:data', { id: 'a', data: 'z' });
    expect(c).toHaveBeenCalledTimes(1);
    offC();
  });
});
