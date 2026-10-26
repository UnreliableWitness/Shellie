import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * The targets the repo's apm.yml declares (`targets:` or `target:`, a list or a string), lower-cased, with APM's
 * `vscode` read as `copilot`. Undefined when there is no apm.yml, no such key, a value that is not strings, or `all`.
 */
export async function readApmYmlTargets(
  repoPath: string,
): Promise<string[] | undefined> {
  let doc: unknown;
  try {
    doc = parseYaml(await fs.readFile(path.join(repoPath, 'apm.yml'), 'utf8'));
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== 'object') return undefined;
  const raw =
    (doc as Record<string, unknown>).targets ??
    (doc as Record<string, unknown>).target;
  const items =
    typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : undefined;
  if (!items || !items.every((t) => typeof t === 'string')) return undefined;
  const targets = (items as string[])
    .flatMap((t) => t.split(','))
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .map((t) => (t === 'vscode' ? 'copilot' : t));
  if (targets.length === 0 || targets.includes('all')) return undefined;
  return [...new Set(targets)];
}
