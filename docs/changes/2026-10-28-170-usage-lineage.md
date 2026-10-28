# Usage lineage

Usage tab (#170, 2026-10-28, `agent/issues/170-detailed-cost-lineage-per-task`): the Sessions card has a Sessions / Lineage switch. Lineage (`UsageLineage`) is a foldable tree with one root per billable session (tool and start time) and the subagents it started below it. Each row shows a dot in its model family's colour, the short model name, the effort when the tool reports one, a cost share bar, the share and the euros; hover gives tokens, requests and cost. Totals include the children, so the roots add up to the Billable total. Sessions marked not billable are left out, as in the ring.

The tree is built in the main process (`buildUsageTree` in `src/shared/usageViews.ts`, called from `UsageStore.summarize`) and sent as the optional `TaskUsage.lineage`, so older renderers ignore it. Prices and the cost calculation are unchanged; requests are only regrouped.

Where the subagent comes from:

- Claude Code: the Usage tab gets its numbers from Claude Code's telemetry (`claude_code.api_request`), not from the transcripts, so the subagent is read there: `query_source` `agent:builtin:Explore` becomes "Explore", `agent:custom` becomes "Subagent", anything else is the main thread (`subagentOf` in `src/main/usage/otlp.ts`). The `effort` attribute is kept too. Telemetry has no per-run subagent id, so runs of the same subagent type in one session share one row.
- OpenCode: a subagent runs in a child session. The reader takes `session.parent_id` for each message (skipped when an older database has no such column) and the message's `agent` (or `mode`) as the name; the ledger passes both to the Usage tab, so a child session sits under its parent session.
- Copilot CLI: flat roots, no parent data.

Known gaps: effort shows only for Claude Code. Requests already on the Usage tab before this change have no subagent data and stay on their session's own row. The `agent:` values of `query_source` come from Claude Code's naming and are not in the recorded fixture (it holds only `sdk` and `main`). Not verified in the running app or on Windows.
