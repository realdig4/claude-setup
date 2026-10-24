import { useMemo, useState } from 'react'
import { ArchiveRestore, History, RefreshCw, RotateCw, SearchX, Settings2 } from 'lucide-react'
import type { BackupEntry } from '@shared/types'
import {
  Button,
  Callout,
  EmptyState,
  ErrorState,
  List,
  PageHeader,
  SearchInput,
  Skeleton,
  Tooltip,
  confirmAction,
  toastError,
  toastResult
} from '@renderer/components/ui'
import { core } from '@renderer/lib/api'
import { refreshTargets, useAsync, useSettings } from '@renderer/lib/hooks'
import { formatDateTime, pluralize } from '@renderer/lib/format'
import { getPage, type PageProps } from '@renderer/lib/nav'
import { useNavigate } from '@renderer/lib/store'
import { AdvancedGate } from './backups/AdvancedGate'
import { BackupRow } from './backups/BackupRow'
import { describeBackupFile, groupBackups, matchesBackup } from './backups/logic'

const page = getPage('backups')

function LoadingList() {
  return (
    <List aria-label="Loading backups">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="flex items-start gap-3.5 px-4 py-3.5">
          <Skeleton className="size-9 rounded-[10px]" />
          <div className="flex-1 space-y-2 pt-0.5">
            <Skeleton className="h-4 w-72 max-w-full" />
            <Skeleton className="h-3.5 w-56 max-w-full" />
          </div>
          <Skeleton className="h-8 w-24 rounded-lg" />
        </li>
      ))}
    </List>
  )
}

/** Backups: every config file is saved before Claude Setup changes it — restore or delete any of them. */
export default function BackupsPage(_props: PageProps) {
  const navigate = useNavigate()
  const { settings } = useSettings()
  const backups = useAsync(() => core.backups.list(), [])
  const [query, setQuery] = useState('')
  const [restoring, setRestoring] = useState<string | null>(null)
  const [freshId, setFreshId] = useState<string | null>(null)
  const [restartNeeded, setRestartNeeded] = useState(false)
  const [restartingDesktop, setRestartingDesktop] = useState(false)

  const all = backups.data ?? []
  const visible = useMemo(() => all.filter((b) => matchesBackup(b, query)), [all, query])
  const groups = useMemo(() => groupBackups(visible), [visible])

  const restore = async (entry: BackupEntry): Promise<void> => {
    const removed = entry.files.filter((f) => !f.existed)
    const single = entry.files.length === 1
    const ok = await confirmAction({
      title: 'Restore this backup?',
      description:
        `Your ${single ? 'file goes' : 'files go'} back to how ${single ? 'it was' : 'they were'} on ` +
        `${formatDateTime(entry.createdAt)}. Claude Setup backs up the current versions first, so you can undo this.`,
      details: (
        <ul className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-2/50 px-3 py-2.5 text-[13px] text-fg-muted">
          {entry.files.map((file) => (
            <li key={file.path} className="flex items-baseline justify-between gap-3">
              <span className="font-medium text-fg">{describeBackupFile(file.path)}</span>
              <span className="text-xs">{file.existed ? 'Restored' : 'Removed (didn’t exist yet)'}</span>
            </li>
          ))}
          {removed.length ? (
            <li className="pt-1 text-xs text-fg-subtle">
              {removed.length === 1 ? 'One file' : `${removed.length} files`} didn’t exist before this backup, so restoring removes{' '}
              {removed.length === 1 ? 'it' : 'them'}.
            </li>
          ) : null}
        </ul>
      ),
      confirmLabel: 'Restore',
      icon: ArchiveRestore
    })
    if (!ok) return
    setRestoring(entry.id)
    try {
      const result = await core.backups.restore(entry.id)
      toastResult(result)
      if (result.needsRestart) setRestartNeeded(true)
      if (result.ok) {
        setFreshId(result.backupId ?? null)
        void refreshTargets()
      }
    } catch (err) {
      toastError(err, 'Couldn’t restore the backup')
    } finally {
      setRestoring(null)
      void backups.reload()
    }
  }

  const remove = async (entry: BackupEntry): Promise<void> => {
    const ok = await confirmAction({
      title: 'Delete this backup?',
      description: `“${entry.reason || 'Backup'}” will be gone for good — you won’t be able to restore these files from it.`,
      tone: 'danger',
      confirmLabel: 'Delete backup'
    })
    if (!ok) return
    const before = backups.data
    backups.setData((list) => list?.filter((b) => b.id !== entry.id))
    try {
      const result = await core.backups.delete(entry.id)
      toastResult(result)
      if (!result.ok && before) backups.setData(before)
    } catch (err) {
      if (before) backups.setData(before)
      toastError(err, 'Couldn’t delete the backup')
    } finally {
      void backups.reload()
    }
  }

  const restartDesktop = async (): Promise<void> => {
    setRestartingDesktop(true)
    try {
      const result = await core.targets.restartDesktop()
      toastResult(result)
      if (result.ok) setRestartNeeded(false)
    } catch (err) {
      toastError(err, 'Couldn’t restart Claude Desktop')
    } finally {
      setRestartingDesktop(false)
    }
  }

  let body
  if (backups.loading && !backups.data) body = <LoadingList />
  else if (backups.error && !backups.data) {
    body = <ErrorState framed title="Couldn’t load your backups" error={backups.error} onRetry={() => void backups.reload()} />
  }
  else if (all.length === 0) {
    body = (
      <EmptyState
        framed
        size="lg"
        icon={History}
        title="No backups yet"
        description="Claude Setup makes one automatically before it changes any settings file — they’ll show up here, ready to restore."
      />
    )
  } else if (visible.length === 0) {
    body = (
      <EmptyState
        framed
        size="sm"
        icon={SearchX}
        title="No backups match your search"
        description="Try a file name like “settings.json” or a word from the reason."
        actions={
          <Button size="sm" onClick={() => setQuery('')}>
            Clear search
          </Button>
        }
      />
    )
  } else {
    body = (
      <div className="space-y-8">
        {groups.map((group) => (
          <section key={group.label} aria-label={group.label} className="flex flex-col gap-2.5">
            <h2 className="flex items-baseline gap-2 px-1 text-xs font-semibold tracking-wide text-fg-muted uppercase">
              {group.label}
              <span className="font-normal tracking-normal normal-case text-fg-subtle">
                {pluralize(group.entries.length, 'backup')}
              </span>
            </h2>
            <List aria-label={`Backups from ${group.label}`}>
              {group.entries.map((entry) => (
                <BackupRow
                  key={entry.id}
                  entry={entry}
                  restoring={restoring === entry.id}
                  fresh={entry.id === freshId}
                  onRestore={(e) => void restore(e)}
                  onDelete={(e) => void remove(e)}
                />
              ))}
            </List>
          </section>
        ))}
      </div>
    )
  }

  return (
    <>
      <PageHeader
        icon={page.icon}
        title={page.label}
        subtitle="Every settings file is backed up before Claude Setup changes it. Restore any version."
        actions={
          <Tooltip content="Refresh">
            <Button size="icon" variant="ghost" aria-label="Refresh" onClick={() => void backups.reload()}>
              <RefreshCw />
            </Button>
          </Tooltip>
        }
      />
      <AdvancedGate
        icon={History}
        title="Backups are part of Advanced mode"
        description="Claude Setup still makes a backup before every change. Turn on Advanced mode to see and restore them."
      >
        <div className="space-y-6">
          {restartNeeded ? (
            <Callout
              tone="warn"
              title="Restart Claude Desktop to finish"
              action={
                <Button size="sm" leftIcon={RotateCw} loading={restartingDesktop} onClick={() => void restartDesktop()}>
                  Restart now
                </Button>
              }
            >
              Claude Desktop loads its settings when it starts.
            </Callout>
          ) : null}
          {all.length > 0 ? (
            <div className="flex flex-wrap items-center gap-3">
              <SearchInput value={query} onValueChange={setQuery} placeholder="Search backups…" shortcut="/" className="max-w-sm" />
              <p className="ml-auto flex items-center gap-1.5 text-[13px] text-fg-muted">
                {settings ? `Keeping the newest ${settings.keepBackups}. ` : ''}
                <button
                  type="button"
                  onClick={() => navigate('settings')}
                  className="inline-flex items-center gap-1 font-medium text-accent-text underline-offset-[3px] hover:underline"
                >
                  <Settings2 className="size-3.5" aria-hidden="true" />
                  Change
                </button>
              </p>
            </div>
          ) : null}
          {body}
        </div>
      </AdvancedGate>
    </>
  )
}
