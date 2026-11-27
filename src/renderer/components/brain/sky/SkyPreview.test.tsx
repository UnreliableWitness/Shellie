import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainPageRow } from '../../../../shared/brain';
import type { SkyScene } from './SkyScene';
import type { Sky } from './skyLayout';
import { SkyPreview } from './SkyPreview';

/** A scene that draws nothing and remembers what it was told. */
class FakeScene {
  static made: FakeScene[] = [];
  static fail = false;
  calls: string[] = [];
  sky: Sky | null = null;
  constructor() {
    if (FakeScene.fail) throw new Error('Error creating WebGL context');
    FakeScene.made.push(this);
  }
  setSky(sky: Sky, keep?: { camera: boolean }) {
    this.sky = sky;
    this.calls.push(keep?.camera ? 'setSky keep' : 'setSky');
  }
  theme: unknown = null;
  setTheme(theme: unknown) {
    this.theme = theme;
  }
  setRunning(on: boolean) {
    this.calls.push(on ? 'run' : 'pause');
  }
  dispose() {
    this.calls.push('dispose');
  }
}
const loadScene = () =>
  Promise.resolve({ SkyScene: FakeScene as unknown as typeof SkyScene });
const row = (name: string, linkedFrom: string[] = []): BrainPageRow => ({
  path: `wiki/${name.toLowerCase()}.md`,
  title: name,
  summary: '',
  type: 'component',
  lastUpdated: '2020-01-01',
  confidence: null,
  verified: null,
  changedSinceVerified: false,
  sources: [],
  linkedFrom,
  pictures: [],
});
const ROWS = [row('Checkout', ['wiki/cart.md']), row('Cart')];
const NONE = new Set<string>();

beforeEach(() => {
  FakeScene.made = [];
  FakeScene.fail = false;
});

describe('SkyPreview', () => {
  it("shows the brain's stars, runs only while Read is in front, and opens Explore on a click", async () => {
    const onExplore = vi.fn();
    const { rerender, unmount } = render(
      <SkyPreview
        rows={ROWS}
        book={null}
        newPaths={NONE}
        active
        onExplore={onExplore}
        loadScene={loadScene}
      />,
    );
    expect(screen.getByText('2 pages')).toBeInTheDocument();
    await waitFor(() => expect(FakeScene.made).toHaveLength(1));
    const scene = FakeScene.made[0];
    await waitFor(() => expect(scene.sky?.stars).toHaveLength(2));
    expect(scene.calls).toContain('run');
    rerender(
      <SkyPreview
        rows={ROWS}
        book={null}
        newPaths={NONE}
        active={false}
        onExplore={onExplore}
        loadScene={loadScene}
      />,
    );
    expect(scene.calls.at(-1)).toBe('pause');
    await userEvent.click(
      screen.getByRole('button', { name: 'Explore the brain' }),
    );
    expect(onExplore).toHaveBeenCalledTimes(1);
    unmount();
    expect(scene.calls.at(-1)).toBe('dispose');
  });

  it('still opens Explore without graphics', async () => {
    FakeScene.fail = true;
    const onExplore = vi.fn();
    render(
      <SkyPreview
        rows={ROWS}
        book={null}
        newPaths={NONE}
        active
        onExplore={onExplore}
        loadScene={loadScene}
      />,
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Explore the brain' }),
    );
    expect(onExplore).toHaveBeenCalled();
  });

  it('is nothing for a brain without pages', () => {
    const { container } = render(
      <SkyPreview
        rows={[]}
        book={null}
        newPaths={NONE}
        active
        onExplore={vi.fn()}
        loadScene={loadScene}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
