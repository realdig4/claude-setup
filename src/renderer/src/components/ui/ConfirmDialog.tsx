import { useRef, useState, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { create } from 'zustand'
import { errorMessage } from '../../lib/api'
import { Button } from './Button'
import { Dialog } from './Dialog'
import type { IconProp } from './icon'
import { toast } from './toast'

export interface ConfirmOptions {
  title: ReactNode
  description?: ReactNode
  /** Extra content under the description (lists, a CodeBlock, a Callout). */
  details?: ReactNode
  /** Default "Continue" (or "Remove" for tone 'danger'). Use a verb: "Remove tool", "Restore backup". */
  confirmLabel?: string
  cancelLabel?: string
  /** 'danger' styles the confirm button red and focuses Cancel first. */
  tone?: 'default' | 'danger'
  icon?: IconProp
  /**
   * Optional async work run when confirming. The dialog stays open with a spinner until it settles;
   * a thrown error is shown as a toast and the dialog stays open.
   */
  onConfirm?: () => Promise<unknown> | unknown
}

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean
  /** Called with true (confirmed) or false (cancelled / dismissed). */
  onResult: (confirmed: boolean) => void
}

/**
 * Controlled confirmation dialog. Most code should use the promise-based useConfirm() instead.
 */
export function ConfirmDialog({
  open,
  onResult,
  title,
  description,
  details,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'default',
  icon,
  onConfirm
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  const confirm = async (): Promise<void> => {
    if (!onConfirm) {
      onResult(true)
      return
    }
    setBusy(true)
    try {
      await onConfirm()
      onResult(true)
    } catch (err) {
      toast.error('That didn’t work', { description: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onResult(false)
      }}
      size="sm"
      title={title}
      description={description}
      icon={icon ?? (tone === 'danger' ? TriangleAlert : undefined)}
      tone={tone === 'danger' ? 'danger' : 'accent'}
      dismissible={!busy}
      hideClose
      initialFocus={tone === 'danger' ? cancelRef : confirmRef}
      footer={
        <>
          <Button ref={cancelRef} variant="ghost" onClick={() => onResult(false)} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button ref={confirmRef} variant={tone === 'danger' ? 'danger' : 'primary'} loading={busy} onClick={() => void confirm()}>
            {confirmLabel ?? (tone === 'danger' ? 'Remove' : 'Continue')}
          </Button>
        </>
      }
    >
      {details}
    </Dialog>
  )
}

interface ConfirmRequest extends ConfirmOptions {
  id: number
  resolve: (confirmed: boolean) => void
}

interface ConfirmStore {
  current: ConfirmRequest | null
  queue: ConfirmRequest[]
  open: boolean
}

const useConfirmStore = create<ConfirmStore>()(() => ({ current: null, queue: [], open: false }))
let nextConfirmId = 1

/**
 * Ask the user to confirm. Resolves true when confirmed. Works anywhere (needs <ConfirmHost/>, mounted by App).
 * @example if (await confirmAction({ title: 'Remove GitHub?', tone: 'danger', confirmLabel: 'Remove' })) …
 */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const request: ConfirmRequest = { ...options, id: nextConfirmId++, resolve }
    const state = useConfirmStore.getState()
    if (state.current) useConfirmStore.setState({ queue: [...state.queue, request] })
    else useConfirmStore.setState({ current: request, open: true })
  })
}

/** Hook returning the confirmAction function (promise-based confirm dialog). */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  return confirmAction
}

function settle(confirmed: boolean): void {
  const { current } = useConfirmStore.getState()
  if (!current) return
  current.resolve(confirmed)
  useConfirmStore.setState({ open: false })
  // Let the exit animation play before showing the next queued request.
  window.setTimeout(() => {
    const { queue } = useConfirmStore.getState()
    const [next, ...rest] = queue
    useConfirmStore.setState(next ? { current: next, queue: rest, open: true } : { current: null, queue: [], open: false })
  }, 180)
}

/** Renders pending confirmAction() requests. Mount once (App does this). */
export function ConfirmHost() {
  const current = useConfirmStore((s) => s.current)
  const open = useConfirmStore((s) => s.open)
  if (!current) return null
  const { id, resolve: _resolve, ...options } = current
  return <ConfirmDialog key={id} {...options} open={open} onResult={settle} />
}
