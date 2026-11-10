import { describe, expect, it } from 'vitest';
import {
  applyFormat,
  fileKind,
  isEditorText,
  suggestStronger,
  titleFor,
} from './text';

describe('titleFor', () => {
  it('keeps a title that was typed', () => {
    expect(titleFor('  Mine ', '# H')).toBe('Mine');
  });
  it('takes the first heading', () => {
    expect(titleFor('', 'intro\n\n## Steerco 5 Nov ##\n\nx')).toBe(
      'Steerco 5 Nov',
    );
  });
  it('else the first line, without list or quote markers', () => {
    expect(titleFor('', '\n- just a line\nmore')).toBe('just a line');
    expect(titleFor('', '> quoted')).toBe('quoted');
  });
  it('cuts a long first line at a word', () => {
    const t = titleFor('', 'word '.repeat(20));
    expect(t.endsWith('…')).toBe(true);
    expect(t.length).toBeLessThanOrEqual(61);
    expect(t).not.toMatch(/ …$/);
  });
  it('is empty for empty text', () => {
    expect(titleFor('', '\n\n')).toBe('');
  });
});

describe('applyFormat', () => {
  it('wraps the selection in bold, italic or code', () => {
    expect(applyFormat('bold', 'ab cd', 3, 5)).toEqual({
      text: 'ab **cd**',
      start: 5,
      end: 7,
    });
    expect(applyFormat('italic', 'ab', 0, 2).text).toBe('_ab_');
    expect(applyFormat('code', 'ab', 0, 2).text).toBe('`ab`');
  });
  it('puts the caret between the markers with no selection', () => {
    expect(applyFormat('bold', 'ab', 2, 2)).toEqual({
      text: 'ab****',
      start: 4,
      end: 4,
    });
  });
  it('fences a selection of several lines as code', () => {
    expect(applyFormat('code', 'a\nb', 0, 3).text).toBe('```\na\nb\n```');
  });
  it('prefixes every selected line, and takes the prefix off again', () => {
    const once = applyFormat('bullets', 'a\nb', 0, 3);
    expect(once.text).toBe('- a\n- b');
    expect(applyFormat('bullets', once.text, once.start, once.end).text).toBe(
      'a\nb',
    );
    expect(applyFormat('checklist', 'x', 0, 0).text).toBe('- [ ] x');
    expect(applyFormat('heading', 'top\nx', 4, 5).text).toBe('top\n## x');
  });
  it('makes a link with the url selected', () => {
    const r = applyFormat('link', 'see docs', 4, 8);
    expect(r.text).toBe('see [docs](url)');
    expect(r.text.slice(r.start, r.end)).toBe('url');
  });
  it('inserts a table on lines of its own', () => {
    const r = applyFormat('table', 'ab', 2, 2);
    expect(r.text).toBe('ab\n\n| Column | Column |\n| --- | --- |\n|  |  |\n');
  });
});

describe('files', () => {
  it('opens Markdown and text in the editor', () => {
    expect(isEditorText('A.MD')).toBe(true);
    expect(isEditorText('n.markdown')).toBe(true);
    expect(isEditorText('n.txt')).toBe(true);
    expect(isEditorText('a.pdf')).toBe(false);
  });
  it('knows a kind per extension', () => {
    expect(fileKind('a.pdf')).toBe('pdf');
    expect(fileKind('a.DOCX')).toBe('word');
    expect(fileKind('a.pptx')).toBe('deck');
    expect(fileKind('a.xlsx')).toBe('sheet');
    expect(fileKind('a.drawio')).toBe('drawio');
    expect(fileKind('a.vtt')).toBe('transcript');
    expect(fileKind('a.md')).toBe('text');
    expect(fileKind('a.png')).toBe('picture');
    expect(fileKind('a.zip')).toBe('other');
  });
  it('suggests a stronger model for a deck or a large file', () => {
    expect(suggestStronger([{ name: 'a.pptx', bytes: 1 }])).toBe('the deck');
    expect(suggestStronger([{ name: 'a.pdf', bytes: 6e6 }])).toBe(
      'the large file',
    );
    expect(suggestStronger([{ name: 'a.pdf', bytes: 1e6 }])).toBeNull();
    expect(suggestStronger([])).toBeNull();
  });
});
