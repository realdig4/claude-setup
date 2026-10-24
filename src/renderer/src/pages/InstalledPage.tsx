/**
 * My Tools: every MCP server installed in Claude Desktop, Claude Code, VS Code, Cursor and Windsurf, grouped by
 * app. Turn tools on/off, test, edit, copy to other apps or remove them (with undo). Advanced mode adds scope and
 * project filters, command details, the JSON editor and the raw config files.
 */
import { useEffect, useMemo, useState } from 'react'
import { Blocks, FileJson, FolderOpen, Plus, RotateCcw, SearchX, Wrench } from 'lucide-react'
import type { InstalledServer, Scope, TargetChangeResult, TargetId, TargetRef } from '@shared/types'
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  ErrorState,
  List,
  PageHeader,
  SearchInput,
  Select,
  Skeleton,
  Tabs,
  Tooltip,
  confirmAction,
  toast,
  toastError,
  toastResult
} from '@renderer/components/ui'
import { core, errorMessage, ui } from '@renderer/lib/api'
import { useTargets } from '@renderer/lib/hooks'
import { pluralize } from '@renderer/lib/format'
import { useIsAdvanced, useNavigate } from '@renderer/lib/store'
import { AppIcon } from './discover/common/apps'
import { RestartCallout, noteRestart } from './discover/common/restart'
import { bumpServers, useCatalogServers, useInstalledServers } from './discover/common/servers'
import { InstallWizardHost } from './discover/install/InstallWizard'
import { openCustomWizard } from './discover/install/store'
import { humanizeName } from './discover/lib/installForm'
import { TARGET_NAMES, folderName, refKey, refLabel, scopeLabel, userRef } from './discover/lib/targets'
import { CopyDialog } from './installed/CopyDialog'
import { EditJsonDialog } from './installed/EditJsonDialog'
import { EditValuesDialog } from './installed/EditValuesDialog'
import { countByTarget, filterInstalled, groupByTarget, projectPaths } from './installed/lib/tools'
import { RawConfigSheet } from './installed/RawConfigSheet'
import { TestSheet } from './installed/TestSheet'
import { ToolRow } from './installed/ToolRow'

function rowKey(server: InstalledServer): string {
  return `${refKey(server.target)}::${server.name}`
}

export default function InstalledPage() {
  const advanced = useIsAdvanced()
  const navigate = useNavigate()
  const installed = useInstalledServers()
  const { byId } = useTargets()
  const servers = useMemo(() => installed.data ?? [], [installed.data])
  const catalog = useCatalogServers(servers.map((s) => s.catalogId).filter((id): id is string => !!id))

  const [query, setQuery] = useState('')
  const [app, setApp] = useState<TargetId | 'all'>('all')
  const [scope, setScope] = useState<Scope | 'all'>('all')
  const [project, setProject] = useState<string>('all')
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [testing, setTesting] = useState<InstalledServer | null>(null)
  const [editing, setEditing] = useState<InstalledServer | null>(null)
  const [copying, setCopying] = useState<InstalledServer | null>(null)
  const [rawTarget, setRawTarget] = useState<TargetRef | null>(null)

  // Catalog name when known, else the config name (readable in Simple mode: "sequential-thinking" → "Sequential thinking").
  const labelOf = (server: InstalledServer): string =>
    (server.catalogId ? catalog.get(server.catalogId)?.name : undefined) ?? (advanced ? server.name : humanizeName(server.name))
  const counts = countByTarget(servers)
  const projects = projectPaths(servers)
  const appCount = app === 'all' ? servers.length : counts[app]
  const projectGone = project !== 'all' && !projects.includes(project)
  // A filter that no longer matches anything (its last tool was removed) falls back to showing everything.
  useEffect(() => {
    if (installed.data && app !== 'all' && appCount === 0) setApp('all')
  }, [installed.data, app, appCount])
  useEffect(() => {
    if (installed.data && projectGone) setProject('all')
  }, [installed.data, projectGone])

  const filter = { query, target: app, scope: advanced ? scope : 'all', projectPath: advanced ? project : 'all' } as const
  const visible = filterInstalled(servers, filter, labelOf)
  const groups = groupByTarget(visible, labelOf)
  const filtering = !!query || app !== 'all' || (advanced && (scope !== 'all' || project !== 'all'))

  const setRowBusy = (key: string, on: boolean): void =>
    setBusy((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })

  // ── Actions ─────────────────────────────────────────────────────────────────
  const toggle = async (server: InstalledServer, enabled: boolean): Promise<void> => {
    const key = rowKey(server)
    const label = labelOf(server)
    const flip = (value: boolean): void => installed.setData((list) => list?.map((s) => (rowKey(s) === key ? { ...s, enabled: value } : s)))
    setRowBusy(key, true)
    flip(enabled)
    try {
      const result = await core.servers.setEnabled(server.name, server.target, enabled)
      if (result.ok) {
        noteRestart(result)
        toastResult(result, { successTitle: enabled ? `Turned on ${label}` : `Turned off ${label}` })
      } else {
        flip(!enabled)
        toastResult(result, { errorTitle: `Couldn’t turn ${enabled ? 'on' : 'off'} ${label}` })
      }
      bumpServers()
    } catch (err) {
      flip(!enabled)
      toastError(err, `Couldn’t turn ${enabled ? 'on' : 'off'} ${label}`)
    } finally {
      setRowBusy(key, false)
    }
  }

  const restore = async (server: InstalledServer): Promise<void> => {
    const label = labelOf(server)
    try {
      // catalogId keeps the link to the catalog entry (icon, name) — the core records it next to a raw config.
      const res = await core.servers.install({ config: server.config, catalogId: server.catalogId, name: server.name, targets: [server.target] })
      if (!res.ok) {
        toast.error(`Couldn’t put ${label} back`, { description: res.results[0]?.message ?? res.warnings[0], duration: 8000 })
        return
      }
      noteRestart(res.results)
      if (!server.enabled) await core.servers.setEnabled(server.name, server.target, false)
      toast.success(`${label} is back`)
    } catch (err) {
      toastError(err, `Couldn’t put ${label} back`)
    } finally {
      bumpServers()
    }
  }

  const remove = async (server: InstalledServer): Promise<void> => {
    const label = labelOf(server)
    const box: { result: TargetChangeResult | null } = { result: null }
    const confirmed = await confirmAction({
      title: `Remove ${label}?`,
      description: `Claude won’t be able to use it in ${refLabel(server.target)} anymore. A backup of the settings file is made first.`,
      tone: 'danger',
      confirmLabel: 'Remove',
      onConfirm: async () => {
        const results = await core.servers.uninstall(server.name, [server.target])
        box.result = results[0] ?? { target: server.target, ok: false, message: 'Nothing was removed.' }
      }
    })
    const result = box.result
    if (!confirmed || !result) return
    if (result.ok) {
      noteRestart(result)
      installed.setData((list) => list?.filter((s) => rowKey(s) !== rowKey(server)))
      toast.success(`Removed ${label}`, {
        description: advanced && result.backupId ? `Backup ${result.backupId}` : 'A backup was made first.',
        action: { label: 'Undo', onClick: () => void restore(server) },
        duration: 8000
      })
    } else {
      toastResult(result, { errorTitle: `Couldn’t remove ${label}` })
    }
    bumpServers()
  }

  const showFile = async (path: string | null | undefined, ref?: TargetRef): Promise<void> => {
    try {
      const target = path || (ref ? await core.targets.configPath(ref) : null)
      if (!target) {
        toast.error('There’s no settings file for this yet')
        return
      }
      await ui.showItemInFolder(target)
    } catch (err) {
      toast.error('Couldn’t open the folder', { description: errorMessage(err) })
    }
  }

  // ── Rendering ───────────────────────────────────────────────────────────────
  const loading = installed.loading && !installed.data
  const failed = !!installed.error && !installed.data

  const appTabs = [
    { value: 'all' as const, label: 'All apps', count: servers.length },
    ...(Object.keys(counts) as TargetId[]).filter((t) => counts[t] > 0).map((t) => ({ value: t, label: TARGET_NAMES[t], count: counts[t] }))
  ]

  return (
    <>
      <PageHeader
        icon={Blocks}
        title="My Tools"
        subtitle="Everything Claude can use right now. Turn tools on or off, check that they work, or remove them."
        actions={
          <>
            {advanced ? (
              <Button leftIcon={Wrench} onClick={openCustomWizard}>
                Add custom tool
              </Button>
            ) : null}
            {/* While the empty state shows its own big "Browse tools" button, keep a single primary action. */}
            <Button variant={servers.length ? 'primary' : 'outline'} leftIcon={Plus} onClick={() => navigate('discover')}>
              Add tools
            </Button>
          </>
        }
      >
        {servers.length > 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            <Tabs variant="pill" size="sm" aria-label="Apps" value={app} onValueChange={setApp} items={appTabs} />
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {advanced ? (
                <Select
                  size="sm"
                  aria-label="Where"
                  value={scope}
                  containerClassName="w-auto"
                  onValueChange={(value) => setScope(value as Scope | 'all')}
                  options={[
                    { value: 'all', label: 'Everywhere & projects' },
                    { value: 'user', label: scopeLabel('user') },
                    { value: 'project', label: scopeLabel('project') },
                    { value: 'local', label: scopeLabel('local') }
                  ]}
                />
              ) : null}
              {advanced && projects.length ? (
                <Select
                  size="sm"
                  aria-label="Project"
                  value={project}
                  containerClassName="w-auto max-w-56"
                  onValueChange={setProject}
                  options={[{ value: 'all', label: 'All projects' }, ...projects.map((p) => ({ value: p, label: folderName(p) }))]}
                />
              ) : null}
              <SearchInput
                value={query}
                onValueChange={setQuery}
                placeholder="Filter your tools…"
                size="sm"
                shortcut="/"
                debounce={120}
                className="w-56"
              />
            </div>
          </div>
        ) : null}
      </PageHeader>

      <div className="space-y-8">
        <RestartCallout />
        {installed.error && installed.data ? (
          <Callout
            tone="warn"
            title="Couldn’t refresh the list"
            action={
              <Button size="sm" leftIcon={RotateCcw} onClick={() => void installed.reload()}>
                Try again
              </Button>
            }
          >
            Showing what Claude Setup saw last. {installed.error}
          </Callout>
        ) : null}

        {loading ? (
          <LoadingGroups />
        ) : failed ? (
          <ErrorState framed title="Couldn’t load your tools" error={installed.error} onRetry={() => void installed.reload()} />
        ) : servers.length === 0 ? (
          <EmptyState
            framed
            size="lg"
            icon={Blocks}
            title="No tools yet"
            description={
              'Tools give Claude new abilities — like reading your files, searching the web or working with GitHub. ' +
              'Add your first one in a click.'
            }
            actions={
              <>
                <Button variant="primary" leftIcon={Plus} onClick={() => navigate('discover')}>
                  Browse tools
                </Button>
                {advanced ? (
                  <Button leftIcon={Wrench} onClick={openCustomWizard}>
                    Add custom tool
                  </Button>
                ) : null}
              </>
            }
          />
        ) : groups.length === 0 ? (
          <EmptyState
            framed
            icon={SearchX}
            title="No tools match"
            description={query ? `Nothing matches “${query}”.` : 'No tools in this view.'}
            actions={
              filtering ? (
                <Button
                  onClick={() => {
                    setQuery('')
                    setApp('all')
                    setScope('all')
                    setProject('all')
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          groups.map((group) => {
            const info = byId(group.target)
            const enabledCount = group.servers.filter((s) => s.enabled).length
            return (
              <section key={group.target} aria-labelledby={`group-${group.target}`} className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <AppIcon target={group.target} size="sm" />
                  <h2 id={`group-${group.target}`} className="text-base font-semibold tracking-[-0.01em] text-fg">
                    {TARGET_NAMES[group.target]}
                  </h2>
                  <span className="text-[13px] text-fg-muted tabular-nums">
                    {pluralize(group.servers.length, 'tool')}
                    {enabledCount < group.servers.length ? ` · ${group.servers.length - enabledCount} off` : ''}
                  </span>
                  {info && !info.installed ? (
                    <Tooltip content={`${TARGET_NAMES[group.target]} isn’t installed, but its settings file has these tools.`}>
                      <Badge size="sm" tone="warn">
                        App not installed
                      </Badge>
                    </Tooltip>
                  ) : null}
                  <div className="ml-auto flex items-center gap-1.5">
                    {advanced ? (
                      <>
                        <Button size="sm" variant="ghost" leftIcon={FileJson} onClick={() => setRawTarget(userRef(group.target))}>
                          View config
                        </Button>
                        <Tooltip content="Show the config file in its folder">
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Show ${TARGET_NAMES[group.target]} config file in folder`}
                            onClick={() => void showFile(info?.configPath, userRef(group.target))}
                          >
                            <FolderOpen />
                          </Button>
                        </Tooltip>
                      </>
                    ) : null}
                  </div>
                </div>
                <List aria-label={`Tools in ${TARGET_NAMES[group.target]}`}>
                  {group.servers.map((server) => (
                    <ToolRow
                      key={rowKey(server)}
                      server={server}
                      catalog={server.catalogId ? catalog.get(server.catalogId) : undefined}
                      label={labelOf(server)}
                      advanced={advanced}
                      busy={busy.has(rowKey(server))}
                      onToggle={(s, enabled) => void toggle(s, enabled)}
                      onTest={setTesting}
                      onEdit={setEditing}
                      onCopy={setCopying}
                      onRemove={(s) => void remove(s)}
                      onShowFile={(s) => void showFile(s.configPath, s.target)}
                      onViewFile={(s) => setRawTarget(s.target)}
                      onOpenCatalog={(id) => navigate('discover', { server: id })}
                    />
                  ))}
                </List>
              </section>
            )
          })
        )}
      </div>

      <TestSheet
        server={testing}
        label={testing ? labelOf(testing) : ''}
        catalog={testing?.catalogId ? catalog.get(testing.catalogId) : undefined}
        onClose={() => setTesting(null)}
      />
      {advanced ? (
        <EditJsonDialog server={editing} label={editing ? labelOf(editing) : ''} onClose={() => setEditing(null)} />
      ) : (
        <EditValuesDialog server={editing} label={editing ? labelOf(editing) : ''} onClose={() => setEditing(null)} />
      )}
      <CopyDialog server={copying} label={copying ? labelOf(copying) : ''} installed={servers} onClose={() => setCopying(null)} />
      <RawConfigSheet target={rawTarget} onClose={() => setRawTarget(null)} />
      <InstallWizardHost />
    </>
  )
}

/** Skeleton shaped like two app groups. */
function LoadingGroups() {
  return (
    <div className="space-y-8" aria-busy="true" aria-label="Loading your tools">
      {[3, 2].map((rows, g) => (
        <div key={g} className="space-y-3">
          <div className="flex items-center gap-3">
            <Skeleton className="size-7 rounded-lg" />
            <Skeleton className="h-5 w-36" />
          </div>
          <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="flex items-center gap-3.5 px-4 py-3.5">
                <Skeleton className="size-9 rounded-[10px]" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-64" />
                </div>
                <Skeleton className="h-5 w-9 rounded-full" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
