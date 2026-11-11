import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { call, cleanUp, join, raw, start, tempDir } from './testing';
import type { Running } from './testing';

afterEach(cleanUp);

const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const FILES: Record<string, string> = {
  'index.html': '<!doctype html><title>Shellie Reader</title>',
  'sw.js': '// service worker',
  'manifest.webmanifest': '{"name":"Shellie Reader"}',
  'favicon.ico': 'ico',
  'icon.png': 'png',
  'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'data.json': '{}',
  'notes.txt': 'plain',
  '.secret': 'a dotfile',
  '.well-known/thing.json': '{"hidden":true}',
  'assets/index-abc123.js': 'console.log(1)',
  'assets/index-abc123.css': 'body{}',
  'assets/font-abc123.woff2': 'woff2',
};

/** A server with a site, in a folder that has a file next to the site. */
async function withSite(): Promise<Running> {
  const parent = await tempDir();
  const publicDir = path.join(parent, 'public');
  await fs.writeFile(path.join(parent, 'outside.txt'), 'outside the site');
  for (const [name, text] of Object.entries(FILES)) {
    const file = path.join(publicDir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  return start({ publicDir });
}

function expectSecurityHeaders(headers: Headers): void {
  expect(headers.get('content-security-policy')).toBe(CSP);
  expect(headers.get('referrer-policy')).toBe('no-referrer');
  expect(headers.get('x-content-type-options')).toBe('nosniff');
}

describe('the site', () => {
  it('serves index.html at / without caching it', async () => {
    const server = await withSite();
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FILES['index.html']);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expectSecurityHeaders(res.headers);
  });

  it('serves the files with their type', async () => {
    const server = await withSite();
    const types: Record<string, string> = {
      'index.html': 'text/html; charset=utf-8',
      'sw.js': 'text/javascript; charset=utf-8',
      'manifest.webmanifest': 'application/manifest+json',
      'favicon.ico': 'image/x-icon',
      'icon.png': 'image/png',
      'icon.svg': 'image/svg+xml',
      'data.json': 'application/json; charset=utf-8',
      'notes.txt': 'application/octet-stream',
      'assets/index-abc123.js': 'text/javascript; charset=utf-8',
      'assets/index-abc123.css': 'text/css; charset=utf-8',
      'assets/font-abc123.woff2': 'font/woff2',
    };
    for (const [name, type] of Object.entries(types)) {
      const res = await fetch(`${server.url}/${name}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(FILES[name]);
      expect(`${name} ${res.headers.get('content-type')}`).toBe(
        `${name} ${type}`,
      );
      expect(res.headers.get('content-length')).toBe(
        String(FILES[name].length),
      );
      expectSecurityHeaders(res.headers);
    }
  });

  it('caches the hashed assets for a year and nothing else', async () => {
    const server = await withSite();
    const cache = async (name: string) =>
      (await fetch(`${server.url}/${name}`)).headers.get('cache-control');
    const forever = 'public, max-age=31536000, immutable';
    expect(await cache('assets/index-abc123.js')).toBe(forever);
    expect(await cache('assets/index-abc123.css')).toBe(forever);
    expect(await cache('assets/font-abc123.woff2')).toBe(forever);
    expect(await cache('sw.js')).toBe('no-cache');
    expect(await cache('index.html')).toBe('no-cache');
    expect(await cache('manifest.webmanifest')).toBe('no-cache');
    expect(await cache('read/some-piece')).toBe('no-cache');
  });

  it('answers index.html for a path that is no file', async () => {
    const server = await withSite();
    for (const pathname of ['/read/abc', '/assets', '/nothing.js', '/a/b/c/']) {
      const res = await fetch(`${server.url}${pathname}?x=1`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(FILES['index.html']);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    }
  });

  it('answers 404 for a missing hashed asset', async () => {
    const server = await withSite();
    const res = await fetch(`${server.url}/assets/index-old000.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expectSecurityHeaders(res.headers);
  });

  it('serves no dotfile', async () => {
    const server = await withSite();
    for (const pathname of [
      '/.secret',
      '/.well-known/thing.json',
      '/%2Esecret',
    ]) {
      const res = await raw(server, 'GET', pathname);
      expect(res.status).toBe(200);
      expect(res.body).toBe(FILES['index.html']);
    }
  });

  it('serves nothing from outside the public folder', async () => {
    const server = await withSite();
    for (const pathname of [
      '/../outside.txt',
      '/..%2Foutside.txt',
      '/%2e%2e/outside.txt',
      '/%2e%2e%2foutside.txt',
      '/assets/../../outside.txt',
      '/assets/..%2F..%2Foutside.txt',
      '/..\\outside.txt',
      '/..%5Coutside.txt',
      '//outside.txt',
      '/%00/../outside.txt',
      '/%zz',
    ]) {
      const res = await raw(server, 'GET', pathname);
      expect(res.body).not.toContain('outside the site');
      expect([200, 404]).toContain(res.status);
    }
  });

  it('answers a HEAD without the body', async () => {
    const server = await withSite();
    const res = await fetch(`${server.url}/sw.js`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('17');
    expect(await res.text()).toBe('');
  });

  it('refuses a method that is not a read', async () => {
    const server = await withSite();
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await fetch(`${server.url}/read/abc`, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
    }
  });

  it('answers 404 when the public folder has no index.html', async () => {
    const server = await start();
    for (const pathname of ['/', '/read/abc', '/index.html']) {
      const res = await fetch(`${server.url}${pathname}`);
      expect(res.status).toBe(404);
      expectSecurityHeaders(res.headers);
    }
    // the API does not need the site
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
  });

  it('sends the security headers on API answers too', async () => {
    const server = await withSite();
    const who = await join(server);
    expectSecurityHeaders((await fetch(`${server.url}/health`)).headers);
    for (const as of [who, null]) {
      const res = await call(server, as, 'GET', '/api/v1/items');
      expectSecurityHeaders(res.headers);
    }
  });

  it('logs a site path without its query', async () => {
    const server = await withSite();
    await fetch(`${server.url}/read/abc?from=list`);
    expect(server.logs).toEqual([
      '2026-11-11T10:00:00.000Z GET /read/abc 200 44',
    ]);
  });
});
