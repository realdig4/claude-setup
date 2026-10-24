import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionsCache } from '@core/extensions/cache'
import { fetchBuffer, friendlyGitHubError, GitHubError, listDirectory, rawUrl } from '@core/extensions/github'
import { InstallRegistry } from '@core/extensions/registry'
import { createSandbox, type Sandbox } from '../helpers/sandbox'
import { fakeRepo, jsonResponse, makeCtx, stubFetch, type TestContext } from './helpers'

describe('github helpers', () => {
  let sb: Sandbox
  let t: TestContext
  beforeEach(async () => {
    sb = await createSandbox()
    t = await makeCtx(sb)
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await sb.cleanup()
  })

  it('caps downloads by declared and streamed size', async () => {
    stubFetch((url) => {
      if (url.pathname === '/declared') return new Response('x'.repeat(10), { headers: { 'content-length': '5000000' } })
      if (url.pathname === '/streamed') return new Response(new Uint8Array(4096))
      return undefined
    })
    await expect(fetchBuffer('https://example.test/declared', { maxBytes: 1000 })).rejects.toMatchObject({ kind: 'too-large' })
    await expect(fetchBuffer('https://example.test/streamed', { maxBytes: 1000 })).rejects.toMatchObject({ kind: 'too-large' })
    const ok = await fetchBuffer('https://example.test/streamed', { maxBytes: 10_000 })
    expect(ok.body.length).toBe(4096)
  })

  it('lists one folder with two small requests, sending the saved token', async () => {
    await t.ctx.secrets.set('github', 'ghp_test')
    await t.ctx.state.update((d) => void (d.settings.githubTokenRef = 'github'))
    const seenAuth: string[] = []
    const repo = fakeRepo('o', 'r', { 'skills/a/SKILL.md': 'a', 'skills/a/x/y.txt': 'y', 'skills/b/SKILL.md': 'b', 'README.md': 'r' })
    const { calls } = stubFetch((url, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization
      if (auth) seenAuth.push(auth)
      return repo(url, init)
    })
    const listing = await listDirectory(t.ctx, 'o', 'r', 'skills/a')
    expect(listing.blobs.map((b) => b.path).sort()).toEqual(['skills/a/SKILL.md', 'skills/a/x/y.txt'])
    expect(calls).toEqual(['https://api.github.com/repos/o/r/contents/skills?ref=HEAD', 'https://api.github.com/repos/o/r/git/trees/tree-skills/a?recursive=1'])
    expect(seenAuth).toEqual(['Bearer ghp_test', 'Bearer ghp_test'])
  })

  it('falls back to the full tree when the folder lookup fails', async () => {
    const repo = fakeRepo('o', 'r', { 'deep/skill/SKILL.md': 'a' })
    stubFetch((url, init) => (url.pathname.includes('/contents') ? jsonResponse({ message: 'boom' }, 500) : repo(url, init)))
    const listing = await listDirectory(t.ctx, 'o', 'r', 'deep/skill')
    expect(listing.blobs.map((b) => b.path)).toEqual(['deep/skill/SKILL.md'])
  })

  it('explains failures in plain words', () => {
    expect(friendlyGitHubError(new GitHubError('not-found', 'x'), 'this skill')).toBe("Couldn't find this skill on GitHub. It may have been moved, renamed or deleted.")
    expect(friendlyGitHubError(new GitHubError('too-large', '30 MB'), 'this skill')).toMatch(/^This skill is too large/)
    expect(friendlyGitHubError(new GitHubError('auth', 'x'))).toMatch(/token/)
    expect(rawUrl('o', 'r', 'a b/c#d.md')).toBe('https://raw.githubusercontent.com/o/r/HEAD/a%20b/c%23d.md')
  })
})

describe('catalog cache', () => {
  let sb: Sandbox
  beforeEach(async () => {
    sb = await createSandbox()
  })
  afterEach(async () => sb.cleanup())

  it('serves fresh data, refetches when expired and falls back to stale data', async () => {
    const dir = join(sb.dataDir, 'cache', 'extensions')
    const cache = new ExtensionsCache(dir)
    const fetcher = vi.fn(async () => ['a'])
    expect((await cache.load('k', 60_000, fetcher)).data).toEqual(['a'])
    expect((await cache.load('k', 60_000, fetcher)).stale).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
    // A second instance reads the file from disk.
    const other = new ExtensionsCache(dir)
    expect((await other.load('k', 60_000, fetcher)).data).toEqual(['a'])
    expect(fetcher).toHaveBeenCalledTimes(1)
    // Expired + failing refresh → stale copy with the error.
    const failing = vi.fn(async (): Promise<string[]> => {
      throw new Error('offline')
    })
    const stale = await other.load('k', 0, failing)
    expect(stale).toMatchObject({ data: ['a'], stale: true, error: 'offline' })
    // Within the back-off window the failing source is not called again.
    await other.load('k', 0, failing)
    expect(failing).toHaveBeenCalledTimes(1)
    // force bypasses both
    expect((await other.load('k', 0, async () => ['b'], { force: true })).data).toEqual(['b'])
  })

  it('shares one fetch between concurrent callers and rethrows without a cache', async () => {
    const cache = new ExtensionsCache(join(sb.dataDir, 'c'))
    let resolve!: (v: number[]) => void
    const fetcher = vi.fn(() => new Promise<number[]>((r) => (resolve = r)))
    const a = cache.load('x', 1000, fetcher)
    const b = cache.load('x', 1000, fetcher)
    await new Promise((r) => setTimeout(r, 10))
    resolve([1])
    expect((await a).data).toEqual([1])
    expect((await b).data).toEqual([1])
    expect(fetcher).toHaveBeenCalledTimes(1)
    await expect(cache.load('none', 1000, async () => Promise.reject(new Error('down')))).rejects.toThrow('down')
    await expect(cache.load('none', 1000, async () => ['never'])).rejects.toThrow('down')
  })
})

describe('install registry', () => {
  let sb: Sandbox
  beforeEach(async () => {
    sb = await createSandbox()
  })
  afterEach(async () => sb.cleanup())

  it('keeps one record per file but several hook records per settings file', async () => {
    const reg = InstallRegistry.at(sb.dataDir)
    const base = { name: 'x', source: 'aitmpl' as const, scope: 'user' as const, files: [], installedAt: new Date().toISOString() }
    const file = join(sb.home, '.claude', 'agents', 'a.md')
    await reg.add({ ...base, id: 'agent:1', kind: 'agent', path: file })
    await reg.add({ ...base, id: 'agent:2', kind: 'agent', path: file })
    expect((await reg.list()).map((r) => r.id)).toEqual(['agent:2'])
    expect((await reg.findByPath('agent', file + '.disabled'))?.id).toBe('agent:2')
    const settings = join(sb.home, '.claude', 'settings.json')
    await Promise.all([
      reg.add({ ...base, id: 'hook:1', kind: 'hook', path: settings }),
      reg.add({ ...base, id: 'hook:2', kind: 'hook', path: settings }),
      reg.add({ ...base, id: 'statusline:1', kind: 'statusline', path: settings }),
      reg.add({ ...base, id: 'statusline:parked', kind: 'statusline', path: settings, disabled: true })
    ])
    expect((await reg.list()).length).toBe(5)
    const hook = (await reg.findById('hook:1', 'user'))[0]
    await reg.update(hook.key, { disabled: true })
    expect((await reg.findByKey(hook.key))?.disabled).toBe(true)
    await reg.remove(hook.key)
    expect(await reg.findById('hook:1')).toEqual([])
  })
})
