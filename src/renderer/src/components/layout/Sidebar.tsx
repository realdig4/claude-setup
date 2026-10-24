import { LayoutGroup, motion } from 'motion/react'
import { Monitor, Moon, SlidersHorizontal, Sparkles, Sun } from 'lucide-react'
import { core, useCoreEvent } from '../../lib/api'
import { cn } from '../../lib/cn'
import { formatCompact } from '../../lib/format'
import { useAsync, useInterval } from '../../lib/hooks'
import { transitions } from '../../lib/motion'
import { navGroups, type PageDef } from '../../lib/nav'
import { useAppStore } from '../../lib/store'
import type { ThemePreference } from '../../lib/theme'
import { Segmented } from '../ui/Segmented'
import { StatusDot, type Status } from '../ui/StatusDot'
import { Tooltip } from '../ui/Tooltip'

const POLL_MS = 10_000

const MODE_HELP = (
  <span className="block space-y-1">
    <span className="block">
      <b className="font-semibold">Simple</b> — guided setup in plain words.
    </span>
    <span className="block">
      <b className="font-semibold">Advanced</b> — adds raw config, scopes, environment variables, the proxy and backups.
    </span>
  </span>
)

const THEME_ORDER: ThemePreference[] = ['system', 'light', 'dark']
const THEME_META: Record<ThemePreference, { label: string; Icon: typeof Sun }> = {
  system: { label: 'Match system', Icon: Monitor },
  light: { label: 'Light', Icon: Sun },
  dark: { label: 'Dark', Icon: Moon }
}

/** Main navigation: page links grouped by section, status pills, mode and theme controls. */
export function Sidebar({ compact = false }: { compact?: boolean }) {
  const mode = useAppStore((s) => s.mode)
  const route = useAppStore((s) => s.route)
  const navigate = useAppStore((s) => s.navigate)
  const groups = navGroups(mode)

  return (
    <aside className="flex w-[var(--sidebar-width)] shrink-0 flex-col" aria-label="Sidebar">
      <nav aria-label="Main" className={cn('min-h-0 flex-1 overflow-y-auto pt-2 pb-4 scrollbar-none', compact ? 'px-2.5' : 'px-3')}>
        <LayoutGroup id="sidebar-nav">
          {groups.map((group, index) => (
            <div key={group.id} className={cn(index > 0 && (compact ? 'mt-3 border-t border-line/70 pt-3' : 'mt-6'))}>
              {compact ? null : (
                <div className="px-2.5 pb-1.5 text-2xs font-semibold tracking-[0.08em] text-fg-subtle uppercase">{group.label}</div>
              )}
              <ul className="flex flex-col gap-0.5">
                {group.pages.map((page) => (
                  <NavItem
                    key={page.id}
                    page={page}
                    active={route.page === page.id}
                    compact={compact}
                    onSelect={() => navigate(page.id)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </LayoutGroup>
      </nav>

      <div className={cn('flex shrink-0 flex-col gap-2.5 pt-2 pb-3', compact ? 'items-center px-2.5' : 'px-3')}>
        <StatusPills compact={compact} />
        <div className={cn('flex items-center gap-1.5', compact && 'flex-col')}>
          <ModeSwitch compact={compact} />
          <ThemeButton />
        </div>
      </div>
    </aside>
  )
}

interface NavItemProps {
  page: PageDef
  active: boolean
  compact: boolean
  onSelect: () => void
}

function NavItem({ page, active, compact, onSelect }: NavItemProps) {
  const Icon = page.icon
  const button = (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'page' : undefined}
      aria-label={compact ? page.label : undefined}
      className={cn(
        'group relative flex h-9 w-full items-center rounded-lg text-[13.5px] font-medium transition-colors duration-150',
        compact ? 'justify-center' : 'gap-2.5 px-2.5',
        active ? 'text-fg' : 'text-fg-muted hover:bg-surface-3/55 hover:text-fg'
      )}
    >
      {active ? (
        <motion.span
          layoutId="nav-active"
          transition={transitions.indicator}
          className="absolute inset-0 rounded-lg bg-surface shadow-sm ring-1 ring-line/80 dark:bg-surface-2 dark:ring-line"
        />
      ) : null}
      <Icon
        className={cn(
          'relative size-[18px] shrink-0 transition-colors',
          active ? 'text-accent-text' : 'text-fg-subtle group-hover:text-fg-muted'
        )}
        aria-hidden="true"
      />
      {compact ? null : <span className="relative truncate">{page.label}</span>}
    </button>
  )
  return (
    <li>
      {compact ? (
        <Tooltip content={page.label} side="right">
          {button}
        </Tooltip>
      ) : (
        button
      )}
    </li>
  )
}

/** Small live indicators: catalog size / refresh, and (Advanced) the translation proxy. */
function StatusPills({ compact }: { compact: boolean }) {
  const advanced = useAppStore((s) => s.mode === 'advanced')
  const navigate = useAppStore((s) => s.navigate)
  const catalog = useAsync(() => core.catalog.stats(), [])
  const proxy = useAsync(() => core.proxy.status(), [], { enabled: advanced })

  useInterval(() => {
    void catalog.reload()
    if (advanced) void proxy.reload()
  }, POLL_MS)

  useCoreEvent('catalog', (event) => {
    if (event.phase === 'start' || event.phase === 'done' || event.phase === 'error') void catalog.reload()
  })

  const pills: Array<{ key: string; status: Status; label: string; title: string; onClick: () => void }> = []
  if (catalog.data) {
    const refreshing = catalog.data.refreshing
    pills.push({
      key: 'catalog',
      status: refreshing ? 'busy' : catalog.data.total > 0 ? 'ok' : 'idle',
      label: refreshing ? 'Updating catalog…' : `${formatCompact(catalog.data.total)} tools available`,
      title: refreshing ? 'The tool catalog is being refreshed' : 'Browse the tool catalog',
      onClick: () => navigate('discover')
    })
  }
  if (advanced && proxy.data) {
    const running = proxy.data.running
    pills.push({
      key: 'proxy',
      status: running ? (proxy.data.lastError && proxy.data.errors > 0 ? 'warn' : 'ok') : 'idle',
      label: running ? `Proxy on${proxy.data.port ? ` · :${proxy.data.port}` : ''}` : 'Proxy off',
      title: running ? 'The translation proxy is running' : 'The translation proxy is stopped',
      onClick: () => navigate('proxy')
    })
  }
  // In the narrow icon sidebar only show states that need attention (keeps it calm).
  const visible = compact ? pills.filter((p) => p.status !== 'ok' && p.status !== 'idle') : pills
  if (visible.length === 0) return null

  return (
    <div className={cn('flex flex-col', compact ? 'items-center gap-1' : 'gap-0.5')}>
      {visible.map((pill) => {
        const content = (
          <button
            key={pill.key}
            type="button"
            onClick={pill.onClick}
            aria-label={compact ? pill.label : undefined}
            className={cn(
              'flex items-center rounded-md text-xs text-fg-muted transition-colors hover:bg-surface-3/55 hover:text-fg',
              compact ? 'size-8 justify-center' : 'h-7 w-full gap-2.5 px-2.5'
            )}
          >
            <StatusDot status={pill.status} size="sm" label={null} pulse={pill.status === 'busy'} />
            {compact ? null : <span className="truncate">{pill.label}</span>}
          </button>
        )
        return (
          <Tooltip key={pill.key} content={compact ? pill.label : pill.title} side={compact ? 'right' : 'top'}>
            {content}
          </Tooltip>
        )
      })}
    </div>
  )
}

function ModeSwitch({ compact }: { compact: boolean }) {
  const mode = useAppStore((s) => s.mode)
  const setMode = useAppStore((s) => s.setMode)
  if (compact) {
    const next = mode === 'simple' ? 'advanced' : 'simple'
    return (
      <Tooltip content={MODE_HELP} side="right">
        <button
          type="button"
          onClick={() => setMode(next)}
          aria-label={`Mode: ${mode === 'simple' ? 'Simple' : 'Advanced'}. Switch to ${next === 'simple' ? 'Simple' : 'Advanced'}`}
          className="grid size-8 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-surface-3/60 hover:text-fg"
        >
          {mode === 'simple' ? (
            <Sparkles className="size-4" aria-hidden="true" />
          ) : (
            <SlidersHorizontal className="size-4 text-accent-text" aria-hidden="true" />
          )}
        </button>
      </Tooltip>
    )
  }
  return (
    <Tooltip content={MODE_HELP} side="top" delay={600}>
      <div className="min-w-0 flex-1">
        <Segmented
          aria-label="Interface mode"
          size="sm"
          fullWidth
          value={mode}
          onValueChange={setMode}
          options={[
            { value: 'simple', label: 'Simple' },
            { value: 'advanced', label: 'Advanced' }
          ]}
        />
      </div>
    </Tooltip>
  )
}

function ThemeButton() {
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length] ?? 'system'
  const { label, Icon } = THEME_META[theme]
  return (
    <Tooltip content={`Theme: ${label}. Click for ${THEME_META[next].label.toLowerCase()}.`} side="top">
      <button
        type="button"
        onClick={() => setTheme(next)}
        aria-label={`Theme: ${label}. Switch to ${THEME_META[next].label}`}
        className="grid size-8 shrink-0 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-surface-3/60 hover:text-fg"
      >
        <Icon className="size-4" aria-hidden="true" />
      </button>
    </Tooltip>
  )
}
