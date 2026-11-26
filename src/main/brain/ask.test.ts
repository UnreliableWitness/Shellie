import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { BRAIN_JOB_TITLE } from '../../shared/brain';
import { ASK_CAP_MESSAGE } from '../../shared/brainAsk';
import type { Command } from '../platform/Platform';
import {
  askClaudeFlags,
  askOpencodeArgs,
  askOpencodePermission,
  BrainAsks,
  opencodeConfigFiles,
  opencodeRulePatterns,
  type BrainAsksDeps,
} from './ask';
import { brainOpencodePermission } from './templates';

const claudeOut = (result: string, id: string) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    result,
    session_id: id,
  });

type Call = {
  cmd: Command;
  cwd: string;
  input: string;
  timeoutMs: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
};
let calls: Call[];
let run: (cmd: Command, o: Omit<Call, 'cmd'>) => Promise<string>;
let clock: number;

function asks(over: Partial<BrainAsksDeps> = {}) {
  return new BrainAsks({
    platform: {
      claudeCommand: (_c, flags) => ({ command: 'claude', args: flags ?? [] }),
      opencodeCommand: (_b, args) => ({
        command: 'opencode',
        args: args ?? [],
      }),
    },
    run: (cmd, o) => {
      calls.push({ cmd, ...o });
      return run(cmd, o);
    },
    env: (id) => ({ SHELLIE_BRAIN_ID: id }),
    tokensToday: () => 0,
    cap: () => 100,
    brainDir: (id) => `/brains/${id}`,
    model: () => 'sonnet',
    agent: () => 'claude',
    opencodeModel: () => null,
    ready: () => true,
    now: () => clock,
    heldReason: () => 'The skills are out of date',
    costOf: () => 0.03,
    rulePatterns: async () => ({ edit: [], bash: [] }),
    snapshot: async () => 'same',
    ...over,
  });
}

beforeEach(() => {
  calls = [];
  clock = 1000;
  run = async () => {
    clock += 18_000;
    return claudeOut('Semicolons. Sources:\n- wiki/a.md', 's1');
  };
});

describe('the ask flags', () => {
  it('gives Claude Code only reading tools and never acceptEdits', () => {
    const f = askClaudeFlags('sonnet', null);
    expect(f).toEqual(
      expect.arrayContaining([
        '-p',
        '--tools',
        'Read,Glob,Grep',
        '--strict-mcp-config',
        '--model',
        'sonnet',
      ]),
    );
    expect(f).not.toContain('acceptEdits');
    expect(f).not.toContain('--resume');
    expect(f[f.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
    const again = askClaudeFlags('sonnet', 's1');
    expect(again[again.indexOf('--resume') + 1]).toBe('s1');
    expect(again[again.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
  });

  it("denies every edit and command on OpenCode, the brain's own allowed git commands too", () => {
    const p = askOpencodePermission();
    expect(p.webfetch).toBe('deny');
    expect(p.edit['*']).toBe('deny');
    expect(p.bash['*']).toBe('deny');
    // A rule in the brain's opencode.json for a narrower pattern would win over '*': each is denied by name.
    for (const pattern of Object.keys(brainOpencodePermission().bash))
      expect(p.bash[pattern]).toBe('deny');
    for (const pattern of Object.keys(brainOpencodePermission().edit))
      expect(p.edit[pattern]).toBe('deny');
    expect(new Set(Object.values(p.bash))).toEqual(new Set(['deny']));
    expect(new Set(Object.values(p.edit))).toEqual(new Set(['deny']));
  });

  it("denies the patterns the brain's own opencode.json names as well", () => {
    const p = askOpencodePermission({
      edit: ['wiki/**'],
      bash: ['npm run *', 'git diff*'],
    });
    expect(p.edit['wiki/**']).toBe('deny');
    expect(p.bash['npm run *']).toBe('deny');
    expect(p.bash['git diff*']).toBe('deny');
  });

  it('reads the rule patterns of every config, with comments and trailing commas, agents included', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'brain-ask-'));
    const a = path.join(dir, 'opencode.json');
    const b = path.join(dir, 'opencode.jsonc');
    expect(await opencodeRulePatterns([a, b])).toEqual({ edit: [], bash: [] });
    await writeFile(
      a,
      JSON.stringify({
        permission: {
          edit: { '*': 'allow', 'wiki/**': 'allow' },
          bash: { 'npm run *': 'allow' },
          webfetch: 'deny',
        },
      }),
    );
    await writeFile(
      b,
      `{
  // the person's own rules, "//" inside a string stays: "http://x"
  "permission": { "bash": { "git *": "allow", /* block */ "ls http://x": "allow", }, "edit": "allow" },
  "agent": { "build": { "permission": { "bash": { "make *": "allow" }, "edit": { "*.md": "allow" } } } },
}`,
    );
    expect(await opencodeRulePatterns([a, b])).toEqual({
      edit: ['*', 'wiki/**', '*.md'],
      bash: ['npm run *', 'git *', 'ls http://x', 'make *'],
    });
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses rules it cannot read rather than guess', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'brain-ask-'));
    const a = path.join(dir, 'opencode.json');
    await writeFile(a, '{ not json');
    await expect(opencodeRulePatterns([a])).rejects.toThrow(
      `Shellie could not read ${a}, so it cannot make sure a question only reads. Fix the file, or ask in the brain's terminal.`,
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('sends OpenCode a plain message, never a command whose template runs shell snippets', () => {
    const a = askOpencodeArgs('p/m', 's9');
    expect(a[0]).toBe('run');
    // `--command` puts the question through the command template, where !`…` runs in the shell and @path attaches a file.
    expect(a).not.toContain('--command');
    expect(a[a.indexOf('--title') + 1].startsWith(BRAIN_JOB_TITLE)).toBe(true);
    expect(a[a.indexOf('-m') + 1]).toBe('p/m');
    expect(a[a.indexOf('--session') + 1]).toBe('s9');
    expect(askOpencodeArgs(null, null)).not.toContain('--session');
    expect(askOpencodeArgs(null, null)).not.toContain('-m');
  });

  it('takes the web search, code search and subagent tools away on OpenCode', () => {
    const p = askOpencodePermission();
    expect(p.websearch).toBe('deny');
    expect(p.codesearch).toBe('deny');
    expect(p.task).toBe('deny');
  });

  it("lists every OpenCode config a run loads: the brain's and the person's own", () => {
    expect(
      opencodeConfigFiles(
        '/b',
        { OPENCODE_CONFIG: '/x/custom.json' },
        '/home/me',
      ),
    ).toEqual([
      path.join('/b', 'opencode.json'),
      path.join('/b', 'opencode.jsonc'),
      path.join('/b', '.opencode', 'opencode.json'),
      path.join('/b', '.opencode', 'opencode.jsonc'),
      path.join('/home/me', '.config', 'opencode', 'opencode.json'),
      path.join('/home/me', '.config', 'opencode', 'opencode.jsonc'),
      '/x/custom.json',
    ]);
    expect(
      opencodeConfigFiles('/b', { XDG_CONFIG_HOME: '/cfg' }, '/home/me'),
    ).toContain(path.join('/cfg', 'opencode', 'opencode.jsonc'));
  });
});

describe('BrainAsks', () => {
  it('sends the question on stdin as the ask prompt, in the brain folder, with the brain env and a 180 s limit', async () => {
    await asks().ask('t1', 'b1', 'Why? (ctx)', null);
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe('/brains/b1');
    expect(calls[0].input).toBe('/ask Why? (ctx)');
    expect(calls[0].timeoutMs).toBe(180_000);
    expect(calls[0].env).toEqual({ SHELLIE_BRAIN_ID: 'b1' });
    expect(calls[0].cmd.args).toEqual(askClaudeFlags('sonnet', null));
  });

  it('returns the answer, the session, the duration and the cost', async () => {
    expect(await asks().ask('t1', 'b1', 'Why?', null)).toEqual({
      ok: true,
      answer: {
        sessionId: 's1',
        answer: 'Semicolons. Sources:\n- wiki/a.md',
        durationMs: 18_000,
        costEur: 0.03,
        changed: false,
      },
    });
  });

  it("says so when the brain's folder changed while the question ran", async () => {
    let n = 0;
    const out = await asks({ snapshot: async () => `state ${n++}` }).ask(
      't1',
      'b1',
      'Why?',
      null,
    );
    expect(out.ok && out.answer.changed).toBe(true);
    // A folder whose state cannot be read is not called unchanged.
    const blind = await asks({
      snapshot: async () => {
        throw new Error('not a git repo');
      },
    }).ask('t2', 'b1', 'Why?', null);
    expect(blind.ok && blind.answer.changed).toBe(true);
  });

  it('refuses an OpenCode question when its rules cannot be read', async () => {
    const out = await asks({
      agent: () => 'opencode',
      rulePatterns: async () => {
        throw new Error('Shellie could not read /b/opencode.json');
      },
    }).ask('t1', 'b1', 'Why?', null);
    expect(out).toEqual({
      ok: false,
      refused: null,
      message: 'Shellie could not read /b/opencode.json',
    });
    expect(calls).toHaveLength(0);
  });

  it('leaves the cost out when it cannot be read', async () => {
    const out = await asks({
      costOf: () => {
        throw new Error('no ledger');
      },
    }).ask('t1', 'b1', 'Why?', null);
    expect(out.ok && out.answer.costEur).toBe(null);
  });

  it('resumes the session on a follow-up', async () => {
    await asks().ask('t1', 'b1', 'And then?', 's1');
    expect(calls[0].cmd.args).toEqual(askClaudeFlags('sonnet', 's1'));
  });

  it('denies every edit and command on OpenCode, on a follow-up too', async () => {
    run = async () =>
      [
        JSON.stringify({
          type: 'text',
          sessionID: 'o1',
          part: { type: 'text', text: 'An answer' },
        }),
      ].join('\n');
    const a = asks({
      agent: () => 'opencode',
      opencodeModel: () => 'p/m',
      rulePatterns: async () => ({ edit: [], bash: ['make *'] }),
    });
    await a.ask('t1', 'b1', 'Why? (ctx)', 's1');
    const c = calls[0];
    expect(c.cmd.command).toBe('opencode');
    expect(c.cmd.args).toEqual(askOpencodeArgs('p/m', 's1'));
    expect(c.input).toBe(
      'Load the ask skill and answer from this brain, reading only: Why? (ctx)',
    );
    expect(JSON.parse(c.env?.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      permission: askOpencodePermission({ edit: [], bash: ['make *'] }),
    });
    expect(
      JSON.parse(c.env?.OPENCODE_CONFIG_CONTENT ?? '{}').permission.bash[
        'make *'
      ],
    ).toBe('deny');
    expect(c.env?.SHELLIE_BRAIN_ID).toBe('b1');
  });

  it('is refused at the daily cap without running', async () => {
    const out = await asks({ tokensToday: () => 100 }).ask(
      't1',
      'b1',
      'Why?',
      null,
    );
    expect(out).toEqual({
      ok: false,
      refused: 'cap',
      message: ASK_CAP_MESSAGE,
    });
    expect(calls).toHaveLength(0);
  });

  it('is refused while the brain is held, with the reason', async () => {
    const out = await asks({ ready: () => false }).ask(
      't1',
      'b1',
      'Why?',
      null,
    );
    expect(out).toEqual({
      ok: false,
      refused: 'held',
      message: 'The skills are out of date',
    });
    expect(calls).toHaveLength(0);
  });

  it('stop aborts the run and resolves Stopped', async () => {
    run = (_c, o) =>
      new Promise((_res, rej) =>
        o.signal?.addEventListener('abort', () => rej(new Error('stopped'))),
      );
    const a = asks();
    const p = a.ask('t1', 'b1', 'Why?', null);
    await Promise.resolve();
    a.stop('t1');
    expect(await p).toEqual({ ok: false, refused: null, message: 'Stopped' });
    // The key is free again.
    run = async () => claudeOut('ok', 's2');
    expect((await a.ask('t1', 'b1', 'Again?', null)).ok).toBe(true);
  });

  it('says the program is missing in plain words', async () => {
    run = async () => {
      throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    };
    expect(await asks().ask('t1', 'b1', 'Why?', null)).toEqual({
      ok: false,
      refused: null,
      message: 'Claude Code was not found',
    });
    expect(
      await asks({ agent: () => 'opencode' }).ask('t2', 'b1', 'Why?', null),
    ).toEqual({
      ok: false,
      refused: null,
      message: 'OpenCode (opencode) was not found',
    });
  });

  it('reports a run that printed nothing as a failure', async () => {
    run = async () => '';
    const out = await asks().ask('t1', 'b1', 'Why?', null);
    expect(out).toEqual({
      ok: false,
      refused: null,
      message: 'Claude Code printed nothing',
    });
  });

  it('refuses a second question for the same key while one runs', async () => {
    let finish: (s: string) => void = () => undefined;
    run = () => new Promise((res) => (finish = res));
    const a = asks();
    const first = a.ask('t1', 'b1', 'Why?', null);
    await Promise.resolve();
    await expect(a.ask('t1', 'b1', 'Again?', null)).rejects.toThrow(
      'A question is already running',
    );
    finish(claudeOut('ok', 's1'));
    expect((await first).ok).toBe(true);
  });

  it('a question starting with "-" or "/" stays stdin text', async () => {
    await asks().ask('t1', 'b1', '--help', null);
    expect(calls[0].cmd.args).not.toContain('--help');
    expect(calls[0].input).toBe('/ask --help');
  });
});
