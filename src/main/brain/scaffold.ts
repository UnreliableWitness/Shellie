import fs from 'node:fs/promises';
import path from 'node:path';
import { isFile } from '../fsRetry';
import type { GitClient } from '../services/GitClient';
import { CREATED_MESSAGE } from './brainCommits';
import { withBrainGit } from './gitMutex';
import { absPath } from './paths';
import {
  managedTemplateFiles,
  TEMPLATES_VERSION,
  templateFiles,
} from './templates';

const SKILLS = ['capture', 'sync', 'lint', 'digest'];

async function writeAll(
  dir: string,
  files: { path: string; content: string }[],
) {
  for (const f of files) {
    await fs.mkdir(path.dirname(absPath(dir, f.path)), { recursive: true });
    await fs.writeFile(absPath(dir, f.path), f.content);
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
  await withBrainGit(dir, async () => {
    await git.run(dir, ['init', '-b', 'main']);
    await git.run(dir, ['config', 'user.name', 'Shellie']);
    await git.run(dir, ['config', 'user.email', 'shellie@localhost']);
    await git.run(dir, ['add', '-A']);
    await git.run(dir, ['commit', '-m', CREATED_MESSAGE]);
  });
}

/** True when SCHEMA.md and the four skills are there. */
export async function isBrainFolder(dir: string): Promise<boolean> {
  const needed = [
    'SCHEMA.md',
    ...SKILLS.map((s) => `.claude/skills/${s}/SKILL.md`),
  ];
  return (await Promise.all(needed.map((p) => isFile(absPath(dir, p))))).every(
    Boolean,
  );
}

export async function templateDiff(
  dir: string,
  name: string,
): Promise<{ path: string; status: 'same' | 'changed' | 'missing' }[]> {
  return Promise.all(
    managedTemplateFiles(name).map(async (f) => {
      try {
        const current = await fs.readFile(absPath(dir, f.path), 'utf8');
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

/** Overwrite the given managed template paths and commit. Other paths (seeded files, anything else) are ignored. */
export async function applyTemplates(
  git: GitClient,
  dir: string,
  name: string,
  paths: string[],
): Promise<void> {
  const wanted = new Set(paths);
  const files = managedTemplateFiles(name).filter((f) => wanted.has(f.path));
  await writeAll(dir, files);
  const written = files.map((f) => f.path);
  await withBrainGit(dir, async () => {
    await git.run(dir, ['add', '-A', '--', ...written]);
    // Only the template files: nothing else staged in the brain lands in this commit.
    await git.run(dir, [
      'commit',
      '--allow-empty',
      '-m',
      `Brain: update skills to v${TEMPLATES_VERSION}`,
      ...(written.length ? ['--', ...written] : []),
    ]);
  });
}
