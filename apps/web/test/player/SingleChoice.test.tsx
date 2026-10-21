import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderPlayer, singleChoice } from './fixtures';

const options = () =>
  within(screen.getByRole('group', { name: 'Варианты ответа' })).getAllByRole('button');
const labels = () => options().map((b) => b.textContent?.replace(/^\d/, ''));

describe('SingleChoiceView', () => {
  it('keeps «Проверить» disabled until an option is picked, then submits the original index', async () => {
    const ev = userEvent.setup();
    const { onSubmit } = renderPlayer(singleChoice);
    const check = screen.getByRole('button', { name: 'Проверить' });
    expect(check).toBeDisabled();

    await ev.click(screen.getByRole('button', { name: 'pwd' }));
    expect(screen.getByRole('button', { name: 'pwd' })).toHaveAttribute('aria-pressed', 'true');
    expect(check).toBeEnabled();

    await ev.click(check);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ type: 'single_choice', selectedIndex: 1 });
  });

  it('key «2» picks the second shown option and Enter submits it', async () => {
    const ev = userEvent.setup();
    const { onSubmit } = renderPlayer(singleChoice);
    const second = options()[1]!;
    await ev.keyboard('2');
    expect(second).toHaveAttribute('aria-pressed', 'true');
    await ev.keyboard('{Enter}');
    const shown = second.textContent!.replace(/^\d/, '');
    expect(onSubmit).toHaveBeenCalledWith({
      type: 'single_choice',
      selectedIndex: singleChoice.options.indexOf(shown as never),
    });
  });

  it('shuffles deterministically per presentation and keeps the order across re-renders', () => {
    const first = renderPlayer(singleChoice, { presentation: 3 });
    const order = labels();
    first.rerenderWith({ presentation: 3 });
    expect(labels()).toEqual(order);
    first.unmount();

    renderPlayer(singleChoice, { presentation: 3 });
    expect(labels()).toEqual(order);
    expect([...labels()].sort()).toEqual([...singleChoice.options].sort());
  });

  it('uses the rng passed in', () => {
    renderPlayer(singleChoice, { rng: () => 0.999 });
    // Fisher–Yates with j = i at every step leaves the order unchanged.
    expect(labels()).toEqual(singleChoice.options);
  });
});
