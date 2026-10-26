// Settings for the agent pollers (.github/agents/config.yml) and who they trust (.github/agents/trusted.yml).
// Spec: docs/superpowers/specs/2026-10-26-agentic-sdlc-design.md, sections 4 and 6.1.
import { parse } from 'yaml';

const DEFAULTS = {
  botLogin: 'shellie-agents[bot]',
  botUserId: 348169834,
  maxOpenAgentPrs: 1,
  maxImplementAttempts: 2,
  maxFixRounds: 3,
  maxTriagePerRun: 5,
  autoMergeMaxLines: 400,
  maxAgentRunsPerDay: 20,
  pauseMinutes: 60,
  needsInfoRemindDays: 14,
  needsInfoCloseDays: 21,
  models: {
    triage: 'claude-sonnet-5-5',
    implement: 'claude-opus-5-5',
    review: 'claude-opus-5-5',
    fix: 'claude-sonnet-5-5',
    health: 'claude-sonnet-5-5',
    garden: 'claude-sonnet-5-5',
  },
  maxTurns: {
    triage: 30,
    implement: 150,
    review: 40,
    fix: 60,
    health: 20,
    garden: 30,
  },
  maxIssuesPerDay: { health: 3 },
  maxIssuesPerWeek: { gardener: 2 },
};

/**
 * @param {string} text the YAML file's contents ('' when there is none)
 * @returns {typeof DEFAULTS} the spec's defaults with the file's values on top (nested objects merged per key)
 */
export function parseConfig(text) {
  const file = parse(text) ?? {};
  /** @type {any} */
  const out = structuredClone(DEFAULTS);
  for (const [key, value] of Object.entries(file)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key])
      Object.assign(out[key], value);
    else out[key] = value;
  }
  return out;
}

/**
 * @param {string} text the trusted list: `owner: <login>` and `logins: [...]`
 * @returns {{ owner: string, logins: Set<string> }} lowercased; the owner is always in `logins`
 */
export function parseTrusted(text) {
  const file = parse(text) ?? {};
  const owner = String(file.owner ?? '').toLowerCase();
  const logins = new Set(
    (file.logins ?? []).map((l) => String(l).toLowerCase()),
  );
  if (owner) logins.add(owner);
  return { owner, logins };
}

/**
 * @param {{ logins: Set<string> }} trusted
 * @param {string | undefined} login
 */
export function isTrusted(trusted, login) {
  return !!login && trusted.logins.has(login.toLowerCase());
}
