import { type CSSProperties, type ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { useMediaQuery } from '../../lib/hooks'
import { getPage } from '../../lib/nav'
import { useAppStore } from '../../lib/store'
import { Sidebar } from './Sidebar'
import { TitleBar } from './TitleBar'

/** Below this window width the sidebar collapses to icons. */
const COMPACT_QUERY = '(max-width: 979px)'

/** id of the scrollable main region (the router scrolls it to the top on page changes). */
export const MAIN_CONTENT_ID = 'main-content'

/**
 * Window layout: title bar on top, sidebar on the left, and the page in a rounded, scrollable content
 * panel with a centered max-width container.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const compact = useMediaQuery(COMPACT_QUERY)
  const pageId = useAppStore((s) => s.route.page)
  const page = getPage(pageId)
  const style = { '--sidebar-width': compact ? '68px' : '240px' } as CSSProperties

  return (
    <div className="flex h-full flex-col bg-sidebar text-fg" style={style}>
      <button
        type="button"
        onClick={() => document.getElementById(MAIN_CONTENT_ID)?.focus()}
        className={cn(
          'sr-only z-[80] rounded-lg bg-elevated px-3 py-2 text-sm font-medium shadow-lg',
          'focus:not-sr-only focus:fixed focus:top-2 focus:left-2'
        )}
      >
        Skip to content
      </button>
      <TitleBar compact={compact} />
      <div className="flex min-h-0 flex-1">
        <Sidebar compact={compact} />
        <main
          id={MAIN_CONTENT_ID}
          tabIndex={-1}
          className={cn(
            'relative min-w-0 flex-1 overflow-y-auto rounded-tl-2xl border-t border-l border-line bg-canvas outline-none',
            'shadow-[0_0_0_0.5px_var(--elev-1),-6px_0_20px_-14px_var(--elev-3)] [scrollbar-gutter:stable]'
          )}
        >
          <div
            className={cn(
              'mx-auto w-full pt-9 pb-16',
              compact ? 'px-6' : 'px-10',
              page.width === 'wide' ? 'max-w-[1320px]' : 'max-w-[1120px]'
            )}
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
