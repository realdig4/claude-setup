import { useMemo, useState } from 'react'
import { PackageOpen, SearchX, ShieldAlert } from 'lucide-react'
import type { ExtensionItem, ExtensionKind, ExtensionSource, Scope } from '@shared/types'
import {
  Button,
  Callout,
  CardGrid,
  Chip,
  EmptyState,
  ErrorState,
  SearchInput,
  Segmented,
  Select,
  SkeletonCard,
  Stagger,
  StaggerItem,
  confirmAction,
  toast,
  toastError,
  toastResult
} from '@renderer/components/ui'
import { core, useCoreEvent } from '@renderer/lib/api'
import { formatNumber } from '@renderer/lib/format'
import { useAsync, useProgress } from '@renderer/lib/hooks'
import { ExtensionCard, type CardBusy } from './ExtensionCard'
import { InstallDialog } from './InstallDialog'
import { KIND_META, SOURCE_FILTERS, matchesExtension, runsCommands } from './meta'

export interface ExtensionBrowserProps {
  /** One kind, or several shown with a switcher (hooks + status lines). */
  kinds: ExtensionKind[]
  advanced: boolean
}

interface DialogState {
  key: number
  open: boolean
  item: ExtensionItem
}

/** Search, filter and manage one kind of extension (plugins, skills, agents, commands, hooks, status lines…). */
export function ExtensionBrowser({ kinds, advanced }: ExtensionBrowserProps) {
  const [kind, setKind] = useState<ExtensionKind>(kinds[0] ?? 'plugin')
  const [query, setQuery] = useState('')
  const [installedOnly, setInstalledOnly] = useState(false)
  const [source, setSource] = useState<ExtensionSource | ''>('')
  const [busy, setBusy] = useState<Record<string, CardBusy>>({})
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const { progress, reset } = useProgress('extensions')
  const meta = KIND_META[kind]
  const activeSource = advanced ? source : ''

  const results = useAsync(
    () => core.extensions.search({ kind, query: query.trim() || undefined, source: activeSource || undefined, limit: 60 }),
    [kind, query, activeSource]
  )
  const installed = useAsync(() => core.extensions.installed(kind), [kind])

  useCoreEvent('state', (event) => {
    if (event.key === 'extensions') {
      void results.reload()
      void installed.reload()
    }
  })

  const setItemBusy = (id: string, state: CardBusy): void => setBusy((b) => ({ ...b, [id]: state }))
  const patchItem = (id: string, changes: Partial<ExtensionItem>): void => {
    results.setData((list) => list?.map((i) => (i.id === id ? { ...i, ...changes } : i)))
    installed.setData((list) => list?.map((i) => (i.id === id ? { ...i, ...changes } : i)))
  }
  const refreshLists = (): void => {
    void results.reload()
    void installed.reload()
  }

  const install = async (item: ExtensionItem, scope?: Scope, projectPath?: string): Promise<void> => {
    setItemBusy(item.id, 'install')
    reset()
    try {
      const result = await core.extensions.install(item.id, scope ? { scope, ...(projectPath ? { projectPath } : {}) } : undefined)
      toastResult(result)
      if (result.ok) patchItem(item.id, { installed: true, enabled: true, scope: scope ?? 'user' })
    } catch (err) {
      toastError(err, `Couldn’t install ${item.name}`)
    } finally {
      setItemBusy(item.id, null)
      refreshLists()
    }
  }

  const requestInstall = async (item: ExtensionItem): Promise<void> => {
    if (advanced) {
      setDialog({ key: Date.now(), open: true, item })
      return
    }
    if (runsCommands(item.kind) || item.warnings?.length) {
      const ok = await confirmAction({
        title: `Install ${item.name}?`,
        description: runsCommands(item.kind)
          ? `${KIND_META[item.kind].label} run commands on your computer automatically while Claude Code works. ` +
            'Only install ones from people you trust.'
          : 'Please read this first:',
        details: item.warnings?.length ? (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-fg-muted">
            {item.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : undefined,
        confirmLabel: 'Install',
        icon: ShieldAlert
      })
      if (!ok) return
    }
    void install(item)
  }

  const uninstall = async (item: ExtensionItem): Promise<void> => {
    const ok = await confirmAction({
      title: `Remove ${item.name}?`,
      description:
        item.kind === 'plugin'
          ? 'Its commands, skills and agents go away, and its saved data is removed. You can install it again later.'
          : `Claude Code won’t use this ${KIND_META[item.kind].singular} anymore. You can install it again later.`,
      tone: 'danger',
      confirmLabel: 'Remove'
    })
    if (!ok) return
    setItemBusy(item.id, 'uninstall')
    try {
      const result = await core.extensions.uninstall(item.id)
      toastResult(result)
      if (result.ok) patchItem(item.id, { installed: false, enabled: undefined, installedPath: undefined })
    } catch (err) {
      toastError(err, `Couldn’t remove ${item.name}`)
    } finally {
      setItemBusy(item.id, null)
      refreshLists()
    }
  }

  const toggle = async (item: ExtensionItem, enabled: boolean): Promise<void> => {
    setItemBusy(item.id, 'toggle')
    patchItem(item.id, { enabled })
    try {
      const result = await core.extensions.setEnabled(item.id, enabled)
      if (!result.ok) {
        patchItem(item.id, { enabled: !enabled })
        toastResult(result)
      } else {
        toast.success(result.message, { description: 'Start a new Claude Code session to see the change.' })
      }
    } catch (err) {
      patchItem(item.id, { enabled: !enabled })
      toastError(err, `Couldn’t turn ${enabled ? 'on' : 'off'} ${item.name}`)
    } finally {
      setItemBusy(item.id, null)
    }
  }

  const installedList = useMemo(
    () => (installed.data ?? []).filter((i) => matchesExtension(i, query) && (!activeSource || i.source === activeSource)),
    [installed.data, query, activeSource]
  )
  const items = installedOnly ? installedList : results.data
  const loading = installedOnly ? installed.loading && !installed.data : results.loading && !results.data
  const error = installedOnly ? (installed.data ? null : installed.error) : results.data ? null : results.error

  return (
    <div className="flex flex-col gap-5">
      {kinds.length > 1 ? (
        <Segmented
          aria-label="Kind"
          value={kind}
          onValueChange={(next) => {
            setKind(next)
            setQuery('')
          }}
          options={kinds.map((k) => ({ value: k, label: KIND_META[k].label }))}
          className="self-start"
        />
      ) : null}

      {runsCommands(kind) ? (
        <Callout tone="warn" icon={ShieldAlert} title={`${meta.label} run commands on your computer`}>
          They start automatically while Claude Code works — for example after every edit. Only install ones from people you trust, and
          check what they do on their page first.
        </Callout>
      ) : null}

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={query}
            onValueChange={setQuery}
            placeholder={`Search ${meta.label.toLowerCase()}…`}
            shortcut="/"
            loading={results.loading && !!results.data && !installedOnly}
            className="max-w-md min-w-60 flex-1"
          />
          <Chip selected={installedOnly} count={installed.data?.length} onClick={() => setInstalledOnly((v) => !v)}>
            Installed
          </Chip>
          {advanced ? (
            <Select
              value={source}
              onValueChange={(v) => setSource(v as ExtensionSource | '')}
              options={SOURCE_FILTERS.map((s) => ({ value: s.value, label: s.label }))}
              containerClassName="w-56"
              aria-label="Source"
            />
          ) : null}
        </div>
        <p className="text-[13px] text-fg-muted">
          {meta.description}
          {items && !loading ? <span className="text-fg-subtle"> · {formatNumber(items.length)} shown</span> : null}
        </p>
      </div>

      {error ? (
        <ErrorState framed title={`Couldn’t load ${meta.label.toLowerCase()}`} error={error} onRetry={refreshLists} />
      ) : loading ? (
        <CardGrid minItemWidth={280}>
          {Array.from({ length: 6 }, (_, i) => (
            <SkeletonCard key={i} />
          ))}
        </CardGrid>
      ) : !items || items.length === 0 ? (
        installedOnly ? (
          <EmptyState
            framed
            icon={PackageOpen}
            title={
              query ? `No installed ${meta.label.toLowerCase()} match “${query}”` : `No ${meta.label.toLowerCase()} installed yet`
            }
            description="Browse the list and install one with a single click."
            actions={
              <Button size="sm" onClick={() => setInstalledOnly(false)}>
                Browse {meta.label.toLowerCase()}
              </Button>
            }
          />
        ) : (
          <EmptyState
            framed
            icon={SearchX}
            title={query ? `No ${meta.label.toLowerCase()} match “${query}”` : `No ${meta.label.toLowerCase()} found`}
            description={query ? 'Try a shorter or different word.' : 'Check your internet connection, or add a marketplace.'}
            actions={
              query ? (
                <Button size="sm" onClick={() => setQuery('')}>
                  Clear search
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <Stagger>
          <CardGrid minItemWidth={280}>
            {items.map((item, i) => (
              <StaggerItem key={item.id} index={i} className="h-full">
                <ExtensionCard
                  item={item}
                  busy={busy[item.id] ?? null}
                  progress={busy[item.id] === 'install' ? progress?.message : undefined}
                  advanced={advanced}
                  onInstall={(it) => void requestInstall(it)}
                  onUninstall={(it) => void uninstall(it)}
                  onToggle={(it, on) => void toggle(it, on)}
                />
              </StaggerItem>
            ))}
          </CardGrid>
        </Stagger>
      )}

      {dialog ? (
        <InstallDialog
          key={dialog.key}
          open={dialog.open}
          onOpenChange={(open) => setDialog((d) => (d ? { ...d, open } : d))}
          item={dialog.item}
          onInstall={(scope, projectPath) => void install(dialog.item, scope, projectPath)}
        />
      ) : null}
    </div>
  )
}
