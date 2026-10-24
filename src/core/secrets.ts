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
 *
 * secrets.json = { version: 1, items: { [ref]: { backend, value?, updatedAt } } } — for Keychain and
 * libsecret items it is only an index (the value lives in the OS store). Values are cached in memory;
 * the cache is dropped whenever another process changes secrets.json.
 */
import { existsSync } from 'node:fs'
import { readFile, rename } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { isPlainObject, writeTextAtomic } from './fs/json'
import { run, runPowerShell, type RunResult } from './platform/exec'

export interface SecretStore {
  get(ref: string): Promise<string | null>
  set(ref: string, value: string): Promise<void>
  delete(ref: string): Promise<void>
  has(ref: string): Promise<boolean>
  /** Human-readable backend name, e.g. "Windows DPAPI". */
  backend(): string
}

/** Storage backend of a secret, as recorded per item in secrets.json. */
export type SecretBackendId = 'dpapi' | 'keychain' | 'libsecret' | 'file'

export interface SecretStoreOptions {
  /**
   * Force a backend. 'file' is always honoured (tests, portable use); an OS backend only on its own OS.
   * The env var CLAUDE_SETUP_SECRET_BACKEND=file does the same.
   */
  backend?: SecretBackendId
  /** Receives warnings (e.g. falling back to the unencrypted file). Default: process.emitWarning (stderr). */
  onWarning?: (message: string) => void
}

interface SecretItem {
  backend: SecretBackendId
  /** dpapi: base64 DPAPI blob · file: base64 UTF-8 value · keychain/libsecret: absent */
  value?: string
  updatedAt: string
}

interface SecretsFile {
  version: 1
  items: Record<string, SecretItem>
}

const SERVICE = 'Claude Setup'
const FILE_NAME = 'secrets.json'
const OS_TIMEOUT_MS = 30_000
/** Values the OS tools could mangle (non-printable, surrounding spaces) are stored base64 with this prefix. */
const OS_ENCODED_PREFIX = 'cs-b64:'
const REF_PATTERN = /^[\w.:@/+=#,-]{1,200}$/
const BACKENDS: SecretBackendId[] = ['dpapi', 'keychain', 'libsecret', 'file']

const BACKEND_NAMES: Record<SecretBackendId, string> = {
  dpapi: 'Windows DPAPI',
  keychain: 'macOS Keychain',
  libsecret: 'Secret Service (libsecret)',
  file: 'Local file (not encrypted)'
}

/** True when `ref` is a usable secret reference: 1–200 chars of letters, digits and _ . : @ / + = # , - */
export function isValidSecretRef(ref: unknown): ref is string {
  return typeof ref === 'string' && REF_PATTERN.test(ref)
}

function assertRef(ref: string): void {
  if (!isValidSecretRef(ref)) throw new Error(`Invalid secret reference: ${JSON.stringify(ref)}`)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Short reason for a failed OS tool call (never includes stdin, where secrets travel). */
function toolError(r: RunResult): string {
  if (r.error) return r.error
  if (r.timedOut) return 'timed out'
  const lines = r.stderr
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return lines[lines.length - 1] ?? `exit code ${r.code}`
}

function encodeForOs(value: string): string {
  const plain = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value) && !value.startsWith(OS_ENCODED_PREFIX)
  return plain ? value : OS_ENCODED_PREFIX + Buffer.from(value, 'utf8').toString('base64')
}

function decodeFromOs(raw: string): string {
  const text = raw.replace(/\r?\n$/, '')
  return text.startsWith(OS_ENCODED_PREFIX) ? Buffer.from(text.slice(OS_ENCODED_PREFIX.length), 'base64').toString('utf8') : text
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows DPAPI (PowerShell, values travel base64-encoded on stdin/stdout)
// ─────────────────────────────────────────────────────────────────────────────

function dpapiScript(op: 'Protect' | 'Unprotect'): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
    "$entropy = [System.Text.Encoding]::UTF8.GetBytes('Claude Setup')",
    'foreach ($line in ([Console]::In.ReadToEnd() -split "`n")) {',
    '  $t = $line.Trim()',
    '  if ($t.Length -eq 0) { continue }',
    '  try {',
    `    $out = [System.Security.Cryptography.ProtectedData]::${op}([Convert]::FromBase64String($t), $entropy, $scope)`,
    "    [Console]::Out.WriteLine('+' + [Convert]::ToBase64String($out))",
    "  } catch { [Console]::Out.WriteLine('-') }",
    '}'
  ].join('\n')
}

/** Protect/unprotect base64 payloads in one PowerShell call; null for items that failed. */
async function dpapi(op: 'Protect' | 'Unprotect', payloads: string[]): Promise<Array<string | null>> {
  if (!payloads.length) return []
  const r = await runPowerShell(dpapiScript(op), { input: payloads.join('\n') + '\n', timeoutMs: OS_TIMEOUT_MS })
  if (!r.ok) throw new Error(`PowerShell failed (${toolError(r)})`)
  const lines = r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l === '-' || l.startsWith('+'))
  if (lines.length !== payloads.length) throw new Error('unexpected answer from PowerShell')
  return lines.map((l) => (l.startsWith('+') ? l.slice(1) : null))
}

async function dpapiProtect(value: string): Promise<string> {
  const [blob] = await dpapi('Protect', [Buffer.from(value, 'utf8').toString('base64')])
  if (!blob) throw new Error('Windows refused to encrypt the secret')
  return blob
}

async function dpapiUnprotect(blobs: string[]): Promise<Array<string | null>> {
  const plain = await dpapi('Unprotect', blobs)
  return plain.map((p) => (p === null ? null : Buffer.from(p, 'base64').toString('utf8')))
}

// ─────────────────────────────────────────────────────────────────────────────
// macOS Keychain (`security`) and Linux Secret Service (`secret-tool`)
// ─────────────────────────────────────────────────────────────────────────────

const SECURITY = '/usr/bin/security'
/** `security` exit code for errSecItemNotFound. */
const KEYCHAIN_NOT_FOUND = 44

async function keychainSet(ref: string, value: string): Promise<void> {
  // The value is briefly visible in the process list: `security` has no stdin option for passwords.
  const args = ['add-generic-password', '-U', '-s', SERVICE, '-a', ref, '-l', `${SERVICE}: ${ref}`, '-w', encodeForOs(value)]
  const r = await run(SECURITY, args, { timeoutMs: OS_TIMEOUT_MS })
  if (!r.ok) throw new Error(`the Keychain refused to save it (${toolError(r)})`)
}

async function keychainGet(ref: string): Promise<string | null> {
  const r = await run(SECURITY, ['find-generic-password', '-s', SERVICE, '-a', ref, '-w'], { timeoutMs: OS_TIMEOUT_MS })
  if (r.ok) return decodeFromOs(r.stdout)
  if (r.code === KEYCHAIN_NOT_FOUND) return null
  throw new Error(`the Keychain could not be read (${toolError(r)})`)
}

async function keychainDelete(ref: string): Promise<void> {
  const r = await run(SECURITY, ['delete-generic-password', '-s', SERVICE, '-a', ref], { timeoutMs: OS_TIMEOUT_MS })
  if (!r.ok && r.code !== KEYCHAIN_NOT_FOUND) throw new Error(`the Keychain refused to delete it (${toolError(r)})`)
}

/** secret-tool on PATH (sync, so the backend is known at construction). */
function findSecretTool(): string | null {
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), '/usr/bin', '/usr/local/bin']
  for (const dir of dirs) {
    const candidate = join(dir, 'secret-tool')
    if (existsSync(candidate)) return candidate
  }
  return null
}

async function libsecretSet(tool: string, ref: string, value: string): Promise<void> {
  const args = ['store', '--label', `${SERVICE}: ${ref}`, 'service', SERVICE, 'account', ref]
  const r = await run(tool, args, { input: encodeForOs(value), timeoutMs: OS_TIMEOUT_MS })
  if (!r.ok) throw new Error(`the system keyring refused to save it (${toolError(r)})`)
}

async function libsecretGet(tool: string, ref: string): Promise<string | null> {
  const r = await run(tool, ['lookup', 'service', SERVICE, 'account', ref], { timeoutMs: OS_TIMEOUT_MS })
  if (r.ok) return r.stdout ? decodeFromOs(r.stdout) : null
  // Exit 1 without a message means "not found".
  if (r.code === 1 && !r.error && !r.stderr.trim()) return null
  throw new Error(`the system keyring could not be read (${toolError(r)})`)
}

async function libsecretDelete(tool: string, ref: string): Promise<void> {
  const r = await run(tool, ['clear', 'service', SERVICE, 'account', ref], { timeoutMs: OS_TIMEOUT_MS })
  if (!r.ok && !(r.code === 1 && !r.error && !r.stderr.trim())) throw new Error(`the system keyring refused to delete it (${toolError(r)})`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

function emptyIndex(): SecretsFile {
  return { version: 1, items: {} }
}

function sanitizeIndex(data: unknown): SecretsFile {
  const out = emptyIndex()
  if (!isPlainObject(data) || !isPlainObject(data.items)) return out
  for (const [ref, raw] of Object.entries(data.items)) {
    if (!isValidSecretRef(ref) || !isPlainObject(raw)) continue
    const backend = raw.backend as SecretBackendId
    if (!BACKENDS.includes(backend)) continue
    if ((backend === 'dpapi' || backend === 'file') && typeof raw.value !== 'string') continue
    const item: SecretItem = { backend, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString() }
    if (typeof raw.value === 'string') item.value = raw.value
    out.items[ref] = item
  }
  return out
}

function nativeBackend(): SecretBackendId {
  return process.platform === 'win32' ? 'dpapi' : process.platform === 'darwin' ? 'keychain' : 'libsecret'
}

class OsSecretStore implements SecretStore {
  private readonly file: string
  private readonly primary: SecretBackendId
  private readonly secretTool: string | null
  private readonly onWarning: (message: string) => void
  private index: SecretsFile = emptyIndex()
  /** Raw text of secrets.json as last read/written (null: missing; undefined: never read). */
  private indexText: string | null | undefined = undefined
  private corrupt = false
  /** ref → value, or null when known to be absent. */
  private readonly cache = new Map<string, string | null>()
  private cacheGeneration = 0
  private dpapiLoad: Promise<void> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private fellBack = false
  private readonly warned = new Set<string>()

  constructor(
    private readonly dataDir: string,
    opts: SecretStoreOptions
  ) {
    this.file = join(dataDir, FILE_NAME)
    this.onWarning = opts.onWarning ?? ((message) => process.emitWarning(message, { code: 'CLAUDE_SETUP_SECRETS' }))
    const native = nativeBackend()
    const requested = opts.backend ?? process.env.CLAUDE_SETUP_SECRET_BACKEND
    this.secretTool = native === 'libsecret' ? findSecretTool() : null
    if (requested === 'file') this.primary = 'file'
    else if (native === 'libsecret' && !this.secretTool) {
      this.primary = 'file'
      this.fellBack = true
    } else this.primary = native
  }

  backend(): string {
    const name = BACKEND_NAMES[this.primary]
    if (this.primary === 'file') return this.fellBack ? `${name}; no system keyring found` : name
    const someInFile = this.fellBack || Object.values(this.index.items).some((i) => i.backend === 'file')
    return someInFile ? `${name} (some secrets in a local file)` : name
  }

  async get(ref: string): Promise<string | null> {
    assertRef(ref)
    await this.loadIndex()
    if (this.cache.has(ref)) return this.cache.get(ref) ?? null
    const item = this.index.items[ref]
    if (item?.backend === 'dpapi') {
      await this.loadDpapi()
      return this.cache.get(ref) ?? null
    }
    const generation = this.cacheGeneration
    // undefined = the OS store could not be read (e.g. locked keychain): report missing, but don't cache it.
    let value: string | null | undefined = null
    if (item?.backend === 'file') value = item.value !== undefined ? Buffer.from(item.value, 'base64').toString('utf8') : null
    else if (item?.backend === 'keychain' || item?.backend === 'libsecret') value = await this.readOs(item.backend, ref)
    else if (!item && (this.primary === 'keychain' || this.primary === 'libsecret')) value = await this.readOs(this.primary, ref)
    if (value === undefined) return null
    if (generation === this.cacheGeneration) this.cache.set(ref, value)
    return value
  }

  async has(ref: string): Promise<boolean> {
    return (await this.get(ref)) !== null
  }

  async set(ref: string, value: string): Promise<void> {
    assertRef(ref)
    if (typeof value !== 'string') throw new TypeError('A secret value must be a string')
    return this.exclusive(async () => {
      await this.loadIndex()
      const previous = this.index.items[ref]
      const item = await this.storeValue(ref, value)
      if (previous && previous.backend !== item.backend && (previous.backend === 'keychain' || previous.backend === 'libsecret')) {
        // Don't leave a stale copy behind in the OS store.
        await this.deleteOs(previous.backend, ref).catch((err) => {
          this.warn(`stale:${ref}`, `Could not remove an old copy of "${ref}": ${errorMessage(err)}`)
        })
      }
      await this.writeIndex((items) => {
        items[ref] = item
      })
      this.cache.set(ref, value)
    })
  }

  async delete(ref: string): Promise<void> {
    assertRef(ref)
    return this.exclusive(async () => {
      await this.loadIndex()
      const item = this.index.items[ref]
      const osBackend =
        item?.backend === 'keychain' || item?.backend === 'libsecret'
          ? item.backend
          : !item && (this.primary === 'keychain' || this.primary === 'libsecret')
            ? this.primary
            : null
      if (osBackend) {
        try {
          await this.deleteOs(osBackend, ref)
        } catch (err) {
          throw new Error(`Could not remove the secret from the ${BACKEND_NAMES[osBackend]}: ${errorMessage(err)}`)
        }
      }
      if (item) {
        await this.writeIndex((items) => {
          delete items[ref]
        })
      }
      this.cache.set(ref, null)
    })
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private warn(key: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    try {
      this.onWarning(message)
    } catch {
      // Never let logging break secret handling.
    }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.queue.then(fn, fn)
    this.queue = job.catch(() => undefined)
    return job
  }

  /** (Re)read secrets.json when its content changed (e.g. written by the CLI or another window). */
  private async loadIndex(): Promise<void> {
    let text: string | null
    try {
      text = await readFile(this.file, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') this.warn('unreadable', `Could not read ${this.file}: ${errorMessage(err)}`)
      text = null
    }
    if (text === this.indexText) return
    this.indexText = text
    this.cache.clear()
    this.cacheGeneration++
    this.dpapiLoad = null
    if (text === null) {
      this.index = emptyIndex()
      this.corrupt = false
      return
    }
    try {
      this.index = sanitizeIndex(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text))
      this.corrupt = false
    } catch {
      this.index = emptyIndex()
      this.corrupt = true
      this.warn('corrupt', `The saved secrets file is damaged (${this.file}); saved keys need to be entered again.`)
    }
  }

  /** Decrypt every DPAPI item with a single PowerShell call and fill the cache. */
  private loadDpapi(): Promise<void> {
    this.dpapiLoad ??= (async () => {
      const generation = this.cacheGeneration
      const entries = Object.entries(this.index.items).filter(([ref, i]) => i.backend === 'dpapi' && i.value && !this.cache.has(ref))
      if (!entries.length) return
      let plain: Array<string | null>
      try {
        plain = await dpapiUnprotect(entries.map(([, i]) => i.value as string))
      } catch (err) {
        if (generation === this.cacheGeneration) this.dpapiLoad = null // transient: retry on the next call
        this.warn('dpapi-read', `Could not unlock saved secrets with Windows DPAPI: ${errorMessage(err)}`)
        return
      }
      if (generation !== this.cacheGeneration) return
      entries.forEach(([ref], k) => {
        if (!this.cache.has(ref)) this.cache.set(ref, plain[k])
      })
      if (plain.some((p) => p === null)) {
        this.warn(
          'dpapi-undecryptable',
          'Some saved secrets could not be decrypted (they may come from another Windows account) and need to be entered again.'
        )
      }
    })()
    return this.dpapiLoad
  }

  /** Value from the OS store; null when absent, undefined when the store could not be read. */
  private async readOs(backend: 'keychain' | 'libsecret', ref: string): Promise<string | null | undefined> {
    try {
      if (backend === 'keychain') return await keychainGet(ref)
      if (!this.secretTool) return undefined
      return await libsecretGet(this.secretTool, ref)
    } catch (err) {
      this.warn(`read:${backend}`, `Could not read a secret from the ${BACKEND_NAMES[backend]}: ${errorMessage(err)}`)
      return undefined
    }
  }

  private async deleteOs(backend: 'keychain' | 'libsecret', ref: string): Promise<void> {
    if (backend === 'keychain') return keychainDelete(ref)
    if (this.secretTool) return libsecretDelete(this.secretTool, ref)
  }

  /** Store the value in the primary backend, falling back to the file backend if the OS store fails. */
  private async storeValue(ref: string, value: string): Promise<SecretItem> {
    const updatedAt = new Date().toISOString()
    const backend = this.primary
    if (backend === 'file') {
      if (this.fellBack) {
        this.warn(
          'no-keyring',
          'No system keyring (secret-tool) was found, so secrets are stored in a local file that only your user account can read.'
        )
      }
    } else {
      try {
        if (backend === 'dpapi') return { backend, value: await dpapiProtect(value), updatedAt }
        if (backend === 'keychain') await keychainSet(ref, value)
        else if (this.secretTool) await libsecretSet(this.secretTool, ref, value)
        else throw new Error('secret-tool is not installed')
        return { backend, updatedAt }
      } catch (err) {
        this.fellBack = true
        this.warn(
          `fallback:${backend}`,
          `${BACKEND_NAMES[backend]} is not available (${errorMessage(err)}). ` +
            'Secrets are stored in a local file that only your user account can read.'
        )
      }
    }
    return { backend: 'file', value: Buffer.from(value, 'utf8').toString('base64'), updatedAt }
  }

  /** Read-modify-write secrets.json (re-read first so changes from other processes are kept). */
  private async writeIndex(mutate: (items: Record<string, SecretItem>) => void): Promise<void> {
    await this.loadIndex()
    const next: SecretsFile = { version: 1, items: { ...this.index.items } }
    mutate(next.items)
    if (this.corrupt) await this.preserveCorruptFile()
    const text = JSON.stringify(next, null, 2) + '\n'
    await writeTextAtomic(this.file, text, { mode: 0o600 })
    this.index = next
    this.indexText = text
    this.corrupt = false
  }

  private async preserveCorruptFile(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await rename(this.file, join(this.dataDir, `secrets.corrupt-${stamp}.json`)).catch(() => {})
  }
}

/**
 * Create the secret store for `dataDir` (OS backend with automatic file fallback).
 * Safe to create several instances (GUI, CLI, MCP): each re-reads secrets.json when it changes.
 */
export function createSecretStore(dataDir: string, opts: SecretStoreOptions = {}): SecretStore {
  return new OsSecretStore(dataDir, opts)
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
