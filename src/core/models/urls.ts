/** Small URL / model-id helpers shared by the models and doctor modules. */

/** Remove trailing slashes. */
export function trimSlashes(url: string): string {
  return url.replace(/\/+$/, '')
}

/** Join a base URL and a path without doubling slashes. */
export function joinUrl(base: string, path: string): string {
  return trimSlashes(base) + (path.startsWith('/') ? path : `/${path}`)
}

/** True when the string is an absolute http(s) URL. */
export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Comparable form of a base URL: lower-case, default port dropped, no trailing slash. */
export function normalizeBaseUrl(url: string | undefined): string {
  if (!url) return ''
  const trimmed = url.trim()
  try {
    const u = new URL(trimmed)
    return `${u.protocol}//${u.host}${trimSlashes(u.pathname)}`.toLowerCase()
  } catch {
    return trimSlashes(trimmed).toLowerCase()
  }
}

/** ANTHROPIC_BASE_URL must not end in /v1 (Claude Code appends /v1/messages itself). */
export function stripTrailingV1(url: string): string {
  return trimSlashes(url).replace(/\/v1$/i, '')
}

/** Host name of a URL, or the input when it doesn't parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Loopback check (127.0.0.0/8, ::1, localhost) plus the effective port. */
export function loopbackPort(url: string | undefined): number | null {
  if (!url) return null
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    const loopback = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)
    if (!loopback) return null
    if (u.port) return Number(u.port)
    return u.protocol === 'https:' ? 443 : 80
  } catch {
    return null
  }
}

/** `[1m]` marks a 1M-context variant for Claude Code; Claude Code strips it and so must our own API calls. */
export function stripContextSuffix(model: string): string {
  return model.trim().replace(/\[1m\]$/i, '')
}

/** True when the id carries Claude Code's `[1m]` suffix. */
export function hasContextSuffix(model: string): boolean {
  return /\[1m\]$/i.test(model.trim())
}

/** True for Claude model ids (direct, gateway-prefixed or cloud-prefixed), e.g. `us.anthropic.claude-opus-5-5`. */
export function isClaudeModel(model: string): boolean {
  const id = model.trim().replace(/^claude-code\//i, '')
  return /(^|[/.~])claude-(opus|sonnet|haiku|fable|mythos|\d)/i.test(id)
}
