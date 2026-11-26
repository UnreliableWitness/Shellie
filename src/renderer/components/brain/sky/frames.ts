/** What is going on in the scene, for deciding whether a frame is worth drawing. */
export type Motion = {
  /** The camera is on its way somewhere. */
  flying: boolean;
  pointerDown: boolean;
  /** The pointer is over the scene. */
  hovering: boolean;
  /** The user asked for reduced motion: nothing moves by itself. */
  reduced: boolean;
  /** Something changed that the last frame does not show. */
  dirty: boolean;
};

/** The ambient motion (drift, twinkle, pulse) is drawn at most this often, in ms: 30 frames a second. */
export const AMBIENT_MS = 33;

/**
 * Whether to draw a frame now. What the user drives (a flight, a drag, the pointer over the scene, a change) is
 * drawn at the display's rate; the motion the scene makes by itself at 30 frames a second at most, and never with
 * reduced motion.
 */
export function frameDue(m: Motion, now: number, lastDraw: number): boolean {
  if (m.dirty || m.flying || m.pointerDown || m.hovering) return true;
  if (m.reduced) return false;
  return now - lastDraw >= AMBIENT_MS;
}
