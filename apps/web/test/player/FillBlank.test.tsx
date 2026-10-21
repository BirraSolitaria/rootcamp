import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fillBlank, renderPlayer } from './fixtures';

describe('FillBlankView', () => {
  it('keeps «Проверить» disabled for blank input, then submits the text', async () => {
    const ev = userEvent.setup();
    const { onSubmit } = renderPlayer(fillBlank);
    const check = screen.getByRole('button', { name: 'Проверить' });
    const input = screen.getByRole('textbox', { name: 'Ответ' });
    expect(screen.getByText('cd')).toBeInTheDocument();
    expect(check).toBeDisabled();

    await ev.type(input, '   ');
    expect(check).toBeDisabled();
    await ev.clear(input);
    await ev.type(input, '~');
    expect(check).toBeEnabled();
    await ev.click(check);
    expect(onSubmit).toHaveBeenCalledWith({ type: 'fill_blank', text: '~' });
    expect(input).toHaveAttribute('readonly');
  });

  it('Enter in the input submits', async () => {
    const ev = userEvent.setup();
    const { onSubmit } = renderPlayer(fillBlank);
    await ev.type(screen.getByRole('textbox', { name: 'Ответ' }), '~{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ type: 'fill_blank', text: '~' });
  });

  it('digits typed into the input are text, not option shortcuts', async () => {
    const ev = userEvent.setup();
    const { onSubmit } = renderPlayer(fillBlank);
    await ev.type(screen.getByRole('textbox', { name: 'Ответ' }), '12');
    expect(screen.getByRole('textbox', { name: 'Ответ' })).toHaveValue('12');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
