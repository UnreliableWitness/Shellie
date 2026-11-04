/**
 * Things that look like credentials in a text. A source holding one is refused at drop time: the brain is a git
 * folder, and a secret committed there stays in its history.
 */

export type SecretHit = { kind: string; line: number };

/** A value that is a placeholder, a reference or a word, not a secret: `<your-password>`, `${X}`, `@param`, `REPLACE_ME`. */
const placeholder = (value: string) =>
  /^[<${@%[]/.test(value) ||
  /^[A-Z_]+$/.test(value) ||
  /^[a-z_]+$/.test(value) ||
  // Letters only (`currentDirectoryPath`) is a name; a generated value has digits or symbols.
  !/\d|[^A-Za-z]/.test(value);

type Pattern = { kind: string; re: RegExp; value?: number };

const PATTERNS: Pattern[] = [
  { kind: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { kind: 'GitHub token', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { kind: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'Slack token', re: /\bxapp-\d-[A-Za-z0-9-]{10,}\b/ },
  {
    kind: 'Slack webhook',
    re: /hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/,
  },
  { kind: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    kind: 'AWS secret key',
    re: /\baws_secret_access_key\b\s*[:=]\s*["']?[A-Za-z0-9/+]{30,}/i,
  },
  { kind: 'Stripe key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { kind: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    kind: 'OpenAI or Anthropic key',
    re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/,
  },
  { kind: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  // Azure DevOps: the current 84-character PAT with AZDO near its end, and the legacy 52-character base32 one
  // (a digit keeps a long lowercase word out).
  {
    kind: 'Azure DevOps token',
    re: /\b[A-Za-z0-9]{70,80}AZDO[A-Za-z0-9]{4}\b/,
  },
  { kind: 'Azure DevOps token', re: /\b(?=[a-z2-7]*\d)[a-z2-7]{52}\b/ },
  {
    kind: 'Entra client secret',
    re: /\b[A-Za-z0-9_~.-]{3}8Q~[A-Za-z0-9_~.-]{30,34}\b/,
  },
  {
    kind: 'JSON web token',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    kind: 'password in a URL',
    re: /\bhttps?:\/\/[^/\s:@]+:[^/\s@]{6,}@[^\s/]+/,
  },
  {
    kind: 'connection string password or key',
    re: /(?<![A-Za-z])(?:password|pwd|accountkey|sharedaccesskey|sharedaccesssignature|clientsecret|client[_-]secret)["']?\s*[:=]\s*["']?([^;\s"'`,]{8,})/i,
    value: 1,
  },
  { kind: 'bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{30,}=*/ },
  {
    kind: 'API key or secret',
    re: /(?<![A-Za-z])(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|authtoken)["']?\s*[:=]\s*["']?([A-Za-z0-9_\-./+~]{20,})/i,
    value: 1,
  },
  { kind: 'SAS signature', re: /[?&]sig=[A-Za-z0-9%+/=]{32,}/ },
];

/** Every kind found, with the first line it appears on (1-based). Empty when the text looks clean. */
export function findSecrets(text: string): SecretHit[] {
  const first = new Map<string, number>();
  const lines = text.split(/\r?\n/);
  for (const { kind, re, value } of PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      if ((first.get(kind) ?? Infinity) <= i + 1) break;
      const m = re.exec(lines[i]);
      if (!m) continue;
      if (value !== undefined && placeholder(m[value])) continue;
      first.set(kind, i + 1);
      break;
    }
  }
  return [...first]
    .map(([kind, line]) => ({ kind, line }))
    .sort((a, b) => a.line - b.line);
}

/** The refusal message for a drop: which kind, where, what to do. Never the value. */
export function secretMessage(
  hits: SecretHit[],
  file?: { name: string; converted: boolean },
): string {
  const where = file?.converted
    ? `line ${hits[0].line} of the converted text`
    : `line ${hits[0].line}`;
  const name = file ? `${file.name}: ` : '';
  return `${name}looks like it holds a ${hits[0].kind} (${where}); remove it and add it again`;
}
