# Brain: a read-only ask skill, confidence and verified, a secret scan at drop time

Spec `docs/superpowers/specs/2026-11-04-brain-followups-design.md` (PR 1 of 2). The first half of the remaining llm-wiki harvest, after the owner said "ok you can do those too".

## What changed

- **`/ask`** (templates v4, `.claude/skills/ask/SKILL.md`, `allowed-tools: Read, Glob, Grep`, which pre-approves the read tools; the skill's text forbids writing and commands): answers a question from the brain without writing anything. Index first, then only the pages it points to, Grep over `wiki/` when the index does not show where, `sources/` only for a quote. Answer, then a `Sources:` list with exact paths; says when the answer rests on a `low` confidence page, an unverified one or one changed since verified; never fills a gap from memory. The Ask box on the Brain screen sends `/ask <question>` to the brain terminal. The task Context section tells a task's Claude how to answer from the brain (skills in an `--add-dir` folder are not loaded).
- **`confidence` and `verified`** in page frontmatter. The skills set `confidence` (`high`, `medium`, `low`) from the sources' weight and never touch `verified`; a person writes `verified` through "Mark verified" on a wiki page in the Brain screen (`brain:verify`: today's local date, replacing an earlier one, committed alone as `Brain: verified <page>`) or by hand. The page viewer shows `Verified <day>`, `changed since (<last_updated>)` when the page moved on, or `Not verified by anyone yet`, with the confidence. Shellie's checks: a bad `confidence` or `verified` is a `frontmatter` finding; a page is not `stale` for a source a person verified it against (`verified` on or after the source's ingested day).
- **Secret scan** (`src/main/brain/secrets.ts`): a dropped file or pasted text that looks like it holds a private key, a GitHub, Slack, Stripe or AWS token, a legacy Azure DevOps PAT, a JWT, a connection-string password or key, a bearer token, an `api_key = …` assignment or a SAS signature is refused (`reason: 'secret'`, the kind and line in the drop note, nothing written; telemetry outcome `secret`). A mirrored wiki page holding one is copied with a warning naming the page and the kind.
- **Templates v4 also ship `/retract` and `/lessons`** (used by PR 2's Remove source and lessons-at-Finish) and the `lesson-*` page type, so brains update once.

## Verified

`npm test` (3559 tests), `npm run typecheck`, `npm run lint` green. Tests: `secrets.test.ts` (every kind with its line, ordinary documents clean: hashes, "password policy", a long lowercase word, "Bearer of the ring"), `sources.test.ts` (pasted text and a file refused, nothing written), `check.test.ts` and `pages.test.ts` (bad values flagged, a verification covers a newer source), `brainHandlers.test.ts` (`verifyPage` replaces the date, commits the page alone, refuses pages outside `wiki/` or without frontmatter), `BrainFiles.test.tsx` (the verified bar and the button), `BrainScreen.test.tsx` (Ask sends `/ask`), `scaffold.test.ts` (v4 pins), `context.test.ts`. A review by a separate agent before merge.

## After the review

A separate agent (Opus) found and these were fixed: "Mark verified" swept a hand edit of the page into a `Brain:` commit, hiding it from Health and `/sync` (the edit is committed first as an outside edit, the verify refuses while a job runs, a repeat on the same day commits nothing, and a dot segment in the path normalises away); the schema's example block carried a `verified` date a skill would copy (removed); the viewer's frontmatter parser crossed lines on an empty value and showed comments and timestamps (fixed, and a failed verify is now reported); the scanner missed the current 84-character Azure DevOps PAT, passwords in URLs, Slack webhooks, Google, OpenAI, Anthropic and npm keys, PGP keys, AWS secret keys and Entra client secrets, and `"api_key": "…"` or `export MY_API_KEY=` shapes (added), while refusing placeholders like `Password=<your-password>`, `${DB_PASSWORD}`, `@password` and `REPLACE_WITH_…` (skipped now); the refusal message did not name the file or say the line is in the converted text (it does); `confidence: 3` gave no finding (it does).

## Known gaps

- The secret patterns are a list, not a classifier: a credential of an unlisted shape passes, and a 52-character base32 word with a digit is refused as a PAT. There is no "add anyway" for a refused drop: redact and drop again.
- A verification is a day, not a moment: a page changed and verified the same day reads as verified, and a wiki mirror page refreshed in the afternoon after a morning verification does not make the page stale.
- `allowed-tools` in a skill pre-approves tools; whether Claude Code also withholds the others is not pinned by a test here. The skill's text forbids writing; the brain terminal would prompt before an edit.
- `/ask` is a skill of the brain folder; a task's Claude gets the protocol in its Context section but not the skill.
- `/lessons` run by hand on this version leaves its source uncaptured on Health: the runner records a capture for `capture` jobs only until the next change adds the `lessons` job.
