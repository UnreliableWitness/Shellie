import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskComposer } from './AskComposer';

afterEach(cleanup);

type Props = Partial<Parameters<typeof AskComposer>[0]> & { start?: string };
function Harness({ start = '', ...props }: Props) {
  const [value, setValue] = useState(start);
  return (
    <AskComposer
      label="Ask the brain"
      value={value}
      onChange={setValue}
      onSend={() => undefined}
      {...props}
    />
  );
}
const box = () => screen.getByRole('textbox', { name: 'Ask the brain' });
const ask = () => screen.getByRole('button', { name: 'Ask' });

describe('AskComposer', () => {
  it('sends on Enter and not on Shift+Enter', async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    await userEvent.type(box(), 'one{Shift>}{Enter}{/Shift}two');
    expect(onSend).not.toHaveBeenCalled();
    expect(box()).toHaveValue('one\ntwo');
    await userEvent.type(box(), '{Enter}');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('does not send on the Enter that ends a composition', () => {
    const onSend = vi.fn();
    render(<Harness start="text" onSend={onSend} />);
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends nothing when empty, and shows the hint only then', async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} hint="Enter sends" />);
    expect(ask()).toBeDisabled();
    expect(screen.getByText('Enter sends')).toBeInTheDocument();
    await userEvent.type(box(), '{Enter}');
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.type(box(), 'a');
    expect(screen.queryByText('Enter sends')).not.toBeInTheDocument();
    expect(ask()).toBeEnabled();
  });

  it('keeps the text and sends nothing while a run is under way', async () => {
    const onSend = vi.fn();
    render(
      <Harness
        start="next"
        onSend={onSend}
        waiting="Wait for this one, or stop it"
      />,
    );
    expect(box()).toBeEnabled();
    expect(ask()).toBeDisabled();
    expect(
      screen.getByText('Wait for this one, or stop it'),
    ).toBeInTheDocument();
    await userEvent.type(box(), '{Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(box()).toHaveValue('next');
  });

  it('is disabled with its reason when off', () => {
    render(<Harness off="Take the proposal back to change it" />);
    expect(box()).toBeDisabled();
    expect(box()).toHaveAccessibleDescription(
      'Take the proposal back to change it',
    );
  });

  it('is read-only while the send is in flight', () => {
    render(<Harness start="text" sending />);
    expect(box()).toHaveAttribute('readonly');
    expect(ask()).toBeDisabled();
  });

  it('removes the quote on Escape and with its button', async () => {
    const onQuoteRemove = vi.fn();
    render(<Harness quote="rebase first" onQuoteRemove={onQuoteRemove} />);
    expect(screen.getByText('About: “rebase first”')).toBeInTheDocument();
    await userEvent.type(box(), '{Escape}');
    expect(onQuoteRemove).toHaveBeenCalledTimes(1);
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Remove the selected text from the ask',
      }),
    );
    expect(onQuoteRemove).toHaveBeenCalledTimes(2);
  });

  it('grows with its lines, from two rows to eight', () => {
    render(<Harness start="a" />);
    expect(box()).toHaveAttribute('rows', '2');
    cleanup();
    render(<Harness start={'a\nb\nc\nd'} />);
    expect(box()).toHaveAttribute('rows', '4');
    cleanup();
    render(<Harness start={'\n'.repeat(20)} />);
    expect(box()).toHaveAttribute('rows', '8');
  });
});
