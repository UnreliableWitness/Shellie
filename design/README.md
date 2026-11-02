# MIAC design mockups

Copied from the design canvas on 2026-10-14: https://claude.ai/artifact/4kbfLSRgmPYqtrJWZ6yoMJ
The canvas is the source of truth; these are a snapshot for reference while building.

Each `mockups/*.dc.html` is one screen as HTML with inline styles plus a small `class Component` script
holding the sample data. They use the canvas's `<x-dc>` / `{{hole}}` / `<sc-for>` template format, so they
don't render standalone in a browser; read them for layout, copy, colors and data shapes, or open the canvas link to see them.
`mockups/canvas.json` lists the screens and their order.

| File | Screen |
|---|---|
| `Main.dc.html` | 1. Workspace: task list per repo, task header with AI cost, terminal tabs (Claude Code, PowerShell, dev) |
| `NewTask.dc.html` | 2. New task from a work item: pick item, repo, base, branch, setup and start options |
| `Setup.dc.html` | 3. Task setup running: step list plus live log (worktree, copy .env, npm ci, build) |
| `Done.dc.html` | 4. Finish task: safety checks, final AI usage to work item, clean up worktree/branch |
| `Settings.dc.html` | 5. Settings: repos and `.miac.yml`, Azure DevOps connection, rate table and currency (superseded by the 2026-11-02 Settings redesign, `docs/superpowers/specs/2026-11-02-settings-redesign-design.md`) |
| `Usage.dc.html` | 6. Task AI usage: per-session tokens and cost, custom fields and comment on the work item |
| `Invoicing.dc.html` | 7. AI cost per customer for invoicing, per period, with CSV export |

Visual language (sub-project 6 replaces the mockups' greys): space-black ground `#090b10` (`#07080c` void,
`#0c0e14` panels), `#1d2230` hairlines, amber `#f0a443` as the one accent, cream `#f6e7c8` for highlights. Instrument
motifs: the Mind dial mark, ring gauges, bracketed values, tick rules and small spaced-out labels. IBM Plex Sans for UI,
JetBrains Mono for code, ids, paths and money, both bundled with the app (no font downloads).
