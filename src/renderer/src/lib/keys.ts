/**
 * Keyboard shortcut parsing, matching and display labels.
 * Combos are written like 'mod+k', 'shift+/', 'escape', '/', 'ctrl+shift+p'.
 * 'mod' means ⌘ on macOS and Ctrl on Windows/Linux.
 */

export interface Hotkey {
  key: string
  mod: boolean
  ctrl: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

/** The subset of KeyboardEvent we need (keeps this module testable without a DOM). */
export interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  space: ' ',
  spacebar: ' ',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  del: 'delete',
  plus: '+'
}

/** Parse 'mod+shift+k' into a Hotkey. */
export function parseHotkey(combo: string): Hotkey {
  const parts = combo
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
  // A trailing '+' means the plus key itself ("mod++").
  if (combo.endsWith('++')) parts.splice(parts.length - 2, 2, '+')
  const hotkey: Hotkey = { key: '', mod: false, ctrl: false, meta: false, shift: false, alt: false }
  for (const part of parts) {
    if (part === 'mod') hotkey.mod = true
    else if (part === 'ctrl' || part === 'control') hotkey.ctrl = true
    else if (part === 'meta' || part === 'cmd' || part === 'command') hotkey.meta = true
    else if (part === 'shift') hotkey.shift = true
    else if (part === 'alt' || part === 'option') hotkey.alt = true
    else if (part) hotkey.key = KEY_ALIASES[part] ?? part
  }
  return hotkey
}

/** True when the event matches the hotkey on the given platform. */
export function matchesHotkey(event: KeyLike, hotkey: Hotkey, isMac: boolean): boolean {
  if (event.key.toLowerCase() !== hotkey.key) return false
  const wantCtrl = hotkey.ctrl || (hotkey.mod && !isMac)
  const wantMeta = hotkey.meta || (hotkey.mod && isMac)
  if (event.ctrlKey !== wantCtrl) return false
  if (event.metaKey !== wantMeta) return false
  if (event.altKey !== hotkey.alt) return false
  // Symbols like "?" already imply Shift on most layouts, so only enforce Shift for letters/named keys.
  const isSymbol = hotkey.key.length === 1 && !/[a-z0-9]/.test(hotkey.key)
  if (!isSymbol && event.shiftKey !== hotkey.shift) return false
  return true
}

const MAC_MODIFIERS = { mod: '⌘', ctrl: '⌃', meta: '⌘', alt: '⌥', shift: '⇧' }
const PC_MODIFIERS = { mod: 'Ctrl', ctrl: 'Ctrl', meta: 'Win', alt: 'Alt', shift: 'Shift' }

const KEY_LABELS: Record<string, string> = {
  escape: 'Esc',
  enter: '↵',
  ' ': 'Space',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  backspace: '⌫',
  delete: 'Del',
  tab: 'Tab'
}

/** Labels to render a shortcut, e.g. 'mod+k' → ['⌘', 'K'] on macOS and ['Ctrl', 'K'] elsewhere. */
export function hotkeyLabels(combo: string, isMac: boolean): string[] {
  const hotkey = parseHotkey(combo)
  const names = isMac ? MAC_MODIFIERS : PC_MODIFIERS
  const labels: string[] = []
  if (hotkey.ctrl) labels.push(names.ctrl)
  if (hotkey.mod && !(hotkey.ctrl && !isMac)) labels.push(names.mod)
  if (hotkey.meta && !(hotkey.mod && isMac)) labels.push(names.meta)
  if (hotkey.alt) labels.push(names.alt)
  if (hotkey.shift) labels.push(names.shift)
  if (hotkey.key) labels.push(KEY_LABELS[hotkey.key] ?? (hotkey.key.length === 1 ? hotkey.key.toUpperCase() : capitalize(hotkey.key)))
  return labels
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/** True when keyboard focus is in a text field (shortcuts without modifiers should not fire there). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as { tagName?: unknown }).tagName !== 'string') return false
  const el = target as unknown as { tagName: string; isContentEditable?: boolean; type?: string }
  if (el.isContentEditable) return true
  const tag = el.tagName.toLowerCase()
  if (tag === 'textarea' || tag === 'select') return true
  if (tag !== 'input') return false
  const type = (el.type ?? 'text').toLowerCase()
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type)
}
