import { FolderOpen } from 'lucide-react'
import { ui } from '../../lib/api'
import { cn } from '../../lib/cn'
import { truncateMiddle } from '../../lib/format'
import { CopyButton } from './CopyButton'
import { toast } from './toast'
import { Tooltip } from './Tooltip'

export interface PathTextProps {
  path: string
  /** Max characters before the middle is elided (default 56). The full path shows in a tooltip. */
  max?: number
  /** Show a copy button. */
  copy?: boolean
  /** Show a "Show in folder" button (opens the OS file manager). */
  reveal?: boolean
  className?: string
}

/**
 * A file/folder path in monospace, shortened in the middle, with optional copy / show-in-folder actions.
 * Mostly for Advanced mode.
 * @example <PathText path={target.configPath} copy reveal />
 */
export function PathText({ path, max = 56, copy, reveal, className }: PathTextProps) {
  const short = truncateMiddle(path, max)
  const text = <span className="min-w-0 truncate font-mono text-xs text-fg-muted">{short}</span>
  return (
    <span className={cn('inline-flex max-w-full min-w-0 items-center gap-1', className)}>
      {short !== path ? (
        <Tooltip content={<span className="font-mono text-[11.5px] break-all">{path}</span>}>
          <span className="min-w-0 truncate" tabIndex={0}>
            {text}
          </span>
        </Tooltip>
      ) : (
        text
      )}
      {copy ? <CopyButton text={path} label="Copy path" className="size-7" /> : null}
      {reveal ? (
        <button
          type="button"
          onClick={() => void ui.showItemInFolder(path).catch(() => toast.error('Couldn’t open the folder', { description: path }))}
          className="grid size-7 shrink-0 place-items-center rounded-lg text-fg-subtle transition-colors hover:bg-surface-3/60 hover:text-fg"
          aria-label="Show in folder"
          title="Show in folder"
        >
          <FolderOpen className="size-[15px]" aria-hidden="true" />
        </button>
      ) : null}
    </span>
  )
}
