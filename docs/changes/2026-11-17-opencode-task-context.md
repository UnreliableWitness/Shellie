# OpenCode starts knowing about the task's .shellie/task.md

Branch `fix/opencode-reads-task-md` (2026-11-17).

## Problem

A task's Claude Code tab starts with a system prompt (`claudeContext` in `src/shared/naming.ts`) that says the folder is a Shellie task and the details are in `.shellie/task.md`, plus the `shellie run` names and the brain when there is one. OpenCode has no system prompt flag, and its tab got only an `instructions` file holding the `shellie run` line, and only when the repo had stored secrets. So OpenCode never learned that `.shellie/task.md` existed and did not read it.

## What changed

- `startTerminal` (`src/main/ipc/handlers.ts`) builds the same `claudeContext` text for an OpenCode tab (task, `shellie run` names, readable brain) and passes it to `terminalEnv` as `context`.
- Main (`src/main.ts`) writes it to `<userData>/opencode/shellie-task-<taskId>.md` and puts that file in `instructions` in `OPENCODE_CONFIG_CONTENT`, next to the developer's own instructions. It replaces the old `shellie-run-<taskId>.md`, whose line is now part of the context. It no longer waits for the attention plugin to be written, and it creates the folder itself.

## Verified

- Unit test: the OpenCode tab's context names `.shellie/task.md` and the brain and is identical to Claude's prompt; Claude's tab gets no `context`.
- OpenCode 1.19.3 on macOS: an absolute path in `instructions` from `OPENCODE_CONFIG_CONTENT` shows in `opencode debug config`, and `opencode run` answered from that file's contents.

## Known gaps

- Not run in the packaged app or on Windows.
- A developer `OPENCODE_CONFIG_CONTENT` that is not a JSON object still drops all of Shellie's config, this context included (the existing warning does not name it).
