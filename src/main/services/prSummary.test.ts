import { describe, expect, it } from 'vitest';
import {
  claudeResult,
  PR_PROMPT_MAX,
  PR_SUMMARY_MAX,
  prSummaryFlags,
  prSummaryPrompt,
  runWithInput,
  ExitError,
  tidySummary,
  TURN_CUT,
  TURNS_MAX,
  WORK_ITEM_MAX,
  prOpencodeArgs,
  prOpencodeEnv,
  programMissing,
  type PrSummaryContext,
} from './prSummary';

const ctx: PrSummaryContext = {
  heading:
    'Bug 8221: PDP Variant selector | color selections point to same sku',
  log: '- abc1234 Map each colour to its own SKU\n  The selector reused the first variant.',
  stat: ' src/variant.ts | 12 ++++++------\n 1 file changed',
  diff: 'diff --git a/src/variant.ts b/src/variant.ts\n+const sku = variant.sku;',
  workItem:
    '## Work item\n\n### Description\n\nEvery colour button opens the first SKU.\n\n### Acceptance criteria\n\nEach colour opens its own SKU.',
  turns: [
    {
      who: 'Developer',
      text: 'The colour buttons all open the same SKU, fix that',
    },
    {
      who: 'Claude',
      text: 'The selector reused variants[0]; I map each colour to its SKU and added a test.',
    },
  ],
  style: null,
};

describe('prSummaryPrompt', () => {
  it('holds the work item text, the session, the commits, the stat and the diff', () => {
    const p = prSummaryPrompt(ctx);
    expect(p).toContain(ctx.heading);
    expect(p).toContain('Each colour opens its own SKU.');
    expect(p).toContain('Developer: The colour buttons all open the same SKU');
    expect(p).toContain('Agent: The selector reused variants[0]');
    expect(p).toContain('## How it works');
    expect(p).toContain('## How it was verified');
    expect(p).toContain('Map each colour to its own SKU');
    expect(p).toContain('1 file changed');
    expect(p).toContain('+const sku = variant.sku;');
    expect(p).toContain('## What changed');
    expect(p).toContain('## Why');
    expect(p).not.toContain('style guide');
  });

  it("adds the repo's own style when it has one", () => {
    const p = prSummaryPrompt({ ...ctx, style: 'Write in Dutch.' });
    expect(p).toContain('Write in Dutch.');
  });

  it('says so when nothing was said in the sessions', () => {
    expect(prSummaryPrompt({ ...ctx, turns: [] })).toContain('(none recorded)');
  });

  it('keeps the newest turns within the budget, oldest first, each cut', () => {
    const turns = Array.from({ length: 100 }, (_, i) => ({
      who: i % 2 ? ('Agent' as const) : ('Developer' as const),
      text: `turn-${i} ${'x'.repeat(2000)}`,
    }));
    const p = prSummaryPrompt({ ...ctx, turns });
    const section = p.slice(
      p.indexOf('# What was done'),
      p.indexOf('# Commits'),
    );
    expect(section.length).toBeLessThan(TURNS_MAX + 200);
    expect(section).toContain('turn-99');
    expect(section).not.toContain('turn-0 ');
    expect(section).toMatch(/earlier turns left out/);
    expect(section.indexOf('turn-98')).toBeLessThan(section.indexOf('turn-99'));
    const line = section.split('\n').find((l) => l.includes('turn-99'))!;
    expect(line.length).toBeLessThanOrEqual('Agent: '.length + TURN_CUT);
  });

  it('cuts a long work item', () => {
    const p = prSummaryPrompt({ ...ctx, workItem: 'w'.repeat(50_000) });
    expect(p.split('w'.repeat(100)).length).toBeLessThan(
      WORK_ITEM_MAX / 100 + 2,
    );
    expect(p).toContain('[cut]');
  });

  it('works without a work item file', () => {
    expect(prSummaryPrompt({ ...ctx, workItem: null })).toContain(
      `# Work item\n${ctx.heading}\n\n# What was done`,
    );
  });

  it('stays within the prompt budget, cutting the diff first', () => {
    const p = prSummaryPrompt({
      ...ctx,
      diff: 'd'.repeat(500_000),
      log: 'l'.repeat(100_000),
      workItem: 'w'.repeat(100_000),
      turns: Array.from({ length: 200 }, () => ({
        who: 'Developer' as const,
        text: 'r'.repeat(800),
      })),
    });
    expect(p.length).toBeLessThanOrEqual(PR_PROMPT_MAX);
    expect(p).toContain('[cut]');
    expect(p).toContain(ctx.heading);
    expect(p).toContain('## Why');
  });
});

describe('claudeResult', () => {
  it('returns the result of a successful run', () => {
    expect(
      claudeResult(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '## What changed\n- x',
        }),
      ),
    ).toBe('## What changed\n- x');
  });

  it('finds the result in an array of messages', () => {
    expect(
      claudeResult(
        JSON.stringify([
          { type: 'system' },
          { type: 'result', subtype: 'success', result: 'ok' },
        ]),
      ),
    ).toBe('ok');
  });

  it('skips lines a login shell printed before the JSON', () => {
    expect(
      claudeResult(
        `Welcome back\n${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`,
      ),
    ).toBe('ok');
  });

  it('throws on an error result or output that is not JSON', () => {
    expect(() =>
      claudeResult(
        JSON.stringify({
          type: 'result',
          subtype: 'error_max_budget_usd',
          is_error: true,
          result: '',
        }),
      ),
    ).toThrow(/error_max_budget_usd/);
    expect(() => claudeResult('Invalid API key')).toThrow(/Invalid API key/);
  });
});

describe('tidySummary', () => {
  it('drops a fence around the text and a title line', () => {
    expect(
      tidySummary(
        '```markdown\n# Fix the selector\n\n## What changed\n- x\n```',
      ),
    ).toBe('## What changed\n- x');
  });

  it('cuts at a line under the limit', () => {
    const text = tidySummary(
      Array.from({ length: 400 }, (_, i) => `- line ${i}`).join('\n'),
    );
    expect(text.length).toBeLessThanOrEqual(PR_SUMMARY_MAX);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('prSummaryFlags', () => {
  it('runs Claude Code once, printing JSON, without tools that write and without saving the session', () => {
    const f = prSummaryFlags();
    expect(f).toContain('-p');
    expect(f.join(' ')).toContain('--output-format json');
    expect(f).toContain('--no-session-persistence');
    expect(f).toContain('--strict-mcp-config');
    expect(f.join(' ')).toMatch(/--tools Read,Grep,Glob/);
    expect(f.join(' ')).toMatch(/--max-budget-usd \d/);
    // Flags only: the prompt goes through stdin, never the command line.
    expect(f.every((x) => x.length < 40)).toBe(true);
  });

  it('runs the chosen model, Sonnet by default', () => {
    expect(prSummaryFlags().join(' ')).toContain('--model sonnet');
    expect(prSummaryFlags('haiku').join(' ')).toContain('--model haiku');
    expect(prSummaryFlags('haiku').join(' ')).toContain(
      '--max-budget-usd 0.50',
    );
  });
});

describe('the OpenCode writer', () => {
  it('runs once with json events and its own title, prompt on stdin', () => {
    expect(prOpencodeArgs()).toEqual([
      'run',
      '--format',
      'json',
      '--title',
      'Shellie PR description',
    ]);
  });

  it('may only read: edit, bash and webfetch are denied', () => {
    const env = prOpencodeEnv({ A: '1' });
    expect(env.A).toBe('1');
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({
      permission: { edit: 'deny', bash: 'deny', webfetch: 'deny' },
    });
    expect(
      JSON.parse(prOpencodeEnv({}, ['.env']).OPENCODE_CONFIG_CONTENT).permission
        .read,
    ).toEqual({ '*': 'allow', '.env': 'deny' });
  });
});

describe('runWithInput', () => {
  const node = process.execPath;
  it('sends the input on stdin and returns stdout', async () => {
    const out = await runWithInput(
      {
        command: node,
        args: [
          '-e',
          "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s.toUpperCase()+process.env.EXTRA))",
        ],
        env: { EXTRA: '!' },
      },
      { cwd: process.cwd(), input: 'hello', timeoutMs: 10_000 },
    );
    expect(out).toBe('HELLO!');
  });

  it('rejects with the last stderr line on a failed exit', async () => {
    await expect(
      runWithInput(
        {
          command: node,
          args: ['-e', "console.error('first\\nboom');process.exit(3)"],
        },
        { cwd: process.cwd(), input: '', timeoutMs: 10_000 },
      ),
    ).rejects.toThrow(/boom/);
  });

  it('keeps the exit code and stdout on the error of a failed exit', async () => {
    const e = await runWithInput(
      {
        command: node,
        args: [
          '-e',
          'process.stdout.write(\'{"type":"error"}\');process.exit(1)',
        ],
      },
      { cwd: process.cwd(), input: '', timeoutMs: 10_000 },
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ExitError);
    expect(e).toMatchObject({
      message: 'exited with code 1',
      exitCode: 1,
      stdout: '{"type":"error"}',
    });
  });

  it('says the program is missing on exit code 127', async () => {
    await expect(
      runWithInput(
        { command: node, args: ['-e', 'process.exit(127)'] },
        { cwd: process.cwd(), input: '', timeoutMs: 10_000 },
      ),
    ).rejects.toThrow(/not found/);
  });

  it('kills a run that takes too long', async () => {
    await expect(
      runWithInput(
        { command: node, args: ['-e', 'setTimeout(() => {}, 10000)'] },
        { cwd: process.cwd(), input: '', timeoutMs: 200 },
      ),
    ).rejects.toThrow(/timed out/);
  });
});

describe('programMissing', () => {
  it('knows a missing program from a failing one', () => {
    expect(
      programMissing(Object.assign(new Error('spawn'), { code: 'ENOENT' })),
    ).toBe(true);
    expect(
      programMissing(
        new ExitError('Claude Code (claude) was not found', 127, ''),
      ),
    ).toBe(true);
    expect(
      programMissing(
        new ExitError(
          "claude : The term 'claude' is not recognized as the name of a cmdlet, function, script file",
          1,
          '',
        ),
      ),
    ).toBe(true);
    expect(
      programMissing(new ExitError('model not found: claude-x', 1, '')),
    ).toBe(false);
    expect(
      programMissing(new Error('Claude Code (claude) was not found')),
    ).toBe(false);
  });
});

describe('runWithInput abort', () => {
  it('kills the run and rejects with stopped', async () => {
    const ac = new AbortController();
    const p = runWithInput(
      {
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 10000)'],
      },
      { cwd: process.cwd(), input: '', timeoutMs: 20_000, signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toThrow('stopped');
  });
});
