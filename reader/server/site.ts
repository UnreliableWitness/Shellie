import fs from 'node:fs/promises';
import path from 'node:path';
import { notAllowed, type Reply } from './reply';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

// Vite names the files under /assets/ after their content.
const FOREVER = 'public, max-age=31536000, immutable';

const NOT_FOUND: Reply = {
  status: 404,
  headers: {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache',
  },
  body: 'not found',
};

/** The file a request path names inside `root`, or null when it may not. */
function fileFor(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const parts = decoded.split('/').filter(Boolean);
  // No dotfiles, which also rules out `..`.
  const bad = (part: string) => part.startsWith('.') || /[\\\0]/.test(part);
  if (parts.length === 0 || parts.some(bad)) return null;
  const file = path.join(root, ...parts);
  return file.startsWith(root + path.sep) ? file : null;
}

async function read(file: string | null): Promise<Buffer | null> {
  if (!file) return null;
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

function page(file: string, body: Buffer, cache: string): Reply {
  const type = TYPES[path.extname(file).toLowerCase()];
  return {
    status: 200,
    headers: {
      'Content-Type': type ?? 'application/octet-stream',
      'Cache-Control': cache,
    },
    body,
  };
}

/**
 * A file from the public folder, or `index.html` for a path that is none (the
 * site routes in the browser). A missing file under /assets/ is a 404: a page
 * in place of a script only hides that a deploy went wrong.
 */
export async function serveSite(
  publicDir: string,
  method: string,
  pathname: string,
): Promise<Reply> {
  if (method !== 'GET' && method !== 'HEAD') return notAllowed(['GET', 'HEAD']);
  const root = path.resolve(publicDir);
  const asset = pathname.startsWith('/assets/');
  const file = fileFor(root, pathname);
  const body = await read(file);
  if (file && body) return page(file, body, asset ? FOREVER : 'no-cache');
  if (asset) return NOT_FOUND;
  const index = path.join(root, 'index.html');
  const html = await read(index);
  return html ? page(index, html, 'no-cache') : NOT_FOUND;
}
