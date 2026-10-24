import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createContext } from '../../src/core/context'
import { BackupManager, createBackupsApi } from '../../src/core/fs/backups'
import { createMemorySecretStore } from '../../src/core/secrets'
import { withSandbox, type Sandbox } from '../helpers/sandbox'

process.env.CLAUDE_SETUP_SKIP_FIXPATH = '1'

function manager(sb: Sandbox, keep = 30): BackupManager {
  return new BackupManager(join(sb.dataDir, 'backups'), () => keep)
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

describe('BackupManager', () => {
  it('snapshots existing and missing files', async () => {
    await withSandbox(async (sb) => {
      const backups = manager(sb)
      const config = join(sb.home, '.claude.json')
      const missing = join(sb.home, '.claude', 'settings.json')
      await writeFile(config, '{"projects":{}}')

      const entry = await backups.snapshot('install github', [config, missing, config])
      expect(entry.id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/)
      expect(entry.reason).toBe('install github')
      expect(entry.files).toEqual([
        { path: config, existed: true, size: 15 },
        { path: missing, existed: false, size: 0 }
      ])

      const folder = join(sb.dataDir, 'backups', entry.id)
      const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'))
      expect(manifest.files[0].stored).toBe('files/0.bak')
      expect(await readFile(join(folder, 'files', '0.bak'), 'utf8')).toBe('{"projects":{}}')

      const listed = await backups.list()
      expect(listed).toEqual([entry])
    })
  })

  it('restores files, deletes files that did not exist and keeps a safety backup', async () => {
    await withSandbox(async (sb) => {
      const backups = manager(sb)
      const config = join(sb.home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
      const created = join(sb.home, '.claude', 'settings.json')
      await mkdir(join(sb.home, 'AppData', 'Roaming', 'Claude'), { recursive: true })
      await writeFile(config, 'original')

      const before = await backups.snapshot('before change', [config, created])
      await writeFile(config, 'changed')
      await mkdir(join(sb.home, '.claude'), { recursive: true })
      await writeFile(created, 'new file')

      const result = await backups.restore(before.id)
      expect(result.ok).toBe(true)
      expect(result.needsRestart).toBe(true) // a Claude Desktop config was restored
      expect(result.backupId).toBeDefined()
      expect(await readFile(config, 'utf8')).toBe('original')
      expect(await exists(created)).toBe(false)

      const list = await backups.list()
      expect(list[0].id).toBe(result.backupId)
      expect(list[0].reason).toBe(`before restore ${before.id}`)
      expect(list[1].id).toBe(before.id)

      // The safety backup brings back the state from just before the restore.
      const undo = await backups.restore(result.backupId as string)
      expect(undo.ok).toBe(true)
      expect(await readFile(config, 'utf8')).toBe('changed')
      expect(await readFile(created, 'utf8')).toBe('new file')
    })
  })

  it('recreates missing folders when restoring', async () => {
    await withSandbox(async (sb) => {
      const backups = manager(sb)
      const file = join(sb.home, 'deep', 'nested', 'config.json')
      await mkdir(join(sb.home, 'deep', 'nested'), { recursive: true })
      await writeFile(file, '{"a":1}')
      const entry = await backups.snapshot('nested', [file])
      await rm(join(sb.home, 'deep'), { recursive: true, force: true })
      expect((await backups.restore(entry.id)).ok).toBe(true)
      expect(await readFile(file, 'utf8')).toBe('{"a":1}')
    })
  })

  it('creates unique ids within the same second and lists newest first', async () => {
    await withSandbox(async (sb) => {
      const backups = manager(sb)
      const file = join(sb.home, 'a.json')
      await writeFile(file, '{}')
      const entries = await Promise.all(Array.from({ length: 8 }, (_, i) => backups.snapshot(`snap ${i}`, [file])))
      const ids = new Set(entries.map((e) => e.id))
      expect(ids.size).toBe(8)
      const listed = await backups.list()
      expect(listed.map((e) => e.reason)).toEqual(entries.map((e) => e.reason).reverse())
      for (let i = 1; i < listed.length; i++) expect(listed[i - 1].createdAt > listed[i].createdAt).toBe(true)
    })
  })

  it('prunes to keep() newest backups', async () => {
    await withSandbox(async (sb) => {
      const backups = manager(sb, 3)
      const file = join(sb.home, 'a.json')
      await writeFile(file, '{}')
      const made = []
      for (let i = 0; i < 5; i++) made.push(await backups.snapshot(`snap ${i}`, [file]))
      const listed = await backups.list()
      expect(listed.map((e) => e.id)).toEqual(made.slice(2).map((e) => e.id).reverse())
      expect((await readdir(join(sb.dataDir, 'backups'))).length).toBe(3)
    })
  })

  it('never prunes the backup being restored, even with keep() = 1', async () => {
    await withSandbox(async (sb) => {
      const backups = manager(sb, 1)
      const file = join(sb.home, 'a.json')
      await writeFile(file, 'v1')
      const first = await backups.snapshot('v1', [file])
      await writeFile(file, 'v2')
      const result = await backups.restore(first.id)
      expect(result.ok).toBe(true)
      expect(await readFile(file, 'utf8')).toBe('v1')
      const listed = await backups.list()
      expect(listed.map((e) => e.id)).toContain(result.backupId)
    })
  })

  it('treats keep() errors and nonsense values safely', async () => {
    await withSandbox(async (sb) => {
      const file = join(sb.home, 'a.json')
      await writeFile(file, '{}')
      const throwing = new BackupManager(join(sb.dataDir, 'backups'), () => {
        throw new Error('state not loaded')
      })
      await throwing.snapshot('one', [file])
      const zero = new BackupManager(join(sb.dataDir, 'backups'), () => 0)
      const latest = await zero.snapshot('two', [file])
      expect((await zero.list()).map((e) => e.id)).toEqual([latest.id])
    })
  })

  it('skips damaged backups when listing', async () => {
    await withSandbox(async (sb) => {
      const backups = manager(sb)
      const file = join(sb.home, 'a.json')
      await writeFile(file, '{}')
      const good = await backups.snapshot('good', [file])
      await mkdir(join(sb.dataDir, 'backups', '20260101-000000-abcd'), { recursive: true })
      await writeFile(join(sb.dataDir, 'backups', '20260101-000000-abcd', 'manifest.json'), '{ broken')
      await mkdir(join(sb.dataDir, 'backups', 'not-a-backup'), { recursive: true })
      expect((await backups.list()).map((e) => e.id)).toEqual([good.id])
      expect((await backups.restore('20260101-000000-abcd')).ok).toBe(false)
    })
  })

  it('deletes backups and rejects unknown or unsafe ids', async () => {
    await withSandbox(async (sb) => {
      const backups = manager(sb)
      const file = join(sb.home, 'a.json')
      await writeFile(file, '{}')
      const entry = await backups.snapshot('x', [file])
      expect((await backups.delete(entry.id)).ok).toBe(true)
      expect(await backups.list()).toEqual([])
      expect((await backups.delete(entry.id)).ok).toBe(false)
      expect((await backups.delete('../../etc')).ok).toBe(false)
      expect((await backups.restore('..\\..\\Windows')).ok).toBe(false)
    })
  })

  it('refuses to restore an incomplete backup and changes nothing', async () => {
    await withSandbox(async (sb) => {
      const backups = manager(sb)
      const file = join(sb.home, 'a.json')
      await writeFile(file, 'original')
      const entry = await backups.snapshot('x', [file])
      await rm(join(sb.dataDir, 'backups', entry.id, 'files', '0.bak'))
      await writeFile(file, 'current')
      const result = await backups.restore(entry.id)
      expect(result.ok).toBe(false)
      expect(await readFile(file, 'utf8')).toBe('current')
      expect((await backups.list()).length).toBe(1)
    })
  })

  it('records folders without copying them, and restore leaves them alone', async () => {
    await withSandbox(async (sb) => {
      const backups = manager(sb)
      const folderAsFile = join(sb.home, 'some-folder')
      await mkdir(folderAsFile)
      const entry = await backups.snapshot('folder', [folderAsFile])
      expect(entry.files).toEqual([{ path: folderAsFile, existed: true, size: 0 }])
      const result = await backups.restore(entry.id)
      expect(result.ok).toBe(true)
      expect((await stat(folderAsFile)).isDirectory()).toBe(true)
    })
  })
})

describe('createBackupsApi', () => {
  it('wraps ctx.backups and emits state events', async () => {
    await withSandbox(async (sb) => {
      const ctx = await createContext({ surface: 'cli', appVersion: '0.0.0-test', dataDir: sb.dataDir, secretStore: createMemorySecretStore() })
      const api = createBackupsApi(ctx)
      const events: string[] = []
      ctx.events.on('state', (e) => events.push(e.key))

      const file = join(sb.home, 'a.json')
      await writeFile(file, 'one')
      const entry = await ctx.backups.snapshot('api test', [file])
      expect((await api.list()).map((e) => e.id)).toEqual([entry.id])

      await writeFile(file, 'two')
      const restored = await api.restore(entry.id)
      expect(restored.ok).toBe(true)
      expect(await readFile(file, 'utf8')).toBe('one')
      expect((await api.delete(entry.id)).ok).toBe(true)
      expect(events).toEqual(['backups', 'backups'])

      expect((await api.restore('nope')).ok).toBe(false)
      expect((await api.delete('nope')).ok).toBe(false)
    })
  })
})
