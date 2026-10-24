/** Which credentials Claude Code will actually see (settings env wins over the shell; "" cancels a shell export). */

export type CredentialSource = 'settings' | 'shell' | null

export interface CredentialState {
  /** ANTHROPIC_AUTH_TOKEN (sent as Authorization: Bearer). */
  token: CredentialSource
  /** ANTHROPIC_API_KEY (sent as x-api-key). */
  apiKey: CredentialSource
  /** An apiKeyHelper command in settings.json. */
  helper: boolean
  /** Number of active credentials (more than one = auth conflict warning in Claude Code). */
  count: number
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

function source(name: string, env: Record<string, unknown>, shell: Record<string, string | undefined>): CredentialSource {
  if (name in env) return nonEmpty(env[name]) ? 'settings' : null
  return nonEmpty(shell[name]) ? 'shell' : null
}

/** Effective credential sources for a settings env block, apiKeyHelper value and shell environment. */
export function credentialState(env: Record<string, unknown>, apiKeyHelper: unknown, shell: Record<string, string | undefined>): CredentialState {
  const token = source('ANTHROPIC_AUTH_TOKEN', env, shell)
  const apiKey = source('ANTHROPIC_API_KEY', env, shell)
  const helper = nonEmpty(apiKeyHelper)
  return { token, apiKey, helper, count: (token ? 1 : 0) + (apiKey ? 1 : 0) + (helper ? 1 : 0) }
}

/** Human description of a conflict, e.g. "ANTHROPIC_AUTH_TOKEN (settings) and ANTHROPIC_API_KEY (your shell)". */
export function describeCredentials(state: CredentialState): string {
  const parts: string[] = []
  if (state.token) parts.push(`ANTHROPIC_AUTH_TOKEN (${state.token === 'shell' ? 'your shell environment' : 'settings.json'})`)
  if (state.apiKey) parts.push(`ANTHROPIC_API_KEY (${state.apiKey === 'shell' ? 'your shell environment' : 'settings.json'})`)
  if (state.helper) parts.push('apiKeyHelper (settings.json)')
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}
