/**
 * Pure security checks shared by the Electron main process and the preload script.
 * No Node or Electron imports here: the sandboxed preload bundles this file.
 */
import { CORE_METHODS, UI_METHODS, type Namespace, type UiApi } from '@shared/api'

/** True when `ns.method` is on the core allow-list (own properties only — no prototype tricks). */
export function isAllowedCoreCall(ns: unknown, method: unknown): ns is Namespace {
  if (typeof ns !== 'string' || typeof method !== 'string') return false
  if (!Object.prototype.hasOwnProperty.call(CORE_METHODS, ns)) return false
  const methods = CORE_METHODS[ns as Namespace] as ReadonlyArray<string>
  return methods.includes(method)
}

/** True when `method` is one of the GUI helpers implemented by the main process. */
export function isAllowedUiCall(method: unknown): method is keyof UiApi {
  return typeof method === 'string' && (UI_METHODS as ReadonlyArray<string>).includes(method)
}

/**
 * Is a frame URL our own renderer? Packaged/built: a file:// page. Development: the
 * electron-vite dev server origin (ELECTRON_RENDERER_URL).
 */
export function isTrustedRendererUrl(url: string | undefined | null, devServerUrl?: string): boolean {
  if (!url) return false
  if (url.startsWith('file://')) return true
  if (!devServerUrl) return false
  try {
    return new URL(url).origin === new URL(devServerUrl).origin
  } catch {
    return false
  }
}

/** Only web links may be handed to the OS browser. */
export function isSafeExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 4096) return false
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !!parsed.hostname
  } catch {
    return false
  }
}

/** File types the renderer may ask the OS to open (config and text files — never programs or scripts). */
export const OPENABLE_EXTENSIONS = ['.json', '.jsonc', '.json5', '.md', '.markdown', '.txt', '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.csv', '.xml', '.plist']

/** Lower-cased extension of a path ('' when none). Works with / and \ separators. */
export function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

/**
 * Whether the renderer may open `path` with the default app: folders always, files only when
 * they are config/text files (opening an .exe/.bat/.app would run it).
 */
export function isOpenablePath(path: string, isDirectory: boolean): boolean {
  if (isDirectory) return true
  return OPENABLE_EXTENSIONS.includes(extensionOf(path))
}

/**
 * Content-Security-Policy for renderer pages. Development additionally allows the inline React
 * Refresh preamble and the Vite HMR websocket.
 */
export function rendererCsp(devServerUrl?: string): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'img-src': ["'self'", 'data:', 'https:'],
    'style-src': ["'self'", "'unsafe-inline'"],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"]
  }
  if (devServerUrl) {
    try {
      const dev = new URL(devServerUrl)
      const ws = `${dev.protocol === 'https:' ? 'wss' : 'ws'}://${dev.host}`
      directives['script-src'].push("'unsafe-inline'", dev.origin)
      directives['connect-src'].push(dev.origin, ws)
    } catch {
      // Malformed dev URL: keep the production policy.
    }
  }
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ')
}
