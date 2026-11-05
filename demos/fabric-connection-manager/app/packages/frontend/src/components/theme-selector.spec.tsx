import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ThemeContext, type ThemeContextValue } from '../hooks/theme.context';
import { ThemeSelector } from './theme-selector';

afterEach(cleanup);

function renderSelector(overrides: Partial<ThemeContextValue> = {}) {
  const value: ThemeContextValue = {
    preference: 'system', isDark: false, storageError: null,
    setPreference: vi.fn(), toggleTheme: vi.fn(), ...overrides,
  };
  render(<ThemeContext.Provider value={value}><ThemeSelector /></ThemeContext.Provider>);
  return value;
}

describe('theme selector', () => {
  it('offers labeled System / Light / Dark choices and passes selection to the provider', () => {
    const value = renderSelector();
    const select = screen.getByRole('combobox', { name: 'Theme' });
    expect(select).toHaveValue('system');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['System', 'Light', 'Dark']);
    fireEvent.change(select, { target: { value: 'dark' } });
    expect(value.setPreference).toHaveBeenCalledWith('dark');
  });

  it('shows saved choices and explicitly announces storage failures', () => {
    const message = 'Theme preference could not be saved on this device. Your choice applies only until reload.';
    renderSelector({ preference: 'light', storageError: message });
    expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveValue('light');
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('combobox')).toHaveAccessibleDescription(message);
  });
});
