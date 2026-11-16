# Revert the dependency bump that broke the terminal font

v1.104.0 contained only the dependabot group bump (#307): Electron 45.0.0 -> 45.2.3, vite 8.3.6,
@vitejs/plugin-react 6.2.1, mermaid 12.3.0, zustand 5.1.0, turndown 7.2.5, vitest, oxlint, oxfmt.
After updating, Claude Code's terminal showed the wrong font and font size and was unusable.
Shellie's terminal options (`src/renderer/terminalSetup.ts`) and xterm itself did not change, so the bump is the cause.

This change reverts the whole bump to ship a working release at once.

Known gaps: which package caused it is not yet pinned down. Electron (a new Chromium, with new font matching and
rendering) is the main suspect; vite/rolldown reordering CSS (xterm.css) is the second. Re-bump them one at a time
and check the terminal on Windows before taking Electron 45.2.x again.
