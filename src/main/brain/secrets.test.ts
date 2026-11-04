import { describe, expect, it } from 'vitest';
import { findSecrets, secretMessage } from './secrets';

describe('findSecrets', () => {
  it('finds the common credential shapes, once per kind, with the line', () => {
    const text = [
      'Intro',
      '-----BEGIN RSA PRIVATE KEY-----',
      'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0',
      'xoxb-123456789012-abcdefghijkl',
      'AKIAIOSFODNN7EXAMPLE',
      'sk_live_' + 'abcdefghijklmnop1234',
      'pat: ' + 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqr2z',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      'Server=x;Password=Sup3rSecretValue;',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCD',
      'api_key = "0123456789abcdefghijklmnopqrstuv"',
      'https://x.blob.core.windows.net/c?sv=2020&sig=abcdefghijklmnopqrstuvwxyz0123456789ABCDEF%3D',
    ].join('\n');
    const hits = findSecrets(text);
    expect(hits.map((h) => h.kind)).toEqual([
      'private key',
      'GitHub token',
      'Slack token',
      'AWS access key',
      'Stripe key',
      'Azure DevOps token',
      'JSON web token',
      'connection string password or key',
      'bearer token',
      'API key or secret',
      'SAS signature',
    ]);
    expect(hits[0].line).toBe(2);
    expect(secretMessage(hits)).toBe(
      'Looks like it holds a private key (line 2); remove it and add the file again',
    );
  });

  it('leaves ordinary documents alone', () => {
    const text = [
      '# Architecture',
      'The password policy requires 12 characters.',
      'Commit 3f2a9c8e1b7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f is the fix.',
      'sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      'The token bucket algorithm limits requests.',
      'Set password=hunter2 in dev only',
      'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz',
      'Bearer of the ring',
      'access token expires after an hour',
    ].join('\n');
    expect(findSecrets(text)).toEqual([]);
  });
});
