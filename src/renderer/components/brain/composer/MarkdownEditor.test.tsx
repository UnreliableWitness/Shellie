import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownEditor, type EditorView } from './MarkdownEditor';

const load = vi.hoisted(() => ({
  next: () => new Promise<never>(() => undefined) as Promise<never>,
}));
vi.mock('../../../review/loadMonaco', () => ({
  loadMonaco: () => load.next(),
}));

afterEach(() => {
  cleanup();
  load.next = () => new Promise<never>(() => undefined);
});

function Harness({
  initial = '',
  onSubmit = () => undefined,
  onChange,
}: {
  initial?: string;
  onSubmit?: () => void;
  onChange?: (v: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const [view, setView] = useState<EditorView>('write');
  return (
    <MarkdownEditor
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
      onSubmit={onSubmit}
      placeholder="Write or paste here"
      view={view}
      onView={setView}
      label="Text"
    />
  );
}

const text = () =>
  screen.getByRole('textbox', { name: 'Text' }) as HTMLTextAreaElement;

const paste = (el: Element, data: Record<string, string>) =>
  fireEvent.paste(el, {
    clipboardData: {
      types: Object.keys(data),
      getData: (t: string) => data[t] ?? '',
    },
  });

describe('MarkdownEditor', () => {
  it('is a text box until the editor has loaded, and Ctrl or Cmd+Enter submits', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    render(<Harness onChange={onChange} onSubmit={onSubmit} />);
    fireEvent.change(text(), { target: { value: '# Hi' } });
    expect(onChange).toHaveBeenLastCalledWith('# Hi');
    fireEvent.keyDown(text(), { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(text(), { key: 'Enter', metaKey: true });
    fireEvent.keyDown(text(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('formats the selection from the toolbar', () => {
    const onChange = vi.fn();
    render(<Harness initial="ab cd" onChange={onChange} />);
    text().setSelectionRange(3, 5);
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    expect(onChange).toHaveBeenLastCalledWith('ab **cd**');
    expect(
      screen.getByRole('toolbar', { name: 'Formatting' }),
    ).toBeInTheDocument();
  });

  it('pastes rich text as Markdown, and Paste as plain text puts the plain text back', () => {
    const onChange = vi.fn();
    render(<Harness initial="x " onChange={onChange} />);
    text().setSelectionRange(2, 2);
    paste(text(), {
      'text/html': '<ul><li>a</li><li><b>b</b></li></ul>',
      'text/plain': 'a\nb',
    });
    expect(onChange).toHaveBeenLastCalledWith('x - a\n- **b**');
    expect(screen.getByText('Pasted as Markdown')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Paste as plain text' }),
    );
    expect(onChange).toHaveBeenLastCalledWith('x a\nb');
    expect(screen.queryByText('Pasted as Markdown')).toBeNull();
  });

  it('leaves HTML without formatting, and a copy from a code editor, to the text box', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    paste(text(), {
      'text/html':
        '<html><body><p class="MsoNormal"><span>file_name 5*3 [draft]</span></p></body></html>',
      'text/plain': 'file_name 5*3 [draft]',
    });
    paste(text(), {
      'text/html': '<div><b>## Heading</b></div>',
      'text/plain': '## Heading',
      'vscode-editor-data': '{}',
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText('Pasted as Markdown')).toBeNull();
  });

  it('forgets Paste as plain text once the text changed after the paste', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    paste(text(), { 'text/html': '<ul><li>a</li></ul>', 'text/plain': 'a' });
    expect(screen.getByText('Pasted as Markdown')).toBeInTheDocument();
    fireEvent.change(text(), { target: { value: 'typed above\n- a' } });
    expect(
      screen.queryByRole('button', { name: 'Paste as plain text' }),
    ).toBeNull();
  });

  it('takes the cursor when asked to, at the end of the text', () => {
    render(
      <MarkdownEditor
        value="abc"
        onChange={() => undefined}
        onSubmit={() => undefined}
        placeholder=""
        view="write"
        onView={() => undefined}
        label="Text"
        autoFocus
      />,
    );
    expect(document.activeElement).toBe(text());
    expect(text().selectionStart).toBe(3);
  });

  it('leaves a plain-text paste to the text box', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    paste(text(), { 'text/plain': 'just text' });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText('Pasted as Markdown')).toBeNull();
  });

  it('Preview renders the Markdown and hides the text box; Split shows both', () => {
    render(<Harness initial="# Hi" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(screen.getByRole('heading', { name: 'Hi' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Text' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Split' }));
    expect(screen.getByRole('heading', { name: 'Hi' })).toBeInTheDocument();
    expect(text()).toBeInTheDocument();
  });

  it('stays a working text box when the editor fails to load', async () => {
    load.next = () => Promise.reject(new Error('chunk failed'));
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.change(text(), { target: { value: 'still works' } });
    expect(onChange).toHaveBeenLastCalledWith('still works');
  });
});
