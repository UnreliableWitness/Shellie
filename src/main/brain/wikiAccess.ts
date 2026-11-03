import type { AdoWikiPage, BrainWiki } from '../../shared/brain';
import { azureHeaderScope, extraHeaderEnv } from '../services/gitAuth';
import { decodeName, type MirrorAuth } from './mirror';

/** Git env for the wiki's clone: the connection's PAT as an auth header scoped to the remote's organization. */
export const mirrorAuthFor =
  (token: (connectionId: string) => Promise<string>) =>
  (connectionId: string, gitUrl: string): MirrorAuth =>
  async () => {
    const scope = azureHeaderScope(gitUrl);
    return scope ? extraHeaderEnv(scope, await token(connectionId)) : {};
  };

/** The root page's file in the wiki repo ('' for the whole wiki), looked up in the page tree at refresh time. */
export async function rootGitItemPath(
  wiki: BrainWiki,
  pages: () => Promise<AdoWikiPage[]>,
): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  if (wiki.rootPath === '/') return { ok: true, path: '' };
  const page = (await pages()).find((p) => p.path === wiki.rootPath);
  return page
    ? { ok: true, path: page.gitItemPath }
    : { ok: false, message: `Root page not found: ${wiki.rootPath}` };
}

/** A mirrored file's page in Azure DevOps; `gitItemPath` is repo-relative (under mappedPath), as the mirror gives it. */
export function wikiPageUrl(
  organizationUrl: string,
  project: string,
  wiki: BrainWiki,
  gitItemPath: string,
): string {
  const mapped = wiki.mappedPath.split('/').filter(Boolean);
  const segs = gitItemPath.replace(/\.md$/i, '').split('/').filter(Boolean);
  const inWiki = segs.slice(
    mapped.every((m, i) => segs[i] === m) ? mapped.length : 0,
  );
  const pagePath = '/' + inWiki.map(decodeName).join('/');
  return `${organizationUrl.replace(/\/+$/, '')}/${encodeURIComponent(project)}/_wiki/wikis/${encodeURIComponent(wiki.wikiId)}?pagePath=${encodeURIComponent(pagePath)}`;
}
