/**
 * Theme application. Tenant themes are applied ONLY by setting the CSS variables derived by
 * the shared theme engine (themeCssVariables) — never by building CSS from strings.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_THEME, themeCssVariables, type ThemeInput, type ThemeMode } from '@daliz/shared';

export type ResolvedMode = 'light' | 'dark';
const STORAGE_KEY = 'daliz.colorMode';
const DEFAULT_FAVICON = '/favicon.svg';

function readStoredMode(): ThemeMode | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : null;
  } catch {
    return null;
  }
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/** Sets the derived variables as inline custom properties on an element. */
export function applyThemeVariables(el: HTMLElement, theme: ThemeInput, mode: ResolvedMode): void {
  const vars = themeCssVariables(theme, mode);
  for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, value);
}

/** Inline-style object for scoping a theme to a container (branding preview). */
export function themeStyle(theme: ThemeInput, mode: ResolvedMode): Record<string, string> {
  try {
    return themeCssVariables(theme, mode);
  } catch {
    return themeCssVariables(DEFAULT_THEME, mode);
  }
}

export function applyDocumentTheme(theme: ThemeInput, mode: ResolvedMode): void {
  const root = document.documentElement;
  try {
    applyThemeVariables(root, theme, mode);
  } catch {
    applyThemeVariables(root, DEFAULT_THEME, mode);
  }
  root.classList.toggle('dark', mode === 'dark');
  root.style.colorScheme = mode;
}

export function setFavicon(url: string | null): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  const href = url ?? DEFAULT_FAVICON;
  link.type = href.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
  link.href = href;
}

interface ThemeContextValue {
  /** The brand theme currently applied app-wide. */
  theme: ThemeInput;
  setBrand: (brand: { theme: ThemeInput; name: string; favicon: string | null }) => void;
  resetBrand: () => void;
  brandName: string;
  /** The user's explicit choice, or null to follow the tenant's default mode. */
  preference: ThemeMode | null;
  setPreference: (mode: ThemeMode | null) => void;
  mode: ResolvedMode;
  toggle: () => void;
}

// Kept on globalThis so hot module replacement never pairs a provider and consumer from
// different module instances ("useTheme must be used inside ThemeProvider").
const globalCtx = globalThis as typeof globalThis & { __dalizThemeContext?: ReturnType<typeof createContext<ThemeContextValue | null>> };
const ThemeContext = (globalCtx.__dalizThemeContext ??= createContext<ThemeContextValue | null>(null));

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeInput>(DEFAULT_THEME);
  const [brandName, setBrandName] = useState('Daliz');
  const [favicon, setFaviconUrl] = useState<string | null>(null);
  const [preference, setPreferenceState] = useState<ThemeMode | null>(readStoredMode);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const effective = preference ?? theme.defaultMode;
  const mode: ResolvedMode = effective === 'system' ? (systemDark ? 'dark' : 'light') : effective;

  useLayoutEffect(() => {
    applyDocumentTheme(theme, mode);
  }, [theme, mode]);

  useEffect(() => {
    setFavicon(favicon);
  }, [favicon]);

  const setPreference = useCallback((m: ThemeMode | null) => {
    setPreferenceState(m);
    try {
      if (m) localStorage.setItem(STORAGE_KEY, m);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage may be unavailable (private mode); the choice still applies for this visit.
    }
  }, []);

  const setBrand = useCallback((b: { theme: ThemeInput; name: string; favicon: string | null }) => {
    setTheme((prev) => (JSON.stringify(prev) === JSON.stringify(b.theme) ? prev : b.theme));
    setBrandName(b.name);
    setFaviconUrl(b.favicon);
  }, []);

  const resetBrand = useCallback(() => {
    setTheme(DEFAULT_THEME);
    setBrandName('Daliz');
    setFaviconUrl(null);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setBrand,
      resetBrand,
      brandName,
      preference,
      setPreference,
      mode,
      toggle: () => setPreference(mode === 'dark' ? 'light' : 'dark'),
    }),
    [theme, setBrand, resetBrand, brandName, preference, setPreference, mode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}

/** Sets document.title as "<page> · <brand>". */
export function useDocumentTitle(title: string | null | undefined): void {
  const { brandName } = useTheme();
  useEffect(() => {
    document.title = title ? `${title} · ${brandName}` : brandName;
  }, [title, brandName]);
}
