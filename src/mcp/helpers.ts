/** Zod-free helpers shared by the MCP tools and the CLI (keeps the CLI from loading zod). */
import type { CoreApi } from '@shared/api'
import type { ModelTarget } from '@shared/types'

/** Config keys allowed by Claude Desktop and Claude Code. */
export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Accept "npx -y some-server" as a command when no args were given (models often do this).
 * Paths containing separators are left alone so "C:\Program Files\…" keeps working.
 */
export function splitCommandLine(command: string, args: string[] | undefined): { command: string; args: string[] } {
  const trimmed = command.trim()
  if (args?.length || !/\s/.test(trimmed)) return { command: trimmed, args: args ?? [] }
  const tokens = trimmed.match(/"[^"]*"|'[^']*'|\S+/g)?.map((t) => t.replace(/^(["'])(.*)\1$/, '$2')) ?? []
  if (!tokens.length || /[\\/]/.test(tokens[0])) return { command: trimmed, args: [] }
  return { command: tokens[0], args: tokens.slice(1) }
}

/** Claude Code always; VS Code too when it is installed (its extension needs its own settings). */
export async function defaultModelTargets(core: CoreApi): Promise<ModelTarget[]> {
  try {
    const targets = await core.targets.list()
    return targets.some((t) => t.id === 'vscode' && t.installed) ? ['claude-code', 'vscode'] : ['claude-code']
  } catch {
    return ['claude-code']
  }
}
