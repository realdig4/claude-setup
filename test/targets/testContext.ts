/**
 * A CoreContext for TARGETS / SERVERS tests: real StateStore in the sandbox data dir, in-memory secrets, and a
 * simple backup manager that records the content of every file it was asked to back up.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BackupEntry, LogEvent } from '@shared/types'
import type { CoreContext } from '@core/context'
import { CoreEmitter } from '@core/events'
import type { BackupManager } from '@core/fs/backups'
import { createMemorySecretStore, type SecretStore } from '@core/secrets'
import { StateStore } from '@core/state'
import type { Sandbox } from '../helpers/sandbox'

export interface RecordedBackup extends BackupEntry {
  /** File contents at backup time (null when the file did not exist). */
  contents: Record<string, string | null>
}

export interface TestContext extends CoreContext {
  backupsTaken: RecordedBackup[]
  logs: LogEvent[]
  secretStore: SecretStore
  /** Make the next snapshot() fail. */
  failNextBackup(): void
}

export async function createTestContext(sb: Sandbox): Promise<TestContext> {
  const state = new StateStore(join(sb.dataDir, 'state.json'))
  await state.load()
  const events = new CoreEmitter()
  const logs: LogEvent[] = []
  events.on('log', (e) => logs.push(e))
  const backupsTaken: RecordedBackup[] = []
  let failNext = false
  let n = 0
  const backups = {
    dir: join(sb.dataDir, 'backups'),
    keep: () => 30,
    async snapshot(reason: string, paths: string[]): Promise<BackupEntry> {
      if (failNext) {
        failNext = false
        throw new Error('disk full (test)')
      }
      const contents: Record<string, string | null> = {}
      const files: BackupEntry['files'] = []
      for (const p of paths) {
        try {
          const text = await readFile(p, 'utf8')
          contents[p] = text
          files.push({ path: p, existed: true, size: Buffer.byteLength(text) })
        } catch {
          contents[p] = null
          files.push({ path: p, existed: false, size: 0 })
        }
      }
      const entry: RecordedBackup = { id: `test-backup-${++n}`, createdAt: new Date().toISOString(), reason, files, contents }
      backupsTaken.push(entry)
      return entry
    },
    async list() {
      return [...backupsTaken].reverse()
    },
    async restore() {
      return { ok: false, message: 'Not supported in tests.' }
    },
    async delete() {
      return { ok: true, message: 'Deleted.' }
    }
  } as unknown as BackupManager
  const secretStore = createMemorySecretStore()
  const log = {
    debug: (scope: string, message: string) => events.emitEvent('log', { time: new Date().toISOString(), level: 'debug', scope, message }),
    info: (scope: string, message: string) => events.emitEvent('log', { time: new Date().toISOString(), level: 'info', scope, message }),
    warn: (scope: string, message: string) => events.emitEvent('log', { time: new Date().toISOString(), level: 'warn', scope, message }),
    error: (scope: string, message: string) => events.emitEvent('log', { time: new Date().toISOString(), level: 'error', scope, message })
  }
  return {
    options: { surface: 'cli', appVersion: '0.0.0-test' },
    dataDir: sb.dataDir,
    cacheDir: join(sb.dataDir, 'cache'),
    state,
    secrets: secretStore,
    secretStore,
    backups,
    events,
    log,
    backupsTaken,
    logs,
    failNextBackup() {
      failNext = true
    }
  }
}
