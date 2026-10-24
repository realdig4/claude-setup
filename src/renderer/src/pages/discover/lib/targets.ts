/**
 * Pure helpers for apps ("targets") and where in them a tool is saved ("scopes"): plain-words labels,
 * stable keys, comparisons and the install wizard's defaults. No React / DOM imports (unit-tested in Node).
 */
import type { Scope, TargetId, TargetInfo, TargetRef } from '@shared/types'

/** Display order of apps everywhere in the UI (matches the core). */
export const TARGET_ORDER: readonly TargetId[] = ['claude-desktop', 'claude-code', 'vscode', 'cursor', 'windsurf']

/** Product names. */
export const TARGET_NAMES: Record<TargetId, string> = {
  'claude-desktop': 'Claude Desktop',
  'claude-code': 'Claude Code',
  vscode: 'VS Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf'
}

/** Scopes each app supports; the first one is the default (mirrors the core). */
export const TARGET_SCOPES: Record<TargetId, readonly Scope[]> = {
  'claude-desktop': ['user'],
  'claude-code': ['user', 'project', 'local'],
  vscode: ['user', 'project'],
  cursor: ['user', 'project'],
  windsurf: ['user']
}

/** Does this scope need a project folder? */
export function needsProject(scope: Scope | undefined): boolean {
  return scope === 'project' || scope === 'local'
}

/** Last segment of a folder path ("C:\\Users\\you\\acme-web" → "acme-web"). */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || trimmed || path
}

/** Comparable form of a path: forward slashes, no trailing slash, lower case. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** The same folder (ignores slash direction, trailing slashes and letter case)? */
export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b)
}

/** Stable key for a ref, e.g. "claude-code|project|c:/users/you/acme". */
export function refKey(ref: TargetRef): string {
  const scope = ref.scope ?? TARGET_SCOPES[ref.target]?.[0] ?? 'user'
  const project = needsProject(scope) ? normalizePath(ref.projectPath ?? '') : ''
  return `${ref.target}|${scope}|${project}`
}

/** Do both refs point at the same place? */
export function sameRef(a: TargetRef, b: TargetRef): boolean {
  return refKey(a) === refKey(b)
}

/** The "everywhere" ref of an app (scope left out for single-scope apps, like the core does). */
export function userRef(target: TargetId): TargetRef {
  return TARGET_SCOPES[target].length > 1 ? { target, scope: 'user' } : { target }
}

/** Short plain-words name of a scope. */
export function scopeLabel(scope: Scope | undefined): string {
  if (scope === 'project') return 'This project (shared)'
  if (scope === 'local') return 'This project (just me)'
  return 'Everywhere'
}

/** One sentence explaining what a scope means for an app. */
export function scopeHint(scope: Scope | undefined, target: TargetId): string {
  if (scope === 'project') {
    const file = target === 'vscode' ? '.vscode/mcp.json' : target === 'cursor' ? '.cursor/mcp.json' : '.mcp.json'
    return `Saved in the project’s ${file}, so everyone who works on it gets the tool.`
  }
  if (scope === 'local') return 'Only for you, and only in this project.'
  return target === 'claude-code' ? 'Available in every project.' : 'Available everywhere in this app.'
}

/** "Claude Code", "Claude Code · acme-web (shared)", "Claude Code · acme-web (just me)". */
export function refLabel(ref: TargetRef): string {
  const name = TARGET_NAMES[ref.target]
  if (!needsProject(ref.scope)) return name
  const folder = ref.projectPath ? folderName(ref.projectPath) : 'a project'
  return `${name} · ${folder} (${ref.scope === 'local' ? 'just me' : 'shared'})`
}

/** Friendly problem with a wizard selection, or null when it can be used. */
export function selectionProblem(refs: readonly TargetRef[]): string | null {
  if (refs.length === 0) return 'Choose at least one app.'
  const missing = refs.find((r) => needsProject(r.scope) && !r.projectPath)
  if (missing) return `Choose a project folder for ${TARGET_NAMES[missing.target]}.`
  return null
}

/**
 * Apps preselected in the install wizard: the saved defaults that are installed here (one per app), or else
 * the first installed primary app. Project scopes without a folder fall back to "everywhere".
 */
export function initialTargets(defaults: readonly TargetRef[], targets: readonly TargetInfo[]): TargetRef[] {
  const installed = new Map(targets.filter((t) => t.installed).map((t) => [t.id, t]))
  const picked: TargetRef[] = []
  for (const ref of defaults) {
    const info = installed.get(ref.target)
    if (!info || picked.some((p) => p.target === ref.target)) continue
    const scopes = info.scopes.length ? info.scopes : TARGET_SCOPES[ref.target]
    const scope = ref.scope && scopes.includes(ref.scope) ? ref.scope : scopes[0]
    if (needsProject(scope) && ref.projectPath) picked.push({ target: ref.target, scope, projectPath: ref.projectPath })
    else picked.push(userRef(ref.target))
  }
  if (picked.length) return orderRefs(picked)
  const fallback = targets.find((t) => t.installed && t.primary) ?? targets.find((t) => t.installed)
  return fallback ? [userRef(fallback.id)] : []
}

/** Refs sorted in display order (stable for refs of the same app). */
export function orderRefs(refs: readonly TargetRef[]): TargetRef[] {
  return [...refs].sort((a, b) => TARGET_ORDER.indexOf(a.target) - TARGET_ORDER.indexOf(b.target))
}

/** Same set of places (order-insensitive)? */
export function sameRefSet(a: readonly TargetRef[], b: readonly TargetRef[]): boolean {
  if (a.length !== b.length) return false
  const keys = new Set(a.map(refKey))
  return b.every((r) => keys.has(refKey(r)))
}

/** Targets in display order: primary apps first, then installed ones, then the rest. */
export function sortTargets(targets: readonly TargetInfo[]): TargetInfo[] {
  const rank = (t: TargetInfo): number => (t.primary ? 0 : 2) + (t.installed ? 0 : 1)
  return [...targets].sort((a, b) => rank(a) - rank(b) || TARGET_ORDER.indexOf(a.id) - TARGET_ORDER.indexOf(b.id))
}
