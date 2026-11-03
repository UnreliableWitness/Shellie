import { describe, expect, it } from 'vitest';
import type { UsageRecord } from '../../shared/usage';
import { budgetRecordsFromUsage } from './usageRecords';

const rec = (over: Partial<UsageRecord>): UsageRecord => ({
  id: 'x',
  taskId: 't1',
  tool: 'claude-code',
  sessionId: 's1',
  model: 'claude-sonnet-4-5',
  at: '2026-10-20T10:00:00.000Z',
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 30,
  cacheWriteTokens: 40,
  fast: false,
  costUsd: 1,
  rateId: 'r',
  rate: null,
  ...over,
});

describe('budgetRecordsFromUsage', () => {
  it('admits brain records with a br: id', () => {
    const out = budgetRecordsFromUsage([
      rec({ id: 'req_9', source: 'brain', taskId: 'brain:b1' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'br:req_9',
      taskId: 'brain:b1',
      provider: 'anthropic',
    });
  });
  it('maps Copilot CLI and PR summary records, drops tab records', () => {
    const out = budgetRecordsFromUsage([
      rec({ id: 'tr:sp', tool: 'copilot-cli', model: 'gpt-5' }),
      rec({ id: 'req_1', source: 'pr-summary' }),
      rec({ id: 'req_2' }),
    ]);
    expect(out).toEqual([
      {
        id: 'cp:tr:sp',
        tool: 'copilot-cli',
        sessionId: 's1',
        model: 'gpt-5',
        provider: 'github-copilot',
        at: '2026-10-20T10:00:00.000Z',
        cwd: null,
        fast: false,
        taskId: 't1',
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWrite5mTokens: 40,
        cacheWrite1hTokens: 0,
      },
      {
        id: 'sh:req_1',
        tool: 'claude-code',
        sessionId: 's1',
        model: 'claude-sonnet-4-5',
        provider: 'anthropic',
        at: '2026-10-20T10:00:00.000Z',
        cwd: null,
        fast: false,
        taskId: 't1',
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWrite5mTokens: 40,
        cacheWrite1hTokens: 0,
      },
    ]);
  });
});
