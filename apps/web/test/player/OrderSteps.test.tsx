import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { orderSteps, renderPlayer } from './fixtures';

const shown = () =>
  within(screen.getByRole('list', { name: 'Порядок шагов' }))
    .getAllByRole('listitem')
    .map((li) => li.getAttribute('data-step'));

describe('OrderStepsView', () => {
  it('starts in a wrong order with «Проверить» disabled; ↓ on the first step swaps it with the second', async () => {
    const ev = userEvent.setup();
    renderPlayer(orderSteps);
    const before = shown();
    expect(before).not.toEqual(orderSteps.steps);
    expect([...before].sort()).toEqual([...orderSteps.steps].sort());
    expect(screen.getByRole('button', { name: 'Проверить' })).toBeDisabled();
    expect(screen.getByRole('button', { name: `Выше: ${before[0]}` })).toBeDisabled();
    expect(screen.getByRole('button', { name: `Ниже: ${before[3]}` })).toBeDisabled();

    await ev.click(screen.getByRole('button', { name: `Ниже: ${before[0]}` }));
    expect(shown()).toEqual([before[1], before[0], before[2], before[3]]);
    expect(screen.getByRole('button', { name: 'Проверить' })).toBeEnabled();
  });

  it('submits {type:"order_steps", order} after reordering with ↑', async () => {
    const ev = userEvent.setup();
    const { onSubmit } = renderPlayer(orderSteps);
    // insertion sort with the ↑ buttons
    for (let target = 0; target < orderSteps.steps.length; target++) {
      const step = orderSteps.steps[target]!;
      while (shown().indexOf(step) > target) {
        await ev.click(screen.getByRole('button', { name: `Выше: ${step}` }));
      }
    }
    expect(shown()).toEqual(orderSteps.steps);
    await ev.click(screen.getByRole('button', { name: 'Проверить' }));
    expect(onSubmit).toHaveBeenCalledWith({ type: 'order_steps', order: orderSteps.steps });
  });

  it('every step has a drag handle', () => {
    renderPlayer(orderSteps);
    for (const step of orderSteps.steps) {
      expect(screen.getByRole('button', { name: `Перетащить: ${step}` })).toBeInTheDocument();
    }
  });
});
