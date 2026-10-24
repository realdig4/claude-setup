/**
 * "Start Claude Setup at login (hidden in the tray)" — keeps the model proxy available after a reboot.
 * Windows/macOS use Electron login items; Linux uses an XDG autostart .desktop file.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

export const HIDDEN_ARG = '--hidden'

/** Started by the login item: open in the tray only (no window). */
export function startedHidden(argv: string[] = process.argv): boolean {
  if (argv.includes(HIDDEN_ARG)) return true
  if (process.platform === 'darwin') {
    try {
      return app.getLoginItemSettings().wasOpenedAtLogin
    } catch {
      return false
    }
  }
  return false
}

function autostartFile(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(configHome, 'autostart', 'claude-setup.desktop')
}

/** Quote a path for a .desktop Exec line. */
function desktopQuote(path: string): string {
  return `"${path.replace(/(["`$\\])/g, '\\$1')}"`
}

/**
 * Turn the login item on/off. Returns null on success, or a friendly reason why it is not
 * possible for this copy (dev build, portable exe, …).
 */
export async function applyLoginItem(enabled: boolean): Promise<string | null> {
  if (!app.isPackaged) return enabled ? 'Start at login only works in the installed app.' : null
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    return enabled ? 'The portable version cannot start at login. Use the installer version instead.' : null
  }
  if (process.platform === 'linux') {
    const file = autostartFile()
    if (!enabled) {
      await rm(file, { force: true }).catch(() => {})
      return null
    }
    const exec = process.env.APPIMAGE || process.execPath
    const body = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Claude Setup',
      'Comment=Keeps the Claude Setup model proxy available',
      `Exec=${desktopQuote(exec)} ${HIDDEN_ARG}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      ''
    ].join('\n')
    try {
      await mkdir(join(file, '..'), { recursive: true })
      await writeFile(file, body, 'utf8')
      return null
    } catch (err) {
      return `Could not create the autostart entry: ${(err as Error).message}`
    }
  }
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_ARG] })
    return null
  } catch (err) {
    return `Could not change the login item: ${(err as Error).message}`
  }
}
