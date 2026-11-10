import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddSourceResult, BrainView } from '../../../../shared/brain';
import { useStore } from '../../../store';
import { brainView } from '../../../test-helpers/brainFixture';
import { installFakeApi } from '../../../test-helpers/fakeApi';
import { Composer } from './Composer';
import { useComposer } from './useComposer';

vi.mock('../../../review/loadMonaco', () => ({
  loadMonaco: () => new Promise<never>(() => undefined),
}));

const file = (name: string, body = 'x', bytes?: number) => {
  const f = Object.assign(new File([body], name), { path: `/dl/${name}` });
  if (bytes !== undefined) Object.defineProperty(f, 'size', { value: bytes });
  return f;
};
const ok = (path: string): AddSourceResult => ({
  ok: true,
  path,
  images: 0,
  dropped: 0,
  warnings: [],
  contents: '',
});

function Host({ brain = brainView() }: { brain?: BrainView }) {
  const c = useComposer(brain);
  const [expanded, setExpanded] = useState(true);
  return (
    <Composer
      brain={brain}
      composer={c}
      expanded={expanded}
      onExpand={() => setExpanded(true)}
      onAdded={() => setExpanded(false)}
      dropping={null}
    />
  );
}

const text = () => screen.getByRole('textbox', { name: 'Text' });
const attach = (...files: File[]) =>
  fireEvent.change(screen.getByLabelText('Attach files'), {
    target: { files },
  });
const calls = (a: ReturnType<typeof installFakeApi>, channel: string) =>
  a.calls.filter((c) => c.channel === channel).map((c) => c.args);

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ notices: [], brainDrafts: {} });
});
afterEach(cleanup);

describe('Composer', () => {
  it('adds text and two files in one press, with one note for all of them', async () => {
    const a = installFakeApi({
      'brain:addText': () => ok('sources/steerco.md'),
      'brain:addFiles': () => [ok('sources/a.pdf'), ok('sources/b.docx')],
    });
    render(<Host />);
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    fireEvent.change(text(), { target: { value: '# Steerco\n\nx' } });
    attach(file('a.pdf'), file('b.docx'));
    await screen.findByText('b.docx');
    fireEvent.change(screen.getByLabelText('Note for the agent'), {
      target: { value: 'Context' },
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Add text and 2 files' }),
    );
    await waitFor(() =>
      expect(calls(a, 'brain:addFiles')).toEqual([
        [
          'b1',
          [
            { path: '/dl/a.pdf', type: 'doc', note: 'Context' },
            { path: '/dl/b.docx', type: 'doc', note: 'Context' },
          ],
        ],
      ]),
    );
    expect(calls(a, 'brain:addText')).toEqual([
      ['b1', '# Steerco\n\nx', 'Steerco', 'note', 'Context'],
    ]);
    expect(
      await screen.findByText(/Added Steerco and 2 files\. Capturing now/),
    ).toBeInTheDocument();
    expect(useStore.getState().brainDrafts.b1.files).toEqual([]);
  });

  it('an Own note replaces the shared note for that file only', async () => {
    const a = installFakeApi({
      'brain:addFiles': () => [ok('sources/a.pdf'), ok('sources/b.pdf')],
    });
    render(<Host />);
    attach(file('a.pdf'), file('b.pdf'));
    await userEvent.click(
      within(await screen.findByRole('group', { name: 'a.pdf' })).getByRole(
        'button',
        { name: 'Own note' },
      ),
    );
    fireEvent.change(screen.getByLabelText('Own note for a.pdf'), {
      target: { value: 'Only section 4' },
    });
    fireEvent.change(screen.getByLabelText('Note for the agent'), {
      target: { value: 'Shared' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Add 2 files' }));
    await waitFor(() =>
      expect(calls(a, 'brain:addFiles')[0]?.[1]).toEqual([
        { path: '/dl/a.pdf', type: 'doc', note: 'Only section 4' },
        { path: '/dl/b.pdf', type: 'doc', note: 'Shared' },
      ]),
    );
  });

  it('Capture with sends the model for this add only, then is back on the brain default', async () => {
    const a = installFakeApi({
      'brain:addText': () => ok('sources/t.md'),
      'brain:addFiles': () => [ok('sources/a.pdf')],
    });
    render(<Host />);
    const picker = screen.getByRole('combobox', { name: 'Capture with' });
    expect(picker).toHaveDisplayValue('Sonnet (brain default)');
    fireEvent.change(text(), { target: { value: 'notes' } });
    attach(file('a.pdf'));
    await screen.findByText('a.pdf');
    fireEvent.change(picker, { target: { value: 'opus' } });
    await userEvent.click(
      screen.getByRole('button', { name: 'Add text and 1 file' }),
    );
    await waitFor(() =>
      expect(calls(a, 'brain:addFiles')).toEqual([
        ['b1', [{ path: '/dl/a.pdf', type: 'doc' }], 'opus'],
      ]),
    );
    expect(calls(a, 'brain:addText')).toEqual([
      ['b1', 'notes', 'notes', 'note', undefined, 'opus'],
    ]);
    await waitFor(() =>
      expect(useStore.getState().brainDrafts.b1.model).toBeNull(),
    );
    // The composer folds after the add; used again, it is back on the brain's model.
    fireEvent.focus(screen.getByRole('textbox', { name: 'Write or paste' }));
    expect(
      screen.getByRole('combobox', { name: 'Capture with' }),
    ).toHaveDisplayValue('Sonnet (brain default)');
  });

  it("an OpenCode brain offers OpenCode's models, the brain's first, and no hint", async () => {
    installFakeApi({
      'agents:opencodeModels': () => ['openai/gpt-5', 'opencode/big-pickle'],
    });
    render(
      <Host
        brain={brainView({
          options: {
            ...brainView().options,
            agent: 'opencode',
            opencodeModel: 'opencode/big-pickle',
          },
        })}
      />,
    );
    const picker = screen.getByRole('combobox', { name: 'Capture with' });
    await waitFor(() =>
      expect(
        within(picker)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['opencode/big-pickle (brain default)', 'openai/gpt-5']),
    );
    attach(file('deck.pptx'));
    await screen.findByText('deck.pptx');
    expect(screen.queryByText(/may capture/)).toBeNull();
  });

  it('suggests Opus for a deck, never switches by itself, and the hint goes on Opus', async () => {
    installFakeApi();
    render(<Host />);
    attach(file('deck.pptx'));
    expect(
      await screen.findByText('Opus may capture the deck better'),
    ).toBeInTheDocument();
    const picker = screen.getByRole('combobox', { name: 'Capture with' });
    expect(picker).toHaveDisplayValue('Sonnet (brain default)');
    expect(screen.getByLabelText('Type of deck.pptx')).toHaveValue('deck');
    fireEvent.change(picker, { target: { value: 'opus' } });
    expect(screen.queryByText(/may capture/)).toBeNull();
  });

  it('keeps only what failed, with its problem, after a partial failure', async () => {
    installFakeApi({
      'brain:addFiles': () => [
        ok('sources/a.pdf'),
        {
          ok: false,
          reason: 'error',
          message: 'b.pdf: not a file on disk',
        } as AddSourceResult,
      ],
    });
    render(<Host />);
    attach(file('a.pdf'), file('b.pdf'));
    await screen.findByText('b.pdf');
    fireEvent.change(screen.getByLabelText('Note for the agent'), {
      target: { value: 'Shared' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Add 2 files' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'b.pdf: not a file on disk',
    );
    expect(screen.queryByText('a.pdf')).toBeNull();
    expect(screen.getByText('b.pdf')).toBeInTheDocument();
    expect(screen.getByLabelText('Note for the agent')).toHaveValue('Shared');
    // What did go in is said, and the composer stays open on what did not.
    expect(
      screen.getByText(/^Added 1 file\. Capturing now/),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Text' })).toBeInTheDocument();
  });

  it('after a partial add the model is back on the brain default, and a refusal names its file', async () => {
    installFakeApi({
      'brain:addFiles': () => [
        ok('sources/a.pdf'),
        { ok: false, reason: 'error', message: 'Not a valid .pdf file' },
      ],
    });
    render(<Host />);
    attach(file('a.pdf'), file('b.pdf'));
    await screen.findByText('b.pdf');
    fireEvent.change(screen.getByRole('combobox', { name: 'Capture with' }), {
      target: { value: 'opus' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Add 2 files' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'b.pdf: Not a valid .pdf file',
    );
    expect(
      screen.getByRole('combobox', { name: 'Capture with' }),
    ).toHaveDisplayValue('Sonnet (brain default)');
  });

  it('a Markdown file opens in the empty editor; the next one is attached', async () => {
    installFakeApi();
    render(<Host />);
    attach(file('notes.md', '# Hi'), file('more.md', '# More'));
    await waitFor(() => expect(text()).toHaveValue('# Hi'));
    expect(screen.getByLabelText('Title')).toHaveValue('notes');
    expect(screen.getByLabelText('Text goes in as')).toHaveValue('doc');
    expect(screen.getByRole('group', { name: 'more.md' })).toBeInTheDocument();
  });

  it('asks before discarding a long draft, and Keep keeps it', async () => {
    installFakeApi();
    render(<Host />);
    fireEvent.change(text(), { target: { value: 'word '.repeat(30) } });
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByText('Discard this draft?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(text()).toHaveValue('word '.repeat(30));
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await userEvent.click(
      screen.getByRole('button', { name: 'Discard draft' }),
    );
    expect(text()).toHaveValue('');
  });

  it('names no agent outside the model choice', () => {
    installFakeApi();
    const { container } = render(<Host />);
    const picker = screen.getByRole('combobox', { name: 'Capture with' });
    picker.remove();
    expect(container.textContent).not.toMatch(/claude/i);
  });
});
