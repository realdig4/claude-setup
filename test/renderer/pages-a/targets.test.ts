import { describe, expect, it } from 'vitest'
import type { TargetInfo } from '@shared/types'
import {
  folderName,
  initialTargets,
  orderRefs,
  refKey,
  refLabel,
  sameRef,
  sameRefSet,
  scopeHint,
  scopeLabel,
  selectionProblem,
  sortTargets,
  userRef
} from '../../../src/renderer/src/pages/discover/lib/targets'

function info(id: TargetInfo['id'], patch: Partial<TargetInfo> = {}): TargetInfo {
  const multi = id === 'claude-code' ? ['user', 'project', 'local'] : id === 'vscode' || id === 'cursor' ? ['user', 'project'] : ['user']
  return {
    id,
    label: id,
    description: '',
    installed: true,
    configExists: true,
    configValid: true,
    supportsRemote: id !== 'claude-desktop',
    scopes: multi as TargetInfo['scopes'],
    serverCount: 0,
    notes: [],
    primary: id === 'claude-desktop' || id === 'claude-code',
    ...patch
  }
}

describe('pages-a/targets: refs', () => {
  it('builds stable keys that ignore slash direction, case and default scopes', () => {
    expect(refKey({ target: 'claude-desktop' })).toBe('claude-desktop|user|')
    expect(refKey({ target: 'claude-code' })).toBe('claude-code|user|')
    expect(sameRef({ target: 'claude-code' }, { target: 'claude-code', scope: 'user' })).toBe(true)
    expect(
      sameRef(
        { target: 'claude-code', scope: 'project', projectPath: 'C:\\Users\\you\\Acme\\' },
        { target: 'claude-code', scope: 'project', projectPath: 'c:/users/you/acme' }
      )
    ).toBe(true)
    const project = { target: 'claude-code', scope: 'project', projectPath: '/a' } as const
    expect(sameRef(project, { ...project, scope: 'local' })).toBe(false)
    // A user-scope ref never depends on a stray project path.
    expect(sameRef({ target: 'vscode', scope: 'user', projectPath: '/x' }, { target: 'vscode' })).toBe(true)
  })

  it('omits the scope for single-scope apps like the core', () => {
    expect(userRef('claude-desktop')).toEqual({ target: 'claude-desktop' })
    expect(userRef('claude-code')).toEqual({ target: 'claude-code', scope: 'user' })
  })

  it('labels scopes and refs in plain words', () => {
    expect(folderName('C:\\Users\\you\\acme-web\\')).toBe('acme-web')
    expect(folderName('/home/you/site')).toBe('site')
    expect(scopeLabel(undefined)).toBe('Everywhere')
    expect(scopeLabel('local')).toBe('This project (just me)')
    expect(scopeHint('project', 'vscode')).toContain('.vscode/mcp.json')
    expect(refLabel({ target: 'claude-desktop' })).toBe('Claude Desktop')
    expect(refLabel({ target: 'claude-code', scope: 'project', projectPath: '/p/acme' })).toBe('Claude Code · acme (shared)')
    expect(refLabel({ target: 'claude-code', scope: 'local', projectPath: '/p/acme' })).toBe('Claude Code · acme (just me)')
  })

  it('explains what is missing from a selection', () => {
    expect(selectionProblem([])).toBe('Choose at least one app.')
    expect(selectionProblem([{ target: 'claude-code', scope: 'project' }])).toBe('Choose a project folder for Claude Code.')
    expect(selectionProblem([{ target: 'claude-code', scope: 'project', projectPath: '/p' }])).toBeNull()
  })

  it('compares and orders sets of refs', () => {
    const a = [{ target: 'vscode' as const }, { target: 'claude-desktop' as const }]
    const b = [{ target: 'claude-desktop' as const }, { target: 'vscode' as const, scope: 'user' as const }]
    expect(sameRefSet(a, b)).toBe(true)
    expect(sameRefSet([{ target: 'vscode' }], [{ target: 'cursor' }])).toBe(false)
    expect(orderRefs([{ target: 'windsurf' }, { target: 'claude-desktop' }]).map((r) => r.target)).toEqual(['claude-desktop', 'windsurf'])
  })
})

describe('pages-a/targets: wizard defaults', () => {
  const targets = [
    info('claude-desktop'),
    info('claude-code'),
    info('vscode'),
    info('cursor', { installed: false, primary: false }),
    info('windsurf', { installed: false })
  ]

  it('keeps installed defaults and drops missing apps', () => {
    const picked = initialTargets([{ target: 'cursor' }, { target: 'claude-desktop' }, { target: 'claude-code', scope: 'user' }], targets)
    expect(picked).toEqual([{ target: 'claude-desktop' }, { target: 'claude-code', scope: 'user' }])
  })

  it('falls back to everywhere when a project default has no folder', () => {
    expect(initialTargets([{ target: 'claude-code', scope: 'project' }], targets)).toEqual([{ target: 'claude-code', scope: 'user' }])
    expect(initialTargets([{ target: 'claude-code', scope: 'local', projectPath: '/p' }], targets)).toEqual([
      { target: 'claude-code', scope: 'local', projectPath: '/p' }
    ])
  })

  it('uses the first installed primary app when nothing else fits', () => {
    expect(initialTargets([{ target: 'cursor' }], targets)).toEqual([{ target: 'claude-desktop' }])
    const onlyCode = targets.map((t) => (t.id === 'claude-desktop' ? { ...t, installed: false } : t))
    expect(initialTargets([], onlyCode)).toEqual([{ target: 'claude-code', scope: 'user' }])
    expect(initialTargets([], targets.map((t) => ({ ...t, installed: false })))).toEqual([])
  })

  it('sorts primary and installed apps first', () => {
    const order = sortTargets([
      info('windsurf', { installed: false, primary: false }),
      info('vscode', { primary: false }),
      info('claude-code'),
      info('claude-desktop', { installed: false })
    ])
    expect(order.map((t) => t.id)).toEqual(['claude-code', 'claude-desktop', 'vscode', 'windsurf'])
  })
})
