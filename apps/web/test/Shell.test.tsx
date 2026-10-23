import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { ROUTER_FUTURE } from '../src/config';
import { Shell } from '../src/layout/Shell';

const initialWidth = window.innerWidth;

function setWidth(px: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: px });
}

function renderShell(route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]} future={ROUTER_FUTURE}>
      <Shell aside={<p>правая колонка</p>}>
        <p>контент</p>
      </Shell>
    </MemoryRouter>,
  );
}

describe('Shell', () => {
  afterEach(() => setWidth(initialWidth));

  it('renders the bottom tab bar on a phone (390 px)', () => {
    setWidth(390);
    renderShell();
    expect(screen.getByRole('navigation', { name: 'Вкладки' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Меню' })).not.toBeInTheDocument();
    expect(screen.getByText('контент')).toBeInTheDocument();
  });

  it('keeps the bottom tab bar on a tablet (800 px)', () => {
    setWidth(800);
    renderShell();
    expect(screen.getByRole('navigation', { name: 'Вкладки' })).toBeInTheDocument();
  });

  it('renders the side navigation on a desktop (1440 px)', () => {
    setWidth(1440);
    renderShell();
    expect(screen.getByRole('navigation', { name: 'Меню' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Вкладки' })).not.toBeInTheDocument();
    expect(screen.getByText('правая колонка')).toBeInTheDocument();
  });

  it('switches layout on resize', () => {
    setWidth(1440);
    renderShell();
    act(() => {
      setWidth(390);
      window.dispatchEvent(new Event('resize'));
    });
    expect(screen.getByRole('navigation', { name: 'Вкладки' })).toBeInTheDocument();
  });

  it('shows «Путь» and hides items whose screens are not built yet', () => {
    setWidth(1440);
    renderShell();
    expect(screen.getByRole('link', { name: /Путь/ })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('link', { name: /Лидерборд/ })).not.toBeInTheDocument();
  });

  it('marks «Путь» active on a track page (/track/:trackId)', () => {
    setWidth(1440);
    renderShell('/track/t1');
    const path = screen.getByRole('link', { name: /Путь/ });
    expect(path).toHaveAttribute('aria-current', 'page');
    expect(path).toHaveAttribute('href', '/track/t1');
  });
});
