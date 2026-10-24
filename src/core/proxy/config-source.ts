/**
 * The configuration a running proxy serves with.
 *
 * Normally that is this process's in-memory state. But the proxy may be hosted by one Claude Setup process
 * (the app) while another one (the CLI, or the MCP server Claude Code launched) saves a new upstream or
 * route. Every few seconds the state file's mtime is checked; a newer proxy section written by another
 * process is picked up without a restart. Changes made in this process always win until they are on disk.
 */
import { statSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { ProxyConfig } from '@shared/types'
import type { StateStore } from '../state'
import { sanitizeProxyConfig } from './config'
import { isObject } from './wire'

/** Live, sanitized proxy configuration (in-memory state, refreshed from state.json written by other processes). */
export class ProxyConfigSource {
  private memoryRef: unknown
  private memorySeenAt: number
  private disk: { config: ProxyConfig; seenAt: number } | null = null
  private diskMtime: number
  private lastCheck = 0
  private checking: Promise<void> | null = null

  constructor(
    private readonly state: StateStore,
    private readonly checkIntervalMs = 2000
  ) {
    this.memoryRef = state.get().proxy
    this.memorySeenAt = Date.now()
    // Baseline now: the in-memory state reflects the file as it is at this moment.
    try {
      this.diskMtime = statSync(state.file).mtimeMs
    } catch {
      this.diskMtime = 0
    }
  }

  /** Effective (sanitized) configuration right now. */
  async current(): Promise<ProxyConfig> {
    const memory = this.state.get().proxy
    if (memory !== this.memoryRef) {
      this.memoryRef = memory
      this.memorySeenAt = Date.now()
    }
    if (Date.now() - this.lastCheck >= this.checkIntervalMs) {
      this.checking ??= this.checkDisk().finally(() => {
        this.checking = null
      })
      await this.checking
    }
    if (this.disk && this.disk.seenAt > this.memorySeenAt) return this.disk.config
    return sanitizeProxyConfig(memory)
  }

  private async checkDisk(): Promise<void> {
    this.lastCheck = Date.now()
    try {
      const info = await stat(this.state.file)
      if (info.mtimeMs === this.diskMtime) return
      this.diskMtime = info.mtimeMs
      const text = await readFile(this.state.file, 'utf8')
      const json: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
      if (isObject(json) && isObject(json.proxy)) this.disk = { config: sanitizeProxyConfig(json.proxy), seenAt: Date.now() }
    } catch {
      // Missing or unreadable file: keep serving the current configuration.
    }
  }
}
