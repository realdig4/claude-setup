import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppSettings } from '../../src/shared/types'
import { createAppApi } from '../../src/core/app'
import { createContext, type CoreContext } from '../../src/core/context'
import { createMemorySecretStore, createSecretStore } from '../../src/core/secrets'
import { withSandbox } from '../helpers/sandbox'

process.env.CLAUDE_SETUP_SKIP_FIXPATH = '1'

async function makeContext(dataDir: string, overrides: Partial<Parameters<typeof createContext>[0]> = {}): Promise<CoreContext> {
  return createContext({ surface: 'gui', appVersion: '1.2.3', dataDir, secretStore: createMemorySecretStore(), ...overrides })
}

describe('AppApi.info', () => {
  it('describes the running app', async () => {
    await withSandbox(async (sb) => {
      const selfMcpConfig = { type: 'stdio' as const, command: 'node', args: ['mcp.js'] }
      const ctx = await makeContext(sb.dataDir, { packaged: true, selfMcpConfig })
      const info = await createAppApi(ctx).info()
      expect(info).toEqual({
        name: 'Claude Setup',
        version: '1.2.3',
        platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
        arch: process.arch,
        dataDir: sb.dataDir,
        surface: 'gui',
        selfMcpConfig,
        packaged: true
      })
      const minimal = await createAppApi(await makeContext(sb.dataDir, { surface: 'cli' })).info()
      expect(minimal.packaged).toBe(false)
      expect('selfMcpConfig' in minimal).toBe(false)
    })
  })
})

describe('AppApi settings', () => {
  it('merges patches (sources per key), persists them and emits a state event', async () => {
    await withSandbox(async (sb) => {
      const ctx = await makeContext(sb.dataDir)
      const app = createAppApi(ctx)
      const events: string[] = []
      ctx.events.on('state', (e) => events.push(e.key))

      const defaults = await app.getSettings()
      expect(defaults.mode).toBe('simple')
      expect(defaults.sources.official).toBe(true)
      expect(defaults.sources.glama).toBe(false)

      const updated = await app.updateSettings({ mode: 'advanced', sources: { glama: true } as AppSettings['sources'] })
      expect(updated.mode).toBe('advanced')
      expect(updated.sources.glama).toBe(true)
      expect(updated.sources.official).toBe(true) // untouched keys survive
      expect(updated.theme).toBe(defaults.theme)
      expect(events).toEqual(['settings'])

      const second = await app.updateSettings({ sources: { official: false } as AppSettings['sources'] })
      expect(second.sources).toMatchObject({ glama: true, official: false })

      const stored = JSON.parse(await readFile(join(sb.dataDir, 'state.json'), 'utf8'))
      expect(stored.settings.mode).toBe('advanced')
      expect(stored.settings.sources.glama).toBe(true)

      const reloaded = await createAppApi(await makeContext(sb.dataDir)).getSettings()
      expect(reloaded.mode).toBe('advanced')
      expect(reloaded.sources).toMatchObject({ glama: true, official: false })
    })
  })

  it('returns copies, not live state', async () => {
    await withSandbox(async (sb) => {
      const app = createAppApi(await makeContext(sb.dataDir))
      const s = await app.getSettings()
      s.mode = 'advanced'
      s.sources.official = false
      expect((await app.getSettings()).mode).toBe('simple')
      expect((await app.getSettings()).sources.official).toBe(true)
    })
  })

  it('ignores invalid values and clamps numbers', async () => {
    await withSandbox(async (sb) => {
      const ctx = await makeContext(sb.dataDir)
      const warnings: string[] = []
      ctx.events.on('log', (e) => e.level === 'warn' && warnings.push(e.message))
      const app = createAppApi(ctx)
      const patch = {
        mode: 'expert',
        theme: 'dark',
        keepBackups: 0,
        catalogTtlHours: 100000,
        onboarded: 'yes',
        unknownKey: 1,
        sources: { official: 'no', glama: true, nonsense: true },
        recentProjects: ['/a', '', '/a', 42, '/b'],
        defaultTargets: [{ target: 'claude-code', scope: 'user' }, { target: 'nope' }, { target: 'claude-code', scope: 'project' }]
      } as unknown as Partial<AppSettings>
      const s = await app.updateSettings(patch)
      expect(s.mode).toBe('simple')
      expect(s.theme).toBe('dark')
      expect(s.keepBackups).toBe(1)
      expect(s.catalogTtlHours).toBe(720)
      expect(s.onboarded).toBe(false)
      expect(s.sources.official).toBe(true)
      expect(s.sources.glama).toBe(true)
      expect('nonsense' in s.sources).toBe(false)
      expect('unknownKey' in s).toBe(false)
      expect(s.recentProjects).toEqual(['/a', '/b'])
      expect(s.defaultTargets).toEqual([{ target: 'claude-code', scope: 'user' }])
      expect(warnings.some((w) => w.includes('mode') && w.includes('unknownKey'))).toBe(true)
    })
  })

  it('sets and clears secret-reference settings', async () => {
    await withSandbox(async (sb) => {
      const app = createAppApi(await makeContext(sb.dataDir))
      expect((await app.updateSettings({ githubTokenRef: 'github' })).githubTokenRef).toBe('github')
      const cleared = await app.updateSettings({ githubTokenRef: null } as unknown as Partial<AppSettings>)
      expect('githubTokenRef' in cleared).toBe(false)
    })
  })

  it('serializes concurrent updates without losing any', async () => {
    await withSandbox(async (sb) => {
      const app = createAppApi(await makeContext(sb.dataDir))
      await Promise.all([
        app.updateSettings({ theme: 'dark' }),
        app.updateSettings({ keepBackups: 12 }),
        app.updateSettings({ onboarded: true })
      ])
      expect(await app.getSettings()).toMatchObject({ theme: 'dark', keepBackups: 12, onboarded: true })
    })
  })
})

describe('AppApi secrets', () => {
  it('stores, checks and removes secrets', async () => {
    await withSandbox(async (sb) => {
      const ctx = await makeContext(sb.dataDir)
      const app = createAppApi(ctx)
      const events: string[] = []
      ctx.events.on('state', (e) => events.push(e.key))

      expect(await app.hasSecret('profile:kimi')).toBe(false)
      const saved = await app.setSecret('profile:kimi', '  sk-123\n')
      expect(saved.ok).toBe(true)
      expect(await ctx.secrets.get('profile:kimi')).toBe('sk-123') // trimmed
      expect(await app.hasSecret('profile:kimi')).toBe(true)

      expect((await app.setSecret('profile:kimi', null)).ok).toBe(true)
      expect(await app.hasSecret('profile:kimi')).toBe(false)
      await app.setSecret('profile:kimi', 'x')
      expect((await app.setSecret('profile:kimi', '   ')).message).toMatch(/removed/i)
      expect(await app.hasSecret('profile:kimi')).toBe(false)
      expect(events.every((k) => k === 'secrets')).toBe(true)
    })
  })

  it('rejects invalid refs and values with friendly results', async () => {
    await withSandbox(async (sb) => {
      const app = createAppApi(await makeContext(sb.dataDir))
      expect((await app.setSecret('bad ref', 'x')).ok).toBe(false)
      expect((await app.setSecret('ok', 42 as unknown as string)).ok).toBe(false)
      expect(await app.hasSecret('bad ref')).toBe(false)
    })
  })

  it('works with the file-backed store and mentions where the secret went', async () => {
    await withSandbox(async (sb) => {
      const ctx = await makeContext(sb.dataDir, { secretStore: createSecretStore(sb.dataDir, { backend: 'file' }) })
      const app = createAppApi(ctx)
      const r = await app.setSecret('smithery', 'smy-key')
      expect(r.ok).toBe(true)
      expect(r.message).toMatch(/local file/)
      expect(await app.hasSecret('smithery')).toBe(true)
      // Secrets never land in state.json.
      expect(await readFile(join(sb.dataDir, 'state.json'), 'utf8').catch(() => '')).not.toContain('smy-key')
    })
  })
})
