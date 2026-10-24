/**
 * Running the Claude Code CLI for plugin work (`claude plugin … --json`).
 * Verified on 2.1.309: operations print one JSON line ({command, outcome, message, failureCode?}),
 * listings print pretty-printed JSON, and a few commands print plain text — parseCliJson handles all three.
 */
import type { OpResult } from '@shared/types'
import { isPlainObject } from '../fs/json'
import { run, type RunResult } from '../platform/exec'
import { findClaudeCli } from '../platform/runtimes'
import { clip, errorMessage } from './util'

/** Built-in virtual marketplace backed by Anthropic's plugin directory (no `marketplace add` needed). */
export const PLUGIN_DIRECTORY = 'anthropic-plugin-directory'

/** Locate the claude CLI; null when it is not installed (never throws). */
export async function locateClaudeCli(): Promise<string | null> {
  try {
    return await findClaudeCli()
  } catch {
    return null
  }
}

/**
 * Extra environment for plugin commands:
 * - CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1 clones "owner/repo" over HTTPS (no SSH probe or host-key prompt);
 * - GIT_TERMINAL_PROMPT=0 makes git fail fast instead of waiting for credentials;
 * - on Windows, core.longpaths=true (via GIT_CONFIG_COUNT/KEY/VALUE, appended after any existing entries),
 *   because marketplace clones otherwise fail with "Filename too long".
 */
export function pluginCommandEnv(platform: string = process.platform, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { CLAUDE_CODE_PLUGIN_PREFER_HTTPS: '1', GIT_TERMINAL_PROMPT: '0' }
  if (platform === 'win32') {
    const n = Math.max(0, Number.parseInt(base.GIT_CONFIG_COUNT ?? '0', 10) || 0)
    env.GIT_CONFIG_COUNT = String(n + 1)
    env[`GIT_CONFIG_KEY_${n}`] = 'core.longpaths'
    env[`GIT_CONFIG_VALUE_${n}`] = 'true'
  }
  return env
}

/**
 * Parse CLI JSON output: the whole stdout (pretty-printed listings), else the last JSON line
 * (operations may print progress first), else a JSON block starting at column 0. undefined when none.
 */
export function parseCliJson(stdout: string): unknown {
  const text = stdout.trim()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    // fall through
  }
  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    if (line.startsWith('{') || line.startsWith('[')) {
      try {
        return JSON.parse(line)
      } catch {
        // maybe the start of a multi-line block
      }
    }
    if (lines[i].startsWith('{') || lines[i].startsWith('[')) {
      try {
        return JSON.parse(lines.slice(i).join('\n'))
      } catch {
        // keep looking further up
      }
    }
  }
  return undefined
}

export interface CliResult {
  /** The operation succeeded (or there was nothing to do). */
  ok: boolean
  /** Parsed JSON object, when the command printed one. */
  json?: Record<string, unknown>
  /** Best available message (JSON message, else stderr/stdout). */
  message: string
  failureCode?: string
  /** Nothing to do: already enabled / disabled / installed. */
  alreadyDone: boolean
  timedOut: boolean
  spawnError?: string
  raw: RunResult
}

/** Run `claude <args>` with the plugin environment and interpret the result. */
export async function runClaude(cli: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<CliResult> {
  let raw: RunResult
  try {
    raw = await run(cli, args, { cwd: opts.cwd, env: pluginCommandEnv(), timeoutMs: opts.timeoutMs ?? 120_000 })
  } catch (err) {
    raw = { ok: false, code: null, stdout: '', stderr: '', timedOut: false, error: errorMessage(err) }
  }
  const parsed = parseCliJson(raw.stdout)
  const json = isPlainObject(parsed) ? parsed : undefined
  const outcome = typeof json?.outcome === 'string' ? json.outcome : undefined
  const failureCode = typeof json?.failureCode === 'string' ? json.failureCode : undefined
  const alreadyDone = json?.alreadyInGoalState === true || failureCode === 'already_in_goal_state'
  const ok = !raw.timedOut && (alreadyDone || (outcome ? outcome === 'ok' : raw.ok && !raw.error))
  const message =
    (typeof json?.message === 'string' && json.message.trim()) ||
    lastMeaningfulLine(raw.stderr) ||
    (json ? '' : clip(stripMarks(raw.stdout), 600)) ||
    raw.error ||
    ''
  return { ok, json, message, failureCode, alreadyDone, timedOut: raw.timedOut, spawnError: raw.error, raw }
}

function stripMarks(text: string): string {
  return text.replace(/^[\s✔✘✓✗×]+/gmu, '').trim()
}

function lastMeaningfulLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => stripMarks(l))
    .filter(Boolean)
  return lines.length ? clip(lines[lines.length - 1], 600) : ''
}

/** OpResult for "the claude CLI is not installed". */
export function claudeMissing(): OpResult {
  return {
    ok: false,
    message: 'Install Claude Code first',
    details:
      "Plugins and marketplaces are managed by Claude Code itself, and Claude Setup can't find it on this computer. " +
      'Install Claude Code (from the Home or Doctor page, or https://claude.com/claude-code), then try again.'
  }
}

/** Friendly OpResult for a failed CLI operation. `action` reads like "install this plugin". */
export function explainCliFailure(r: CliResult, action: string, opts: { notFound?: string; notConfigured?: string } = {}): OpResult {
  const text = `${r.message}\n${r.raw.stderr}\n${r.raw.stdout.slice(-2000)}`
  let message: string
  if (r.spawnError && !r.raw.stdout && !r.raw.stderr) message = `Couldn't start Claude Code to ${action}. Try reinstalling Claude Code.`
  else if (r.timedOut) message = `Claude Code took too long to ${action}. Check your internet connection and try again.`
  else if (/filename too long|path too long|MAX_PATH/i.test(text))
    message = 'Windows could not save some files because their paths are too long. Run "git config --global core.longpaths true" in a terminal, then try again.'
  else if (r.failureCode === 'not_found' && opts.notFound) message = opts.notFound
  else if (r.failureCode === 'not_configured' && opts.notConfigured) message = opts.notConfigured
  else if (/unable to get password|could not read username|repository not found|authentication failed|terminal prompts disabled|cannot prompt/i.test(text))
    message = "The repository couldn't be downloaded. Check the name — it may not exist, or it may be private."
  else if (/could not resolve host|unable to access|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|network/i.test(text))
    message = `Couldn't reach the internet to ${action}. Check your connection and try again.`
  else if (/accept-command|--yes\b|\s-y\b|requires? confirmation/i.test(text))
    message =
      'This plugin runs a setup command while it installs. For your safety, install it from inside Claude Code with /plugin, ' +
      'where you can review that command first.'
  else if (/\bgit\b.*(not found|not installed|not recognized|ENOENT)|spawn git/i.test(text))
    message = 'Git is needed to download plugins. Install Git (git-scm.com), then try again.'
  else message = `Claude Code couldn't ${action}.`
  return { ok: false, message, details: r.message || r.raw.stderr.trim() || r.spawnError || undefined }
}
