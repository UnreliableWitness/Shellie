import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrainPageRow } from '../../../shared/brain';
import { installMatchMedia } from '../../testColorScheme';
import { BrainGraph } from './BrainGraph';

const row = (over: Partial<BrainPageRow> & { path: string }): BrainPageRow => ({
  title: over.path,
  summary: '',
  type: 'other',
  lastUpdated: null,
  confidence: null,
  verified: null,
  changedSinceVerified: false,
  sources: [],
  linkedFrom: [],
  pictures: [],
  ...over,
});
const rows = [
  row({ path: 'wiki/account.md', title: 'Acme', type: 'account' }),
  row({
    path: 'wiki/db.md',
    title: 'Database',
    type: 'decision',
    linkedFrom: ['wiki/account.md'],
  }),
  row({ path: 'wiki/hosting.md', title: 'Hosting', type: 'decision' }),
];

afterEach(installMatchMedia);

describe('BrainGraph', () => {
  it('draws a dot per page with the counts and the types in it', () => {
    render(<BrainGraph rows={rows} newPaths={new Set()} onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: 'Acme' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hosting' })).toBeInTheDocument();
    expect(screen.getByText('3 pages · 1 link')).toBeInTheDocument();
    expect(screen.getByText('account')).toBeInTheDocument();
    expect(screen.getByText('decision')).toBeInTheDocument();
  });

  it('opens a page on click and on Enter', async () => {
    const onOpen = vi.fn();
    render(<BrainGraph rows={rows} newPaths={new Set()} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole('button', { name: 'Database' }));
    expect(onOpen).toHaveBeenLastCalledWith('wiki/db.md');
    screen.getByRole('button', { name: 'Hosting' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(onOpen).toHaveBeenLastCalledWith('wiki/hosting.md');
  });

  it('dims the pages a focused page does not link to and names its neighbours', () => {
    render(<BrainGraph rows={rows} newPaths={new Set()} onOpen={() => {}} />);
    const acme = screen.getByRole('button', { name: 'Acme' });
    const hosting = screen.getByRole('button', { name: 'Hosting' });
    expect(hosting).not.toHaveClass('dim');
    act(() => acme.focus());
    expect(hosting).toHaveClass('dim');
    expect(screen.getByRole('button', { name: 'Database' })).not.toHaveClass(
      'dim',
    );
    expect(acme).toHaveClass('hover');
  });

  it('rings pages changed since the last visit', () => {
    const { container } = render(
      <BrainGraph
        rows={rows}
        newPaths={new Set(['wiki/hosting.md'])}
        onOpen={() => {}}
      />,
    );
    expect(container.querySelectorAll('.brain-graph-new')).toHaveLength(1);
  });

  it('draws nothing for fewer than two pages', () => {
    const { container } = render(
      <BrainGraph
        rows={rows.slice(0, 1)}
        newPaths={new Set()}
        onOpen={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('says how many pages it leaves out of a big brain', () => {
    const many = Array.from({ length: 160 }, (_, i) =>
      row({ path: `wiki/p${i}.md` }),
    );
    render(<BrainGraph rows={many} newPaths={new Set()} onOpen={() => {}} />);
    expect(screen.getByText('150 of 160 pages · 0 links')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(150);
  });

  it('places every dot at once and moves nothing with reduced motion', () => {
    window.matchMedia = ((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const { container } = render(
      <BrainGraph rows={rows} newPaths={new Set()} onOpen={() => {}} />,
    );
    for (const g of container.querySelectorAll('.brain-graph-node'))
      expect(g.getAttribute('transform')).toMatch(/^translate\(/);
    expect(raf).not.toHaveBeenCalled();
    raf.mockRestore();
  });
});
