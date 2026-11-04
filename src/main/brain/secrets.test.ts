import { describe, expect, it } from 'vitest';
import { findSecrets, secretMessage } from './secrets';

describe('findSecrets', () => {
  it('finds the common credential shapes, once per kind, with the first line', () => {
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
      'github_pat_' + 'ABCDEFGHIJKLMNOPQRSTUV0123456789',
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
    // The first GitHub token line, not the first pattern's.
    expect(hits[1].line).toBe(3);
    expect(secretMessage(hits)).toBe(
      'looks like it holds a private key (line 2); remove it and add it again',
    );
    expect(secretMessage(hits, { name: 'deck.pptx', converted: true })).toBe(
      'deck.pptx: looks like it holds a private key (line 2 of the converted text); remove it and add it again',
    );
  });

  it('finds the shapes a customer project is likely to hold', () => {
    const cases: [string, string][] = [
      [
        '8Kx2mQ9v' + 'A'.repeat(44) + 'JQQJ99BKACAAAAAAAAAAAAASAZDO1abc',
        'Azure DevOps token',
      ],
      [
        'git clone https://deploy:S3cr3tPassw0rd@dev.azure.com/org/proj/_git/repo',
        'password in a URL',
      ],
      [
        'https://hooks.slack.com/' +
          'services/T00000000/' +
          'B00000000/XXXXXXXXXXXXXXXXXXXXXXXX',
        'Slack webhook',
      ],
      ['AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY', 'Google API key'],
      [
        'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ',
        'OpenAI or Anthropic key',
      ],
      [
        'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ',
        'OpenAI or Anthropic key',
      ],
      ['npm_abcdefghijklmnopqrstuvwxyz0123456789', 'npm token'],
      [
        '//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789',
        'npm token',
      ],
      ['xapp-1-A0123456789-0123456789012-abcdef', 'Slack token'],
      ['-----BEGIN PGP PRIVATE KEY BLOCK-----', 'private key'],
      ['ASIAIOSFODNN7EXAMPLE', 'AWS access key'],
      [
        'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        'AWS secret key',
      ],
      [
        'client secret value: abc8Q~defghijklmnopqrstuvwxyz0123456',
        'Entra client secret',
      ],
      [
        'export MY_API_KEY=0123456789abcdefghijklmnopqrstuv',
        'API key or secret',
      ],
      ['"api_key": "0123456789abcdefghijklmnopqrstuv"', 'API key or secret'],
      ['"password": "Sup3rSecretValue1"', 'connection string password or key'],
      ['password: Sup3rSecretValue', 'connection string password or key'],
      ['Password="Sup3rSecretValue";', 'connection string password or key'],
      [
        '"clientSecret": "Abc123def456ghi789"',
        'connection string password or key',
      ],
    ];
    for (const [line, kind] of cases)
      expect(
        findSecrets(line).map((h) => h.kind),
        line,
      ).toContain(kind);
  });

  it('leaves ordinary documents, placeholders and references alone', () => {
    const lines = [
      '# Architecture',
      'The password policy requires 12 characters.',
      'Commit 3f2a9c8e1b7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f is the fix.',
      'sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      'The token bucket algorithm limits requests.',
      'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz',
      'Bearer of the ring',
      'access token expires after an hour',
      "SELECT * FROM Users WHERE Password = @password AND Id = '1';",
      'Server=db;User Id=sa;Password=<your-password>;',
      'Password=${DB_PASSWORD};',
      'Password=@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/db)',
      'pwd=currentDirectoryPath',
      'client_secret: REPLACE_WITH_YOUR_CLIENT_SECRET_VALUE',
      'access_token: the_token_returned_by_the_oauth_endpoint',
      'Resource id /subscriptions/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b/resourceGroups/rg',
      'https://contoso.sharepoint.com/sites/Engineering/Shared%20Documents/Forms/AllItems.aspx',
      'Donaudampfschifffahrtsgesellschaftskapitänsmützenabzeichen',
    ];
    for (const line of lines) expect(findSecrets(line), line).toEqual([]);
    expect(findSecrets(lines.join('\n'))).toEqual([]);
  });
});
