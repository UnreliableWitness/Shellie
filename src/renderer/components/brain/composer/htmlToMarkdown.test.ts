import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, isRichHtml } from './htmlToMarkdown';

describe('htmlToMarkdown', () => {
  it('turns headings, lists and bold into Markdown', () => {
    expect(
      htmlToMarkdown('<h2>Decided</h2><ul><li>Go-live <b>2 Feb</b></li></ul>'),
    ).toBe('## Decided\n\n- Go-live **2 Feb**');
  });
  it('keeps links', () => {
    expect(htmlToMarkdown('<p>See <a href="https://x">spec</a></p>')).toBe(
      'See [spec](https://x)',
    );
  });
  it('turns a table into a GitHub table', () => {
    const md = htmlToMarkdown(
      '<table><thead><tr><th>Who</th><th>When</th></tr></thead><tbody><tr><td>A</td><td>Mon</td></tr></tbody></table>',
    );
    expect(md).toContain('| Who | When |');
    expect(md).toMatch(/\| -+ \| -+ \|/);
    expect(md).toContain('| A | Mon |');
  });
  it('drops styles, scripts and the head', () => {
    expect(
      htmlToMarkdown(
        '<html><head><title>T</title><meta charset="utf-8"><style>p{}</style></head><body><script>x()</script><p>Hi</p></body></html>',
      ),
    ).toBe('Hi');
  });
  it('gives plain words for a wrapper around plain text, without escapes or spans', () => {
    expect(
      htmlToMarkdown(
        '<html><body><p class="MsoNormal"><span style="x">Plain words here</span></p></body></html>',
      ),
    ).toBe('Plain words here');
  });
  it('keeps the paragraphs of a chat message apart', () => {
    expect(
      htmlToMarkdown(
        '<div><div>Anna</div><div><p>Line one</p><p>Line two</p></div></div>',
      ),
    ).toContain('Line one\n\nLine two');
  });
  it('never leaves more than one empty line', () => {
    expect(htmlToMarkdown('<p>a</p><br><br><br><p>b</p>')).not.toMatch(
      /\n{3,}/,
    );
  });
});

describe('htmlToMarkdown lists', () => {
  it('numbers an ordered list and nests with indentation', () => {
    expect(
      htmlToMarkdown('<ol><li>a</li><li>b<ul><li>c</li></ul></li></ol>'),
    ).toBe('1. a\n2. b\n   - c');
  });
});

describe('htmlToMarkdown escaping', () => {
  it('leaves underscores, stars and brackets in formatted text alone', () => {
    expect(
      htmlToMarkdown(
        '<p><b>Rename</b> file_name to my_var, cost 5*3 [draft]</p>',
      ),
    ).toBe('**Rename** file_name to my_var, cost 5*3 [draft]');
  });
});

describe('isRichHtml', () => {
  it('is rich only with formatting a person would want kept', () => {
    expect(isRichHtml('<h2>A</h2>')).toBe(true);
    expect(isRichHtml('<ul><li>a</li></ul>')).toBe(true);
    expect(isRichHtml('<p>See <a href="https://x">x</a></p>')).toBe(true);
    expect(isRichHtml('<table><tr><td>a</td></tr></table>')).toBe(true);
    expect(isRichHtml('<p>x <strong>y</strong></p>')).toBe(true);
    expect(
      isRichHtml(
        '<html><body><p class="MsoNormal"><span style="x">file_name 5*3 [draft]</span></p></body></html>',
      ),
    ).toBe(false);
    expect(
      isRichHtml('<div><span>## Heading</span><br><span>- item</span></div>'),
    ).toBe(false);
  });
});
