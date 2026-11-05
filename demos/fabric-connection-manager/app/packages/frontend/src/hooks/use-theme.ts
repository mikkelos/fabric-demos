import { useEffect, useLayoutEffect, useState } from 'react';

import {
  applyTheme,
  isThemePreference,
  readThemePreference,
  SYSTEM_THEME_QUERY,
  systemIsDark,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from '../lib/theme';

export function useAppTheme() {
  const [state, setState] = useState(readThemePreference);
  const [systemDark, setSystemDark] = useState(systemIsDark);
  const { preference, storageError } = state;
  const isDark = preference === 'system' ? systemDark : preference === 'dark';

  useLayoutEffect(() => {
    applyTheme(preference, isDark);
  }, [preference, isDark]);

  useEffect(() => {
    if (preference !== 'system' || !window.matchMedia) return;
    const media = window.matchMedia(SYSTEM_THEME_QUERY);
    const update = () => setSystemDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [preference]);

  const setPreference = (next: ThemePreference) => {
    if (!isThemePreference(next)) return;
    let error: string | null = null;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
      delete document.documentElement.dataset.themeStorageError;
    } catch {
      error = 'Theme preference could not be saved on this device. Your choice applies only until reload.';
    }
    if (next === 'system') setSystemDark(systemIsDark());
    setState({ preference: next, storageError: error });
  };

  const toggleTheme = () => setPreference(isDark ? 'light' : 'dark');

  return { isDark, preference, setPreference, storageError, toggleTheme };
}
