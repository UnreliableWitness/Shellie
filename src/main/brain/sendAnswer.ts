import path from 'node:path';
import type { SendAnswerResult } from '../../shared/ipc';

const QUESTION_MAX = 120;
/** One line, and nothing a terminal reads as a key (Ctrl+C, Escape, Delete): the text is typed into an agent's prompt. */
const oneLine = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    // oxlint-disable-next-line no-control-regex -- control characters are the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();

/** The file the task's agent is pointed at: the question and the brain's answer, as Markdown. */
export const answerFileText = (question: string, answer: string): string =>
  `# What the project's brain says\n\n## Question\n\n${question.trim()}\n\n## Answer\n\n${answer.trim()}\n`;

/** The one line typed into the agent's prompt; the person adds what they want done with it and sends it. */
export function answerLine(rel: string, question: string): string {
  const q = oneLine(question);
  const cut = q.length > QUESTION_MAX ? `${q.slice(0, QUESTION_MAX)}…` : q;
  return `Read ${rel}: what the project's brain says about "${cut}"`;
}

export type SendAnswerDeps = {
  /** The agent tab that may be typed into now (pickSendTab), with its folder; else why none can. */
  pick(): Promise<
    | { tab: { id: string; cwd: string } }
    | { reason: 'none' | 'busy' | 'typing' }
  >;
  /** A free `.shellie/brain-answer-<n>.md` in the folder, relative to it. */
  nextFile(cwd: string): Promise<string>;
  write(abs: string, text: string): Promise<void>;
  /** Types into the tab without sending. */
  type(terminalId: string, data: string): void;
};

/**
 * Hands a brain's answer to the task's agent: the answer as a file in the tab's own folder (so the relative path
 * resolves in a task with several repos) and one line in its prompt, without Enter. Nothing is written or typed when
 * no tab can take it.
 */
export async function sendAnswer(
  d: SendAnswerDeps,
  question: string,
  answer: string,
): Promise<SendAnswerResult> {
  const picked = await d.pick();
  if ('reason' in picked) return { ok: false, reason: picked.reason };
  const rel = await d.nextFile(picked.tab.cwd);
  await d.write(
    path.join(picked.tab.cwd, rel),
    answerFileText(question, answer),
  );
  d.type(picked.tab.id, answerLine(rel, question));
  return { ok: true, terminalId: picked.tab.id };
}
