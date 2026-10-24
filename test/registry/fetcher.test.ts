import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpError, PoliteHttp, mapLimit } from '@core/registry/fetcher'
import { stubFetch } from './helpers'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PoliteHttp', () => {
  it('retries 429 (honouring Retry-After) and 5xx, then succeeds', async () => {
    let n = 0
    const { calls } = stubFetch([
      () => {
        n++
        if (n === 1) return { status: 429, headers: { 'retry-after': '0' }, body: 'slow down' }
        if (n === 2) return { status: 503, body: 'busy' }
        return { body: { ok: true } }
      }
    ])
    const http = new PoliteHttp({ minIntervalMs: 0, retryBaseMs: 1 })
    await expect(http.json('https://registry.example.com/x')).resolves.toEqual({ ok: true })
    expect(calls).toHaveLength(3)
    expect(http.requests).toBe(3)
  })

  it('does not retry client errors and gives friendly messages', async () => {
    const { calls } = stubFetch([() => ({ status: 404, body: 'nope' })])
    const http = new PoliteHttp({ minIntervalMs: 0, retryBaseMs: 1 })
    const err = (await http.json('https://registry.example.com/missing').catch((e: unknown) => e)) as HttpError
    expect(err).toBeInstanceOf(HttpError)
    expect(err.message).toBe('registry.example.com could not find the requested page (HTTP 404).')
    expect(calls).toHaveLength(1)
  })

  it('gives up after the retry budget with a friendly network message', async () => {
    stubFetch([])
    const http = new PoliteHttp({ minIntervalMs: 0, retryBaseMs: 1, retries: 2 })
    const err = (await http.text('https://down.example.com/').catch((e: unknown) => e)) as HttpError
    expect(err).toBeInstanceOf(HttpError)
    expect(err.message).toMatch(/^Could not reach down\.example\.com/)
  })

  it('rejects invalid JSON and passes 304 through', async () => {
    stubFetch([(u) => (u.pathname === '/bad' ? { body: 'not json' } : { status: 304 })])
    const http = new PoliteHttp({ minIntervalMs: 0, retryBaseMs: 1 })
    await expect(http.json('https://x.example.com/bad')).rejects.toThrow(/invalid JSON/)
    await expect(http.text('https://x.example.com/etag')).resolves.toMatchObject({ status: 304 })
  })

  it('keeps at most 4 requests in flight and spaces request starts', async () => {
    let active = 0
    let peak = 0
    stubFetch([
      async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 15))
        active--
        return { body: {} }
      }
    ])
    const http = new PoliteHttp({ concurrency: 10, minIntervalMs: 0, retryBaseMs: 1 })
    await mapLimit(Array.from({ length: 12 }, (_, i) => i), 12, (i) => http.json(`https://x.example.com/${i}`))
    expect(peak).toBe(4)
    const spaced = new PoliteHttp({ concurrency: 4, minIntervalMs: 30 })
    const started = Date.now()
    await Promise.all([1, 2, 3].map((i) => spaced.json(`https://x.example.com/s${i}`)))
    expect(Date.now() - started).toBeGreaterThanOrEqual(55)
  })

  it('stops when aborted', async () => {
    stubFetch([() => ({ body: {}, delay: 50 })])
    const controller = new AbortController()
    const http = new PoliteHttp({ minIntervalMs: 0, signal: controller.signal })
    const p = http.json('https://x.example.com/slow')
    controller.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('mapLimit', () => {
  it('keeps result order', async () => {
    const out = await mapLimit([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n * 5))
      return n * 10
    })
    expect(out).toEqual([30, 10, 20])
    expect(await mapLimit([], 4, async () => 1)).toEqual([])
  })
})
