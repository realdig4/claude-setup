/** Home hero: a warm greeting, what Claude can do right now, and the two main next steps. */
import { Compass, Stethoscope } from 'lucide-react'
import type { CatalogServer, InstalledServer } from '@shared/types'
import { Button, Card, ServerIcon, Skeleton } from '@renderer/components/ui'
import { cn } from '@renderer/lib/cn'
import { joinList, pluralize } from '@renderer/lib/format'
import { TARGET_NAMES, TARGET_ORDER } from '../discover/lib/targets'

/** "Good morning" / "Good afternoon" / "Good evening" for the local time. */
export function greeting(date = new Date()): string {
  const hour = date.getHours()
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 18) return 'Good afternoon'
  if (hour >= 18 && hour < 23) return 'Good evening'
  return 'Hello there'
}

export interface HeroCardProps {
  /** Installed servers (undefined while loading). */
  installed: InstalledServer[] | undefined
  /** Catalog entries for icons (installed tools, or popular picks when nothing is installed). */
  icons: Array<Pick<CatalogServer, 'id' | 'name' | 'iconUrl'>>
  onDiscover: () => void
  onCheck: () => void
}

/** The top card on Home. */
export function HeroCard({ installed, icons, onDiscover, onCheck }: HeroCardProps) {
  const enabled = installed?.filter((s) => s.enabled) ?? []
  const apps = TARGET_ORDER.filter((t) => enabled.some((s) => s.target.target === t)).map((t) => TARGET_NAMES[t])
  const shown = icons.slice(0, 5)
  const extra = Math.max(0, (installed?.length ? new Set(installed.map((s) => s.catalogId ?? s.name)).size : 0) - shown.length)

  return (
    <Card variant="hero" className="relative overflow-hidden px-7 py-7 sm:px-8">
      <div
        aria-hidden="true"
        className="dot-grid pointer-events-none absolute inset-y-0 right-0 w-1/2 opacity-60 [mask-image:linear-gradient(to_left,black,transparent)]"
      />
      <div className="relative flex flex-wrap items-center gap-x-10 gap-y-6">
        <div className="min-w-0 flex-1 basis-[420px]">
          <h1 className="text-[28px] leading-9 font-semibold tracking-[-0.025em] text-fg">{greeting()}</h1>
          {installed === undefined ? (
            <Skeleton className="mt-2.5 h-5 w-80 max-w-full" />
          ) : (
            <p className="mt-1.5 max-w-xl text-[15px] leading-6 text-fg-muted">
              {enabled.length === 0
                ? 'Let’s give Claude some new abilities. Add a tool in a click — no config files, no terminal.'
                : `Claude can use ${pluralize(enabled.length, 'tool')} in ${joinList(apps)}. Add more whenever you like.`}
            </p>
          )}
          <div className="mt-5 flex flex-wrap gap-2.5">
            <Button variant="primary" size="lg" leftIcon={Compass} onClick={onDiscover}>
              Find tools
            </Button>
            <Button size="lg" leftIcon={Stethoscope} onClick={onCheck}>
              Check my setup
            </Button>
          </div>
        </div>
        {shown.length ? (
          <div className="flex shrink-0 flex-col items-start gap-2.5 sm:items-end" aria-hidden="true">
            <div className="flex -space-x-2.5">
              {shown.map((server, i) => (
                <span
                  key={server.id}
                  className="rounded-[14px] ring-[3px] ring-surface transition-transform duration-200 hover:-translate-y-0.5"
                  style={{ zIndex: shown.length - i }}
                >
                  <ServerIcon src={server.iconUrl} name={server.name} seed={server.id} size="lg" />
                </span>
              ))}
              {extra > 0 ? (
                <span
                  className={cn(
                    'z-0 grid size-11 place-items-center rounded-xl bg-surface-3 text-[13px] font-semibold text-fg-muted',
                    'ring-[3px] ring-surface tabular-nums'
                  )}
                >
                  +{extra}
                </span>
              ) : null}
            </div>
            <span className="text-xs font-medium text-fg-subtle">{installed?.length ? 'Your tools' : 'Popular picks'}</span>
          </div>
        ) : null}
      </div>
    </Card>
  )
}
