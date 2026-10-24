import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMemorySecretStore, createSecretStore, isValidSecretRef } from '../../src/core/secrets'
import { withSandbox } from '../helpers/sandbox'

process.env.CLAUDE_SETUP_SKIP_FIXPATH = '1'

const isWin = process.platform === 'win32'
/** Exercise the real OS backend only where it has no persistent side effects (DPAPI) or when explicitly allowed. */
const testOsBackend = isWin || process.env.CLAUDE_SETUP_TEST_KEYCHAIN === '1'

async function readIndex(dataDir: string): Promise<{ version: number; items: Record<string, { backend: string; value?: string }> }> {
  return JSON.parse(await readFile(join(dataDir, 'secrets.json'), 'utf8'))
}

describe('secret refs', () => {
  it('accepts typical refs and rejects odd ones', () => {
    for (const ref of ['smithery', 'github', 'profile:abc-123', 'proxy:openai_main', 'server:github/GITHUB_TOKEN']) {
      expect(isValidSecretRef(ref)).toBe(true)
    }
    for (const ref of ['', ' ', 'has space', 'quote"', 'a\nb', 'x'.repeat(201), 42, null]) expect(isValidSecretRef(ref)).toBe(false)
  })
})

describe('file backend', () => {
  it('round-trips, persists across instances and deletes', async () => {
    await withSandbox(async (sb) => {
      const store = createSecretStore(sb.dataDir, { backend: 'file' })
      expect(store.backend()).toBe('Local file (not encrypted)')
      expect(await store.get('profile:kimi')).toBeNull()
      expect(await store.has('profile:kimi')).toBe(false)

      await store.set('profile:kimi', 'sk-test-123')
      await store.set('github', 'ghp_ünïcödé ✓')
      expect(await store.get('profile:kimi')).toBe('sk-test-123')
      expect(await store.has('github')).toBe(true)

      const raw = await readFile(join(sb.dataDir, 'secrets.json'), 'utf8')
      expect(raw).not.toContain('sk-test-123')
      const index = await readIndex(sb.dataDir)
      expect(index.version).toBe(1)
      expect(index.items['profile:kimi']).toMatchObject({ backend: 'file', value: Buffer.from('sk-test-123').toString('base64') })

      const again = createSecretStore(sb.dataDir, { backend: 'file' })
      expect(await again.get('github')).toBe('ghp_ünïcödé ✓')

      await again.delete('github')
      expect(await again.get('github')).toBeNull()
      expect(await store.get('github')).toBeNull() // the other instance notices the change
      expect((await readIndex(sb.dataDir)).items.github).toBeUndefined()
      await again.delete('never-set') // deleting something missing is fine
    })
  })

  it('picks up changes written by another process', async () => {
    await withSandbox(async (sb) => {
      const a = createSecretStore(sb.dataDir, { backend: 'file' })
      const b = createSecretStore(sb.dataDir, { backend: 'file' })
      await a.set('k', '1')
      expect(await b.get('k')).toBe('1')
      await a.set('k', '2')
      expect(await b.get('k')).toBe('2')
    })
  })

  it('keeps concurrent writes from the same instance', async () => {
    await withSandbox(async (sb) => {
      const store = createSecretStore(sb.dataDir, { backend: 'file' })
      await Promise.all(Array.from({ length: 10 }, (_, i) => store.set(`key-${i}`, `value-${i}`)))
      const fresh = createSecretStore(sb.dataDir, { backend: 'file' })
      for (let i = 0; i < 10; i++) expect(await fresh.get(`key-${i}`)).toBe(`value-${i}`)
    })
  })

  it('survives a damaged secrets.json and keeps a copy of it', async () => {
    await withSandbox(async (sb) => {
      await writeFile(join(sb.dataDir, 'secrets.json'), '{ not json')
      const warnings: string[] = []
      const store = createSecretStore(sb.dataDir, { backend: 'file', onWarning: (m) => warnings.push(m) })
      expect(await store.get('x')).toBeNull()
      expect(warnings.some((w) => /damaged/.test(w))).toBe(true)
      await store.set('x', 'y')
      expect(await createSecretStore(sb.dataDir, { backend: 'file' }).get('x')).toBe('y')
      expect((await readdir(sb.dataDir)).some((f) => f.startsWith('secrets.corrupt-'))).toBe(true)
    })
  })

  it('rejects invalid refs and non-string values', async () => {
    await withSandbox(async (sb) => {
      const store = createSecretStore(sb.dataDir, { backend: 'file' })
      await expect(store.get('bad ref')).rejects.toThrow(/Invalid secret reference/)
      await expect(store.set('ok', 42 as unknown as string)).rejects.toThrow(/string/)
    })
  })

  it('CLAUDE_SETUP_SECRET_BACKEND=file forces the file backend', async () => {
    await withSandbox(async (sb) => {
      process.env.CLAUDE_SETUP_SECRET_BACKEND = 'file'
      try {
        const store = createSecretStore(sb.dataDir)
        expect(store.backend()).toBe('Local file (not encrypted)')
        await store.set('a', 'b')
        expect((await readIndex(sb.dataDir)).items.a.backend).toBe('file')
      } finally {
        delete process.env.CLAUDE_SETUP_SECRET_BACKEND
      }
    })
  })
})

describe.runIf(testOsBackend)('OS backend', () => {
  it('round-trips through the native secret store', async () => {
    await withSandbox(async (sb) => {
      const warnings: string[] = []
      const store = createSecretStore(sb.dataDir, { onWarning: (m) => warnings.push(m) })
      const ref = `test:${process.pid}-${Date.now()}`
      try {
        await store.set(ref, 'sk-live-ÄÖÜ-✓ with "quotes" & spaces ')
        expect(await store.get(ref)).toBe('sk-live-ÄÖÜ-✓ with "quotes" & spaces ')
        const fresh = createSecretStore(sb.dataDir)
        expect(await fresh.get(ref)).toBe('sk-live-ÄÖÜ-✓ with "quotes" & spaces ')
        expect(await fresh.has(ref)).toBe(true)
        if (isWin) {
          expect(store.backend()).toBe('Windows DPAPI')
          const item = (await readIndex(sb.dataDir)).items[ref]
          expect(item.backend).toBe('dpapi')
          expect(Buffer.from(item.value ?? '', 'base64').toString('utf8')).not.toContain('sk-live')
        }
        expect(warnings).toEqual([])
      } finally {
        await store.delete(ref)
      }
      expect(await store.get(ref)).toBeNull()
      expect(await createSecretStore(sb.dataDir).has(ref)).toBe(false)
    })
  }, 30_000)

  it.runIf(isWin)('decrypts all DPAPI secrets with one PowerShell call and caches them', async () => {
    await withSandbox(async (sb) => {
      const writer = createSecretStore(sb.dataDir)
      await writer.set('one', 'first')
      await writer.set('two', 'second')
      const reader = createSecretStore(sb.dataDir)
      const started = Date.now()
      expect(await reader.get('one')).toBe('first')
      const firstCall = Date.now() - started
      const t2 = Date.now()
      expect(await reader.get('two')).toBe('second')
      expect(await reader.get('one')).toBe('first')
      expect(Date.now() - t2).toBeLessThan(Math.max(50, firstCall / 2))
    })
  }, 30_000)

  it.runIf(isWin)('treats undecryptable blobs as missing', async () => {
    await withSandbox(async (sb) => {
      const index = { version: 1, items: { broken: { backend: 'dpapi', value: Buffer.from('not a dpapi blob').toString('base64'), updatedAt: new Date().toISOString() } } }
      await writeFile(join(sb.dataDir, 'secrets.json'), JSON.stringify(index))
      const warnings: string[] = []
      const store = createSecretStore(sb.dataDir, { onWarning: (m) => warnings.push(m) })
      expect(await store.get('broken')).toBeNull()
      expect(await store.has('broken')).toBe(false)
      expect(warnings.length).toBe(1)
    })
  }, 30_000)
})

describe('memory store', () => {
  it('works for tests', async () => {
    const store = createMemorySecretStore()
    await store.set('a', 'b')
    expect(await store.get('a')).toBe('b')
    expect(store.backend()).toBe('memory')
    await store.delete('a')
    expect(await store.has('a')).toBe(false)
  })
})
