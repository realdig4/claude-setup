/** Generic icons for the apps Claude Setup configures (no brand logos; same set as the rest of the app). */
import { CodeXml, MessagesSquare, MousePointer2, SquareTerminal, Wind, type LucideIcon } from 'lucide-react'
import type { TargetId } from '@shared/types'

export const APP_ICONS: Record<TargetId, LucideIcon> = {
  'claude-desktop': MessagesSquare,
  'claude-code': SquareTerminal,
  vscode: CodeXml,
  cursor: MousePointer2,
  windsurf: Wind
}

/** Plain-words blurb for each app. */
export const APP_BLURBS: Record<TargetId, string> = {
  'claude-desktop': 'The Claude chat app',
  'claude-code': 'Terminal and the VS Code extension',
  vscode: 'VS Code’s own agent mode (Copilot)',
  cursor: 'The Cursor code editor',
  windsurf: 'The Windsurf code editor'
}

export const APP_ORDER: readonly TargetId[] = ['claude-desktop', 'claude-code', 'vscode', 'cursor', 'windsurf']
