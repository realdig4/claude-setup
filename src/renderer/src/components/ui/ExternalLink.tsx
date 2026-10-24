import type { ComponentProps, MouseEvent } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { ui } from '../../lib/api'
import { cn } from '../../lib/cn'
import { toast } from './toast'

const SAFE_URL = /^(https?:|mailto:)/i

/** Open a URL in the user's default browser (http/https/mailto only). */
export async function openExternal(url: string): Promise<void> {
  if (!SAFE_URL.test(url)) {
    toast.error('That link can’t be opened', { description: url })
    return
  }
  try {
    await ui.openExternal(url)
  } catch {
    toast.error('Couldn’t open your browser', { description: url })
  }
}

export interface ExternalLinkProps extends Omit<ComponentProps<'a'>, 'href'> {
  href: string
  /** Show the ↗ icon (default true). */
  showIcon?: boolean
  /** 'accent' (default) or 'muted' (inherits a quieter color). */
  tone?: 'accent' | 'muted'
}

/**
 * Link that opens in the system browser (never inside the app window).
 * @example <ExternalLink href="https://platform.kimi.ai/console/api-keys">Get an API key</ExternalLink>
 */
export function ExternalLink({ href, showIcon = true, tone = 'accent', className, children, onClick, ...props }: ExternalLinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event)
    event.preventDefault()
    void openExternal(href)
  }
  return (
    <a
      href={href}
      onClick={handleClick}
      onAuxClick={(event) => {
        // Middle-click would open a new Electron window — open the system browser instead.
        event.preventDefault()
        if (event.button === 1) void openExternal(href)
      }}
      rel="noreferrer noopener"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-sm font-medium underline-offset-[3px] hover:underline',
        tone === 'accent' ? 'text-accent-text' : 'text-fg-muted hover:text-fg',
        className
      )}
      {...props}
    >
      {children ?? href}
      {showIcon ? <ArrowUpRight className="size-3.5 shrink-0 opacity-80" aria-hidden="true" /> : null}
      <span className="sr-only"> (opens in your browser)</span>
    </a>
  )
}
