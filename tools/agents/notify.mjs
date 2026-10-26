// The notifier (spec 5.6), no LLM: tells the reporter which release has the fix, and the owner when a
// merged fix never reached a release. Run by .github/workflows/agents-notify.yml.
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseConfig } from './config.mjs';
import { createGitHub, readTokenFile } from './github.mjs';
import { needsRelease } from '../release/needs-release.mjs';
import { findStatusComment, parseStatus, renderStatus } from './state.mjs';

const LIVE_MODES = ['implement', 'full'];
// releases are bundled at 12:00 and 17:00 Brussels: the longest wait (17:00 to 12:00) is 19 h, so 26 h means one was missed
const LATE_MS = 26 * 3600000;

export async function runNotify({ gh, config, mode, now, summary }) {
  if (!LIVE_MODES.includes(mode)) {
    summary(`Notifier is off (AGENTS_MODE=${mode || 'unset'}).`);
    return;
  }
  const bot = config.botLogin;
  let releases;
  for (const issue of await gh.listIssuesByLabel('agent:merged')) {
    const comment = findStatusComment(await gh.listComments(issue.number), bot);
    const status = comment ? parseStatus(comment.body) : null;
    if (!status?.mergeSha) continue;
    const write = (next, line) =>
      gh.editComment(comment.id, renderStatus(next, line));

    // the earliest published release that contains the merge commit
    releases ??= (await gh.listReleases())
      .filter((r) => !r.draft && r.published_at)
      .sort((a, b) => a.published_at.localeCompare(b.published_at));
    // a fix that changes no app files makes no release (tools/release/needs-release.mjs): nothing to wait for
    if (!needsRelease(await gh.commitFiles(status.mergeSha))) {
      await gh.comment(
        issue.number,
        `Fixed on \`main\` in ${status.mergeSha.slice(0, 7)}. The change touches no app files (tests, docs or tooling), so there is no new version of Shellie for it.`,
      );
      await gh.addLabels(issue.number, ['agent:released']);
      await gh.removeLabel(issue.number, 'agent:merged');
      if (issue.state === 'open') await gh.close(issue.number, 'completed');
      await write(
        {
          ...status,
          state: 'released',
          release: null,
          releasedAt: now.toISOString(),
        },
        '**Fixed on main** (no app change, so no release).',
      );
      summary(`#${issue.number}: fixed without an app change; closed`);
      continue;
    }
    let found = null;
    for (const r of releases.filter(
      (x) => x.published_at >= (status.mergedAt ?? ''),
    )) {
      const c = await gh.compare(status.mergeSha, r.tag_name);
      if (c.status === 'ahead' || c.status === 'identical') {
        found = r;
        break;
      }
    }

    if (found) {
      const day = found.published_at.slice(0, 10);
      await gh.comment(
        issue.number,
        `Fixed in **${found.tag_name}** (released ${day}). Shellie updates itself within about half an hour; restart when it offers. macOS: only builds in /Applications update.`,
      );
      await gh.addLabels(issue.number, ['agent:released']);
      await gh.removeLabel(issue.number, 'agent:merged');
      if (issue.state === 'open') await gh.close(issue.number, 'completed');
      await write(
        {
          ...status,
          state: 'released',
          release: found.tag_name,
          releasedAt: now.toISOString(),
        },
        `**Released** in ${found.tag_name}.`,
      );
      summary(`#${issue.number}: released in ${found.tag_name}`);
    } else if (
      now.getTime() - Date.parse(status.mergedAt) > LATE_MS &&
      !status.releaseLateNoted
    ) {
      await gh.comment(
        issue.number,
        `The fix was merged ${Math.round((now.getTime() - Date.parse(status.mergedAt)) / 3600000)} hours ago but no release has it yet, although one is made at 12:00 and 17:00 Brussels time. The scheduled release may have failed, or \`main\`'s CI is red.`,
      );
      await gh.addLabels(issue.number, ['agent:needs-owner']);
      await write(
        { ...status, releaseLateNoted: true },
        '**Merged, not released yet:** the owner has a look.',
      );
      summary(`#${issue.number}: merged but not released after 26 hours`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const out = process.env.GITHUB_STEP_SUMMARY;
  await runNotify({
    gh: createGitHub(
      process.env.GITHUB_REPOSITORY ?? 'UnreliableWitness/Shellie',
      readTokenFile(process.env.AGENTS_GH_TOKEN_FILE),
    ),
    config: parseConfig(
      readFileSync(
        new URL('../../.github/agents/config.yml', import.meta.url),
        'utf8',
      ),
    ),
    mode: process.env.AGENTS_MODE ?? 'off',
    now: new Date(),
    summary: (line) => {
      console.log(line);
      if (out) appendFileSync(out, `- ${line}\n`);
    },
  });
}
