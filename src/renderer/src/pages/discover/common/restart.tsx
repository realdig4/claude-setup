/**
 * Claude Desktop restart handling shared by the pages: remembers that a change is waiting for a restart,
 * offers a confirmed restart, and shows a friendly callout while a restart is pending.
 */
import { useState } from 'react'
import { RotateCw } from 'lucide-react'
import { create } from 'zustand'
import type { OpResult, TargetRef } from '@shared/types'
import { Button, Callout, confirmAction, toast, toastResult, type ButtonProps } from '@renderer/components/ui'
import { core, errorMessage } from '@renderer/lib/api'
import { refreshTargets, useTargets } from '@renderer/lib/hooks'

interface RestartStore {
  /** A change was written while Claude Desktop was open. */
  pending: boolean
  restarting: boolean
}

const useRestartStore = create<RestartStore>()(() => ({ pending: false, restarting: false }))

type ResultLike = { target?: TargetRef; ok: boolean; needsRestart?: boolean }

/** Record results of a change: any successful Claude Desktop change that needs a restart marks it pending. */
export function noteRestart(results: ResultLike | readonly ResultLike[]): void {
  const list = Array.isArray(results) ? results : [results as ResultLike]
  if (list.some((r) => r.ok && r.needsRestart && (!r.target || r.target.target === 'claude-desktop'))) {
    useRestartStore.setState({ pending: true })
  }
}

/** Is a Claude Desktop restart waiting (and is Desktop actually open)? */
export function useRestartPending(): boolean {
  const pending = useRestartStore((s) => s.pending)
  const { byId } = useTargets()
  const desktop = byId('claude-desktop')
  return pending && desktop?.installed !== false && desktop?.running !== false
}

/**
 * Ask, then quit and reopen Claude Desktop. Resolves true when it restarted.
 * Safe to call from anywhere (uses the global confirm dialog and toasts).
 */
export async function restartDesktop(): Promise<boolean> {
  const box: { result: OpResult | null } = { result: null }
  const confirmed = await confirmAction({
    title: 'Restart Claude Desktop?',
    description: 'Claude Desktop will close and open again so it loads your tools. Anything you’re typing there may be lost.',
    confirmLabel: 'Restart',
    icon: RotateCw,
    onConfirm: async () => {
      useRestartStore.setState({ restarting: true })
      try {
        box.result = await core.targets.restartDesktop()
      } catch (err) {
        box.result = { ok: false, message: errorMessage(err) }
      } finally {
        useRestartStore.setState({ restarting: false })
      }
    }
  })
  const outcome = box.result
  if (!confirmed || !outcome) return false
  if (outcome.ok) {
    useRestartStore.setState({ pending: false })
    toastResult(outcome)
  } else {
    toast.error('Couldn’t restart Claude Desktop', {
      description: `${outcome.message} You can also quit Claude Desktop from its tray icon and open it again.`,
      duration: 9000
    })
  }
  void refreshTargets()
  return outcome.ok
}

/** "Restart Claude Desktop" button (asks first, shows a spinner while restarting). */
export function RestartDesktopButton({ children, ...props }: ButtonProps) {
  const restarting = useRestartStore((s) => s.restarting)
  const [busy, setBusy] = useState(false)
  return (
    <Button
      leftIcon={RotateCw}
      loading={busy || restarting}
      {...props}
      onClick={() => {
        setBusy(true)
        void restartDesktop().finally(() => setBusy(false))
      }}
    >
      {children ?? 'Restart Claude Desktop'}
    </Button>
  )
}

/** Callout shown while a Claude Desktop restart is pending. Renders nothing otherwise. */
export function RestartCallout({ className }: { className?: string }) {
  const pending = useRestartPending()
  if (!pending) return null
  return (
    <Callout
      tone="warn"
      className={className}
      title="Restart Claude Desktop to use your changes"
      action={<RestartDesktopButton size="sm" variant="outline">Restart now</RestartDesktopButton>}
    >
      Claude Desktop loads its tools when it starts.
    </Callout>
  )
}
