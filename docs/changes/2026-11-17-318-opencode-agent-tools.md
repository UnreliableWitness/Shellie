# OpenCode agent files from APM get OpenCode's tools map

Issue #318, branch `agent/issues/318-shellie-apm-opencode-throws-error`.

A repo whose `apm.yml` targets opencode got Claude Code agent files in `.opencode/agents/` as APM wrote them. Their frontmatter lists tools as text (`tools: Read, Glob, Grep, mcp__azure-devops__wiki_get_wiki, Bash`) and names a Claude model alias (`model: haiku`), and OpenCode refused to start: `Expected object | undefined, got "Read, Glob, ..." tools`.

## What changed

- New `opencodeAgents.ts`: after `apm install --target opencode`, the apm step rewrites every `*.md` in `.opencode/agents/` and `.opencode/agent/` whose `tools:` is a string or a list into OpenCode's map (`tools: { read: true }`). Claude built-ins are lowercased (`LS` becomes `list`, `MultiEdit` becomes `edit`), `mcp__server__tool` becomes `server_tool`, a permission pattern such as `Bash(git:*)` becomes its tool, and unknown names are lowercased, kept and logged.
- A `model:` without a `/` (not a provider/model id) is removed, so OpenCode uses its default model.
- A file that already has a map, has no frontmatter, or cannot be parsed is left alone. Only the `tools:` and `model:` lines change; the rest of the file stays byte for byte.
- It runs before the step puts committed files back, so an agent file committed in the repo stays as committed. A file that cannot be converted is logged and does not fail the step.
- Telemetry: no change.

## Verified

- `npm test`, `npm run typecheck` and `npm run lint` pass.
- New tests: `opencodeAgents.test.ts` (the issue's frontmatter, lists, CRLF, files left alone); `SetupRunner.test.ts` converts only when opencode is a target.

## Known gaps

- The MCP tool name mapping and the `tools` schema were not checked against a live OpenCode.
- Only files written in later setup runs are converted: a task that already has a bad file needs the apm step retried, or the file fixed or deleted once.
- Other frontmatter keys and other APM primitives (prompts, instructions) are not converted.
