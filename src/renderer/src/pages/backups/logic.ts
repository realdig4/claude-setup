/**
 * Pure helpers for the Backups page: friendly names for backed-up files, newest-first day groups and search.
 * No React or DOM (unit-tested in Node).
 */
import type { BackupEntry } from '@shared/types'

/** Last path segment ("C:\a\b.json" → "b.json"). */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

const FILE_NAMES: Array<{ test: RegExp; name: string }> = [
  { test: /claude_desktop_config\.json$/i, name: 'Claude Desktop settings' },
  { test: /(^|[\\/])\.claude\.json$/i, name: 'Claude Code tools and projects' },
  { test: /[\\/]\.claude[\\/]settings\.local\.json$/i, name: 'Claude Code local settings' },
  { test: /[\\/]\.claude[\\/]settings\.json$/i, name: 'Claude Code settings' },
  { test: /(^|[\\/])\.mcp\.json$/i, name: 'Project tools (.mcp.json)' },
  { test: /[\\/]\.vscode[\\/]mcp\.json$/i, name: 'VS Code project tools' },
  { test: /[\\/](Code|Code - Insiders|VSCodium)[\\/]User[\\/]mcp\.json$/i, name: 'VS Code tools' },
  { test: /[\\/](Code|Code - Insiders|VSCodium)[\\/]User[\\/](profiles[\\/][^\\/]+[\\/])?settings\.json$/i, name: 'VS Code settings' },
  { test: /[\\/]Cursor[\\/]User[\\/]settings\.json$/i, name: 'Cursor settings' },
  { test: /[\\/]\.cursor[\\/]mcp\.json$/i, name: 'Cursor tools' },
  { test: /mcp_config\.json$/i, name: 'Windsurf tools' },
  { test: /(^|[\\/])CLAUDE(\.local)?\.md$/i, name: 'CLAUDE.md instructions' },
  { test: /(^|[\\/])\.gitconfig$|[\\/]git[\\/]config$/i, name: 'Git settings' }
]

/** A friendly name for a backed-up file ("Claude Code settings"), falling back to the file name. */
export function describeBackupFile(path: string): string {
  return FILE_NAMES.find((f) => f.test.test(path))?.name ?? baseName(path)
}

/** Total size of the files in a backup. */
export function backupSize(entry: BackupEntry): number {
  return entry.files.reduce((sum, f) => sum + (f.existed ? f.size : 0), 0)
}

/** Backups sorted newest first (invalid dates last). */
export function sortBackups(entries: readonly BackupEntry[]): BackupEntry[] {
  const time = (e: BackupEntry): number => {
    const t = new Date(e.createdAt).getTime()
    return Number.isNaN(t) ? -Infinity : t
  }
  return [...entries].sort((a, b) => time(b) - time(a))
}

/** Case-insensitive search over the reason, the files' names and paths, and the id. */
export function matchesBackup(entry: BackupEntry, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const haystack = [entry.reason, entry.id, ...entry.files.flatMap((f) => [f.path, describeBackupFile(f.path)])]
    .join(' ')
    .toLowerCase()
  return words.every((w) => haystack.includes(w))
}

export interface BackupGroup {
  label: string
  entries: BackupEntry[]
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Newest-first groups: Today, Yesterday, Earlier this week, then one group per month ("September 2026"). */
export function groupBackups(entries: readonly BackupEntry[], now: Date = new Date()): BackupGroup[] {
  const today = startOfDay(now)
  const day = 86_400_000
  const groups: BackupGroup[] = []
  const push = (label: string, entry: BackupEntry): void => {
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.entries.push(entry)
    else groups.push({ label, entries: [entry] })
  }
  for (const entry of sortBackups(entries)) {
    const date = new Date(entry.createdAt)
    if (Number.isNaN(date.getTime())) {
      push('Unknown date', entry)
      continue
    }
    const start = startOfDay(date)
    if (start >= today) push('Today', entry)
    else if (start >= today - day) push('Yesterday', entry)
    else if (start >= today - 6 * day) push('Earlier this week', entry)
    else push(date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }), entry)
  }
  return groups
}
