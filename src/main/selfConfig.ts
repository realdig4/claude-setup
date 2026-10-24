/**
 * Works out how this GUI installation launches Claude Setup's own MCP server.
 * Packaged: <exe> <resources>/app.asar/out/main/mcp.js with ELECTRON_RUN_AS_NODE=1.
 * Development: the dev Electron binary with <project>/out/main/mcp.js.
 * Portable builds, macOS translocated/disk-image copies and AppImages get no config (and a reason).
 */
import { app } from 'electron'
import { guiSelfLaunch, type SelfLaunch } from '@core/self/launch'

/** How this GUI installation launches its own MCP server (or why it can't). */
export function resolveSelfMcp(): SelfLaunch {
  return guiSelfLaunch({
    platform: process.platform,
    packaged: app.isPackaged,
    execPath: process.execPath,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    env: process.env
  })
}
