/** Locations of the app's own built files and bundled resources (dev and packaged). */
import { app } from 'electron'
import { join } from 'node:path'

/**
 * electron-vite dev server URL. Ignored in packaged builds so an environment variable can never
 * make the installed app load (and grant IPC access to) a foreign page.
 */
export function devServerUrl(): string | undefined {
  if (app.isPackaged) return undefined
  return process.env.ELECTRON_RENDERER_URL || undefined
}

/** A file inside the app (project root in development, app.asar when packaged). */
export function appFile(...parts: string[]): string {
  return join(app.getAppPath(), ...parts)
}

/** Built preload script (out/preload/index.js). */
export function preloadPath(): string {
  return appFile('out', 'preload', 'index.js')
}

/** Built renderer entry page (out/renderer/index.html). */
export function rendererIndexPath(): string {
  return appFile('out', 'renderer', 'index.html')
}

/** A bundled file from resources/ (icons). Read it with fs (asar-aware in Electron), which works in both layouts. */
export function resourcePath(name: string): string {
  return appFile('resources', name)
}
