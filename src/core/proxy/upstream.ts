/**
 * HTTP client for upstream Chat Completions calls.
 *
 * Uses node:http/https directly instead of global fetch: undici's default 300 s headers/body timeouts would
 * kill long reasoning streams and slow non-streaming fallbacks. Here the time to response headers and the
 * body idle time are explicit; aborting the signal (client pressed Esc / disconnected) destroys the request
 * so the provider stops generating (and billing). Keep-alive agents reuse connections; gzip/deflate/br
 * response bodies are decoded transparently.
 */
import http from 'node:http'
import https from 'node:https'
import type { Readable } from 'node:stream'
import { constants as zlib, createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

/** One upstream POST. */
export interface UpstreamRequestOptions {
  url: URL
  headers: Record<string, string>
  body: string
  signal: AbortSignal
  /** Max wait for the response headers (includes connecting). */
  headersTimeoutMs: number
  /** Max silence while the body is being received. */
  idleTimeoutMs: number
}

/** An upstream response whose headers have arrived (the body may still be streaming). */
export interface UpstreamResponse {
  status: number
  /** Lower-cased header names; repeated headers joined with ", ". */
  headers: Record<string, string>
  contentType: string
  /** Decoded body stream (async-iterable Buffers). */
  body: Readable
  /** Read the whole body as UTF-8 (at most `limitBytes`; the rest is discarded). */
  text(limitBytes?: number): Promise<string>
  /** Release the response: a complete one keeps its pooled connection, an unfinished one is aborted. */
  destroy(): void
}

/** The upstream did not answer / went silent. `code` is checked by mapNetworkError(). */
export class UpstreamTimeoutError extends Error {
  readonly code = 'UPSTREAM_TIMEOUT'
  constructor(message: string) {
    super(message)
    this.name = 'UpstreamTimeoutError'
  }
}

/** The request was cancelled through its AbortSignal. */
export class UpstreamAbortError extends Error {
  readonly code = 'ABORT_ERR'
  constructor() {
    super('The request was cancelled.')
    this.name = 'AbortError'
  }
}

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

function decodeBody(res: http.IncomingMessage): Readable {
  const encoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase()
  const decoder =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? createGunzip({ flush: zlib.Z_SYNC_FLUSH, finishFlush: zlib.Z_SYNC_FLUSH })
      : encoding === 'deflate'
        ? createInflate({ flush: zlib.Z_SYNC_FLUSH, finishFlush: zlib.Z_SYNC_FLUSH })
        : encoding === 'br'
          ? createBrotliDecompress({ flush: zlib.BROTLI_OPERATION_FLUSH, finishFlush: zlib.BROTLI_OPERATION_FLUSH })
          : null
  if (!decoder) return res
  res.on('error', (err) => decoder.destroy(err))
  res.on('aborted', () => decoder.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' })))
  return res.pipe(decoder)
}

async function readText(body: Readable, limitBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of body) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    if (size + buf.length > limitBytes) {
      chunks.push(buf.subarray(0, limitBytes - size))
      body.destroy()
      break
    }
    chunks.push(buf)
    size += buf.length
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** HTTP(S) client with keep-alive pools; one per proxy server instance. */
export class UpstreamClient {
  private readonly httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 })
  private readonly httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 })

  /** POST `body` to the upstream. Rejects with network/timeout/abort errors before the response starts. */
  send(opts: UpstreamRequestOptions): Promise<UpstreamResponse> {
    return new Promise<UpstreamResponse>((resolve, reject) => {
      if (opts.signal.aborted) {
        reject(new UpstreamAbortError())
        return
      }
      const secure = opts.url.protocol === 'https:'
      let req: http.ClientRequest
      try {
        req = (secure ? https : http).request(opts.url, {
          method: 'POST',
          headers: { ...opts.headers, 'content-length': String(Buffer.byteLength(opts.body)) },
          agent: secure ? this.httpsAgent : this.httpAgent
        })
      } catch (err) {
        reject(err)
        return
      }
      let body: Readable | null = null
      let settled = false
      const onAbort = (): void => {
        req.destroy(new UpstreamAbortError())
      }
      const headersTimer = setTimeout(
        () => req.destroy(new UpstreamTimeoutError(`No response after ${Math.round(opts.headersTimeoutMs / 1000)} seconds.`)),
        opts.headersTimeoutMs
      )
      const cleanup = (): void => {
        clearTimeout(headersTimer)
        opts.signal.removeEventListener('abort', onAbort)
      }
      opts.signal.addEventListener('abort', onAbort, { once: true })

      req.on('error', (err) => {
        if (!settled) {
          settled = true
          cleanup()
          reject(err)
        } else if (body && !body.destroyed) body.destroy(err)
      })
      req.on('close', () => {
        if (settled) cleanup()
      })
      req.on('response', (res) => {
        clearTimeout(headersTimer)
        settled = true
        req.setTimeout(opts.idleTimeoutMs, () => req.destroy(new UpstreamTimeoutError('The provider stopped sending data.')))
        const decoded = decodeBody(res)
        body = decoded
        resolve({
          status: res.statusCode ?? 0,
          headers: flattenHeaders(res.headers),
          contentType: String(res.headers['content-type'] ?? '').toLowerCase(),
          body: decoded,
          text: (limitBytes = 1024 * 1024) => readText(decoded, limitBytes),
          destroy: () => {
            if (decoded !== res) decoded.destroy()
            // A complete response is drained so its keep-alive socket returns to the pool; an unfinished one is cut.
            if (res.complete) res.resume()
            else req.destroy()
          }
        })
      })
      req.end(opts.body)
    })
  }

  /** Close pooled keep-alive connections. */
  close(): void {
    this.httpAgent.destroy()
    this.httpsAgent.destroy()
  }
}
