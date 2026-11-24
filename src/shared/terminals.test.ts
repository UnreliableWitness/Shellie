import { describe, expect, it } from 'vitest';
import { setupTabsFrom, tabsWithAgent } from './terminals';
import { AppSettingsSchema, defaultSettings } from './usage';

describe('default terminals', () => {
  it('opens Claude Code and a shell unless changed', () => {
    expect(defaultSettings().defaultTerminals).toEqual({
      claude: true,
      copilot: false,
      opencode: false,
      shell: true,
    });
  });

  it('defaults for settings saved before the choice existed', () => {
    const old: Record<string, unknown> = { ...defaultSettings() };
    delete old.defaultTerminals;
    expect(AppSettingsSchema.parse(old).defaultTerminals).toEqual(
      defaultSettings().defaultTerminals,
    );
  });

  it('fills in a tab that an older settings file does not name', () => {
    const parsed = AppSettingsSchema.parse({
      ...defaultSettings(),
      defaultTerminals: { claude: false, shell: true },
    });
    expect(parsed.defaultTerminals).toEqual({
      claude: false,
      copilot: false,
      opencode: false,
      shell: true,
    });
  });

  it('turns the choice into the task setup flags', () => {
    expect(
      setupTabsFrom({
        claude: false,
        copilot: false,
        opencode: true,
        shell: true,
      }),
    ).toEqual({
      startClaude: false,
      openShell: true,
      openCopilot: false,
      openOpencode: true,
    });
  });
});

describe('tabsWithAgent', () => {
  const tab = (kind: string, id = kind) => ({ kind, id });
  const make = () => tab('copilot', 'new');

  it('puts the agent where the first agent tab was and drops the other agents', () => {
    expect(
      tabsWithAgent(
        [tab('run'), tab('claude'), tab('opencode'), tab('shell')],
        'copilot',
        make,
      ),
    ).toEqual([tab('run'), tab('copilot', 'new'), tab('shell')]);
  });

  it("keeps the agent's own tabs, so their sessions resume", () => {
    expect(
      tabsWithAgent(
        [tab('claude', 'a'), tab('copilot', 'mine'), tab('shell')],
        'copilot',
        make,
      ),
    ).toEqual([tab('copilot', 'mine'), tab('shell')]);
  });

  it('puts the agent first when the task had no agent tab', () => {
    expect(tabsWithAgent([tab('shell')], 'copilot', make)).toEqual([
      tab('copilot', 'new'),
      tab('shell'),
    ]);
  });
});
