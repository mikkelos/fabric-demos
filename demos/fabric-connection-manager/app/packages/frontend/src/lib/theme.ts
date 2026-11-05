export const THEME_STORAGE_KEY = 'fabric-connection-manager.theme';
export const SYSTEM_THEME_QUERY = '(prefers-color-scheme: dark)';
export type ThemePreference = 'system' | 'light' | 'dark';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function readThemePreference(): {
  preference: ThemePreference;
  storageError: string | null;
} {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return {
      preference: isThemePreference(stored) ? stored : 'system',
      storageError: document.documentElement.dataset.themeStorageError ?? null,
    };
  } catch {
    return {
      preference: 'system',
      storageError: 'Theme preference could not be read on this device. Using System.',
    };
  }
}

export function systemIsDark() {
  return window.matchMedia?.(SYSTEM_THEME_QUERY).matches ?? false;
}

export function applyTheme(preference: ThemePreference, isDark: boolean) {
  const root = document.documentElement;
  root.classList.toggle('dark', isDark);
  root.dataset.theme = isDark ? 'dark' : 'light';
  root.dataset.themePreference = preference;
  root.style.colorScheme = isDark ? 'dark' : 'light';
}

export function initializeTheme() {
  const { preference, storageError } = readThemePreference();
  applyTheme(preference, preference === 'system' ? systemIsDark() : preference === 'dark');
  if (storageError) document.documentElement.dataset.themeStorageError = storageError;
}
