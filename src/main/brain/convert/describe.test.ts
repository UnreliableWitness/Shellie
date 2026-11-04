import { describe, expect, it } from 'vitest';
import { describeContents } from './describe';

describe('describeContents', () => {
  it("counts a deck's slides, pictures and tables and names the first slides", () => {
    const md = [
      '## Slide 1',
      'Acme platform: target architecture',
      '![Architecture diagram]({{assets}}/slide-1-1.png)',
      '',
      '## Slide 2',
      'Phase 1 scope',
      '| Milestone | Date |',
      '| --- | --- |',
      '| Gateway live | 2026-12-15 |',
      '',
      '## Slide 3',
      '_Notes:_ only notes',
      '',
    ].join('\n');
    expect(describeContents(md, 1, 'pptx')).toBe(
      '3 slides · 1 picture · 1 table: Acme platform: target architecture; Phase 1 scope; Notes: only notes',
    );
  });

  it('counts pages and drawn pages of a PDF', () => {
    const md =
      '## p.1\n\nTarget architecture\nWeb App\n![p.1 as drawn]({{assets}}/p1.png)\n\n## p.2\n\nPlain page\n';
    expect(describeContents(md, 1, 'pdf')).toBe(
      '2 pages · 1 drawn page · 1 picture: Target architecture; Plain page',
    );
  });

  it('counts sheets and rows of a workbook and names the sheets', () => {
    const md =
      '## Budget 2026\n\n| Item | EUR |\n| --- | --- |\n| Licences | 1250 |\n| Total | 1250 |\n\n## Notes\n\n_(empty sheet)_\n';
    expect(describeContents(md, 0, 'xlsx')).toBe(
      '2 sheets · 3 rows: Budget 2026; Notes',
    );
  });

  it('counts minutes and speakers of a transcript', () => {
    const md =
      '## 0:00:00\n\n**Ann:** Welcome.\n\n**Bob:** Thanks.\n\n## 0:01:00\n\n**Ann:** Next item.\n';
    expect(describeContents(md, 0, 'vtt')).toBe('2 min · 2 speakers');
  });

  it('names the headings of a document and falls back to the first line of a note', () => {
    expect(
      describeContents(
        '# Project Plan\n\nBody.\n\n## Scope\n\nText\n',
        0,
        'docx',
      ),
    ).toBe('2 headings: Project Plan; Scope');
    expect(
      describeContents('Kickoff with Acme on Friday.\nMore.\n', 0, 'txt'),
    ).toBe('6 words: Kickoff with Acme on Friday.');
  });

  it('clips long titles and the whole line', () => {
    const long = 'x'.repeat(100);
    const line = describeContents(
      `## Slide 1\n${long}\n## Slide 2\n${long}\n## Slide 3\n${long}\n## Slide 4\n${long}\n`,
      0,
      'pptx',
    );
    expect(line.length).toBeLessThanOrEqual(180);
    expect(line).toContain('…');
  });
});
