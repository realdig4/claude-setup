/**
 * Global UI store (zustand): navigation, Simple/Advanced mode, theme and app settings.
 *
 * Mode and theme are mirrored to the core (core.app.updateSettings) with optimistic updates:
 * the UI changes instantly, and is re-synced from the core if saving fails.
 */
import { create } from 'zustand'
import { toast } from 'sonner'
import type { AppSettings } from '@shared/types'
import { core, errorMessage } from './api'
import { cleanParams, getPage, sameRoute, type PageId, type Route, type RouteParams } from './nav'
import { readCachedUi, writeCachedUi, type ThemePreference, type UiMode } from './theme'

const MAX_HISTORY = 50

export type SettingsStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface AppStore {
  /** Current page and its params. */
  route: Route
  /** Previous routes (most recent last) for back(). */
  history: Route[]
  /** Go to a page. Pushes the current route on the history stack. No-op if already there. */
  navigate: (page: PageId, params?: RouteParams) => void
  /** Change the current page's params without adding a history entry (e.g. filters). */
  replaceParams: (params: RouteParams, opts?: { merge?: boolean }) => void
  /** Return to the previous route (falls back to Home). */
  back: () => void

  settings: AppSettings | null
  settingsStatus: SettingsStatus
  settingsError: string | null
  /** Load settings from the core (deduplicated; `force` refetches). */
  loadSettings: (force?: boolean) => Promise<AppSettings | null>
  /** Optimistically patch settings and persist them. Resolves false (and toasts) on failure. */
  updateSettings: (patch: Partial<AppSettings>) => Promise<boolean>

  mode: UiMode
  theme: ThemePreference
  setMode: (mode: UiMode) => void
  setTheme: (theme: ThemePreference) => void

  /** Command palette (Ctrl/Cmd+K) visibility. */
  commandOpen: boolean
  setCommandOpen: (open: boolean) => void
}

const cached = readCachedUi()
let settingsSeq = 0
let inflightLoad: Promise<AppSettings | null> | null = null

export const useAppStore = create<AppStore>()((set, get) => ({
  route: { page: 'home', params: {} },
  history: [],

  navigate: (page, params) => {
    const next: Route = { page, params: cleanParams(params) }
    const { route, history } = get()
    if (sameRoute(route, next)) return
    set({ route: next, history: [...history, route].slice(-MAX_HISTORY) })
  },

  replaceParams: (params, opts) => {
    const { route } = get()
    const merged = opts?.merge === false ? params : { ...route.params, ...params }
    set({ route: { page: route.page, params: cleanParams(merged) } })
  },

  back: () => {
    const { history } = get()
    const previous = history[history.length - 1]
    if (!previous) {
      set({ route: { page: 'home', params: {} } })
      return
    }
    set({ route: previous, history: history.slice(0, -1) })
  },

  settings: null,
  settingsStatus: 'idle',
  settingsError: null,

  loadSettings: (force = false) => {
    const state = get()
    if (!force && state.settings) return Promise.resolve(state.settings)
    if (inflightLoad && !force) return inflightLoad
    if (!state.settings) set({ settingsStatus: 'loading' })
    const seq = settingsSeq
    const load = core.app
      .getSettings()
      .then((settings) => {
        // Ignore if an optimistic update happened while loading (its own response will sync).
        if (seq === settingsSeq) {
          set({ settings, settingsStatus: 'ready', settingsError: null, mode: settings.mode, theme: settings.theme })
          writeCachedUi({ mode: settings.mode, theme: settings.theme })
        }
        return settings
      })
      .catch((err: unknown) => {
        set({ settingsStatus: get().settings ? 'ready' : 'error', settingsError: errorMessage(err) })
        return null
      })
      .finally(() => {
        if (inflightLoad === load) inflightLoad = null
      })
    inflightLoad = load
    return load
  },

  updateSettings: async (patch) => {
    const seq = ++settingsSeq
    const before = { settings: get().settings, mode: get().mode, theme: get().theme }
    set((s) => ({
      settings: s.settings ? { ...s.settings, ...patch } : s.settings,
      mode: patch.mode ?? s.mode,
      theme: patch.theme ?? s.theme
    }))
    writeCachedUi({ mode: patch.mode, theme: patch.theme })
    try {
      const next = await core.app.updateSettings(patch)
      if (seq === settingsSeq) {
        set({ settings: next, mode: next.mode, theme: next.theme, settingsStatus: 'ready', settingsError: null })
        writeCachedUi({ mode: next.mode, theme: next.theme })
      }
      return true
    } catch (err) {
      toast.error('Couldn’t save that setting', { description: errorMessage(err) })
      if (seq === settingsSeq) {
        const fresh = await get().loadSettings(true)
        if (!fresh) {
          set(before)
          writeCachedUi({ mode: before.mode, theme: before.theme })
        }
      }
      return false
    }
  },

  mode: cached.mode ?? 'simple',
  theme: cached.theme ?? 'system',

  setMode: (mode) => {
    const { route, history } = get()
    if (mode === 'simple' && getPage(route.page).advancedOnly) {
      // Leaving Advanced mode while on an advanced-only page: go somewhere visible.
      set({ route: { page: 'home', params: {} }, history: history.filter((r) => !getPage(r.page).advancedOnly) })
    }
    void get().updateSettings({ mode })
  },

  setTheme: (theme) => {
    void get().updateSettings({ theme })
  },

  commandOpen: false,
  setCommandOpen: (open) => set({ commandOpen: open })
}))

/** Navigate from anywhere (event handlers outside React, toast actions, …). */
export function navigate(page: PageId, params?: RouteParams): void {
  useAppStore.getState().navigate(page, params)
}

/** Current route (re-renders on navigation). */
export function useRoute(): Route {
  return useAppStore((s) => s.route)
}

/** The navigate() function (stable reference). */
export function useNavigate(): AppStore['navigate'] {
  return useAppStore((s) => s.navigate)
}

/** 'simple' | 'advanced'. */
export function useMode(): UiMode {
  return useAppStore((s) => s.mode)
}

/** True in Advanced mode. */
export function useIsAdvanced(): boolean {
  return useAppStore((s) => s.mode === 'advanced')
}

/** The saved theme preference ('system' | 'light' | 'dark'). */
export function useThemePreference(): ThemePreference {
  return useAppStore((s) => s.theme)
}
