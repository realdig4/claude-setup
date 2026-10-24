/** UiApi: GUI helpers the renderer may call (links, file dialogs, clipboard, window controls). */
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { clipboard, dialog, shell, type BrowserWindow, type OpenDialogOptions } from 'electron'
import type { UiApi } from '@shared/api'
import { isOpenablePath, isSafeExternalUrl } from './guards'

function requirePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) throw new Error('A full file or folder path is required.')
  return value
}

async function isDirectory(path: string): Promise<boolean | null> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return null
  }
}

function sanitizeFilters(filters: unknown): OpenDialogOptions['filters'] {
  if (!Array.isArray(filters)) return undefined
  return filters
    .filter((f): f is { name: string; extensions: string[] } => !!f && typeof f.name === 'string' && Array.isArray(f.extensions))
    .map((f) => ({ name: f.name.slice(0, 100), extensions: f.extensions.filter((e) => typeof e === 'string').map((e) => e.replace(/^\./, '')) }))
}

/** Build the UiApi implementation bound to the main window. */
export function createUiApi(getWindow: () => BrowserWindow | null): UiApi {
  const showOpen = async (options: OpenDialogOptions): Promise<string | null> => {
    const win = getWindow()
    const result = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0]
  }

  return {
    async openExternal(url) {
      if (!isSafeExternalUrl(url)) throw new Error('Only web links (http or https) can be opened.')
      await shell.openExternal(url)
    },

    async showItemInFolder(path) {
      shell.showItemInFolder(requirePath(path))
    },

    async openPath(path) {
      const target = requirePath(path)
      const dir = await isDirectory(target)
      if (dir === null) return `Not found: ${target}`
      if (!isOpenablePath(target, dir)) {
        shell.showItemInFolder(target)
        return 'For safety, Claude Setup only opens folders and text or config files. The file is shown in its folder instead.'
      }
      return shell.openPath(target)
    },

    async pickFolder(opts) {
      return showOpen({
        title: typeof opts?.title === 'string' ? opts.title : 'Choose a folder',
        defaultPath: typeof opts?.defaultPath === 'string' ? opts.defaultPath : undefined,
        properties: ['openDirectory', 'createDirectory']
      })
    },

    async pickFile(opts) {
      return showOpen({
        title: typeof opts?.title === 'string' ? opts.title : 'Choose a file',
        filters: sanitizeFilters(opts?.filters),
        properties: ['openFile']
      })
    },

    async copyText(text) {
      await clipboard.writeText(String(text ?? ''))
    },

    async readClipboard() {
      return (await clipboard.readText()).slice(0, 100_000)
    },

    async windowState() {
      const win = getWindow()
      return { maximized: !!win && !win.isDestroyed() && win.isMaximized() }
    },

    async window(action) {
      const win = getWindow()
      if (!win || win.isDestroyed()) return
      if (action === 'minimize') win.minimize()
      else if (action === 'maximize') {
        if (win.isMaximized()) win.unmaximize()
        else win.maximize()
      } else if (action === 'close') win.close()
      else throw new Error(`Unknown window action: ${String(action)}`)
    }
  }
}
