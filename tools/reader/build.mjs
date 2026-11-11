// Builds what runs on aktse into reader/dist (docs/deploy-aktse.md):
//   reader/dist/server.mjs   the server, one file, no node_modules needed
//   reader/dist/public/      the site (reader/site, built by Vite)
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const dist = path.join(root, 'reader/dist');
const siteConfig = path.join(root, 'reader/site/vite.config.mts');

const kb = (file) => `${(statSync(file).size / 1024).toFixed(1)} kB`;

async function buildServer() {
  const file = path.join(dist, 'server.mjs');
  await build({
    input: path.join(root, 'reader/server/main.ts'),
    platform: 'node',
    transform: { target: 'node24' },
    output: { file, format: 'esm', codeSplitting: false },
    logLevel: 'warn',
  });
  console.log(`server: ${path.relative(root, file)} (${kb(file)})`);
}

function buildSite() {
  if (!existsSync(siteConfig)) {
    const config = path.relative(root, siteConfig);
    console.log(`site: skipped, ${config} does not exist`);
    return;
  }
  const vite = path.join(root, 'node_modules/vite/bin/vite.js');
  const run = spawnSync(
    process.execPath,
    [vite, 'build', '--config', siteConfig],
    { cwd: root, stdio: 'inherit' },
  );
  if (run.status !== 0) throw new Error('the site did not build');
  const out = path.join(dist, 'public');
  const index = path.join(out, 'index.html');
  if (!existsSync(index))
    throw new Error(`the site built, but not into ${path.relative(root, out)}`);
  console.log(`site: ${path.relative(root, out)}/`);
}

try {
  await buildServer();
  buildSite();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
