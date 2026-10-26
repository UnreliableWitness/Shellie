import { describe, expect, it } from 'vitest';
import { needsRelease } from './needs-release.mjs';

describe('needsRelease', () => {
  it('releases for anything that goes into the app', () => {
    for (const f of [
      'src/main/ipc/handlers.ts',
      'src/renderer/App.tsx',
      'package.json',
      'package-lock.json',
      'forge.config.mts',
      'vite.main.config.mts',
      'index.html',
      'splash.html',
      'assets/icon/shellie.svg',
      'assets/entitlements.mac.plist',
      'scripts/fix-node-pty-perms.mjs',
      'tools/forge/smoke.mjs',
    ])
      expect(needsRelease([f]), f).toBe(true);
  });

  it('does not release for the agent pipeline, docs, art sources, design, tests or dev tools', () => {
    expect(
      needsRelease([
        '.github/workflows/agents-pr.yml',
        '.github/agents/config.yml',
        '.claude/skills/sdlc-fix/SKILL.md',
        'tools/agents/pr.mjs',
        'tools/art/prompts.md',
        'tools/ado/seed-test-items.mjs',
        'tools/release/next-version.mjs',
        'docs/changes/2026-10-26-x.md',
        'CLAUDE.md',
        'README.md',
        'assets/ART.md',
        'assets/agents/avatar.png',
        'design/mockups/home.png',
        'src/main/ipc/handlers.part1.test.ts',
        'src/renderer/components/review/ChangesTab.test.tsx',
        'src/main/test-helpers/gitRepo.ts',
        'src/main/ipc/handlersHarness.ts',
        'vitest.config.mts',
      ]),
    ).toBe(false);
  });

  it('releases when any one file goes into the app', () => {
    expect(
      needsRelease(['docs/agents.md', 'src/main/services/SetupRunner.ts']),
    ).toBe(true);
  });

  it('releases when it cannot tell', () => {
    expect(needsRelease([])).toBe(false);
    expect(needsRelease(['some/new/folder/thing.ts'])).toBe(true);
  });
});
