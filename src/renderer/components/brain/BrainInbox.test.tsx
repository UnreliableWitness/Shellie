import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { brainJob, brainView } from '../../test-helpers/brainFixture';
import { BrainInbox } from './BrainInbox';

const file = (name: string, path = `/dl/${name}`) =>
  Object.assign(new File(['x'], name), { path });
const def = { id: 'bt1', kind: 'claude' as const, label: 'Brain' };

beforeEach(() =>
  useStore.setState({ notices: [], screen: { kind: 'brain', brainId: 'b1' } }),
);

describe('BrainInbox', () => {
  it('dropping files calls brain:addFiles with guessed types', async () => {
    const a = installFakeApi({
      'brain:addFiles': () => [
        { ok: true, path: 'sources/x', images: 0, warnings: [], contents: '' },
        { ok: true, path: 'sources/y', images: 0, warnings: [], contents: '' },
        { ok: true, path: 'sources/z', images: 0, warnings: [], contents: '' },
      ],
    });
    render(<BrainInbox brain={brainView()} />);
    fireEvent.drop(screen.getByText(/Drop files here/), {
      dataTransfer: {
        files: [file('kickoff.vtt'), file('plan.pptx'), file('sow.docx')],
      },
    });
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:addFiles',
        args: [
          'b1',
          [
            { path: '/dl/kickoff.vtt', type: 'transcript' },
            { path: '/dl/plan.pptx', type: 'deck' },
            { path: '/dl/sow.docx', type: 'doc' },
          ],
        ],
      }),
    );
  });

  it('says what a drop added, with pictures and what conversion left out', async () => {
    installFakeApi({
      'brain:addFiles': () => [
        {
          ok: true,
          path: 'sources/2026-11-04-plan.md',
          images: 3,
          warnings: ['1 picture in formats Claude cannot view (emf)'],
          contents: '12 slides · 3 pictures: Kick-off',
        },
        {
          ok: true,
          path: 'sources/2026-11-04-sow.md',
          images: 0,
          warnings: [],
          contents: '',
        },
      ],
    });
    render(<BrainInbox brain={brainView()} />);
    fireEvent.drop(screen.getByText(/Drop files here/), {
      dataTransfer: { files: [file('plan.pptx'), file('sow.docx')] },
    });
    const added = await screen.findByLabelText('Added');
    expect(added).toHaveTextContent(
      'Added 2026-11-04-plan.md · 12 slides · 3 pictures: Kick-off',
    );
    expect(added).toHaveTextContent(
      '2026-11-04-plan.md: 1 picture in formats Claude cannot view (emf)',
    );
    expect(added).toHaveTextContent('Added 2026-11-04-sow.md');
    expect(added).not.toHaveTextContent('sow.md ·');
  });

  it('shows what a drop could not add', async () => {
    installFakeApi({
      'brain:addFiles': () => [
        {
          ok: false,
          reason: 'duplicate',
          message: 'kickoff.vtt is already in the brain',
        },
      ],
    });
    render(<BrainInbox brain={brainView()} />);
    fireEvent.drop(screen.getByText(/Drop files here/), {
      dataTransfer: { files: [file('kickoff.vtt')] },
    });
    expect(await screen.findByText(/already in the brain/)).toBeInTheDocument();
  });

  it('pasting text sends title, text and type to brain:addText', async () => {
    const a = installFakeApi({
      'brain:addText': () => ({
        ok: true,
        path: 'sources/n.md',
        images: 0,
        warnings: [],
        contents: '',
      }),
    });
    render(<BrainInbox brain={brainView()} />);
    await userEvent.type(screen.getByLabelText('Title'), 'Call notes');
    await userEvent.type(screen.getByLabelText('Text'), 'we agreed on X');
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'note');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:addText',
        args: ['b1', 'we agreed on X', 'Call notes', 'note'],
      }),
    );
    expect(screen.getByLabelText('Text')).toHaveValue('');
  });

  it('lists jobs newest first with Retry and Continue in terminal', async () => {
    const a = installFakeApi({
      'brain:run': () => brainJob({ id: 'j3', status: 'queued' }),
      'brain:terminal': () => def,
    });
    const brain = brainView({
      jobs: [
        brainJob({
          id: 'j1',
          source: 'sources/old.vtt',
          startedAt: '2026-11-01T10:00:00.000Z',
        }),
        brainJob({
          id: 'j2',
          source: 'sources/new.vtt',
          startedAt: '2026-11-02T10:00:00.000Z',
        }),
      ],
    });
    render(<BrainInbox brain={brain} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('new.vtt');
    expect(rows[1]).toHaveTextContent('old.vtt');
    expect(rows[0]).toHaveTextContent('claude exited 1');
    await userEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]);
    expect(a.calls).toContainEqual({
      channel: 'brain:run',
      args: ['b1', 'capture', 'sources/new.vtt'],
    });
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Continue in terminal' })[0],
    );
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:terminal',
        args: ['b1', 's-1'],
      }),
    );
  });

  it('lists uncaptured sources (not the wiki mirror) with Capture', async () => {
    const a = installFakeApi({
      'brain:sources': () => [
        {
          path: 'sources/2026-11-02-sow.md',
          type: 'sow',
          ingestedAt: '2026-11-02T10:00:00.000Z',
          captured: false,
          original: null,
          contents: null,
        },
        {
          path: 'sources/2026-11-01-kickoff.md',
          type: 'transcript',
          ingestedAt: '2026-11-01T10:00:00.000Z',
          captured: true,
          original: null,
          contents: null,
        },
        {
          path: 'sources/wiki/Home.md',
          type: 'wiki-page',
          ingestedAt: '2026-11-01T10:00:00.000Z',
          captured: false,
          original: null,
          contents: null,
        },
      ],
      'brain:run': () => brainJob({ status: 'queued' }),
    });
    render(<BrainInbox brain={brainView()} />);
    const list = await screen.findByRole('list', {
      name: 'Sources to capture',
    });
    expect(list).toHaveTextContent('sources/2026-11-02-sow.md');
    expect(list).not.toHaveTextContent('kickoff');
    expect(list).not.toHaveTextContent('Home.md');
    await userEvent.click(
      screen.getByRole('button', { name: 'Capture sources/2026-11-02-sow.md' }),
    );
    expect(a.calls).toContainEqual({
      channel: 'brain:run',
      args: ['b1', 'capture', 'sources/2026-11-02-sow.md'],
    });
  });

  it('offers no Retry on a paused job and shows takeaways of a done one', async () => {
    installFakeApi({});
    const brain = brainView({
      jobs: [
        brainJob({ id: 'p', status: 'paused', error: null }),
        brainJob({
          id: 'd',
          status: 'done',
          error: null,
          result: '- The SOW fixes the delivery date',
        }),
      ],
    });
    render(<BrainInbox brain={brain} />);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByText('Takeaways')).toBeInTheDocument();
    expect(
      screen.getByText('- The SOW fixes the delivery date'),
    ).toBeInTheDocument();
  });
});
