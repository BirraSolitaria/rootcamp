import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { matchPairs, renderPlayer } from './fixtures';

const left = (name: string) =>
  within(screen.getByRole('group', { name: 'Левая колонка' })).getByRole('button', {
    name: new RegExp(`^${name}`),
  });
const right = (name: string) =>
  within(screen.getByRole('group', { name: 'Правая колонка' })).getByRole('button', {
    name: new RegExp(`^${name}`),
  });

describe('MatchPairsView', () => {
  it('keeps «Проверить» disabled until every pair is linked, then submits the pairs', async () => {
    const ev = userEvent.setup();
    const { onSubmit } = renderPlayer(matchPairs);
    const check = screen.getByRole('button', { name: 'Проверить' });
    expect(check).toBeDisabled();

    await ev.click(left('ls'));
    expect(left('ls')).toHaveAttribute('aria-pressed', 'true');
    await ev.click(right('список файлов'));
    expect(left('ls')).toHaveAccessibleName('ls, пара 1');
    expect(right('список файлов')).toHaveAccessibleName('список файлов, пара 1');
    await ev.click(left('pwd'));
    await ev.click(right('текущий каталог'));
    expect(check).toBeDisabled();
    await ev.click(left('cd'));
    await ev.click(right('сменить каталог'));
    expect(check).toBeEnabled();

    await ev.click(check);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const answer = onSubmit.mock.calls[0]![0];
    expect(answer.type).toBe('match_pairs');
    expect(answer.type === 'match_pairs' && answer.pairs).toEqual(
      expect.arrayContaining(matchPairs.pairs),
    );
  });

  it('tapping a linked tile unlinks the pair', async () => {
    const ev = userEvent.setup();
    renderPlayer(matchPairs);
    await ev.click(left('ls'));
    await ev.click(right('текущий каталог'));
    await ev.click(right('текущий каталог'));
    expect(left('ls')).toHaveAccessibleName('ls');
    expect(left('ls')).toHaveAttribute('aria-pressed', 'false');
  });
});
