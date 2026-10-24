/**
 * Secret storage shared by GUI, CLI and MCP surfaces (so it cannot use Electron safeStorage).
 * CONTRACT (owned by FOUNDATION).
 *
 * Backends (no native modules):
 * - Windows: DPAPI (CurrentUser) via PowerShell ProtectedData; blobs stored in <dataDir>/secrets.json
 * - macOS:   Keychain via `security add-generic-password -s "Claude Setup" -a <ref> -w <value> -U`
 * - Linux:   libsecret via `secret-tool` when available
 * - Fallback: <dataDir>/secrets.json with base64 values, file mode 0600 (log a warning)
 * Refs are short ids like "profile:<id>", "proxy:<upstreamId>", "smithery", "github".
 */

export interface SecretStore {
  get(ref: string): Promise<string | null>
  set(ref: string, value: string): Promise<void>
  delete(ref: string): Promise<void>
  has(ref: string): Promise<boolean>
  /** Human-readable backend name, e.g. "Windows DPAPI". */
  backend(): string
}

export function createSecretStore(_dataDir: string): SecretStore {
  throw new Error('TODO(foundation): createSecretStore')
}

/** In-memory store (tests). */
export function createMemorySecretStore(): SecretStore {
  const m = new Map<string, string>()
  return {
    get: async (ref) => m.get(ref) ?? null,
    set: async (ref, value) => void m.set(ref, value),
    delete: async (ref) => void m.delete(ref),
    has: async (ref) => m.has(ref),
    backend: () => 'memory'
  }
}
