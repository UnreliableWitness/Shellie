import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { KeyValueEditor } from './KeyValueEditor';
import { ListEditor } from './ListEditor';
import { SettingRow, SettingsCategory } from './SettingRow';
import { matchesQuery, SettingsSearchProvider } from './settingsSearch';
import { useScrollSpy } from './useScrollSpy';

function List({ start }: { start: string[] }) {
  const [items, setItems] = useState(start);
  return (
    <>
      <ListEditor label="Copy" items={items} onChange={setItems} />
      <output data-testid="out">{JSON.stringify(items)}</output>
    </>
  );
}

const out = () => screen.getByTestId('out').textContent;

describe('SettingRow', () => {
  it('shows Modified by you and Reset calls onReset', () => {
    const onReset = vi.fn();
    const { container } = render(
      <SettingRow
        id="a"
        category="Repo"
        title="Base branch"
        modified
        source="override"
        onReset={onReset}
      >
        <input />
      </SettingRow>,
    );
    expect(screen.getByText('Modified by you')).toBeTruthy();
    expect(container.querySelector('[data-modified]')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('More actions for Base branch'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset' }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it('hides when the query does not match', () => {
    render(
      <SettingsSearchProvider query="zebra">
        <SettingsCategory id="c" title="C">
          <SettingRow id="a" category="Repo" title="Base branch">
            <input />
          </SettingRow>
        </SettingsCategory>
      </SettingsSearchProvider>,
    );
    expect(screen.queryByText('Base branch')).toBeNull();
    expect(document.getElementById('c')?.hidden).toBe(true);
  });
});

describe('search', () => {
  it('terms all have to match', () => {
    expect(matchesQuery('base repo', ['Base branch', 'Repo'])).toBe(true);
    expect(matchesQuery('base zebra', ['Base branch', 'Repo'])).toBe(false);
    expect(matchesQuery('BASE', ['base branch'])).toBe(true);
  });
});

describe('ListEditor', () => {
  it('adds, edits, removes and reorders', () => {
    render(<List start={['a', 'b']} />);
    fireEvent.click(screen.getByText('Add item'));
    const add = screen.getByLabelText('New Copy item');
    fireEvent.change(add, { target: { value: 'c' } });
    fireEvent.keyDown(add, { key: 'Enter' });
    expect(out()).toBe('["a","b","c"]');
    const first = screen.getByLabelText('Copy item 1');
    fireEvent.change(first, { target: { value: 'z' } });
    fireEvent.blur(first);
    expect(out()).toBe('["z","b","c"]');
    fireEvent.click(screen.getByLabelText('Move c up'));
    expect(out()).toBe('["z","c","b"]');
    fireEvent.click(screen.getByLabelText('Move z down'));
    expect(out()).toBe('["c","z","b"]');
    fireEvent.click(screen.getByLabelText('Remove z'));
    expect(out()).toBe('["c","b"]');
    const second = screen.getByLabelText('Copy item 2');
    fireEvent.change(second, { target: { value: '  ' } });
    fireEvent.keyDown(second, { key: 'Enter' });
    expect(out()).toBe('["c"]');
  });

  it('Escape cancels', () => {
    render(<List start={['a']} />);
    const input = screen.getByLabelText('Copy item 1') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'changed' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('a');
    expect(out()).toBe('["a"]');
  });
});

describe('ListEditor saving', () => {
  it('commits once on Enter then blur', async () => {
    // The parent saves asynchronously, so the items have not changed yet when the field loses focus.
    const onChange = vi.fn();
    render(<ListEditor label="Copy" items={['a']} onChange={onChange} />);
    const input = screen.getByLabelText('Copy item 1');
    fireEvent.change(input, { target: { value: 'z' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => {});
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(['z']);
  });
});

describe('KeyValueEditor', () => {
  it('refuses a duplicate key', () => {
    const onChange = vi.fn();
    render(
      <KeyValueEditor
        label="Env"
        value={{ A: '1', B: '2' }}
        onChange={onChange}
        keyLabel="Name"
        valueLabel="Value"
      />,
    );
    fireEvent.click(screen.getByText('Add item'));
    const keys = screen.getAllByLabelText('Name');
    const k = keys[keys.length - 1];
    fireEvent.change(k, { target: { value: 'A' } });
    fireEvent.keyDown(k, { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toContain('already used');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(k, { target: { value: 'C' } });
    fireEvent.keyDown(k, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith({ A: '1', B: '2', C: '' });
  });
});

function Spy() {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  const active = useScrollSpy(ref, ['a', 'b'], shown);
  return (
    <>
      <button type="button" onClick={() => setShown(true)}>
        show
      </button>
      <output data-testid="active">{active}</output>
      {shown && (
        <div ref={ref}>
          <div id="a" />
          <div id="b" />
        </div>
      )}
    </>
  );
}

describe('useScrollSpy', () => {
  it('binds to a container mounted after the first render', () => {
    render(<Spy />);
    expect(screen.getByTestId('active').textContent).toBe('a');
    fireEvent.click(screen.getByRole('button', { name: 'show' }));
    // jsdom puts every box at 0, so both tops have reached the container's top.
    expect(screen.getByTestId('active').textContent).toBe('b');
  });
});
