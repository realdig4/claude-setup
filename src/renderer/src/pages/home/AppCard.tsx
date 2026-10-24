/** "Your Claude apps" card: detected status, version, tool count, restart hint and quick actions for one app. */
import type { ReactNode } from 'react'
import { Blocks, Plus, RefreshCw, Stethoscope, TriangleAlert } from 'lucide-react'
import type { InstalledServer, TargetInfo } from '@shared/types'
import { Badge, Button, Card, CardFooter, ExternalLink, PathText, Skeleton, StatusDot } from '@renderer/components/ui'
import { cn } from '@renderer/lib/cn'
import { pluralize } from '@renderer/lib/format'
import { APP_BLURBS, APP_GET_URLS, AppIcon } from '../discover/common/apps'
import { RestartDesktopButton } from '../discover/common/restart'

export interface AppCardProps {
  target: TargetInfo
  /** Tools installed in this app (undefined while loading). */
  tools: InstalledServer[] | undefined
  advanced: boolean
  /** A Claude Desktop restart is waiting. */
  restartPending: boolean
  onManage: () => void
  onAdd: () => void
  onCheck: () => void
  onRecheck: () => void
  /** Extra content (e.g. the model chip for Claude Code). */
  children?: ReactNode
}

function StatusBadge({ target }: { target: TargetInfo }) {
  if (!target.installed) return <Badge size="sm">Not installed</Badge>
  if (!target.configValid) {
    return (
      <Badge size="sm" tone="warn" icon={TriangleAlert}>
        Needs a fix
      </Badge>
    )
  }
  if (target.id === 'claude-desktop') {
    return target.running ? (
      <Badge size="sm" tone="success">
        <StatusDot status="ok" size="sm" label={null} />
        Open
      </Badge>
    ) : (
      <Badge size="sm" tone="neutral">
        Installed
      </Badge>
    )
  }
  return (
    <Badge size="sm" tone="success">
      <StatusDot status="ok" size="sm" label={null} pulse={false} />
      Ready
    </Badge>
  )
}

/** One primary app on Home. */
export function AppCard({ target, tools, advanced, restartPending, onManage, onAdd, onCheck, onRecheck, children }: AppCardProps) {
  const count = tools?.length ?? target.serverCount
  const off = tools?.filter((s) => !s.enabled).length ?? 0
  const desktop = target.id === 'claude-desktop'
  const blurb = [APP_BLURBS[target.id], target.version ? `v${target.version}` : null].filter(Boolean).join(' · ')

  return (
    <Card className="flex flex-col">
      <div className="flex items-start gap-4 p-5 pb-4">
        <AppIcon target={target.id} size="lg" tone={target.installed ? 'accent' : 'neutral'} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base leading-6 font-semibold tracking-[-0.01em] text-fg">{target.label}</h3>
            <StatusBadge target={target} />
          </div>
          <p className="mt-0.5 truncate text-[13px] text-fg-muted">{blurb}</p>
        </div>
      </div>

      <div className="flex-1 space-y-3 px-5 pb-5">
        {!target.installed ? (
          <div className="rounded-xl border border-dashed border-line-strong/70 px-4 py-3.5">
            <p className="text-[13.5px] text-fg-muted">
              {desktop ? 'Claude Desktop isn’t on this computer yet.' : 'Claude Code isn’t on this computer yet.'}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
              <ExternalLink href={APP_GET_URLS[target.id]}>{desktop ? 'Get Claude Desktop' : 'How to install Claude Code'}</ExternalLink>
              <Button size="sm" variant="ghost" leftIcon={RefreshCw} onClick={onRecheck}>
                Check again
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              {tools === undefined ? (
                <Skeleton className="h-8 w-24" />
              ) : (
                <>
                  <span className="text-[28px] leading-8 font-semibold tracking-[-0.02em] text-fg tabular-nums">{count}</span>
                  <span className="text-[13.5px] text-fg-muted">
                    {pluralize(count, 'tool', undefined, false)}
                    {off ? ` · ${off} turned off` : count === 0 ? ' yet' : ''}
                  </span>
                </>
              )}
            </div>
            {!target.configValid ? (
              <div className="flex items-start gap-2.5 rounded-xl border border-warn-line/80 bg-warn-soft/70 px-3.5 py-3 text-[13px] text-fg">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn-text" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p>Its settings file has a problem, so its tools may not load.</p>
                  {advanced && target.configError ? (
                    <p className="mt-0.5 font-mono text-xs break-words text-fg-muted">{target.configError}</p>
                  ) : null}
                  <Button size="sm" variant="link" className="mt-1 px-0" leftIcon={Stethoscope} onClick={onCheck}>
                    Fix it in Health Check
                  </Button>
                </div>
              </div>
            ) : null}
            {desktop && target.running && restartPending ? (
              <div
                className={cn(
                  'flex flex-wrap items-center justify-between gap-2 rounded-xl border border-warn-line/80 bg-warn-soft/70',
                  'px-3.5 py-2.5'
                )}
              >
                <span className="text-[13px] text-fg">Restart it to load your latest changes.</span>
                <RestartDesktopButton size="sm" variant="outline">
                  Restart now
                </RestartDesktopButton>
              </div>
            ) : null}
            {children}
            {advanced && target.configPath ? <PathText path={target.configPath} copy reveal /> : null}
            {advanced && target.notes.length ? (
              <ul className="space-y-1 text-xs leading-[1.45] text-fg-subtle">
                {target.notes.map((note) => (
                  <li key={note} className="flex gap-1.5">
                    <span aria-hidden="true">·</span>
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>

      {target.installed ? (
        <CardFooter className="flex-wrap">
          <Button size="sm" variant="outline" leftIcon={Blocks} onClick={onManage}>
            Manage tools
          </Button>
          <Button size="sm" variant="ghost" leftIcon={Plus} onClick={onAdd}>
            Add tools
          </Button>
          {desktop && target.running && !restartPending ? (
            <RestartDesktopButton size="sm" variant="ghost" className="ml-auto">
              Restart
            </RestartDesktopButton>
          ) : null}
        </CardFooter>
      ) : null}
    </Card>
  )
}
