import { describe, expect, it } from 'vitest';
import { shimSafePrompt, windowsPlatform } from './windows';

const WRAP = (cmd: string) =>
  [
    '$shellieFailed = $false',
    '& {',
    cmd,
    '} 2>&1 | ForEach-Object {',
    '  if ($_ -is [System.Management.Automation.ErrorRecord]) {',
    `    if ("$($_.FullyQualifiedErrorId)" -notlike 'NativeCommandError*') { $shellieFailed = $true }`,
    '    [Console]::Error.WriteLine("$_")',
    '  } else { $_ }',
    '}',
    'if ($LASTEXITCODE) { exit $LASTEXITCODE }',
    'if ($shellieFailed) { exit 1 }',
  ].join('\n');
const RUN_WRAP = (cmd: string) =>
  ['& {', cmd, '}', 'if ($LASTEXITCODE) { exit $LASTEXITCODE }'].join('\n');
const make = (found: Record<string, string>) =>
  windowsPlatform({}, { which: (n) => found[n] ?? null });

describe('windowsPlatform', () => {
  it('has no user secrets folder without APPDATA or USERPROFILE', () => {
    expect(
      windowsPlatform({}, { which: () => null }).userSecretsDir('abc'),
    ).toBeNull();
  });
  it('keeps .NET user secrets under %APPDATA%\\Microsoft\\UserSecrets', () => {
    const p = windowsPlatform(
      { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
      { which: () => null },
    );
    expect(p.userSecretsDir('abc')).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\UserSecrets\\abc',
    );
  });
  it('probes an agent CLI with Get-Command', () => {
    expect(make({ pwsh: 'C:\\pwsh\\pwsh.exe' }).probeCommand('claude')).toEqual(
      {
        command: 'C:\\pwsh\\pwsh.exe',
        args: [
          '-NoLogo',
          '-ExecutionPolicy',
          'Bypass',
          '-NoProfile',
          '-Command',
          '(Get-Command claude -ErrorAction Stop).Source; & claude --version',
        ],
      },
    );
  });

  it('prefers pwsh and falls back to Windows PowerShell', () => {
    expect(make({ pwsh: 'C:\\pwsh\\pwsh.exe' }).interactiveShell()).toEqual({
      command: 'C:\\pwsh\\pwsh.exe',
      args: ['-NoLogo', '-ExecutionPolicy', 'Bypass'],
    });
    expect(make({}).interactiveShell()).toEqual({
      command: 'powershell.exe',
      args: ['-NoLogo', '-ExecutionPolicy', 'Bypass'],
    });
    expect(make({}).shellLabel).toBe('PowerShell');
  });

  it('runs setup commands so failures give a non-zero exit', () => {
    expect(make({}).shellCommand('npm ci')).toEqual({
      command: 'powershell.exe',
      args: [
        '-NoLogo',
        '-ExecutionPolicy',
        'Bypass',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        WRAP('npm ci'),
      ],
    });
  });

  it('keeps a trailing comment in a setup command from swallowing the wrapper', () => {
    const args = make({}).shellCommand('npm ci # install').args;
    expect(args.at(-1)).toBe(WRAP('npm ci # install'));
    expect(args.at(-1)).toContain('npm ci # install\n}');
  });

  it('runs terminal commands without the setup pipe, so the console stays a console', () => {
    expect(make({}).runCommand('npm run dev')).toEqual({
      command: 'powershell.exe',
      args: [
        '-NoLogo',
        '-ExecutionPolicy',
        'Bypass',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        RUN_WRAP('npm run dev'),
      ],
    });
    const text = make({}).runCommand('npm run dev # dev').args.at(-1);
    expect(text).toContain('npm run dev # dev\n}');
    expect(text).not.toContain('2>&1');
    expect(text).not.toContain('ForEach-Object');
  });

  it('passes a run command its extra arguments through an env var as data, never in the command text', () => {
    const cmd = make({}).runCommand('npm run dev', ["it's", '$(x); y']);
    const text = cmd.args.at(-1)!;
    expect(text).toBe(
      [
        '$shellieArgs = [string[]](ConvertFrom-Json $env:SHELLIE_RUN_ARGS)',
        '& {',
        'npm run dev @shellieArgs',
        '}',
        'if ($LASTEXITCODE) { exit $LASTEXITCODE }',
      ].join('\n'),
    );
    expect(text).not.toContain('$(x)');
    expect(cmd.env).toEqual({
      SHELLIE_RUN_ARGS: JSON.stringify(["it's", '$(x); y']),
    });
    expect(make({}).runCommand('npm run dev', [])).toEqual(
      make({}).runCommand('npm run dev'),
    );
  });

  it('runs setup commands in order in a console, stopping at the first failing exit code', () => {
    const text = make({}).setupCommands(['npm ci', "echo 'x' # y"]).args.at(-1);
    expect(text).toBe(
      [
        "Write-Host '$ npm ci'",
        '& {',
        'npm ci',
        '}',
        'if ($LASTEXITCODE) { exit $LASTEXITCODE }',
        "Write-Host '$ echo ''x'' # y'",
        '& {',
        "echo 'x' # y",
        '}',
        'if ($LASTEXITCODE) { exit $LASTEXITCODE }',
      ].join('\n'),
    );
    expect(text).not.toContain('2>&1');
  });

  it('has no cheap folder clone', () => {
    expect(make({}).cloneDir).toBeUndefined();
  });

  it('starts a native claude.exe directly with the context as one argument', () => {
    const prompt = `Work on Issue 3: Coupon field ignores O'Brien style "names"`;
    expect(
      make({ claude: 'C:\\Users\\d\\.local\\bin\\claude.exe' }).claudeCommand(
        prompt,
      ),
    ).toEqual({
      command: 'C:\\Users\\d\\.local\\bin\\claude.exe',
      args: ['--append-system-prompt', prompt],
    });
  });

  it('keeps the flags when the tool is not on PATH, so PowerShell reports the real command line', () => {
    // The CI runner has no claude: `claude -p` must still reach PowerShell (it answers "not recognized"),
    // not a bare `claude` that drops the print flag (tasks:prSummary asserts on it).
    expect(
      make({}).claudeCommand(null, ['-p', '--output-format', 'json']),
    ).toEqual({
      command: 'powershell.exe',
      args: [
        '-NoLogo',
        '-ExecutionPolicy',
        'Bypass',
        '-NoProfile',
        '-Command',
        "& claude '-p' '--output-format' 'json'",
      ],
    });
  });

  it('starts an npm shim through PowerShell with the context in an env var', () => {
    const prompt = `it's "quoted" & <b> | 50% ^x`;
    expect(
      make({ claude: 'C:\\npm\\claude.cmd' }).claudeCommand(prompt),
    ).toEqual({
      command: 'powershell.exe',
      args: [
        '-NoLogo',
        '-ExecutionPolicy',
        'Bypass',
        '-NoProfile',
        '-Command',
        "& claude '--append-system-prompt' $env:SHELLIE_CLAUDE_PROMPT",
      ],
      env: { SHELLIE_CLAUDE_PROMPT: "it's 'quoted' b 50 x" },
    });
  });

  it('passes a first message last: an argument to claude.exe, an env var through a shim', () => {
    expect(
      make({ claude: 'C:\\bin\\claude.exe' }).claudeCommand(
        null,
        ['--session-id', 'abc'],
        undefined,
        'What is "in scope"?',
      ).args,
    ).toEqual(['--session-id', 'abc', 'What is "in scope"?']);
    expect(
      make({ claude: 'C:\\npm\\claude.cmd' }).claudeCommand(
        'ctx',
        ['--session-id', 'abc'],
        undefined,
        'What is "in scope"?',
      ),
    ).toMatchObject({
      args: expect.arrayContaining([
        "& claude '--session-id' 'abc' '--append-system-prompt' $env:SHELLIE_CLAUDE_PROMPT $env:SHELLIE_CLAUDE_FIRST_MESSAGE",
      ]),
      env: {
        SHELLIE_CLAUDE_PROMPT: 'ctx',
        SHELLIE_CLAUDE_FIRST_MESSAGE: "What is 'in scope'?",
      },
    });
  });

  it('passes session flags before the prompt to claude.exe and a shim', () => {
    expect(
      make({ claude: 'C:\\bin\\claude.exe' }).claudeCommand('go', [
        '--session-id',
        'abc',
      ]).args,
    ).toEqual(['--session-id', 'abc', '--append-system-prompt', 'go']);
    expect(
      make({ claude: 'C:\\bin\\claude.exe' }).claudeCommand(null, [
        '--resume',
        'abc',
      ]).args,
    ).toEqual(['--resume', 'abc']);
    expect(
      make({ claude: 'C:\\npm\\claude.cmd' })
        .claudeCommand('go', ['--session-id', 'abc'])
        .args.at(-1),
    ).toBe(
      "& claude '--session-id' 'abc' '--append-system-prompt' $env:SHELLIE_CLAUDE_PROMPT",
    );
    const resume = make({ claude: 'C:\\npm\\claude.cmd' }).claudeCommand(null, [
      '--continue',
    ]);
    expect(resume.args.at(-1)).toBe("& claude '--continue'");
    expect(resume.env).toBeUndefined();
  });

  it('lets PowerShell report a missing claude, with the context it would have had', () => {
    expect(make({}).claudeCommand('x')).toEqual({
      command: 'powershell.exe',
      args: [
        '-NoLogo',
        '-ExecutionPolicy',
        'Bypass',
        '-NoProfile',
        '-Command',
        "& claude '--append-system-prompt' $env:SHELLIE_CLAUDE_PROMPT",
      ],
      env: { SHELLIE_CLAUDE_PROMPT: 'x' },
    });
  });

  it("runs the repo's own claude command through PowerShell, even with a claude.exe on PATH", () => {
    expect(
      make({ claude: 'C:\\bin\\claude.exe' }).claudeCommand(
        `it's "go"`,
        ['--session-id', 'abc'],
        'claude --permission-mode acceptEdits',
      ),
    ).toEqual({
      command: 'powershell.exe',
      args: [
        '-NoLogo',
        '-ExecutionPolicy',
        'Bypass',
        '-NoProfile',
        '-Command',
        "& claude --permission-mode acceptEdits '--session-id' 'abc' '--append-system-prompt' $env:SHELLIE_CLAUDE_PROMPT",
      ],
      env: { SHELLIE_CLAUDE_PROMPT: "it's 'go'" },
    });
    // An empty command is the default.
    expect(
      make({ claude: 'C:\\bin\\claude.exe' }).claudeCommand(null, [], ' '),
    ).toEqual({ command: 'C:\\bin\\claude.exe', args: [] });
  });

  it("runs the repo's own opencode command", () => {
    expect(
      make({ opencode: 'C:\\o\\opencode.exe' })
        .opencodeCommand('opencode --foo')
        .args.at(-1),
    ).toBe('& opencode --foo');
  });

  it('starts opencode like copilot', () => {
    expect(make({ opencode: 'C:\\o\\opencode.exe' }).opencodeCommand()).toEqual(
      { command: 'C:\\o\\opencode.exe', args: [] },
    );
    expect(
      make({ opencode: 'C:\\npm\\opencode.cmd' }).opencodeCommand().args.at(-1),
    ).toBe('& opencode');
  });

  it('starts copilot the same way', () => {
    expect(make({ copilot: 'C:\\c\\copilot.exe' }).copilotCommand()).toEqual({
      command: 'C:\\c\\copilot.exe',
      args: [],
    });
    expect(make({ copilot: 'C:\\npm\\copilot.cmd' }).copilotCommand()).toEqual({
      command: 'powershell.exe',
      args: [
        '-NoLogo',
        '-ExecutionPolicy',
        'Bypass',
        '-NoProfile',
        '-Command',
        '& copilot',
      ],
    });
  });

  it('opens VS Code with a quoted path', () => {
    expect(
      make({ code: 'C:\\VS\\bin\\code.cmd' }).editorCommand(
        "C:\\src\\o'brien.worktrees\\3-x",
      ),
    ).toEqual({
      command: 'powershell.exe',
      args: [
        '-NoLogo',
        '-ExecutionPolicy',
        'Bypass',
        '-NoProfile',
        '-Command',
        "& code 'C:\\src\\o''brien.worktrees\\3-x'",
      ],
    });
  });

  it('quotes typographic single quotes in paths, which PowerShell also treats as quotes', () => {
    const [l, r, low, rev] = [0x2018, 0x2019, 0x201a, 0x201b].map((c) =>
      String.fromCharCode(c),
    );
    const p = `C:\\src\\o${r}brien ${l}x${low}${rev}`;
    expect(
      make({ code: 'C:\\VS\\bin\\code.cmd' }).editorCommand(p).args.at(-1),
    ).toBe(
      `& code 'C:\\src\\o${r}${r}brien ${l}${l}x${low}${low}${rev}${rev}'`,
    );
  });

  it('opens VS Code at a file and line with quoted paths', () => {
    const cmd = make({ code: 'C:\\VS\\bin\\code.cmd' }).editorGotoCommand(
      'C:\\src\\wt',
      "C:\\src\\wt\\o'b.md",
      4,
    );
    expect(cmd.args.at(-1)).toContain(
      "& code 'C:\\src\\wt' -g 'C:\\src\\wt\\o''b.md:4:1'",
    );
  });

  it('starts Code.exe next to the code shim directly when it is there (#73)', () => {
    const p = windowsPlatform(
      {},
      {
        which: (n) => (n === 'code' ? 'C:\\VS Code\\bin\\code.cmd' : null),
        exists: (f) => f === 'C:\\VS Code\\Code.exe',
      },
    );
    expect(p.editorCommand("C:\\src\\o'b")).toEqual({
      command: 'C:\\VS Code\\Code.exe',
      args: ["C:\\src\\o'b"],
    });
    expect(p.editorGotoCommand('C:\\wt', 'C:\\wt\\a.md', 4)).toEqual({
      command: 'C:\\VS Code\\Code.exe',
      args: ['C:\\wt', '-g', 'C:\\wt\\a.md:4:1'],
    });
  });

  it('reports a missing VS Code clearly', () => {
    expect(() => make({}).editorCommand('C:\\x')).toThrow(
      'VS Code (code) is not on PATH',
    );
  });

  it('shimSafePrompt strips quotes and cmd metacharacters', () => {
    expect(shimSafePrompt(`a "b" & c | <d> ^ 5%`)).toBe("a 'b' c d 5");
  });
});
