import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitClient } from '../services/GitClient';
import { TEMPLATES_VERSION, templateFiles } from './templates';

const SKILLS = ['capture', 'sync', 'lint', 'digest'];

const abs = (dir: string, rel: string) => path.join(dir, ...rel.split('/'));

async function writeAll(
  dir: string,
  files: { path: string; content: string }[],
) {
  for (const f of files) {
    await fs.mkdir(path.dirname(abs(dir, f.path)), { recursive: true });
    await fs.writeFile(abs(dir, f.path), f.content);
  }
}

/** Create the folder, write the templates, `git init` on main and make the first commit. */
export async function scaffoldBrain(
  git: GitClient,
  dir: string,
  name: string,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await writeAll(dir, [
    ...templateFiles(name),
    { path: 'sources/.gitkeep', content: '' },
    { path: 'wiki/.gitkeep', content: '' },
  ]);
  await git.run(dir, ['init', '-b', 'main']);
  await git.run(dir, ['config', 'user.name', 'Shellie']);
  await git.run(dir, ['config', 'user.email', 'shellie@localhost']);
  await git.run(dir, ['add', '-A']);
  await git.run(dir, ['commit', '-m', 'Brain created']);
}

const exists = (p: string) =>
  fs.stat(p).then(
    (s) => s.isFile(),
    () => false,
  );

/** True when SCHEMA.md and the four skills are there. */
export async function isBrainFolder(dir: string): Promise<boolean> {
  const needed = [
    'SCHEMA.md',
    ...SKILLS.map((s) => `.claude/skills/${s}/SKILL.md`),
  ];
  return (await Promise.all(needed.map((p) => exists(abs(dir, p))))).every(
    Boolean,
  );
}

export async function templateDiff(
  dir: string,
  name: string,
): Promise<{ path: string; status: 'same' | 'changed' | 'missing' }[]> {
  return Promise.all(
    templateFiles(name).map(async (f) => {
      try {
        const current = await fs.readFile(abs(dir, f.path), 'utf8');
        return {
          path: f.path,
          status:
            current === f.content ? ('same' as const) : ('changed' as const),
        };
      } catch {
        return { path: f.path, status: 'missing' as const };
      }
    }),
  );
}

/** Overwrite the given template paths and commit. Paths that are not templates are ignored. */
export async function applyTemplates(
  git: GitClient,
  dir: string,
  name: string,
  paths: string[],
): Promise<void> {
  const wanted = new Set(paths);
  const files = templateFiles(name).filter((f) => wanted.has(f.path));
  await writeAll(dir, files);
  await git.run(dir, ['add', '-A', '--', ...files.map((f) => f.path)]);
  await git.run(dir, [
    'commit',
    '--allow-empty',
    '-m',
    `Brain: update skills to v${TEMPLATES_VERSION}`,
  ]);
}
