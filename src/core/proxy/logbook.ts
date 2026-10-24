/** Request log (ring buffer) and counters for the proxy status. */
import type { ProxyLogEntry } from '@shared/types'

/** Number of log entries kept in memory. */
export const LOG_CAPACITY = 500

/** Ring buffer of ProxyLogEntry plus request/error counters; notifies a listener for every entry. */
export class ProxyLogBook {
  private readonly entries: ProxyLogEntry[] = []
  requests = 0
  errors = 0
  lastError?: string

  constructor(
    private readonly onEntry?: (entry: ProxyLogEntry) => void,
    private readonly capacity = LOG_CAPACITY
  ) {}

  /** Append an entry (timestamped now) and notify listeners. */
  add(entry: Omit<ProxyLogEntry, 'time'>): ProxyLogEntry {
    const full: ProxyLogEntry = { time: new Date().toISOString(), ...entry }
    this.entries.push(full)
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity)
    try {
      this.onEntry?.(full)
    } catch {
      // a failing listener must never break request handling
    }
    return full
  }

  /** Count one handled API request; `error` marks it failed and becomes `lastError`. */
  count(error?: string): void {
    this.requests++
    if (error) {
      this.errors++
      this.lastError = error
    }
  }

  /** The newest `limit` entries, oldest first. */
  list(limit = 200): ProxyLogEntry[] {
    const n = Math.max(1, Math.min(Math.floor(Number.isFinite(limit) ? limit : 200), this.capacity))
    return this.entries.slice(-n)
  }
}
