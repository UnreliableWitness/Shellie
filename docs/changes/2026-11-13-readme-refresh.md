# README refresh

The README described Shellie as of 2026-10-26. This update brings it up to date and retakes the screenshots.

## What changed

- New sections: **A brain per project** (feeding, capture, the book, Ask, Settle), **Long reads, the reading list and
  your phone**, **Brains and tasks**, and a short **Settings** section on the User / Project / Repository scopes.
- The Features table gains "A brain per project" and "Secrets" cells, and the Azure DevOps cell names the Project page.
- Corrected:
  - Cost is no longer written to Azure DevOps (no `Custom.AI*` fields, comment or PR cost line since 2026-10-23). The
    cost section now describes the ledger, both budgets and the opt-in cost server.
  - Releases are scheduled twice a day and carry a signed macOS build. They no longer happen on every merge.
  - Setup now has four Get started steps, the PAT needs Wiki (Read) for a brain, and the settings paths are the
    scoped ones.
  - `.shellie.yml` without `base` uses the repo's default branch. Settings overrides win over the file, and unknown
    keys are an error.
  - The Electron badge says 45.
- Screenshots: all seven old ones retaken, plus `project`, `settings`, `brain-book`, `brain-add`, `brain-settle` and
  `brain-reading`.

## How the screenshots were made

- They come from the demo setup in `~/Shellie-demo` on the owner's Mac. It holds the `launch.sh` script, a separate
  profile, the `contoso-shop` repo with three task worktrees, and a demo Claude config folder. It talks to the real
  test project `unreliablewitness/Shellie`.
- The demo's usage data dates from 2026-10-21. It was moved forward 22.5 days, so this week's stats and the last six
  hours have data.
- The `Contoso shop` brain was built in the app by real capture, sync and `/write` jobs. Its sources were five short
  fictional documents (statement of work, kick-off transcript, architecture notes, carrier notes, a decision). The
  carrier's five-minute rule against the fifteen-minute cache is the conflict that Settle and the hero shot show.
- The shots are 1680×1050, with a CDP `Emulation.setDeviceMetricsOverride`. At 1440 px wide the task bar pushes the
  terminal tabs out of the tab strip.

## Known gaps

- The sprint in the test project ran 12 to 25 October, so Sprint and Project show those dates next to November
  activity.
- The phone reader has no screenshot, because a real connection's QR code and link must never be shown.
