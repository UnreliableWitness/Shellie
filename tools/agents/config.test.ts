import { describe, expect, it } from 'vitest';
import { isTrusted, parseConfig, parseTrusted } from './config.mjs';
import { LABELS, missingLabels } from './labels.mjs';

describe('parseConfig', () => {
  it('fills the spec defaults for an empty file', () => {
    const c = parseConfig('');
    expect(c.botLogin).toBe('shellie-agents[bot]');
    expect(c.maxOpenAgentPrs).toBe(1);
    expect(c.maxTriagePerRun).toBe(5);
    expect(c.maxAgentRunsPerDay).toBe(20);
    expect(c.pauseMinutes).toBe(60);
    expect(c.needsInfoRemindDays).toBe(14);
    expect(c.needsInfoCloseDays).toBe(21);
    expect(c.maxTurns.triage).toBe(30);
    expect(c.models.triage).toBe('claude-sonnet-5-5');
  });

  it('lets a file value override one key and keeps the others', () => {
    const c = parseConfig('maxTriagePerRun: 2\nmaxTurns:\n  triage: 10\n');
    expect(c.maxTriagePerRun).toBe(2);
    expect(c.maxTurns.triage).toBe(10);
    expect(c.maxTurns.implement).toBe(150);
    expect(c.maxAgentRunsPerDay).toBe(20);
  });
});

describe('parseTrusted', () => {
  it('lowercases logins and always includes the owner', () => {
    const t = parseTrusted(
      'owner: UnreliableWitness\nlogins: [MaximeDeBraekeleer]\n',
    );
    expect(t.owner).toBe('unreliablewitness');
    expect(isTrusted(t, 'UnreliableWitness')).toBe(true);
    expect(isTrusted(t, 'maximedebraekeleer')).toBe(true);
    expect(isTrusted(t, 'someone-else')).toBe(false);
    expect(isTrusted(t, undefined)).toBe(false);
  });
});

describe('labels', () => {
  it('lists only the labels that do not exist yet', () => {
    const missing = missingLabels(['claude-working', 'agent:ready']).map(
      (l) => l.name,
    );
    expect(missing).not.toContain('claude-working');
    expect(missing).not.toContain('agent:ready');
    expect(missing).toContain('agent:needs-info');
    expect(missing).toContain('agent:activity');
    expect(LABELS.every((l) => /^[0-9a-f]{6}$/.test(l.color))).toBe(true);
  });
});
