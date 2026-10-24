import { useId, useState } from 'react'
import { ChevronRight, Ellipsis, FileClock, FilePlus2, History, Trash2 } from 'lucide-react'
import type { BackupEntry } from '@shared/types'
import { Badge, Button, IconTile, Menu, PathText, Tooltip } from '@renderer/components/ui'
import { cn } from '@renderer/lib/cn'
import { formatBytes, formatDateTime, formatRelativeTime, pluralize } from '@renderer/lib/format'
import { backupSize, describeBackupFile } from './logic'

export interface BackupRowProps {
  entry: BackupEntry
  onRestore: (entry: BackupEntry) => void
  onDelete: (entry: BackupEntry) => void
  restoring: boolean
  /** Just created by the last restore (highlighted). */
  fresh?: boolean
}

/** One backup: why it was made, when, which files (expandable) and Restore / Delete actions. */
export function BackupRow({ entry, onRestore, onDelete, restoring, fresh }: BackupRowProps) {
  const [open, setOpen] = useState(false)
  const filesId = useId()
  const size = backupSize(entry)
  const names = [...new Set(entry.files.map((f) => describeBackupFile(f.path)))]

  return (
    <li className={cn('transition-colors duration-700', fresh && 'bg-accent-soft/40')}>
      <div className="flex items-start gap-3.5 px-4 py-3.5">
        <IconTile icon={FileClock} tone="neutral" size="md" className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm leading-6 font-medium text-fg">{entry.reason || 'Backup'}</span>
            {fresh ? (
              <Badge size="sm" tone="accent">
                New
              </Badge>
            ) : null}
          </div>
          <p className="text-[13px] leading-5 text-fg-muted">
            <Tooltip content={formatDateTime(entry.createdAt)}>
              <span tabIndex={0} className="rounded-sm">
                {formatRelativeTime(entry.createdAt)}
              </span>
            </Tooltip>
            {' · '}
            {pluralize(entry.files.length, 'file')}
            {size ? ` · ${formatBytes(size)}` : ''}
            {names.length ? ` · ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''}` : ''}
          </p>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={filesId}
            onClick={() => setOpen((v) => !v)}
            className={cn(
              'mt-1 -ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium text-fg-muted',
              'transition-colors hover:text-fg'
            )}
          >
            <ChevronRight className={cn('size-3.5 transition-transform duration-200', open && 'rotate-90')} aria-hidden="true" />
            {open ? 'Hide files' : 'Show files'}
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" leftIcon={History} loading={restoring} onClick={() => onRestore(entry)}>
            Restore
          </Button>
          <Menu
            label={`Actions for backup ${entry.id}`}
            trigger={
              <Button size="icon-sm" variant="ghost" aria-label="More actions">
                <Ellipsis />
              </Button>
            }
            items={[{ label: 'Delete backup', icon: Trash2, tone: 'danger', onSelect: () => onDelete(entry) }]}
          />
        </div>
      </div>
      {open ? (
        <div id={filesId} className="px-4 pb-4 pl-[66px]">
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface-2/40">
            {entry.files.map((file) => (
              <li key={file.path} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="min-w-0 text-[13px] font-medium text-fg">{describeBackupFile(file.path)}</span>
                {file.existed ? (
                  <span className="text-xs text-fg-subtle tabular-nums">{formatBytes(file.size)}</span>
                ) : (
                  <Tooltip content="Restoring this backup removes the file, because it didn’t exist before the change.">
                    <Badge size="sm" icon={FilePlus2} tabIndex={0}>
                      Didn’t exist yet
                    </Badge>
                  </Tooltip>
                )}
                <PathText path={file.path} copy reveal max={70} className="ml-auto" />
              </li>
            ))}
          </ul>
          <p className="mt-2 font-mono text-[11px] text-fg-subtle">Backup {entry.id}</p>
        </div>
      ) : null}
    </li>
  )
}
