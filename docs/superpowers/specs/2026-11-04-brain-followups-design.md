# Brain: the rest of the llm-wiki harvest

Follows `2026-11-04-brain-checks-design.md`. The owner said "ok you can do those too" to the six items left after comparing the brain with nvk/llm-wiki (MIT): a read-only ask skill, removing or scrubbing a source, a secret scan at drop time, human-only `verified` and `confidence` per page, lessons learned at Finish, archiving a brain. Two pull requests.

## PR 1: ask, confidence and verified, secrets

### `/ask` (templates v4)

A fifth skill, `.claude/skills/ask/SKILL.md`, with `allowed-tools: Read, Glob, Grep` so it cannot write. Protocol: read `index.md`, open only the pages it points to that bear on the question, follow their links when needed, use `sources/` only for a quote or a detail a page lacks. Answer first, then `Sources:` with exact file paths (`wiki/account.md`, `sources/2026-11-04-deck.md#slide-4`). Say when a page the answer rests on is `low` confidence or was changed since it was verified. Never fill a gap from memory: say the brain does not answer and name the closest pages. Never write anything, not even `log.md`.

The Ask box on the Brain screen sends `/ask <question>` to the brain terminal instead of the bare question. The task Context section tells a task's Claude how to answer from the brain (index first, then pages, cite paths, say when there is no answer), because skills in an `--add-dir` folder are not loaded.

### `confidence` and `verified`

Frontmatter gains two fields. `confidence` (`high`, `medium`, `low`) is set by the skills from the sources: `high` for a contractual source (SOW, signed scope, a recorded decision) or two independent sources that agree; `medium` for one document, deck or meeting; `low` for a passing remark in a transcript or note, or when sources disagree. `verified: yyyy-mm-dd` is written only by a person: through "Mark verified" on a wiki page in the Brain screen (`brain:verify`, which writes today's local date and commits `Brain: verified <page>`), or by hand. The skills never add, change or remove it. A verification counts while `verified` is on or after `last_updated`; a page changed later is "changed since verified" (the ask skill says so, the page viewer shows it).

Shellie's checks: a `confidence` outside the three values or a `verified` that is not a date is a `frontmatter` finding; a page is not `stale` for a source a person verified it against (`verified` day on or after the source's ingested day).

### Secret scan at drop time

`findSecrets(text)` (`src/main/brain/secrets.ts`) looks for private keys, GitHub, Slack, Stripe and AWS tokens, legacy Azure DevOps PATs (52 base32 characters with a digit), JWTs, connection-string passwords and keys, bearer tokens, `api_key = …` style assignments and SAS signatures, and returns the kind and line of each. `addSource` refuses a file or pasted text that holds one (`reason: 'secret'`, the kind and the line in the message; nothing is written, the drop notes show it) and `brain.source.added` gets the outcome `secret`. A mirrored wiki page that holds one is copied (it is the customer's wiki, already there) with a warning naming the page and the kind.

### Templates v4 also carry the PR 2 skills

`/retract <source>` and `/lessons <source>` (below) ship in the same template bump so brains update once; both are usable from the brain terminal before PR 2 adds their buttons and jobs. `lesson-<yyyy-mm-dd>-<topic>.md` is a new page type: something learned doing a task (a gotcha, a fix, a correction) with the rule that follows from it.

## PR 2: remove, scrub, lessons at Finish, archive

- **Remove source** (`brain:removeSource(id, path)`): a button on each row of the Sources tab. Deletes the source, its original beside it and its assets folder, drops it from `state.captured`, commits `Brain: remove source <path>` and queues a `retract` job: `/retract <path>` finds every page citing it (Grep), removes the claims only it backed, keeps claims other sources back (fixing the citation), updates `sources:` and `last_updated`, deletes a page left empty, logs. The file stays in the brain's git history; the UI says so. Wiki mirror pages cannot be removed this way (the next refresh would bring them back).
- **Scrub a value** (`brain:scrub(id, value)`): a password field on the Health card. Replaces every occurrence of the value, its URL-encoded and base64 forms, with `[REDACTED]` in every text file under `sources/`, `wiki/`, `index.md`, `log.md` and `brain/state.json`, renames files whose name holds it, commits `Brain: scrub`, returns the number of files changed; the value never reaches telemetry, logs or the commit message. History keeps it; the UI says so.
- **Lessons at Finish**: a Finish option "Save what this task taught into the brain" (off by default, like the task.md one). Shellie writes a compact digest of the task's Claude session (the user's messages and Claude's replies from the session transcript, tool output left out, cut at 60k characters) as a `task` source `<slug>-session.md` through `addSource` (the secret scan applies) and queues a `lessons` job: `/lessons <source>` extracts 0 to 7 lessons (error→fix, corrections, gotchas, decisions), each with a generalisable rule and the specifics (paths, messages), never a secret, into `lesson-*` pages linked to the components they touch. The job records the source as captured.
- **Archive a brain**: `Brain.archived` (default false). An archived brain is hidden from the nav, is not the brain of any task (no Context, no `--add-dir`, no tab, no close line), gets no scheduled refresh or digest, and refuses jobs. Settings › Brains lists it under "Archived" with Restore; Delete stays.

## Verification

Unit tests per module, renderer tests for each button, `npm test`, `npm run typecheck`, `npm run lint`, a review by a separate agent per PR.
