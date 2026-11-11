import { memo, useMemo, type MouseEvent } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import { decodeAnchor, hasScheme, isWeb, resolveRelative } from './links';

// As in Shellie's MarkdownView: ids are not prefixed by the sanitizer, so footnote links find their notes.
const schema = { ...defaultSchema, clobberPrefix: '' };

type Node = {
  type: string;
  properties?: Record<string, unknown>;
  children?: Node[];
};

/** Prefixes every id, so a page shown over a piece does not share an id with it. */
function rehypeIdPrefix(prefix: string) {
  const walk = (node: Node) => {
    if (node.type === 'element' && typeof node.properties?.id === 'string')
      node.properties.id = prefix + node.properties.id;
    node.children?.forEach(walk);
  };
  return (tree: Node) => {
    if (prefix) walk(tree);
  };
}

/** Brings the heading (or note) with this id into view. */
export function scrollToAnchor(idPrefix: string, anchor: string) {
  document
    .getElementById(idPrefix + anchor)
    ?.scrollIntoView?.({ block: 'start' });
}

/**
 * A text as markdown. A link to a heading scrolls to it; a web link opens in a new tab; a relative link is handed
 * to `onOpen` as a path in the brain, and never becomes an address the browser could ask the server for. Pictures
 * are not sent to the phone: their description stands in their place.
 */
export const Markdown = memo(function Markdown({
  text,
  path,
  idPrefix = '',
  onOpen,
}: {
  text: string;
  /** The path in the brain of the text shown: relative links start from it. */
  path: string;
  idPrefix?: string;
  onOpen: (path: string, anchor?: string) => void;
}) {
  const components = useMemo<Components>(
    () => ({
      a: ({ href = '', children, node: _n, ...rest }) => {
        if (isWeb(href))
          return (
            <a {...rest} href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          );
        if (href.startsWith('#')) {
          const follow = (e: MouseEvent) => {
            e.preventDefault();
            scrollToAnchor(idPrefix, decodeAnchor(href.slice(1)));
          };
          return (
            <a {...rest} href={href} onClick={follow}>
              {children}
            </a>
          );
        }
        if (hasScheme(href) || !href)
          return (
            <a {...rest} href={href || undefined} rel="noreferrer noopener">
              {children}
            </a>
          );
        const follow = (e: MouseEvent) => {
          e.preventDefault();
          const target = resolveRelative(path, href);
          const raw = href.includes('#') ? href.split('#')[1] : undefined;
          // A link out of the brain goes nowhere; the sheet says the page was not sent.
          onOpen(target ?? '', raw ? decodeAnchor(raw) : undefined);
        };
        // The path stays out of `href`: opening it in a new tab would send it to the server.
        return (
          <a {...rest} href="#" onClick={follow}>
            {children}
          </a>
        );
      },
      img: ({ alt }) => (
        <span className="picture" role="img" aria-label={alt || 'Picture'}>
          {alt ? `Picture: ${alt}` : 'Picture, not sent to your phone'}
        </span>
      ),
      table: ({ children, node: _n, ...rest }) => (
        <div className="table-scroll">
          <table {...rest}>{children}</table>
        </div>
      ),
      input: ({ node: _n, ...rest }) => <input {...rest} disabled />,
    }),
    [path, idPrefix, onOpen],
  );
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          [rehypeSanitize, schema],
          rehypeSlug,
          [rehypeIdPrefix, idPrefix],
        ]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
