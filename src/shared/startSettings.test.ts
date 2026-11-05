import { describe, expect, it } from 'vitest';
import { effectiveStartSettings, startSettingsSource } from './startSettings';

const own = {
  moveToInProgress: false,
  assignToMe: true,
  stateOverrides: { Bug: 'Doing' },
};
const proj = { moveToInProgress: true, assignToMe: false, stateOverrides: {} };

describe('effectiveStartSettings', () => {
  it('a repo without its own value inherits the project', () => {
    expect(effectiveStartSettings({}, { workItemOnStart: proj })).toEqual(proj);
    expect(startSettingsSource({}, { workItemOnStart: proj })).toBe('project');
  });
  it('a repo with its own value wins', () => {
    expect(
      effectiveStartSettings(
        { workItemOnStart: own },
        { workItemOnStart: proj },
      ),
    ).toEqual(own);
    expect(
      startSettingsSource({ workItemOnStart: own }, { workItemOnStart: proj }),
    ).toBe('repo');
  });
  it('no project and no own value gives the schema default', () => {
    expect(effectiveStartSettings({}, null)).toEqual({
      moveToInProgress: true,
      assignToMe: true,
      stateOverrides: {},
    });
    expect(startSettingsSource({}, null)).toBe('default');
  });
  it('no project but an own value keeps it', () => {
    expect(effectiveStartSettings({ workItemOnStart: own }, null)).toEqual(own);
  });
});
