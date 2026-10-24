import { describe, expect, it } from 'vitest'
import { hotkeyLabels, isEditableTarget, matchesHotkey, parseHotkey, type KeyLike } from '../../src/renderer/src/lib/keys'
import { PAGES, cleanParams, getPage, isPageId, navGroups, sameRoute, visiblePages } from '../../src/renderer/src/lib/nav'

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods })

describe('renderer/nav', () => {
  it('defines every page exactly once', () => {
    const ids = PAGES.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.sort()).toEqual(['backups', 'discover', 'doctor', 'extensions', 'home', 'installed', 'models', 'proxy', 'settings'])
  })

  it('uses the agreed labels', () => {
    expect(getPage('installed').label).toBe('My Tools')
    expect(getPage('doctor').label).toBe('Health Check')
    expect(getPage('proxy').advancedOnly).toBe(true)
    expect(getPage('backups').advancedOnly).toBe(true)
  })

  it('hides advanced pages in Simple mode', () => {
    expect(visiblePages('simple').some((p) => p.advancedOnly)).toBe(false)
    expect(visiblePages('advanced')).toHaveLength(PAGES.length)
    const groups = navGroups('simple')
    expect(groups.map((g) => g.id)).toEqual(['setup', 'customize', 'maintain'])
    expect(groups.flatMap((g) => g.pages).map((p) => p.id)).toEqual(['home', 'discover', 'installed', 'models', 'extensions', 'doctor', 'settings'])
  })

  it('validates page ids and compares routes', () => {
    expect(isPageId('discover')).toBe(true)
    expect(isPageId('nope')).toBe(false)
    expect(isPageId(null)).toBe(false)
    expect(() => getPage('nope' as never)).toThrow()
    expect(sameRoute({ page: 'discover', params: { q: 'git' } }, { page: 'discover', params: { q: 'git' } })).toBe(true)
    expect(sameRoute({ page: 'discover', params: { q: 'git' } }, { page: 'discover', params: {} })).toBe(false)
    expect(cleanParams({ a: 1, b: undefined, c: false })).toEqual({ a: 1, c: false })
  })
})

describe('renderer/keys', () => {
  it('parses combos', () => {
    expect(parseHotkey('mod+k')).toMatchObject({ key: 'k', mod: true, shift: false })
    expect(parseHotkey('Ctrl+Shift+P')).toMatchObject({ key: 'p', ctrl: true, shift: true })
    expect(parseHotkey('esc').key).toBe('escape')
    expect(parseHotkey('mod++').key).toBe('+')
  })

  it('matches mod as Ctrl on Windows and ⌘ on macOS', () => {
    const hk = parseHotkey('mod+k')
    expect(matchesHotkey(key('k', { ctrlKey: true }), hk, false)).toBe(true)
    expect(matchesHotkey(key('k', { metaKey: true }), hk, false)).toBe(false)
    expect(matchesHotkey(key('k', { metaKey: true }), hk, true)).toBe(true)
    expect(matchesHotkey(key('K', { ctrlKey: true, shiftKey: true }), hk, false)).toBe(false)
  })

  it('matches plain and symbol keys without modifiers', () => {
    expect(matchesHotkey(key('/'), parseHotkey('/'), false)).toBe(true)
    expect(matchesHotkey(key('/', { ctrlKey: true }), parseHotkey('/'), false)).toBe(false)
    expect(matchesHotkey(key('?', { shiftKey: true }), parseHotkey('?'), false)).toBe(true)
    expect(matchesHotkey(key('Escape'), parseHotkey('escape'), false)).toBe(true)
  })

  it('renders platform-specific labels', () => {
    expect(hotkeyLabels('mod+k', false)).toEqual(['Ctrl', 'K'])
    expect(hotkeyLabels('mod+k', true)).toEqual(['⌘', 'K'])
    expect(hotkeyLabels('shift+enter', false)).toEqual(['Shift', '↵'])
    expect(hotkeyLabels('escape', true)).toEqual(['Esc'])
  })

  it('detects text fields', () => {
    expect(isEditableTarget({ tagName: 'INPUT', type: 'text' } as unknown as EventTarget)).toBe(true)
    expect(isEditableTarget({ tagName: 'INPUT', type: 'checkbox' } as unknown as EventTarget)).toBe(false)
    expect(isEditableTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true)
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true)
    expect(isEditableTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})
