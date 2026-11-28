import path from 'node:path';
import {
  ASK_STEPS_MAX,
  type AskProgress,
  type AskStep,
} from '../../shared/askProgress';
import { claudeResultWithSession } from '../services/prSummary';

/** The longest search pattern a step shows. */
const PATTERN_MAX = 60;
const OUTSIDE = 'a file outside the folder';

const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null;

/** The path as it reads inside the run's folder; never a path that leaves it. */
function shown(file: string, cwd: string): string {
  const rel = path.relative(cwd, path.resolve(cwd, file));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel))
    return OUTSIDE;
  return rel.split(path.sep).join('/');
}

const cut = (s: string) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > PATTERN_MAX ? `${one.slice(0, PATTERN_MAX - 1)}…` : one;
};

/** A step for a tool call: the tool's name as either agent spells it, and its input. */
function stepOf(tool: string, input: unknown, cwd: string): AskStep {
  const i = (input && typeof input === 'object' ? input : {}) as Record<
    string,
    unknown
  >;
  const file = text(i.filePath) ?? text(i.file_path) ?? text(i.path);
  const pattern = text(i.pattern) ?? text(i.query);
  switch (tool.toLowerCase()) {
    case 'read':
      return {
        kind: 'read',
        label: `Read ${file ? shown(file, cwd) : 'a file'}`,
      };
    case 'edit':
    case 'multiedit':
    case 'patch':
      return {
        kind: 'edit',
        label: `Edited ${file ? shown(file, cwd) : 'a file'}`,
      };
    case 'write':
      return {
        kind: 'write',
        label: `Wrote ${file ? shown(file, cwd) : 'a file'}`,
      };
    case 'grep':
      return {
        kind: 'search',
        label: pattern ? `Searched for “${cut(pattern)}”` : 'Searched',
      };
    case 'glob':
    case 'list':
    case 'ls':
      return {
        kind: 'search',
        label: pattern
          ? `Looked for ${cut(pattern)}`
          : 'Looked through the files',
      };
    default:
      // A tool's name is the agent's: shown only when it is a plain word.
      return {
        kind: 'other',
        label: /^[\w.-]{1,40}$/.test(tool) ? `Used ${tool}` : 'Used a tool',
      };
  }
}

const parsed = (line: string): Record<string, unknown> | null => {
  if (!line.startsWith('{')) return null;
  try {
    const v: unknown = JSON.parse(line);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * The step in one line of `opencode run --format json` (seen on 1.19.3): a `tool_use` event, which OpenCode prints
 * when the tool has finished. Null for every other line.
 */
export function opencodeStep(line: string, cwd: string): AskStep | null {
  const e = parsed(line);
  if (e?.type !== 'tool_use') return null;
  const part = e.part as
    | { tool?: unknown; state?: { status?: unknown; input?: unknown } }
    | undefined;
  if (typeof part?.tool !== 'string' || part.state?.status !== 'completed')
    return null;
  return stepOf(part.tool, part.state.input, cwd);
}

/**
 * What one line of Claude Code's `--output-format stream-json --verbose --include-partial-messages` says: a tool
 * call (a step; the text written before it was not the answer, so `reset`), or a piece of text. Null for every
 * other line, the agent's thinking included.
 */
export function claudeEvent(
  line: string,
  cwd: string,
): { step?: AskStep; text?: string; reset?: true } | null {
  const e = parsed(line);
  if (!e) return null;
  if (e.type === 'assistant') {
    const content = (e.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return null;
    const call = content.find(
      (b): b is { type: 'tool_use'; name: string; input?: unknown } =>
        !!b &&
        typeof b === 'object' &&
        (b as { type?: unknown }).type === 'tool_use' &&
        typeof (b as { name?: unknown }).name === 'string',
    );
    return call
      ? { step: stepOf(call.name, call.input, cwd), reset: true }
      : null;
  }
  if (e.type === 'stream_event') {
    const event = e.event as
      | { type?: unknown; delta?: { type?: unknown; text?: unknown } }
      | undefined;
    if (
      event?.type === 'content_block_delta' &&
      event.delta?.type === 'text_delta' &&
      typeof event.delta.text === 'string'
    )
      return { text: event.delta.text };
  }
  return null;
}

/** Whether a line of a stream-json run is its result (the keys come in no fixed order). */
export const isClaudeResultLine = (line: string): boolean =>
  line.includes('"type":"result"') && parsed(line)?.type === 'result';

/** The answer and session of a stream-json run: its last `result` line, by the rules of a single JSON result. */
export function claudeStreamResult(stdout: string): {
  result: string;
  sessionId: string | null;
} {
  const lines = stdout.trim().split('\n');
  const line = lines.findLast((l) => parsed(l.trim())?.type === 'result');
  if (line === undefined) {
    if (!stdout.trim()) throw new Error('Claude Code printed nothing');
    throw new Error('Claude Code gave no result');
  }
  return claudeResultWithSession(line.trim());
}

/**
 * Collects what a run is doing and says so through `emit`: at once, then at most once per `everyMs`, and always the
 * last state. A step equal to the one before it counts once; the newest `ASK_STEPS_MAX` are kept.
 */
export function progressLog(
  emit: (p: AskProgress) => void,
  o: { everyMs?: number } = {},
) {
  const everyMs = o.everyMs ?? 250;
  let steps: AskStep[] = [];
  let earlier = 0;
  let said = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  const snapshot = (): AskProgress => ({
    steps: [...steps],
    earlier,
    text: said,
  });
  const send = () => {
    dirty = false;
    emit(snapshot());
  };
  const changed = () => {
    if (timer !== undefined) {
      dirty = true;
      return;
    }
    send();
    timer = setTimeout(() => {
      timer = undefined;
      if (dirty) changed();
    }, everyMs);
  };
  return {
    step(s: AskStep) {
      const last = steps.at(-1);
      if (last && last.kind === s.kind && last.label === s.label) return;
      steps.push(s);
      if (steps.length > ASK_STEPS_MAX) {
        earlier += steps.length - ASK_STEPS_MAX;
        steps = steps.slice(-ASK_STEPS_MAX);
      }
      changed();
    },
    text(t: string) {
      if (t === '') return;
      said += t;
      changed();
    },
    resetText() {
      if (said === '') return;
      said = '';
      changed();
    },
    /** Says the last state now and stops the timer: for the end of the run. */
    flush() {
      clearTimeout(timer);
      timer = undefined;
      if (dirty) send();
    },
    snapshot,
  };
}
