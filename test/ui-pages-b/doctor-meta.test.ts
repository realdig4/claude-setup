import { describe, expect, it } from 'vitest'
import type { DoctorCheck, DoctorReport, RuntimeInfo } from '@shared/types'
import {
  CATEGORY_META,
  CATEGORY_ORDER,
  STATUS_META,
  attentionChecks,
  fixImpact,
  groupChecks,
  otherChecks,
  reportHeadline,
  runtimeState,
  visibleRuntimes,
  worstStatus
} from '../../src/renderer/src/pages/doctor/meta'

const checks: DoctorCheck[] = [
  { id: 'node', category: 'runtimes', title: 'Node ok', status: 'ok' },
  { id: 'uv', category: 'runtimes', title: 'uv missing', status: 'warn', fix: { id: 'install-runtime:uv', label: 'Install uv', auto: true } },
  { id: 'restart', category: 'claude-desktop', title: 'Restart', status: 'info', fix: { id: 'restart-desktop', label: 'Restart now', auto: true } },
  { id: 'note', category: 'system', title: 'Note', status: 'info' },
  { id: 'orphan', category: 'mcp', title: 'Broken', status: 'error', fix: { id: 'remove-invalid-desktop-entries', label: 'Remove it', auto: true } },
  { id: 'manual', category: 'claude-code', title: 'Manual', status: 'warn', fix: { id: 'manual', label: 'Do it yourself', auto: false } },
  { id: 'skip', category: 'system', title: 'Skipped', status: 'skip' }
]

function report(list: DoctorCheck[]): DoctorReport {
  const summary = { ok: 0, warn: 0, error: 0, info: 0, skip: 0 }
  for (const c of list) summary[c.status]++
  return { ranAt: '2026-10-23T21:00:00Z', checks: list, summary }
}

describe('pages-b/doctor: grouping and order', () => {
  it('lists checks needing attention worst first', () => {
    expect(attentionChecks(checks).map((c) => c.id)).toEqual(['orphan', 'uv', 'manual', 'restart'])
    expect(otherChecks(checks).map((c) => c.id)).toEqual(['node', 'note', 'skip'])
  })

  it('groups by category in display order, worst first inside a group', () => {
    const groups = groupChecks(checks)
    expect(groups.map((g) => g.category)).toEqual(['runtimes', 'claude-desktop', 'claude-code', 'mcp', 'system'])
    expect(groups[0]?.checks.map((c) => c.id)).toEqual(['uv', 'node'])
    expect(groups[4]?.checks.map((c) => c.id)).toEqual(['note', 'skip'])
    expect(CATEGORY_ORDER.every((c) => CATEGORY_META[c].title)).toBe(true)
  })

  it('finds the worst status', () => {
    expect(worstStatus(checks)).toBe('error')
    expect(worstStatus([])).toBe('ok')
    expect(worstStatus([checks[0]!, checks[3]!])).toBe('info')
    expect(STATUS_META.error.tone).toBe('danger')
  })
})

describe('pages-b/doctor: headline', () => {
  it('summarises problems, warnings or a clean bill of health', () => {
    expect(reportHeadline(report(checks))).toMatchObject({ title: '1 problem found', tone: 'danger' })
    expect(reportHeadline(report(checks)).subtitle).toMatch(/3 one-click fixes/)
    expect(reportHeadline(report(checks.filter((c) => c.status !== 'error')))).toMatchObject({ title: '2 things to look at', tone: 'warn' })
    expect(reportHeadline(report([checks[0]!]))).toMatchObject({ title: 'Everything looks good', tone: 'success' })
    expect(reportHeadline(report([checks[5]!])).subtitle).toBe('See below for what to do.')
  })
})

describe('pages-b/doctor: fixes', () => {
  it('asks before installing, restarting or changing files', () => {
    expect(fixImpact('install-runtime:uv', 'Install uv')).toMatchObject({ kind: 'install', confirm: true, title: 'Install uv?' })
    expect(fixImpact('install-uv', 'Install uv').kind).toBe('install')
    expect(fixImpact('restart-desktop', 'Restart now')).toMatchObject({ kind: 'restart', confirm: true })
    expect(fixImpact('fix-auth-conflict', 'Keep only one credential')).toMatchObject({ kind: 'files', confirm: true })
    expect(fixImpact('fix-auth-conflict', 'x').description).toMatch(/backup/i)
    expect(fixImpact('start-proxy', 'Start the proxy')).toMatchObject({ kind: 'process', confirm: false })
    expect(fixImpact('something-new', 'Do it')).toMatchObject({ kind: 'other', confirm: true })
  })
})

describe('pages-b/doctor: runtimes', () => {
  const base = { label: 'X', purpose: 'p' }
  const list: RuntimeInfo[] = [
    { ...base, id: 'node', found: true, version: '24.0.0' },
    { ...base, id: 'npx', found: true },
    { ...base, id: 'docker', found: true, running: false },
    { ...base, id: 'uv', found: false },
    { ...base, id: 'python', found: true, outdated: true },
    { ...base, id: 'winget', found: true }
  ]

  it('hides bundled helpers in Simple mode', () => {
    expect(visibleRuntimes(list, false).map((r) => r.id)).toEqual(['node', 'docker', 'uv', 'python'])
    expect(visibleRuntimes(list, true)).toHaveLength(6)
  })

  it('derives a runtime state', () => {
    expect(list.map(runtimeState)).toEqual(['ok', 'ok', 'stopped', 'missing', 'outdated', 'ok'])
  })
})
