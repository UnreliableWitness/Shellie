// src/renderer/components/EditorCommands.test.tsx
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { allCommands } from '../commands/registry';
import { installFakeApi } from '../test-helpers/fakeApi';
import { EditorCommands } from './EditorCommands';

const vs = { id: 'visualstudio', label: 'Visual Studio' } as const;
const code = { id: 'vscode', label: 'VS Code' } as const;
const sent = (calls: { channel: string; args: unknown[] }[], channel: string) =>
  calls.filter((c) => c.channel === channel).map((c) => c.args);
const options = (
  o: Partial<{
    editors: (typeof vs | typeof code)[];
    chosen: 'vscode' | 'visualstudio' | null;
    solutions: string[];
  }> = {},
) => ({
  'editor:options': () => ({
    editors: [code, vs],
    chosen: 'visualstudio' as 'vscode' | 'visualstudio' | null,
    solutions: [] as string[],
    solution: null,
    ...o,
  }),
});
describe('EditorCommands', () => {
  const offered = () =>
    allCommands()
      .filter((c) => c.id.startsWith('task.editor') || c.id === 'task.folder')
      .map((c) => c.title);

  it('renders nothing and offers the editors, the solutions and the folder as commands', async () => {
    const { calls } = installFakeApi(
      options({ solutions: ['A.sln', 'tools/B.sln'] }),
    );
    const { container } = render(<EditorCommands taskId="t1" />);
    expect(container).toBeEmptyDOMElement();
    await waitFor(() =>
      expect(offered()).toEqual([
        'Open in editor',
        'Open in VS Code',
        'Open A.sln',
        'Open B.sln',
        'Open folder',
      ]),
    );
    allCommands()
      .find((c) => c.title === 'Open B.sln')
      ?.run();
    expect(sent(calls, 'editor:openFolder')).toEqual([
      ['t1', undefined, { editorId: 'visualstudio', solution: 'tools/B.sln' }],
    ]);
    allCommands()
      .find((c) => c.id === 'task.editor')
      ?.run();
    expect(sent(calls, 'editor:openFolder').at(-1)).toEqual([
      't1',
      undefined,
      {},
    ]);
    allCommands()
      .find((c) => c.id === 'task.folder')
      ?.run();
    expect(sent(calls, 'editor:showFolder')).toEqual([['t1']]);
  });

  it('without an editor, the command leads to Settings instead of opening nothing', async () => {
    const { calls } = installFakeApi(options({ editors: [], chosen: null }));
    render(<EditorCommands taskId="t1" />);
    await waitFor(() =>
      expect(offered()).toEqual([
        'No editor found: choose one in Settings',
        'Open folder',
      ]),
    );
    allCommands()
      .find((c) => c.id === 'task.editor')
      ?.run();
    expect(sent(calls, 'editor:openFolder')).toEqual([]);
  });

  it('looks for editors again when asked to (the task menu opened)', async () => {
    const { calls } = installFakeApi(options());
    const { rerender } = render(<EditorCommands taskId="t1" />);
    await waitFor(() =>
      expect(sent(calls, 'editor:options')).toEqual([['t1', undefined, false]]),
    );
    rerender(<EditorCommands taskId="t1" refresh={1} />);
    await waitFor(() =>
      expect(sent(calls, 'editor:options')).toEqual([
        ['t1', undefined, false],
        ['t1', undefined, true],
      ]),
    );
  });
});
