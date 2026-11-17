# Terminal hyperlinks open in the browser

Issue #311, branch `agent/issues/311-open-a-link-throws-a-warning-and-we-can`.

Clicking a hyperlink a program prints with the OSC 8 escape sequence (Claude Code's pull request links, for one) showed xterm's "Do you want to navigate to …? WARNING: This link could potentially be dangerous" prompt, and OK opened nothing. The terminal had no `linkHandler`, so xterm's default ran: `confirm()`, then `window.open()` with no URL. Main denies every window that is not an allowed link (`setWindowOpenHandler` in `windowGuards.ts`), so the blank window was refused. Plain-text URLs were not affected: they go through Shellie's own link provider.

## What changed

- `oscLinkHandler` in `terminalLinks.ts` sends OSC 8 links to `openLink`, which calls `links:open`, like plain URLs. `TerminalView` passes it to every terminal, brain terminals too.
- No prompt: `links:open` already allows only http(s) without credentials (`allowedLink`), and `allowNonHttpProtocols` is false so xterm drops other schemes itself. A refused URL is ignored silently, as for plain links.
- Telemetry: no new event; these clicks are counted by the existing `terminal.linkOpened` with type `url`.

## Verified

- `npm test`, `npm run typecheck` and `npm run lint` pass.
- New tests: the handler sends the URL to `links:open` without `window.confirm` (`terminalLinks.test.ts`), and `TerminalView` gives the terminal that handler (`TerminalView.test.tsx`). `javascript:` URLs were already refused by `allowedLink` (`docsHandlers.test.ts`).

## Known gaps

- Not run in the app or on Windows (the reporter's platform); the change is renderer-only.
- No hover tooltip for OSC 8 links.
