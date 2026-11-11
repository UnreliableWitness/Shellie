import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api as shellie } from '../../api';
import { installFakeApi } from '../../test-helpers/fakeApi';
import mermaid from 'mermaid';
import { rehypeLines } from '../../docs/rehypeLines';
import { MarkdownView } from './MarkdownView';

vi.mock('../../docs/rehypeLines', async (orig) => {
  const real = await orig<typeof import('../../docs/rehypeLines')>();
  // Counts parses: react-markdown runs this plugin once per parse.
  return { rehypeLines: vi.fn(real.rehypeLines) };
});

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, code: string) => {
      if (code.includes('bad')) throw new Error('Parse error on line 1');
      if (code.includes('click'))
        return {
          svg:
            '<svg data-testid="diagram" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
            '<a xlink:href="https://x.dev/page" target="_blank"><text>Web</text></a>' +
            '<a href="file:///etc/passwd" target="_top"><text>File</text></a>' +
            '<a xlink:href="javascript:alert(1)"><text>Js</text></a>' +
            '<a xlink:href="http://u:p@x.dev/"><text>Creds</text></a>' +
            '</svg>',
        };
      return { svg: '<svg data-testid="diagram"></svg>' };
    }),
  },
}));

const view = (text: string, over = {}) => {
  const onOpenDoc = vi.fn();
  const onOpenFile = vi.fn();
  const api = installFakeApi({
    'docs:asset': () => 'data:image/png;base64,AA==',
    'links:open': () => undefined,
    ...over,
  });
  render(
    <MarkdownView
      asset={(p) => shellie().invoke('docs:asset', 't', p)}
      path="docs/a.md"
      text={text}
      onOpenDoc={onOpenDoc}
      onOpenFile={onOpenFile}
    />,
  );
  return { onOpenDoc, onOpenFile, api };
};

describe('MarkdownView', () => {
  it('renders GFM tables and task lists', () => {
    view('| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n');
    expect(screen.getByRole('table')).toBeTruthy();
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    expect(boxes.every((b) => b.disabled)).toBe(true);
  });
  it('does not render raw HTML', () => {
    const { container } = render(
      <MarkdownView
        asset={(p) => shellie().invoke('docs:asset', 't', p)}
        path="a.md"
        text={'<img src=x onerror=alert(1)><script>x</script>'}
        onOpenDoc={() => {}}
        onOpenFile={() => {}}
      />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });
  it('highlights code and copies it', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    view('```ts\nconst a = 1;\n```\n');
    expect(
      document.querySelector('code.hljs, code .hljs-keyword'),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('const a = 1;');
  });
  it('routes links: md in the viewer, other files to the editor, web to links:open', async () => {
    const { onOpenDoc, onOpenFile, api } = view(
      '[p](../plans/b.md#x) [c](src/x.ts) [w](https://x.dev)',
    );
    await userEvent.click(screen.getByText('p'));
    expect(onOpenDoc).toHaveBeenCalledWith('plans/b.md', 'x');
    await userEvent.click(screen.getByText('c'));
    expect(onOpenFile).toHaveBeenCalledWith('docs/src/x.ts');
    await userEvent.click(screen.getByText('w'));
    expect(
      api.calls.some(
        (c) => c.channel === 'links:open' && c.args[0] === 'https://x.dev/',
      ),
    ).toBe(true);
  });
  it('loads relative images through docs:asset and does not load remote ones', async () => {
    view('![local](img/a.png) ![remote](https://x.dev/a.png)');
    await waitFor(() =>
      expect((screen.getByAltText('local') as HTMLImageElement).src).toMatch(
        /^data:image\/png/,
      ),
    );
    expect(screen.queryByAltText('remote')).toBeNull();
    expect(screen.getByRole('link', { name: /remote/ })).toBeTruthy();
  });
  it('renders mermaid diagrams and shows the error and source for a bad one', async () => {
    view('```mermaid\ngraph TD; A-->B\n```\n\n```mermaid\nbad\n```\n');
    expect(await screen.findByTestId('diagram')).toBeTruthy();
    expect(await screen.findByText(/Parse error on line 1/)).toBeTruthy();
    expect(screen.getByText('bad')).toBeTruthy();
  });
  it('gives headings GitHub-style ids', () => {
    view('## Send to Claude\n');
    expect(document.getElementById('send-to-claude')).toBeTruthy();
  });
  it('keeps source line attributes through sanitize', () => {
    view('first\n\nsecond\n');
    const ps = document.querySelectorAll('p[data-line-start]');
    expect(ps).toHaveLength(2);
    expect(ps[1].getAttribute('data-line-start')).toBe('3');
    expect(ps[1].getAttribute('data-line-end')).toBe('3');
  });
  it('does not refetch images or re-render mermaid when only callbacks change', async () => {
    const api = installFakeApi({
      'docs:asset': () => 'data:image/png;base64,AA==',
    });
    const text = '![local](img/a.png)\n\n```mermaid\ngraph TD; A-->B\n```\n';
    const mk = (f: () => void) => (
      <MarkdownView
        asset={(p) => shellie().invoke('docs:asset', 't', p)}
        path="docs/a.md"
        text={text}
        onOpenDoc={f}
        onOpenFile={f}
      />
    );
    vi.mocked(mermaid.render).mockClear();
    const { rerender } = render(mk(() => {}));
    await screen.findByTestId('diagram');
    await waitFor(() =>
      expect((screen.getByAltText('local') as HTMLImageElement).src).toMatch(
        /^data:/,
      ),
    );
    rerender(mk(() => {}));
    await new Promise((r) => setTimeout(r, 20));
    expect(api.calls.filter((c) => c.channel === 'docs:asset')).toHaveLength(1);
    expect(mermaid.render).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('diagram')).toBeTruthy();
  });
  it('ignores empty hrefs and malformed anchors', async () => {
    const { onOpenDoc, onOpenFile } = view(
      '[a](javascript:alert(1)) [b](#%E0%A4%A) [c](x.md#%E0%A4%A)',
    );
    await userEvent.click(screen.getByText('a'));
    await userEvent.click(screen.getByText('b'));
    await userEvent.click(screen.getByText('c'));
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(onOpenDoc).toHaveBeenCalledWith('docs/x.md', '%E0%A4%25A');
  });

  it('routes links inside a Mermaid diagram: default prevented, only http(s) to links:open', async () => {
    const { api } = view(
      '```mermaid\ngraph TD; A-->B; click A "https://x.dev/page"\n```\n',
    );
    await screen.findByTestId('diagram');
    const opened = () =>
      api.calls.filter((c) => c.channel === 'links:open').map((c) => c.args[0]);
    // fireEvent returns false when a handler called preventDefault.
    expect(fireEvent.click(screen.getByText('Web'))).toBe(false);
    expect(opened()).toEqual(['https://x.dev/page']);
    expect(fireEvent.click(screen.getByText('File'))).toBe(false);
    expect(fireEvent.click(screen.getByText('Js'))).toBe(false);
    expect(fireEvent.click(screen.getByText('Creds'))).toBe(false);
    expect(
      fireEvent(
        screen.getByText('Web'),
        new MouseEvent('auxclick', {
          bubbles: true,
          cancelable: true,
          button: 1,
        }),
      ),
    ).toBe(false);
    expect(
      fireEvent(
        screen.getByText('File'),
        new MouseEvent('auxclick', {
          bubbles: true,
          cancelable: true,
          button: 1,
        }),
      ),
    ).toBe(false);
    expect(opened()).toEqual(['https://x.dev/page', 'https://x.dev/page']);
    expect(document.querySelector('.doc-mermaid [target]')).toBeNull();
  });
  it('handles a middle click on a Markdown link like a click', async () => {
    const { api, onOpenDoc } = view('[w](https://x.dev) [p](b.md)');
    const aux = (el: Element) =>
      fireEvent(
        el,
        new MouseEvent('auxclick', {
          bubbles: true,
          cancelable: true,
          button: 1,
        }),
      );
    expect(aux(screen.getByText('w'))).toBe(false);
    expect(aux(screen.getByText('p'))).toBe(false);
    expect(
      api.calls.filter((c) => c.channel === 'links:open').map((c) => c.args[0]),
    ).toEqual(['https://x.dev/']);
    expect(onOpenDoc).toHaveBeenCalledWith('docs/b.md', undefined);
  });
  it('does nothing for a web link that is not a valid URL', async () => {
    const { api } = view('[bad](http://[) ![img](http://[)');
    expect(fireEvent.click(screen.getByText('bad'))).toBe(false);
    expect(fireEvent.click(screen.getByText('img'))).toBe(false);
    expect(api.calls.filter((c) => c.channel === 'links:open')).toEqual([]);
  });
  it('idPrefix prefixes heading ids and #links scroll to the prefixed heading', async () => {
    const { container } = render(
      <MarkdownView
        asset={(p) => shellie().invoke('docs:asset', 't', p)}
        path="a.md"
        text={'## Intro\n\n[up](#intro)\n'}
        idPrefix="s1-"
        onOpenDoc={() => {}}
        onOpenFile={() => {}}
      />,
    );
    const h = container.querySelector('h2') as HTMLElement;
    expect(h.id).toBe('s1-intro');
    const scroll = vi.fn();
    h.scrollIntoView = scroll;
    await userEvent.click(
      container.querySelector('a[href="#intro"]') as HTMLElement,
    );
    expect(scroll).toHaveBeenCalled();
  });
  it('idPrefix prefixes footnote ids and a footnote reference scrolls to its footnote', async () => {
    const { container } = render(
      <MarkdownView
        asset={(p) => shellie().invoke('docs:asset', 't', p)}
        path="a.md"
        text={'Claim[^1].\n\n[^1]: The note.\n'}
        idPrefix="s1-"
        onOpenDoc={() => {}}
        onOpenFile={() => {}}
      />,
    );
    const note = container.querySelector('li[id^="s1-"]') as HTMLElement;
    expect(note.id).toMatch(/^s1-.*fn-1$/);
    const scroll = vi.fn();
    note.scrollIntoView = scroll;
    await userEvent.click(
      container.querySelector('a[data-footnote-ref]') as HTMLElement,
    );
    expect(scroll).toHaveBeenCalled();
  });
  it('does not parse again when only the callbacks change', () => {
    const props = {
      asset: async () => '',
      path: 'a.md',
      text: '# Title\n\nBody.\n',
    };
    const { rerender } = render(
      <MarkdownView {...props} onOpenDoc={() => {}} onOpenFile={() => {}} />,
    );
    const parses = vi.mocked(rehypeLines).mock.calls.length;
    rerender(
      <MarkdownView {...props} onOpenDoc={() => {}} onOpenFile={() => {}} />,
    );
    expect(vi.mocked(rehypeLines).mock.calls.length).toBe(parses);
    rerender(
      <MarkdownView
        {...props}
        text={'# Other\n'}
        onOpenDoc={() => {}}
        onOpenFile={() => {}}
      />,
    );
    expect(vi.mocked(rehypeLines).mock.calls.length).toBeGreaterThan(parses);
    expect(screen.getByRole('heading').textContent).toBe('Other');
  });
});
