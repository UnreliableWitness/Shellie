import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AddSourceResult } from '../../../shared/brain';
import { useStore } from '../../store';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { brainJob, brainView } from '../../test-helpers/brainFixture';
import { BrainInbox } from './BrainInbox';

const file = (name: string, path = `/dl/${name}`) =>
  Object.assign(new File(['x'], name), { path });
const def = { id: 'bt1', kind: 'claude' as const, label: 'Brain' };

beforeEach(() =>
  useStore.setState({
    notices: [],
    screen: { kind: 'brain', brainId: 'b1' },
    brainPending: {},
  }),
);

describe('BrainInbox', () => {
  it('dropped files wait with guessed types until Add sends them', async () => {
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
    const list = await screen.findByRole('form', { name: 'Files to add' });
    expect(list).toHaveTextContent('kickoff.vtt');
    expect(screen.getByLabelText('Type of kickoff.vtt')).toHaveValue(
      'transcript',
    );
    expect(screen.getByLabelText('Type of plan.pptx')).toHaveValue('deck');
    expect(a.calls.filter((c) => c.channel === 'brain:addFiles')).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Add 3 files' }));
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
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Files to add' })).toBeNull(),
    );
  });

  it('takes a type and a note per file, drops a removed one, and sends them with Enter', async () => {
    const a = installFakeApi({
      'brain:addFiles': () => [
        { ok: true, path: 'sources/x', images: 0, warnings: [], contents: '' },
      ],
    });
    render(<BrainInbox brain={brainView()} />);
    fireEvent.drop(screen.getByText(/Drop files here/), {
      dataTransfer: { files: [file('sow.docx'), file('old.docx')] },
    });
    // The same path dropped again is not listed twice.
    fireEvent.drop(screen.getByText(/Drop files here/), {
      dataTransfer: { files: [file('sow.docx')] },
    });
    expect(await screen.findAllByLabelText(/^Type of /)).toHaveLength(2);
    await userEvent.selectOptions(
      screen.getByLabelText('Type of sow.docx'),
      'sow',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove old.docx' }),
    );
    expect(screen.queryByLabelText('Type of old.docx')).toBeNull();
    await userEvent.type(
      screen.getByLabelText('Note for sow.docx'),
      ' Signed version; supersedes the draft {enter}',
    );
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:addFiles',
        args: [
          'b1',
          [
            {
              path: '/dl/sow.docx',
              type: 'sow',
              note: 'Signed version; supersedes the draft',
            },
          ],
        ],
      }),
    );
  });

  it('keeps waiting files across a remount, keeps files dropped during an add, and reports a file with no path', async () => {
    let answer: (r: AddSourceResult[]) => void = () => undefined;
    const a = installFakeApi({
      'brain:addFiles': () => new Promise((res) => (answer = res)),
    });
    const { unmount } = render(<BrainInbox brain={brainView()} />);
    fireEvent.drop(screen.getByText(/Drop files here/), {
      dataTransfer: { files: [file('a.docx')] },
    });
    await userEvent.type(
      await screen.findByLabelText('Note for a.docx'),
      'first',
    );
    unmount();
    render(<BrainInbox brain={brainView()} />);
    expect(screen.getByLabelText('Note for a.docx')).toHaveValue('first');
    await userEvent.click(screen.getByRole('button', { name: 'Add 1 file' }));
    expect(screen.getByLabelText('Note for a.docx')).toBeDisabled();
    fireEvent.drop(screen.getByText(/Drop files here/), {
      dataTransfer: { files: [file('b.docx'), file('ghost.png', '')] },
    });
    expect(
      await screen.findByText('ghost.png: not a file on disk'),
    ).toBeInTheDocument();
    answer([
      { ok: true, path: 'sources/a.md', images: 0, warnings: [], contents: '' },
    ]);
    await waitFor(() =>
      expect(screen.queryByLabelText('Note for a.docx')).toBeNull(),
    );
    expect(screen.getByLabelText('Note for b.docx')).toBeInTheDocument();
    expect(a.calls.filter((c) => c.channel === 'brain:addFiles')).toHaveLength(
      1,
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
    await userEvent.click(
      await screen.findByRole('button', { name: 'Add 2 files' }),
    );
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
    await userEvent.click(
      await screen.findByRole('button', { name: 'Add 1 file' }),
    );
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

  it('sends the note with pasted text and clears it', async () => {
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
    await userEvent.type(screen.getByLabelText('Text'), 'we agreed on X');
    await userEvent.type(screen.getByLabelText('Note'), ' From memory, check ');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(a.calls).toContainEqual({
        channel: 'brain:addText',
        args: ['b1', 'we agreed on X', '', 'note', 'From memory, check'],
      }),
    );
    expect(screen.getByLabelText('Note')).toHaveValue('');
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
          note: null,
        },
        {
          path: 'sources/2026-11-01-kickoff.md',
          type: 'transcript',
          ingestedAt: '2026-11-01T10:00:00.000Z',
          captured: true,
          original: null,
          contents: null,
          note: null,
        },
        {
          path: 'sources/wiki/Home.md',
          type: 'wiki-page',
          ingestedAt: '2026-11-01T10:00:00.000Z',
          captured: false,
          original: null,
          contents: null,
          note: null,
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
