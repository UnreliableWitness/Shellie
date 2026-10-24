import { describe, expect, it } from 'vitest';
import { macSigning } from './macSigning.mjs';

const keys = {
  APPLE_API_KEY: '/tmp/AuthKey_ABC.p8',
  APPLE_API_KEY_ID: 'ABC123',
  APPLE_API_ISSUER: 'issuer-uuid',
};

describe('macSigning', () => {
  it('is off without MAC_SIGN', () => {
    expect(macSigning({ ...keys })).toBeUndefined();
  });

  it('is off when MAC_SIGN is false', () => {
    expect(macSigning({ ...keys, MAC_SIGN: 'false' })).toBeUndefined();
  });

  it('signs with the hardened runtime and notarizes with the API key', () => {
    const result = macSigning({ ...keys, MAC_SIGN: 'true' });
    expect(result?.osxNotarize).toEqual({
      appleApiKey: keys.APPLE_API_KEY,
      appleApiKeyId: keys.APPLE_API_KEY_ID,
      appleApiIssuer: keys.APPLE_API_ISSUER,
    });
    const sign = result?.osxSign as {
      continueOnError: boolean;
      optionsForFile: (f: string) => unknown;
    };
    expect(sign.continueOnError).toBe(false);
    expect(sign.optionsForFile('x')).toEqual({
      hardenedRuntime: true,
      entitlements: 'assets/entitlements.mac.plist',
    });
  });

  it('names what is missing', () => {
    expect(() =>
      macSigning({ ...keys, MAC_SIGN: 'true', APPLE_API_ISSUER: '' }),
    ).toThrow(/missing: APPLE_API_ISSUER/);
  });
});
