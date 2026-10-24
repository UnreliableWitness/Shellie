// Signing and notarization for the macOS build, switched on by CI with MAC_SIGN=true.
// Notarization uses an App Store Connect API key (never an Apple ID and password).
// Without MAC_SIGN the build stays unsigned, as it does locally.
const REQUIRED = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];

export function macSigning(env) {
  if (env.MAC_SIGN !== 'true') return undefined;
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0)
    throw new Error(`Mac signing is on but missing: ${missing.join(', ')}`);
  return {
    osxSign: {
      // Packager logs and carries on after a sign error unless this is false; fail the build instead.
      continueOnError: false,
      // Every file, node-pty's .node and spawn-helper included, gets the hardened runtime.
      optionsForFile: () => ({
        hardenedRuntime: true,
        entitlements: 'assets/entitlements.mac.plist',
      }),
    },
    osxNotarize: {
      appleApiKey: env.APPLE_API_KEY,
      appleApiKeyId: env.APPLE_API_KEY_ID,
      appleApiIssuer: env.APPLE_API_ISSUER,
    },
  };
}
