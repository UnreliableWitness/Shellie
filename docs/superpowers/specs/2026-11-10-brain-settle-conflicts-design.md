# Brain: settling conflicts without a terminal

Date: 2026-11-10. Status: design, awaiting the owner's approval.

Mockups: the Claude Design canvas https://claude.ai/artifact/JWaKY49q1TBQijpBRRjygh, four screens: 1 · a contradiction (pick what is true), 2 · I need to ask someone, 3 · a scope change, 4 · the list after settling. They are the UI reference; their sample conflicts, names and dates are made up.

## Why

Lint finds `contradiction` (two pages disagree on a fact) and `scope-change` (a source contradicts a `scope-*` page) findings, and the only way to act on one is "Resolve in terminal" on the Health card: an agent terminal opens with the finding as its first message. The owner has never resolved one: "The terminal replaces Shellie, ideally I want a flow to follow to resolve a conflict." Conflicts can be settled from the sources alone, or only after asking someone (a customer, a colleague): "could be both".

## Goals

- A guided flow inside Shellie, start to finish, with no terminal and no free-form chat: see the conflict, choose what is true, optionally say why, settle.
- Both sides of a conflict shown side by side, each with its words, page, source and date, plus the agent's suggestion.
- A way to park a conflict while someone is asked, with a question ready to copy, and to come back with the answer.
- Settling keeps history: the page states the current fact and keeps the old one as superseded, with its date and the decision that replaced it (owner's answer).
- Every settled conflict leaves a decision page, so the same conflict is not raised again and the "why" is kept.

## Non-goals

- A change-request or invoicing flag on scope decisions (owner: no).
- Resolving Shellie's own findings (broken links, stale pages, frontmatter, uncaptured sources, pictures): they keep their current buttons.
- Editing pages by hand inside the flow.
- Notifications outside Shellie (mail, Teams); copying the question is the whole integration.

## Anti-goals

- The flow ever opening a terminal or needing a reply typed to an agent.
- A settled conflict coming back on the next lint.
- Silent rewrites: a settle that changes a page without its old claim staying visible as history.
- A conflict parked "waiting on someone" still counted in Needs you or the Add badge.

## Constraints

- Agent-neutral texts; Claude Code and OpenCode brains both work (skills in `src/main/brain/templates.ts`, both agents read the same skills).
- Skills change, so `TEMPLATES_VERSION` goes to 9; existing brains get it through Update skills. A brain on older skills still shows its conflicts (see Old findings).
- Jobs run through the existing runner (`jobs.ts`), on the brain's model, under the daily token cap, committed like every brain job.
- Shellie's look (`tokens.css`, `brain.css`, dark and light), existing controls.
- Telemetry: counts and kinds only (`brain.screen.action` and `docs/telemetry.md`); never the question, claims, names typed in Who, or answers.
- TDD; `npm test`, `npm run typecheck`, `npm run lint`; a change note in `docs/changes/`.

## What a conflict is (data)

Lint (skills v9) writes each `contradiction` and `scope-change` finding with a structured `conflict` next to today's fields (`kind`, `page`, `detail`, `at` stay, so older code still reads them):

- `id`: stable for the same disagreement across lint runs (the skill derives it from the kind and the pages involved, for example `contradiction:wiki/plan.md+wiki/meeting-2026-11-05-steerco.md:go-live`); Shellie only compares ids.
- `question`: the disagreement as one plain question ("When does Acme go live?").
- `claims`: exactly two, `a` and `b`, each with `page` (a wiki path, or for a scope change the new side's source path), `quote` (the words, short), `source` (the source path the claim cites, or null) and `date` (the source's date, or null). For a `scope-change`, `a` is the agreed scope page and `b` the new source.
- `suggestion`: `pick` (`a`, `b`, `both`, `neither`, or null when the agent cannot tell) and `reason` (one or two sentences).

Shellie validates this with zod and keeps a finding whose `conflict` does not parse as an old finding (below). The pages and sources shown are only those that exist. Today `BrainFindingSchema` drops unknown keys and `writeState` replaces `findings` wholesale, so every state write Shellie makes (after each capture) would wipe what lint wrote: the schema must carry `conflict` through untouched, and a malformed `conflict` must never make `state.json` unreadable (it is kept as raw data and the finding treated as old).

Shellie keeps its own record of what the person did, in `brain/conflicts.json` (written by Shellie only, under the brain's git lock, committed with the brain): per conflict id either `{ "parked": { "question", "at" } }` or `{ "settled": { "at", "status": "pending" | "done" | "failed", "decision": <the whole decision JSON the job got>, "page": <decision page path or null>, "error": <string or null> } }`. Lint never writes it. Who can answer is a person's name, so it stays out of the brain: it is kept in Shellie's user data per brain and conflict id, never committed, never sent to an agent (my call).

- A finding whose id is settled (any status) is not shown as open, even if an older lint left it in state, unless lint marks it `reopens` (below).
- A `pending` settle whose job is not in the runner (the app quit or crashed) is queued again at launch from the kept decision, like the scheduler's other passes; `failed` shows in Settled with its error and Retry, which queues the kept decision again. `done` is written when the job succeeds, with the decision page's path.
- A parked id is shown under Waiting on someone and is not counted in Needs you or the badge.

## The flow

### Where it starts

- **Add › Activity › Needs you** gets one row "Conflicts to settle · n" (n = open conflicts, not parked ones) with Settle, which opens the flow at the first one. The Add badge counts open conflicts too.
- **Health**: each `contradiction` and `scope-change` finding's button becomes Settle (opening the flow at that conflict). Shellie's own findings (broken link, stale, frontmatter) keep Resolve in terminal as today.
- **Read**: a page involved in an open conflict shows one line under its title, "This page disagrees with <other page> · Settle" (my call; it is where a reader meets the conflict).

### The settle page (screen 1)

A page of the Brain screen, like Read and Add, reached from those entries; "← Add" goes back to where it came from. Header: "Settle conflicts", "n of m", previous and next.

One conflict at a time: its kind and when lint found it, the question as the heading, claims A and B side by side (quote, page title, source and date, "Newer" on the more recent, Open page opening it in Read), the agent's read (suggestion and reason, when there is one), then the choice:

- Contradiction: **A is right**, **B is right**, **Both, in different contexts** (a field: how they fit), **Neither** (a field: what is true), **I need to ask someone**. The suggested option carries "Suggested"; nothing is preselected (my call: a person decides).
- Scope change (screen 3): **Accept: this is the new scope**, **Keep the agreed scope**, **I need to ask someone**.

Then **Why** (optional, two lines), and the primary button naming the choice ("Settle: B is right"), plus Skip for now. "Record as a decision page" from the mockup is not a switch: every settle writes one (it is how the conflict stays settled).

Settle queues a `settle` job and moves to the next conflict at once; the job's progress shows in the list (screen 4) and in Activity. Settle and Re-check need skills v9: a `settleReady(brain)` check like `bookReady`/`picturesReady` gates `brain:run` for `settle` and disables both buttons with "Update skills to settle conflicts here" (the runner's own hold covers only OpenCode brains below v7). While the daily token cap holds the queue, Settle still queues and says the job waits for the cap.

### Asking someone (screen 2)

Choosing I need to ask someone shows **Who can answer** (free text, stays local) and **The question**, prefilled from the two claims ("The SOW v2 (28 Oct) says …; the steerco notes of 5 Nov say …. Which is current?"), editable, with Copy question. **Park** writes the parked record and moves on. A parked conflict leaves Needs you and the badge.

### The list (screen 4)

The settle page with no conflict open (or after the last one) is the list: **Needs you** (open conflicts, each with Settle), **Waiting on someone** (who, since when, Copy question, **Got an answer**), **Settled** (the choice in one line, by you and when, the job's state, "n pages changed", Decision page). Settled shows this session's and the last 30 days' settles from `conflicts.json`.

**Got an answer** opens a field for the reply. "Add answer and settle" adds it as a source (`brain:addText`, type `note`, title "Answer: <question>", note "Answer to a conflict", no name) without the automatic capture: `brain:addText` always queues one today, so it gains an option to skip it (my call: the settle job reads the answer instead, one job not two). While its settle is pending the answer source counts as in flight (not in Needs you, the badge or Health's uncaptured); when the settle succeeds the job records the answer source as captured, as a capture does; if the settle fails it shows with the settle's error, and Retry settles again rather than capturing it, clears the parked record, and opens the conflict with the answer shown above the choice. The settle job gets the answer's path.

### What a settle does (the job)

A new job kind `settle`, run by a new skill `/settle`, with one argument: a small JSON of the decision (`id`, `kind`, `choice`, `text` for both/neither, `why`, `answer` source path or null, the two claims). The skill:

1. Writes `wiki/decision-<yyyy-mm-dd>-<topic>.md`: the question, both claims with their sources, the choice, the why, the answer source when given, who decided (by role: "the team") and the date.
2. Updates every page that holds a losing or outdated claim: the current fact first, then the old claim kept as history in the schema's form ("~~12 January~~ 2 February, since the steerco of 5 Nov ([decision](decision-…))"). Both: each page says in which context its claim holds. Neither: the given fact, the old claims kept as history. Scope accepted: the scope page gets the new line with its source, the old line kept as history; scope kept: the scope page notes the request as not taken in, with the decision.
3. Removes the finding from `brain/state.json` and appends to `log.md` like other skills.

Shellie writes the `settled` record (`pending`, with the whole decision) when the job is queued, so the conflict leaves the queue at once and survives a restart (above). Lint (v9) reads decision pages and does not raise a conflict a decision has settled; when a source newer than the decision disagrees again, it raises it with `reopens: <decision page path>`, and Shellie then shows it as open again despite the settled record (my call).

The SCHEMA gains the superseded form and the decision page's sections; capture follows the superseded form when a source updates a fact (my call: one rule for history everywhere).

### Old findings

A finding without a valid `conflict` (lint before v9, or a malformed one) appears in the flow with its one-line detail instead of claims, and the choices **Write what is true** (a field; settles under the id `kind:page:detail`) and **Re-check** (queues a lint, which on v9 skills writes it in full under a new id). It cannot be parked (my call: its id does not survive a re-lint, so a parked old finding would come back as new).

## Telemetry

New `brain.screen.action` values: `settle-open` (the page opened, with `from`: `add`, `health`, `read`), `settle` (with `kind`, `choice`, `suggested`: whether the choice was the suggestion, `why`: boolean, `answered`: boolean), `park`, `copy-question`, `answer`, `skip`, `recheck`.

## Testing

- Shared: the conflict schema accepts lint's shape and rejects partial ones (the finding then counts as old).
- Main: `brain/conflicts.json` read and write (missing, corrupt, concurrent with the brain's git lock); `settle` queued with its argument on both agents; settled ids are hidden from findings; parked ids are not counted in the badge; Got an answer adds the source without queuing a capture.
- Skills: the v9 lint, settle and schema texts carry the rules above (string tests like today's template tests).
- Renderer: the settle page shows claims, suggestion and choices per kind; Settle sends the decision and moves on; Ask fills the question, Copy, Park; the list's groups; Got an answer; old findings' choices; Health and Read entry points; nothing preselected; names no agent.
- Live, in the dev app with a fake agent: a brain with a v9-shaped state, settle, park, answer; and one real run of `/settle` on a scratch brain (owner's subscription) to see a decision page and the superseded form.

## Left to the builder

Component and file names; the decision JSON's exact field names; how the skill derives conflict ids; the superseded Markdown form (keep it readable in Read); the narrow-window layout; whether the settle page is a third tab or a sub-view of Add (the mockups show it reached from Add).
