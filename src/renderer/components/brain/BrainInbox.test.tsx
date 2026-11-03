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
        { ok: true, path: 'sources/x' },
        { ok: true, path: 'sources/y' },
        { ok: true, path: 'sources/z' },
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
      'brain:addText': () => ({ ok: true, path: 'sources/n.md' }),
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
});
