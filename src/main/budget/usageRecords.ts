import type { BudgetRecord } from '../../shared/budget';
import type { UsageRecord } from '../../shared/usage';

/** Budget records from the usage store: Copilot CLI requests and Shellie's own `claude -p` runs (PR descriptions). Claude tab usage comes from the transcripts, so it is dropped here. */
export function budgetRecordsFromUsage(records: UsageRecord[]): BudgetRecord[] {
  const out: BudgetRecord[] = [];
  for (const r of records) {
    let id: string;
    let provider: string;
    if (r.tool === 'copilot-cli') {
      id = `cp:${r.id}`;
      provider = 'github-copilot';
    } else if (r.tool === 'claude-code' && r.source === 'pr-summary') {
      id = `sh:${r.id}`;
      provider = 'anthropic';
    } else continue;
    out.push({
      id,
      tool: r.tool,
      sessionId: r.sessionId,
      model: r.model,
      provider,
      at: r.at,
      cwd: null,
      fast: r.fast,
      taskId: r.taskId,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheWrite5mTokens: r.cacheWriteTokens,
      cacheWrite1hTokens: 0,
    });
  }
  return out;
}
