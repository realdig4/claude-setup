/**
 * Shared React hooks for pages: async data, debouncing, intervals, settings, targets, shortcuts, theme.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type DependencyList } from 'react'
import { create } from 'zustand'
import { toast } from 'sonner'
import type { AppSettings, TargetId, TargetInfo } from '@shared/types'
import { core, errorMessage, platform, ui, useCoreEvent } from './api'
import { isEditableTarget, matchesHotkey, parseHotkey } from './keys'
import { hasModalLayer } from './layers'
import { useAppStore } from './store'
import { applyTheme, type ResolvedTheme } from './theme'

/** True on macOS (⌘ shortcuts, traffic-light window chrome). */
export const isMac = platform === 'darwin'

/** A ref that always holds the latest committed value (for callbacks used inside effects and handlers). */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value)
  useLayoutEffect(() => {
    ref.current = value
  })
  return ref
}

// ─────────────────────────────────────────────────────────────────────────────
// Async data
// ─────────────────────────────────────────────────────────────────────────────

export interface AsyncState<T> {
  /** Last successful result (kept while reloading). */
  data: T | undefined
  /** Friendly error message from the last failed run, or null. */
  error: string | null
  /** A request is in flight. Show skeletons when `loading && data === undefined`. */
  loading: boolean
  /** Run again (keeps current data while loading). Resolves with the new data, or undefined on error. */
  reload: () => Promise<T | undefined>
  /** Replace the data locally (optimistic updates). Accepts a value or an updater. */
  setData: (next: T | undefined | ((prev: T | undefined) => T | undefined)) => void
}

export interface AsyncOptions<T> {
  /** Skip running while false (e.g. until an id is known). Default true. */
  enabled?: boolean
  /** Data to start with (avoids a loading state). */
  initialData?: T
  /** Keep showing the previous data while deps change (default true). Set false for detail views. */
  keepPreviousData?: boolean
  onSuccess?: (data: T) => void
  onError?: (message: string) => void
}

/**
 * Run an async function (usually a core call) and track its state. Re-runs when `deps` change;
 * out-of-order responses are ignored.
 * @example const { data, loading, error, reload } = useAsync(() => core.servers.list(), [])
 */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList, options: AsyncOptions<T> = {}): AsyncState<T> {
  const { enabled = true, keepPreviousData = true } = options
  const [state, setState] = useState<{ data: T | undefined; error: string | null; loading: boolean }>(() => ({
    data: options.initialData,
    error: null,
    loading: enabled
  }))
  const fnRef = useLatest(fn)
  const optionsRef = useLatest(options)
  const callRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const reload = useCallback(async (): Promise<T | undefined> => {
    const id = ++callRef.current
    setState((s) => (s.loading && s.error === null ? s : { data: s.data, error: null, loading: true }))
    try {
      const data = await fnRef.current()
      if (mountedRef.current && id === callRef.current) {
        setState({ data, error: null, loading: false })
        optionsRef.current.onSuccess?.(data)
      }
      return data
    } catch (err) {
      const message = errorMessage(err)
      if (mountedRef.current && id === callRef.current) {
        setState((s) => ({ data: s.data, error: message, loading: false }))
        optionsRef.current.onError?.(message)
      }
      return undefined
    }
  }, [fnRef, optionsRef])

  useEffect(() => {
    if (!enabled) {
      callRef.current++
      setState((s) => (s.loading ? { ...s, loading: false } : s))
      return
    }
    if (!keepPreviousData) setState({ data: undefined, error: null, loading: true })
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps])

  const setData = useCallback((next: T | undefined | ((prev: T | undefined) => T | undefined)) => {
    setState((s) => ({
      ...s,
      data: typeof next === 'function' ? (next as (prev: T | undefined) => T | undefined)(s.data) : next
    }))
  }, [])

  return { data: state.data, error: state.error, loading: state.loading, reload, setData }
}

// ─────────────────────────────────────────────────────────────────────────────
// Timing
// ─────────────────────────────────────────────────────────────────────────────

/** The value, updated only after it stopped changing for `delay` ms. */
export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    if (Object.is(value, debounced)) return
    const id = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(id)
  }, [value, delay, debounced])
  return debounced
}

function subscribeVisibility(cb: () => void): () => void {
  document.addEventListener('visibilitychange', cb)
  return () => document.removeEventListener('visibilitychange', cb)
}

/** True while the window is visible (not minimized / hidden). */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== 'hidden',
    () => true
  )
}

/**
 * Call `callback` every `delay` ms (null pauses). Pauses while the window is hidden and fires once
 * when it becomes visible again (unless `pauseWhenHidden: false`).
 */
export function useInterval(callback: () => void, delay: number | null, opts: { pauseWhenHidden?: boolean } = {}): void {
  const cb = useLatest(callback)
  const visible = useDocumentVisible()
  const pauseWhenHidden = opts.pauseWhenHidden !== false
  const active = delay !== null && (!pauseWhenHidden || visible)
  const wasHidden = useRef(false)

  useEffect(() => {
    if (!visible) wasHidden.current = true
    else if (wasHidden.current && delay !== null && pauseWhenHidden) {
      wasHidden.current = false
      cb.current()
    }
  }, [visible, delay, pauseWhenHidden, cb])

  useEffect(() => {
    if (!active || delay === null) return
    const id = window.setInterval(() => cb.current(), delay)
    return () => window.clearInterval(id)
  }, [active, delay, cb])
}

// ─────────────────────────────────────────────────────────────────────────────
// Media / theme
// ─────────────────────────────────────────────────────────────────────────────

/** Live result of a CSS media query, e.g. useMediaQuery('(max-width: 960px)'). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const media = window.matchMedia(query)
      media.addEventListener('change', cb)
      return () => media.removeEventListener('change', cb)
    },
    [query]
  )
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  )
}

/** The effective theme ('light' | 'dark'), following the OS when the preference is 'system'. */
export function useResolvedTheme(): ResolvedTheme {
  const pref = useAppStore((s) => s.theme)
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')
  if (pref === 'system') return systemDark ? 'dark' : 'light'
  return pref
}

/** Keeps <html data-theme> in sync with the preference (mounted once by App). */
export function useThemeSync(): ResolvedTheme {
  const resolved = useResolvedTheme()
  useLayoutEffect(() => applyTheme(resolved), [resolved])
  return resolved
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings & targets
// ─────────────────────────────────────────────────────────────────────────────

export interface SettingsState {
  settings: AppSettings | null
  loading: boolean
  error: string | null
  /** Optimistic patch; resolves false (and shows a toast) if saving failed. */
  update: (patch: Partial<AppSettings>) => Promise<boolean>
  reload: () => Promise<AppSettings | null>
}

/** App settings from the core (loaded once, shared by every component). */
export function useSettings(): SettingsState {
  const settings = useAppStore((s) => s.settings)
  const status = useAppStore((s) => s.settingsStatus)
  const error = useAppStore((s) => s.settingsError)
  const update = useAppStore((s) => s.updateSettings)
  const load = useAppStore((s) => s.loadSettings)
  useEffect(() => {
    if (status === 'idle') void load()
  }, [status, load])
  const reload = useCallback(() => load(true), [load])
  return { settings, loading: status === 'idle' || status === 'loading', error, update, reload }
}

interface TargetsStore {
  targets: TargetInfo[] | null
  loading: boolean
  error: string | null
  loadedAt: number
  load: (force?: boolean) => Promise<TargetInfo[] | null>
}

const TARGETS_STALE_MS = 60_000
let targetsInflight: Promise<TargetInfo[] | null> | null = null

const useTargetsStore = create<TargetsStore>()((set, get) => ({
  targets: null,
  loading: false,
  error: null,
  loadedAt: 0,
  load: (force = false) => {
    if (targetsInflight) return targetsInflight
    const { targets, loadedAt } = get()
    if (!force && targets && Date.now() - loadedAt < TARGETS_STALE_MS) return Promise.resolve(targets)
    set({ loading: true })
    const request = core.targets
      .list()
      .then((list) => {
        set({ targets: list, loading: false, error: null, loadedAt: Date.now() })
        return list
      })
      .catch((err: unknown) => {
        set({ loading: false, error: errorMessage(err) })
        return null
      })
      .finally(() => {
        targetsInflight = null
      })
    targetsInflight = request
    return request
  }
}))

export interface TargetsState {
  /** Every supported app (installed or not). Empty until loaded. */
  targets: TargetInfo[]
  /** Loaded at least once. */
  ready: boolean
  loading: boolean
  error: string | null
  /** Refetch (e.g. after installing a server or restarting Claude Desktop). */
  reload: () => Promise<TargetInfo[] | null>
  /** Find one target by id. */
  byId: (id: TargetId) => TargetInfo | undefined
}

/** The apps Claude Setup can configure (Claude Desktop, Claude Code, VS Code, Cursor, Windsurf). Cached app-wide. */
export function useTargets(): TargetsState {
  const targets = useTargetsStore((s) => s.targets)
  const loading = useTargetsStore((s) => s.loading)
  const error = useTargetsStore((s) => s.error)
  const load = useTargetsStore((s) => s.load)
  useEffect(() => {
    void load()
  }, [load])
  const reload = useCallback(() => load(true), [load])
  const byId = useCallback((id: TargetId) => targets?.find((t) => t.id === id), [targets])
  return { targets: targets ?? [], ready: targets !== null, loading, error, reload, byId }
}

/** Refetch targets from anywhere (outside React too), e.g. after an install. */
export function refreshTargets(): Promise<TargetInfo[] | null> {
  return useTargetsStore.getState().load(true)
}

// ─────────────────────────────────────────────────────────────────────────────
// Core progress events
// ─────────────────────────────────────────────────────────────────────────────

export interface ProgressState {
  op: string
  message: string
  /** 0–100 when known. */
  pct?: number
}

/**
 * Latest core 'progress' event for an operation (e.g. 'install', 'doctor', 'restart-desktop'), or null.
 * Call reset() right before starting the operation.
 * @example const { progress, reset } = useProgress('install'); … <ProgressBar value={progress?.pct} label={progress?.message ?? 'Working…'} />
 */
export function useProgress(op: string | ((op: string) => boolean)): { progress: ProgressState | null; reset: () => void } {
  const [progress, setProgress] = useState<ProgressState | null>(null)
  const matcher = useLatest(op)
  useCoreEvent('progress', (payload) => {
    const m = matcher.current
    if (typeof m === 'function' ? m(payload.op) : payload.op === m) setProgress({ op: payload.op, message: payload.message, pct: payload.pct })
  })
  const reset = useCallback(() => setProgress(null), [])
  return { progress, reset }
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyboard & clipboard
// ─────────────────────────────────────────────────────────────────────────────

export interface HotkeyOptions {
  enabled?: boolean
  /** Fire even when typing in a text field (combos with Ctrl/⌘ always do). */
  allowInInputs?: boolean
  /** Fire even while a dialog/sheet/palette is open. */
  allowWhenModal?: boolean
  /** Call preventDefault() when matched (default true). */
  preventDefault?: boolean
}

/**
 * Global keyboard shortcut. `combo` like 'mod+k', '/', 'shift+?' (or an array of combos).
 * @example useHotkey('mod+r', () => reload())
 */
export function useHotkey(combo: string | string[], handler: (event: KeyboardEvent) => void, options: HotkeyOptions = {}): void {
  const { enabled = true, allowInInputs = false, allowWhenModal = false, preventDefault = true } = options
  const handlerRef = useLatest(handler)
  const key = Array.isArray(combo) ? combo.join('|') : combo
  useEffect(() => {
    if (!enabled) return
    const hotkeys = key.split('|').map(parseHotkey)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return
      if (!allowWhenModal && hasModalLayer()) return
      const editable = isEditableTarget(event.target)
      for (const hotkey of hotkeys) {
        if (!matchesHotkey(event, hotkey, isMac)) continue
        if (editable && !allowInInputs && !(hotkey.mod || hotkey.ctrl || hotkey.meta)) return
        if (preventDefault) event.preventDefault()
        handlerRef.current(event)
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [key, enabled, allowInInputs, allowWhenModal, preventDefault, handlerRef])
}

/**
 * Copy text to the clipboard and confirm with a toast (pass `false` as label for no success toast).
 * Returns true on success.
 */
export async function copyText(text: string, label: string | false = 'Copied to clipboard'): Promise<boolean> {
  try {
    await ui.copyText(text)
  } catch {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      toast.error('Couldn’t copy', { description: 'Select the text and press Ctrl+C instead.' })
      return false
    }
  }
  if (label !== false) toast.success(label)
  return true
}

/** Hook form of copyText (stable reference). */
export function useCopy(): (text: string, label?: string | false) => Promise<boolean> {
  return useCallback((text: string, label?: string | false) => copyText(text, label), [])
}
