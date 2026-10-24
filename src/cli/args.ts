/**
 * Argument parsing helpers for the CLI (pure; unit-tested): target aliases, KEY=VALUE pairs,
 * scopes and numbers. Parsers throw commander's InvalidArgumentError with a friendly message.
 */
import { isAbsolute, resolve } from 'node:path'
import { InvalidArgumentError } from 'commander'
import type { ExtensionKind, ModelTarget, Scope, TargetId, TargetRef } from '@shared/types'
import { CliError, EXIT } from './errors'

/** Accepted spellings for --target values. */
export const TARGET_ALIASES: Record<string, TargetId> = {
  desktop: 'claude-desktop',
  'claude-desktop': 'claude-desktop',
  claude: 'claude-desktop',
  code: 'claude-code',
  'claude-code': 'claude-code',
  cli: 'claude-code',
  cc: 'claude-code',
  vscode: 'vscode',
  'vs-code': 'vscode',
  cursor: 'cursor',
  windsurf: 'windsurf'
}

/** Every app, in display order. */
export const ALL_TARGET_IDS: TargetId[] = ['claude-desktop', 'claude-code', 'vscode', 'cursor', 'windsurf']

/** Accepted spellings for model --target values. */
export const MODEL_TARGET_ALIASES: Record<string, ModelTarget> = {
  code: 'claude-code',
  'claude-code': 'claude-code',
  cli: 'claude-code',
  cc: 'claude-code',
  vscode: 'vscode',
  'vs-code': 'vscode'
}

/** Extension kinds accepted by --kind. */
export const EXTENSION_KINDS: ExtensionKind[] = ['plugin', 'skill', 'agent', 'command', 'hook', 'statusline', 'output-style']

function splitList(values: string | string[]): string[] {
  return (Array.isArray(values) ? values : [values])
    .flatMap((v) => v.split(','))
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
}

/** "desktop,code" (or repeated flags) → ['claude-desktop', 'claude-code']. "all" selects every app. */
export function parseTargetList(values: string | string[]): TargetId[] {
  const out: TargetId[] = []
  for (const item of splitList(values)) {
    if (item === 'all') return [...ALL_TARGET_IDS]
    const id = TARGET_ALIASES[item]
    if (!id) {
      throw new InvalidArgumentError(`Unknown app "${item}". Use one of: desktop, code, vscode, cursor, windsurf (or all).`)
    }
    if (!out.includes(id)) out.push(id)
  }
  return out
}

/** "code,vscode" → ['claude-code', 'vscode']. */
export function parseModelTargets(values: string | string[]): ModelTarget[] {
  const out: ModelTarget[] = []
  for (const item of splitList(values)) {
    if (item === 'all') return ['claude-code', 'vscode']
    const id = MODEL_TARGET_ALIASES[item]
    if (!id) throw new InvalidArgumentError(`Unknown target "${item}". Use code and/or vscode.`)
    if (!out.includes(id)) out.push(id)
  }
  return out
}

/** Commander accumulator for repeatable options. */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value]
}

/** What a NAME=value pair is for (decides which names are valid). */
export type PairKind = 'env' | 'header' | 'arg'

const KEY_RULES: Record<PairKind, { re: RegExp; what: string }> = {
  env: { re: /^[A-Za-z_][A-Za-z0-9_]*$/, what: 'an environment variable name (letters, digits, _)' },
  header: { re: /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, what: 'an HTTP header name' },
  arg: { re: /^[A-Za-z0-9_.:-]+$/, what: 'an argument name' }
}

/** Split "KEY=VALUE" at the first "=" (the value may contain "=" and be empty). */
export function parsePair(pair: string, kind: PairKind): [string, string] {
  const at = pair.indexOf('=')
  if (at <= 0) throw new InvalidArgumentError(`"${pair}" should look like NAME=value.`)
  const key = pair.slice(0, at).trim()
  const value = pair.slice(at + 1)
  if (!KEY_RULES[kind].re.test(key)) throw new InvalidArgumentError(`"${key}" is not ${KEY_RULES[kind].what}.`)
  return [key, value]
}

/** KEY=VALUE list → object (later values win). */
export function pairsToRecord(pairs: string[] | undefined, kind: 'env' | 'header'): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of pairs ?? []) {
    const [k, v] = parsePair(pair, kind)
    out[k] = v
  }
  return out
}

/** NAME=VALUE list → argument values; a repeated name becomes a list (repeatable arguments). */
export function pairsToArgValues(pairs: string[] | undefined): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const pair of pairs ?? []) {
    const [k, v] = parsePair(pair, 'arg')
    const prev = out[k]
    out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v]
  }
  return out
}

/** Commander parser for --scope. */
export function parseScope(value: string): Scope {
  const v = value.trim().toLowerCase()
  if (v === 'user' || v === 'project' || v === 'local') return v
  throw new InvalidArgumentError('Use user, project or local.')
}

/** Commander parser for positive whole numbers. */
export function parsePositiveInt(value: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('Use a whole number of 1 or more.')
  return n
}

/** Commander parser for --kind (accepts plurals and common aliases). */
export function parseExtensionKind(value: string): ExtensionKind {
  const v = value.trim().toLowerCase().replace(/s$/, '') as ExtensionKind
  const alias: Record<string, ExtensionKind> = { subagent: 'agent', 'slash-command': 'command', 'status-line': 'statusline', style: 'output-style' }
  const kind = alias[v] ?? v
  if (EXTENSION_KINDS.includes(kind)) return kind
  throw new InvalidArgumentError(`Use one of: ${EXTENSION_KINDS.join(', ')}.`)
}

/**
 * Target ids + scope → TargetRefs. Scope applies to Claude Code (user/project/local) and VS Code
 * (user/project). Project and local scopes use `projectPath`, defaulting to the current folder.
 */
export function buildTargetRefs(ids: TargetId[], scope: Scope | undefined, projectPath: string | undefined, cwd: string): TargetRef[] {
  const needsProject = scope === 'project' || scope === 'local'
  const folder = needsProject ? (projectPath ? (isAbsolute(projectPath) ? projectPath : resolve(cwd, projectPath)) : cwd) : undefined
  return ids.map((target) => {
    if (target === 'claude-code' && scope) return { target, scope, ...(folder ? { projectPath: folder } : {}) }
    if (target === 'vscode' && scope) {
      if (scope === 'local') throw new CliError('VS Code supports the user and project scopes only.', EXIT.usage)
      return { target, scope, ...(folder ? { projectPath: folder } : {}) }
    }
    return { target }
  })
}
