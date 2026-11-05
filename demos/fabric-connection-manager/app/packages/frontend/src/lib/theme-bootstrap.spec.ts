import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { THEME_STORAGE_KEY } from './theme';

const bootstrap = readFileSync(resolve('public', 'theme-bootstrap.js'), 'utf8');
const html = readFileSync(resolve('index.html'), 'utf8');
const runBootstrap = () => new Function('window', 'document', bootstrap)(window, document);

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-preference');
  document.documentElement.removeAttribute('data-theme-storage-error');
  document.documentElement.style.colorScheme = '';
  vi.unstubAllGlobals();
});

describe('theme before first paint', () => {
  it('loads a blocking bootstrap in the head before the body and React entry', () => {
    const script = html.indexOf('<script src="/theme-bootstrap.js"></script>');
    expect(script).toBeGreaterThan(html.indexOf('<head>'));
    expect(script).toBeLessThan(html.indexOf('</head>'));
    expect(script).toBeLessThan(html.indexOf('<body>'));
    expect(script).toBeLessThan(html.indexOf('src="/src/main.tsx"'));
    expect(html).toContain('html.dark { background: #151d22; color-scheme: dark; }');
  });

  it.each([
    [null, 'system', true],
    ['system', 'system', true],
    ['light', 'light', false],
    ['dark', 'dark', true],
    ['invalid', 'system', true],
  ])('applies stored %s before any React render', (stored, preference, dark) => {
    if (stored !== null) window.localStorage.setItem(THEME_STORAGE_KEY, String(stored));
    runBootstrap();
    expect(document.documentElement.classList.contains('dark')).toBe(dark);
    expect(document.documentElement.dataset.themePreference).toBe(preference);
    expect(document.documentElement.dataset.theme).toBe(dark ? 'dark' : 'light');
    expect(document.documentElement.style.colorScheme).toBe(dark ? 'dark' : 'light');
  });

  it('does not crash when storage is blocked and records an explicit failure', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    runBootstrap();
    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement.dataset.themeStorageError).toMatch(/could not be read/);
  });

  it('uses light when the browser has no system appearance API', () => {
    vi.stubGlobal('matchMedia', undefined);
    runBootstrap();
    expect(document.documentElement).not.toHaveClass('dark');
  });
});
