import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Command } from 'cmdk'
import { AnimatePresence, motion, useIsPresent } from 'motion/react'
import {
  ArrowLeft,
  CornerDownLeft,
  FolderOpen,
  Monitor,
  Moon,
  RefreshCw,
  RotateCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Stethoscope,
  Sun,
  type LucideIcon
} from 'lucide-react'
import type { CatalogServer } from '@shared/types'
import { core, errorMessage, ui } from '../../lib/api'
import { cn } from '../../lib/cn'
import { formatNumber } from '../../lib/format'
import { useAsync, useDebounced, useHotkey } from '../../lib/hooks'
import { hasModalLayer } from '../../lib/layers'
import { transitions } from '../../lib/motion'
import { visiblePages, type PageId, type RouteParams } from '../../lib/nav'
import { useAppStore } from '../../lib/store'
import { confirmAction } from '../ui/ConfirmDialog'
import { Kbd } from '../ui/Kbd'
import { ServerIcon } from '../ui/Monogram'
import { Portal, useLayer } from '../ui/overlay'
import { Spinner } from '../ui/Spinner'
import { toast, toastResult } from '../ui/toast'

/** Ctrl/⌘+K command palette: jump to pages, run actions, search the MCP server catalog. Mounted once by App. */
export function CommandPalette() {
  const open = useAppStore((s) => s.commandOpen)
  const setOpen = useAppStore((s) => s.setCommandOpen)

  useHotkey(
    'mod+k',
    () => {
      const isOpen = useAppStore.getState().commandOpen
      if (isOpen) setOpen(false)
      else if (!hasModalLayer()) setOpen(true)
    },
    { allowInInputs: true, allowWhenModal: true }
  )

  return (
    <Portal>
      <AnimatePresence>{open ? <PaletteLayer key="palette" onClose={() => setOpen(false)} /> : null}</AnimatePresence>
    </Portal>
  )
}

interface PaletteAction {
  id: string
  label: string
  icon: LucideIcon
  keywords: string[]
  hint?: string
  run: () => void
}

/** Every word of the query must appear somewhere in the haystack. */
function matches(query: string, haystack: Array<string | undefined>): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const text = haystack.filter(Boolean).join(' ').toLowerCase()
  return words.every((w) => text.includes(w))
}

function PaletteLayer({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const isPresent = useIsPresent()
  useLayer({ active: isPresent, ref, onEscape: onClose })

  const [query, setQuery] = useState('')
  const trimmed = query.trim()
  const debounced = useDebounced(trimmed, 200)
  const mode = useAppStore((s) => s.mode)
  const theme = useAppStore((s) => s.theme)
  const canGoBack = useAppStore((s) => s.history.length > 0)
  const { navigate, back, setMode, setTheme } = useAppStore.getState()

  const servers = useAsync<CatalogServer[]>(
    () => (debounced.length >= 2 ? core.catalog.search({ query: debounced, limit: 6, sort: 'relevance' }).then((p) => p.items) : Promise.resolve([])),
    [debounced]
  )
  const serverItems = debounced.length >= 2 && trimmed.length >= 2 ? (servers.data ?? []) : []
  const searching = servers.loading && trimmed.length >= 2

  const go = (page: PageId, params?: RouteParams) => {
    onClose()
    navigate(page, params)
  }
  const run = (fn: () => void) => {
    onClose()
    fn()
  }

  const actions: PaletteAction[] = [
    ...(canGoBack ? [{ id: 'back', label: 'Go back', icon: ArrowLeft, keywords: ['previous', 'return'], run: back }] : []),
    {
      id: 'doctor',
      label: 'Run a health check',
      icon: Stethoscope,
      keywords: ['doctor', 'fix', 'problems', 'diagnose'],
      run: () => navigate('doctor', { run: true })
    },
    {
      id: 'refresh-catalog',
      label: 'Refresh the tool catalog',
      icon: RefreshCw,
      keywords: ['update', 'registry', 'servers', 'reload'],
      run: () => {
        toast.promise(core.catalog.refresh({ force: true }), {
          loading: 'Refreshing the tool catalog…',
          success: (stats) => `Catalog updated — ${formatNumber(stats.total)} tools available`,
          error: (err: unknown) => `Couldn’t refresh the catalog: ${errorMessage(err)}`
        })
      }
    },
    {
      id: 'restart-desktop',
      label: 'Restart Claude Desktop',
      icon: RotateCw,
      keywords: ['reload', 'apply', 'desktop', 'relaunch'],
      hint: 'Loads new tools',
      run: () => {
        void (async () => {
          const ok = await confirmAction({
            title: 'Restart Claude Desktop?',
            description: 'Claude Desktop will close and open again so it picks up your latest changes. Unsent messages may be lost.',
            confirmLabel: 'Restart'
          })
          if (!ok) return
          try {
            toastResult(await core.targets.restartDesktop())
          } catch (err) {
            toast.error('Couldn’t restart Claude Desktop', { description: errorMessage(err) })
          }
        })()
      }
    },
    mode === 'simple'
      ? {
          id: 'mode-advanced',
          label: 'Switch to Advanced mode',
          icon: SlidersHorizontal,
          keywords: ['mode', 'expert', 'power', 'raw', 'json'],
          hint: 'Shows raw config, proxy and backups',
          run: () => setMode('advanced')
        }
      : {
          id: 'mode-simple',
          label: 'Switch to Simple mode',
          icon: Sparkles,
          keywords: ['mode', 'easy', 'beginner', 'friendly'],
          hint: 'Friendly, guided setup',
          run: () => setMode('simple')
        },
    ...(
      [
        ['light', 'Use light theme', Sun],
        ['dark', 'Use dark theme', Moon],
        ['system', 'Match system theme', Monitor]
      ] as const
    )
      .filter(([value]) => value !== theme)
      .map(([value, label, icon]) => ({
        id: `theme-${value}`,
        label,
        icon,
        keywords: ['theme', 'appearance', 'colors', value],
        run: () => setTheme(value)
      })),
    ...(mode === 'advanced'
      ? [
          {
            id: 'data-folder',
            label: 'Open Claude Setup data folder',
            icon: FolderOpen,
            keywords: ['state', 'files', 'logs', 'backups', 'directory'],
            run: () => {
              void core.app
                .info()
                .then((info) => ui.openPath(info.dataDir))
                .catch((err: unknown) => toast.error('Couldn’t open the folder', { description: errorMessage(err) }))
            }
          }
        ]
      : [])
  ]

  const pages = visiblePages(mode).filter((p) => matches(trimmed, [p.label, p.description, ...p.keywords]))
  const filteredActions = actions.filter((a) => matches(trimmed, [a.label, a.hint, ...a.keywords]))

  // Keep the highlight on the first result as async results arrive (cmdk would otherwise stay put).
  const firstValue = pages[0]
    ? `page-${pages[0].id}`
    : serverItems[0]
      ? `server-${serverItems[0].id}`
      : trimmed.length >= 2
        ? 'search-all-tools'
        : filteredActions[0]
          ? `action-${filteredActions[0].id}`
          : ''
  const [selected, setSelected] = useState(firstValue)
  const resultKey = `${trimmed}|${serverItems.map((s) => s.id).join(',')}`
  useEffect(() => {
    setSelected(firstValue)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resultKey])

  return (
    <div ref={ref} tabIndex={-1} className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[13vh] outline-none">
      <motion.div
        aria-hidden="true"
        className="absolute inset-0 bg-overlay backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.16 }}
        onClick={onClose}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative w-full max-w-[620px] overflow-hidden rounded-2xl border border-line bg-elevated text-fg shadow-2xl"
        initial={{ opacity: 0, scale: 0.97, y: -6 }}
        animate={{ opacity: 1, scale: 1, y: 0, transition: transitions.dialog }}
        exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
      >
        <Command shouldFilter={false} loop label="Command palette" value={selected} onValueChange={setSelected} className="flex flex-col">
          <div className="flex items-center gap-3 border-b border-line px-4">
            <Search className="size-[18px] shrink-0 text-fg-subtle" aria-hidden="true" />
            <Command.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Search pages, actions and tools…"
              className="h-14 min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-subtle"
              data-autofocus
            />
            {searching ? <Spinner size="sm" className="text-fg-subtle" label="Searching" /> : null}
            <Kbd>Esc</Kbd>
          </div>

          <Command.List
            className={cn(
              'max-h-[min(440px,58vh)] scroll-py-2 overflow-y-auto p-2',
              '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1.5',
              '[&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-[0.08em]',
              '[&_[cmdk-group-heading]]:text-fg-subtle [&_[cmdk-group-heading]]:uppercase'
            )}
          >
            <Command.Empty className="px-4 py-10 text-center text-sm text-fg-muted">
              {searching ? 'Searching…' : 'No matches. Try another word.'}
            </Command.Empty>

            {pages.length > 0 ? (
              <Command.Group heading="Go to">
                {pages.map((page) => (
                  <PaletteItem
                    key={page.id}
                    value={`page-${page.id}`}
                    icon={<page.icon className="size-4" aria-hidden="true" />}
                    label={page.label}
                    hint={page.description}
                    onSelect={() => go(page.id)}
                  />
                ))}
              </Command.Group>
            ) : null}

            {serverItems.length > 0 ? (
              <Command.Group heading="Tools">
                {serverItems.map((server) => (
                  <PaletteItem
                    key={server.id}
                    value={`server-${server.id}`}
                    icon={<ServerIcon src={server.iconUrl} name={server.name} seed={server.id} size="xs" />}
                    label={server.name}
                    hint={server.description}
                    onSelect={() => go('discover', { server: server.id })}
                  />
                ))}
              </Command.Group>
            ) : null}

            {trimmed.length >= 2 ? (
              <Command.Group heading={serverItems.length > 0 ? undefined : 'Tools'}>
                <PaletteItem
                  value="search-all-tools"
                  icon={<Search className="size-4" aria-hidden="true" />}
                  label={`Search all tools for “${trimmed}”`}
                  onSelect={() => go('discover', { q: trimmed })}
                />
              </Command.Group>
            ) : null}

            {filteredActions.length > 0 ? (
              <Command.Group heading="Actions">
                {filteredActions.map((action) => (
                  <PaletteItem
                    key={action.id}
                    value={`action-${action.id}`}
                    icon={<action.icon className="size-4" aria-hidden="true" />}
                    label={action.label}
                    hint={action.hint}
                    onSelect={() => run(action.run)}
                  />
                ))}
              </Command.Group>
            ) : null}
          </Command.List>

          <div className="flex items-center gap-4 border-t border-line bg-surface-2/50 px-4 py-2.5 text-xs text-fg-subtle">
            <span className="flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              to move
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>
                <CornerDownLeft className="size-3" aria-hidden="true" />
              </Kbd>
              to open
            </span>
            <span className="ml-auto">Tip: type a tool name, like “github”</span>
          </div>
        </Command>
      </motion.div>
    </div>
  )
}

interface PaletteItemProps {
  value: string
  icon: ReactNode
  label: string
  hint?: string
  onSelect: () => void
}

function PaletteItem({ value, icon, label, hint, onSelect }: PaletteItemProps) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className={cn(
        'group flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-fg select-none',
        'data-[selected=true]:bg-surface-2 data-[disabled=true]:opacity-50'
      )}
    >
      <span
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-md border border-line bg-surface text-fg-muted',
          'group-data-[selected=true]:text-accent-text'
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{label}</span>
        {hint ? <span className="block truncate text-xs text-fg-subtle">{hint}</span> : null}
      </span>
      <CornerDownLeft className="size-3.5 shrink-0 text-fg-subtle opacity-0 group-data-[selected=true]:opacity-100" aria-hidden="true" />
    </Command.Item>
  )
}
