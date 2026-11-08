import { Copy16Regular } from '@fluentui/react-icons';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import type { Element, Root } from 'hast';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import { openWeb, resolveRelative } from '../../docs/linkify';
import { rehypeLines } from '../../docs/rehypeLines';
import { remarkFigures } from '../../docs/remarkFigures';
import { MermaidBlock } from './MermaidBlock';

const schema = {
  ...defaultSchema,
  clobberPrefix: '',
  attributes: {
    ...defaultSchema.attributes,
    '*': [
      ...(defaultSchema.attributes?.['*'] ?? []),
      'dataLineStart',
      'dataLineEnd',
      'dataFigure',
    ],
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ['className', /^language-./],
    ],
  },
};
const isWeb = (href: string) => /^https?:\/\//i.test(href);
const hasScheme = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href);

function decodeAnchor(a: string): string {
  try {
    return decodeURIComponent(a);
  } catch {
    return a;
  }
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node)
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  return '';
}

function LocalImage({
  asset,
  path,
  alt,
}: {
  asset: (path: string) => Promise<string>;
  path: string;
  alt: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    asset(path).then(
      (s) => live && setSrc(s),
      () => live && setSrc(null),
    );
    return () => {
      live = false;
    };
  }, [asset, path]);
  return src ? (
    <img src={src} alt={alt} />
  ) : (
    <span className="muted">{alt}</span>
  );
}

/** A picture cited by a link, shown under its block with the link text as caption. A picture that fails shows nothing. */
function Figure({
  asset,
  path,
  alt,
}: {
  asset: (path: string) => Promise<string>;
  path: string;
  alt: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    asset(path).then(
      (s) => live && setSrc(s),
      () => live && setSrc(null),
    );
    return () => {
      live = false;
    };
  }, [asset, path]);
  return src ? (
    <span className="doc-figure">
      <img src={src} alt={alt} />
      <span className="doc-figure-cap">{alt}</span>
    </span>
  ) : null;
}

/** Prefixes the heading ids, so two views on one screen (a chapter's sections) do not share an id. */
function rehypeIdPrefix(prefix: string) {
  return (tree: Root) => {
    if (!prefix) return;
    visit(tree, 'element', (node: Element) => {
      if (
        /^h[1-6]$/.test(node.tagName) &&
        typeof node.properties.id === 'string'
      )
        node.properties.id = prefix + node.properties.id;
    });
  };
}

export function MarkdownView({
  asset,
  path,
  text,
  onOpenDoc,
  onOpenFile,
  figures,
  idPrefix = '',
}: {
  /** Loads a relative image as a data URL (a task's `docs:asset`, a brain's `brain:asset`). */
  asset: (path: string) => Promise<string>;
  path: string;
  text: string;
  onOpenDoc(path: string, anchor?: string): void;
  onOpenFile(path: string): void;
  /** Shows the pictures a link cites under its block, except those in `shown`. Absent: no figures. */
  figures?: { shown: ReadonlySet<string> };
  /** Prefix for every heading id and the `#x` links within the view; anchors given to `onOpenDoc` stay as written. */
  idPrefix?: string;
}) {
  const shown = figures?.shown;
  const cb = useRef({ onOpenDoc, onOpenFile, asset });
  cb.current = { onOpenDoc, onOpenFile, asset };
  // Callers may pass a new function each render; images must not refetch for that.
  const loadAsset = useCallback((p: string) => cb.current.asset(p), []);
  // Stable element types: new component functions would remount every MermaidBlock and LocalImage.
  const components = useMemo<Components>(
    () => ({
      a: ({ href = '', children, node: _n, ...rest }) => {
        const follow = (e: MouseEvent<HTMLAnchorElement>) => {
          e.preventDefault();
          // auxclick also fires for the right button; only a middle click follows the link.
          if (e.type === 'auxclick' && e.button !== 1) return;
          if (!href) return;
          if (href.startsWith('#')) {
            const id = decodeAnchor(href.slice(1));
            (
              document.getElementById(idPrefix + id) ??
              document.getElementById(id)
            )?.scrollIntoView?.({ block: 'start' });
          } else if (isWeb(href)) {
            openWeb(href);
          } else if (!hasScheme(href)) {
            const target = resolveRelative(path, href);
            if (!target) return;
            const raw = href.includes('#') ? href.split('#')[1] : undefined;
            const anchor = raw === undefined ? undefined : decodeAnchor(raw);
            if (/\.(md|markdown)$/i.test(target))
              cb.current.onOpenDoc(target, anchor);
            else cb.current.onOpenFile(target);
          }
        };
        return (
          <a {...rest} href={href} onClick={follow} onAuxClick={follow}>
            {children}
          </a>
        );
      },
      img: ({ src = '', alt = '', ...rest }) => {
        const s = String(src);
        if (isWeb(s) || hasScheme(s))
          return (
            <a
              href={s}
              onClick={(e) => {
                e.preventDefault();
                openWeb(s);
              }}
              onAuxClick={(e) => {
                e.preventDefault();
                if (e.button === 1) openWeb(s);
              }}
            >
              {alt || s}
            </a>
          );
        const target = resolveRelative(path, s);
        if ((rest as Record<string, unknown>)['data-figure'] === 'true')
          return target ? (
            <Figure asset={loadAsset} path={target} alt={alt} />
          ) : null;
        return target ? (
          <LocalImage asset={loadAsset} path={target} alt={alt} />
        ) : (
          <span className="muted">{alt}</span>
        );
      },
      input: (props: ComponentProps<'input'>) => <input {...props} disabled />,
      pre: ({ children, node: _n, ...rest }) => {
        const child = Array.isArray(children) ? children[0] : children;
        const cls =
          (child as { props?: { className?: string } })?.props?.className ?? '';
        const code = textOf(child).replace(/\n$/, '');
        if (/\blanguage-mermaid\b/.test(cls))
          return <MermaidBlock code={code} />;
        return (
          <div className="doc-code">
            <button
              type="button"
              className="btn btn-subtle btn-sm doc-copy"
              aria-label="Copy code"
              onClick={() => void navigator.clipboard?.writeText(code)}
            >
              <Copy16Regular />
            </button>
            <pre {...rest}>{children}</pre>
          </div>
        );
      },
    }),
    [path, loadAsset, idPrefix],
  );
  return (
    <article className="doc-md">
      <Markdown
        remarkPlugins={
          shown ? [remarkGfm, [remarkFigures, { path, shown }]] : [remarkGfm]
        }
        rehypePlugins={[
          rehypeLines,
          [rehypeSanitize, schema],
          rehypeSlug,
          [rehypeIdPrefix, idPrefix],
          [rehypeHighlight, { detect: false, plainText: ['mermaid'] }],
        ]}
        components={components}
      >
        {text}
      </Markdown>
    </article>
  );
}
