/**
 * Things that look like credentials in a text. A source holding one is refused at drop time: the brain is a git
 * folder, and a secret committed there stays in its history.
 */

export type SecretHit = { kind: string; line: number };

const PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { kind: 'GitHub token', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { kind: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'Stripe key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  // A legacy Azure DevOps PAT: 52 base32 characters; a digit keeps a long lowercase word out.
  { kind: 'Azure DevOps token', re: /\b(?=[a-z2-7]*\d)[a-z2-7]{52}\b/ },
  {
    kind: 'JSON web token',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    kind: 'connection string password or key',
    re: /\b(?:password|pwd|accountkey|sharedaccesskey|sharedaccesssignature)\s*=\s*[^;\s"'`]{8,}/i,
  },
  { kind: 'bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{30,}=*/ },
  {
    kind: 'API key or secret',
    re: /\b(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{20,}/i,
  },
  { kind: 'SAS signature', re: /[?&]sig=[A-Za-z0-9%+/=]{32,}/ },
];

/** Every kind found, with the first line it appears on (1-based). Empty when the text looks clean. */
export function findSecrets(text: string): SecretHit[] {
  const out: SecretHit[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (const { kind, re } of PATTERNS) {
    if (seen.has(kind)) continue;
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        out.push({ kind, line: i + 1 });
        seen.add(kind);
        break;
      }
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** The refusal message for a drop: which kind, where, what to do. Never the value. */
export const secretMessage = (hits: SecretHit[]): string =>
  `Looks like it holds a ${hits[0].kind} (line ${hits[0].line}); remove it and add the file again`;
