/**
 * Theme plumbing: resolves 'system' | 'light' | 'dark' to an effective theme and applies it as
 * <html data-theme="…">. Also caches the last mode/theme in localStorage so the very first frame
 * (before settings arrive from the core) already looks right.
 * Deliberately free of any core/IPC imports — it runs before the app boots.
 */

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'
export type UiMode = 'simple' | 'advanced'

const CACHE_KEY = 'claude-setup:ui'
const DARK_QUERY = '(prefers-color-scheme: dark)'

export interface CachedUi {
  mode?: UiMode
  theme?: ThemePreference
}

/** Last known mode/theme (from the previous session). Never throws. */
export function readCachedUi(): CachedUi {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as CachedUi
    const out: CachedUi = {}
    if (parsed.mode === 'simple' || parsed.mode === 'advanced') out.mode = parsed.mode
    if (parsed.theme === 'system' || parsed.theme === 'light' || parsed.theme === 'dark') out.theme = parsed.theme
    return out
  } catch {
    return {}
  }
}

/** Remember mode/theme for the next launch (undefined fields are left unchanged). Never throws. */
export function writeCachedUi(patch: CachedUi): void {
  try {
    const next: CachedUi = { ...readCachedUi() }
    if (patch.mode) next.mode = patch.mode
    if (patch.theme) next.theme = patch.theme
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(next))
  } catch {
    // Storage can be unavailable (private mode, quota) — the cache is only an optimization.
  }
}

/** Whether the OS currently prefers dark colors. */
export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches
}

/** 'system' → the OS preference; 'light'/'dark' pass through. */
export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return pref
}

/** Apply the effective theme to <html>. */
export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement
  if (root.dataset.theme !== theme) root.dataset.theme = theme
  root.style.colorScheme = theme
}

/** Subscribe to OS light/dark changes. Returns an unsubscribe function. */
export function onSystemThemeChange(cb: (dark: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const media = window.matchMedia(DARK_QUERY)
  const listener = (e: MediaQueryListEvent): void => cb(e.matches)
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}

/** Called once at startup (before React renders) with the cached preference. */
export function applyInitialTheme(override?: ThemePreference): ResolvedTheme {
  const pref = override ?? readCachedUi().theme ?? 'system'
  const resolved = resolveTheme(pref)
  applyTheme(resolved)
  return resolved
}
