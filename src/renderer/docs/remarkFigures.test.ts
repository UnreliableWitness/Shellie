import type { Image, Root, RootContent } from 'mdast';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';
import { remarkFigures } from './remarkFigures';

const PATH = 'wiki/page.md';
const X = '../sources/a-assets/x.png';

function run(md: string, shown: ReadonlySet<string> = new Set()): Root {
  const proc = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFigures, { path: PATH, shown });
  return proc.runSync(proc.parse(md)) as Root;
}
const figures = (tree: Root) =>
  tree.children.flatMap((b, i) => {
    if (b.type !== 'paragraph') return [];
    const img = b.children[0];
    return img?.type === 'image' && img.data?.hProperties?.dataFigure === 'true'
      ? [{ at: i, img: img as Image }]
      : [];
  });
const types = (tree: Root) => tree.children.map((b: RootContent) => b.type);

describe('remarkFigures', () => {
  it('puts a figure after a paragraph that cites a picture, caption from the link text, link kept', () => {
    const tree = run(`See [the slide](${X}) for it.\n\nNext.\n`);
    expect(types(tree)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    const [f] = figures(tree);
    expect(f.at).toBe(1);
    expect(f.img.url).toBe(X);
    expect(f.img.alt).toBe('the slide');
    const first = tree.children[0];
    expect(first.type === 'paragraph' && first.children[1].type).toBe('link');
  });

  it('puts it after the whole list or table', () => {
    const tree = run(
      `- one [a](${X})\n- two\n\n| h |\n|---|\n| [b](../sources/a-assets/y.png) |\n`,
    );
    expect(types(tree)).toEqual(['list', 'paragraph', 'table', 'paragraph']);
    expect(figures(tree).map((f) => f.at)).toEqual([1, 3]);
  });

  it('gives two citations of one picture one figure, at the first', () => {
    const tree = run(`[a](${X})\n\nmiddle\n\n[b](${X})\n`);
    expect(figures(tree).map((f) => f.at)).toEqual([1]);
  });

  it('gives none for a picture in shown', () => {
    const tree = run(`[a](${X})\n`, new Set(['sources/a-assets/x.png']));
    expect(figures(tree)).toEqual([]);
  });

  it('gives none for a picture embedded anywhere in the document', () => {
    expect(figures(run(`![x](${X})\n\n[a](${X})\n`))).toEqual([]);
    expect(figures(run(`[a](${X})\n\n![x](${X})\n`))).toEqual([]);
    expect(figures(run(`[a](${X}) and ![x](${X})\n`))).toEqual([]);
  });

  it('gives none for pages and web links, and strips a fragment', () => {
    expect(
      figures(
        run('[p](other.md) [w](https://x.dev/a.png) [m](mailto:a@b.c)\n'),
      ),
    ).toEqual([]);
    const [f] = figures(run(`[a](${X}#frag)\n`));
    expect(f.img.url).toBe(X);
  });

  it('does not mutate shown and gives the same result when run twice', () => {
    const shown = new Set(['wiki/other.png']);
    const md = `[a](${X})\n`;
    const a = run(md, shown);
    const b = run(md, shown);
    expect([...shown]).toEqual(['wiki/other.png']);
    expect(figures(a)).toHaveLength(1);
    expect(figures(b)).toHaveLength(1);
  });
});
