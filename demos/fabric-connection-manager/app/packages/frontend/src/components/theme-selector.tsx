import { useId } from 'react';

import { useTheme } from '../hooks/theme.context';
import { isThemePreference } from '../lib/theme';

export function ThemeSelector() {
  const { preference, setPreference, storageError } = useTheme();
  const errorId = useId();

  return (
    <div className="flex flex-col gap-100">
      <label className="flex items-center gap-200 text-200">
        <span>Theme</span>
        <select
          className="rounded-lg border border-border bg-card px-300 py-200 text-200 text-foreground focus-visible:outline-2 focus-visible:outline-primary"
          value={preference}
          aria-describedby={storageError ? errorId : undefined}
          onChange={(event) => {
            const value = event.target.value;
            if (isThemePreference(value)) setPreference(value);
          }}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      {storageError && (
        <p id={errorId} role="alert" className="max-w-80 text-200 text-destructive">
          {storageError}
        </p>
      )}
    </div>
  );
}
