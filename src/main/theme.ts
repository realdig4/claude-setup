/** Native theme handling: follows the app's theme setting and keeps the window background in sync. */
import { nativeTheme, type BrowserWindow } from 'electron'
import type { AppSettings } from '@shared/types'

/** Window background before the renderer paints (matches the UI's base surface colours). */
export const WINDOW_BACKGROUND = { light: '#F2EFEB', dark: '#100D0B' } as const

/** Background colour for the current effective theme. */
export function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light
}

/** Apply the user's theme choice to native UI (menus, dialogs, scrollbars, title bar). */
export function applyThemeSetting(theme: AppSettings['theme'] | undefined): void {
  const source = theme === 'light' || theme === 'dark' ? theme : 'system'
  if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source
}

/** Keep a window's background colour in step with the effective theme. Returns an unsubscribe function. */
export function syncWindowBackground(getWindow: () => BrowserWindow | null): () => void {
  const onUpdated = (): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackground())
  }
  nativeTheme.on('updated', onUpdated)
  return () => nativeTheme.off('updated', onUpdated)
}
