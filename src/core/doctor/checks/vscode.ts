/** VS Code: Claude Code extension installed, and its model settings in line with the terminal. */
import { join } from 'node:path'
import type { DoctorCheck } from '@shared/types'
import { pathExists } from '../../fs/json'
import { homeDir, vscodeUserDir } from '../../platform/paths'
import { findClaudeCodeExtensions } from '../../targets/claudeCode'
import { guard, type CheckGroup, type RunContext } from '../context'

const CATEGORY = 'vscode' as const
const FIX = { id: 'apply-model-vscode', label: 'Use the same settings in VS Code', auto: true }
const EXTENSION_TITLE = 'Claude Code for VS Code'
const MODEL_TITLE = 'Model settings in VS Code'

async function vscodeInstalled(rc: RunContext): Promise<boolean> {
  if ((await pathExists(vscodeUserDir('Code'))) || (await pathExists(vscodeUserDir('Code - Insiders')))) return true
  if (await pathExists(join(homeDir(), '.vscode'))) return true
  try {
    return Boolean((await rc.runtime('code'))?.found)
  } catch {
    return false
  }
}

async function modelCheck(rc: RunContext, extensionInstalled: boolean): Promise<DoctorCheck | null> {
  if (!extensionInstalled) return null
  const m = await rc.models()
  if (m.settingsError) return null
  const base = { id: 'vscode:model', category: CATEGORY, title: MODEL_TITLE }
  const what = m.mode === 'anthropic' ? 'Claude' : (m.providerName ?? 'a custom endpoint')
  if (m.mode !== 'anthropic' && !m.vscode.configured) {
    const detail =
      `Claude Code in the terminal uses ${what}, but the VS Code extension isn't set up for it, ` +
      'so it may ask you to sign in or use Claude instead.'
    return { ...base, status: 'warn', detail, fix: FIX }
  }
  if (m.mode === 'anthropic' && m.vscode.configured) {
    return { ...base, status: 'warn', detail: 'The VS Code extension still has third-party model settings while the terminal uses Claude.', fix: FIX }
  }
  if (!m.vscode.matches) {
    return { ...base, status: 'warn', detail: `The VS Code extension uses different model settings than the terminal (which uses ${what}).`, fix: FIX }
  }
  return { ...base, status: 'ok', detail: `VS Code and the terminal both use ${what}.` }
}

export const vscodeChecks: CheckGroup = {
  id: 'vscode',
  category: CATEGORY,
  title: 'VS Code',
  timeoutMs: 20_000,
  async run(rc) {
    const base = { id: 'vscode:extension', category: CATEGORY, title: EXTENSION_TITLE }
    if (!(await vscodeInstalled(rc))) return [{ ...base, status: 'skip', detail: "VS Code isn't installed." }]
    const all = await findClaudeCodeExtensions().catch(() => [])
    const extensions = all.filter((e) => e.editor === 'VS Code' || e.editor === 'VS Code Insiders')
    const extension: DoctorCheck = extensions.length
      ? { ...base, status: 'ok', detail: extensions.map((e) => `${e.editor}: version ${e.version}`).join('; ') }
      : {
          ...base,
          status: 'info',
          detail:
            "The Claude Code extension isn't installed in VS Code. Install \"Claude Code for VS Code\" from the Extensions view " +
            '(or run: code --install-extension anthropic.claude-code).',
          docsUrl: 'https://code.claude.com/docs/en/vs-code'
        }
    const model = await guard('vscode:model', CATEGORY, MODEL_TITLE, () => modelCheck(rc, extensions.length > 0))
    return [extension, ...model]
  }
}
