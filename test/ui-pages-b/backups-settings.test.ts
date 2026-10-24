import { describe, expect, it } from 'vitest'
import type { AppSettings, BackupEntry, TargetInfo } from '@shared/types'
import { backupSize, baseName, describeBackupFile, groupBackups, matchesBackup, sortBackups } from '../../src/renderer/src/pages/backups/logic'
import { KEY_META, SOURCE_META, SOURCE_ORDER, isDefaultTarget, keyRef, toggleDefaultTarget, ttlLabel, withCurrent } from '../../src/renderer/src/pages/settings/meta'

function entry(id: string, createdAt: string, reason = 'Change', files: BackupEntry['files'] = []): BackupEntry {
  return { id, createdAt, reason, files }
}

describe('pages-b/backups', () => {
  it('names backed-up files in plain words', () => {
    expect(describeBackupFile('C:\\Users\\you\\AppData\\Roaming\\Claude\\claude_desktop_config.json')).toBe('Claude Desktop settings')
    expect(describeBackupFile('C:\\Users\\you\\.claude.json')).toBe('Claude Code tools and projects')
    expect(describeBackupFile('/home/you/.claude/settings.json')).toBe('Claude Code settings')
    expect(describeBackupFile('/home/you/proj/.claude/settings.local.json')).toBe('Claude Code local settings')
    expect(describeBackupFile('/home/you/proj/.mcp.json')).toBe('Project tools (.mcp.json)')
    expect(describeBackupFile('C:\\Users\\you\\AppData\\Roaming\\Code\\User\\settings.json')).toBe('VS Code settings')
    expect(describeBackupFile('C:\\Users\\you\\AppData\\Roaming\\Code\\User\\mcp.json')).toBe('VS Code tools')
    expect(describeBackupFile('/Users/you/Library/Application Support/Code/User/profiles/abc/settings.json')).toBe('VS Code settings')
    expect(describeBackupFile('/home/you/.cursor/mcp.json')).toBe('Cursor tools')
    expect(describeBackupFile('/home/you/.config/devin/mcp_config.json')).toBe('Windsurf tools')
    expect(describeBackupFile('/home/you/.claude/CLAUDE.md')).toBe('CLAUDE.md instructions')
    expect(describeBackupFile('C:\\Users\\you\\.gitconfig')).toBe('Git settings')
    expect(describeBackupFile('/tmp/other.json')).toBe('other.json')
    expect(baseName('C:\\a\\b\\c.json')).toBe('c.json')
  })

  it('sums sizes of files that existed', () => {
    expect(
      backupSize(
        entry('a', '2026-10-23T10:00:00Z', 'x', [
          { path: '/a', existed: true, size: 100 },
          { path: '/b', existed: false, size: 50 }
        ])
      )
    ).toBe(100)
  })

  it('sorts newest first and groups by day', () => {
    const now = new Date(2026, 9, 23, 22, 0, 0)
    const at = (d: number, h: number): string => new Date(2026, 9, d, h, 0, 0).toISOString()
    const list = [
      entry('old', new Date(2026, 8, 2, 9).toISOString()),
      entry('today2', at(23, 9)),
      entry('yesterday', at(22, 23)),
      entry('today1', at(23, 21)),
      entry('week', at(19, 8)),
      entry('bad', 'not a date')
    ]
    expect(sortBackups(list).map((e) => e.id)).toEqual(['today1', 'today2', 'yesterday', 'week', 'old', 'bad'])
    const groups = groupBackups(list, now)
    expect(groups.map((g) => [g.label, g.entries.map((e) => e.id)])).toEqual([
      ['Today', ['today1', 'today2']],
      ['Yesterday', ['yesterday']],
      ['Earlier this week', ['week']],
      ['September 2026', ['old']],
      ['Unknown date', ['bad']]
    ])
  })

  it('searches reasons, ids, paths and friendly names', () => {
    const e = entry('20261023-101010-abcd', '2026-10-23T10:10:10Z', 'Install "github" in Claude Code', [
      { path: 'C:\\Users\\you\\.claude.json', existed: true, size: 1 }
    ])
    expect(matchesBackup(e, 'github')).toBe(true)
    expect(matchesBackup(e, 'claude.json')).toBe(true)
    expect(matchesBackup(e, 'tools and projects')).toBe(true)
    expect(matchesBackup(e, 'abcd')).toBe(true)
    expect(matchesBackup(e, 'vscode')).toBe(false)
    expect(matchesBackup(e, '')).toBe(true)
  })
})

describe('pages-b/settings', () => {
  it('describes every catalog source', () => {
    expect(SOURCE_ORDER).toHaveLength(Object.keys(SOURCE_META).length)
    expect(SOURCE_META.glama.needsKey).toBe('glamaKeyRef')
    expect(KEY_META.map((k) => k.id)).toEqual(['github', 'smithery', 'glama', 'pulsemcp'])
    expect(KEY_META.every((k) => /^[\w.:@/+=#,-]{1,200}$/.test(k.defaultRef))).toBe(true)
  })

  it('uses the saved secret reference, else the default', () => {
    const meta = KEY_META[0]!
    expect(keyRef(null, meta)).toBe(meta.defaultRef)
    expect(keyRef({ githubTokenRef: 'custom:ref' } as Pick<AppSettings, 'githubTokenRef'>, meta)).toBe('custom:ref')
  })

  it('keeps the current value in choice lists', () => {
    expect(withCurrent([10, 30], 25)).toEqual([10, 25, 30])
    expect(withCurrent([10, 30], 30)).toEqual([10, 30])
    expect(ttlLabel(24)).toBe('Once a day')
    expect(ttlLabel(36)).toBe('Every 36 hours')
    expect(ttlLabel(1)).toBe('Every 1 hour')
  })

  it('toggles default install targets with sensible scopes', () => {
    const target = (id: TargetInfo['id'], scopes: TargetInfo['scopes']): TargetInfo => ({
      id,
      label: id,
      description: '',
      installed: true,
      configExists: true,
      configValid: true,
      supportsRemote: true,
      scopes,
      serverCount: 0,
      notes: [],
      primary: false
    })
    const current = [{ target: 'claude-desktop' as const }]
    expect(toggleDefaultTarget(current, target('claude-code', ['user', 'project', 'local']), true)).toEqual([
      { target: 'claude-desktop' },
      { target: 'claude-code', scope: 'user' }
    ])
    expect(toggleDefaultTarget(current, target('claude-desktop', ['user']), true)).toEqual([{ target: 'claude-desktop' }])
    expect(toggleDefaultTarget(current, target('claude-desktop', ['user']), false)).toEqual([])
    expect(isDefaultTarget({ defaultTargets: current }, 'claude-desktop')).toBe(true)
    expect(isDefaultTarget(undefined, 'claude-desktop')).toBe(false)
  })
})
