// src/renderer/components/OpenInEditor.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { allCommands } from '../commands/registry';
import { installFakeApi } from '../test-helpers/fakeApi';
import { OpenInEditor } from './OpenInEditor';

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
const openMenu = async () =>
  fireEvent.click(
    await screen.findByRole('button', { name: 'Open in an editor' }),
  );

describe('OpenInEditor', () => {
  const offered = () =>
    allCommands()
      .filter((c) => c.id.startsWith('task.editor') || c.id === 'task.folder')
      .map((c) => c.title);

  it('without buttons, offers the editors, the solutions and the folder as commands', async () => {
    const { calls } = installFakeApi(
      options({ solutions: ['A.sln', 'tools/B.sln'] }),
    );
    const { container } = render(<OpenInEditor taskId="t1" headless />);
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
  });

  it('without an editor, the command leads to Settings instead of opening nothing', async () => {
    const { calls } = installFakeApi(options({ editors: [], chosen: null }));
    render(<OpenInEditor taskId="t1" headless />);
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
    const { rerender } = render(<OpenInEditor taskId="t1" headless />);
    await waitFor(() =>
      expect(sent(calls, 'editor:options')).toEqual([['t1', undefined, false]]),
    );
    rerender(<OpenInEditor taskId="t1" headless refresh={1} />);
    await waitFor(() =>
      expect(sent(calls, 'editor:options')).toEqual([
        ['t1', undefined, false],
        ['t1', undefined, true],
      ]),
    );
  });

  it('opens the task folder in the file manager (#73)', async () => {
    const { calls } = installFakeApi(options());
    render(<OpenInEditor taskId="t1" workspaceId="w2" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open folder' }));
    expect(sent(calls, 'editor:showFolder')).toEqual([['t1', 'w2']]);
    expect(sent(calls, 'editor:openFolder')).toEqual([]);
  });

  it('lists the chosen editor first in its menu and opens the folder with it', async () => {
    const { calls } = installFakeApi(options());
    render(<OpenInEditor taskId="t1" />);
    await openMenu();
    const items = screen.getAllByRole('menuitem').map((m) => m.textContent);
    expect(items).toEqual(['Open in Visual Studio', 'Open in VS Code']);
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Open in Visual Studio' }),
    );
    expect(sent(calls, 'editor:openFolder')).toEqual([['t1', undefined, {}]]);
  });

  it('offers the other editors and the solutions in its menu', async () => {
    const { calls } = installFakeApi(
      options({ solutions: ['A.sln', 'tools/B.sln'] }),
    );
    render(<OpenInEditor taskId="t1" workspaceId="w2" />);
    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open B.sln' }));
    await openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in VS Code' }));
    expect(sent(calls, 'editor:openFolder')).toEqual([
      ['t1', 'w2', { editorId: 'visualstudio', solution: 'tools/B.sln' }],
      ['t1', 'w2', { editorId: 'vscode' }],
    ]);
  });

  it('points to Settings when no editor is found, and still opens the folder', async () => {
    const { calls } = installFakeApi(options({ editors: [], chosen: null }));
    render(<OpenInEditor taskId="t1" />);
    await openMenu();
    expect(
      screen.getByRole('menuitem', {
        name: 'No editor found: choose one in Settings',
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open folder' }));
    expect(sent(calls, 'editor:showFolder')).toEqual([['t1', undefined]]);
  });

  it('loads the options again when its menu opens', async () => {
    let chosen: 'vscode' | 'visualstudio' = 'vscode';
    installFakeApi({
      'editor:options': () => ({
        editors: [code, vs],
        chosen,
        solutions: [],
        solution: null,
      }),
    });
    render(<OpenInEditor taskId="t1" />);
    await openMenu();
    expect(screen.getAllByRole('menuitem')[0].textContent).toBe(
      'Open in VS Code',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open in an editor' }));
    chosen = 'visualstudio';
    await openMenu();
    await waitFor(() =>
      expect(screen.getAllByRole('menuitem')[0].textContent).toBe(
        'Open in Visual Studio',
      ),
    );
  });

  // #94: Visual Studio must be on offer whenever it is installed, also when VS Code is the choice.
  it('lists every installed editor and Visual Studio’s solutions when VS Code is chosen', async () => {
    const { calls } = installFakeApi(
      options({ chosen: 'vscode', solutions: ['A.sln', 'src/Dxp/Dxp.sln'] }),
    );
    render(<OpenInEditor taskId="t1" />);
    await openMenu();
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Open in VS Code',
      'Open in Visual Studio',
      'Open A.slnA.sln',
      'Open Dxp.slnsrc/Dxp/Dxp.sln',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open Dxp.sln' }));
    expect(sent(calls, 'editor:openFolder')).toEqual([
      [
        't1',
        undefined,
        { editorId: 'visualstudio', solution: 'src/Dxp/Dxp.sln' },
      ],
    ]);
  });

  it('looks for editors again each time its menu opens (#94)', async () => {
    const { calls } = installFakeApi(options());
    render(<OpenInEditor taskId="t1" workspaceId="w2" />);
    await openMenu();
    await waitFor(() =>
      expect(sent(calls, 'editor:options')).toContainEqual(['t1', 'w2', true]),
    );
    // The first load (no menu yet) uses the cached detection.
    expect(sent(calls, 'editor:options')[0]).toEqual(['t1', 'w2', false]);
  });
});
