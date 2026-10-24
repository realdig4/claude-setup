import { ChevronLeft, Minus, Search, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { platform, ui, useCoreEvent } from '../../lib/api'
import { cn } from '../../lib/cn'
import { getPage } from '../../lib/nav'
import { useAppStore } from '../../lib/store'
import { Shortcut } from '../ui/Kbd'
import { Portal } from '../ui/overlay'
import { Tooltip } from '../ui/Tooltip'
import { Wordmark } from './Brand'

const IS_MAC = platform === 'darwin'

/** Width reserved on the right for the window buttons (Windows: 3 × 46px). */
const CONTROLS_WIDTH = platform === 'win32' ? 'w-[138px]' : platform === 'linux' ? 'w-[108px]' : 'w-0'

/**
 * Frameless window title bar: drag region, wordmark, back + page crumb, command palette trigger and
 * (Windows/Linux) minimize / maximize / close. On macOS the native traffic lights sit in the left padding.
 */
export function TitleBar({ compact = false }: { compact?: boolean }) {
  const route = useAppStore((s) => s.route)
  const canGoBack = useAppStore((s) => s.history.length > 0)
  const back = useAppStore((s) => s.back)
  const setCommandOpen = useAppStore((s) => s.setCommandOpen)
  const page = getPage(route.page)
  const PageIcon = page.icon

  return (
    <header className="drag-region relative z-20 flex h-[var(--titlebar-height)] shrink-0 items-center">
      <div
        className={cn(
          'flex h-full w-[var(--sidebar-width)] shrink-0 items-center',
          IS_MAC ? (compact ? 'justify-end pr-3' : 'pl-[84px]') : compact ? 'justify-center' : 'pl-[22px]'
        )}
      >
        {/* The wordmark stays part of the drag region (dragging the window by it feels natural). */}
        {IS_MAC && compact ? null : <Wordmark compact={compact} />}
      </div>

      <div className="grid h-full min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 pl-3">
        <div className="flex min-w-0 items-center gap-1">
          {canGoBack ? (
            <Tooltip content="Back" side="bottom">
              <button
                type="button"
                onClick={back}
                aria-label="Back"
                className={cn(
                  'no-drag grid size-7 shrink-0 place-items-center rounded-md text-fg-muted transition-colors',
                  'hover:bg-surface-3/60 hover:text-fg'
                )}
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
              </button>
            </Tooltip>
          ) : null}
          <span className="flex min-w-0 items-center gap-1.5 px-1 text-[13px] font-medium text-fg-muted">
            <PageIcon className="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
            <span className="truncate">{page.label}</span>
          </span>
        </div>

        <button
          type="button"
          onClick={() => setCommandOpen(true)}
          className={cn(
            'no-drag group flex h-[30px] items-center gap-2.5 rounded-lg border border-line/80 bg-surface/70 pr-1.5 pl-3',
            'text-[13px] text-fg-subtle shadow-xs',
            'transition-[background-color,border-color,color] duration-150 hover:border-line-strong hover:bg-surface hover:text-fg-muted',
            compact ? 'w-[min(300px,34vw)]' : 'w-[min(380px,36vw)]'
          )}
          aria-label="Search pages, actions and tools"
        >
          <Search className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="flex-1 truncate text-left">Search tools, pages, actions…</span>
          <Shortcut keys="mod+k" />
        </button>

        <div className="flex h-full items-center justify-end">
          <div className={cn('h-full shrink-0', CONTROLS_WIDTH)} />
        </div>
      </div>

      {IS_MAC ? null : <WindowControls />}
    </header>
  )
}

/**
 * Minimize / maximize / close. Rendered in a body portal above every overlay so the window can always be
 * managed, even while a dialog is open.
 */
function WindowControls() {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    void ui
      .windowState()
      .then((s) => setMaximized(s.maximized))
      .catch(() => {})
  }, [])
  useCoreEvent('window', (s) => setMaximized(s.maximized))
  const action = (name: 'minimize' | 'maximize' | 'close') => () => {
    void ui.window(name).catch(() => {})
  }
  const maxLabel = maximized ? 'Restore' : 'Maximize'
  if (platform === 'linux') {
    return (
      <Portal>
        <div className="fixed top-0 right-0 z-[60] flex h-[var(--titlebar-height)] items-center gap-2 pr-3">
          {(
            [
              ['minimize', 'Minimize', Minus],
              ['maximize', maxLabel, Square],
              ['close', 'Close', X]
            ] as const
          ).map(([name, label, Icon]) => (
            <button
              key={name}
              type="button"
              onClick={action(name)}
              aria-label={label}
              title={label}
              className={cn(
                'no-drag grid size-6 place-items-center rounded-full bg-surface-3/80 text-fg-muted transition-colors',
                name === 'close' ? 'hover:bg-danger-solid hover:text-white' : 'hover:bg-surface-3 hover:text-fg'
              )}
            >
              <Icon className={name === 'maximize' ? 'size-2.5' : 'size-3.5'} strokeWidth={2.25} aria-hidden="true" />
            </button>
          ))}
        </div>
      </Portal>
    )
  }
  const base =
    'no-drag grid h-full w-[46px] place-items-center text-fg-muted transition-colors duration-100 focus-visible:-outline-offset-2'
  return (
    <Portal>
      <div className="fixed top-0 right-0 z-[60] flex h-[var(--titlebar-height)]">
        <button
          type="button"
          onClick={action('minimize')}
          aria-label="Minimize"
          title="Minimize"
          className={cn(base, 'hover:bg-fg/[0.07] hover:text-fg')}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 5.5h10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button
          type="button"
          onClick={action('maximize')}
          aria-label={maxLabel}
          title={maxLabel}
          className={cn(base, 'hover:bg-fg/[0.07] hover:text-fg')}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0.5" y="2.5" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1" />
              <path d="M2.5 2.5V1.7A1.2 1.2 0 0 1 3.7.5h4.6a1.2 1.2 0 0 1 1.2 1.2v4.6a1.2 1.2 0 0 1-1.2 1.2h-.8" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button
          type="button"
          onClick={action('close')}
          aria-label="Close"
          title="Close"
          className={cn(base, 'hover:bg-[#c42b1c] hover:text-white active:bg-[#c42b1c]/85')}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
      </div>
    </Portal>
  )
}
