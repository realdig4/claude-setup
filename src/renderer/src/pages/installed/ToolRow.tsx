/** One installed tool in My Tools: icon, name, how it runs, on/off switch, Test and a menu of actions. */
import { Activity, Compass, Copy, Ellipsis, FileJson, FolderOpen, Pencil, Trash2 } from 'lucide-react'
import type { CatalogServer, InstalledServer } from '@shared/types'
import { Badge, Button, ListItem, Menu, ServerIcon, Switch, Tooltip, type MenuItem } from '@renderer/components/ui'
import { cn } from '@renderer/lib/cn'
import { formatRelativeTime } from '@renderer/lib/format'
import { folderName, scopeLabel } from '../discover/lib/targets'
import { TOOL_KIND_LABELS, editableValues, safeSummary, toolKind } from './lib/tools'

export interface ToolRowActions {
  onToggle: (server: InstalledServer, enabled: boolean) => void
  onTest: (server: InstalledServer) => void
  onEdit: (server: InstalledServer) => void
  onCopy: (server: InstalledServer) => void
  onRemove: (server: InstalledServer) => void
  onShowFile: (server: InstalledServer) => void
  onViewFile: (server: InstalledServer) => void
  onOpenCatalog: (catalogId: string) => void
}

export interface ToolRowProps extends ToolRowActions {
  server: InstalledServer
  /** Catalog entry (icon, display name) when known. */
  catalog?: CatalogServer | null
  label: string
  advanced: boolean
  /** A toggle is being saved. */
  busy: boolean
}

/** A row in an app's tool list. */
export function ToolRow({ server, catalog, label, advanced, busy, ...actions }: ToolRowProps) {
  const kind = toolKind(server.config)
  const scope = server.target.scope ?? 'user'
  const inProject = (scope === 'project' || scope === 'local') && server.target.projectPath
  const canEdit = advanced || editableValues(server.config).length > 0

  const description = advanced ? (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate font-mono text-[12px]">{safeSummary(server.config)}</span>
    </span>
  ) : (
    [
      TOOL_KIND_LABELS[kind],
      inProject ? `only in ${folderName(server.target.projectPath as string)}` : null,
      server.installedAt ? `added ${formatRelativeTime(server.installedAt)}` : null
    ]
      .filter(Boolean)
      .join(' · ')
  )

  const items: MenuItem[] = [
    { label: 'Test connection', icon: Activity, onSelect: () => actions.onTest(server) },
    ...(canEdit
      ? [
          {
            label: advanced ? 'Edit settings (JSON)' : 'Change settings',
            icon: Pencil,
            description: advanced ? undefined : 'Update a key or other value',
            onSelect: () => actions.onEdit(server)
          }
        ]
      : []),
    { label: 'Copy to other apps', icon: Copy, onSelect: () => actions.onCopy(server) },
    ...(server.catalogId ? [{ label: 'View in Discover', icon: Compass, onSelect: () => actions.onOpenCatalog(server.catalogId as string) }] : []),
    ...(advanced
      ? [
          { type: 'separator' as const },
          { label: 'Show config file in folder', icon: FolderOpen, onSelect: () => actions.onShowFile(server) },
          { label: 'View config file', icon: FileJson, onSelect: () => actions.onViewFile(server) }
        ]
      : []),
    { type: 'separator' },
    { label: 'Remove…', icon: Trash2, tone: 'danger', onSelect: () => actions.onRemove(server) }
  ]

  return (
    <ListItem
      media={
        <span className={cn('flex transition-[opacity,filter] duration-200', !server.enabled && 'opacity-45 grayscale')}>
          <ServerIcon src={catalog?.iconUrl} name={label} seed={server.catalogId ?? server.name} size="md" />
        </span>
      }
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn('truncate', !server.enabled && 'text-fg-muted')}>{label}</span>
          {advanced && label.toLowerCase() !== server.name.toLowerCase() ? (
            <code className="truncate font-mono text-[11.5px] font-normal text-fg-subtle">{server.name}</code>
          ) : null}
          {!server.enabled ? (
            <Badge size="sm" tone="neutral">
              Off
            </Badge>
          ) : null}
          {advanced && scope !== 'user' ? (
            <Badge size="sm" variant="outline" tone="info">
              {scopeLabel(scope)}
            </Badge>
          ) : null}
          {advanced && !server.managedByUs ? (
            <Tooltip content="Added outside Claude Setup (by hand or by another app).">
              <Badge size="sm" variant="outline">
                External
              </Badge>
            </Tooltip>
          ) : null}
        </span>
      }
      description={
        advanced && inProject ? (
          <span className="flex min-w-0 flex-col">
            {description}
            <span className="truncate text-xs text-fg-subtle">{server.target.projectPath}</span>
          </span>
        ) : (
          description
        )
      }
      actions={
        <>
          <Button size="sm" variant="ghost" leftIcon={Activity} onClick={() => actions.onTest(server)} className="max-sm:hidden">
            Test
          </Button>
          <Switch
            checked={server.enabled}
            disabled={busy}
            onCheckedChange={(enabled) => actions.onToggle(server, enabled)}
            aria-label={`${server.enabled ? 'Turn off' : 'Turn on'} ${label}`}
            className="mx-1.5"
          />
          <Menu
            label={`${label} actions`}
            trigger={
              <Button size="icon-sm" variant="ghost" aria-label={`More actions for ${label}`}>
                <Ellipsis />
              </Button>
            }
            items={items}
          />
        </>
      }
    />
  )
}
