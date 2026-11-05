import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SYSTEM_THEME_QUERY, THEME_STORAGE_KEY } from '../lib/theme';
import { useAppTheme } from './use-theme';

let media: MediaQueryList;
let listeners: Set<() => void>;

beforeEach(() => {
  window.localStorage.clear();
  listeners = new Set();
  media = {
    matches: false,
    addEventListener: vi.fn((_event, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_event, listener: () => void) => listeners.delete(listener)),
  } as unknown as MediaQueryList;
  vi.stubGlobal('matchMedia', vi.fn(() => media));
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-preference');
  document.documentElement.removeAttribute('data-theme-storage-error');
  document.documentElement.classList.remove('dark');
  document.documentElement.style.colorScheme = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function systemChanges(dark: boolean) {
  Object.defineProperty(media, 'matches', { value: dark, configurable: true });
  act(() => listeners.forEach((listener) => listener()));
}

describe('device-local app theme', () => {
  it('defaults to System and resolves the system preference before the first render', () => {
    Object.defineProperty(media, 'matches', { value: true, configurable: true });
    const { result } = renderHook(useAppTheme);
    expect(result.current.preference).toBe('system');
    expect(result.current.isDark).toBe(true);
    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(window.matchMedia).toHaveBeenCalledWith(SYSTEM_THEME_QUERY);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it.each(['system', 'light', 'dark'] as const)('initializes saved %s preference', (preference) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    const { result } = renderHook(useAppTheme);
    expect(result.current.preference).toBe(preference);
    expect(result.current.isDark).toBe(preference === 'dark');
  });

  it.each(['system', 'light', 'dark'] as const)('persists selected %s across remounts', (preference) => {
    const first = renderHook(useAppTheme);
    act(() => first.result.current.setPreference(preference));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(preference);
    first.unmount();
    const second = renderHook(useAppTheme);
    expect(second.result.current.preference).toBe(preference);
  });

  it('tracks system changes only for System and resumes tracking when reselected', () => {
    const { result, unmount } = renderHook(useAppTheme);
    systemChanges(true);
    expect(result.current.isDark).toBe(true);
    act(() => result.current.setPreference('light'));
    expect(listeners.size).toBe(0);
    systemChanges(false);
    systemChanges(true);
    expect(result.current.isDark).toBe(false);
    act(() => result.current.setPreference('dark'));
    systemChanges(false);
    expect(result.current.isDark).toBe(true);
    act(() => result.current.setPreference('system'));
    expect(result.current.isDark).toBe(false);
    systemChanges(true);
    expect(result.current.isDark).toBe(true);
    unmount();
    expect(listeners.size).toBe(0);
  });

  it.each(['invalid', '', 'DARK', '{"theme":"dark"}'])('ignores invalid saved value %j', (stored) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, stored);
    const { result } = renderHook(useAppTheme);
    expect(result.current.preference).toBe('system');
    expect(result.current.storageError).toBeNull();
  });

  it('surfaces unavailable storage reads while resolving System', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const { result } = renderHook(useAppTheme);
    expect(result.current.preference).toBe('system');
    expect(result.current.storageError).toMatch(/could not be read/);
  });

  it('surfaces a bootstrap storage failure even if subsequent reads recover', () => {
    document.documentElement.dataset.themeStorageError = 'Theme preference could not be read on this device. Using System.';
    const { result } = renderHook(useAppTheme);
    expect(result.current.storageError).toMatch(/could not be read/);
    act(() => result.current.setPreference('light'));
    expect(result.current.storageError).toBeNull();
    expect(document.documentElement.dataset.themeStorageError).toBeUndefined();
  });

  it('applies the selected choice and surfaces failed writes, clearing the error after a successful retry', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    const { result } = renderHook(useAppTheme);
    act(() => result.current.setPreference('dark'));
    expect(result.current.isDark).toBe(true);
    expect(document.documentElement).toHaveClass('dark');
    expect(result.current.storageError).toMatch(/only until reload/);
    write.mockRestore();
    act(() => result.current.setPreference('light'));
    expect(result.current.storageError).toBeNull();
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('supports the legacy toggle without losing persistence', () => {
    const { result } = renderHook(useAppTheme);
    act(() => result.current.toggleTheme());
    expect(result.current.preference).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });
});
