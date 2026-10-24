/**
 * App identity used across Home, Discover and My Tools: icons (generic — no brand logos), one-line blurbs
 * and where to get each app.
 */
import { CodeXml, MessagesSquare, MousePointer2, SquareTerminal, Wind, type LucideIcon } from 'lucide-react'
import type { TargetId } from '@shared/types'
import { IconTile, type IconTileSize, type Tone } from '@renderer/components/ui'

export const APP_ICONS: Record<TargetId, LucideIcon> = {
  'claude-desktop': MessagesSquare,
  'claude-code': SquareTerminal,
  vscode: CodeXml,
  cursor: MousePointer2,
  windsurf: Wind
}

/** Short plain-words description of each app. */
export const APP_BLURBS: Record<TargetId, string> = {
  'claude-desktop': 'The Claude chat app',
  'claude-code': 'Terminal & VS Code',
  vscode: 'VS Code’s own agent mode (Copilot)',
  cursor: 'The Cursor code editor',
  windsurf: 'The Windsurf code editor'
}

/** Official download / install pages. */
export const APP_GET_URLS: Record<TargetId, string> = {
  'claude-desktop': 'https://claude.com/download',
  'claude-code': 'https://code.claude.com/docs/en/setup',
  vscode: 'https://code.visualstudio.com/download',
  cursor: 'https://cursor.com/downloads',
  windsurf: 'https://windsurf.com/download'
}

export interface AppIconProps {
  target: TargetId
  size?: IconTileSize
  tone?: Tone
  className?: string
}

/** An app's icon on a tinted tile. */
export function AppIcon({ target, size = 'md', tone = 'neutral', className }: AppIconProps) {
  return <IconTile icon={APP_ICONS[target]} size={size} tone={tone} className={className} />
}
