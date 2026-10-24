/**
 * Pure helpers for the Health Check page: category and status wording, ordering, the summary headline and what a
 * one-click fix will do (so the UI can ask before changing files). No React or DOM (unit-tested in Node).
 */
import type { CheckStatus, DoctorCheck, DoctorReport, RuntimeInfo } from '@shared/types'

export type CheckCategory = DoctorCheck['category']
export type StatusTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info'

export const CATEGORY_ORDER: readonly CheckCategory[] = [
  'runtimes',
  'claude-desktop',
  'claude-code',
  'vscode',
  'models',
  'mcp',
  'system'
]

export const CATEGORY_META: Record<CheckCategory, { title: string; simple: string; description: string; running: string }> = {
  runtimes: {
    title: 'Runtimes',
    simple: 'Programs tools need',
    description: 'Node.js, Python, Docker and friends.',
    running: 'Checking the programs tools need…'
  },
  'claude-desktop': {
    title: 'Claude Desktop',
    simple: 'Claude Desktop',
    description: 'The Claude chat app.',
    running: 'Checking Claude Desktop…'
  },
  'claude-code': {
    title: 'Claude Code',
    simple: 'Claude Code',
    description: 'The claude command and its settings.',
    running: 'Checking Claude Code…'
  },
  vscode: { title: 'VS Code', simple: 'VS Code', description: 'The Claude Code extension for VS Code.', running: 'Checking VS Code…' },
  models: {
    title: 'Models',
    simple: 'Models',
    description: 'Which model Claude Code uses and how it signs in.',
    running: 'Checking your models…'
  },
  mcp: { title: 'MCP servers', simple: 'Your tools', description: 'The tools you added to Claude.', running: 'Checking your tools…' },
  system: {
    title: 'System',
    simple: 'This computer',
    description: 'Settings on this computer that affect Claude.',
    running: 'Checking this computer…'
  }
}

export interface StatusMeta {
  label: string
  dot: 'ok' | 'warn' | 'error' | 'idle' | 'busy'
  tone: StatusTone
  /** Plain-words meaning for Simple mode. */
  meaning: string
}

export const STATUS_META: Record<CheckStatus, StatusMeta> = {
  error: { label: 'Problem', dot: 'error', tone: 'danger', meaning: 'Something doesn’t work because of this.' },
  warn: { label: 'Warning', dot: 'warn', tone: 'warn', meaning: 'Things still work, but this could cause trouble.' },
  info: { label: 'Note', dot: 'idle', tone: 'info', meaning: 'Just so you know.' },
  ok: { label: 'OK', dot: 'ok', tone: 'success', meaning: 'All good.' },
  skip: { label: 'Skipped', dot: 'idle', tone: 'neutral', meaning: 'This check didn’t run.' }
}

const STATUS_RANK: Record<CheckStatus, number> = { error: 0, warn: 1, info: 2, ok: 3, skip: 4 }

/** Checks that need the user's attention: problems, warnings and notes that come with a fix — worst first. */
export function attentionChecks(checks: readonly DoctorCheck[]): DoctorCheck[] {
  return checks
    .filter((c) => c.status === 'error' || c.status === 'warn' || (c.status === 'info' && !!c.fix))
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])
}

/** Everything that isn't in attentionChecks(). */
export function otherChecks(checks: readonly DoctorCheck[]): DoctorCheck[] {
  const attention = new Set(attentionChecks(checks))
  return checks.filter((c) => !attention.has(c))
}

/** Checks grouped by category in display order (empty categories dropped). */
export function groupChecks(checks: readonly DoctorCheck[]): Array<{ category: CheckCategory; checks: DoctorCheck[] }> {
  const known = CATEGORY_ORDER.map((category) => ({
    category,
    checks: checks.filter((c) => c.category === category).sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])
  }))
  return known.filter((g) => g.checks.length > 0)
}

/** Worst status in a list (ok when empty). */
export function worstStatus(checks: readonly DoctorCheck[]): CheckStatus {
  return checks.reduce<CheckStatus>((worst, c) => (STATUS_RANK[c.status] < STATUS_RANK[worst] ? c.status : worst), 'ok')
}

export interface ReportHeadline {
  title: string
  subtitle: string
  tone: 'success' | 'warn' | 'danger'
}

/** Big summary line for a report. */
export function reportHeadline(report: DoctorReport): ReportHeadline {
  const errors = report.checks.filter((c) => c.status === 'error')
  const warns = report.checks.filter((c) => c.status === 'warn')
  const fixable = attentionChecks(report.checks).filter((c) => c.fix?.auto).length
  const fixLine = fixable
    ? `${fixable === 1 ? 'A one-click fix is' : `${fixable} one-click fixes are`} ready below.`
    : 'See below for what to do.'
  if (errors.length) {
    return { title: `${errors.length} ${errors.length === 1 ? 'problem' : 'problems'} found`, subtitle: fixLine, tone: 'danger' }
  }
  if (warns.length) {
    return { title: `${warns.length} ${warns.length === 1 ? 'thing' : 'things'} to look at`, subtitle: fixLine, tone: 'warn' }
  }
  return { title: 'Everything looks good', subtitle: 'Claude is ready to go.', tone: 'success' }
}

export type FixKind = 'files' | 'install' | 'restart' | 'process' | 'other'

export interface FixImpact {
  kind: FixKind
  /** Ask before running it. */
  confirm: boolean
  title: string
  description: string
}

/** Fixes known to edit a settings file (each makes a backup first). */
const FILE_FIXES = new Set([
  'remove-invalid-desktop-entries',
  'apply-model-vscode',
  'fix-auth-conflict',
  'git-longpaths',
  'enable-longpaths',
  'remove-orphan',
  'fix-claude-path'
])

/** Fixes that only start something and change no files. */
const PROCESS_FIXES = new Set(['start-proxy', 'start-docker'])

/** What a fix will do, so the UI can confirm before it changes files or installs software. */
export function fixImpact(fixId: string, label: string): FixImpact {
  const runtime = /^install-runtime:(.+)$/.exec(fixId)?.[1]
  if (runtime || /^install-/.test(fixId)) {
    const name = label.replace(/^install\s+/i, '') || runtime || 'it'
    return {
      kind: 'install',
      confirm: true,
      title: `Install ${name}?`,
      description: 'Claude Setup downloads it from the official source and installs it for you. This can take a minute or two.'
    }
  }
  if (fixId === 'restart-desktop') {
    return {
      kind: 'restart',
      confirm: true,
      title: 'Restart Claude Desktop?',
      description: 'Claude Desktop closes and opens again so it loads your changes.'
    }
  }
  if (PROCESS_FIXES.has(fixId)) return { kind: 'process', confirm: false, title: label, description: '' }
  if (FILE_FIXES.has(fixId)) {
    return {
      kind: 'files',
      confirm: true,
      title: `${label}?`,
      description: 'Claude Setup changes a settings file to fix this. A backup is made first, so you can undo it from Backups.'
    }
  }
  return {
    kind: 'other',
    confirm: true,
    title: `${label}?`,
    description: 'Claude Setup changes your setup to fix this. A backup is made before any settings file changes.'
  }
}

/** Runtimes shown in Simple mode (helpers that come bundled with another runtime are hidden). */
export function visibleRuntimes(runtimes: readonly RuntimeInfo[], advanced: boolean): RuntimeInfo[] {
  if (advanced) return [...runtimes]
  const hidden = new Set(['npx', 'uvx', 'winget', 'brew'])
  return runtimes.filter((r) => !hidden.has(r.id))
}

export type RuntimeState = 'ok' | 'outdated' | 'stopped' | 'missing'

/** Installed and usable, outdated, installed but not running (Docker), or missing. */
export function runtimeState(runtime: RuntimeInfo): RuntimeState {
  if (!runtime.found) return 'missing'
  if (runtime.outdated) return 'outdated'
  if (runtime.running === false) return 'stopped'
  return 'ok'
}
