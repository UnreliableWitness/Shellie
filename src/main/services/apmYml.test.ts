import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readApmYmlTargets } from './apmYml';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const repoWith = (apmYml?: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'apmyml-'));
  dirs.push(dir);
  if (apmYml !== undefined) writeFileSync(path.join(dir, 'apm.yml'), apmYml);
  return dir;
};

describe('readApmYmlTargets', () => {
  it('reads a targets list', async () => {
    expect(
      await readApmYmlTargets(
        repoWith('name: x\ntargets: [claude, opencode]\n'),
      ),
    ).toEqual(['claude', 'opencode']);
  });

  it('reads a single target string, comma lists and vscode as copilot', async () => {
    expect(await readApmYmlTargets(repoWith('target: claude\n'))).toEqual([
      'claude',
    ]);
    expect(
      await readApmYmlTargets(repoWith('target: "vscode, claude"\n')),
    ).toEqual(['copilot', 'claude']);
  });

  it('is undefined without apm.yml, without the key, for all, or for a bad value', async () => {
    expect(await readApmYmlTargets(repoWith())).toBeUndefined();
    expect(await readApmYmlTargets(repoWith('name: x\n'))).toBeUndefined();
    expect(await readApmYmlTargets(repoWith('target: all\n'))).toBeUndefined();
    expect(
      await readApmYmlTargets(repoWith('targets: {claude: true}\n')),
    ).toBeUndefined();
    expect(await readApmYmlTargets(repoWith('targets: [\n'))).toBeUndefined();
  });
});
