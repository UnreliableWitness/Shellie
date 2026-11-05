import { describe, expect, it } from 'vitest';
import {
  guessSourceType,
  parseSourceFrontmatter,
  renderSource,
  sha256,
  slugify,
  sourceFileName,
} from './sourceFile';

describe('sourceFile', () => {
  it('names a source by date and slug and avoids collisions', () => {
    const d = new Date('2026-10-02T10:00:00Z');
    expect(sourceFileName(d, 'acme-sow', new Set())).toBe(
      '2026-10-02-acme-sow.md',
    );
    expect(
      sourceFileName(d, 'acme-sow', new Set(['2026-10-02-acme-sow.md'])),
    ).toBe('2026-10-02-acme-sow-2.md');
    expect(
      sourceFileName(
        d,
        'acme-sow',
        new Set(['2026-10-02-acme-sow.md', '2026-10-02-acme-sow-2.md']),
      ),
    ).toBe('2026-10-02-acme-sow-3.md');
  });

  it('slugify strips the extension and odd characters', () => {
    expect(slugify('Acme SOW (final).PDF')).toBe('acme-sow-final');
    expect(slugify('a'.repeat(100)).length).toBe(60);
  });

  it('renders and parses frontmatter round trip', () => {
    const fm = {
      title: 'Acme: SOW "final"',
      source_url: 'https://example.com/a?b=1#c',
      ingested_at: '2026-10-02T10:00:00.000Z',
      content_type: 'sow' as const,
      sha256: sha256('hello'),
    };
    const text = renderSource(fm, 'Body text\n');
    expect(text.startsWith('---\ntitle:')).toBe(true);
    expect(text).toContain('---\n\nBody text\n');
    expect(parseSourceFrontmatter(text)).toEqual(fm);
  });

  it('keeps a note through the round trip and drops a blank one', () => {
    const fm = {
      title: 'Deck',
      source_url: 'deck.pptx',
      ingested_at: '2026-11-05T10:00:00.000Z',
      content_type: 'deck' as const,
      sha256: sha256('x'),
      note: 'Kickoff deck: slide 7 pricing is outdated',
    };
    const text = renderSource(fm, 'Body\n');
    expect(text).toContain('note: "Kickoff deck: slide 7 pricing is outdated"');
    expect(parseSourceFrontmatter(text)).toEqual(fm);
    expect(
      parseSourceFrontmatter(renderSource({ ...fm, note: '' }, 'Body\n')),
    ).toEqual({ ...fm, note: undefined });
  });

  it('returns null without usable frontmatter', () => {
    expect(parseSourceFrontmatter('just text')).toBeNull();
    expect(parseSourceFrontmatter('---\ntitle: x\n---\n\nbody')).toBeNull();
  });

  it('guesses the content type', () => {
    expect(guessSourceType('a.vtt')).toBe('transcript');
    expect(guessSourceType('a.pptx')).toBe('deck');
    expect(guessSourceType('a.pdf')).toBe('doc');
    expect(guessSourceType('A.DOCX')).toBe('doc');
    expect(guessSourceType('a.xyz')).toBe('doc');
  });

  it('hashes strings and buffers identically', () => {
    expect(sha256('abc')).toBe(sha256(Buffer.from('abc')));
    expect(sha256('abc')).toHaveLength(64);
  });
});
