/**
 * A stand-in for `opencode run --format json` in tests: a node script, started through the real `Platform` with the
 * current node binary, that plays one scripted run per call (in order). A run reads stdin, applies file edits in its
 * folder, writes the report the prompt names, prints OpenCode-style json events with a session id, and can be told
 * to sleep or exit 1.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Platform } from '../platform/Platform';
import { isWindows, testPlatform } from './shell';

export type FakeRun = {
  sessionId?: string;
  /** Repo-relative path to new content; null deletes the file. */
  edits?: Record<string, string | null>;
  /** Written to the report path the prompt names: an object as JSON, a string as is, null for none. */
  report?: unknown;
  /** Adds these verdicts, in order, to the proposals of the report already there (a check run). */
  verdicts?: ('pass' | 'fail')[];
  /** Written (empty) when the run starts, before any sleep. */
  startedMarker?: string;
  sleepMs?: number;
  exitCode?: number;
};

export type FakeCall = {
  args: string[];
  cwd: string;
  input: string;
  env: Record<string, string | undefined>;
};

const SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const scenarioPath = process.argv[2];
const args = process.argv.slice(3);
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
const counter = scenarioPath + '.n';
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
fs.writeFileSync(counter, String(n + 1));
const run = scenario.runs[n] || {};
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  fs.writeFileSync(scenarioPath + '.call' + n, JSON.stringify({
    args, cwd: process.cwd(), input,
    env: {
      PWD: process.env.PWD,
      OPENCODE_DISABLE_PROJECT_CONFIG: process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
      OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
      OPENCODE_PERMISSION: process.env.OPENCODE_PERMISSION,
      OPENCODE_CONFIG: process.env.OPENCODE_CONFIG,
    },
  }));
  if (run.startedMarker) fs.writeFileSync(run.startedMarker, '');
  setTimeout(play, run.sleepMs || 0);
  function play() {
    const sid = run.sessionId || 'ses_fake';
    if (run.exitCode) {
      process.stdout.write(JSON.stringify({ type: 'error', sessionID: sid, error: { name: 'UnknownError', data: { message: 'secret session text' } } }) + '\n');
      process.stderr.write('secret session text\n');
      process.exit(run.exitCode);
    }
    for (const [rel, content] of Object.entries(run.edits || {})) {
      const abs = path.join(process.cwd(), rel);
      if (content === null) fs.rmSync(abs, { force: true });
      else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      }
    }
    const m = /the report file (.+)[\\/]report\.json\./.exec(input);
    if (m) {
      const file = path.join(m[1], 'report.json');
      if (run.verdicts) {
        const r = JSON.parse(fs.readFileSync(file, 'utf8'));
        r.proposals.forEach((p, i) => { if (run.verdicts[i]) { p.verdict = run.verdicts[i]; p.verdictWhy = 'checked'; } });
        fs.writeFileSync(file, JSON.stringify(r));
      } else if (run.report !== undefined && run.report !== null) {
        fs.writeFileSync(file, typeof run.report === 'string' ? run.report : JSON.stringify(run.report));
      }
    }
    const ev = (e) => process.stdout.write(JSON.stringify({ sessionID: sid, ...e }) + '\n');
    ev({ type: 'step_start' });
    ev({ type: 'text', part: { text: 'done' } });
    ev({ type: 'step_finish' });
  }
});
`;

const quote = (s: string): string =>
  isWindows
    ? `'${s.replaceAll("'", "''")}'`
    : `'${s.replaceAll("'", "'\\''")}'`;

/** A fake OpenCode playing `runs` in order. Its folder is removed by `dispose`. */
export function fakeOpencode(runs: FakeRun[]): {
  /** The command line to give `Platform.opencodeCommand` as its `base`. */
  base: string;
  /** The real platform for this OS, starting the fake whatever `base` it is given. */
  platform: Pick<Platform, 'opencodeCommand'>;
  calls(): FakeCall[];
  dispose(): void;
} {
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'shellie-fake-opencode-')),
  );
  const script = path.join(dir, 'opencode.cjs');
  const scenario = path.join(dir, 'scenario.json');
  fs.writeFileSync(script, SCRIPT);
  fs.writeFileSync(scenario, JSON.stringify({ runs }));
  const base = [process.execPath, script, scenario].map(quote).join(' ');
  const real = testPlatform();
  return {
    base,
    platform: {
      opencodeCommand: (_own, args, prompt) =>
        real.opencodeCommand(base, args, prompt),
    },
    calls: () =>
      runs
        .map((_, i) => `${scenario}.call${i}`)
        .filter((f) => fs.existsSync(f))
        .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as FakeCall),
    dispose: () =>
      fs.rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      }),
  };
}
