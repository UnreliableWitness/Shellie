import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  HelpTip,
  IconButton,
  MindMark,
  PageHeader,
  Pivots,
  RingGauge,
  StateDot,
  WorkItemTypeIcon,
} from '.';
import { installFakeApi } from '../../test-helpers/fakeApi';
import { useWorkItemTypes } from '../../workItemTypes';

const projectTypes = () =>
  installFakeApi({
    'workItems:types': () => [
      {
        name: 'Task',
        color: '#a4880a',
        icon: 'data:image/svg+xml;base64,PHN2Zy8+',
        states: [{ name: 'Doing', color: '#007acc', category: 'InProgress' }],
      },
      { name: 'Issue', color: '#339947', icon: null, states: [] },
    ],
  });

const arcLength = (el: Element) =>
  Number(el.querySelector('[data-part="arc"]')!.getAttribute('data-fraction'));

describe('RingGauge', () => {
  it('fills against the 50 EUR reference scale without max', () => {
    render(<RingGauge value={12.5} label="AI cost 12.50" />);
    expect(arcLength(screen.getByRole('img', { name: 'AI cost 12.50' }))).toBe(
      0.25,
    );
  });
  it('clamps to the full ring and to empty', () => {
    const { container, rerender } = render(<RingGauge value={500} />);
    expect(arcLength(container)).toBe(1);
    rerender(<RingGauge value={-3} />);
    expect(arcLength(container)).toBe(0);
  });
  it('draws one arc per segment, in order', () => {
    const { container } = render(
      <RingGauge
        value={10}
        max={10}
        segments={[
          { value: 8, color: 'var(--chart-claude)' },
          { value: 2, color: 'var(--chart-copilot)' },
        ]}
      />,
    );
    const segs = container.querySelectorAll('[data-part="segment"]');
    expect([...segs].map((s) => s.getAttribute('data-fraction'))).toEqual([
      '0.8',
      '0.2',
    ]);
  });
  it('is hidden from assistive tech without a label', () => {
    const { container } = render(<RingGauge value={1} />);
    expect(container.querySelector('svg')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });
});

describe('IconButton', () => {
  it('uses the label as accessible name and the shortcut in the tooltip', async () => {
    const onClick = vi.fn();
    render(
      <IconButton label="New task" shortcut="Ctrl+N" onClick={onClick}>
        +
      </IconButton>,
    );
    const b = screen.getByRole('button', { name: 'New task' });
    expect(b).toHaveAttribute('title', 'New task (Ctrl+N)');
    await userEvent.click(b);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('WorkItemTypeIcon', () => {
  it('falls back to a square in the ADO type color', () => {
    const { container } = render(
      <>
        <WorkItemTypeIcon type="Bug" />
        <WorkItemTypeIcon type="Product Backlog Item" />
        <WorkItemTypeIcon type="Something else" />
      </>,
    );
    const fills = [...container.querySelectorAll('.wit-fallback > span')].map(
      (s) => (s as HTMLElement).style.background,
    );
    expect(fills).toEqual([
      'rgb(204, 41, 61)',
      'rgb(0, 156, 204)',
      'rgb(136, 136, 136)',
    ]);
    expect(screen.getByRole('img', { name: 'Bug' })).toBeInTheDocument();
  });
  it('shows the real icon when given one', () => {
    render(<WorkItemTypeIcon type="Task" iconUrl="data:image/svg+xml,x" />);
    expect(screen.getByRole('img', { name: 'Task' })).toHaveAttribute(
      'src',
      'data:image/svg+xml,x',
    );
  });
  it("looks up the project's real icon and color for a connection, once", async () => {
    const { calls } = projectTypes();
    const { container } = render(
      <>
        <WorkItemTypeIcon type="task" connectionId="c1" />
        <WorkItemTypeIcon type="Issue" connectionId="c1" />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'task' })).toHaveAttribute(
        'src',
        'data:image/svg+xml;base64,PHN2Zy8+',
      ),
    );
    expect(
      (container.querySelector('.wit-fallback > span') as HTMLElement).style
        .background,
    ).toBe('rgb(51, 153, 71)');
    expect(calls.filter((c) => c.channel === 'workItems:types')).toHaveLength(
      1,
    );
  });
  it('keeps the fallback when the types cannot be loaded', async () => {
    installFakeApi({
      'workItems:types': () => {
        throw new Error('offline');
      },
    });
    const { container } = render(
      <WorkItemTypeIcon type="Bug" connectionId="c1" />,
    );
    await waitFor(() =>
      expect(useWorkItemTypes.getState().byConnection.c1?.status).toBe(
        'failed',
      ),
    );
    expect(container.querySelector('.wit-fallback')).not.toBeNull();
  });
});

describe('StateDot', () => {
  it('draws the state color before the name, with a fallback map', () => {
    const { container, rerender } = render(<StateDot state="Active" />);
    expect(screen.getByText('Active')).toBeInTheDocument();
    const dot = () => container.querySelector('.state-dot') as HTMLElement;
    expect(dot().style.background).toBe('rgb(0, 122, 204)');
    rerender(<StateDot state="Closed" />);
    expect(dot().style.background).toBe('rgb(51, 153, 51)');
    rerender(<StateDot state="Doing" color="#123456" />);
    expect(dot().style.background).toBe('rgb(18, 52, 86)');
  });
  it("uses the project's state color for the type", async () => {
    projectTypes();
    const { container } = render(
      <StateDot state="Doing" type="Task" connectionId="c1" />,
    );
    const dot = () => container.querySelector('.state-dot') as HTMLElement;
    // Doing is not in the fallback map, so it starts grey.
    expect(dot().style.background).toBe('rgb(178, 178, 178)');
    await waitFor(() =>
      expect(dot().style.background).toBe('rgb(0, 122, 204)'),
    );
  });
  it('draws a Removed item in the muted colour, not white', () => {
    const { container } = render(<StateDot state="Removed" />);
    expect(
      (container.querySelector('.state-dot') as HTMLElement).style.background,
    ).toBe('var(--muted)');
  });
});

describe('PageHeader and Pivots', () => {
  it('renders the title and selects pivots', async () => {
    const onSelect = vi.fn();
    render(
      <PageHeader
        title="New task"
        pivots={
          <Pivots
            label="Start from"
            items={[
              { key: 'a', label: 'Work item' },
              { key: 'b', label: 'Typed' },
            ]}
            selected="a"
            onSelect={onSelect}
          />
        }
      />,
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'New task' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Work item' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Typed' }));
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('puts the commands on the title row when inline', () => {
    const commands = <button type="button">Refresh</button>;
    const { container, rerender } = render(
      <PageHeader title="Sprint 8" commands={commands} inline />,
    );
    const heading = screen.getByRole('heading', { level: 1 });
    const refresh = screen.getByRole('button', { name: 'Refresh' });
    expect(heading.parentElement).toContainElement(refresh);
    expect(container.querySelector('.pagehead-bar')).toBeNull();

    rerender(<PageHeader title="Sprint 8" commands={commands} />);
    expect(
      screen.getByRole('heading', { level: 1 }).parentElement,
    ).not.toContainElement(screen.getByRole('button', { name: 'Refresh' }));
  });
});

describe('MindMark', () => {
  it('is decorative', () => {
    const { container } = render(<MindMark />);
    expect(container.querySelector('img')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });
});

describe('HelpTip', () => {
  const tip = (onOpen?: () => void) =>
    render(
      <HelpTip label="Sync" onOpen={onOpen}>
        Pulls changes
      </HelpTip>,
    );
  it('shows the text on hover and describes the button with it', async () => {
    tip();
    const btn = screen.getByRole('button', { name: 'Help: Sync' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    await userEvent.hover(btn);
    const pop = screen.getByRole('tooltip');
    expect(pop).toHaveTextContent('Pulls changes');
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(btn).toHaveAttribute('aria-describedby', pop.id);
  });
  it('hides on Escape and returns focus to the button', async () => {
    tip();
    const btn = screen.getByRole('button', { name: 'Help: Sync' });
    await userEvent.hover(btn);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(btn).toHaveFocus();
  });
  it('opens on click and calls onOpen once per opening', async () => {
    const onOpen = vi.fn();
    tip(onOpen);
    const btn = screen.getByRole('button', { name: 'Help: Sync' });
    await userEvent.click(btn);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
  it('opens when tabbed to and closes when focus leaves', async () => {
    render(
      <>
        <HelpTip label="Sync">Pulls changes</HelpTip>
        <button type="button">Next</button>
      </>,
    );
    await userEvent.tab();
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    await userEvent.tab();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
