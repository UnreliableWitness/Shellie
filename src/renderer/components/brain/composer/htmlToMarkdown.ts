import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

let service: TurndownService | null = null;

function turndown(): TurndownService {
  if (service) return service;
  const t = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
  });
  t.use(gfm);
  // Turndown pads a list marker to four columns (`-   item`); one space is what people type. Task items from gfm win.
  t.addRule('listItem', {
    filter: 'li',
    replacement: (content, node, options) => {
      const parent = node.parentNode as HTMLElement | null;
      let marker = `${options.bulletListMarker} `;
      if (parent?.nodeName === 'OL') {
        const start = Number(parent.getAttribute('start') ?? 1);
        marker = `${start + Array.prototype.indexOf.call(parent.children, node)}. `;
      }
      const body = content
        .replace(/^\n+/, '')
        .replace(/\n+$/, '\n')
        .replace(/\n/gm, `\n${' '.repeat(marker.length)}`);
      return (
        marker + body + (node.nextSibling && !body.endsWith('\n') ? '\n' : '')
      );
    },
  });
  t.remove(['script', 'style', 'meta', 'head', 'title']);
  service = t;
  return t;
}

/** Rich text from the clipboard (an email, a Teams message, a web page) as GitHub-flavored Markdown. */
export function htmlToMarkdown(html: string): string {
  return turndown()
    .turndown(html)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
