/**
 * macOS Keychain and Linux Secret Service backends against simulated `security` / `secret-tool`
 * tools (exec is mocked and process.platform is overridden), so they are covered on every OS.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunOptions, RunResult } from '../../src/core/platform/exec'

const sim = vi.hoisted(() => ({
  keychain: new Map<string, string>(),
  keyring: new Map<string, string>(),
  calls: [] as Array<{ cmd: string; args: string[]; input?: string }>,
  failStore: false,
  failRead: false
}))

function result(ok: boolean, code: number, stdout = '', stderr = ''): RunResult {
  return { ok, code, stdout, stderr, timedOut: false }
}

function arg(args: string[], flag: string): string {
  return args[args.indexOf(flag) + 1]
}

function security(args: string[]): RunResult {
  const account = arg(args, '-a')
  switch (args[0]) {
    case 'add-generic-password':
      if (sim.failStore) return result(false, 45, '', 'security: SecKeychainItemCreateFromContent: User interaction is not allowed.')
      sim.keychain.set(account, arg(args, '-w'))
      return result(true, 0)
    case 'find-generic-password':
      if (sim.failRead) return result(false, 36, '', 'security: SecKeychainSearchCopyNext: The keychain is locked.')
      return sim.keychain.has(account) ? result(true, 0, `${sim.keychain.get(account)}\n`) : result(false, 44, '', 'The specified item could not be found in the keychain.')
    case 'delete-generic-password':
      return sim.keychain.delete(account) ? result(true, 0) : result(false, 44, '', 'The specified item could not be found in the keychain.')
  }
  return result(false, 1, '', 'unknown command')
}

function secretTool(args: string[], input?: string): RunResult {
  const account = arg(args, 'account')
  switch (args[0]) {
    case 'store':
      if (sim.failStore) return result(false, 1, '', 'Cannot autolaunch D-Bus without X11 $DISPLAY')
      sim.keyring.set(account, input ?? '')
      return result(true, 0)
    case 'lookup':
      return sim.keyring.has(account) ? result(true, 0, sim.keyring.get(account)) : result(false, 1)
    case 'clear':
      sim.keyring.delete(account)
      return result(true, 0)
  }
  return result(false, 1, '', 'unknown command')
}

vi.mock('../../src/core/platform/exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/platform/exec')>()
  return {
    ...actual,
    run: async (cmd: string, args: string[], opts?: RunOptions) => {
      sim.calls.push({ cmd, args, input: opts?.input })
      if (cmd === '/usr/bin/security') return security(args)
      if (/secret-tool$/.test(cmd)) return secretTool(args, opts?.input)
      return result(false, 1, '', `unexpected command ${cmd}`)
    }
  }
})

const { createSecretStore } = await import('../../src/core/secrets')
const { withSandbox } = await import('../helpers/sandbox')

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: platform })
}

async function readIndex(dataDir: string): Promise<{ items: Record<string, { backend: string; value?: string }> }> {
  return JSON.parse(await readFile(join(dataDir, 'secrets.json'), 'utf8'))
}

beforeEach(() => {
  sim.keychain.clear()
  sim.keyring.clear()
  sim.calls.length = 0
  sim.failStore = false
  sim.failRead = false
})

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform)
})

describe('macOS Keychain backend', () => {
  beforeEach(() => setPlatform('darwin'))

  it('stores values in the Keychain and keeps only an index in secrets.json', async () => {
    await withSandbox(async (sb) => {
      const store = createSecretStore(sb.dataDir)
      expect(store.backend()).toBe('macOS Keychain')
      await store.set('profile:kimi', 'sk-abc')
      const add = sim.calls.find((c) => c.args[0] === 'add-generic-password')
      expect(add?.args).toEqual(['add-generic-password', '-U', '-s', 'Claude Setup', '-a', 'profile:kimi', '-l', 'Claude Setup: profile:kimi', '-w', 'sk-abc'])
      expect((await readIndex(sb.dataDir)).items['profile:kimi']).toEqual({ backend: 'keychain', updatedAt: expect.any(String) })
      expect(await readFile(join(sb.dataDir, 'secrets.json'), 'utf8')).not.toContain('sk-abc')

      const fresh = createSecretStore(sb.dataDir)
      expect(await fresh.get('profile:kimi')).toBe('sk-abc')
      expect(await fresh.has('profile:kimi')).toBe(true)
    })
  })

  it('encodes values the security tool could mangle', async () => {
    await withSandbox(async (sb) => {
      const store = createSecretStore(sb.dataDir)
      const tricky = ' ünïcode ✓ with spaces \n'
      await store.set('tricky', tricky)
      expect(sim.keychain.get('tricky')).toMatch(/^cs-b64:/)
      expect(await createSecretStore(sb.dataDir).get('tricky')).toBe(tricky)
      await store.set('looks-encoded', 'cs-b64:not really')
      expect(await createSecretStore(sb.dataDir).get('looks-encoded')).toBe('cs-b64:not really')
    })
  })

  it('deletes from the Keychain and the index', async () => {
    await withSandbox(async (sb) => {
      const store = createSecretStore(sb.dataDir)
      await store.set('github', 'ghp_1')
      await store.delete('github')
      expect(sim.keychain.has('github')).toBe(false)
      expect((await readIndex(sb.dataDir)).items.github).toBeUndefined()
      expect(await createSecretStore(sb.dataDir).get('github')).toBeNull()
    })
  })

  it('finds Keychain items even when the index was lost', async () => {
    await withSandbox(async (sb) => {
      sim.keychain.set('smithery', 'smy-1')
      expect(await createSecretStore(sb.dataDir).get('smithery')).toBe('smy-1')
    })
  })

  it('falls back to the file backend when the Keychain refuses, and moves back later', async () => {
    await withSandbox(async (sb) => {
      const warnings: string[] = []
      const store = createSecretStore(sb.dataDir, { onWarning: (m) => warnings.push(m) })
      sim.failStore = true
      await store.set('k', 'v1')
      expect((await readIndex(sb.dataDir)).items.k.backend).toBe('file')
      expect(warnings.length).toBe(1)
      expect(warnings[0]).toMatch(/not available/)
      expect(store.backend()).toBe('macOS Keychain (some secrets in a local file)')
      expect(await createSecretStore(sb.dataDir).get('k')).toBe('v1')

      sim.failStore = false
      await store.set('k', 'v2')
      expect((await readIndex(sb.dataDir)).items.k).toEqual({ backend: 'keychain', updatedAt: expect.any(String) })
      expect(await createSecretStore(sb.dataDir).get('k')).toBe('v2')
    })
  })

  it('does not cache a failed read as "missing"', async () => {
    await withSandbox(async (sb) => {
      await createSecretStore(sb.dataDir).set('k', 'v')
      const store = createSecretStore(sb.dataDir, { onWarning: () => {} })
      sim.failRead = true
      expect(await store.get('k')).toBeNull()
      sim.failRead = false
      expect(await store.get('k')).toBe('v')
    })
  })
})

describe('Linux Secret Service backend', () => {
  let toolDir: string
  let savedPath: string | undefined

  beforeEach(async () => {
    setPlatform('linux')
    savedPath = process.env.PATH
    toolDir = await mkdtemp(join(tmpdir(), 'claude-setup-secret-tool-'))
    await writeFile(join(toolDir, 'secret-tool'), '')
    process.env.PATH = [toolDir, savedPath].join(delimiter)
  })

  afterEach(async () => {
    process.env.PATH = savedPath
    await rm(toolDir, { recursive: true, force: true })
  })

  it('stores secrets with secret-tool, passing the value on stdin', async () => {
    await withSandbox(async (sb) => {
      const store = createSecretStore(sb.dataDir)
      expect(store.backend()).toBe('Secret Service (libsecret)')
      await store.set('proxy:openai', 'sk-proxy')
      const storeCall = sim.calls.find((c) => c.args[0] === 'store')
      expect(storeCall?.args).toEqual(['store', '--label', 'Claude Setup: proxy:openai', 'service', 'Claude Setup', 'account', 'proxy:openai'])
      expect(storeCall?.input).toBe('sk-proxy')
      expect(storeCall?.args.join(' ')).not.toContain('sk-proxy')
      expect(await createSecretStore(sb.dataDir).get('proxy:openai')).toBe('sk-proxy')
      await store.delete('proxy:openai')
      expect(sim.keyring.has('proxy:openai')).toBe(false)
    })
  })

  it('falls back to the file backend without a running Secret Service', async () => {
    await withSandbox(async (sb) => {
      const warnings: string[] = []
      const store = createSecretStore(sb.dataDir, { onWarning: (m) => warnings.push(m) })
      sim.failStore = true
      await store.set('k', 'v')
      expect((await readIndex(sb.dataDir)).items.k.backend).toBe('file')
      expect(warnings[0]).toMatch(/D-Bus/)
      expect(await createSecretStore(sb.dataDir).get('k')).toBe('v')
    })
  })

  it.skipIf(existsSync('/usr/bin/secret-tool') || existsSync('/usr/local/bin/secret-tool'))(
    'uses the file backend when secret-tool is not installed',
    async () => {
      process.env.PATH = savedPath
      await withSandbox(async (sb) => {
        const warnings: string[] = []
        const store = createSecretStore(sb.dataDir, { onWarning: (m) => warnings.push(m) })
        expect(store.backend()).toBe('Local file (not encrypted); no system keyring found')
        await store.set('k', 'v')
        await store.set('k2', 'v2')
        expect(warnings.length).toBe(1)
        expect(sim.calls).toEqual([])
        expect(await createSecretStore(sb.dataDir).get('k2')).toBe('v2')
      })
    }
  )
})
