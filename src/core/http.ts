/** Small fetch helpers with timeouts. Uses the global fetch (Node ≥ 22 / Electron). */

export interface HttpOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
  signal?: AbortSignal
}

export interface HttpResult<T> {
  ok: boolean
  status: number
  data?: T
  text?: string
  headers?: Record<string, string>
  /** Network/timeout/parse error. */
  error?: string
}

export const USER_AGENT = 'ClaudeSetup/0.1 (+https://github.com/; desktop app)'

async function doFetch(url: string, opts: HttpOptions): Promise<{ res?: Response; error?: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000)
  const onAbort = () => controller.abort()
  opts.signal?.addEventListener('abort', onAbort)
  try {
    const headers: Record<string, string> = { 'user-agent': USER_AGENT, ...(opts.headers ?? {}) }
    let body: string | undefined
    if (opts.body !== undefined) {
      body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json'
    }
    const res = await fetch(url, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, signal: controller.signal, redirect: 'follow' })
    return { res }
  } catch (err) {
    const e = err as Error
    return { error: e.name === 'AbortError' ? `Request timed out: ${url}` : `${e.message}${(e as { cause?: Error }).cause ? ` (${(e as { cause?: Error }).cause?.message})` : ''}` }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  h.forEach((v, k) => (out[k] = v))
  return out
}

export async function fetchText(url: string, opts: HttpOptions = {}): Promise<HttpResult<string>> {
  const { res, error } = await doFetch(url, opts)
  if (!res) return { ok: false, status: 0, error }
  try {
    const text = await res.text()
    return { ok: res.ok, status: res.status, data: text, text, headers: headersToObject(res.headers) }
  } catch (err) {
    return { ok: false, status: res.status, error: (err as Error).message }
  }
}

/** Fetch and parse JSON. `ok` reflects the HTTP status; `data` is set whenever the body parses. */
export async function fetchJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<HttpResult<T>> {
  const r = await fetchText(url, { ...opts, headers: { accept: 'application/json', ...(opts.headers ?? {}) } })
  if (r.error || r.text === undefined) return { ok: false, status: r.status, error: r.error, headers: r.headers }
  try {
    return { ok: r.ok, status: r.status, data: JSON.parse(r.text) as T, text: r.text, headers: r.headers }
  } catch {
    return { ok: false, status: r.status, text: r.text, headers: r.headers, error: `Invalid JSON from ${url} (HTTP ${r.status})` }
  }
}
