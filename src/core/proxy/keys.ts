/**
 * Upstream API keys, read from the secret store by `upstream.keyRef`.
 * Found keys are cached briefly (the OS keychain can be slow, e.g. DPAPI through PowerShell);
 * missing keys are never cached, so a key added in the app works on the next request.
 */
import type { ProxyUpstream } from '@shared/types'
import type { SecretStore } from '../secrets'

/** The key to send (null = upstream needs none), or a friendly reason why it is unavailable. */
export type KeyLookup = { ok: true; key: string | null } | { ok: false; message: string }

/** Reads upstream API keys from the secret store with a short-lived cache. */
export class UpstreamKeyCache {
  private readonly cache = new Map<string, { key: string; at: number }>()

  constructor(
    private readonly secrets: SecretStore,
    private readonly ttlMs = 60_000
  ) {}

  /** The key for an upstream (`key: null` when it has no keyRef, e.g. a local server without auth). */
  async lookup(upstream: ProxyUpstream): Promise<KeyLookup> {
    const label = upstream.name || upstream.id
    const ref = upstream.keyRef
    if (!ref) return { ok: true, key: null }
    const hit = this.cache.get(ref)
    if (hit && Date.now() - hit.at < this.ttlMs) return { ok: true, key: hit.key }
    let value: string | null
    try {
      value = await this.secrets.get(ref)
    } catch (err) {
      return { ok: false, message: `Claude Setup could not read the saved API key for ${label}: ${(err as Error).message}` }
    }
    const key = value?.trim() ?? ''
    if (!key) return { ok: false, message: `No API key is saved for ${label}. Add it in Claude Setup → Proxy.` }
    if (/[^\x20-\x7e]/.test(key)) {
      return { ok: false, message: `The saved API key for ${label} contains invalid characters. Paste it again in Claude Setup → Proxy.` }
    }
    this.cache.set(ref, { key, at: Date.now() })
    return { ok: true, key }
  }

  /** Forget a cached key (after the provider rejected it, so a corrected key is picked up). */
  invalidate(upstream: ProxyUpstream): void {
    if (upstream.keyRef) this.cache.delete(upstream.keyRef)
  }

  clear(): void {
    this.cache.clear()
  }
}
