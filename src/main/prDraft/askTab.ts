import type { AttentionState } from '../../shared/attention';
import type { Turn } from '../brain/sessionDigest';
import { readReply } from './protocol';

/** How long Shellie waits for the tab's answer before writing the description without it. */
export const TAB_TIMEOUT_MS = 180_000;
/** Between the typed line and its Enter, so the agent submits it rather than adding a line (as brainTerminal does). */
export const SUBMIT_DELAY_MS = 150;
/** How often the session is read again besides on a finished turn (a missed state report, a tab that went away). */
export const POLL_MS = 2_000;
/** After a finished turn without the marked reply, the session is read again this long later before giving up. */
export const SETTLE_MS = 1_500;

export type AskTabDeps = {
  /** The request line typed into the tab. */
  line: string;
  /** Writes the request file. */
  writeRequest(): Promise<void>;
  /** Removes the request file; never throws. */
  removeRequest(): Promise<void>;
  /** Called before typing: what the session holds from then on is what `read` returns. */
  begin(): Promise<() => Promise<Turn[]>>;
  /** Whether typing is still safe right now (not paused, nothing typed, agent waiting). */
  canType(): boolean;
  type(data: string): void;
  mute(): void;
  unmute(): void;
  onState(listener: (state: AttentionState) => void): () => void;
  alive(): boolean;
  onBlocked(blocked: boolean): void;
  setTimer(fn: () => void, ms: number): () => void;
  timeoutMs?: number;
};

export type AskTabResult =
  | { text: string }
  | { reason: 'busy' | 'no-reply' | 'exited' | 'timeout' }
  | { aborted: true };

/**
 * Asks the task's agent tab for the PR description: writes the request file, types the request line and waits for the
 * session to answer between the markers. A finished turn without them (the agent asked something, refused, was in
 * plan mode) ends it at once, once the session shows the request was answered; a finished turn before the request is
 * even in the session does not. The request file goes in every case.
 */
export async function askTab(
  d: AskTabDeps,
  signal: AbortSignal,
): Promise<AskTabResult> {
  if (signal.aborted) return { aborted: true };
  await d.writeRequest();
  let muted = false;
  const cleanups: (() => void)[] = [];
  try {
    const read = await d.begin();
    if (signal.aborted) return { aborted: true };
    if (!d.canType()) return { reason: 'busy' };
    d.mute();
    muted = true;
    d.type(d.line);
    await new Promise<void>((resolve) => {
      cleanups.push(d.setTimer(resolve, SUBMIT_DELAY_MS));
    });
    if (signal.aborted) return { aborted: true };
    d.type('\r');
    const result = await new Promise<AskTabResult>((resolve) => {
      let done = false;
      let checking = false;
      const finish = (r: AskTabResult) => {
        if (done) return;
        done = true;
        resolve(r);
      };
      /** Reads the session; `ended` when the agent just finished a turn, so an unmarked answer counts. */
      const check = async (ended: boolean) => {
        if (done || checking) return;
        checking = true;
        try {
          const r = readReply(await read(), d.line);
          if (r.kind === 'reply') finish({ text: r.text });
          else if (r.kind === 'unmarked' && ended) {
            // The last text may not be written yet when the turn's end is reported: read once more a little later.
            cleanups.push(
              d.setTimer(() => {
                void (async () => {
                  const again = readReply(await read(), d.line);
                  if (again.kind === 'reply') finish({ text: again.text });
                  else if (again.kind === 'unmarked')
                    finish({ reason: 'no-reply' });
                })();
              }, SETTLE_MS),
            );
          }
        } catch {
          // An unreadable session now may be readable at the next turn or poll.
        } finally {
          checking = false;
        }
      };
      const onAbort = () => finish({ aborted: true });
      signal.addEventListener('abort', onAbort);
      cleanups.push(() => signal.removeEventListener('abort', onAbort));
      cleanups.push(
        d.onState((state) => {
          if (state === 'blocked') d.onBlocked(true);
          else if (state === 'working') d.onBlocked(false);
          else if (state === 'clear') finish({ reason: 'exited' });
          if (state === 'done' || state === 'idle') {
            d.onBlocked(false);
            void check(true);
          }
        }),
      );
      const poll = () => {
        if (done) return;
        if (!d.alive()) {
          finish({ reason: 'exited' });
          return;
        }
        void check(false);
        cleanups.push(d.setTimer(poll, POLL_MS));
      };
      cleanups.push(d.setTimer(poll, POLL_MS));
      cleanups.push(
        d.setTimer(
          () => finish({ reason: 'timeout' }),
          d.timeoutMs ?? TAB_TIMEOUT_MS,
        ),
      );
    });
    // A turn that ended with the reply used up the mute; anything else may still be running.
    if ('text' in result) muted = false;
    return result;
  } finally {
    for (const c of cleanups) c();
    if (muted) d.unmute();
    await d.removeRequest();
  }
}
