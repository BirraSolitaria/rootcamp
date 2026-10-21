import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { assemble, renderPlayer } from './fixtures';

const bank = () => within(screen.getByRole('group', { name: 'Плитки' }));
const answer = () => within(screen.getByRole('group', { name: 'Твой ответ' }));

describe('AssembleView', () => {
  it('keeps «Проверить» disabled until a tile is chosen, then submits tokens in order', async () => {
    const ev = userEvent.setup();
    const { onSubmit } = renderPlayer(assemble);
    const check = screen.getByRole('button', { name: 'Проверить' });
    expect(check).toBeDisabled();
    expect(bank().getAllByRole('button')).toHaveLength(4);

    await ev.click(bank().getByRole('button', { name: 'ls' }));
    expect(check).toBeEnabled();
    // a used tile leaves a placeholder in the bank, not a button
    expect(bank().queryByRole('button', { name: 'ls' })).toBeNull();
    await ev.click(bank().getByRole('button', { name: '-l' }));
    expect(
      answer()
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['ls', '-l']);

    await ev.click(check);
    expect(onSubmit).toHaveBeenCalledWith({ type: 'assemble', tokens: ['ls', '-l'] });
  });

  it('a chosen tile goes back to the bank when tapped', async () => {
    const ev = userEvent.setup();
    renderPlayer(assemble);
    await ev.click(bank().getByRole('button', { name: 'cd' }));
    await ev.click(answer().getByRole('button', { name: 'cd' }));
    expect(answer().queryAllByRole('button')).toHaveLength(0);
    expect(bank().getByRole('button', { name: 'cd' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Проверить' })).toBeDisabled();
  });
});
