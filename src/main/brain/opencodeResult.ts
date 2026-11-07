type OpencodeEvent = {
  type?: unknown;
  sessionID?: unknown;
  part?: { text?: unknown };
  error?: { name?: unknown; data?: { message?: unknown } };
};

/** The answer and session id of `opencode run --format json`: one JSON event per line; throws when the run failed or gave no text. */
export function opencodeResultWithSession(stdout: string): {
  result: string;
  sessionId: string | null;
} {
  if (!stdout.trim()) throw new Error('OpenCode printed nothing');
  let sessionId: string | null = null;
  let texts: string[] = [];
  for (const raw of stdout.split('\n')) {
    let event: OpencodeEvent;
    try {
      event = JSON.parse(raw) as OpencodeEvent;
    } catch {
      continue; // a login shell's profile may print before OpenCode does
    }
    if (!event || typeof event !== 'object') continue;
    if (sessionId === null && typeof event.sessionID === 'string')
      sessionId = event.sessionID;
    if (event.type === 'error') {
      const message = event.error?.data?.message ?? event.error?.name;
      throw new Error(
        `OpenCode stopped (${typeof message === 'string' ? message.slice(0, 200) : 'error'})`,
      );
    }
    if (event.type === 'step_start') texts = [];
    else if (event.type === 'text' && typeof event.part?.text === 'string')
      texts.push(event.part.text);
  }
  if (!texts.length) throw new Error('OpenCode gave no result');
  return { result: texts.join('\n'), sessionId };
}
