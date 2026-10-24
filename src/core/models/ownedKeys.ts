/**
 * The Claude Code settings Claude Setup owns.
 *
 * Every key in ALWAYS_OWNED_ENV belongs to the third-party model setup: apply() removes them all before writing a
 * profile (so nothing stale from an earlier provider survives) and reset() removes them all to go back to official
 * Claude. Any OTHER key we write (cloud region/project variables, NO_PROXY, profile extras…) is tracked in the apply
 * marker together with a tag of the value we wrote, and is only removed later when it still holds that value.
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homeDir } from '../platform/paths'

const TIERS = ['OPUS', 'SONNET', 'HAIKU', 'FABLE'] as const

/** Model slot → Claude Code variable. `main` is the session model, `subagent` the default subagent model. */
export const SLOT_ENV = {
  main: 'ANTHROPIC_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  subagent: 'CLAUDE_CODE_SUBAGENT_MODEL'
} as const

/** Variables that select one of Anthropic's official cloud providers. */
export const CLOUD_SWITCH_ENV = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS'
] as const

/** Credential variables Claude Code reads (exactly one may be set). */
export const CREDENTIAL_ENV = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const

/** Keys Claude Setup always owns in `env` (settings.json) and in VS Code `claudeCode.environmentVariables`. */
export const ALWAYS_OWNED_ENV: readonly string[] = [
  'ANTHROPIC_BASE_URL',
  ...CREDENTIAL_ENV,
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  ...TIERS.flatMap((t) => [`ANTHROPIC_DEFAULT_${t}_MODEL`, `ANTHROPIC_DEFAULT_${t}_MODEL_NAME`, `ANTHROPIC_DEFAULT_${t}_MODEL_DESCRIPTION`]),
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'ENABLE_TOOL_SEARCH',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_ATTRIBUTION_HEADER',
  'API_TIMEOUT_MS',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_INTERLEAVED_THINKING',
  'CLAUDE_CODE_DISABLE_THINKING',
  'CLAUDE_CODE_EXTRA_BODY',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
  ...CLOUD_SWITCH_ENV
]

const ALWAYS = new Set(ALWAYS_OWNED_ENV)

/**
 * True for keys removed on every apply/reset regardless of who wrote them. Everything else Claude Setup writes —
 * e.g. AWS_REGION, CLOUD_ML_REGION, ANTHROPIC_VERTEX_PROJECT_ID, ANTHROPIC_FOUNDRY_*, NO_PROXY, profile extras —
 * is only removed when the apply marker says Claude Setup wrote it and it still holds that value.
 */
export function isAlwaysOwned(name: string): boolean {
  return ALWAYS.has(name)
}

/** Variables never accepted from a profile's extra env (they come from the provider, key field or proxy). */
export const PROTECTED_EXTRA_ENV: readonly string[] = ['ANTHROPIC_BASE_URL', ...CREDENTIAL_ENV, ...Object.values(SLOT_ENV)]

/** `apiKeyHelper` command written for profiles that keep their key in Claude Setup's secret store. */
export function keyHelperCommand(profileId: string, platform: NodeJS.Platform = process.platform): string {
  return `"${keyHelperShimPath(platform)}" secret get profile:${profileId}`
}

/**
 * Absolute path of the claude-setup CLI shim (written by SelfApi.installCli into ~/.local/bin).
 * Used quoted in apiKeyHelper so it works even when ~/.local/bin is not on PATH.
 */
export function keyHelperShimPath(platform: NodeJS.Platform = process.platform): string {
  return join(homeDir(), '.local', 'bin', platform === 'win32' ? 'claude-setup.cmd' : 'claude-setup')
}

/** Recognises an apiKeyHelper written by Claude Setup (even when the apply marker was lost). */
export function isOurKeyHelper(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^(?:"[^"]*claude-setup(?:\.cmd)?"|\S*claude-setup(?:\.cmd)?)\s+secret\s+get\s+profile:[a-z0-9-]+\s*$/i.test(value.trim())
  )
}

/**
 * Short, non-reversible tag of a value we wrote, so later cleanups can tell whether the user changed it.
 * (Truncated SHA-256 — never the value itself, so secrets don't end up in state.json.)
 */
export function valueTag(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('hex')
    .slice(0, 16)
}
