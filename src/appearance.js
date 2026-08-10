const THEME_PREFERENCES = new Set(['system', 'light', 'dark']);

export function normalizeThemePreference(value) {
  return THEME_PREFERENCES.has(value) ? value : 'system';
}

export function resolveTheme(preference, prefersDark = false) {
  const normalized = normalizeThemePreference(preference);
  if (normalized === 'dark') return 'dark';
  if (normalized === 'light') return 'light';
  return prefersDark ? 'dark' : 'light';
}

export function nextThemePreference(preference) {
  const normalized = normalizeThemePreference(preference);
  return normalized === 'system' ? 'dark' : normalized === 'dark' ? 'light' : 'system';
}
