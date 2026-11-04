import { describe, expect, it } from 'vitest';
import { keepInPackage } from './packageFilter.mjs';

const win = (f: string) => keepInPackage(f, 'win32-x64');
const mac = (f: string) => keepInPackage(f, 'darwin-arm64');

describe('keepInPackage', () => {
  it('keeps the Vite output and the root', () => {
    expect(win('')).toBe(true);
    expect(win('/.vite')).toBe(true);
    expect(win('/.vite/build/main.cjs')).toBe(true);
  });

  it('drops sources and other modules', () => {
    expect(win('/src')).toBe(false);
    expect(win('/src/main.ts')).toBe(false);
    expect(win('/package-lock.json')).toBe(false);
    expect(win('/node_modules/react')).toBe(false);
    expect(win('/node_modules/node-addon-api')).toBe(false);
    expect(win('/node_modules/node-pty-other')).toBe(false);
  });

  it('keeps the node-pty runtime: package.json and lib, without tests and maps', () => {
    expect(win('/node_modules')).toBe(true);
    expect(win('/node_modules/node-pty')).toBe(true);
    expect(win('/node_modules/node-pty/package.json')).toBe(true);
    expect(win('/node_modules/node-pty/LICENSE')).toBe(true);
    expect(win('/node_modules/node-pty/lib')).toBe(true);
    expect(win('/node_modules/node-pty/lib/index.js')).toBe(true);
    expect(win('/node_modules/node-pty/lib/worker/conoutSocketWorker.js')).toBe(
      true,
    );
    expect(win('/node_modules/node-pty/lib/index.js.map')).toBe(false);
    expect(win('/node_modules/node-pty/lib/terminal.test.js')).toBe(false);
  });

  it('keeps @napi-rs/canvas and the binding package of the target only', () => {
    expect(win('/node_modules/@napi-rs')).toBe(true);
    expect(win('/node_modules/@napi-rs/canvas')).toBe(true);
    expect(win('/node_modules/@napi-rs/canvas/package.json')).toBe(true);
    expect(win('/node_modules/@napi-rs/canvas/index.js')).toBe(true);
    expect(win('/node_modules/@napi-rs/canvas/load-image.js')).toBe(true);
    expect(win('/node_modules/@napi-rs/canvas/index.d.ts')).toBe(false);
    expect(win('/node_modules/@napi-rs/canvas/README.md')).toBe(false);
    expect(win('/node_modules/@napi-rs/canvas-win32-x64-msvc')).toBe(true);
    expect(
      win(
        '/node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node',
      ),
    ).toBe(true);
    expect(
      win('/node_modules/@napi-rs/canvas-win32-x64-msvc/package.json'),
    ).toBe(true);
    expect(win('/node_modules/@napi-rs/canvas-win32-x64-msvc/README.md')).toBe(
      false,
    );
    expect(win('/node_modules/@napi-rs/canvas-darwin-arm64')).toBe(false);
    expect(mac('/node_modules/@napi-rs/canvas-darwin-arm64')).toBe(true);
    expect(
      mac('/node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node'),
    ).toBe(true);
    expect(mac('/node_modules/@napi-rs/canvas-win32-x64-msvc')).toBe(false);
    expect(win('/node_modules/@napi-rs/other')).toBe(false);
  });

  it('drops node-pty build sources so Forge does not try to rebuild it', () => {
    expect(win('/node_modules/node-pty/binding.gyp')).toBe(false);
    expect(win('/node_modules/node-pty/src')).toBe(false);
    expect(win('/node_modules/node-pty/deps')).toBe(false);
    expect(win('/node_modules/node-pty/third_party')).toBe(false);
    expect(win('/node_modules/node-pty/scripts')).toBe(false);
    expect(win('/node_modules/node-pty/typings')).toBe(false);
  });

  it('keeps only the prebuilds for the target, without debug symbols', () => {
    expect(win('/node_modules/node-pty/prebuilds')).toBe(true);
    for (const f of [
      'conpty.node',
      'conpty_console_list.node',
      'pty.node',
      'winpty.dll',
      'winpty-agent.exe',
      'conpty',
      'conpty/conpty.dll',
      'conpty/OpenConsole.exe',
    ])
      expect(win(`/node_modules/node-pty/prebuilds/win32-x64/${f}`)).toBe(true);
    expect(win('/node_modules/node-pty/prebuilds/win32-x64/pty.pdb')).toBe(
      false,
    );
    expect(win('/node_modules/node-pty/prebuilds/win32-arm64')).toBe(false);
    expect(win('/node_modules/node-pty/prebuilds/darwin-arm64')).toBe(false);
    expect(mac('/node_modules/node-pty/prebuilds/darwin-arm64/pty.node')).toBe(
      true,
    );
    expect(
      mac('/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'),
    ).toBe(true);
    expect(mac('/node_modules/node-pty/prebuilds/win32-x64')).toBe(false);
  });

  it('keeps a from-source build/Release when there is no prebuild', () => {
    expect(mac('/node_modules/node-pty/build')).toBe(true);
    expect(mac('/node_modules/node-pty/build/Release')).toBe(true);
    expect(mac('/node_modules/node-pty/build/Release/pty.node')).toBe(true);
    expect(mac('/node_modules/node-pty/build/Release/spawn-helper')).toBe(true);
    expect(mac('/node_modules/node-pty/build/Release/obj.target')).toBe(false);
    expect(mac('/node_modules/node-pty/build/Makefile')).toBe(false);
  });
});
