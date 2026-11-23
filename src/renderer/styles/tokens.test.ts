import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = path.resolve(__dirname);
const tokensCss = readFileSync(path.join(dir, 'tokens.css'), 'utf8');

type RGBA = [number, number, number, number];

function parseColor(v: string): RGBA {
  const s = v.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h =
      hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return [0, 2, 4]
      .map((i) => parseInt(h.slice(i, i + 2), 16))
      .concat(1) as RGBA;
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(s);
  if (rgba) {
    const [r, g, b, a = '1'] = rgba[1].split(',').map((x) => x.trim());
    return [Number(r), Number(g), Number(b), Number(a)];
  }
  throw new Error(`not a colour: ${v}`);
}

/** Custom properties declared in a CSS block body. */
function decls(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi))
    out[m[1]] = m[2].trim();
  return out;
}

const darkBlock = /:root\s*\{([^}]*)\}/.exec(tokensCss)![1];
const lightBlock =
  /@media \(prefers-color-scheme: light\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(
    tokensCss,
  )![1];
const DARK = decls(darkBlock);
const LIGHT = { ...DARK, ...decls(lightBlock) };

function over(fg: RGBA, bg: RGBA): RGBA {
  const a = fg[3];
  return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)).concat(1) as RGBA;
}
function lum([r, g, b]: RGBA): number {
  const f = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(
  fgVar: string,
  bgVar: string,
  t: Record<string, string>,
): number {
  const bg = parseColor(t[bgVar]);
  const fg = over(parseColor(t[fgVar]), bg);
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

const TEXT = [
  '--text',
  '--muted',
  '--link',
  '--green',
  '--red',
  '--amber',
  '--warn',
];
const CHART = [
  '--chart-claude',
  '--chart-copilot',
  '--chart-opus',
  '--chart-sonnet',
  '--chart-haiku',
  '--chart-fable',
  '--chart-you',
  '--chart-agents',
  '--chart-opencode',
  '--repo-1',
  '--repo-2',
  '--repo-3',
  '--repo-4',
  '--repo-5',
  '--repo-6',
];

describe.each([
  ['dark', DARK],
  ['light', LIGHT],
] as const)('%s tokens', (name, t) => {
  it.each(
    TEXT.flatMap((fg) =>
      ['--bg-page', '--bg-card', '--bg-pane'].map((bg) => [fg, bg]),
    ),
  )(`${name}: %s on %s is at least 4.5:1`, (fg, bg) =>
    expect(contrast(fg, bg, t)).toBeGreaterThanOrEqual(4.5),
  );
  it.each(CHART)(`${name}: %s on --bg-card is at least 3:1`, (fg) =>
    expect(contrast(fg, '--bg-card', t)).toBeGreaterThanOrEqual(3),
  );
  // The text on a Week card: 12 px on the task's series colour.
  it.each(['1', '2', '3', '4', '5', '6', '7', '8', 'other'])(
    `${name}: --on-series-%s on its series colour is at least 4.5:1`,
    (n) =>
      expect(
        contrast(`--on-series-${n}`, `--series-${n}`, t),
      ).toBeGreaterThanOrEqual(4.5),
  );
});

describe('button hover', () => {
  it('keeps the dark --btn-hover opaque as before and lightens in light', () => {
    expect(DARK['--btn-hover']).toBe('#2f2e2d');
    expect(LIGHT['--btn-hover']).toBe('rgba(0, 0, 0, 0.06)');
  });
});

describe('panes (#96)', () => {
  it('keep dark as it was: the page ground and the usual selected row', () => {
    expect(DARK['--bg-pane']).toBe(DARK['--bg-page']);
    expect(DARK['--bg-pane-selected']).toBe(DARK['--bg-selected']);
  });
  it('set the light file tree apart from the page and the diff', () => {
    expect(LIGHT['--bg-pane']).not.toBe(LIGHT['--bg-page']);
    expect(LIGHT['--bg-pane']).toBe(LIGHT['--bg-chrome']);
  });
  it.each(['dark', 'light'] as const)(
    '%s: text on a selected pane row is at least 4.5:1',
    (name) => {
      const t = name === 'dark' ? DARK : LIGHT;
      const sel = over(
        parseColor(t['--bg-pane-selected']),
        parseColor(t['--bg-pane']),
      );
      const withSel = { ...t, '--sel': `rgb(${sel.slice(0, 3).join(', ')})` };
      for (const fg of TEXT)
        expect(contrast(fg, '--sel', withSel), fg).toBeGreaterThanOrEqual(4.5);
    },
  );
});

describe('light block', () => {
  it('overrides every colour token of the dark block', () => {
    const colourKeys = Object.keys(DARK).filter((k) =>
      /^(#|rgba?\()/.test(DARK[k]),
    );
    const missing = colourKeys.filter(
      (k) => !(k in decls(lightBlock)) && k !== '--accent',
    );
    expect(missing).toEqual([]);
  });
});

describe('stylesheets', () => {
  // Third-party sheets imported with @import (highlight.js in docs.css) are not scanned
  // here; they must be split per colour scheme with a media condition instead.
  it('use tokens instead of colour literals', () => {
    const hits: string[] = [];
    for (const f of readdirSync(dir).filter(
      (f) => f.endsWith('.css') && f !== 'tokens.css',
    ))
      readFileSync(path.join(dir, f), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/#[0-9a-f]{3,8}\b|rgba?\(/i.test(line))
            hits.push(`${f}:${i + 1}: ${line.trim()}`);
        });
    expect(hits).toEqual([]);
  });
});
