import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  promises as fsp,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ClaudeTranscriptReader,
  parseTranscriptLine,
} from './claudeTranscripts';

const line = (
  o: {
    id?: string;
    model?: string;
    usage?: object;
    type?: string;
    speed?: string;
  } = {},
) =>
  JSON.stringify({
    type: o.type ?? 'assistant',
    timestamp: '2026-10-07T11:21:00.626Z',
    sessionId: 's1',
    cwd: '/w/repo',
    message: {
      id: o.id ?? 'msg_1',
      model: o.model ?? 'claude-opus-5-5',
      usage: o.usage ?? {
        input_tokens: 2,
        output_tokens: 87,
        cache_read_input_tokens: 25716,
        cache_creation_input_tokens: 20289,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 20289,
        },
        speed: o.speed ?? 'standard',
      },
    },
  });

describe('parseTranscriptLine', () => {
  it('reads an assistant line with the 5m/1h split', () => {
    expect(parseTranscriptLine(line())).toEqual({
      id: 'cc:msg_1',
      tool: 'claude-code',
      sessionId: 's1',
      model: 'claude-opus-5-5',
      provider: 'anthropic',
      at: '2026-10-07T11:21:00.626Z',
      cwd: '/w/repo',
      fast: false,
      inputTokens: 2,
      outputTokens: 87,
      cacheReadTokens: 25716,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 20289,
    });
  });
  it('treats cache writes as 5-minute when the split is missing', () => {
    const r = parseTranscriptLine(
      line({
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 50,
        },
      }),
    );
    expect(r).toMatchObject({
      cacheWrite5mTokens: 50,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0,
    });
  });
  it('marks fast mode', () => {
    const r = parseTranscriptLine(
      line({ usage: { input_tokens: 1, output_tokens: 1, speed: 'fast' } }),
    );
    expect(r?.fast).toBe(true);
  });
  it('skips user lines, synthetic models, lines without usage and garbage', () => {
    expect(parseTranscriptLine(line({ type: 'user' }))).toBeNull();
    expect(parseTranscriptLine(line({ model: '<synthetic>' }))).toBeNull();
    expect(
      parseTranscriptLine(
        JSON.stringify({ type: 'assistant', message: { id: 'x' } }),
      ),
    ).toBeNull();
    expect(parseTranscriptLine('{not json')).toBeNull();
    for (const x of ['null', '42', '"x"'])
      expect(parseTranscriptLine(x)).toBeNull();
  });
});

describe('ClaudeTranscriptReader', () => {
  const setup = () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    mkdirSync(path.join(root, 'proj', 's1', 'subagents'), { recursive: true });
    return root;
  };

  it('reads nested files and only new lines on the next pass', async () => {
    const root = setup();
    const f = path.join(root, 'proj', 's1.jsonl');
    writeFileSync(f, `${line({ id: 'a' })}\n`);
    writeFileSync(
      path.join(root, 'proj', 's1', 'subagents', 'x.jsonl'),
      `${line({ id: 'b' })}\n`,
    );
    const reader = new ClaudeTranscriptReader(root);
    const first = await reader.read({});
    expect(first.records.map((r) => r.id).sort()).toEqual(['cc:a', 'cc:b']);
    appendFileSync(f, `${line({ id: 'c' })}\n`);
    const second = await reader.read(first.cursors);
    expect(second.records.map((r) => r.id)).toEqual(['cc:c']);
  });

  it('leaves a half-written last line for the next pass', async () => {
    const root = setup();
    const f = path.join(root, 'proj', 's1.jsonl');
    const full = line({ id: 'a' });
    writeFileSync(f, full.slice(0, 30));
    const reader = new ClaudeTranscriptReader(root);
    const first = await reader.read({});
    expect(first.records).toEqual([]);
    appendFileSync(f, `${full.slice(30)}\n`);
    expect((await reader.read(first.cursors)).records.map((r) => r.id)).toEqual(
      ['cc:a'],
    );
  });

  it('re-reads a file that shrank', async () => {
    const root = setup();
    const f = path.join(root, 'proj', 's1.jsonl');
    writeFileSync(f, `${line({ id: 'a' })}\n${line({ id: 'b' })}\n`);
    const reader = new ClaudeTranscriptReader(root);
    const first = await reader.read({});
    writeFileSync(f, `${line({ id: 'z' })}\n`);
    expect((await reader.read(first.cursors)).records.map((r) => r.id)).toEqual(
      ['cc:z'],
    );
  });

  it('skips unseen files older than `since`', async () => {
    const root = setup();
    writeFileSync(
      path.join(root, 'proj', 'old.jsonl'),
      `${line({ id: 'old' })}\n`,
    );
    const reader = new ClaudeTranscriptReader(root, {
      since: Date.now() + 60_000,
    });
    expect((await reader.read({})).records).toEqual([]);
  });

  it('reads a file larger than one chunk exactly once and leaves a partial tail', async () => {
    const root = setup();
    const f = path.join(root, 'proj', 's1.jsonl');
    const ids = Array.from({ length: 20 }, (_, i) => `m${i}`);
    const partial = line({ id: 'tail' });
    writeFileSync(
      f,
      ids.map((i) => `${line({ id: i })}\n`).join('') + partial.slice(0, 40),
    );
    const reader = new ClaudeTranscriptReader(root, { chunkBytes: 64 });
    const first = await reader.read({});
    expect(first.records.map((r) => r.id)).toEqual(ids.map((i) => `cc:${i}`));
    appendFileSync(f, `${partial.slice(40)}\n`);
    expect((await reader.read(first.cursors)).records.map((r) => r.id)).toEqual(
      ['cc:tail'],
    );
  });

  it('skips a file that vanishes between listing and reading, keeping its cursor', async () => {
    const root = setup();
    const gone = path.join(root, 'proj', 'gone.jsonl');
    const ok = path.join(root, 'proj', 'ok.jsonl');
    writeFileSync(gone, `${line({ id: 'g' })}\n`);
    writeFileSync(ok, `${line({ id: 'o' })}\n`);
    const reader = new ClaudeTranscriptReader(root);
    const first = await reader.read({});
    appendFileSync(gone, `${line({ id: 'g2' })}\n`);
    appendFileSync(ok, `${line({ id: 'o2' })}\n`);
    const real = fsp.open.bind(fsp);
    const spy = vi
      .spyOn(fsp, 'open')
      .mockImplementation(((p: string, ...rest: unknown[]) =>
        p === gone
          ? Promise.reject(
              Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
            )
          : (real as (...a: unknown[]) => unknown)(p, ...rest)) as never);
    try {
      const second = await reader.read(first.cursors);
      expect(second.records.map((r) => r.id)).toEqual(['cc:o2']);
      expect(second.cursors[gone]).toEqual(first.cursors[gone]);
    } finally {
      spy.mockRestore();
    }
  });

  it('reports a missing folder as not found', async () => {
    const r = await new ClaudeTranscriptReader('/no/such/dir').read({});
    expect(r).toEqual({ records: [], cursors: {}, found: false });
  });
});
