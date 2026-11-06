/**
 * Home's What's new card (#126): the short notes of the releases installed since the card was last dismissed.
 *
 * The long notes are the GitHub Release bodies, which the release job makes with `gh release create
 * --generate-notes` (the merged PRs). The app reads them from the public GitHub Releases API after an update,
 * rather than bundling them at build time, because one update can skip several releases (a release per merge)
 * and only the API knows the ones in between; it is one unauthenticated call per launch, only while a card is
 * due. When GitHub cannot be reached the card still shows, with only the link to the release.
 */
import type { ReleaseNote, WhatsNew } from '../shared/ipc';
import type { AppSettings } from '../shared/usage';
import { UPDATE_REPO } from './autoUpdate';

const RELEASES_API = `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=30`;
const RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/releases`;
const FETCH_TIMEOUT_MS = 10_000;

/** The fields of a GitHub Releases API entry this module reads. */
export type GitHubRelease = {
  tag_name: string;
  html_url: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
};

const releasePage = (version: string) => `${RELEASES_PAGE}/tag/v${version}`;

/**
 * The bullets of a release body as one-line notes. GitHub's generated notes list each PR as
 * "* Title by @author in <url>"; the author, the link and trailing "(#123)" references are dropped.
 * The New Contributors section is left out.
 */
export function shortNotes(body: string | null | undefined): string[] {
  const out: string[] = [];
  for (const line of (body ?? '').split(/\r?\n/)) {
    if (/^#+\s*new contributors/i.test(line.trim())) break;
    const m = line.match(/^\s*[*-]\s+(.+)$/);
    if (!m) continue;
    const text = m[1]
      .replace(/\s+by @\S+ in \S+\s*$/, '')
      .replace(/(\s*\(#\d+\))+\s*$/, '')
      .trim();
    if (text) out.push(text);
  }
  return out;
}

const parse = (v: string) =>
  (v.match(/^v?(\d+)\.(\d+)\.(\d+)/)?.slice(1) ?? []).map(Number);

/** Compares x.y.z versions by number; a pre-release suffix is ignored. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const isVersion = (v: string) => /^\d+\.\d+\.\d+$/.test(v);

/** Published releases after `from` up to and including `to`, newest first; only `to` when `from` is null. */
export function pickReleases(
  list: GitHubRelease[],
  from: string | null,
  to: string,
): ReleaseNote[] {
  return list
    .filter((r) => !r.draft && !r.prerelease)
    .map((r) => ({ r, version: r.tag_name.replace(/^v/, '') }))
    .filter(({ version }) => isVersion(version))
    .filter(({ version }) =>
      from === null
        ? compareVersions(version, to) === 0
        : compareVersions(version, from) > 0 &&
          compareVersions(version, to) <= 0,
    )
    .sort((a, b) => compareVersions(b.version, a.version))
    .map(({ r, version }) => ({
      version,
      url: r.html_url || releasePage(version),
      items: shortNotes(r.body),
    }));
}

/**
 * Where the card starts: undefined when no card is due, null for "the running version only" (an install from
 * before the card, which never recorded a version), else the last seen version.
 */
export function whatsNewFrom(
  settings: AppSettings,
  version: string,
): string | null | undefined {
  const seen = settings.whatsNewSeen;
  if (!seen) return null;
  return compareVersions(version, seen) > 0 ? seen : undefined;
}

/**
 * At boot: a fresh install (Get started not dismissed) records its version as seen, so it gets no card for the
 * version it was installed with. Returns the version to save, or null when nothing changes. Runs after the
 * onboarding migration, which marks installs from before Get started as dismissed.
 */
export function seenAtBoot(
  settings: AppSettings,
  version: string,
): string | null {
  if (settings.whatsNewSeen) return null;
  return settings.onboarding.dismissedAt === null ? version : null;
}

export type WhatsNewService = { get(): Promise<WhatsNew | null> };

export function createWhatsNew(d: {
  version: string;
  settings: () => AppSettings;
  fetch?: typeof fetch;
}): WhatsNewService {
  const doFetch = d.fetch ?? fetch;
  let releases: Promise<GitHubRelease[] | null> | null = null;
  const load = async (): Promise<GitHubRelease[] | null> => {
    try {
      const res = await doFetch(RELEASES_API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Shellie',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const list = (await res.json()) as unknown;
      return Array.isArray(list) ? (list as GitHubRelease[]) : null;
    } catch {
      return null;
    }
  };
  return {
    async get() {
      const from = whatsNewFrom(d.settings(), d.version);
      if (from === undefined) return null;
      releases ??= load();
      const list = await releases;
      // A failed fetch is tried again on the next Home visit.
      if (list === null) releases = null;
      const picked = list ? pickReleases(list, from, d.version) : [];
      return {
        version: d.version,
        url: picked.length > 1 ? RELEASES_PAGE : releasePage(d.version),
        fetched: list !== null,
        releases: picked,
      };
    },
  };
}
