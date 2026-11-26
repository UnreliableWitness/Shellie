import { describe, expect, it } from 'vitest';
import { frameDue, type Motion } from './frames';

const idle: Motion = {
  flying: false,
  pointerDown: false,
  hovering: false,
  reduced: false,
  dirty: false,
};

describe('frameDue', () => {
  it('draws every frame while flying, dragging or hovering', () => {
    for (const key of ['flying', 'pointerDown', 'hovering'] as const)
      expect(frameDue({ ...idle, [key]: true }, 1001, 1000)).toBe(true);
  });

  it('draws the ambient motion at most every 33 ms', () => {
    expect(frameDue(idle, 1016, 1000)).toBe(false);
    expect(frameDue(idle, 1033, 1000)).toBe(true);
  });

  it('draws nothing by itself with reduced motion', () => {
    expect(frameDue({ ...idle, reduced: true }, 9000, 1000)).toBe(false);
  });

  it('draws a change at once, also with reduced motion', () => {
    expect(frameDue({ ...idle, reduced: true, dirty: true }, 1001, 1000)).toBe(
      true,
    );
  });
});
