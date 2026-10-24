/**
 * Small GUI-only preferences (window position, one-time notices) stored in <dataDir>/gui.json.
 * Kept separate from state.json, which belongs to the core.
 */
import { join } from 'node:path'
import { isPlainObject, readJson, writeJsonAtomic } from '@core/fs/json'

/** Saved window position and size. */
export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
}

/** Contents of <dataDir>/gui.json. */
export interface GuiPrefs {
  window?: WindowBounds & { maximized?: boolean }
  /** The "still running in the tray" notification was shown once. */
  trayNoticeShown?: boolean
}

/** A display work area. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** True when at least a 100×60 px piece of `bounds` (its title area) is on one of the work areas. */
export function isVisibleOnSomeDisplay(bounds: WindowBounds, workAreas: Rect[]): boolean {
  if (bounds.x === undefined || bounds.y === undefined) return true
  const { x, y, width } = bounds
  return workAreas.some((a) => {
    const overlapW = Math.min(x + width, a.x + a.width) - Math.max(x, a.x)
    const overlapH = Math.min(y + 60, a.y + a.height) - Math.max(y, a.y)
    return overlapW >= 100 && overlapH >= 30
  })
}

/** Sanitize saved bounds: enforce minimum size, drop a position that is off-screen. */
export function restoreBounds(saved: GuiPrefs['window'], workAreas: Rect[], min: { width: number; height: number }): WindowBounds | undefined {
  if (!saved || typeof saved.width !== 'number' || typeof saved.height !== 'number') return undefined
  const bounds: WindowBounds = { width: Math.max(min.width, Math.round(saved.width)), height: Math.max(min.height, Math.round(saved.height)) }
  if (typeof saved.x === 'number' && typeof saved.y === 'number') {
    const positioned = { ...bounds, x: Math.round(saved.x), y: Math.round(saved.y) }
    if (isVisibleOnSomeDisplay(positioned, workAreas)) return positioned
  }
  return bounds
}

/** Loads and (debounced) saves gui.json. */
export class PrefsStore {
  private prefs: GuiPrefs = {}
  private timer: NodeJS.Timeout | undefined
  private readonly file: string

  constructor(dataDir: string) {
    this.file = join(dataDir, 'gui.json')
  }

  async load(): Promise<GuiPrefs> {
    const r = await readJson<GuiPrefs>(this.file)
    this.prefs = r.data && isPlainObject(r.data) ? r.data : {}
    return this.prefs
  }

  get(): GuiPrefs {
    return this.prefs
  }

  /** Merge a patch and save shortly after (debounced). */
  update(patch: Partial<GuiPrefs>): void {
    this.prefs = { ...this.prefs, ...patch }
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), 400)
  }

  /** Write pending changes now. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await writeJsonAtomic(this.file, this.prefs).catch(() => {})
  }
}
