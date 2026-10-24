import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MobileKeys, useMobileKeys } from '../../src/terminal/MobileKeys';

/** The terminal's hidden textarea stand-in: typed text goes through the key controller. */
function Harness({ onSend }: { onSend: (s: string) => void }) {
  const keys = useMobileKeys(onSend);
  return (
    <>
      <textarea aria-label="ввод" value="" onChange={(e) => keys.input(e.target.value)} />
      <MobileKeys keys={keys} />
    </>
  );
}

describe('MobileKeys', () => {
  it('renders the 6×2 grid of §8.3 in order', () => {
    render(<Harness onSend={() => {}} />);
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['Esc', 'Tab', 'Ctrl', '↑', '↓', '|', '←', '→', '/', '-', '~', '^C']);
  });

  it('sends escape sequences', async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Вверх' }));
    await u.click(screen.getByRole('button', { name: 'Esc' }));
    await u.click(screen.getByRole('button', { name: 'Ctrl+C' }));
    await u.click(screen.getByRole('button', { name: 'Влево' }));
    expect(onSend.mock.calls).toEqual([['\x1b[A'], ['\x1b'], ['\x03'], ['\x1b[D']]);
  });

  it('Ctrl is sticky: the next letter goes out as a control character, then Ctrl releases', async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const u = userEvent.setup();
    const ctrl = screen.getByRole('button', { name: 'Ctrl' });
    await u.click(ctrl);
    expect(ctrl).toHaveAttribute('aria-pressed', 'true');
    expect(onSend).not.toHaveBeenCalled();

    await u.type(screen.getByLabelText('ввод'), 'd');
    expect(onSend).toHaveBeenLastCalledWith('\x04');
    expect(ctrl).toHaveAttribute('aria-pressed', 'false');

    await u.type(screen.getByLabelText('ввод'), 'd');
    expect(onSend).toHaveBeenLastCalledWith('d');
  });

  it('pressing Ctrl twice releases it; another key also releases it', async () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const u = userEvent.setup();
    const ctrl = screen.getByRole('button', { name: 'Ctrl' });
    await u.click(ctrl);
    await u.click(ctrl);
    expect(ctrl).toHaveAttribute('aria-pressed', 'false');

    await u.click(ctrl);
    await u.click(screen.getByRole('button', { name: 'Tab' }));
    expect(onSend).toHaveBeenLastCalledWith('\t');
    expect(ctrl).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps focus where it was (the soft keyboard stays open)', async () => {
    render(<Harness onSend={() => {}} />);
    const u = userEvent.setup();
    const input = screen.getByLabelText('ввод');
    input.focus();
    await u.click(screen.getByRole('button', { name: 'Вниз' }));
    expect(input).toHaveFocus();
  });
});
