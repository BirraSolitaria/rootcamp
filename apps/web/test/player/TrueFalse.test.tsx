import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderPlayer, trueFalse } from './fixtures';

describe('TrueFalseView', () => {
  it('keeps «Проверить» disabled until a choice is made, then submits it', async () => {
    const ev = userEvent.setup();
    const { onSubmit } = renderPlayer(trueFalse);
    expect(screen.getByText(trueFalse.statement)).toBeInTheDocument();
    const check = screen.getByRole('button', { name: 'Проверить' });
    expect(check).toBeDisabled();

    await ev.click(screen.getByRole('button', { name: 'Верно' }));
    expect(check).toBeEnabled();
    await ev.click(check);
    expect(onSubmit).toHaveBeenCalledWith({ type: 'true_false', value: true });
  });

  it('key «2» picks «Неверно» and Enter submits', async () => {
    const ev = userEvent.setup();
    const { onSubmit } = renderPlayer(trueFalse);
    await ev.keyboard('2');
    expect(screen.getByRole('button', { name: 'Неверно' })).toHaveAttribute('aria-pressed', 'true');
    await ev.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ type: 'true_false', value: false });
  });

  it('ignores keys beyond the number of options', async () => {
    const ev = userEvent.setup();
    const { onSubmit } = renderPlayer(trueFalse);
    await ev.keyboard('3{Enter}');
    expect(screen.getByRole('button', { name: 'Проверить' })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
