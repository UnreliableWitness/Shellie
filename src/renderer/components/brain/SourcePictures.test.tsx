import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  BrainJob,
  PictureCounts,
  PictureRow,
  SourcePictures as SourcePicturesData,
} from '../../../shared/brain';
import { installFakeApi } from '../../test-helpers/fakeApi';
import {
  AddedPictures,
  SourcePictures,
  useSourcePictures,
} from './SourcePictures';

const SOURCE = 'sources/2026-11-04-acme-kickoff.md';
const ASSETS = 'sources/2026-11-04-acme-kickoff-assets';

const picture = (
  over: Partial<PictureRow> & { status: PictureRow['status'] },
): PictureRow => ({
  path: `${ASSETS}/slide-1-1.png`,
  label: 'Slide 1',
  alt: null,
  pages: [],
  reason: null,
  fix: null,
  where: null,
  ...over,
});

const countsOf = (rows: PictureRow[], tiny = 0): PictureCounts => {
  const n = (s: PictureRow['status']) =>
    rows.filter((r) => r.status === s).length;
  return {
    total: rows.length,
    described: n('described'),
    skipped: n('skipped'),
    missing: n('missing'),
    dropped: n('dropped'),
    accepted: n('accepted'),
    tiny,
  };
};

const data = (rows: PictureRow[], tiny = 0): SourcePicturesData => ({
  source: SOURCE,
  counts: countsOf(rows, tiny),
  rows,
});

/** The mockup's deck: 11 described, 2 nothing to record, 1 not interpreted, 2 never reached the agent. */
const deck = () =>
  data([
    picture({
      status: 'described',
      label: 'Slide 4',
      alt: 'Integration architecture',
      path: `${ASSETS}/slide-4-1.png`,
      pages: ['wiki/architecture.md', 'wiki/integrations.md'],
    }),
    picture({
      status: 'missing',
      label: 'Slide 11',
      alt: 'Whiteboard photo',
      path: `${ASSETS}/slide-11-1.png`,
    }),
    picture({
      status: 'skipped',
      label: 'Slide layouts and master',
      path: `${ASSETS}/layout-1.png`,
      reason: 'company logo on every slide',
    }),
    picture({
      status: 'dropped',
      label: 'Slide 9',
      alt: 'picture 2',
      path: null,
      reason: 'EMF converts on Windows only',
      fix: 'Re-add the deck on Windows, or save the picture as PNG',
      where: 'Slide 9, picture 2',
    }),
    picture({
      status: 'dropped',
      label: 'Slide 12',
      path: null,
      reason: 'EMF converts on Windows only',
      fix: 'Re-add the deck on Windows, or save the picture as PNG',
      where: 'Slide 12, picture 1',
    }),
    picture({ status: 'skipped', label: 'Slide 2' }),
    ...Array.from({ length: 10 }, (_, i) =>
      picture({
        status: 'described',
        label: `Slide ${20 + i}`,
        path: `${ASSETS}/slide-${20 + i}-1.png`,
        pages: ['wiki/planning.md'],
      }),
    ),
  ]);

const job = (over: Partial<BrainJob>): BrainJob => ({
  id: 'j1',
  brainId: 'b1',
  kind: 'pictures',
  source: SOURCE,
  status: 'running',
  startedAt: '2026-11-07T09:00:00.000Z',
  endedAt: null,
  sessionId: null,
  result: null,
  error: null,
  background: false,
  agent: 'claude',
  ...over,
});

const fake = () =>
  installFakeApi({
    'brain:asset': (_id, rel) => `shellie-asset://${rel}`,
    'brain:run': (brainId, kind, source) =>
      job({ brainId, kind, source: source ?? null, status: 'queued' }),
    'brain:acceptDrop': () => undefined,
  });

const panel = (
  pictures: SourcePicturesData,
  extra: Partial<React.ComponentProps<typeof SourcePictures>> = {},
) => (
  <SourcePictures
    brainId="b1"
    pictures={pictures}
    jobs={[]}
    onOpen={() => undefined}
    {...extra}
  />
);

describe('SourcePictures', () => {
  it('counts the pictures per status and tags each row', async () => {
    fake();
    render(panel(deck()));
    const region = screen.getByRole('region', { name: 'Pictures' });
    expect(within(region).getByLabelText('Counts')).toHaveTextContent(
      '11 described · 2 nothing to record · 1 not interpreted · 2 never reached the agent',
    );
    for (const tag of [
      'described',
      'nothing to record',
      'not interpreted',
      'never reached the agent',
    ])
      expect(
        within(region).getAllByText(tag, { selector: '.tag' }).length,
      ).toBeGreaterThan(0);
    expect(
      within(region).getByText(
        'Nothing to record: company logo on every slide',
      ),
    ).toBeInTheDocument();
    expect(
      within(region).getAllByText(
        'Never reached the agent: EMF converts on Windows only. Re-add the deck on Windows, or save the picture as PNG.',
      ),
    ).toHaveLength(2);
    await waitFor(() =>
      expect(
        within(region).getByRole('img', {
          name: 'Slide 4 · Integration architecture',
        }),
      ).toHaveAttribute('src', `shellie-asset://${ASSETS}/slide-4-1.png`),
    );
  });

  it('links the pages that describe a picture', async () => {
    fake();
    const onOpen = vi.fn();
    render(panel(deck(), { onOpen }));
    await userEvent.click(screen.getByRole('button', { name: 'integrations' }));
    expect(onOpen).toHaveBeenCalledWith('wiki/integrations.md');
  });

  it('shows the first five rows, then Show all 16', async () => {
    fake();
    render(panel(deck()));
    const list = screen.getByRole('list', { name: 'Pictures' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    await userEvent.click(screen.getByRole('button', { name: 'Show all 16' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(16);
    expect(
      screen.queryByRole('button', { name: /Show all/ }),
    ).not.toBeInTheDocument();
  });

  it('omits the parts that are zero, and says how many tiny images were not looked at', () => {
    fake();
    render(
      panel(
        data(
          [
            picture({ status: 'described', pages: ['wiki/a.md'] }),
            picture({ status: 'described', pages: ['wiki/a.md'] }),
          ],
          23,
        ),
      ),
    );
    expect(screen.getByLabelText('Counts')).toHaveTextContent(
      /^2 described · plus 23 tiny images not looked at$/,
    );
    expect(
      screen.queryByRole('button', { name: /Re-evaluate/ }),
    ).not.toBeInTheDocument();
  });

  it('Re-evaluate 1 picture queues a pictures job for the source', async () => {
    const a = fake();
    render(panel(deck()));
    await userEvent.click(
      screen.getByRole('button', { name: 'Re-evaluate 1 picture' }),
    );
    expect(
      a.calls.filter((c) => c.channel === 'brain:run').map((c) => c.args),
    ).toEqual([['b1', 'pictures', SOURCE]]);
    expect(a.tracked).toContainEqual({
      type: 'event',
      name: 'brain.screen.action',
      props: { action: 'reevaluate' },
    });
  });

  it('while a pictures job for the source is queued or running the button says Re-evaluating…', () => {
    fake();
    const { rerender } = render(panel(deck(), { jobs: [job({})] }));
    expect(
      screen.getByRole('button', { name: 'Re-evaluating…' }),
    ).toBeDisabled();
    rerender(panel(deck(), { jobs: [job({ status: 'queued' })] }));
    expect(
      screen.getByRole('button', { name: 'Re-evaluating…' }),
    ).toBeDisabled();
    // Paused by the daily token cap: still coming.
    rerender(panel(deck(), { jobs: [job({ status: 'paused' })] }));
    expect(
      screen.getByRole('button', { name: 'Re-evaluating…' }),
    ).toBeDisabled();
    rerender(
      panel(deck(), {
        jobs: [job({ status: 'running', source: 'sources/x.md' })],
      }),
    );
    expect(
      screen.getByRole('button', { name: 'Re-evaluate 1 picture' }),
    ).toBeEnabled();
  });

  it('on a brain whose skills are older than v6 there is no Re-evaluate, only a note to update them', () => {
    fake();
    render(panel(deck(), { skillsReady: false }));
    expect(
      screen.queryByRole('button', { name: /Re-evaluat/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Update skills to re-evaluate')).toHaveClass(
      'muted',
    );
  });

  it('Fine, I know accepts that drop by its where', async () => {
    const a = fake();
    render(panel(deck()));
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Fine, I know' })[0],
    );
    expect(
      a.calls
        .filter((c) => c.channel === 'brain:acceptDrop')
        .map((c) => c.args),
    ).toEqual([['b1', SOURCE, 'Slide 9, picture 2']]);
    expect(a.tracked).toContainEqual({
      type: 'event',
      name: 'brain.screen.action',
      props: { action: 'accept-drop' },
    });
  });

  it('an accepted drop is tagged accepted, without Fine, I know', () => {
    fake();
    render(
      panel(
        data([
          picture({
            status: 'accepted',
            path: null,
            reason: 'EMF converts on Windows only',
            where: 'Slide 9, picture 2',
          }),
        ]),
      ),
    );
    expect(
      screen.getByText('accepted', { selector: '.tag' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Fine, I know' }),
    ).not.toBeInTheDocument();
  });
});

describe('AddedPictures', () => {
  const pictures = (rows: PictureRow[]) => () => data(rows);
  const gaps = [
    ...Array.from({ length: 13 }, () =>
      picture({ status: 'described', pages: ['wiki/a.md'] }),
    ),
    picture({ status: 'missing' }),
    picture({ status: 'dropped', path: null, where: 'Slide 9, picture 2' }),
  ];

  it('while the re-evaluation runs: Capture done, how many are interpreted, how many are being re-evaluated', async () => {
    installFakeApi({ 'brain:pictures': pictures(gaps) });
    render(<AddedPictures brainId="b1" path={SOURCE} jobs={[job({})]} />);
    expect(
      await screen.findByText(
        'Capture done · 13 of 14 pictures interpreted · re-evaluating 1 picture…',
      ),
    ).toBeInTheDocument();
  });

  it('when idle and complete: all N pictures interpreted', async () => {
    installFakeApi({
      'brain:pictures': pictures([
        picture({ status: 'described', pages: ['wiki/a.md'] }),
        picture({ status: 'skipped', reason: 'a logo' }),
        picture({ status: 'dropped', path: null, where: 'p1' }),
      ]),
    });
    render(<AddedPictures brainId="b1" path={SOURCE} jobs={[]} />);
    expect(
      await screen.findByText('all 2 pictures interpreted', {
        selector: '.tag-green',
      }),
    ).toBeInTheDocument();
  });

  it('says nothing while the capture itself runs', async () => {
    const a = installFakeApi({ 'brain:pictures': pictures(gaps) });
    const { container } = render(
      <AddedPictures
        brainId="b1"
        path={SOURCE}
        jobs={[job({ kind: 'capture' })]}
      />,
    );
    await waitFor(() =>
      expect(a.calls.some((c) => c.channel === 'brain:pictures')).toBe(true),
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('useSourcePictures', () => {
  function Described() {
    const p = useSourcePictures('b1', SOURCE);
    return <span>{p ? `${p.counts.described} described` : 'none'}</span>;
  }
  const described = (n: number) =>
    data(
      Array.from({ length: n }, () =>
        picture({ status: 'described', pages: ['wiki/a.md'] }),
      ),
    );

  it('keeps the newer answer when an older refetch answers last', async () => {
    const answers: ((p: SourcePicturesData) => void)[] = [];
    const a = installFakeApi({
      'brain:pictures': () =>
        new Promise<SourcePicturesData>((resolve) => answers.push(resolve)),
    });
    render(<Described />);
    await waitFor(() => expect(answers).toHaveLength(1));
    act(() => a.emit('brain:changed', { brainId: 'b1' }));
    await waitFor(() => expect(answers).toHaveLength(2));
    await act(async () => answers[1](described(2)));
    await act(async () => answers[0](described(1)));
    expect(screen.getByText('2 described')).toBeInTheDocument();
  });

  it('keeps the last good answer when a refetch fails', async () => {
    let fail = false;
    const a = installFakeApi({
      'brain:pictures': () => {
        if (fail) throw new Error('gone');
        return described(3);
      },
    });
    render(<Described />);
    expect(await screen.findByText('3 described')).toBeInTheDocument();
    fail = true;
    act(() => a.emit('brain:changed', { brainId: 'b1' }));
    await waitFor(() =>
      expect(
        a.calls.filter((c) => c.channel === 'brain:pictures'),
      ).toHaveLength(2),
    );
    expect(screen.getByText('3 described')).toBeInTheDocument();
  });
});

describe('AddedPictures with nothing Claude could look at', () => {
  it('says how many never reached the agent', async () => {
    installFakeApi({
      'brain:pictures': () =>
        data([
          picture({ status: 'dropped', path: null, where: 'p1' }),
          picture({ status: 'dropped', path: null, where: 'p2' }),
        ]),
    });
    render(<AddedPictures brainId="b1" path={SOURCE} jobs={[]} />);
    expect(
      await screen.findByText('2 pictures never reached the agent'),
    ).toBeInTheDocument();
  });
});
