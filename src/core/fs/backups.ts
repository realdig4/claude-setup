/**
 * Backups of every config file before Claude Setup changes it. CONTRACT (owned by FOUNDATION).
 * Layout: <backupsDir>/<id>/manifest.json + files/<n>.bak
 *   id = YYYYMMDD-HHmmss-<4 hex>; manifest = BackupEntry & { files[i].stored: "files/<n>.bak" }
 * A snapshot of a non-existent file records existed=false so restore deletes it.
 */
import type { BackupsApi } from '@shared/api'
import type { BackupEntry, OpResult } from '@shared/types'
import type { CoreContext } from '../context'

export class BackupManager {
  constructor(
    readonly dir: string,
    readonly keep: () => number
  ) {}

  /** Copy the given files (if they exist) into a new backup and prune old ones. */
  snapshot(_reason: string, _paths: string[]): Promise<BackupEntry> {
    throw new Error('TODO(foundation): BackupManager.snapshot')
  }

  /** Newest first. */
  list(): Promise<BackupEntry[]> {
    throw new Error('TODO(foundation): BackupManager.list')
  }

  /** Restore all files of a backup (takes a safety snapshot of current files first). */
  restore(_id: string): Promise<OpResult> {
    throw new Error('TODO(foundation): BackupManager.restore')
  }

  delete(_id: string): Promise<OpResult> {
    throw new Error('TODO(foundation): BackupManager.delete')
  }
}

export function createBackupsApi(_ctx: CoreContext): BackupsApi {
  throw new Error('TODO(foundation): createBackupsApi')
}
