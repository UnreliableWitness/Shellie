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
  userRequests,
  type PrSummaryContext,
} from './prSummary';

const ctx: PrSummaryContext = {
  heading:
    'Bug 8221: PDP Variant selector | color selections point to same sku',
  log: '- abc1234 Map each colour to its own SKU\n  The selector reused the first variant.',
  stat: ' src/variant.ts | 12 ++++++------\n 1 file changed',
  diff: 'diff --git a/src/variant.ts b/src/variant.ts\n+const sku = variant.sku;',
  requests: ['The colour buttons all open the same SKU, fix that'],
  style: null,
};

describe('prSummaryPrompt', () => {
  it('holds the work item, the requests, the commits, the stat and the diff', () => {
    const p = prSummaryPrompt(ctx);
    expect(p).toContain(ctx.heading);
    expect(p).toContain('The colour buttons all open the same SKU');
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

  it('says so when there are no requests', () => {
    expect(prSummaryPrompt({ ...ctx, requests: [] })).toContain(
      '(none recorded)',
    );
  });

  it('stays within the prompt budget, cutting the diff first', () => {
    const p = prSummaryPrompt({
      ...ctx,
      diff: 'd'.repeat(500_000),
      log: 'l'.repeat(100_000),
      requests: Array.from({ length: 200 }, () => 'r'.repeat(800)),
    });
    expect(p.length).toBeLessThanOrEqual(PR_PROMPT_MAX);
    expect(p).toContain('[cut]');
    expect(p).toContain(ctx.heading);
    expect(p).toContain('## Why');
  });
});

describe('userRequests', () => {
  const line = (o: object) => JSON.stringify(o);
  it('keeps what the developer typed, not tool results, commands or meta lines', () => {
    const lines = [
      line({
        type: 'user',
        message: { role: 'user', content: 'Fix the colour selector' },
      }),
      line({
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: 'caveat' },
      }),
      line({
        type: 'user',
        message: {
          role: 'user',
          content: '<command-name>/clear</command-name>',
        },
      }),
      line({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'output' }],
        },
      }),
      line({
        type: 'user',
        isSidechain: true,
        message: { role: 'user', content: 'subagent prompt' },
      }),
      line({
        type: 'assistant',
        message: { role: 'assistant', content: 'Sure' },
      }),
      line({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Also keep the size picker' }],
        },
      }),
      'not json',
      line({
        type: 'user',
        message: { role: 'user', content: 'Fix the colour selector' },
      }),
    ];
    expect(userRequests(lines)).toEqual([
      'Fix the colour selector',
      'Also keep the size picker',
    ]);
  });

  it('shortens long messages', () => {
    const [r] = userRequests([
      line({ type: 'user', message: { content: 'x'.repeat(5000) } }),
    ]);
    expect(r.length).toBeLessThanOrEqual(801);
    expect(r.endsWith('…')).toBe(true);
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
