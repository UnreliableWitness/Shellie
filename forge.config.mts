import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { keepInPackage } from './tools/forge/packageFilter.mjs';
import { trimLocales } from './tools/forge/trimLocales.mjs';
import { macSigning } from './tools/forge/macSigning.mjs';

// Signing is switched on by CI only (Azure Artifact Signing), see tools/windows-sign.
const signing = process.env.ARTIFACT_SIGNING_ENDPOINT
  ? {
      hookModulePath: path.resolve(
        process.cwd(),
        'tools/windows-sign/sign.cjs',
      ),
    }
  : undefined;

const config: ForgeConfig = {
  packagerConfig: {
    // node-pty is loaded at runtime (external to the Vite bundle), so it must be in the package, and
    // unpacked: its .node binaries, spawn-helper (macOS), the conpty worker script, conpty.dll,
    // OpenConsole.exe (Windows) have to exist on disk.
    // Packaging targets the host platform and arch (see keepInPackage).
    asar: { unpack: '**/node_modules/node-pty/**' },
    ignore: (file: string) => !keepInPackage(file),
    executableName: 'Shellie',
    icon: 'assets/icon/shellie',
    // macOS only (Windows ignores extendInfo): the hardened runtime asks for these when a CLI run in a
    // Shellie terminal uses the microphone, camera or Apple Events.
    extendInfo: {
      NSMicrophoneUsageDescription:
        'A program running in a Shellie terminal wants to use the microphone.',
      NSCameraUsageDescription:
        'A program running in a Shellie terminal wants to use the camera.',
      NSAppleEventsUsageDescription:
        'A program running in a Shellie terminal wants to control another app.',
    },
    ...(signing ? { windowsSign: signing } : {}),
    // macOS: signed and notarized only when CI sets MAC_SIGN=true (see tools/forge/macSigning.mjs).
    ...macSigning(process.env),
  },
  rebuildConfig: {},
  hooks: {
    // Runs on the freshly extracted Electron folder, before the app is copied in, before signing and
    // before any maker reads the output. Locale packs sit outside app.asar, so asar integrity is unaffected.
    // Windows/Linux only: keeps en-US and nl, drops the other Chromium locale packs (about 50 MB).
    packageAfterExtract: async (
      _config,
      buildPath,
      _electronVersion,
      platform,
    ) => {
      const { removed } = trimLocales(buildPath, platform);
      if (removed.length > 0)
        console.log(`Removed ${removed.length} unused Chromium locale packs`);
    },
  },
  makers: [
    new MakerSquirrel({
      name: 'shellie',
      setupExe: 'Shellie-Setup.exe',
      setupIcon: 'assets/icon/shellie.ico',
      // Apps & features icon. Squirrel fetches it at install time, so it must be a URL; this one
      // resolves once assets/icon/shellie.ico is on main.
      iconUrl:
        'https://raw.githubusercontent.com/UnreliableWitness/Shellie/main/assets/icon/shellie.ico',
      ...(signing ? { windowsSign: signing } : {}),
    }),
    new MakerDMG({ format: 'ULFO' }, ['darwin']),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.mts',
          target: 'preload',
        },
        {
          entry: 'src/splashPreload.ts',
          config: 'vite.preload.config.mts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
        {
          name: 'splash_window',
          config: 'vite.splash.config.mts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
