/** Bump when SCHEMA.md or a skill changes, so existing brains offer the update. */
export const TEMPLATES_VERSION = 1;

/** `path` is relative to the brain folder, with forward slashes. */
export type TemplateFile = { path: string; content: string };

const SCHEMA = `# Schema

This file is the contract for everything that writes in this brain. Read it first, every time.

## Layers

- \`sources/\`: raw material (converted documents, transcripts, notes, task files). Never edited, by anyone or any skill. The \`.mirror/\` folder holds a read-only copy of the Azure DevOps wiki.
- \`wiki/\`: the curated pages. Skills and humans both edit here.
- \`index.md\`: the entry point. Lists every top-level page with a one-line summary.
- \`log.md\`: append-only history of what the skills did.
- \`brain/state.json\`: machine state, described below.

## Page types

Name the file after its type: \`account.md\`, \`scope-<topic>.md\`, \`decision-<yyyy-mm-dd>-<topic>.md\`, \`meeting-<yyyy-mm-dd>-<topic>.md\`, \`component-<name>.md\`, \`glossary.md\`, and \`digests/<year>-w<nn>.md\` for \`digest\` pages.

- \`account\`: who the customer is, roles, contracts in outline.
- \`scope-*\`: what was agreed to deliver. The only place rates and prices may appear.
- \`decision-*\`: one decision, its context and who (by role) took it.
- \`meeting-*\`: decisions, actions and open questions from one meeting.
- \`component-*\`: one part of the system.
- \`glossary\`: terms the customer uses.
- \`digest\`: the weekly summary.

## Frontmatter

Every page in \`wiki/\` starts with:

\`\`\`
---
title: Short title
summary: One or two sentences.
sources: [sources/2026-10-09-kickoff.md]
last_updated: 2026-10-09
---
\`\`\`

The summary is repeated as the first paragraph under the title. Set \`last_updated\` to today whenever you change a page.

## Links and citations

- Every page is linked from \`index.md\` or from a parent page. A page nobody links to is an orphan.
- Links and citations are ordinary markdown links, never wikilinks. Cite a source like this: \`[Kickoff p.3](../sources/2026-10-09-kickoff.md#p3)\`.
- Every claim that comes from a source gets a citation.

## Log format

Append one line per action to \`log.md\`:

\`\`\`
- <ISO timestamp> <skill> <source or ''> → pages: a, b; takeaway: …
\`\`\`

## Rules

- Never edit anything under \`sources/\`.
- Meetings: record decisions, actions and open questions. No verbatim quotes.
- Refer to people by role (the customer's product owner), not by name.
- Never copy credentials. Never write rates or prices outside \`scope-*\` pages.
- No opinions about people.
- When a source contradicts a \`scope-*\` page, do not overwrite the page. Add a finding of kind \`scope-change\` and say what differs.
- Never revert a human edit in \`wiki/\`. Reconcile around it, or add a finding.
- Never create or edit a \`CLAUDE.md\`.

## brain/state.json

\`\`\`json
{
  "schemaVersion": 1,
  "lastSyncCommit": "abc123",
  "lastLintAt": "2026-11-03T10:00:00Z",
  "captured": {},
  "findings": [{ "kind": "contradiction", "page": "wiki/x.md", "detail": "…", "at": "2026-11-03T10:00:00Z" }]
}
\`\`\`

- Read the file, change only the fields your skill owns, and write it back with every other field intact.
- \`captured\` is written by Shellie, never by a skill.
- \`/sync\` writes \`lastSyncCommit\` (a git commit id).
- \`/lint\` writes \`findings\` (replacing the list) and \`lastLintAt\` (ISO timestamp). A finding has \`kind\` (\`contradiction\`, \`orphan\`, \`broken-link\`, \`stale\`, \`uncaptured\` or \`scope-change\`), \`page\`, \`detail\` and \`at\`. Keep existing \`scope-change\` findings that were not resolved.
- \`/capture\` and \`/digest\` do not write the file.
`;

const CAPTURE = `---
description: Use after a document, transcript or note lands in sources/ to fold it into the wiki. Takes the source path.
---
Capture the source named in the argument into the wiki.

1. Read \`SCHEMA.md\`. Follow it for every step.
2. Read the source in full, then \`index.md\`.
3. Decide which pages it affects. Update those pages, or create new ones of the right type.
   - Frontmatter on every page, summary at the top, citations as markdown links to the source.
   - Link every new page from \`index.md\` or a parent page.
   - If the source contradicts a \`scope-*\` page, leave the page as it is and tell the user in the takeaways (lint records the finding).
4. Update \`index.md\` so each new or changed page has its one-line summary.
5. Append one line to \`log.md\` in the schema's format.
6. Do not touch \`brain/state.json\`: Shellie records captures itself.
7. Do not edit anything in \`sources/\`. Do not create a \`CLAUDE.md\`.
8. End by printing the takeaways: 3 to 6 bullets, plus the pages you touched.
`;

const SYNC = `---
description: Use after sources/ or the wiki mirror changed, or after people edited wiki/ by hand, to reconcile the pages with what changed.
---
Bring the wiki in line with what changed since the last sync.

1. Read \`SCHEMA.md\`. Follow it for every step.
2. Read \`brain/state.json\`. \`lastSyncCommit\` is the starting point; if it is null, use the first commit.
3. Run \`git diff <lastSyncCommit> HEAD --stat\`, then read the diffs for \`sources/\` (including \`.mirror/\`) and \`wiki/\`.
4. For each changed source, update the pages that cite it. Re-read the source; do not guess from the diff.
5. For each human edit in \`wiki/\`, keep it. Fix links, \`index.md\` and other pages around it. If it contradicts a source, add a note to the takeaways instead of reverting it.
6. If a source contradicts a \`scope-*\` page, leave the page as it is and report it in the takeaways.
7. Update \`index.md\`. Append one line to \`log.md\` in the schema's format.
8. Write \`lastSyncCommit\` in \`brain/state.json\` (the current \`git rev-parse HEAD\`). Read the file first and write it back with every other field unchanged.
9. Do not edit anything in \`sources/\`. Do not create a \`CLAUDE.md\`.
10. End by printing what changed.
`;

const LINT = `---
description: Use after captures or edits to check the wiki for broken links, orphans, contradictions, stale pages and uncaptured sources.
---
Check the wiki, incrementally.

1. Read \`SCHEMA.md\`. Follow it for every step.
2. Read \`brain/state.json\`. Check the pages in \`wiki/\` whose \`last_updated\` is after \`lastLintAt\` (all pages when it is null), plus every page they link to.
3. Look for:
   - \`broken-link\`: a markdown link whose target does not exist.
   - \`orphan\`: a page linked from neither \`index.md\` nor a parent.
   - \`contradiction\`: two pages that disagree on a fact.
   - \`scope-change\`: a source that contradicts a \`scope-*\` page.
   - \`stale\`: a page older than a source it cites.
   - \`uncaptured\`: a file in \`sources/\` that no page cites and \`log.md\` does not mention.
4. Do not fix pages. Only report.
5. Write \`brain/state.json\`: read it first, replace \`findings\` with the findings for the pages you checked plus earlier ones for pages you did not check, set \`lastLintAt\` to now (ISO timestamp), and keep every other field unchanged.
   Each finding is \`{ "kind", "page", "detail", "at" }\`.
6. Append one summary line to \`log.md\` in the schema's format.
7. Do not edit anything in \`sources/\`. Do not create a \`CLAUDE.md\`.
8. End by printing the number of findings per kind.
`;

const DIGEST = `---
description: Use once a week to summarise the week's log entries into a digest page.
---
Write the weekly digest.

1. Read \`SCHEMA.md\`. Follow it for every step.
2. Read \`log.md\` and take the entries from the last 7 days.
3. Open the pages they mention. Check what changed, not only what the log says.
4. Write \`wiki/digests/<year>-w<nn>.md\` (ISO week) as a \`digest\` page with frontmatter, a summary at the top, and these sections: decisions, actions, open questions, changes to scope.
   - Cite the pages and sources with markdown links.
   - Follow the schema's rules on people, quotes and rates.
5. Link the new page from \`index.md\`.
6. Append one line to \`log.md\` in the schema's format.
7. Do not touch \`brain/state.json\`. Do not edit anything in \`sources/\`. Do not create a \`CLAUDE.md\`.
8. End by printing the digest's summary.
`;

const SETTINGS = `${JSON.stringify(
  {
    permissions: {
      deny: [
        'Edit(sources/**)',
        'Write(sources/**)',
        'MultiEdit(sources/**)',
        'NotebookEdit(sources/**)',
      ],
    },
  },
  null,
  2,
)}\n`;

/** Every file a brain is made of; the content never depends on anything but the brain's name. */
export function templateFiles(brainName: string): TemplateFile[] {
  return [
    { path: 'SCHEMA.md', content: SCHEMA },
    { path: 'index.md', content: `# ${brainName} brain\n\n(no pages yet)\n` },
    { path: 'log.md', content: '# Log\n\n' },
    { path: 'brain/state.json', content: '{"schemaVersion":1}\n' },
    { path: '.claude/settings.json', content: SETTINGS },
    { path: '.claude/skills/capture/SKILL.md', content: CAPTURE },
    { path: '.claude/skills/sync/SKILL.md', content: SYNC },
    { path: '.claude/skills/lint/SKILL.md', content: LINT },
    { path: '.claude/skills/digest/SKILL.md', content: DIGEST },
    { path: '.gitignore', content: 'brain/lock\n.mirror/\n' },
  ];
}
