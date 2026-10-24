/**
 * Pure helpers that edit a parsed Claude Code settings object in place:
 *   hooks       { "<Event>": [ { "matcher"?: "...", "hooks": [ {type, command…} ] } ] }   merged per event, identical handlers deduped
 *   statusLine  { "type": "command", "command": "...", "padding"? }                         replaced; previous value remembered by the caller
 *   skillOverrides { "<skill>": "off" | … }                                                  per-skill visibility
 */
import { cloneJson, isPlainObject } from '../fs/json'
import { deepEqual, sha256, stableStringify } from './util'

export interface HookHandler {
  type: string
  [key: string]: unknown
}

export interface HookGroup {
  matcher?: string
  hooks: HookHandler[]
  [key: string]: unknown
}

export type HooksMap = Record<string, HookGroup[]>

/** One handler at one event/matcher — the unit we add, remove and park. */
export interface HookRef {
  event: string
  matcher?: string
  handler: HookHandler
}

/** "*", "" and a missing matcher all mean "match everything". */
export function normalizeMatcher(matcher: unknown): string {
  if (typeof matcher !== 'string') return ''
  const m = matcher.trim()
  return m === '*' ? '' : m
}

/**
 * Validate a downloaded hooks fragment ({ "<Event>": [groups] }). Returns the usable part and
 * human-readable problems for anything skipped.
 */
export function validateHooks(value: unknown): { hooks: HooksMap; problems: string[] } {
  const hooks: HooksMap = {}
  const problems: string[] = []
  if (!isPlainObject(value)) return { hooks, problems: ['It does not contain any hooks.'] }
  for (const [event, groups] of Object.entries(value)) {
    if (!/^[A-Za-z]+$/.test(event)) {
      problems.push(`Skipped an unknown hook event "${event}".`)
      continue
    }
    if (!Array.isArray(groups)) {
      problems.push(`Skipped "${event}": it is not a list of hook groups.`)
      continue
    }
    const valid: HookGroup[] = []
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) continue
      const handlers = group.hooks.filter((h): h is HookHandler => isPlainObject(h) && typeof h.type === 'string' && h.type.length > 0)
      if (!handlers.length) continue
      const g: HookGroup = { ...cloneJson(group), hooks: cloneJson(handlers) }
      if (g.matcher !== undefined && typeof g.matcher !== 'string') delete g.matcher
      valid.push(g)
    }
    if (valid.length) hooks[event] = valid
  }
  if (!Object.keys(hooks).length && !problems.length) problems.push('It does not contain any hooks.')
  return { hooks, problems }
}

function hooksObject(settings: Record<string, unknown>, create: boolean): Record<string, unknown> | undefined {
  if (isPlainObject(settings.hooks)) return settings.hooks
  if (!create) return undefined
  settings.hooks = {}
  return settings.hooks as Record<string, unknown>
}

/** Every handler currently in a settings object, flattened. */
export function listHooks(settings: Record<string, unknown>): HookRef[] {
  const out: HookRef[] = []
  const hooks = hooksObject(settings, false)
  if (!hooks) return out
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) continue
      for (const handler of group.hooks) {
        if (!isPlainObject(handler) || typeof handler.type !== 'string') continue
        out.push({ event, matcher: typeof group.matcher === 'string' ? group.matcher : undefined, handler: handler as HookHandler })
      }
    }
  }
  return out
}

/** True when an identical handler exists for the same event and (equivalent) matcher. */
export function hasHook(settings: Record<string, unknown>, ref: HookRef): boolean {
  return listHooks(settings).some((h) => sameRef(h, ref))
}

function sameRef(a: HookRef, b: HookRef): boolean {
  return a.event === b.event && normalizeMatcher(a.matcher) === normalizeMatcher(b.matcher) && deepEqual(a.handler, b.handler)
}

/**
 * Merge hooks into settings. Handlers go into an existing group with the same matcher when there is one;
 * identical handlers are not added twice. Returns the handlers actually added.
 */
export function mergeHooks(settings: Record<string, unknown>, fragment: HooksMap): HookRef[] {
  const added: HookRef[] = []
  for (const [event, groups] of Object.entries(fragment)) {
    for (const group of groups) {
      for (const handler of group.hooks) {
        const ref: HookRef = { event, matcher: group.matcher, handler }
        if (addHook(settings, ref, group)) added.push(cloneJson(ref))
      }
    }
  }
  return added
}

/** Add one handler (no-op when an identical one exists). `template` supplies extra group keys for a new group. */
export function addHook(settings: Record<string, unknown>, ref: HookRef, template?: HookGroup): boolean {
  if (hasHook(settings, ref)) return false
  const hooks = hooksObject(settings, true) as Record<string, unknown>
  const groups: unknown[] = Array.isArray(hooks[ref.event]) ? (hooks[ref.event] as unknown[]) : []
  hooks[ref.event] = groups
  const matcher = normalizeMatcher(ref.matcher)
  let target = groups.find((g) => isPlainObject(g) && Array.isArray(g.hooks) && normalizeMatcher(g.matcher) === matcher) as HookGroup | undefined
  if (!target) {
    const extra: Record<string, unknown> = {}
    if (template) for (const [k, v] of Object.entries(template)) if (k !== 'hooks' && k !== 'matcher') extra[k] = cloneJson(v)
    target = { ...(ref.matcher !== undefined ? { matcher: ref.matcher } : {}), ...extra, hooks: [] }
    groups.push(target)
  }
  target.hooks.push(cloneJson(ref.handler))
  return true
}

/** Remove handlers (one occurrence each); drops empty groups, events and the hooks key. Returns how many were removed. */
export function removeHooks(settings: Record<string, unknown>, refs: HookRef[]): number {
  const hooks = hooksObject(settings, false)
  if (!hooks) return 0
  let removed = 0
  for (const ref of refs) {
    const groups = hooks[ref.event]
    if (!Array.isArray(groups)) continue
    const matcher = normalizeMatcher(ref.matcher)
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks) || normalizeMatcher(group.matcher) !== matcher) continue
      const index = group.hooks.findIndex((h: unknown) => deepEqual(h, ref.handler))
      if (index >= 0) {
        group.hooks.splice(index, 1)
        removed++
        break
      }
    }
    const remaining = groups.filter((g) => !(isPlainObject(g) && Array.isArray(g.hooks) && g.hooks.length === 0))
    if (remaining.length) hooks[ref.event] = remaining
    else delete hooks[ref.event]
  }
  if (!Object.keys(hooks).length) delete settings.hooks
  return removed
}

/** Stable short hash identifying a handler at an event/matcher (used in ids of hooks we did not install). */
export function hookRefHash(ref: HookRef): string {
  return sha256(stableStringify({ e: ref.event, m: normalizeMatcher(ref.matcher), h: ref.handler })).slice(0, 12)
}

/** Shell commands / prompts of a hooks fragment (for requirement checks and previews). */
export function hookCommands(hooks: HooksMap): string[] {
  const out: string[] = []
  for (const groups of Object.values(hooks)) for (const g of groups) for (const h of g.hooks) if (typeof h.command === 'string') out.push(h.command)
  return out
}

/** Validate a status line object; returns a clean copy or null. */
export function validateStatusLine(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null
  if (value.type !== undefined && value.type !== 'command') return null
  if (typeof value.command !== 'string' || !value.command.trim()) return null
  return { ...cloneJson(value), type: 'command' }
}

/** Replace the status line; returns what was there before. */
export function setStatusLine(settings: Record<string, unknown>, value: Record<string, unknown>): { previous?: unknown; hadPrevious: boolean } {
  const hadPrevious = settings.statusLine !== undefined
  const previous = hadPrevious ? cloneJson(settings.statusLine) : undefined
  settings.statusLine = cloneJson(value)
  return { previous, hadPrevious }
}

/**
 * Undo a status line we installed: put the previous value back (or remove the key).
 * When the user has changed it since, settings are left alone ('changed'); 'absent' when there is none.
 */
export function restoreStatusLine(
  settings: Record<string, unknown>,
  installed: Record<string, unknown>,
  previous: unknown,
  hadPrevious: boolean
): 'restored' | 'removed' | 'changed' | 'absent' {
  if (settings.statusLine === undefined) return 'absent'
  if (!deepEqual(settings.statusLine, installed)) return 'changed'
  if (hadPrevious && previous !== undefined) {
    settings.statusLine = cloneJson(previous)
    return 'restored'
  }
  delete settings.statusLine
  return 'removed'
}

/** Set (or with `value` undefined, remove) a skillOverrides entry; drops the key when it becomes empty. */
export function setSkillOverride(settings: Record<string, unknown>, name: string, value: string | undefined): boolean {
  const current = isPlainObject(settings.skillOverrides) ? settings.skillOverrides : undefined
  if (value === undefined) {
    if (!current || !(name in current)) return false
    delete current[name]
    if (!Object.keys(current).length) delete settings.skillOverrides
    return true
  }
  if (current?.[name] === value) return false
  settings.skillOverrides = { ...(current ?? {}), [name]: value }
  return true
}

/** Current skillOverrides value for a skill. */
export function skillOverride(settings: Record<string, unknown>, name: string): string | undefined {
  const v = isPlainObject(settings.skillOverrides) ? settings.skillOverrides[name] : undefined
  return typeof v === 'string' ? v : undefined
}
