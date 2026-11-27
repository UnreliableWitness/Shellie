# Sharing a brain: feedback while it uploads, the join link in a box, History, and a light when a colleague adds

Asked for (the owner, 2026-11-27, after the first real share to GitHub): the Share card looked frozen while the brain uploaded; the join link should sit in an ordinary copy box; an overview of the brain's activity; and "an animation that indicates when a new thought was added to the brain by a team member". No spec: the owner asked for speed. The calls made while building are under "Decided without the owner".

## What changed

- **A share says what it is doing** (`share/share.ts`, `ShareDialog.tsx`). `shareBrain` reports its step through `ShareDeps.progress`, sent to the window as the new event `brain:shareProgress` (`brainId`, `step`: `opening`, `checking`, `creating`, `uploading`, and `percent` while git names one). The card shows the step, a bar and, from five seconds on, the seconds passed; during the upload the bar fills with git's own `Writing objects: n%` (`pushPercent`), and the button reads "Sharing…". While a `/sync` runs first the card says "Syncing first. Shellie shares when that is done…" with the same bar.
- **A first upload gets 30 minutes** (`SHARE_PUSH_TIMEOUT_MS`). `GitClient.push` gave up after two minutes, the limit meant for a task's push; a large brain's first push could be cut off there and reported as "git push timed out". `push` takes `timeoutMs` and `onProgress` (which adds `--progress` and hands over git's stderr as it comes); every other push is as before.
- **The join link in a box** (`CopyField.tsx`): the whole link in a read-only field that selects itself on a click, with Copy beside it ("Copied" for two seconds). After a share, and behind the header's button of a shared brain, now **Join link**, which opens an "Invite a colleague" card with the box and what the colleague needs. Before, the header button copied the link without ever showing it.
- **History**, a fourth view on the Brain page (`brain/activity.ts`, `history/BrainHistory.tsx`, channel `brain:activity`). Read from the brain's own git log: per day, who added a source, turned it into pages, wrote a long read, settled or answered a conflict, edited pages by hand, joined, left or shared, with the pages each entry added (`+`) or changed as links into Read (six named, the rest counted). On top, "The last 7 days": per person, sources added and pages added or changed. Shellie's housekeeping commits (index, merges, shared facts, keeper, verified stamps) and job commits that touched no page are left out. A person is the commit's author name; "You" is the commit whose author email is this install's (`<installId>@install.shellie`), and every commit of a brain that is not shared.
- **A light when a colleague adds** (`history/ArrivedChip.tsx`, `history/useBrainActivity.ts`). When a pull brings entries colleagues made that this person has not looked at, a chip appears beside the sync line: a dot with three slow rings and "Anna added 3 pages" (or sources, "joined", "changed the brain"; two names, then "and 2 others"). It plays again when more arrives, opens History on a click, and there the new entries carry a "New" mark and a tint until the view is left. What was looked at is kept per brain in localStorage (`shellie.brain.seen.<id>`, commit ids); the first look at a brain marks all of it as seen, so a brain just joined does not announce its past. With reduced motion set in the system, the chip appears without the rings (the app-wide rule in `tokens.css`).
- **Join says it is downloading**: the join screen shows "Downloading the brain…" with the bar and "Joining…" on the button while the clone runs.
- The Share and Join link cards got a margin and the three "Where it lives" choices a line each (`.brain-share` had no styles at all).
- Telemetry: `brain.screen.action` `view-history` (`docs/telemetry.md`).

## Decided without the owner

- The view is called **History**, because Add already has a card called Activity (the jobs of this machine).
- The light is a chip in the brain's header, not a new star in Explore or a notice outside the Brain page: it is seen where the brain is read, and stays calm. Nothing shows in the nav or on Home.
- What counts as new is by commit, not by time: a colleague's commit made yesterday that arrives today is new.
- Colleagues' entries only: one's own work on another machine counts as a colleague's there (it has another install id).
- The percentage is git's count of objects written, not bytes; over https the last part ("finishing") can take a while after 100%.
- History reads the last 600 commits and shows at most 150 entries.

## Verified

`npm run typecheck`, `npm run lint`, and the tests of the touched files: `activity.test.ts` (a real git folder: the order, who, what is left out, six pages named), `share.test.ts` (the steps in order and real percentages from a push to a bare repo, ending at 100; `pushPercent`), `history.test.ts`, `ShareDialog.test.tsx` (the step line, another brain's progress ignored, the bar's value, the link in the box, Copy), `BrainScreen.test.tsx` (the Join link card; the chip after a colleague's entry arrives, History marking it new, the chip gone after the look).

In a scratch dev app (`SHELLIE_USER_DATA`, own debug port, mock keychain, the Azure DevOps test project), driven over CDP:

- A share to a GitHub address that does not exist showed "Opening the repo…" with the sliding bar and "Sharing…", then the token step.
- The demo brain was then made a shared one by hand (a `sharing` record in `brains.json`, a local bare repo as its server, a second clone committing as "Anna Peeters" with another install email). After Anna pushed a source and its capture (two new pages, one changed) and the app pulled (`brain:syncNow`), the chip read "Anna Peeters added 3 pages"; clicking it opened History with her three entries marked New, the week's sums for both people, and the chip gone. A page link opened the page in Read. The Join link card showed the link in the box and Copy turned to "Copied".

## Known gaps

- **The upload step itself was not seen in the running app** (no real share went through there); its percentages come from the git test, its look from the component test.
- **Not run on Windows**, the release target: reading git's progress from stderr while the push runs is untested there.
- The owner's own brain was not used; the check ran on a hand-made one.
- No light theme screenshot was taken (only tokens are used).
- The chip shows on the Brain page only; someone who never opens the brain sees nothing.
- History needs one `git log` per brain change while the Brain page is open (debounced with the other reads).
- A brain's history from before it was shared is not in History: the share starts a fresh history.
