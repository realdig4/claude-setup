/**
 * Polite HTTP client for registry crawls: per-source concurrency limit, minimum spacing between
 * requests, retries with exponential backoff on network errors / 429 / 5xx (honouring Retry-After),
 * cancellation, and friendly error messages. Built on core/http.ts (global fetch).
 */
import { fetchText } from '../http'
import { abortError, sleep } from './util'

export interface PoliteHttpOptions {
  /** Max requests in flight (default 4). */
  concurrency?: number
  /** Minimum delay between two request starts (default 150 ms). */
  minIntervalMs?: number
  /** Retries after the first attempt (default 4). */
  retries?: number
  /** First backoff delay (default 1000 ms, doubled each retry, capped at 60 s). */
  retryBaseMs?: number
  /** Per-request timeout (default 45 s). */
  timeoutMs?: number
  signal?: AbortSignal
  /** Extra headers sent with every request (auth). */
  headers?: Record<string, string>
}

/** HTTP failure with a user-facing message. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export interface TextResponse {
  status: number
  text: string
  headers: Record<string, string>
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function retryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  const v = headers?.['retry-after']
  if (!v) return undefined
  const secs = Number(v)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const t = Date.parse(v)
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined
}

function friendlyStatus(status: number, host: string): string {
  if (status === 401 || status === 403) return `${host} refused the request (HTTP ${status}). Check the API key in Settings.`
  if (status === 404) return `${host} could not find the requested page (HTTP 404).`
  if (status === 429) return `${host} is rate-limiting requests (HTTP 429). Try again later.`
  if (status >= 500) return `${host} is having problems right now (HTTP ${status}). Try again later.`
  return `${host} answered with HTTP ${status}.`
}

/** Rate-limited HTTP client bound to one source. */
export class PoliteHttp {
  private active = 0
  private readonly queue: Array<() => void> = []
  private lastStart = 0
  private readonly opts: Required<Omit<PoliteHttpOptions, 'signal' | 'headers'>> & Pick<PoliteHttpOptions, 'signal' | 'headers'>
  /** Number of HTTP requests issued (including retries). */
  requests = 0

  constructor(options: PoliteHttpOptions = {}) {
    this.opts = {
      concurrency: Math.max(1, Math.min(4, options.concurrency ?? 4)),
      minIntervalMs: options.minIntervalMs ?? 150,
      retries: options.retries ?? 4,
      retryBaseMs: options.retryBaseMs ?? 1000,
      timeoutMs: options.timeoutMs ?? 45_000,
      signal: options.signal,
      headers: options.headers
    }
  }

  private async acquire(): Promise<void> {
    if (this.opts.signal?.aborted) throw abortError()
    if (this.active >= this.opts.concurrency) await new Promise<void>((resolve) => this.queue.push(resolve))
    this.active++
    const now = Date.now()
    const start = Math.max(now, this.lastStart + this.opts.minIntervalMs)
    this.lastStart = start
    const wait = start - now
    if (wait > 0) {
      try {
        await sleep(wait, this.opts.signal)
      } catch (err) {
        this.release()
        throw err
      }
    }
  }

  private release(): void {
    this.active--
    this.queue.shift()?.()
  }

  /** GET text. Resolves for 2xx and 304; throws HttpError otherwise (after retries). */
  async text(url: string, headers: Record<string, string> = {}): Promise<TextResponse> {
    const host = hostOf(url)
    let attempt = 0
    for (;;) {
      await this.acquire()
      let res
      try {
        this.requests++
        res = await fetchText(url, {
          headers: { ...(this.opts.headers ?? {}), ...headers },
          timeoutMs: this.opts.timeoutMs,
          signal: this.opts.signal
        })
      } finally {
        this.release()
      }
      if (this.opts.signal?.aborted) throw abortError()
      const status = res.status
      if (status === 304 || (res.ok && res.text !== undefined)) return { status, text: res.text ?? '', headers: res.headers ?? {} }
      const retryable = status === 0 || status === 429 || status >= 500
      if (!retryable || attempt >= this.opts.retries) {
        if (status === 0) throw new HttpError(`Could not reach ${host}: ${res.error ?? 'network error'}`, 0)
        throw new HttpError(friendlyStatus(status, host), status)
      }
      const backoff = Math.min(60_000, this.opts.retryBaseMs * 2 ** attempt) * (0.75 + Math.random() * 0.5)
      const delay = Math.min(60_000, retryAfterMs(res.headers) ?? backoff)
      attempt++
      await sleep(delay, this.opts.signal)
    }
  }

  /** GET and parse JSON (throws HttpError with a friendly message on failure). */
  async json<T = unknown>(url: string, headers: Record<string, string> = {}): Promise<T> {
    const res = await this.text(url, { accept: 'application/json', ...headers })
    try {
      return JSON.parse(res.text) as T
    } catch {
      throw new HttpError(`${hostOf(url)} sent data we could not read (invalid JSON).`, res.status)
    }
  }
}

/**
 * Run `worker` over `items` with at most `limit` concurrent calls (results keep input order).
 */
export async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const run = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await worker(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run))
  return results
}
