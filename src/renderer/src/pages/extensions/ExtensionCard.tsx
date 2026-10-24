import { useState } from 'react'
import { ArrowUpRight, BadgeCheck, Check, Download, Ellipsis, FolderOpen, ShieldAlert, Star, Trash2 } from 'lucide-react'
import type { ExtensionItem } from '@shared/types'
import {
  AdvancedOnly,
  Badge,
  Button,
  Card,
  Menu,
  Monogram,
  PathText,
  Switch,
  openExternal,
  toast,
  type MenuItem
} from '@renderer/components/ui'
import { ui } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { formatCompact } from '@renderer/lib/format'
import { KIND_META, SCOPE_META, isOfficialSource, itemUrl, sourceLabel } from './meta'

export type CardBusy = 'install' | 'uninstall' | 'toggle' | null

export interface ExtensionCardProps {
  item: ExtensionItem
  busy: CardBusy
  /** Latest progress message while installing. */
  progress?: string
  advanced: boolean
  onInstall: (item: ExtensionItem) => void
  onUninstall: (item: ExtensionItem) => void
  onToggle: (item: ExtensionItem, enabled: boolean) => void
}

/** One extension: name, author, description, popularity, source, warnings and install / on-off / remove actions. */
export function ExtensionCard({ item, busy, progress, advanced, onInstall, onUninstall, onToggle }: ExtensionCardProps) {
  const [showWarnings, setShowWarnings] = useState(false)
  const warnings = item.warnings ?? []
  const url = itemUrl(item)
  const official = isOfficialSource(item)
  const byAnthropic = !!item.author && /anthropic/i.test(item.author)
  const enabled = item.enabled !== false

  const menu: MenuItem[] = [
    ...(url ? [{ label: 'Open its page', icon: ArrowUpRight, onSelect: () => void openExternal(url) }] : []),
    ...(advanced && item.installedPath
      ? [
          {
            label: 'Show in folder',
            icon: FolderOpen,
            onSelect: () => void ui.showItemInFolder(item.installedPath ?? '').catch(() => toast.error('Couldn’t open the folder'))
          }
        ]
      : []),
    ...(item.installed
      ? [{ type: 'separator' as const }, { label: 'Remove', icon: Trash2, tone: 'danger' as const, onSelect: () => onUninstall(item) }]
      : [])
  ]

  return (
    <Card className="flex h-full flex-col p-4">
      <div className="flex items-start gap-3">
        <Monogram text={item.name} seed={item.id} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[15px] leading-6 font-semibold tracking-[-0.01em] text-fg" title={item.name}>
              {item.name}
            </span>
            {byAnthropic ? <BadgeCheck className="size-4 shrink-0 text-accent-text" aria-label="Made by Anthropic" /> : null}
          </div>
          <p className="truncate text-[13px] leading-5 text-fg-muted">{item.author ? `by ${item.author}` : sourceLabel(item)}</p>
        </div>
        {item.installed ? (
          <Switch
            size="sm"
            checked={enabled}
            disabled={busy !== null}
            onCheckedChange={(on) => onToggle(item, on)}
            aria-label={`${enabled ? 'Turn off' : 'Turn on'} ${item.name}`}
            className="mt-1"
          />
        ) : null}
      </div>

      <p className="mt-2.5 line-clamp-2 text-[13px] leading-5 text-fg-muted" title={item.description}>
        {item.description || `A ${KIND_META[item.kind].singular} for Claude Code.`}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-fg-subtle">
        {item.installs ? (
          <span className="inline-flex items-center gap-1 tabular-nums" title={`${item.installs.toLocaleString('en-US')} installs`}>
            <Download className="size-3.5" aria-hidden="true" />
            {formatCompact(item.installs)}
            <span className="sr-only"> installs</span>
          </span>
        ) : null}
        {item.stars ? (
          <span
            className="inline-flex items-center gap-1 tabular-nums"
            title={`${item.stars.toLocaleString('en-US')} stars on GitHub`}
          >
            <Star className="size-3.5" aria-hidden="true" />
            {formatCompact(item.stars)}
            <span className="sr-only"> stars</span>
          </span>
        ) : null}
        <Badge size="sm" tone={official ? 'accent' : 'neutral'}>
          {sourceLabel(item)}
        </Badge>
        {warnings.length ? (
          <button
            type="button"
            onClick={() => setShowWarnings((v) => !v)}
            aria-expanded={showWarnings}
            className={cn(
              'inline-flex h-5 items-center gap-1 rounded-md border border-warn-line/60 bg-warn-soft px-1.5',
              'text-2xs font-medium text-warn-text transition-colors hover:border-warn-line'
            )}
          >
            <ShieldAlert className="size-3" aria-hidden="true" />
            {warnings.length === 1 ? '1 warning' : `${warnings.length} warnings`}
          </button>
        ) : null}
      </div>

      {showWarnings && warnings.length ? (
        <ul
          className={cn(
            'mt-2.5 flex flex-col gap-1 rounded-lg border border-warn-line/60 bg-warn-soft/60 px-3 py-2',
            'text-[12.5px] leading-5 text-fg-muted'
          )}
        >
          {warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-1.5">
              <ShieldAlert className="mt-[3px] size-3.5 shrink-0 text-warn-text" aria-hidden="true" />
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <AdvancedOnly>
        {item.installed && (item.scope || item.installedPath) ? (
          <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-2">
            {item.scope ? (
              <Badge size="sm" variant="outline">
                {SCOPE_META[item.scope].title}
              </Badge>
            ) : null}
            {item.installedPath ? <PathText path={item.installedPath} max={42} copy /> : null}
          </div>
        ) : null}
      </AdvancedOnly>

      <div className="mt-auto flex items-center gap-2 pt-4">
        {busy === 'install' ? (
          <p className="min-w-0 flex-1 truncate text-xs text-fg-muted" aria-live="polite">
            {progress ?? 'Installing…'}
          </p>
        ) : item.installed ? (
          <span className="inline-flex flex-1 items-center gap-1.5 text-[13px] font-medium text-success-text">
            <Check className="size-4" aria-hidden="true" />
            {enabled ? 'Installed' : 'Installed · off'}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {!item.installed ? (
          <Button size="sm" leftIcon={Download} loading={busy === 'install'} onClick={() => onInstall(item)}>
            Install
          </Button>
        ) : null}
        {menu.length ? (
          <Menu
            label={`Actions for ${item.name}`}
            trigger={
              <Button size="icon-sm" variant="ghost" aria-label={`More actions for ${item.name}`} disabled={busy === 'uninstall'}>
                <Ellipsis />
              </Button>
            }
            items={menu}
          />
        ) : null}
      </div>
    </Card>
  )
}
