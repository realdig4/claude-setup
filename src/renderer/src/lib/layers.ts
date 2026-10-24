/**
 * Registry of open overlay layers (dialogs, sheets, menus, the command palette), topmost last.
 * Only the top layer reacts to Escape / traps focus, and global shortcuts pause while a modal is open.
 * The DOM side effects (inert background, focus restore) live in components/ui/overlay.ts.
 */

export interface LayerEntry {
  id: number
  /** Modal layers make the rest of the app inert and trap focus. */
  modal: boolean
  /** The layer's root element (for focus trapping / inert toggling). */
  element: () => HTMLElement | null
}

const stack: LayerEntry[] = []
const listeners = new Set<() => void>()
let nextId = 1

function notify(): void {
  for (const listener of listeners) listener()
}

/** Register a layer on top of the stack. Returns its id. */
export function pushLayer(entry: Omit<LayerEntry, 'id'>): number {
  const id = nextId++
  stack.push({ ...entry, id })
  notify()
  return id
}

/** Remove a layer (wherever it is in the stack). */
export function removeLayer(id: number): void {
  const index = stack.findIndex((l) => l.id === id)
  if (index >= 0) {
    stack.splice(index, 1)
    notify()
  }
}

/** The topmost layer, if any. */
export function topLayer(): LayerEntry | undefined {
  return stack[stack.length - 1]
}

export function isTopLayer(id: number): boolean {
  return topLayer()?.id === id
}

/** True while any modal layer (dialog, sheet, palette) is open. */
export function hasModalLayer(): boolean {
  return stack.some((l) => l.modal)
}

/** Snapshot of open layers, bottom → top. */
export function openLayers(): readonly LayerEntry[] {
  return stack
}

/** Subscribe to stack changes. Returns an unsubscribe function. */
export function subscribeLayers(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
