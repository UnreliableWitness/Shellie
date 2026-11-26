import { execFile } from 'node:child_process';
import {
  AGENT_IDS,
  type AgentId,
  type AgentProbe,
  type AgentsDetected,
} from '../../shared/agents';
import { isOpencodeModel } from '../../shared/brain';
import type { Command, Platform } from '../platform/Platform';

export type ProbeRunner = (
  cmd: Command,
  timeoutMs: number,
) => Promise<{ code: number; stdout: string }>;

const PROBE_TIMEOUT_MS = 5000;

/**
 * Runs a command to completion. A non-zero exit resolves with its code, and a timeout resolves with code -1 and
 * the output printed before the kill (the path line of a probe whose `--version` hangs); only a spawn failure
 * rejects.
 */
export const runProbe: ProbeRunner = (cmd, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd.command,
      cmd.args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        env: { ...process.env, ...cmd.env },
      },
      (err, stdout) => {
        if (!err) return resolve({ code: 0, stdout });
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        const out = String(stdout ?? '');
        if (e.killed) return resolve({ code: -1, stdout: out });
        if (typeof e.code !== 'number') return reject(err);
        resolve({ code: e.code, stdout: out });
      },
    );
  });

const NOT_FOUND: AgentProbe = { found: false, version: null, path: null };

/** A POSIX path, a drive path (C:\ or C:/) or a UNC path. */
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\)/;

/**
 * An agent counts as found when the probe printed its path (the first absolute-path line, so a login banner
 * before it is skipped), whatever the exit code: a `--version` that hangs, fails or prints something
 * unparseable gives `version: null`, never "not found".
 */
async function probe(
  platform: Platform,
  run: ProbeRunner,
  id: AgentId,
): Promise<AgentProbe> {
  try {
    const { stdout } = await run(platform.probeCommand(id), PROBE_TIMEOUT_MS);
    const lines = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const at = lines.findIndex((l) => ABSOLUTE_PATH.test(l));
    if (at < 0) return NOT_FOUND;
    let version: string | null = null;
    for (const line of lines.slice(at + 1)) {
      // Copilot ends its version line with a full stop ("… 1.0.57."): that is the sentence's, not the version's.
      version =
        line.match(/\d+\.\d+\.\d+\S*/)?.[0].replace(/[.,;:]+$/, '') ?? null;
      if (version) break;
    }
    return { found: true, version, path: lines[at] };
  } catch {
    return NOT_FOUND;
  }
}

export async function detectAgents(
  platform: Platform,
  run: ProbeRunner,
): Promise<AgentsDetected> {
  const results = await Promise.all(
    AGENT_IDS.map((id) => probe(platform, run, id)),
  );
  return {
    checkedAt: new Date().toISOString(),
    agents: Object.fromEntries(
      AGENT_IDS.map((id, i) => [id, results[i]]),
    ) as AgentsDetected['agents'],
    shell: { label: platform.shellLabel },
  };
}

/** `opencode models`: its `provider/model` lines; null when it failed, listed none or is not there. Never cached. */
export async function opencodeModels(
  platform: Pick<Platform, 'opencodeCommand'>,
  probe: ProbeRunner,
): Promise<string[] | null> {
  try {
    const { code, stdout } = await probe(
      platform.opencodeCommand(undefined, ['models']),
      15_000,
    );
    if (code !== 0) return null;
    const models = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(isOpencodeModel);
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}
