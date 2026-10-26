// Runs Claude Code headless for an agent, on the owner's subscription only (spec 1.1, 6.1a).
// Never --bare: it accepts only ANTHROPIC_API_KEY, and an API key bills per use.
import { spawn } from 'node:child_process';

const STRIPPED = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'AGENTS_GH_TOKEN',
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
];

/**
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>} the agent's environment: no GitHub or Actions tokens
 */
export function agentEnv(env) {
  if (env.ANTHROPIC_API_KEY)
    throw new Error(
      'ANTHROPIC_API_KEY is set: refusing to run (subscription only)',
    );
  const out = { ...env };
  for (const k of STRIPPED) delete out[k];
  return out;
}

/**
 * @param {{ model: string, maxTurns: number, tools: string[], allowedTools: string[], schema: string, systemPromptFile: string }} o
 * @returns {string[]}
 */
export function claudeArgs({
  model,
  maxTurns,
  tools,
  allowedTools,
  schema,
  systemPromptFile,
}) {
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    model,
    '--max-turns',
    String(maxTurns),
    '--tools',
    tools.join(','),
    '--allowedTools',
    allowedTools.join(','),
    '--json-schema',
    schema,
    '--append-system-prompt-file',
    systemPromptFile,
    '--strict-mcp-config',
    '--no-session-persistence',
  ];
}

const LIMIT_TEXT =
  /usage limit|rate limit|limit reached|out of (extra )?usage/i;

/**
 * @param {string} stdout `claude -p --output-format json` output
 * @returns {{ ok: boolean, output?: unknown, tokens: number, limited: boolean, error?: string }}
 */
export function parseClaudeResult(stdout) {
  let r;
  try {
    r = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      tokens: 0,
      limited: false,
      error: `unreadable output: ${String(stdout).slice(0, 200)}`,
    };
  }
  const u = r.usage ?? {};
  const tokens =
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.output_tokens ?? 0);
  if (r.is_error) {
    const error = String(r.result ?? r.subtype ?? 'error');
    return {
      ok: false,
      tokens,
      limited: r.api_error_status === 429 || LIMIT_TEXT.test(error),
      error,
    };
  }
  if (r.structured_output == null)
    return { ok: false, tokens, limited: false, error: 'no structured output' };
  return { ok: true, output: r.structured_output, tokens, limited: false };
}

/**
 * @param {Parameters<typeof claudeArgs>[0] & { prompt: string, cwd: string, env?: Record<string, string | undefined>, timeoutMs?: number }} o
 * @returns {Promise<ReturnType<typeof parseClaudeResult>>}
 */
export function runClaude({
  prompt,
  cwd,
  env = process.env,
  timeoutMs = 20 * 60000,
  ...args
}) {
  return new Promise((resolve) => {
    const child = spawn('claude', claudeArgs(args), {
      cwd,
      env: agentEnv(env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, tokens: 0, limited: false, error: e.message });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const r = parseClaudeResult(out);
      resolve(r.ok || out ? r : { ...r, error: err.slice(-500) || r.error });
    });
    child.stdin.end(prompt);
  });
}
