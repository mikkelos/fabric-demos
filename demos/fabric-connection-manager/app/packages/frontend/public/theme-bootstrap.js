// Keep this synchronous bootstrap before the app and styles so first paint uses the device preference.
(function () {
  var preference = 'system';
  var storageError = null;
  try {
    var stored = window.localStorage.getItem('fabric-connection-manager.theme');
    if (stored === 'system' || stored === 'light' || stored === 'dark') {
      preference = stored;
    }
  } catch {
    storageError = 'Theme preference could not be read on this device. Using System.';
  }
  var dark = preference === 'dark' ||
    (preference === 'system' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.themePreference = preference;
  root.style.colorScheme = dark ? 'dark' : 'light';
  if (storageError) root.dataset.themeStorageError = storageError;
})();
