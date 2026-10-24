import { useState, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button, Callout, Dialog, Field, Input } from '@renderer/components/ui'
import { errorMessage } from '@renderer/lib/api'

export interface TypeToConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description: ReactNode
  /** The exact text the user must type. */
  phrase: string
  confirmLabel: string
  /** The work to do; the dialog stays open with a spinner until it settles and shows errors inline. */
  onConfirm: () => Promise<void>
}

/** A strong confirmation for actions that can't be undone: the user types a name to enable the button. */
export function TypeToConfirmDialog(props: TypeToConfirmDialogProps) {
  const { open, onOpenChange, title, description, phrase, confirmLabel, onConfirm } = props
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const matches = typed.trim() === phrase

  const confirm = async (): Promise<void> => {
    if (!matches) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      size="sm"
      tone="danger"
      icon={TriangleAlert}
      title={title}
      description={description}
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} disabled={!matches} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void confirm()
        }}
      >
        {error ? (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        ) : null}
        <Field label={<>Type <span className="font-mono text-fg">{phrase}</span> to confirm</>}>
          <Input mono value={typed} onValueChange={setTyped} autoComplete="off" spellCheck={false} data-autofocus disabled={busy} />
        </Field>
      </form>
    </Dialog>
  )
}
