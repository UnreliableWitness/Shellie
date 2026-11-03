import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { darwinPlatform } from './darwin';

describe('darwinPlatform', () => {
  it('has no user secrets folder without a home folder', () => {
    expect(darwinPlatform({}).userSecretsDir('abc')).toBeNull();
  });
  it('keeps .NET user secrets under ~/.microsoft/usersecrets', () => {
    expect(darwinPlatform({ HOME: '/Users/me' }).userSecretsDir('abc')).toBe(
      '/Users/me/.microsoft/usersecrets/abc',
    );
  });
  const p = darwinPlatform({ SHELL: '/bin/zsh' });
  it('opens a login shell for interactive tabs', () => {
    expect(p.interactiveShell()).toEqual({ command: '/bin/zsh', args: ['-l'] });
    expect(p.shellLabel).toBe('zsh');
  });
  it('runs a command through a login shell so PATH is loaded', () => {
    expect(p.shellCommand('npm run dev')).toEqual({
      command: '/bin/zsh',
      args: ['-l', '-c', 'npm run dev'],
    });
  });
  it('runs a terminal command the same way as a setup command', () => {
    expect(p.runCommand('npm run dev')).toEqual({
      command: '/bin/zsh',
      args: ['-l', '-c', 'npm run dev'],
    });
  });
  it('passes a run command its extra arguments as arguments, never in the shell line', () => {
    expect(p.runCommand('npm run dev', ['--port', '$(rm -rf ~)'])).toEqual({
      command: '/bin/zsh',
      args: [
        '-l',
        '-c',
        'npm run dev "$@"',
        'shellie',
        '--port',
        '$(rm -rf ~)',
      ],
    });
    expect(p.runCommand('npm run dev', [])).toEqual(
      p.runCommand('npm run dev'),
    );
  });
  it('runs setup commands in order in one login shell, stopping at the first failure', () => {
    expect(p.setupCommands(['npm ci', "echo 'hi'"])).toEqual({
      command: '/bin/zsh',
      args: [
        '-l',
        '-c',
        [
          'set -e',
          "printf '%s\\n' '$ npm ci'",
          'npm ci',
          "printf '%s\\n' '$ echo '\\''hi'\\'''",
          "echo 'hi'",
        ].join('\n'),
      ],
    });
  });
  it('clones a folder in one APFS clonefile call through JavaScript for Automation', () => {
    const cmd = p.cloneDir?.('/r/node_modules', '/w/node_modules');
    expect(cmd?.command).toBe('/usr/bin/osascript');
    expect(cmd?.args.slice(0, 3)).toEqual(['-l', 'JavaScript', '-e']);
    expect(cmd?.args[3]).toContain('$.clonefile(argv[0], argv[1], 0)');
    expect(cmd?.args.slice(4)).toEqual(['/r/node_modules', '/w/node_modules']);
  });
  it('probes an agent CLI through the login shell', () => {
    expect(p.probeCommand('claude')).toEqual({
      command: '/bin/zsh',
      args: ['-l', '-c', 'command -v claude && claude --version'],
    });
  });

  it.runIf(process.platform === 'darwin')(
    'clones a real folder, and fails when the target exists',
    () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'shellie-clone-'));
      try {
        mkdirSync(path.join(root, 'src', 'a'), { recursive: true });
        writeFileSync(path.join(root, 'src', 'a', 'f.txt'), 'x');
        const run = () => {
          const c = p.cloneDir!(
            path.join(root, 'src'),
            path.join(root, 'dest'),
          );
          return spawnSync(c.command, c.args).status;
        };
        expect(run()).toBe(0);
        expect(
          readFileSync(path.join(root, 'dest', 'a', 'f.txt'), 'utf8'),
        ).toBe('x');
        expect(run()).not.toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it('starts claude with the task appended to its system prompt, quoted', () => {
    expect(p.claudeCommand("Work item 1: it's done")).toEqual({
      command: '/bin/zsh',
      args: [
        '-l',
        '-c',
        "exec claude '--append-system-prompt' 'Work item 1: it'\\''s done'",
      ],
    });
  });
  it('passes session flags first, and no context when resuming', () => {
    expect(p.claudeCommand('go', ['--session-id', 'abc'])).toEqual({
      command: '/bin/zsh',
      args: [
        '-l',
        '-c',
        "exec claude '--session-id' 'abc' '--append-system-prompt' 'go'",
      ],
    });
    expect(p.claudeCommand(null, ['--continue'])).toEqual({
      command: '/bin/zsh',
      args: ['-l', '-c', "exec claude '--continue'"],
    });
  });
  it('passes a first message last, quoted', () => {
    expect(
      p.claudeCommand(null, ['--resume', 'abc'], undefined, "Fix it's link")
        .args,
    ).toEqual(['-l', '-c', "exec claude '--resume' 'abc' 'Fix it'\\''s link'"]);
  });
  it("runs the repo's own claude command as shell text, with Shellie's flags quoted after it", () => {
    expect(
      p.claudeCommand(
        'go',
        ['--session-id', 'abc'],
        'claude --permission-mode acceptEdits',
      ),
    ).toEqual({
      command: '/bin/zsh',
      args: [
        '-l',
        '-c',
        "exec claude --permission-mode acceptEdits '--session-id' 'abc' '--append-system-prompt' 'go'",
      ],
    });
    expect(p.claudeCommand(null, ['--continue'], '  ').args.at(-1)).toBe(
      "exec claude '--continue'",
    );
  });
  it("runs the repo's own opencode command", () => {
    expect(p.opencodeCommand('opencode --foo').args.at(-1)).toBe(
      'exec opencode --foo',
    );
    expect(p.opencodeCommand('').args.at(-1)).toBe('exec opencode');
  });
  it('starts Copilot CLI through a login shell', () => {
    expect(p.copilotCommand()).toEqual({
      command: '/bin/zsh',
      args: ['-l', '-c', 'exec copilot'],
    });
  });
  it('starts OpenCode through a login shell', () => {
    expect(p.opencodeCommand()).toEqual({
      command: '/bin/zsh',
      args: ['-l', '-c', 'exec opencode'],
    });
  });
  it('opens VS Code', () => {
    expect(p.editorCommand('/src/x')).toEqual({
      command: 'code',
      args: ['/src/x'],
    });
  });
  it('opens VS Code at a file and line in the worktree window', () => {
    expect(p.editorGotoCommand('/wt', '/wt/a.md', 12, 3)).toEqual({
      command: 'code',
      args: ['/wt', '-g', '/wt/a.md:12:3'],
    });
    expect(p.editorGotoCommand('/wt', '/wt/a.md').args[2]).toBe('/wt/a.md:1:1');
  });
  it('falls back to /bin/zsh when SHELL is unset', () => {
    expect(darwinPlatform({}).interactiveShell().command).toBe('/bin/zsh');
  });
});
