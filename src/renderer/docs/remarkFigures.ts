import type { Image, Link, Root, RootContent } from 'mdast';
import { toString } from 'mdast-util-to-string';
import { visit } from 'unist-util-visit';
import { resolveRelative } from './linkify';

const PICTURE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
const hasScheme = (url: string) => /^[a-z][a-z0-9+.-]*:/i.test(url);

/** The picture a link or image url points at, as a path in the brain; null for pages, web links and the rest. */
function pictureOf(path: string, url: string): string | null {
  if (!url || hasScheme(url) || url.startsWith('#')) return null;
  const target = resolveRelative(path, url);
  return target && PICTURE.test(target) ? target : null;
}

/**
 * Shows a picture where a page cites it: after the block (paragraph, list, table) with a link to the picture, a
 * paragraph holding the picture as a figure, captioned with the link text. A picture gets one figure, at its first
 * citation, and none when it is in `shown` or embedded with `![]` anywhere in the document. Pure: `shown` is only read.
 */
export function remarkFigures({
  path,
  shown,
}: {
  path: string;
  shown: ReadonlySet<string>;
}) {
  return (tree: Root) => {
    const embedded = new Set<string>();
    visit(tree, 'image', (img: Image) => {
      const p = pictureOf(path, img.url);
      if (p) embedded.add(p);
    });
    const done = new Set<string>();
    const out: RootContent[] = [];
    for (const block of tree.children) {
      out.push(block);
      const figures: RootContent[] = [];
      visit(block, 'link', (link: Link) => {
        const p = pictureOf(path, link.url);
        if (!p || shown.has(p) || embedded.has(p) || done.has(p)) return;
        done.add(p);
        figures.push({
          type: 'paragraph',
          children: [
            {
              type: 'image',
              url: link.url.split('#')[0],
              alt: toString(link),
              data: { hProperties: { dataFigure: 'true' } },
            },
          ],
        });
      });
      out.push(...figures);
    }
    tree.children = out;
  };
}
