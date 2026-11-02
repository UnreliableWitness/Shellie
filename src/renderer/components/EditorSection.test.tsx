// src/renderer/components/EditorSection.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AppSettings } from '../../shared/usage';
import { defaultSettings } from '../../shared/usage';
import { useStore } from '../store';
import { installFakeApi } from '../test-helpers/fakeApi';
import { EditorSection } from './EditorSection';

describe('EditorSection', () => {
  it('saves the default editor, keeping the other settings; repo rows live under Repository', async () => {
    useStore.setState({
      repos: [
        {
          id: 'r1',
          name: 'web',
          path: '/x',
          baseBranch: 'main',
          connectionId: null,
          configFound: true,
          discovered: false,
          overrides: {},
        } as never,
      ],
    });
    let current: AppSettings = { ...defaultSettings(), idleMinutes: 9 };
    installFakeApi({
      'editor:installed': () => [
        { id: 'vscode', label: 'VS Code' },
        { id: 'visualstudio', label: 'Visual Studio' },
      ],
      'settings:get': () => current,
      'settings:save': (s) => (current = s),
    });
    render(<EditorSection />);
    fireEvent.change(await screen.findByLabelText('Default editor'), {
      target: { value: 'visualstudio' },
    });
    await waitFor(() => expect(current.editor.default).toBe('visualstudio'));
    expect(screen.queryByLabelText('Editor for web')).toBeNull();
    expect(current.idleMinutes).toBe(9);
  });
});
